import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AgentBridge } from '../src/agent.js';
import {
  Automation,
  MAX_PROACTIVE_SEGMENTS,
  MAX_PROACTIVE_SEGMENT_CHARS,
  MAX_PROACTIVE_TOTAL_CHARS,
  PROACTIVE_AUTO_SPLIT_TARGET_CHARS,
  normalizeProactiveParts,
} from '../src/automation.js';
import { createWxarcBridge } from '../src/bridge.js';
import { Store } from '../src/core.js';
import { apply } from '../src/index.js';

function createAutomationFixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'wxarc-bridge-'));
  const store = new Store(dir);
  let clock = 1_700_000_000_000;
  let healthy = true;
  const prepared: Array<Record<string, any>> = [];
  const committed: Array<string> = [];
  const warnLogs: string[] = [];
  const cua = {
    prepare: async (job: Record<string, any>) => {
      prepared.push(job);
      return async () => {
        committed.push(job.decision.text);
        return { confirmed: true };
      };
    },
  };
  const listener = {
    status: () => ({ healthy }),
    wechatRoot: '/data/wxid_bot_1234',
  };
  const args = {
    store,
    listener,
    cua,
    wxarcHome: dir,
    resolveSource: (_h: string, e: Record<string, any>) => ({
      ...e,
      sourceKey: `key-${e.id}`,
      senderId: e.sender,
      account: '/data/wxid_bot_1234/db_storage',
    }),
    resolveTarget: async (e: Record<string, any>) => ({
      kind: 'text',
      sourceId: e.session,
      title: e.session,
      search: e.session,
      wechatId: e.session,
      uniqueTitle: true,
    }),
    logger: {
      warn: (...values: unknown[]) => {
        warnLogs.push(values.map((item) => String(item)).join(' '));
      },
    },
    now: () => clock,
  };
  const auto = new Automation(args);
  auto.save(
    {
      ...auto.settings().policy,
      enabled: true,
      mode: 'send',
      provider: 'test',
      model: 'test',
      ownId: 'wxid_bot',
      instructions: '自然回复',
      allChats: true,
    },
    0,
  );
  t.after(async () => {
    await auto.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    store,
    auto,
    args,
    cua,
    listener,
    prepared,
    committed,
    warnLogs,
    setHealthy: (v: boolean) => {
      healthy = v;
    },
    setClock: (v: number) => {
      clock = v;
    },
  };
}

test('sendProactive serializes concurrent deliveries, avoids stickers.lease, and enforces idempotency and ownId', async (t) => {
  const f = createAutomationFixture(t);
  let inFlight = 0;
  let maxInFlight = 0;
  const order: string[] = [];
  f.cua.prepare = async (job) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    assert.ok(f.auto.active !== null);
    await new Promise((r) => setTimeout(r, 25));
    return async () => {
      order.push(job.decision.text);
      inFlight -= 1;
      return { confirmed: true };
    };
  };

  const [r1, r2] = await Promise.all([
    f.auto.sendProactive({
      idempotencyKey: 'pro-1',
      session: 'room1@chatroom',
      text: '第一条主动消息',
      mode: 'send',
    }),
    f.auto.sendProactive({
      idempotencyKey: 'pro-2',
      session: 'room2@chatroom',
      text: '第二条主动消息',
      mode: 'send',
    }),
  ]);
  assert.equal(r1.status, 'sent');
  assert.equal(r2.status, 'sent');
  assert.equal(maxInFlight, 1);
  assert.deepEqual(order, ['第一条主动消息', '第二条主动消息']);

  const replay = await f.auto.sendProactive({
    idempotencyKey: 'pro-1',
    session: 'room1@chatroom',
    text: '第一条主动消息',
    mode: 'send',
  });
  assert.equal(replay.status, 'sent');
  assert.equal(replay.deliveryId, r1.deliveryId);
  assert.equal(order.length, 2);

  const mismatch = await f.auto.sendProactive({
    idempotencyKey: 'pro-mismatch',
    session: 'room1@chatroom',
    text: '不应发送',
    expectedOwnId: 'wxid_wrong',
  });
  assert.equal(mismatch.status, 'failed');
  assert.match(mismatch.detail || '', /ownId mismatch/);

  f.auto.stickers = { lease: { runId: 'active-sticker-run' } };
  const skipped = await f.auto.sendProactive({
    idempotencyKey: 'pro-sticker-busy',
    session: 'room1@chatroom',
    text: '表情面板占用',
  });
  assert.equal(skipped.status, 'skipped');
  f.auto.stickers = undefined;

  const staged = await f.auto.sendProactive({
    idempotencyKey: 'pro-draft',
    session: 'room1@chatroom',
    text: ['先起草第一句', '再补一句'],
    mode: 'draft',
  });
  assert.equal(staged.status, 'staged');
  assert.equal(order.length, 2);
});

test('sendProactive records sending before commit and recovers interrupted deliveries as uncertain without replay', async (t) => {
  const f = createAutomationFixture(t);
  let commitCalls = 0;
  f.cua.prepare = async () => async () => {
    commitCalls += 1;
    const row = f.store.db
      .prepare('SELECT status, clicked_at FROM proactive_deliveries WHERE idempotency_key = ?')
      .get('pro-crash') as { status: string; clicked_at: number | null };
    assert.equal(row.status, 'sending');
    assert.ok(typeof row.clicked_at === 'number' && row.clicked_at > 0);
    throw new Error('SwiftCUA crashed mid-click');
  };

  const first = await f.auto.sendProactive({
    idempotencyKey: 'pro-crash',
    session: 'peer1',
    text: '可能会发出去的消息',
  });
  assert.equal(first.status, 'uncertain');
  assert.equal(commitCalls, 1);

  const second = await f.auto.sendProactive({
    idempotencyKey: 'pro-crash',
    session: 'peer1',
    text: '可能会发出去的消息',
  });
  assert.equal(second.status, 'uncertain');
  assert.equal(second.deliveryId, first.deliveryId);
  assert.equal(commitCalls, 1);

  f.store.db
    .prepare(
      `INSERT INTO proactive_deliveries
       (id, idempotency_key, session, parts_json, mode, status, detail, reason, clicked_at, created_at, updated_at)
       VALUES ('wxp_interrupted', 'pro-restart', 'peer1', '["hello"]', 'send', 'sending', 'in flight', '', 1000, 1000, 1000)`,
    )
    .run();

  await f.auto.close();
  const restarted = new Automation(f.args);
  t.after(async () => {
    await restarted.close();
  });
  const recovered = restarted.store.db
    .prepare('SELECT status FROM proactive_deliveries WHERE idempotency_key = ?')
    .get('pro-restart') as { status: string };
  assert.equal(recovered.status, 'uncertain');

  const noReplay = await restarted.sendProactive({
    idempotencyKey: 'pro-restart',
    session: 'peer1',
    text: 'hello',
  });
  assert.equal(noReplay.status, 'uncertain');
  assert.equal(commitCalls, 1);
});

test('recentSessionMessages reads session history and reflects wxarc_chat_state.paused', async (t) => {
  const f = createAutomationFixture(t);
  const baseSec = Math.floor(1_700_000_000_000 / 1000);
  f.store.commit(
    'text',
    0,
    [
      {
        id: 1,
        kind: 'text',
        session: 'groupA@chatroom',
        sender: 'alice',
        text: '早安',
        ts: baseSec - 300,
        local_type: 1,
      },
      {
        id: 2,
        kind: 'text',
        session: 'other@chatroom',
        sender: 'bob',
        text: '别的群',
        ts: baseSec - 200,
        local_type: 1,
      },
      {
        id: 3,
        kind: 'text',
        session: 'groupA@chatroom',
        sender: 'wxid_bot',
        text: '早呀',
        ts: baseSec - 60,
        local_type: 1,
      },
    ],
    1000,
  );
  f.auto.batches.set({ session: 'groupA@chatroom' } as any, { paused: 1 });

  const recent = await f.auto.recentSessionMessages({
    session: 'groupA@chatroom',
    limit: 10,
  });
  assert.equal(recent.healthy, true);
  assert.equal(recent.paused, true);
  assert.equal(recent.chatPaused, true);
  assert.equal(recent.messages.length, 2);
  assert.deepEqual(
    recent.messages.map((m) => m.text),
    ['早安', '早呀'],
  );
  assert.equal(recent.messages[1].isOwn, true);
  assert.equal(recent.ownSpokeSince, true);
  assert.equal(recent.secondsSinceLastMessage, 60);

  const otherRecent = await f.auto.recentSessionMessages({
    session: 'other@chatroom',
    limit: 10,
  });
  assert.equal(otherRecent.paused, false);
  assert.equal(otherRecent.chatPaused, false);
  assert.equal(otherRecent.ownSpokeSince, false);
});

test('/wxarc/bridge/* enforces Bearer auth and loopback host, provides wxarcBridge, and prefers personaWardrobe', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wxarc-bridge-http-'));
  const disposers: Array<() => unknown> = [];
  const provided = new Map<string, unknown>();
  const registeredTools: string[] = [];
  let handler!: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  let wardrobeListCalls = 0;
  const fakeWardrobe = {
    list: () => {
      wardrobeListCalls += 1;
      return [{ id: 'shared-1', kind: 'original', name: '共享人物', revision: 1 }];
    },
    get: (id: string) => ({ id, kind: 'original', name: '共享人物', revision: 1 }),
    create: (kind: string) => ({ id: 'new', kind, name: '新', revision: 1 }),
    save: (v: unknown) => v,
    listMemories: () => [],
    editMemory: () => {},
    clearMemories: () => ({ deleted: 0 }),
    getDynamicCard: () => null,
    recordTurnPreference: () => ({ recorded: 0 }),
  };
  const ctx = {
    on: () => () => {},
    get: (serviceName: string) => (serviceName === 'personaWardrobe' ? fakeWardrobe : undefined),
    provide: (serviceName: string, service: unknown) => {
      provided.set(serviceName, service);
    },
    systemPrompt: { section: () => () => {} },
    agents: { get: () => undefined },
    connection: {
      requestRejection: (req: IncomingMessage) =>
        req.headers.cookie === 'test-auth=yes' ? undefined : 401,
    },
    webServer: {
      host: '127.0.0.1',
      port,
      register: (route: { handler: typeof handler }) => {
        handler = route.handler;
        return () => {};
      },
    },
    effect: (fn: () => () => unknown) => disposers.push(fn()),
    inject: (_keys: string[], fn: (child: any) => void) =>
      fn({
        effect: (effectFn: () => () => unknown) => disposers.push(effectFn()),
        tools: {
          register: (tool: { name: string }) => {
            registeredTools.push(tool.name);
            return () => {};
          },
        },
      }),
    logger: { info() {}, warn() {} },
  };
  const secretToken = 'test-bridge-secret-token-123456';
  try {
    apply(ctx, {
      stateDir: dir,
      url: 'http://127.0.0.1:1',
      pollMs: 3000,
      retain: 1000,
      bridgeToken: secretToken,
    });
    assert.deepEqual(registeredTools, [
      'wxarc_sticker_search',
      'wxarc_status',
      'wxarc_messages',
      'wxarc_targets',
      'wxarc_nas_search',
    ]);
    assert.equal(typeof provided.get('wxarcMemoPrincipal'), 'function');
    assert.equal(typeof provided.get('wxarcTargetDirectory'), 'function');
    const cordisBridge = provided.get('wxarcBridge') as ReturnType<typeof createWxarcBridge>;
    assert.ok(cordisBridge);
    assert.equal(typeof cordisBridge.send, 'function');
    assert.equal(typeof cordisBridge.recentMessages, 'function');
    assert.equal(typeof cordisBridge.status, 'function');

    const personasResp = (await (
      await fetch(`http://127.0.0.1:${port}/wxarc/personas`, {
        headers: { Cookie: 'test-auth=yes' },
      })
    ).json()) as { personas: Array<{ id: string }> };
    assert.equal(wardrobeListCalls > 0, true);
    assert.equal(personasResp.personas[0].id, 'shared-1');

    const missingAuth = await fetch(`http://127.0.0.1:${port}/wxarc/bridge/status`);
    assert.equal(missingAuth.status, 401);

    const wrongAuth = await fetch(`http://127.0.0.1:${port}/wxarc/bridge/status`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    assert.equal(wrongAuth.status, 401);

    const okStatus = await fetch(`http://127.0.0.1:${port}/wxarc/bridge/status`, {
      headers: { Authorization: `Bearer ${secretToken}` },
    });
    assert.equal(okStatus.status, 200);
    const statusBody = (await okStatus.json()) as { ok: boolean; healthy: boolean };
    assert.equal(statusBody.ok, true);
    assert.equal(statusBody.healthy, false);

    const okRecent = await fetch(
      `http://127.0.0.1:${port}/wxarc/bridge/recent?chatId=roomX@chatroom&limit=5`,
      { headers: { Authorization: `Bearer ${secretToken}` } },
    );
    assert.equal(okRecent.status, 200);
    const recentBody = (await okRecent.json()) as {
      chatId: string;
      paused: boolean;
      messages: unknown[];
    };
    assert.equal(recentBody.chatId, 'roomX@chatroom');
    assert.equal(recentBody.paused, false);
    assert.deepEqual(recentBody.messages, []);

    const draftSend = await fetch(`http://127.0.0.1:${port}/wxarc/bridge/send`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secretToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chatId: 'roomX@chatroom',
        text: '测试草稿',
        idempotencyKey: 'http-draft-1',
        mode: 'draft',
      }),
    });
    assert.equal(draftSend.status, 200);
    const draftBody = (await draftSend.json()) as { status: string; deliveryId: string };
    assert.equal(draftBody.status, 'staged');
    assert.ok(draftBody.deliveryId);
  } finally {
    for (const dispose of disposers.reverse()) {
      await dispose();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('watcher_memo_* whitelist binds current chat session and blocks cross-chat prompt injection', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wxarc-memo-gate-'));
  const store = new Store(dir);
  const hooks: Record<string, (...args: any[]) => any> = {};
  const agents = new Map<string, any>();
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
    llm: { resolveCallConfig: async () => ({}) },
    workspaceController: {
      create: async () => ({ created: false, workspace: { workspaceId: 'ws' } }),
    },
    workspaceRegistry: { get: () => ({ attachSession: async () => {} }) },
    sessionController: {
      resolveAgent: async (id: string) =>
        agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found' } },
      create: async ({ sessionId, cwd }: { sessionId: string; cwd: string }) => {
        const a = {
          id: sessionId,
          cwd,
          session: { header: {} },
          inbox: { clear() {} },
          model: { select() {} },
          whenIdle: async () => {},
          cancel() {},
        };
        agents.set(sessionId, a);
        hooks['agent/created']({ agent: a });
        return { sessionId };
      },
      rename: async () => {},
      state: async () => ({ running: false, queue: [], pendingInput: [] }),
      prompt: async () => {},
    },
  };
  const policy = {
    enabled: true,
    allChats: true,
    mode: 'send',
    provider: 'test',
    model: 'test',
    ownId: 'wxid_bot',
    instructions: '自然回复',
    personaId: '',
    controllerId: '',
    adminIds: [],
  };
  const bridge = new AgentBridge(ctx, store, {
    root: join(dir, 'work'),
    personas: { context: () => ({ name: '小岚' }) },
    settings: () => ({ revision: 1, policy }),
  });
  t.after(async () => {
    await bridge.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const run = await bridge.start(
    {
      event: {
        kind: 'text',
        session: 'groupA@chatroom',
        sender: 'member1',
        text: '下周提醒一下',
        ts: Math.floor(Date.now() / 1000),
      },
      rule: { title: '群A' },
      policy,
    },
    new AbortController().signal,
  );
  const agent = agents.get(run.session_id);
  const gate = hooks['tools/pre-execute'];

  const addArgs: Record<string, unknown> = { kind: 'time_nudge', basis: '下周跟进' };
  const addOk = await gate(
    { agent, callId: 'c1', name: 'watcher_memo_add', arguments: addArgs },
    async () => ({ kind: 'allow' }),
  );
  assert.equal(addOk.kind, 'allow');
  assert.equal(addArgs.targetChatId, 'groupA@chatroom');
  assert.equal(addArgs.roomKey, 'wechat:groupA@chatroom');

  const injectedTarget = await gate(
    {
      agent,
      callId: 'c2',
      name: 'watcher_memo_add',
      arguments: {
        kind: 'time_nudge',
        basis: '骚扰别的群',
        targetChatId: 'victim@chatroom',
      },
    },
    async () => ({ kind: 'allow' }),
  );
  assert.equal(injectedTarget.kind, 'ask');

  const injectedRoom = await gate(
    {
      agent,
      callId: 'c3',
      name: 'watcher_memo_add',
      arguments: {
        kind: 'time_nudge',
        basis: '骚扰私聊',
        roomKey: 'wechat:wxid_victim',
      },
    },
    async () => ({ kind: 'allow' }),
  );
  assert.equal(injectedRoom.kind, 'ask');

  const injectedNotify = await gate(
    {
      agent,
      callId: 'c4',
      name: 'watcher_memo_add',
      arguments: {
        kind: 'long_watch',
        basis: '偷发通知',
        notifyWechatChatId: 'wxid_victim',
      },
    },
    async () => ({ kind: 'allow' }),
  );
  assert.equal(injectedNotify.kind, 'ask');

  const listArgs: Record<string, unknown> = {};
  const listOk = await gate(
    { agent, callId: 'c5', name: 'watcher_memo_list', arguments: listArgs },
    async () => ({ kind: 'allow' }),
  );
  assert.equal(listOk.kind, 'allow');
  assert.equal(listArgs.roomKey, 'wechat:groupA@chatroom');

  const listForeign = await gate(
    {
      agent,
      callId: 'c6',
      name: 'watcher_memo_list',
      arguments: { roomKey: 'wechat:other@chatroom' },
    },
    async () => ({ kind: 'allow' }),
  );
  assert.equal(listForeign.kind, 'ask');

  const cancelOk = await gate(
    {
      agent,
      callId: 'c7',
      name: 'watcher_memo_cancel',
      arguments: { memoId: 'memo-1' },
    },
    async () => ({ kind: 'allow' }),
  );
  assert.equal(cancelOk.kind, 'allow');

  const subagent = {
    id: 'sub-session',
    session: { header: { parentSession: run.session_id, delegationDepth: 1, origin: 'subagent' } },
  };
  const subDenied = await gate(
    {
      agent: subagent,
      callId: 'c8',
      name: 'watcher_memo_add',
      arguments: { kind: 'time_nudge', basis: '子代理尝试' },
    },
    async () => ({ kind: 'allow' }),
  );
  assert.equal(subDenied.kind, 'ask');
});

test('queueMemoNudge routes reminder into original WeChat conversation with group members and native @ mention', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wxarc-memo-nudge-'));
  const store = new Store(dir);
  const hooks: Record<string, (...args: any[]) => any> = {};
  const agents = new Map<string, any>();
  const promptsSent: Array<{ sessionId: string; content: Array<{ type: string; text?: string }> }> = [];
  const preparedJobs: Array<{ decision: any; mentions?: any[] }> = [];
  let promptProvider: ((input: { agent?: any }) => string) | null = null;

  const ctx: any = {
    on: (type: string, fn: (...args: any[]) => any) => {
      hooks[type] = fn;
      return () => {
        delete hooks[type];
      };
    },
    systemPrompt: {
      section: (opts: { text: (input: { agent?: any }) => string }) => {
        promptProvider = opts.text;
        return () => {};
      },
    },
    agents: { get: (id: string) => agents.get(id) },
    approval: { setPolicy() {} },
    permissionPresets: { set() {} },
    llm: { resolveCallConfig: async () => ({}) },
    workspaceController: {
      create: async () => ({ created: false, workspace: { workspaceId: 'ws' } }),
    },
    workspaceRegistry: { get: () => ({ attachSession: async () => {} }) },
    sessionController: {
      resolveAgent: async (id: string) =>
        agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found' } },
      create: async ({ sessionId, cwd }: { sessionId: string; cwd: string }) => {
        const a = {
          id: sessionId,
          cwd,
          session: { header: {} },
          inbox: { clear() {} },
          model: { select() {} },
          whenIdle: async () => {},
          cancel() {},
        };
        agents.set(sessionId, a);
        hooks['agent/created']({ agent: a });
        return { sessionId };
      },
      rename: async () => {},
      state: async () => ({ running: false, queue: [], pendingInput: [] }),
      prompt: async (input: { sessionId: string; content: Array<{ type: string; text?: string }> }) => {
        promptsSent.push(input);
      },
    },
  };

  const groupMembers = [
    {
      id: 'wxid_zhou',
      nickname: '小周',
      groupNickname: '',
      uiName: '小周',
      uniqueUiName: true,
    },
  ];
  let rememberedCalls = 0;
  const personas: any = {
    context: () => ({ id: 'p1', name: '我的分身', kind: 'double', definition: '', work: '', character: '', style: '', learning: false, memory: [] }),
    get: () => ({ id: 'p1', name: '我的分身', revision: 1 }),
    ready: () => ({ id: 'p1', name: '我的分身', revision: 1 }),
    remember: () => {
      rememberedCalls += 1;
    },
  };
  const cua = {
    prepare: async (job: any) => {
      preparedJobs.push({ decision: job.decision, mentions: job.mentions });
      return async () => ({ confirmed: true, detail: 'ok' });
    },
  };
  const automation = new Automation({
    store: store as any,
    listener: { status: () => ({ healthy: true }), wechatRoot: '/tmp/wxid_bot_abcd' },
    personas,
    cua,
    wxarcHome: dir,
    resolveTarget: async () => ({
      kind: 'text',
      sourceId: 'demo-family@chatroom',
      title: '周末群',
      search: '周末群',
      wechatId: '',
      route: 'group',
      uniqueTitle: true,
    }),
    enrich: async (ev: any) => ({ ...ev, groupMembers }),
    identify: async (ev: any) => ({ ...ev, groupMembers }),
  });
  const policy = {
    enabled: true,
    allChats: true,
    mode: 'send' as const,
    provider: 'test',
    model: 'test',
    ownId: 'wxid_bot',
    instructions: '自然回复',
    personaId: 'p1',
    controllerId: '',
    adminIds: [],
    moments: 'off' as const,
    momentsNotBefore: 0,
    rules: [],
    maxAgeSeconds: 300,
    debounceMs: 10000,
    debounceMaxMessages: 10,
  };
  automation.save(policy, 0);
  const agentBridge = new AgentBridge(ctx, store as any, {
    root: join(dir, 'work'),
    personas,
    settings: () => automation.settings(),
  });
  automation.agentBridge = agentBridge;

  t.after(async () => {
    await automation.close();
    await agentBridge.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const firstRun = await agentBridge.start(
    {
      event: {
        kind: 'text',
        session: 'demo-family@chatroom',
        sender: '小周',
        senderId: 'wxid_zhou',
        text: '明天提醒我做八段锦',
        ts: Math.floor(Date.now() / 1000),
      },
      rule: { title: '周末群' },
      policy,
    },
    new AbortController().signal,
  );
  agentBridge.update(firstRun.id, { status: 'completed' });

  const queued = await automation.queueMemoNudge({
    memoId: 'memo-baduanjin-1',
    chatId: 'demo-family@chatroom',
    targetSessionId: firstRun.session_id,
    title: '提醒小周做八段锦',
    basis: '每天傍晚在群里 @ 小周做八段锦',
  });
  assert.equal(queued.status, 'queued');
  assert.equal(queued.sessionId, firstRun.session_id);
  assert.ok(queued.jobId);

  const dup = await automation.queueMemoNudge({
    memoId: 'memo-baduanjin-1',
    chatId: 'demo-family@chatroom',
    targetSessionId: firstRun.session_id,
    title: '提醒小周做八段锦',
    basis: '每天傍晚在群里 @ 小周做八段锦',
  });
  assert.equal(dup.status, 'queued');
  assert.equal(dup.jobId, queued.jobId);
  assert.equal(dup.detail, 'already_queued');

  promptsSent.length = 0;
  await automation.processNative();
  assert.equal(promptsSent.length, 1);
  assert.equal(promptsSent[0].sessionId, firstRun.session_id);
  assert.ok(promptsSent[0].content[0].text?.includes('[待惦记便签到点提醒]'));
  assert.ok(promptsSent[0].content[0].text?.includes('mentions'));

  const systemText = promptProvider!({ agent: agents.get(firstRun.session_id) });
  assert.ok(systemText.includes('wxid_zhou'));
  assert.ok(systemText.includes('小周'));

  const activeRun = agentBridge.active(firstRun.session_id)!;
  assert.ok(activeRun);
  agentBridge.event(firstRun.session_id, { type: 'turn/start', data: { turn: 2 } });
  agentBridge.event(firstRun.session_id, {
    type: 'assistant/message',
    data: {
      turn: 2,
      interrupted: false,
      message: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              action: 'reply',
              mentions: ['wxid_zhou'],
              text: '到点啦，八段锦练起来～',
              reason: '便签到点提醒',
            }),
          },
        ],
      },
    },
  });
  agentBridge.event(firstRun.session_id, {
    type: 'turn/end',
    data: { turn: 2, reason: { kind: 'completed' } },
  });

  await automation.processNative();
  assert.equal(preparedJobs.length, 1);
  assert.equal(preparedJobs[0].decision.text, '到点啦，八段锦练起来～');
  assert.equal(preparedJobs[0].mentions?.length, 1);
  assert.equal(preparedJobs[0].mentions?.[0].id, 'wxid_zhou');
  assert.equal(preparedJobs[0].mentions?.[0].name, '小周');
  assert.equal(rememberedCalls, 0);
  assert.equal(automation.job(queued.jobId!).status, 'sent');
});

test('normalizeProactiveParts auto-splits long strings by priority boundaries, accepts valid multi-segment arrays, and rejects true overflows', () => {
  assert.equal(MAX_PROACTIVE_SEGMENTS, 6);
  assert.equal(MAX_PROACTIVE_SEGMENT_CHARS, 1500);
  assert.equal(PROACTIVE_AUTO_SPLIT_TARGET_CHARS, 1200);
  assert.equal(MAX_PROACTIVE_TOTAL_CHARS, 6000);

  const para1 = '一'.repeat(500);
  const para2 = '二'.repeat(500);
  const para3 = '三'.repeat(500);
  const para4 = '四'.repeat(500);
  const byBlankLine = normalizeProactiveParts([para1, para2, para3, para4].join('\n\n'));
  assert.equal(byBlankLine.ok, true);
  assert.equal(byBlankLine.parts.length, 2);
  assert.equal(byBlankLine.parts[0], `${para1}\n\n${para2}`);
  assert.equal(byBlankLine.parts[1], `${para3}\n\n${para4}`);

  const lines = Array.from({ length: 6 }, (_, i) => `行${i + 1}-${'文'.repeat(490)}`);
  const bySingleLine = normalizeProactiveParts(lines.join('\n'));
  assert.equal(bySingleLine.ok, true);
  assert.equal(bySingleLine.parts.length, 3);
  assert.ok(bySingleLine.parts.every((part) => part.length <= PROACTIVE_AUTO_SPLIT_TARGET_CHARS));
  assert.equal(bySingleLine.parts.join('\n'), lines.join('\n'));

  const sentences = Array.from({ length: 30 }, (_, i) => `第${i + 1}句${'测'.repeat(92)}。`).join('');
  assert.ok(sentences.length > 2800 && sentences.length < 3200);
  const byPunctuation = normalizeProactiveParts(sentences);
  assert.equal(byPunctuation.ok, true);
  assert.ok(byPunctuation.parts.length >= 3 && byPunctuation.parts.length <= MAX_PROACTIVE_SEGMENTS);
  assert.ok(byPunctuation.parts.every((part) => part.length <= PROACTIVE_AUTO_SPLIT_TARGET_CHARS));
  assert.ok(byPunctuation.parts.slice(0, -1).every((part) => part.endsWith('。')));
  assert.equal(byPunctuation.parts.join(''), sentences);

  const unbrokenWithEmoji = 'a'.repeat(1199) + '😀' + 'b'.repeat(900);
  const byHardCut = normalizeProactiveParts(unbrokenWithEmoji);
  assert.equal(byHardCut.ok, true);
  assert.equal(byHardCut.parts.length, 2);
  assert.equal(byHardCut.parts[0], 'a'.repeat(1199));
  assert.equal(byHardCut.parts[1], '😀' + 'b'.repeat(900));

  const fourSegments = [
    '甲'.repeat(1400),
    '乙'.repeat(1400),
    '丙'.repeat(1400),
    '丁'.repeat(1400),
  ];
  const multiArrayOk = normalizeProactiveParts(fourSegments);
  assert.equal(multiArrayOk.ok, true);
  assert.deepEqual(multiArrayOk.parts, fourSegments);

  const sevenAwkwardParagraphs = Array.from({ length: 7 }, (_, i) => `${i + 1}${'段'.repeat(779)}`).join(
    '\n\n',
  );
  assert.ok(sevenAwkwardParagraphs.length > 5000 && sevenAwkwardParagraphs.length <= 6000);
  const packed = normalizeProactiveParts(sevenAwkwardParagraphs);
  assert.equal(packed.ok, true);
  assert.ok(packed.parts.length <= MAX_PROACTIVE_SEGMENTS);
  assert.ok(packed.parts.every((part) => part.length <= MAX_PROACTIVE_SEGMENT_CHARS));

  const overTotal = normalizeProactiveParts('超'.repeat(MAX_PROACTIVE_TOTAL_CHARS + 1));
  assert.equal(overTotal.ok, false);
  assert.match(overTotal.error, /6000/);

  const tooManyInputSegments = normalizeProactiveParts(['1', '2', '3', '4', '5', '6', '7']);
  assert.equal(tooManyInputSegments.ok, false);
  assert.match(tooManyInputSegments.error, /between 1 and 6 segments/);

  const cannotFitAfterSplit = normalizeProactiveParts([
    '段1',
    '段2',
    '段3',
    '段4',
    '段5',
    '长'.repeat(2000),
  ]);
  assert.equal(cannotFitAfterSplit.ok, false);
  assert.match(cannotFitAfterSplit.error, /exceeds maximum of 6 segments/);
});

test('sendProactive delivers 2000-3000 char auto-split strings, multi-segment arrays >1500 chars, and warns on rejected overflows', async (t) => {
  const f = createAutomationFixture(t);

  const text2000 = [
    '第一部分：背景说明。' + '甲'.repeat(650),
    '第二部分：问题排查。' + '乙'.repeat(650),
    '第三部分：修复结论。' + '丙'.repeat(680),
  ].join('\n\n');
  assert.ok(text2000.length >= 2000);

  const res2000 = await f.auto.sendProactive({
    idempotencyKey: 'pro-2000',
    session: 'room1@chatroom',
    text: text2000,
    mode: 'send',
    reason: 'long_summary_2000',
  });
  assert.equal(res2000.status, 'sent');
  assert.ok(f.committed.length >= 2 && f.committed.length <= MAX_PROACTIVE_SEGMENTS);
  assert.ok(f.committed.every((chunk) => chunk.length <= PROACTIVE_AUTO_SPLIT_TARGET_CHARS));
  assert.equal(f.committed.join('\n\n'), text2000);

  f.committed.length = 0;
  const text3000 = Array.from(
    { length: 6 },
    (_, idx) => `第${idx + 1}节汇总：` + '摘'.repeat(495),
  ).join('\n\n');
  assert.ok(text3000.length >= 3000);

  const res3000 = await f.auto.sendProactive({
    idempotencyKey: 'pro-3000',
    session: 'room1@chatroom',
    text: text3000,
    mode: 'send',
    reason: 'long_summary_3000',
  });
  assert.equal(res3000.status, 'sent');
  assert.equal(f.committed.length, 3);
  assert.ok(f.committed.every((chunk) => chunk.length <= PROACTIVE_AUTO_SPLIT_TARGET_CHARS));
  assert.equal(f.committed.join('\n\n'), text3000);

  f.committed.length = 0;
  const multiSegments = ['第一段' + 'A'.repeat(1100), '第二段' + 'B'.repeat(1100), '第三段' + 'C'.repeat(1100)];
  const resMulti = await f.auto.sendProactive({
    idempotencyKey: 'pro-multi-3300',
    session: 'room1@chatroom',
    text: multiSegments,
    mode: 'send',
    reason: 'multi_segment_over_1500',
  });
  assert.equal(resMulti.status, 'sent');
  assert.deepEqual(f.committed, multiSegments);

  f.warnLogs.length = 0;
  const resTooLong = await f.auto.sendProactive({
    idempotencyKey: 'pro-too-long',
    session: 'room1@chatroom',
    text: '超'.repeat(6001),
    mode: 'send',
    reason: 'overflow_check',
  });
  assert.equal(resTooLong.status, 'failed');
  assert.match(resTooLong.detail || '', /6000/);
  assert.ok(
    f.warnLogs.some((line) => line.includes('pro-too-long') && line.includes('6000')),
  );

  f.warnLogs.length = 0;
  const resOverflowSegments = await f.auto.sendProactive({
    idempotencyKey: 'pro-overflow-segs',
    session: 'room1@chatroom',
    text: ['a', 'b', 'c', 'd', 'e', '长'.repeat(2000)],
    mode: 'send',
    reason: 'segment_overflow_check',
  });
  assert.equal(resOverflowSegments.status, 'failed');
  assert.match(resOverflowSegments.detail || '', /6 segments/);
  assert.ok(
    f.warnLogs.some((line) => line.includes('pro-overflow-segs') && line.includes('6 segments')),
  );

  f.auto.save(
    {
      ...f.auto.settings().policy,
      controllerId: 'wxid_admin_demo',
    },
    f.auto.settings().revision,
  );
  f.auto.setAdminWechatHandler(async () => ({
    handled: true,
    replyText: '溢'.repeat(6005),
  }));
  f.warnLogs.length = 0;
  f.store.commit(
    'text',
    0,
    [
      {
        id: 901,
        kind: 'text',
        session: 'wxid_admin_demo',
        sender: 'wxid_admin_demo',
        text: '测试超长回报',
        ts: Math.floor(1_700_000_000_000 / 1000) - 5,
        local_type: 1,
      },
    ],
    1000,
  );
  await f.auto.collect();
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(
    f.warnLogs.some((line) => line.includes('admin-wechat-reply:1') && line.includes('6000')),
  );
  assert.ok(
    f.warnLogs.some((line) => line.includes('管理员微信自动回复未送达') && line.includes('6000')),
  );
});
