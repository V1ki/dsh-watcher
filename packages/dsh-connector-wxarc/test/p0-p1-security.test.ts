import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { AgentBridge } from '../src/agent.js';
import { Automation } from '../src/automation.js';
import { Store } from '../src/core.js';
import { computeIncludeOwnerMemory, resolvePersonas } from '../src/index.js';
import {
  DEFAULT_NAS_ARCHIVE_URL,
  MAX_NAS_SEARCH_LIMIT,
  UNTRUSTED_NAS_MATERIAL_WARNING,
  assertNasSearchAuthorized,
  searchNasArchive,
  validateNasArchiveUrl,
} from '../src/nas-search.js';
import { listRoomTargets, resolveMemoTarget, resolveUniqueTarget } from '../src/targets.js';
import { WxarcBridgeSecurityError, validateBridgeBaseUrl } from '../src/transport.js';

const OWNER_SOURCE_KEY = 'a'.repeat(64);
const signal = () => new AbortController().signal;

function createAgentFixture(t: TestContext, personaContextImpl?: (...args: any[]) => any) {
  const dir = mkdtempSync(join(tmpdir(), 'wxarc-p01-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  t.after(() => store.close());
  const hooks: Record<string, (...args: any[]) => any> = {};
  const agents = new Map<string, any>();
  const prompts: Array<Record<string, any>> = [];
  const promptProviders: Array<(...args: any[]) => string> = [];
  const listener = { status: () => ({ healthy: true }), wechatRoot: '/data/wxid_me_abcd' };
  const auto = new Automation({
    store,
    listener,
    cua: { prepare: async () => async () => ({ confirmed: true }) },
    resolveSource: (_h, e) => ({
      ...e,
      sourceKey: OWNER_SOURCE_KEY,
      senderId: e.senderId || e.sender,
      account: '/data/wxid_me_abcd/db_storage',
    }),
    resolveTarget: async (e) => ({ title: e.session, sourceId: e.session, kind: 'text' }),
    wxarcHome: dir,
  });
  const ctx: any = {
    on: (type: string, fn: (...args: any[]) => any) => {
      hooks[type] = fn;
      return () => {
        delete hooks[type];
      };
    },
    systemPrompt: {
      section: (def: { text: (...args: any[]) => string }) => {
        promptProviders.push(def.text);
        return () => {};
      },
    },
    agents: { get: (id: string) => agents.get(id) },
    approval: { setPolicy() {} },
    permissionPresets: { set() {} },
    llm: {
      resolveCallConfig: async () => ({}),
      resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }),
    },
    workspaceController: {
      create: async () => ({ created: false, workspace: { workspaceId: 'ws' } }),
    },
    workspaceRegistry: { get: () => ({ attachSession: async () => {} }) },
    sessionController: {
      resolveAgent: async (id: string) =>
        agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found' } },
      create: async ({ sessionId, cwd }: { sessionId: string; cwd: string }) => {
        const agent: any = {
          id: sessionId,
          cwd,
          session: { header: { delegationDepth: 0, origin: 'user' } },
          inbox: { clear() {} },
          model: { select() {} },
          whenIdle: async () => {},
          cancel() {},
          busy: false,
        };
        agents.set(sessionId, agent);
        hooks['agent/created']?.({ agent });
        return { sessionId };
      },
      rename: async () => {},
      state: async ({ sessionId }: { sessionId: string }) => ({
        running: agents.get(sessionId)?.busy || false,
        queue: [],
        pendingInput: [],
      }),
      prompt: async (req: Record<string, any>) => {
        prompts.push(req);
        agents.get(req.sessionId).busy = true;
      },
    },
  };
  const bridge = new AgentBridge(ctx, store, {
    root: join(dir, 'work'),
    personas: {
      context: personaContextImpl || (() => ({ name: '测试角色', memory: [] })),
    },
    settings: () => auto.settings(),
  });
  auto.agentBridge = bridge;
  auto.save(
    {
      ...auto.settings().policy,
      enabled: true,
      allChats: true,
      mode: 'send',
      provider: 'test',
      model: 'test',
      ownId: 'wxid_me',
      controllerId: 'wxid_owner',
      adminIds: ['wxid_owner'],
      instructions: '自然回复',
      debounceMs: 0,
    },
    0,
  );
  return { dir, store, hooks, agents, prompts, auto, bridge, promptProviders };
}

test('P0: computeIncludeOwnerMemory and resolvePersonas align queryText/sourceText and prevent owner leak in groups or memoTrigger', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wxarc-p0-persona-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  t.after(() => store.close());

  const policy = { controllerId: 'wxid_owner' };
  assert.equal(
    computeIncludeOwnerMemory(
      { kind: 'text', session: 'wxid_owner', senderId: 'wxid_owner', text: '提醒我' },
      policy,
    ),
    true,
  );
  assert.equal(
    computeIncludeOwnerMemory(
      { kind: 'text', session: 'family@chatroom', senderId: 'wxid_owner', text: '群里说话' },
      policy,
      true,
    ),
    false,
  );
  assert.equal(
    computeIncludeOwnerMemory(
      { kind: 'text', session: 'wxid_friend', senderId: 'wxid_friend', text: '你好' },
      policy,
    ),
    false,
  );
  assert.equal(
    computeIncludeOwnerMemory(
      {
        kind: 'text',
        session: 'wxid_owner',
        senderId: 'wxid_owner',
        text: '到点提醒',
        memoTrigger: { memoId: 'm1' },
      },
      policy,
    ),
    false,
  );

  const cardCalls: Array<Record<string, any>> = [];
  const rememberCalls: Array<Record<string, any>> = [];
  const fakeWardrobe = {
    list: () => [],
    get: (id: string) => ({
      id,
      name: '小岚',
      kind: 'double',
      definition: '贴心分身',
      work: '',
      character: '',
      style: '自然',
      learning: true,
    }),
    create: () => ({}),
    save: () => ({}),
    getDynamicCard: (input: Record<string, any>) => {
      cardCalls.push(input);
      return {
        memory: [{ note: '圈层记忆' }],
        circle: input.chatId === 'family@chatroom' ? 'family' : 'external',
        version: 7,
        ownerMemoryIncluded: Boolean(input.includeOwnerMemory && !input.isGroup),
      };
    },
    recordTurnPreference: (input: Record<string, any>) => {
      rememberCalls.push(input);
      return { recorded: 1 };
    },
  };

  const adapter = resolvePersonas({ get: (k: string) => (k === 'personaWardrobe' ? fakeWardrobe : undefined) }, store);

  const groupCard = adapter.context(
    'p1',
    {
      kind: 'text',
      session: 'family@chatroom',
      senderId: 'wxid_owner',
      text: '看看语音',
      voice: { kind: 'voice', status: 'transcribed', transcript: '晚上买水果' },
      groupMembers: [{ id: 'wxid_mom' }],
    },
    policy,
    true,
  );
  assert.equal(groupCard.circle, 'family');
  assert.equal(groupCard.version, 7);
  assert.equal(groupCard.ownerMemoryIncluded, false);
  assert.equal(cardCalls[0].includeOwnerMemory, false);
  assert.equal(cardCalls[0].isGroup, true);
  assert.equal(cardCalls[0].ownerId, undefined);
  assert.equal(cardCalls[0].ownerPreview, false);
  assert.match(cardCalls[0].queryText, /看看语音/);
  assert.match(cardCalls[0].queryText, /晚上买水果/);
  assert.deepEqual(cardCalls[0].subjectWxids, ['wxid_owner', 'wxid_mom']);

  const ownerDmCard = adapter.context(
    'p1',
    {
      kind: 'text',
      session: 'wxid_owner',
      senderId: 'wxid_owner',
      text: '帮我查笔记',
    },
    policy,
  );
  assert.equal(ownerDmCard.ownerMemoryIncluded, true);
  assert.equal(cardCalls[1].includeOwnerMemory, true);
  assert.equal(cardCalls[1].ownerId, 'wxid_owner');
  assert.equal(cardCalls[1].isGroup, false);

  adapter.remember(
    'p1',
    {
      kind: 'text',
      seq: 12,
      session: 'family@chatroom',
      sender: '妈妈',
      senderId: 'wxid_mom',
      text: '我不爱吃香菜',
    },
    { memory: [{ note: '不吃香菜', quote: '我不爱吃香菜' }] },
  );
  assert.equal(rememberCalls.length, 1);
  assert.equal(rememberCalls[0].sourceText, '我不爱吃香菜');
  assert.equal(rememberCalls[0].chatId, 'family@chatroom');
  assert.equal(rememberCalls[0].senderWxid, 'wxid_mom');
});

test('P0: dsh_conversations.context does not freeze stale persona memory and refreshes per-turn including memoTrigger', async (t) => {
  let version = 1;
  const seenEvents: Array<Record<string, any>> = [];
  const f = createAgentFixture(t, (_id: string, event: Record<string, any>) => {
    seenEvents.push(event);
    return {
      id: 'p1',
      name: '小岚',
      kind: 'double',
      definition: `第${version}版设定`,
      style: '自然',
      memory: [{ note: `记忆版本-${version}` }],
    };
  });

  const policy = f.auto.settings().policy;
  const dmEvent = {
    id: 1,
    kind: 'text',
    session: 'wxid_owner',
    sender: '主人',
    senderId: 'wxid_owner',
    sourceKey: OWNER_SOURCE_KEY,
    local_type: 1,
    text: '第一轮消息',
    ts: Math.floor(Date.now() / 1000),
  };

  const run1 = await f.bridge.start(
    { event: dmEvent, rule: { title: '主人私聊' }, policy },
    signal(),
  );
  const rawRow = f.store.db
    .prepare('SELECT context FROM dsh_conversations WHERE session_id=?')
    .get(run1.session_id) as { context: string };
  const storedContext = JSON.parse(rawRow.context);
  assert.equal(storedContext.persona, undefined);
  assert.equal(storedContext.event.text, undefined);
  assert.equal(storedContext.personaName, '小岚');

  const prompt1 = f.bridge.prompt(run1.session_id);
  assert.match(prompt1, /记忆版本-1/);
  assert.match(prompt1, /管理员总控模式/);

  f.bridge.update(run1.id, { status: 'done' });
  f.agents.get(run1.session_id).busy = false;
  version = 2;

  const memoEvent = {
    id: 2,
    kind: 'text',
    session: 'wxid_owner',
    sender: '便签',
    senderId: 'wxid_owner',
    sourceKey: OWNER_SOURCE_KEY,
    local_type: 1,
    text: '该喝水了',
    ts: Math.floor(Date.now() / 1000),
    memoTrigger: {
      memoId: 'memo-1',
      title: '喝水提醒',
      basis: '用户要求',
      targetSessionId: run1.session_id,
    },
  };
  const run2 = await f.bridge.start(
    { event: memoEvent, rule: { title: '主人私聊' }, policy },
    signal(),
  );
  const prompt2 = f.bridge.prompt(run2.session_id);
  assert.match(prompt2, /记忆版本-2/);
  assert.doesNotMatch(prompt2, /记忆版本-1/);
  assert.doesNotMatch(prompt2, /管理员总控模式/);
  assert.equal(seenEvents.at(-1)?.memoTrigger?.memoId, 'memo-1');
});

test('P1: adminPrincipal, wxarcMemoPrincipal, wxarc_nas_search and wxarc_targets enforce strict unforgeable gating across DM, group, subagent, and memoTrigger', async (t) => {
  const f = createAgentFixture(t);
  const policy = f.auto.settings().policy;

  const adminEvent = {
    id: 10,
    kind: 'text',
    session: 'wxid_owner',
    sender: '主人',
    senderId: 'wxid_owner',
    sourceKey: OWNER_SOURCE_KEY,
    local_type: 1,
    text: '帮我查群便签',
    ts: Math.floor(Date.now() / 1000),
  };
  const adminRun = await f.bridge.start(
    { event: adminEvent, rule: { title: '主人私聊' }, policy },
    signal(),
  );
  const adminAgent = f.agents.get(adminRun.session_id);

  const adminPrincipalInfo = f.bridge.memoPrincipalForSession(adminRun.session_id, {
    agent: adminAgent,
  });
  assert.equal(adminPrincipalInfo?.isAdminDm, true);
  assert.equal(adminPrincipalInfo?.allowCrossRoom, true);
  assert.equal(adminPrincipalInfo?.delegationDepth, 0);
  assert.equal(adminPrincipalInfo?.adminId, 'wxid_owner');

  const nasPrincipalOk = f.bridge.nasPrincipalForSession(adminRun.session_id, {
    agent: adminAgent,
  });
  assert.equal(assertNasSearchAuthorized(nasPrincipalOk), 'wxid_owner');

  const preAllowNas = await f.hooks['tools/pre-execute'](
    { agent: adminAgent, name: 'wxarc_nas_search', arguments: { query: '合同' } },
    async () => ({ kind: 'allow' }),
  );
  assert.equal(preAllowNas.kind, 'allow');

  const adminMemoArgs: Record<string, any> = { allRooms: true };
  const preAllowMemo = await f.hooks['tools/pre-execute'](
    { agent: adminAgent, name: 'watcher_memo_list', arguments: adminMemoArgs },
    async () => ({ kind: 'allow' }),
  );
  assert.equal(preAllowMemo.kind, 'allow');
  assert.equal(adminMemoArgs.roomKey, undefined);

  const subagent = {
    id: 'subagent-child-1',
    session: {
      header: {
        parentSession: adminRun.session_id,
        delegationDepth: 1,
        origin: 'subagent',
      },
    },
  };
  const preSubagentNas = await f.hooks['tools/pre-execute'](
    { agent: subagent, name: 'wxarc_nas_search', arguments: { query: '密码' } },
    async () => ({ kind: 'allow' }),
  );
  assert.equal(preSubagentNas.kind, 'deny');
  const preSubagentTargets = await f.hooks['tools/pre-execute'](
    { agent: subagent, name: 'wxarc_targets', arguments: {} },
    async () => ({ kind: 'allow' }),
  );
  assert.equal(preSubagentTargets.kind, 'deny');

  const forgedDepthAgent = {
    id: adminRun.session_id,
    session: { header: { delegationDepth: 1, origin: 'subagent' } },
  };
  const forgedNasPrincipal = f.bridge.nasPrincipalForSession(adminRun.session_id, {
    agent: forgedDepthAgent as any,
  });
  assert.throws(() => assertNasSearchAuthorized(forgedNasPrincipal), /NAS_SEARCH_FORBIDDEN|仅允许/);

  const ownerInGroupEvent = {
    id: 11,
    kind: 'text',
    session: 'family@chatroom',
    sender: '主人',
    senderId: 'wxid_owner',
    sourceKey: OWNER_SOURCE_KEY,
    local_type: 1,
    text: '群里查档案',
    ts: Math.floor(Date.now() / 1000),
  };
  const groupRun = await f.bridge.start(
    { event: ownerInGroupEvent, rule: { title: '家人群' }, policy },
    signal(),
  );
  const groupAgent = f.agents.get(groupRun.session_id);
  const groupPrincipal = f.bridge.memoPrincipalForSession(groupRun.session_id, {
    agent: groupAgent,
  });
  assert.equal(groupPrincipal?.isAdminDm, false);
  assert.equal(groupPrincipal?.allowCrossRoom, false);
  assert.throws(
    () =>
      assertNasSearchAuthorized(
        f.bridge.nasPrincipalForSession(groupRun.session_id, { agent: groupAgent }),
      ),
    (err: unknown) =>
      err instanceof WxarcBridgeSecurityError && err.code === 'NAS_SEARCH_FORBIDDEN',
  );
  const preGroupNas = await f.hooks['tools/pre-execute'](
    { agent: groupAgent, name: 'wxarc_nas_search', arguments: { query: '机密' } },
    async () => ({ kind: 'allow' }),
  );
  assert.equal(preGroupNas.kind, 'deny');
  const preGroupAllRooms = await f.hooks['tools/pre-execute'](
    { agent: groupAgent, name: 'watcher_memo_list', arguments: { allRooms: true } },
    async () => ({ kind: 'allow' }),
  );
  assert.equal(preGroupAllRooms.kind, 'ask');
  assert.doesNotMatch(f.bridge.prompt(groupRun.session_id), /管理员总控模式/);

  f.bridge.update(adminRun.id, { status: 'done' });
  adminAgent.busy = false;
  await f.bridge.start(
    {
      event: {
        ...adminEvent,
        id: 12,
        memoTrigger: { memoId: 'm-admin', title: '触发', basis: '定时', targetSessionId: adminRun.session_id },
      },
      rule: { title: '主人私聊' },
      policy,
    },
    signal(),
  );
  const preMemoTriggerNas = await f.hooks['tools/pre-execute'](
    { agent: adminAgent, name: 'wxarc_nas_search', arguments: { query: '历史' } },
    async () => ({ kind: 'allow' }),
  );
  assert.equal(preMemoTriggerNas.kind, 'deny');
  assert.throws(
    () =>
      assertNasSearchAuthorized(
        f.bridge.nasPrincipalForSession(adminRun.session_id, { agent: adminAgent }),
      ),
    (err: unknown) =>
      err instanceof WxarcBridgeSecurityError && err.code === 'NAS_SEARCH_FORBIDDEN',
  );
});

test('P1: wxarc_targets resolves unique rooms and rejects missing, ambiguous, or conflicting targets without admin DM fallback', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wxarc-targets-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  t.after(() => store.close());
  store.db.exec(
    'CREATE TABLE IF NOT EXISTS dsh_conversations(id TEXT PRIMARY KEY,session_id TEXT NOT NULL UNIQUE,title TEXT NOT NULL,cwd TEXT NOT NULL,workspace_id TEXT,context TEXT NOT NULL,created_at INTEGER NOT NULL)',
  );
  store.db
    .prepare('INSERT INTO dsh_conversations VALUES (?,?,?,?,?,?,?)')
    .run(
      'k1',
      'sess-family-1',
      '微信 · 家人大群 · 小岚',
      '/tmp/k1',
      null,
      JSON.stringify({ event: { kind: 'text', session: '111@chatroom' } }),
      Date.now(),
    );
  store.db
    .prepare('INSERT INTO dsh_conversations VALUES (?,?,?,?,?,?,?)')
    .run(
      'k2',
      'sess-owner',
      '微信 · 主人私聊 · 小岚',
      '/tmp/k2',
      null,
      JSON.stringify({ event: { kind: 'text', session: 'wxid_owner' } }),
      Date.now(),
    );

  const source = {
    db: store.db,
    rules: [
      { kind: 'text', sourceId: '111@chatroom', title: '家人大群' },
      { kind: 'text', sourceId: '222@chatroom', title: '项目群' },
      { kind: 'text', sourceId: '333@chatroom', title: '项目群' },
    ],
    circleForRoom: (chatId: string) => (chatId === '111@chatroom' ? 'family' : 'external'),
  };

  const listed = listRoomTargets(source);
  assert.equal(listed.length, 4);

  const unique = resolveUniqueTarget(source, '家人大群');
  assert.equal(unique.ok, true);
  if (unique.ok) {
    assert.equal(unique.target.chatId, '111@chatroom');
    assert.equal(unique.target.roomKey, 'wechat:111@chatroom');
    assert.equal(unique.target.sessionId, 'sess-family-1');
    assert.equal(unique.target.circle, 'family');
  }

  const ambiguous = resolveUniqueTarget(source, '项目群');
  assert.equal(ambiguous.ok, false);
  if (!ambiguous.ok) {
    assert.equal(ambiguous.status, 'ambiguous');
    assert.equal(ambiguous.candidates.length, 2);
  }

  const missing = resolveUniqueTarget(source, '不存在的群');
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.status, 'not_found');
  }

  const memoAmbiguous = resolveMemoTarget(source, { targetName: '项目群' });
  assert.equal(memoAmbiguous.status, 'ambiguous');
  assert.equal(memoAmbiguous.target, undefined);

  const memoMissing = resolveMemoTarget(source, { targetName: '幽灵群' });
  assert.equal(memoMissing.status, 'not_found');
  assert.equal(memoMissing.target, undefined);

  const memoConflict = resolveMemoTarget(source, {
    roomKey: 'wechat:111@chatroom',
    targetChatId: '222@chatroom',
  });
  assert.equal(memoConflict.status, 'not_found');

  const memoMatched = resolveMemoTarget(source, { targetName: '家人大群' });
  assert.equal(memoMatched.status, 'matched');
  assert.equal(memoMatched.target?.roomKey, 'wechat:111@chatroom');
  assert.equal(memoMatched.target?.targetSessionId, 'sess-family-1');
});

test('P1 Track A: wxarc_nas_search blocks port 8765, removes hardcoded LAN default IP, caps results/text, marks untrusted reference framing, and supports HTTP + read-only SQLite', async (t) => {
  assert.equal(DEFAULT_NAS_ARCHIVE_URL, '');
  await assert.rejects(
    () => searchNasArchive({ query: '合同' }),
    (err: unknown) => err instanceof WxarcBridgeSecurityError && err.code === 'EMPTY_NAS_URL',
  );
  assert.throws(
    () => validateNasArchiveUrl('http://127.0.0.1:8765'),
    (err: unknown) =>
      err instanceof WxarcBridgeSecurityError && err.code === 'PERSONAL_WXARC_FORBIDDEN',
  );
  assert.throws(
    () => validateNasArchiveUrl('http://198.51.100.10:8765'),
    (err: unknown) =>
      err instanceof WxarcBridgeSecurityError && err.code === 'PERSONAL_WXARC_FORBIDDEN',
  );
  assert.throws(
    () => validateBridgeBaseUrl('http://127.0.0.1:8765'),
    (err: unknown) =>
      err instanceof WxarcBridgeSecurityError && err.code === 'PERSONAL_WXARC_FORBIDDEN',
  );

  const fetchedUrls: string[] = [];
  const longText = '合同编号A123 ' + 'x'.repeat(800);
  const rawItems = Array.from({ length: 60 }, (_, i) => ({
    id: i + 1,
    session: 'work@chatroom',
    session_name: '工作群',
    sender: '张三',
    text: i === 0 ? longText : `合同编号A123 第${i + 1}条`,
    ts: 1700000000 + i,
  }));

  const httpRes = await searchNasArchive(
    { query: '合同编号A123', limit: 99 },
    {
      baseUrl: 'http://198.51.100.10:28787',
      fetcher: async (url, init) => {
        fetchedUrls.push(url);
        assert.equal(init?.redirect, 'error');
        if (url.includes('/api/search')) {
          return { status: 404, ok: false, json: async () => ({}) };
        }
        return {
          status: 200,
          ok: true,
          text: async () => JSON.stringify({ items: rawItems }),
          json: async () => ({ items: rawItems }),
        };
      },
    },
  );
  assert.equal(fetchedUrls.length, 2);
  assert.equal(httpRes.ok, true);
  assert.equal(httpRes.readOnly, true);
  assert.equal(httpRes.untrustedReferenceMaterial, true);
  assert.equal(httpRes.warning, UNTRUSTED_NAS_MATERIAL_WARNING);
  assert.equal(httpRes.limit, MAX_NAS_SEARCH_LIMIT);
  assert.equal(httpRes.count, MAX_NAS_SEARCH_LIMIT);
  assert.equal(httpRes.truncated, true);
  assert.ok(httpRes.items[0].text.length <= 503);

  const dir = mkdtempSync(join(tmpdir(), 'wxarc-nas-db-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sqlitePath = join(dir, 'archive.sqlite');
  const db = new DatabaseSync(sqlitePath);
  db.exec(
    'CREATE TABLE messages(id INTEGER PRIMARY KEY, session TEXT, session_name TEXT, sender TEXT, sender_id TEXT, text TEXT, ts INTEGER)',
  );
  db.prepare(
    'INSERT INTO messages VALUES (?,?,?,?,?,?,?)',
  ).run(1, 'family@chatroom', '家人群', '奶奶', 'wxid_grandma', '小火车玩具收到了', 1700000100);
  db.close();

  const localRes = await searchNasArchive(
    { query: '小火车', limit: 5 },
    { archivePath: sqlitePath },
  );
  assert.equal(localRes.count, 1);
  assert.equal(localRes.items[0].sender, '奶奶');
  assert.equal(localRes.untrustedReferenceMaterial, true);

  const jsonlPath = join(dir, 'archive.jsonl');
  writeFileSync(
    jsonlPath,
    JSON.stringify({ id: 2, session: 'family@chatroom', sender: '爸爸', text: '周末去公园', ts: 1700000200 }) + '\n',
  );
  const jsonlRes = await searchNasArchive({ query: '公园' }, { archivePath: jsonlPath });
  assert.equal(jsonlRes.count, 1);
  assert.equal(jsonlRes.items[0].text, '周末去公园');

  const appDbPath = join(dir, 'app.db');
  const appDb = new DatabaseSync(appDbPath);
  appDb.exec('CREATE TABLE names(username TEXT PRIMARY KEY, name TEXT)');
  appDb.exec('CREATE TABLE messages(id INTEGER PRIMARY KEY, session TEXT, sender TEXT, text TEXT, ts INTEGER)');
  appDb.prepare('INSERT INTO names VALUES (?,?)').run('2585512030@chatroom', '相亲相爱');
  appDb.prepare('INSERT INTO names VALUES (?,?)').run('wxid_sister', '二姐');
  appDb
    .prepare('INSERT INTO messages VALUES (?,?,?,?,?)')
    .run(10, '2585512030@chatroom', 'wxid_sister', '黄桃很喜欢蜗牛玩具', 1700000300);
  appDb.close();

  const appDbRes = await searchNasArchive({ query: '蜗牛玩具' }, { archivePath: appDbPath });
  assert.equal(appDbRes.count, 1);
  assert.equal(appDbRes.items[0].sessionName, '相亲相爱');
  assert.equal(appDbRes.items[0].sender, '二姐');
  assert.equal(appDbRes.items[0].senderId, 'wxid_sister');

  const nasDir = mkdtempSync(join(tmpdir(), 'wxarc-nas-dir-'));
  t.after(() => rmSync(nasDir, { recursive: true, force: true }));
  writeFileSync(join(nasDir, '访问密码.txt'), '访问密码：test-secret-pw\n');

  const authCalls: Array<{ url: string; method?: string; cookie?: string; body?: string }> = [];
  const authedRes = await searchNasArchive(
    { query: '黄桃', limit: 5 },
    {
      baseUrl: 'http://198.51.100.10:28787',
      archivePath: nasDir,
      fetcher: async (url, init) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        authCalls.push({
          url,
          method: init?.method,
          cookie: headers.Cookie,
          body: typeof init?.body === 'string' ? init.body : undefined,
        });
        assert.equal(init?.redirect, 'error');
        if (url.endsWith('/api/login')) {
          return {
            status: 200,
            ok: true,
            headers: {
              get: (k: string) => (k.toLowerCase() === 'set-cookie' ? 'wxarc_sid=abc123; Path=/; HttpOnly' : null),
            },
            json: async () => ({ ok: true }),
          };
        }
        return {
          status: 200,
          ok: true,
          text: async () =>
            JSON.stringify({
              messages: [
                {
                  id: 99,
                  session: '2585512030@chatroom',
                  session_name: '相亲相爱',
                  sender: 'wxid_sister',
                  sender_name: '二姐',
                  text: '黄桃今天去公园玩了',
                  ts: 1700000400,
                },
              ],
            }),
          json: async () => ({}),
        };
      },
    },
  );
  assert.equal(authCalls.length, 2);
  assert.equal(authCalls[0].method, 'POST');
  assert.equal(authCalls[0].body, JSON.stringify({ password: 'test-secret-pw' }));
  assert.equal(authCalls[1].cookie, 'wxarc_sid=abc123');
  assert.match(authCalls[1].url, /\/api\/messages\?/);
  assert.equal(authedRes.count, 1);
  assert.equal(authedRes.items[0].sender, '二姐');
  assert.equal(authedRes.items[0].senderId, 'wxid_sister');
  assert.equal(authedRes.items[0].sessionName, '相亲相爱');
  assert.equal(authedRes.untrustedReferenceMaterial, true);

  await assert.rejects(
    () =>
      searchNasArchive(
        { query: '黄桃' },
        { baseUrl: 'http://127.0.0.1:8765', archivePath: nasDir },
      ),
    (err: unknown) =>
      err instanceof WxarcBridgeSecurityError && err.code === 'PERSONAL_WXARC_FORBIDDEN',
  );
});
