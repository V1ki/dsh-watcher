import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { apply as applyPersona } from '@local/dsh-persona';
import {
  apply as applyCore,
  createWatcherHttpHandler,
  openWatcherDb,
  type CordisPluginContext,
  type DshAgent,
  type PosteriorToolDefinition,
  type ToolExecutionContext,
} from '@local/dsh-hub';
import {
  GitHubGraphResolver,
  GitHubPoller,
  createGitHubSink,
  hasSelfTriggerMarker,
  normalizeConfig as normalizeGitHubConfig,
  registerDefaultRules,
  registerGitHubStageTools,
} from '@local/dsh-connector-github';
import { apply as applyMemo, type WebSearchResultItem } from '@local/dsh-trigger-memo';
import { WxarcHostBridge, apply as applyWxarc, type HostBridgeDeliverContext } from '@local/dsh-connector-wxarc';

type AnyTool = { name: string; execute: (args: Record<string, unknown>, exec?: ToolExecutionContext) => Promise<unknown> };

function createHarness() {
  let seq = 0;
  const disposers: Array<() => void> = [];
  const tools = new Map<string, AnyTool>();
  const delivered = new Map<string, string[]>();
  const agents = new Map<string, DshAgent>();
  const registerTool = (def: AnyTool | PosteriorToolDefinition): (() => void) => {
    tools.set(def.name, def as AnyTool);
    return () => {
      tools.delete(def.name);
    };
  };
  const ctx: CordisPluginContext & {
    tools: { register: typeof registerTool };
    on: (ev: string, fn: () => void) => () => void;
    disposeAll: () => void;
  } = {
    workspaceRegistry: { resolveByPath: async (p) => ({ id: `ws:${p}` }), create: async (p) => ({ id: `ws:${p}` }) },
    sessionController: {
      create: async () => {
        const sessionId = `sess_${++seq}`;
        const list: string[] = [];
        delivered.set(sessionId, list);
        agents.set(sessionId, {
          id: sessionId,
          session: { id: sessionId },
          followup: (msg: unknown) => {
            list.push((msg as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? '');
          },
          whenIdle: async () => {},
        });
        return { sessionId };
      },
      resolveAgent: async (sessionId) => ({ agent: agents.get(sessionId) }),
    },
    sessions: { flush: async () => true },
    tools: { register: registerTool },
    effect: (fn) => {
      const off = fn();
      if (typeof off === 'function') disposers.push(off);
    },
    on: (ev, fn) => {
      if (ev === 'dispose') disposers.push(fn);
      return () => {};
    },
    disposeAll: () => {
      while (disposers.length > 0) disposers.pop()?.();
    },
  };
  return { ctx, watcher: applyCore(ctx, { inMemory: true, tickIntervalMs: 0 }), tools, delivered };
}

function listen(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ server: http.Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

describe('dsh-watcher-bundle cross-package E2E flows', () => {
  it('Flow 1 & 2: example-owner/* #222/#221 co-habitation, reaction delta, auto-send self-skip, and external draft HTTP approve', async (t) => {
    const { ctx, watcher, tools, delivered } = createHarness();
    let plusOne = 1;
    let nextId = 9000;
    const posted: Array<{ url: string; body: string }> = [];
    const comments222: Array<Record<string, unknown>> = [{ id: 1001, user: { login: 'alice' }, body: 'Need ACP', updated_at: '2026-11-20T10:00:00Z' }];
    const comments221: Array<Record<string, unknown>> = [{ id: 2001, user: { login: 'bob' }, body: 'WIP Fixes #222', updated_at: '2026-11-20T10:01:00Z' }];
    const cfg = normalizeGitHubConfig({
      ownerLogins: ['example-owner'],
      autoSendOwners: ['example-owner'],
      enableNotifications: false,
      gitFetchEnabled: false,
      repoMap: { 'example-owner/dsh-demo': { localPath: '/repo/dsh-demo', defaultBranch: 'main' } },
      pinnedItems: [{ repo: 'example-owner/dsh-demo', number: 222, linkedPrs: [221] }],
    });
    const credentials = {
      readSlot: async () => ({ token: 'ghp_e2e_test', login: 'example-owner', slot: 'read' as const, source: 'credentials' as const, isBot: false }),
      clearCache: () => {},
    };
    const okJson = (data: unknown) => ({ status: 200, ok: true, headers: { get: () => null }, json: async () => data });
    const fetchImpl = async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = String((JSON.parse(String(init.body || '{}')) as { body?: string }).body || '');
        posted.push({ url, body });
        const id = ++nextId;
        return okJson({ id, html_url: `${url}/${id}` });
      }
      if (url.endsWith('/issues/222')) return okJson({ id: 222, number: 222, title: 'ACP', reactions: { '+1': plusOne, total_count: plusOne } });
      if (url.endsWith('/issues/221')) return okJson({ id: 221, number: 221, title: 'PR', pull_request: {}, reactions: { '+1': 0, total_count: 0 } });
      if (url.endsWith('/issues/222/comments?per_page=100')) return okJson(comments222);
      if (url.endsWith('/issues/221/comments?per_page=100')) return okJson(comments221);
      return okJson([]);
    };
    const poller = new GitHubPoller({ config: cfg, credentials, db: watcher.db, fetchImpl, onEvent: (e) => watcher.ingest(e) });
    const resolver = new GitHubGraphResolver({ ctx: { watcher }, config: cfg, credentials, db: watcher.db, execFileImpl: async () => ({ stdout: '0', stderr: '' }) });
    const sink = createGitHubSink({ config: cfg, credentials, db: watcher.db, fetchImpl, onPublished: (m) => poller.recordSelfPublished(m) });
    watcher.registerSource(poller.asWatchSource());
    watcher.registerResolver(resolver.asEntityResolver());
    watcher.registerSink(sink);
    registerDefaultRules(watcher, cfg);
    registerGitHubStageTools({ watcher, tools: ctx.tools }, { config: cfg, sinkId: sink.id });

    const { server, baseUrl } = await listen((req, res) => void createWatcherHttpHandler(watcher)(req, res));
    t.after(() => {
      server.close();
      ctx.disposeAll();
    });

    await poller.pollOnce();
    const ws = watcher.listWorkstreams();
    assert.equal(ws.length, 1);
    assert.ok(ws[0].entityKeys.includes('github:example-owner/dsh-demo#222') && ws[0].entityKeys.includes('github:example-owner/dsh-demo#221'));
    const sessionId = ws[0].sessionId as string;

    plusOne = 3;
    assert.equal((await poller.pollOnce()).events, 1);
    assert.ok(watcher.listInbox().some((i) => i.type === 'github.reaction.delta'));
    assert.equal(delivered.get(sessionId)?.length, 3);

    const ghReply = tools.get('gh_stage_reply')!;
    const rootExec: ToolExecutionContext = { agent: { id: sessionId, session: { header: { delegationDepth: 0 } } } };
    const autoRes = (await ghReply.execute({ repo: 'example-owner/dsh-demo', number: 222, body: 'Tracking on #221' }, rootExec)) as { status: string; receiptId?: string };
    assert.equal(autoRes.status, 'executed');
    assert.equal(hasSelfTriggerMarker(posted[0].body), true);

    comments222.push({ id: Number(autoRes.receiptId), user: { login: 'example-owner' }, body: posted[0].body, updated_at: '2026-11-20T10:05:00Z' });
    assert.equal((await poller.pollOnce()).events, 0);

    const staged = (await ghReply.execute({ repo: 'upstream/ext-repo', number: 88, body: 'External fix' }, rootExec)) as { status: string; draftId?: string };
    assert.equal(staged.status, 'staged');
    assert.equal(watcher.listDrafts({ status: 'pending_approval' }).length, 1);
    assert.equal(posted.length, 1);

    const approveResp = await fetch(`${baseUrl}/local-watcher/drafts/${staged.draftId}/approve`, { method: 'POST' });
    assert.equal(approveResp.status, 200);
    assert.equal(((await approveResp.json()) as { status: string }).status, 'executed');
    assert.equal(posted.length, 2);
    assert.ok(posted[1].url.includes('/repos/upstream/ext-repo/issues/88/comments'));
    assert.equal(watcher.listDrafts({ status: 'pending_approval' }).length, 0);
  });

  it('Flow 3 & 4: time_nudge atmosphere/budget and long_watch rumor-filter -> #223 wakeup + WeChat ping via WxarcHostBridge', async (t) => {
    const { ctx, watcher, delivered } = createHarness();
    const wxDb = new DatabaseSync(':memory:');
    wxDb.exec('CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, payload TEXT NOT NULL); CREATE TABLE wxarc_chat_state (scope TEXT PRIMARY KEY, paused INTEGER NOT NULL DEFAULT 0);');
    const sent: HostBridgeDeliverContext[] = [];
    const hostBridge = new WxarcHostBridge({ db: wxDb, token: 'e2e-secret', ownId: 'wxid_bot_demo', deliverParts: async (c) => { sent.push(c); } });
    const { server, baseUrl } = await listen((req, res) => void hostBridge.handleHttpRequest(req, res));
    let searchResults: WebSearchResultItem[] = [];
    const { engine } = applyMemo(
      { watcher, tools: ctx.tools, web: { search: async () => ({ results: searchResults }) }, on: ctx.on },
      { tickIntervalMs: 60_000, defaultNotifyWechatChatId: 'filehelper', activeChatQuietSeconds: 300 },
    );
    applyWxarc(
      { watcher, tools: ctx.tools, on: ctx.on },
      { mode: 'http', remoteBaseUrl: baseUrl, bridgeToken: 'e2e-secret', ownId: 'wxid_bot_demo', defaultNotifyTarget: 'filehelper', allowedTargets: ['filehelper', 'chat_friday'], requireApprovalByDefault: false },
    );
    t.after(() => {
      server.close();
      wxDb.close();
      ctx.disposeAll();
    });

    const nowMs = Date.now();
    const nudgeInput = {
      kind: 'time_nudge' as const,
      roomKey: 'wechat:chat_friday',
      targetChatId: 'chat_friday',
      title: 'Friday demo',
      basis: 'Check how Friday demo went',
      windowStart: new Date(nowMs - 3_600_000).toISOString(),
      windowEnd: new Date(nowMs + 3_600_000).toISOString(),
      randomFireAt: new Date(nowMs - 60_000).toISOString(),
    };
    wxDb.prepare("INSERT INTO events (kind, payload) VALUES ('text', ?)").run(JSON.stringify({ session: 'chat_friday', sender: 'friend', text: 'still chatting', ts: nowMs - 20_000 }));
    assert.equal((await engine.checkNow(engine.createMemo(nudgeInput).id)).action, 'torn');

    wxDb.prepare('INSERT OR REPLACE INTO wxarc_chat_state (scope, paused) VALUES (?, 1)').run(JSON.stringify(['wxid_bot_demo', '', 'chat_friday']));
    assert.equal((await engine.checkNow(engine.createMemo(nudgeInput).id)).reason, 'chat_paused');

    wxDb.prepare('UPDATE wxarc_chat_state SET paused = 0').run();
    wxDb.prepare('DELETE FROM events').run();
    wxDb.prepare("INSERT INTO events (kind, payload) VALUES ('text', ?)").run(JSON.stringify({ session: 'chat_friday', sender: 'friend', text: 'morning coffee', ts: nowMs - 7_200_000 }));
    const mQuiet = engine.createMemo(nudgeInput);
    assert.equal((await engine.tick()).results.find((r) => r.memoId === mQuiet.id)?.action, 'fired');

    const budgetRes = await engine.checkNow(engine.createMemo({ ...nudgeInput, title: 'Second nudge' }).id);
    assert.equal(budgetRes.action, 'torn');
    assert.equal(budgetRes.reason, 'proactive_budget_exhausted');

    const { sessionId: session223 } = await ctx.sessionController!.create!({ workspaceId: 'ws:/repo/dsh-demo' });
    watcher.registerResolver({ id: 'memo-room', sources: ['memo'], resolve: async (ev) => ({ workspacePath: '/repo/dsh-demo', workstreamKey: ev.threadKey, targetSessionId: String(ev.payload.targetSessionId || '') }) });
    watcher.registerRule({ id: 'memo.long_watch.wake', name: 'Wake room', enabled: true, priority: 50, match: { source: 'memo', type: 'memo.long_watch.matched', excludeBots: false }, handler: { tier: 'triage', resolver: 'memo-room', sessionPolicy: 'reuse-only', deliveryMode: 'followup' } });

    const m223 = engine.createMemo({
      kind: 'long_watch',
      roomKey: 'github:example-owner/dsh-demo#223',
      targetSessionId: session223,
      title: 'Claude Code ACP official support',
      basis: 'Watch official Claude Code ACP support for Issue #223',
      keywords: ['Claude Code', 'ACP'],
      acceptCriteria: 'official ACP protocol support',
      officialDomains: ['docs.anthropic.com'],
      notifyWechatChatId: 'filehelper',
      knownFactsUpdatedAt: new Date(nowMs - 86_400_000).toISOString(),
    });

    searchResults = [{ url: 'https://reddit.com/r/claude/acp-rumor', title: 'Unofficial Claude Code ACP workaround rumor', snippet: 'Proxy hack bypass', publishedAt: new Date(nowMs).toISOString() }];
    assert.equal((await engine.checkNow(m223.id)).action, 'deferred');
    assert.equal(sent.length, 0);
    assert.equal(delivered.get(session223)?.length, 0);

    searchResults = [{ url: 'https://docs.anthropic.com/en/docs/claude-code/acp', title: 'Claude Code Official Release: Native ACP Protocol Support', snippet: 'Official announcement: Claude Code now supports native ACP protocol.', publishedAt: new Date(nowMs).toISOString() }];
    const hit = await engine.checkNow(m223.id);
    assert.equal(hit.action, 'completed');
    assert.equal(hit.wechatPingSent, true);
    assert.equal(engine.store.getMemo(m223.id)?.status, 'completed');
    assert.ok(delivered.get(session223)![0].includes('docs.anthropic.com/en/docs/claude-code/acp'));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].session, 'filehelper');
    assert.ok(sent[0].parts.join(' ').includes('docs.anthropic.com/en/docs/claude-code/acp'));
  });

  it('Flow 5: PersonaWardrobe wxarc SQLite import/card/memory, custom DoorGuard block, and executing->uncertain recovery', async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-watcher-e2e-'));
    const wxarcPath = path.join(tmpDir, 'wxarc.sqlite');
    const stateDir = path.join(tmpDir, 'state');
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    const srcDb = new DatabaseSync(wxarcPath);
    srcDb.exec('CREATE TABLE personas (id TEXT PRIMARY KEY, revision INTEGER, config TEXT, style TEXT, style_meta TEXT); CREATE TABLE persona_memory (id INTEGER PRIMARY KEY AUTOINCREMENT, persona_id TEXT, scope TEXT, event_seq INTEGER, note TEXT, quote TEXT, at INTEGER, source_key TEXT, category TEXT, metadata TEXT);');
    srcDb.prepare('INSERT INTO personas VALUES (?, 1, ?, ?, ?)').run('p_owner', JSON.stringify({ id: 'p_owner', kind: 'double', name: '主人分身', definition: '务实直接', learning: true, work: '', character: '' }), '简短直接', '{}');
    srcDb.prepare('INSERT INTO persona_memory (persona_id, scope, event_seq, note, quote, at, source_key, category, metadata) VALUES (?, ?, 1, ?, ?, 1000, ?, ?, ?)').run('p_owner', 'wechat:chat_demo', '不喜欢客套话', '直接说重点', 'wx:1', '聊天偏好', '{}');
    srcDb.close();

    const db1 = openWatcherDb({ stateDir, acquireLease: false });
    const now = new Date().toISOString();
    db1.db.prepare("INSERT INTO staged_drafts (id, sink_id, sink_kind, action, target_json, payload_json, preview_text, idempotency_key, status, created_at, updated_at) VALUES ('drf_crash_1', 'wxarc.send', 'irreversible-gui', 'send', '{}', '{}', 'hi', 'k_crash_1', 'executing', ?, ?)").run(now, now);
    db1.close();

    const disposers: Array<() => void> = [];
    const personaStateDir = path.join(tmpDir, 'persona-state');
    const { wardrobe } = applyPersona(
      { effect: (fn: () => (() => void) | void) => { const off = fn(); if (typeof off === 'function') disposers.push(off); } },
      { stateDir: personaStateDir, autoMigrate: false },
    );
    const service = applyCore(
      {
        get: (name: string) => (name === 'personaWardrobe' ? wardrobe : undefined),
        effect: (fn) => { const off = fn(); if (typeof off === 'function') disposers.push(off); },
      },
      { stateDir, acquireLease: false, tickIntervalMs: 0 },
    );
    t.after(() => { while (disposers.length > 0) disposers.pop()?.(); });

    assert.equal(service.listDrafts({ status: 'executing' }).length, 0);
    assert.equal(service.listDrafts({ status: 'uncertain' }).some((d) => d.id === 'drf_crash_1'), true);

    const resolvedWardrobe = service.getWardrobe();
    assert.ok(resolvedWardrobe?.importFromWxarcSqlite);
    const imp = resolvedWardrobe.importFromWxarcSqlite(wxarcPath);
    assert.equal(imp.personasImported, 1);
    assert.equal(imp.memoriesImported, 1);
    assert.equal(resolvedWardrobe.recordTurnPreference({ personaId: 'p_owner', scope: 'wechat:chat_demo', sourceText: '别发长段', memories: [{ note: '偏好短句', quote: '别发长段' }] }).recorded, 1);
    const card = resolvedWardrobe.getDynamicCard({ personaId: 'p_owner', scope: 'wechat:chat_demo', channel: 'wechat' });
    assert.ok(card && card.memory.length === 2 && card.promptBlock.includes('主人分身') && card.promptBlock.includes('偏好短句'));

    let sinkCalls = 0;
    service.registerSink({ id: 'custom.sink', label: 'Custom', kind: 'idempotent', invoke: async () => { sinkCalls += 1; return { status: 'executed' }; } });
    const offGuard = service.guard.registerGuard({
      name: 'block-secret-leak',
      beforeSendOut: (g) => (String(g.payload?.body ?? '').includes('SECRET_TOKEN') ? { allow: false, reason: 'secret_leak_blocked' } : { allow: true }),
    });
    const blocked = await service.invokeSink('custom.sink', { action: 'post', target: { repo: 'example-owner/dsh-demo' }, payload: { body: 'leak SECRET_TOKEN' }, idempotencyKey: 'guard-e2e-1' });
    assert.equal(blocked.status, 'skipped');
    assert.equal(blocked.detail, 'secret_leak_blocked');
    assert.equal(sinkCalls, 0);
    offGuard();
  });
});
