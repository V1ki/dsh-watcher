import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { apply as applyPersona } from '@local/dsh-persona';
import {
  PUBLIC_TAINT_WARNING_TEXT,
  apply as applyHub,
  type DshAgent,
  type ToolExecutionContext,
  type VaultContextResponse,
  type VaultSearchResponse,
} from '@local/dsh-hub';
import { apply as applyRouter, type RouterDecisionRecord } from '@local/dsh-router';
import {
  createGitHubSink,
  createGitHubVaultProvider,
  normalizeConfig as normalizeGitHubConfig,
  registerGitHubStageTools,
} from '@local/dsh-connector-github';
import { apply as applyMemo } from '@local/dsh-trigger-memo';
import { createWechatVaultProvider } from '@local/dsh-connector-wxarc';

type AnyTool = {
  name: string;
  execute: (args: Record<string, unknown>, exec?: ToolExecutionContext) => Promise<unknown>;
};

type HookListener = (...args: any[]) => any;

function createVaultHarness() {
  let seq = 0;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vault-e2e-'));
  const disposers: Array<() => void> = [];
  const tools = new Map<string, AnyTool>();
  const delivered = new Map<string, string[]>();
  const injected = new Map<string, string[]>();
  const agents = new Map<string, DshAgent & { inject: (msg: unknown) => void; session: { id: string; header: { delegationDepth: number } } }>();
  const listeners = new Map<string, HookListener[]>();
  const sentWechat: Array<{ target: string; text: string }> = [];

  const registerTool = (def: AnyTool): (() => void) => {
    tools.set(def.name, def);
    return () => {
      tools.delete(def.name);
    };
  };

  const on = (event: string, fn: HookListener): (() => void) => {
    if (event === 'dispose') {
      disposers.push(() => fn());
      return () => {};
    }
    const list = listeners.get(event) ?? [];
    list.push(fn);
    listeners.set(event, list);
    return () => {
      const current = listeners.get(event);
      if (!current) return;
      const idx = current.indexOf(fn);
      if (idx >= 0) current.splice(idx, 1);
    };
  };

  const emit = async (event: string, ...args: unknown[]): Promise<unknown> => {
    const list = [...(listeners.get(event) ?? [])];
    let last: unknown;
    for (const fn of list) {
      last = await fn(...args);
    }
    return last;
  };

  const createAgent = (sessionId: string) => {
    const fList: string[] = [];
    const iList: string[] = [];
    delivered.set(sessionId, fList);
    injected.set(sessionId, iList);
    const agent = {
      id: sessionId,
      session: { id: sessionId, header: { delegationDepth: 0 } },
      followup: (msg: unknown) => {
        const text = (msg as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? '';
        fList.push(text);
      },
      inject: (msg: unknown) => {
        const text = (msg as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? '';
        iList.push(text);
      },
      whenIdle: async () => {},
    };
    agents.set(sessionId, agent);
    return agent;
  };

  const { wardrobe } = applyPersona(
    {
      effect: (fn: () => (() => void) | void) => {
        const off = fn();
        if (typeof off === 'function') disposers.push(off);
      },
    },
    { stateDir: path.join(tmpDir, 'persona'), autoMigrate: false },
  );

  const workspaceRegistry = {
    resolveByPath: async (p: string) => ({ id: `ws:${p}` }),
    create: async (p: string) => ({ id: `ws:${p}` }),
  };
  const sessionController = {
    create: async (opts?: { sessionId?: string; workspaceId?: string; agentPreset?: string }) => {
      const sessionId = opts?.sessionId?.trim() || `sess_${++seq}`;
      createAgent(sessionId);
      return { sessionId };
    },
    resolveAgent: async (sessionId: string) => ({ agent: agents.get(sessionId) }),
  };
  const agentsSvc = {
    get: (sessionId: string) => agents.get(sessionId),
  };
  const sessionsSvc = { flush: async () => true };
  const toolsSvc = { register: registerTool };
  const serviceMap: Record<string, unknown> = {
    personaWardrobe: wardrobe,
    workspaceRegistry,
    sessionController,
    agents: agentsSvc,
    sessions: sessionsSvc,
    tools: toolsSvc,
  };

  const ctx = {
    workspaceRegistry,
    sessionController,
    agents: agentsSvc,
    sessions: sessionsSvc,
    tools: toolsSvc,
    get: (name: string) => serviceMap[name],
    effect: (fn: () => (() => void) | void) => {
      const off = fn();
      if (typeof off === 'function') disposers.push(off);
    },
    on,
  };

  const hub = applyHub(ctx, { inMemory: true, tickIntervalMs: 0 });
  hub.registerWechatTransport({
    send: async (input) => {
      const text = Array.isArray(input.text) ? input.text.join('\n') : input.text;
      sentWechat.push({ target: input.chatId, text });
      return { status: 'sent', deliveryId: `wx_msg_${sentWechat.length}` };
    },
    recentMessages: async () => [],
    getAtmosphere: async (params) => ({
      chatId: params.chatId,
      healthy: true,
      paused: false,
      messageCount: 0,
      lastMessageAt: null,
      secondsSinceLastMessage: 3600,
      ownSpokeSince: false,
      quiet: true,
      recentMessages: [],
    }),
    status: async () => ({ ok: true, mode: 'cordis', healthy: true }),
  });

  const router = applyRouter(
    { ...ctx, hub },
    {
      inMemory: true,
      tickIntervalMs: 0,
      ownerDebounceMs: 60_000,
      homeDir: tmpDir,
      initialPolicy: {
        presenceMode: 'away',
        workHoursDest: 'wechat',
        offHoursDest: 'wechat',
        weekendDest: 'wechat',
        awayFallbackDest: 'wechat',
        wechatTarget: 'wxid_owner_demo',
      },
    },
  );

  const cleanup = () => {
    router.dispose();
    while (disposers.length > 0) disposers.pop()?.();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  };

  return { ctx, hub, router, wardrobe, tools, delivered, injected, agents, sentWechat, emit, cleanup };
}

function makeDecision(overrides: Partial<RouterDecisionRecord> & { id: string; threadKey: string }): RouterDecisionRecord {
  const now = new Date().toISOString();
  return {
    inboxId: `inb_${overrides.id}`,
    eventId: `evt_${overrides.id}`,
    source: 'github',
    actor: 'alice',
    level: 'prepare',
    summary: `Summary for ${overrides.id}`,
    reason: 'test',
    question: null,
    options: [],
    recommendedIndex: null,
    answeredOption: null,
    status: 'notified',
    destination: 'wechat',
    workerSessionId: null,
    subscriptionId: null,
    triageRestored: false,
    rawUrl: null,
    trustLevel: 'owner',
    targetCircle: 'external',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('dsh-hub-bundle Vault, Taint, Lifecycle & Focus-Free E2E', () => {
  it('1. Unified vault_search/vault_context across 4 connectors, default owner_private hiding, and single-turn owner upgrade', async (t) => {
    const h = createVaultHarness();
    t.after(() => h.cleanup());

    const wxDb = new DatabaseSync(':memory:');
    wxDb.exec('CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, payload TEXT NOT NULL, received_at TEXT NOT NULL);');
    t.after(() => wxDb.close());
    const nowIso = new Date().toISOString();
    const nowSec = Math.floor(Date.now() / 1000);
    wxDb.prepare('INSERT INTO events (kind, payload, received_at) VALUES (?, ?, ?)').run(
      'text',
      JSON.stringify({ session: 'room_pub_demo', sender: 'peer_a', text: 'Before nebula-release sync', ts: nowSec - 60 }),
      nowIso,
    );
    wxDb.prepare('INSERT INTO events (kind, payload, received_at) VALUES (?, ?, ?)').run(
      'text',
      JSON.stringify({ session: 'room_pub_demo', sender: 'peer_a', text: 'Public nebula-release rollout ok', ts: nowSec - 30 }),
      nowIso,
    );
    wxDb.prepare('INSERT INTO events (kind, payload, received_at) VALUES (?, ?, ?)').run(
      'text',
      JSON.stringify({ session: 'chat_unlabeled_demo', sender: 'friend_b', text: 'Private nebula-release salary note', ts: nowSec - 10 }),
      nowIso,
    );

    h.wardrobe.create({ id: 'p_vault', kind: 'double', name: 'Demo Persona' });
    h.wardrobe.setChatCircle('room_pub_demo', 'external', 'Public Room');
    h.wardrobe.setChatCircle('github:demo-org/demo-repo#42', 'external', 'Public Repo');
    h.wardrobe.recordEventFact({
      personaId: 'p_vault',
      roomChatId: 'room_pub_demo',
      circle: 'external',
      visibility: 'circle',
      subjectName: 'Demo',
      predicate: 'tracks',
      objectName: 'nebula-release',
      statement: 'Public nebula-release persona fact',
      evidenceType: 'text',
      evidenceExcerpt: 'nebula-release',
    });

    const ghCfg = normalizeGitHubConfig({
      ownerLogins: ['demo-owner'],
      autoSendOwners: ['demo-owner'],
      repoMap: { 'demo-org/demo-repo': { localPath: '/repo/demo-repo', defaultBranch: 'main', visibility: 'public' } },
    });
    h.hub.registerVaultProvider(createWechatVaultProvider({ db: wxDb, getWardrobe: () => h.wardrobe }));
    h.hub.registerVaultProvider(
      createGitHubVaultProvider({
        hub: h.hub,
        getConfig: () => ghCfg,
        getWardrobe: () => h.wardrobe,
        listRecentEvents: () => [
          {
            id: 'gh_ev_42',
            source: 'github',
            type: 'github.issue.comment',
            repo: 'demo-org/demo-repo',
            number: 42,
            threadKey: 'github:demo-org/demo-repo#42',
            entityKey: 'github:demo-org/demo-repo#42',
            actor: 'alice',
            summary: 'GitHub nebula-release PR #42 ready',
            url: 'https://github.com/demo-org/demo-repo/pull/42',
            occurredAt: nowIso,
            payload: {},
          },
        ],
      }),
    );
    const { engine: memoEngine } = applyMemo({ hub: h.hub, tools: h.ctx.tools, on: h.ctx.on }, { tickIntervalMs: 0 });
    memoEngine.createMemo({
      kind: 'long_watch',
      roomKey: 'github:demo-org/demo-repo#42',
      title: 'Track nebula-release milestone',
      basis: 'Watch official nebula-release status',
      keywords: ['nebula-release'],
    });

    const { sessionId: workerSid } = await h.ctx.sessionController.create();
    h.hub.registerSessionPrincipal({
      sessionId: workerSid,
      role: 'worker',
      tier: 1,
      trustLevel: 'owner',
      boundSource: 'github',
      boundThreadKey: 'github:demo-org/demo-repo#42',
      targetCircle: 'external',
    });
    h.router.db.upsertDecision(
      makeDecision({
        id: 'dec_pr_42',
        threadKey: 'github:demo-org/demo-repo#42',
        summary: 'PR #42 nebula-release',
        workerSessionId: workerSid,
      }),
    );

    const vaultSearch = h.tools.get('vault_search')!;
    const vaultContext = h.tools.get('vault_context')!;
    const workerExec: ToolExecutionContext = { agent: h.agents.get(workerSid) };

    const tier1 = (await vaultSearch.execute({ query: 'nebula-release', limit: 20 }, workerExec)) as VaultSearchResponse;
    const sources = new Set(tier1.hits.map((hit) => hit.source));
    assert.deepEqual([...sources].sort(), ['github', 'memo', 'persona', 'wechat']);
    assert.equal(tier1.hits.some((hit) => hit.snippet.includes('salary note')), false);

    const pubWechatHit = tier1.hits.find((hit) => hit.source === 'wechat');
    assert.ok(pubWechatHit);
    const pubCtx = (await vaultContext.execute(
      { source: 'wechat', itemId: pubWechatHit.itemId, before: 2, after: 2 },
      workerExec,
    )) as VaultContextResponse;
    assert.ok((pubCtx.result?.items.length ?? 0) >= 2);
    const privCtxBlocked = (await vaultContext.execute(
      { source: 'wechat', itemId: 'wechat:3', before: 2, after: 2 },
      workerExec,
    )) as VaultContextResponse;
    assert.equal(privCtxBlocked.result, null);

    const upgradeRes = await h.router.handleAdminWechatMessage({
      senderId: 'wxid_owner_demo',
      session: 'wxid_owner_demo',
      text: '#42 查一下私聊记录里的 nebula-release',
    });
    assert.equal(upgradeRes.handled, true);

    const upgraded = (await vaultSearch.execute({ query: 'nebula-release', sources: ['wechat'], limit: 10 }, workerExec)) as VaultSearchResponse;
    const privHit = upgraded.hits.find((hit) => hit.snippet.includes('salary note'));
    assert.ok(privHit);
    assert.equal(privHit.circle, 'owner_private');
    assert.equal(h.hub.isSessionTainted(workerSid), true);

    await h.emit('agent/inbox/inserted', {
      sessionId: workerSid,
      message: { source: { kind: 'github', trust: 'untrusted' } },
    });
    const dropped = (await vaultSearch.execute({ query: 'nebula-release', sources: ['wechat'], limit: 10 }, workerExec)) as VaultSearchResponse;
    assert.equal(dropped.hits.some((hit) => hit.snippet.includes('salary note')), false);
  });

  it('2. Sticky taint lock forces DoorGuard stageOnly + warning and denies web_fetch / require_escalated', async (t) => {
    const h = createVaultHarness();
    t.after(() => h.cleanup());

    const wxDb = new DatabaseSync(':memory:');
    wxDb.exec('CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, payload TEXT NOT NULL, received_at TEXT NOT NULL);');
    t.after(() => wxDb.close());
    wxDb.prepare('INSERT INTO events (kind, payload, received_at) VALUES (?, ?, ?)').run(
      'text',
      JSON.stringify({ session: 'chat_secret_demo', sender: 'friend_c', text: 'Internal budget-alpha code', ts: Math.floor(Date.now() / 1000) }),
      new Date().toISOString(),
    );
    h.hub.registerVaultProvider(createWechatVaultProvider({ db: wxDb, getWardrobe: () => h.wardrobe }));

    const posted: string[] = [];
    const cfg = normalizeGitHubConfig({
      ownerLogins: ['demo-owner'],
      autoSendOwners: ['demo-owner'],
      repoMap: { 'demo-owner/pub-repo': { localPath: '/repo/pub-repo', defaultBranch: 'main', visibility: 'public' } },
    });
    const credentials = {
      readSlot: async () => ({ token: 'ghp_demo_test', login: 'demo-owner', slot: 'read' as const, source: 'credentials' as const, isBot: false }),
      clearCache: () => {},
    };
    const sink = createGitHubSink({
      config: cfg,
      credentials,
      db: h.hub.db,
      fetchImpl: async (url, init) => {
        if (init?.method === 'POST') posted.push(url);
        return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({ id: 901, html_url: url }) };
      },
    });
    h.hub.registerSink(sink);
    registerGitHubStageTools({ watcher: h.hub, tools: h.ctx.tools }, { config: cfg, sinkId: sink.id });

    const { sessionId: workerSid } = await h.ctx.sessionController.create();
    h.hub.registerSessionPrincipal({
      sessionId: workerSid,
      role: 'worker',
      tier: 3,
      trustLevel: 'owner',
      boundSource: 'github',
      boundRepo: 'demo-owner/pub-repo',
      boundThreadKey: 'github:demo-owner/pub-repo#9',
      targetCircle: 'external',
    });
    const workerExec: ToolExecutionContext = { agent: h.agents.get(workerSid) };

    const searchRes = (await h.tools.get('vault_search')!.execute({ query: 'budget-alpha', sources: ['wechat'] }, workerExec)) as VaultSearchResponse;
    assert.equal(searchRes.hits.length, 1);
    assert.equal(h.hub.isSessionTainted(workerSid), true);

    const replyRes = (await h.tools.get('gh_stage_reply')!.execute(
      { repo: 'demo-owner/pub-repo', number: 9, body: 'Public reply draft' },
      workerExec,
    )) as { status: string; warningText?: string; taintWarning?: string };
    assert.equal(replyRes.status, 'staged');
    assert.equal(replyRes.warningText ?? replyRes.taintWarning, PUBLIC_TAINT_WARNING_TEXT);
    assert.equal(posted.length, 0);
    assert.equal(h.hub.listDrafts({ status: 'pending_approval' }).length, 1);

    const denyFetch = (await h.emit(
      'tools/pre-execute',
      { name: 'web_fetch', arguments: { url: 'https://example.com' }, agent: h.agents.get(workerSid) },
      async () => ({ kind: 'allow' }),
    )) as { kind: string };
    assert.equal(denyFetch.kind, 'deny');

    const denyEsc = (await h.emit(
      'tools/pre-execute',
      { name: 'bash', arguments: { command: 'ls', sandbox_permissions: 'require_escalated' }, agent: h.agents.get(workerSid) },
      async () => ({ kind: 'allow' }),
    )) as { kind: string };
    assert.equal(denyEsc.kind, 'deny');
  });

  it('3. lifecycleOnly terminal event settles Router decisions & deferred notifications without waking Worker', async (t) => {
    const h = createVaultHarness();
    t.after(() => h.cleanup());

    const { sessionId: workerSid } = await h.ctx.sessionController.create();
    const threadKey = 'github:demo-org/demo-repo#77';
    h.hub.registerSubscription({
      source: 'github',
      threadKey,
      sessionId: workerSid,
    });
    const nowIso = new Date().toISOString();
    h.router.db.upsertDecision(
      makeDecision({
        id: 'dec_pr_77',
        threadKey,
        summary: 'PR #77 awaiting review',
        status: 'deferred',
        workerSessionId: workerSid,
      }),
    );
    h.router.db.upsertNotification({
      id: 'notif_pr_77',
      decisionId: 'dec_pr_77',
      channel: 'defer',
      target: 'wxid_owner_demo',
      title: 'PR #77',
      summary: 'PR #77 awaiting review',
      reason: 'off_hours',
      rawUrl: null,
      status: 'deferred',
      dueAt: new Date(Date.now() - 60_000).toISOString(),
      createdAt: nowIso,
      updatedAt: nowIso,
    });

    await h.hub.ingest({
      id: 'ev_pr_77_merged',
      dedupeKey: 'ev_pr_77_merged',
      source: 'github',
      type: 'github.pull_request.closed',
      threadKey,
      actor: { id: 'alice', login: 'alice', isBot: false },
      trustLevel: 'owner',
      summary: 'PR #77 merged',
      occurredAt: nowIso,
      payload: { state: 'merged', merged: true, lifecycleOnly: true },
    });

    assert.equal(h.delivered.get(workerSid)?.length, 0);
    const updated = h.router.listDecisions({ limit: 10 }).find((d) => d.id === 'dec_pr_77');
    assert.equal(updated?.status, 'resolved');
    assert.equal(h.router.listNotifications({ status: 'deferred', limit: 10 }).length, 0);
  });

  it('4. No 24h focus lock: plain DM enters owner_session, #id/quote reaches PR Worker, and tickDeferred >=3 merges into 1 card', async (t) => {
    const h = createVaultHarness();
    t.after(() => h.cleanup());

    const { sessionId: worker88 } = await h.ctx.sessionController.create();
    h.router.db.upsertDecision(
      makeDecision({
        id: 'dec_pr_88',
        threadKey: 'github:demo-org/demo-repo#88',
        summary: 'PR #88 refactor auth',
        workerSessionId: worker88,
      }),
    );

    const dmRes = await h.router.handleAdminWechatMessage({
      senderId: 'wxid_owner_demo',
      session: 'wxid_owner_demo',
      text: '明天上午有什么安排',
    });
    assert.equal(dmRes.handled, true);
    await h.router.ownerSession.flushPendingMessages();
    const ownerSid = h.router.ownerSession.getSessionId();
    assert.ok(ownerSid);
    assert.equal(h.delivered.get(worker88)?.length, 0);
    assert.equal(h.delivered.get(ownerSid)?.some((msg) => msg.includes('明天上午有什么安排')), true);

    const hashRes = await h.router.handleAdminWechatMessage({
      senderId: 'wxid_owner_demo',
      session: 'wxid_owner_demo',
      text: '#88 顺便补个单测',
    });
    assert.equal(hashRes.handled, true);
    assert.equal(h.delivered.get(worker88)?.length, 1);
    assert.equal(h.delivered.get(worker88)![0].includes('顺便补个单测'), true);

    const quoteRes = await h.router.handleAdminWechatMessage({
      senderId: 'wxid_owner_demo',
      session: 'wxid_owner_demo',
      quotedText: '[#88] PR #88 refactor auth',
      text: '可以合并',
    });
    assert.equal(quoteRes.handled, true);
    assert.equal(h.delivered.get(worker88)?.length, 2);
    assert.equal(h.delivered.get(worker88)![1].includes('可以合并'), true);
    assert.equal(h.delivered.get(ownerSid)?.length, 1);

    const pastIso = new Date(Date.now() - 60_000).toISOString();
    for (const num of [101, 102, 103]) {
      const id = `dec_batch_${num}`;
      h.router.db.upsertDecision(
        makeDecision({
          id,
          threadKey: `github:demo-org/demo-repo#${num}`,
          summary: `Batch item #${num}`,
          status: 'deferred',
        }),
      );
      h.router.db.upsertNotification({
        id: `notif_batch_${num}`,
        decisionId: id,
        channel: 'defer',
        target: 'wxid_owner_demo',
        title: `PR #${num}`,
        summary: `Batch item #${num}`,
        reason: 'off_hours',
        rawUrl: null,
        status: 'deferred',
        dueAt: pastIso,
        createdAt: pastIso,
        updatedAt: pastIso,
      });
    }

    const tickRes = await h.router.tickDeferred();
    assert.equal(tickRes.processed, 3);
    assert.equal(tickRes.delivered, 3);
    assert.equal(h.sentWechat.length, 1);
    assert.equal(h.sentWechat[0].target, 'wxid_owner_demo');
    assert.ok(h.sentWechat[0].text.includes('Batch item #101'));
    assert.ok(h.sentWechat[0].text.includes('Batch item #102'));
    assert.ok(h.sentWechat[0].text.includes('Batch item #103'));
    assert.equal(h.router.listNotifications({ status: 'deferred', limit: 10 }).length, 0);
  });
});
