import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import {
  VaultError,
  createDoorGuard,
  createHubService,
  openHubDb,
  type AdminWechatMessage,
  type VaultVisibility,
} from '@local/dsh-hub';
import { adminPrincipal, resolveOwnerId } from '../src/admin.js';
import { AgentBridge } from '../src/agent.js';
import { WechatApprovals } from '../src/approvals.js';
import { Automation, validatePolicy } from '../src/automation.js';
import { Store } from '../src/core.js';
import {
  DEFAULT_NAS_ARCHIVE_URL,
  WXARC_PROACTIVE_SEND_TOOL,
  WxarcBridgeSecurityError,
  apply,
  createNasVaultProvider,
  createWechatSendSink,
  createWechatTargetDirectoryProvider,
  createWechatVaultProvider,
  registerWechatSendTool,
  resolveWechatVaultCircle,
  searchNasArchive,
} from '../src/index.js';
import type { WechatToolDefinition } from '../src/send-sink.js';

const OWNER_SOURCE_KEY = 'b'.repeat(64);
const signal = () => new AbortController().signal;

function createTestHub(t: TestContext) {
  const db = openHubDb({ inMemory: true });
  t.after(() => db.close());
  const guard = createDoorGuard();
  const hub = createHubService({}, { db, guard });
  return hub;
}

test('VaultProvider(wechat): enforces 4-tier visibility, unlabeled defaults to owner_private, compact <=200 snippet, and context expansion', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wxarc-vault-wx-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  t.after(() => store.close());

  const longBody = '发布计划确认 ' + '长文内容'.repeat(80);
  store.commit(
    'text',
    0,
    [
      { id: 1, kind: 'text', session: 'ext@chatroom', session_name: '公开交流群', sender: '路人甲', text: '发布计划确认 公开讨论', ts: 1700000001, local_type: 1 },
      { id: 2, kind: 'text', session: 'work@chatroom', session_name: '研发项目群', sender: '同事A', text: '上一条工作上下文', ts: 1700000002, local_type: 1 },
      { id: 3, kind: 'text', session: 'work@chatroom', session_name: '研发项目群', sender: '同事A', text: longBody, ts: 1700000003, local_type: 1 },
      { id: 4, kind: 'text', session: 'work@chatroom', session_name: '研发项目群', sender: '同事B', text: '下一条工作上下文', ts: 1700000004, local_type: 1 },
      { id: 5, kind: 'text', session: 'family@chatroom', session_name: '家庭小群', sender: '家人', text: '发布计划确认 家庭聚餐', ts: 1700000005, local_type: 1 },
      { id: 6, kind: 'text', session: 'unlabeled_dm', session_name: '未标注私聊', sender: '好友', text: '发布计划确认 私密备注', ts: 1700000006, local_type: 1 },
    ],
    1000,
  );

  const circles: Record<string, VaultVisibility> = {
    'ext@chatroom': 'external',
    'work@chatroom': 'work',
    'family@chatroom': 'family',
  };
  const wardrobe = {
    resolveVaultVisibility: (roomKey: string): VaultVisibility => circles[roomKey] ?? 'owner_private',
  };

  assert.equal(resolveWechatVaultCircle('unlabeled_dm', wardrobe), 'owner_private');
  assert.equal(resolveWechatVaultCircle('ext@chatroom', null), 'owner_private');

  const hub = createTestHub(t);
  hub.registerVaultProvider(createWechatVaultProvider({ db: store.db, getWardrobe: () => wardrobe }));

  hub.registerSessionPrincipal({ sessionId: 'ext-chat', role: 'external_chat', tier: 0, trustLevel: 'untrusted', boundRoomKey: 'ext@chatroom' });
  hub.registerSessionPrincipal({ sessionId: 'pr-public', role: 'worker', tier: 1, trustLevel: 'untrusted' });
  hub.registerSessionPrincipal({ sessionId: 'pr-work', role: 'worker', tier: 2, trustLevel: 'triage' });
  hub.registerSessionPrincipal({ sessionId: 'owner-main', role: 'owner_session', tier: 3, trustLevel: 'owner' });

  await assert.rejects(
    () => hub.vault.search({ query: '发布计划确认' }, { agent: { id: 'ext-chat' } }),
    (err: unknown) => err instanceof VaultError && err.code === 'VAULT_FORBIDDEN',
  );

  const tier1 = await hub.vault.search({ query: '发布计划确认' }, { agent: { id: 'pr-public' } });
  assert.deepEqual(tier1.hits.map((h) => h.roomKey), ['wechat:ext@chatroom']);

  const tier2 = await hub.vault.search({ query: '发布计划确认' }, { agent: { id: 'pr-work' } });
  assert.deepEqual(tier2.hits.map((h) => h.circle).sort(), ['external', 'work']);
  const workHit = tier2.hits.find((h) => h.roomKey === 'wechat:work@chatroom')!;
  assert.ok(workHit.snippet.length <= 200);
  assert.equal(workHit.snippet.includes('\n'), false);

  const tier3 = await hub.vault.search({ query: '发布计划确认' }, { agent: { id: 'owner-main' } });
  assert.equal(tier3.hits.length, 4);
  const unlabeledHit = tier3.hits.find((h) => h.roomKey === 'wechat:unlabeled_dm')!;
  assert.equal(unlabeledHit.circle, 'owner_private');

  const ctxWork = await hub.vault.context('wechat', workHit.itemId, { before: 1, after: 1 }, { agent: { id: 'pr-work' } });
  assert.equal(ctxWork.result?.items.length, 3);
  assert.equal(ctxWork.result?.items[0].text, '上一条工作上下文');
  assert.equal(ctxWork.result?.items[1].isTarget, true);
  assert.equal(ctxWork.result?.items[2].text, '下一条工作上下文');

  const deniedCtx = await hub.vault.context('wechat', unlabeledHit.itemId, { before: 1, after: 1 }, { agent: { id: 'pr-work' } });
  assert.equal(deniedCtx.result, null);
});

test('VaultProvider(nas) & nas-search: no hardcoded LAN IP, 4-tier filtering, unlabeled->owner_private, and context', async (t) => {
  assert.equal(DEFAULT_NAS_ARCHIVE_URL, '');
  await assert.rejects(
    () => searchNasArchive({ query: '历史' }),
    (err: unknown) => err instanceof WxarcBridgeSecurityError && err.code === 'EMPTY_NAS_URL',
  );

  const dir = mkdtempSync(join(tmpdir(), 'wxarc-vault-nas-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'nas.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE messages(id INTEGER PRIMARY KEY, session TEXT, session_name TEXT, sender TEXT, sender_id TEXT, text TEXT, ts INTEGER)');
  db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)').run(1, 'work@chatroom', '项目群', '同事', 'wxid_colleague', '部署前检查项', 1700001001);
  db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)').run(2, 'work@chatroom', '项目群', '同事', 'wxid_colleague', '里程碑验收 ' + '细节'.repeat(150), 1700001002);
  db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)').run(3, 'work@chatroom', '项目群', '同事', 'wxid_colleague', '部署后回访', 1700001003);
  db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)').run(4, 'unlabeled_chat', '私人聊天', '朋友', 'wxid_friend', '里程碑验收 私人记录', 1700001004);
  db.close();

  const hub = createTestHub(t);
  const wardrobe = {
    resolveVaultVisibility: (roomKey: string): VaultVisibility =>
      roomKey === 'work@chatroom' ? 'work' : 'owner_private',
  };
  let configuredPath = '';
  hub.registerVaultProvider(
    createNasVaultProvider({
      getConfig: () => ({ baseUrl: '', archivePath: configuredPath }),
      getWardrobe: () => wardrobe,
    }),
  );

  hub.registerSessionPrincipal({ sessionId: 'worker-t2', role: 'worker', tier: 2, trustLevel: 'triage' });
  hub.registerSessionPrincipal({ sessionId: 'owner-t3', role: 'owner_session', tier: 3, trustLevel: 'owner' });

  const unconfigured = await hub.vault.search({ query: '里程碑验收', sources: ['nas'] }, { agent: { id: 'owner-t3' } });
  assert.equal(unconfigured.total, 0);

  configuredPath = dbPath;
  const t2 = await hub.vault.search({ query: '里程碑验收', sources: ['nas'] }, { agent: { id: 'worker-t2' } });
  assert.equal(t2.hits.length, 1);
  assert.equal(t2.hits[0].circle, 'work');
  assert.ok(t2.hits[0].snippet.length <= 200);

  const t3 = await hub.vault.search({ query: '里程碑验收', sources: ['nas'] }, { agent: { id: 'owner-t3' } });
  assert.equal(t3.hits.length, 2);
  const privHit = t3.hits.find((h) => h.roomKey === 'wechat:unlabeled_chat')!;
  assert.equal(privHit.circle, 'owner_private');

  const workCtx = await hub.vault.context('nas', t2.hits[0].itemId, { before: 1, after: 1 }, { agent: { id: 'worker-t2' } });
  assert.equal(workCtx.result?.items.length, 3);
  assert.equal(workCtx.result?.items[1].isTarget, true);

  const blockedCtx = await hub.vault.context('nas', privHit.itemId, { before: 1, after: 1 }, { agent: { id: 'worker-t2' } });
  assert.equal(blockedCtx.result, null);
});

test('TargetDirectoryProvider registers into Hub and resolves/lists rooms', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wxarc-target-dir-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  t.after(() => store.close());

  const hub = createTestHub(t);
  hub.registerTargetDirectory(
    createWechatTargetDirectoryProvider(
      () => ({
        db: store.db,
        rules: [
          { kind: 'text', sourceId: 'proj@chatroom', title: '核心研发群' },
          { kind: 'text', sourceId: 'wxid_demo_peer', title: '测试联系人' },
        ],
      }),
      () => ({
        resolveVaultVisibility: (room: string): VaultVisibility =>
          room === 'proj@chatroom' ? 'work' : 'owner_private',
      }),
    ),
  );

  const resolved = await hub.resolveTarget({ targetName: '核心研发群' });
  assert.equal(resolved.status, 'matched');
  assert.equal(resolved.target?.chatId, 'proj@chatroom');
  assert.equal(resolved.target?.circle, 'work');

  const listed = await hub.listTargets({ source: 'wechat', kind: 'group' });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].roomKey, 'wechat:proj@chatroom');
});

test('Tool auth lockdown: wxarc_messages/status/targets/nas_search & wxarc_proactive_send enforce Hub SessionPrincipal and DoorGuard taint', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wxarc-auth-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const hub = createTestHub(t);
  const disposers: Array<() => unknown> = [];
  const tools = new Map<string, Record<string, any>>();

  const ctx: any = {
    hub,
    watcher: hub,
    on: () => () => {},
    provide: () => {},
    systemPrompt: { section: () => () => {} },
    agents: { get: () => undefined },
    connection: { requestRejection: () => undefined },
    webServer: { host: '127.0.0.1', port: 19999, register: () => () => {} },
    effect: (fn: () => () => unknown) => disposers.push(fn()),
    inject: (keys: string[], fn: (child: any) => void) => {
      if (keys.includes('tools')) {
        fn({
          effect: (ef: () => () => unknown) => disposers.push(ef()),
          tools: {
            register: (def: Record<string, any>) => {
              tools.set(def.name, def);
              return () => tools.delete(def.name);
            },
          },
        });
      }
      if (keys.includes('hub')) {
        fn({
          hub,
          watcher: hub,
          effect: (ef: () => () => unknown) => disposers.push(ef()),
          tools: {
            register: (def: Record<string, any>) => {
              tools.set(def.name, def);
              return () => tools.delete(def.name);
            },
          },
        });
      }
    },
    logger: { info() {}, warn() {} },
  };

  t.after(async () => {
    for (const d of disposers.reverse()) {
      await d();
    }
  });

  const nasPath = join(dir, 'nas-auth.sqlite');
  const nasDb = new DatabaseSync(nasPath);
  nasDb.exec('CREATE TABLE messages(id INTEGER PRIMARY KEY, session TEXT, session_name TEXT, sender TEXT, sender_id TEXT, text TEXT, ts INTEGER)');
  nasDb.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)').run(1, 'work@chatroom', '项目群', '同事', 'wxid_col', '验证查档', 1700002000);
  nasDb.close();

  apply(ctx, {
    stateDir: dir,
    url: 'http://127.0.0.1:1',
    pollMs: 3000,
    retain: 1000,
    nasArchivePath: nasPath,
    defaultNotifyTarget: 'filehelper',
    allowedTargets: ['filehelper', 'group@chatroom'],
    requireApprovalByDefault: false,
  });

  hub.registerSessionPrincipal({ sessionId: 'ext-1', role: 'external_chat', tier: 0, trustLevel: 'untrusted', boundRoomKey: 'group@chatroom' });
  hub.registerSessionPrincipal({ sessionId: 'worker-2', role: 'worker', tier: 2, trustLevel: 'triage' });
  hub.registerSessionPrincipal({ sessionId: 'owner-3', role: 'owner_session', tier: 3, trustLevel: 'owner' });

  const isOwnerForbidden = (err: unknown): boolean =>
    err instanceof WxarcBridgeSecurityError &&
    (err.code === 'OWNER_TOOL_FORBIDDEN' || err.code === 'NAS_SEARCH_FORBIDDEN');

  for (const [name, args] of [
    ['wxarc_status', {}],
    ['wxarc_messages', {}],
    ['wxarc_targets', {}],
    ['wxarc_nas_search', { query: '验证查档' }],
  ] as const) {
    const tool = tools.get(name)!;
    await assert.rejects(() => tool.execute(args), isOwnerForbidden);
    await assert.rejects(
      () => tool.execute(args, { agent: { id: 'ext-1', session: { header: { delegationDepth: 0 } } } }),
      isOwnerForbidden,
    );
    await assert.rejects(
      () => tool.execute(args, { agent: { id: 'worker-2', session: { header: { delegationDepth: 0 } } } }),
      isOwnerForbidden,
    );
    await assert.rejects(
      () =>
        tool.execute(
          args,
          { agent: { id: 'sub-1', session: { header: { delegationDepth: 1, parentSession: 'owner-3', origin: 'subagent' } } } },
        ),
      isOwnerForbidden,
    );
    const ownerRes = await tool.execute(args, { agent: { id: 'owner-3', session: { header: { delegationDepth: 0 } } } });
    assert.ok(ownerRes);
    const webRes = await tool.execute(args, { agent: { id: 'web-interactive-1', session: { header: { delegationDepth: 0 } } } });
    assert.ok(webRes);
  }

  const sink = createWechatSendSink({
    transport: {
      send: async () => ({ status: 'sent', deliveryId: 'del-1' }),
      recentMessages: async () => [],
      getAtmosphere: async ({ chatId }) => ({
        chatId,
        healthy: true,
        paused: false,
        messageCount: 0,
        lastMessageAt: null,
        secondsSinceLastMessage: null,
        ownSpokeSince: false,
        quiet: true,
        recentMessages: [],
      }),
      status: async () => ({ ok: true, mode: 'cordis', healthy: true }),
    },
    config: {
      allowedTargets: ['filehelper', 'group@chatroom'],
      requireApprovalByDefault: false,
    },
    db: hub.db,
  });
  hub.registerSink(sink);

  const sendTools = new Map<string, WechatToolDefinition>();
  registerWechatSendTool(
    {
      hub,
      tools: {
        register: (def) => {
          sendTools.set(def.name, def);
          return () => sendTools.delete(def.name);
        },
      },
    },
    { config: { defaultNotifyTarget: 'filehelper', allowedTargets: ['filehelper', 'group@chatroom'], requireApprovalByDefault: false } },
  );
  const sendTool = sendTools.get(WXARC_PROACTIVE_SEND_TOOL)!;

  await assert.rejects(
    () => sendTool.execute({ chatId: 'filehelper', text: 'nope' }, { agent: { id: 'worker-2', session: { header: { delegationDepth: 0 } } } }),
    /tier-3/,
  );

  const crossGroup = await sendTool.execute(
    { chatId: 'group@chatroom', text: '跨群必须进草稿', idempotencyKey: 'cross-group-1' },
    { agent: { id: 'owner-3', session: { header: { delegationDepth: 0 } } } },
  );
  assert.equal(crossGroup.status, 'staged');

  hub.markSessionTainted('owner-3', 'read_private');
  const taintedSend = await sendTool.execute(
    { chatId: 'filehelper', text: '污点必须进草稿', idempotencyKey: 'tainted-1' },
    { agent: { id: 'owner-3', session: { header: { delegationDepth: 0 } } } },
  );
  assert.equal(taintedSend.status, 'staged');
});

test('AgentBridge: registers external dsh_conversations as tier 0, downgrades legacy wxarc_admin_sessions while preserving disk dir when Router manages admin', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wxarc-thin-admin-'));
  const store = new Store(dir);
  const hub = createTestHub(t);

  const legacyDir = join(dir, 'work', 'legacy-admin-key');
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, 'notes.txt'), 'keep me read-only\n');

  const presets = new Map<unknown, string>();
  const agents = new Map<string, any>();
  const makeAgent = (id: string, cwd: string) => {
    const a = {
      id,
      cwd,
      session: { header: { delegationDepth: 0, origin: 'user' } },
      inbox: { clear() {} },
      model: { select() {} },
      whenIdle: async () => {},
      cancel() {},
    };
    agents.set(id, a);
    return a;
  };
  const legacyAgent = makeAgent('sess-legacy-admin', legacyDir);
  presets.set(legacyAgent.session, 'danger-full-access');

  const ctx: any = {
    on: () => () => {},
    systemPrompt: { section: () => () => {} },
    agents: { get: (id: string) => agents.get(id) },
    approval: { setPolicy() {} },
    permissionPresets: {
      permissionState: (s: unknown) => ({ sandbox: presets.get(s), approval: 'ask' }),
      set: (s: unknown, mode: string) => presets.set(s, mode),
    },
    llm: {
      resolveCallConfig: async () => ({}),
      resolveModelInfo: async () => ({ inputModalities: ['text'] }),
    },
    workspaceController: { create: async () => ({ created: false, workspace: { workspaceId: 'ws' } }) },
    workspaceRegistry: { get: () => ({ attachSession: async () => {} }) },
    sessionController: {
      resolveAgent: async (id: string) =>
        agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found' } },
      create: async ({ sessionId, cwd }: { sessionId: string; cwd: string }) => {
        makeAgent(sessionId, cwd);
        return { sessionId };
      },
      rename: async () => {},
      state: async () => ({ running: false, queue: [], pendingInput: [] }),
      prompt: async () => {},
    },
  };

  const bridge = new AgentBridge(ctx, store, {
    root: join(dir, 'work'),
    personas: { context: () => ({ name: '助手', memory: [] }) },
    hub,
    isRouterManagedAdmin: () => true,
    settings: () => ({
      revision: 1,
      policy: { ownId: 'wxid_bot', controllerId: 'wxid_owner', adminIds: [] },
    }),
  });
  t.after(async () => {
    await bridge.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  store.db
    .prepare('INSERT INTO dsh_conversations VALUES (?,?,?,?,?,?,?)')
    .run(
      'legacy-admin-key',
      'sess-legacy-admin',
      '微信 · 主人 · 助手',
      legacyDir,
      null,
      JSON.stringify({
        policy: { ownId: 'wxid_bot', controllerId: 'wxid_owner' },
        event: { kind: 'text', session: 'wxid_owner', senderId: 'wxid_owner', sourceKey: OWNER_SOURCE_KEY },
      }),
      Date.now(),
    );
  store.db.prepare('INSERT INTO wxarc_admin_sessions VALUES (?)').run('sess-legacy-admin');

  await bridge.refreshAdminWorkspaces();

  assert.equal(presets.get(legacyAgent.session), 'workspace-write');
  assert.equal(
    store.db.prepare('SELECT 1 FROM wxarc_admin_sessions WHERE session_id=?').get('sess-legacy-admin'),
    undefined,
  );
  assert.equal(existsSync(join(legacyDir, 'notes.txt')), true);

  const row = await bridge.ensure(
    { kind: 'text', session: 'ext_group@chatroom', senderId: 'wxid_stranger', sourceKey: OWNER_SOURCE_KEY },
    { title: '外部群' },
    { ownId: 'wxid_bot', controllerId: 'wxid_owner', provider: 'p', model: 'm' },
    signal(),
  );
  const principal = hub.getSessionPrincipal(row.session_id);
  assert.equal(principal?.role, 'external_chat');
  assert.equal(principal?.tier, 0);
  assert.equal(principal?.trustLevel, 'untrusted');
  assert.equal(principal?.boundRoomKey, 'ext_group@chatroom');
});

test('Single-owner controllerId convergence, legacy adminIds[0] fallback, approval deferral to Router, and non-blocking multimodal pass-through', async (t) => {
  assert.throws(
    () =>
      validatePolicy({
        enabled: false,
        adminIds: ['wxid_one', 'wxid_two'],
      }),
    /单一主人/,
  );

  const legacyPolicy = { ownId: 'wxid_bot', controllerId: '', adminIds: ['wxid_legacy'] };
  assert.equal(resolveOwnerId(legacyPolicy), 'wxid_legacy');
  assert.equal(
    adminPrincipal(
      { kind: 'text', session: 'wxid_legacy', senderId: 'wxid_legacy', sourceKey: OWNER_SOURCE_KEY },
      legacyPolicy,
    ),
    'wxid_legacy',
  );
  assert.equal(
    resolveOwnerId({ ownId: 'wxid_bot', controllerId: 'wxid_primary', adminIds: ['wxid_legacy'] }),
    'wxid_primary',
  );

  const dir = mkdtempSync(join(tmpdir(), 'wxarc-multimodal-admin-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  t.after(() => store.close());

  const imgPath = join(dir, 'shot.png');
  const wavPath = join(dir, 'voice.wav');
  const posterPath = join(dir, 'poster.jpg');
  writeFileSync(imgPath, 'img');
  writeFileSync(wavPath, 'wav');
  writeFileSync(posterPath, 'jpg');

  const nowMs = 1_700_000_000_000;
  const nowSec = Math.floor(nowMs / 1000);
  const received: AdminWechatMessage[] = [];
  let approvalConsumed = false;

  const auto = new Automation({
    store,
    listener: { status: () => ({ healthy: true }), wechatRoot: '/data/wxid_bot_abcd' },
    cua: { prepare: async () => async () => ({ confirmed: true }) },
    wxarcHome: dir,
    now: () => nowMs,
    resolveSource: (_h, e) => ({
      ...e,
      senderId: e.sender,
      sourceKey: OWNER_SOURCE_KEY,
      account: '/data/wxid_bot_abcd/db_storage',
    }),
    enrich: async (ev) => {
      await new Promise((r) => setTimeout(r, 180));
      const baseType = (ev.local_type ?? 0) % 4294967296;
      if (baseType === 3) {
        return { ...ev, image: { path: imgPath, status: 'read', hash: 'h1', mediaType: 'image/png', bytes: 3, source: 'test' } };
      }
      if (baseType === 34) {
        return { ...ev, voice: { kind: 'voice', status: 'transcribed', transcript: '帮我查下刚才那个 PR', wavPath } };
      }
      if (baseType === 43) {
        return {
          ...ev,
          video: {
            kind: 'video',
            status: 'ready',
            poster: { path: posterPath, status: 'read', hash: 'h2', mediaType: 'image/jpeg', bytes: 3, source: 'test' },
            transcript: '视频里的演示步骤',
          },
        };
      }
      if (baseType === 49) {
        return {
          ...ev,
          article: { status: 'read', title: '架构周报', text: '这是文章正文摘要内容。'.repeat(20) },
        };
      }
      return ev;
    },
  });
  t.after(() => auto.close());

  const approvals = new WechatApprovals(store, () => auto.settings());
  t.after(() => approvals.close());
  const origConsume = approvals.consume.bind(approvals);
  approvals.consume = (ev) => {
    const res = origConsume(ev);
    if (res) approvalConsumed = true;
    return res;
  };
  auto.approvals = approvals;

  auto.save(
    {
      ...auto.settings().policy,
      enabled: true,
      allChats: false,
      mode: 'send',
      provider: 'test',
      model: 'test',
      ownId: 'wxid_bot',
      controllerId: 'wxid_owner',
      instructions: '自然回复',
      rules: [{ kind: 'text', sourceId: 'filehelper', title: '文件助手', search: '文件助手', wechatId: '' }],
    },
    0,
  );

  auto.setAdminWechatHandler(async (msg) => {
    received.push(msg);
    return { handled: true };
  });

  store.commit(
    'text',
    0,
    [
      { id: 1, kind: 'text', session: 'wxid_owner', sender: 'wxid_owner', text: '确认', ts: nowSec - 5, local_type: 1 },
      { id: 2, kind: 'text', session: 'wxid_owner', sender: 'wxid_owner', text: '[图片]', ts: nowSec - 4, local_type: 3 },
      { id: 3, kind: 'text', session: 'wxid_owner', sender: 'wxid_owner', text: '', ts: nowSec - 3, local_type: 34 },
      { id: 4, kind: 'text', session: 'wxid_owner', sender: 'wxid_owner', text: '', ts: nowSec - 2, local_type: 43 },
      { id: 5, kind: 'text', session: 'wxid_owner', sender: 'wxid_owner', text: '[链接] 架构周报', ts: nowSec - 1, local_type: 49 },
    ],
    1000,
  );

  const startMs = Date.now();
  await auto.collect();
  const elapsedMs = Date.now() - startMs;

  assert.equal(approvalConsumed, false);
  assert.ok(elapsedMs < 140, `collect() blocked on multimodal enrichment (${elapsedMs}ms)`);
  assert.equal(auto.settings().cursor, 5);
  assert.equal(received.length, 1);
  assert.equal(received[0].text, '确认');

  await new Promise((r) => setTimeout(r, 320));
  assert.equal(received.length, 5);

  const imgMsg = received.find((m) => m.localType === 3)!;
  assert.equal(imgMsg.imagePath, imgPath);
  assert.deepEqual(imgMsg.mediaPaths, [imgPath]);

  const voiceMsg = received.find((m) => m.localType === 34)!;
  assert.equal(voiceMsg.voiceTranscript, '帮我查下刚才那个 PR');
  assert.deepEqual(voiceMsg.mediaPaths, [wavPath]);

  const videoMsg = received.find((m) => m.localType === 43)!;
  assert.equal(videoMsg.imagePath, posterPath);
  assert.equal(videoMsg.voiceTranscript, '视频里的演示步骤');

  const articleMsg = received.find((m) => m.localType === 49)!;
  assert.match(articleMsg.articleSummary || '', /架构周报/);
});
