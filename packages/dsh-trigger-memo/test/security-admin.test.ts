import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openHubDb } from '@local/dsh-hub';
import type {
  HubService,
  MemoRecord,
  NormalizedEvent,
  WechatAtmosphere,
  WechatMemoNudgeInput,
  WechatSendInput,
  WechatTransport,
} from '@local/dsh-hub/contracts';
import {
  MemoAuthorizationError,
  MemoEngine,
  MemoIdempotencyConflictError,
  MemoStore,
  MemoTargetError,
  registerMemoTools,
  type MemoCallerPrincipal,
  type MemoTargetBinding,
  type MemoTargetResolver,
  type MemoToolDefinition,
  type ToolExecutionContext,
} from '../src/index.js';

interface TestHarness {
  hub: HubService;
  ingested: NormalizedEvent[];
  wechatSent: WechatSendInput[];
  nudges: WechatMemoNudgeInput[];
  close: () => void;
}

function createHarness(): TestHarness {
  const db = openHubDb({ inMemory: true });
  const ingested: NormalizedEvent[] = [];
  const wechatSent: WechatSendInput[] = [];
  const nudges: WechatMemoNudgeInput[] = [];

  const atmosphere: WechatAtmosphere = {
    chatId: 'w-group@chatroom',
    healthy: true,
    paused: false,
    messageCount: 0,
    lastMessageAt: null,
    secondsSinceLastMessage: 3600,
    ownSpokeSince: false,
    quiet: true,
    recentMessages: [],
  };

  let transport: WechatTransport | null = {
    async send(input) {
      wechatSent.push(input);
      return { status: 'sent', deliveryId: `del_${wechatSent.length}` };
    },
    async triggerMemoNudge(input) {
      nudges.push(input);
      return {
        status: 'queued',
        jobId: nudges.length,
        sessionId: input.targetSessionId ?? undefined,
        detail: 'queued',
      };
    },
    async recentMessages() {
      return [];
    },
    async getAtmosphere(params) {
      return { ...atmosphere, chatId: params.chatId };
    },
    async status() {
      return { ok: true, mode: 'cordis', healthy: true };
    },
  };

  const hub = {
    configRevision: 1,
    db,
    wardrobe: null,
    guard: {} as HubService['guard'],
    getWardrobe: () => null,
    registerConnector: () => () => undefined,
    listConnectors: () => [],
    registerSubscription: () => {
      throw new Error('not implemented');
    },
    resolveSubscription: () => null,
    removeSubscription: () => false,
    listSubscriptions: () => [],
    onUnclaimedEvent: () => () => undefined,
    registerSource: () => () => undefined,
    registerResolver: () => () => undefined,
    registerSink: () => () => undefined,
    registerRule: () => () => undefined,
    registerWechatTransport(next: WechatTransport) {
      transport = next;
      return () => {
        transport = null;
      };
    },
    getWechatTransport: () => transport,
    async ingest(event: NormalizedEvent) {
      ingested.push(event);
      return { accepted: true, inboxId: `inb_${ingested.length}` };
    },
    async invokeSink() {
      return { status: 'executed' as const };
    },
    approveDraft: async () => ({ status: 'executed' as const }),
    discardDraft: async () => undefined,
    listInbox: () => [],
    listWorkstreams: () => [],
    listDrafts: () => [],
    getStatus: () => ({
      sources: [],
      connectors: [],
      sinks: [],
      wechatTransportMode: 'cordis' as const,
      activeWorkstreams: 0,
      activeSubscriptions: 0,
      unreadInbox: 0,
      pendingDrafts: 0,
      autoSessionsThisHour: 0,
      configRevision: 1,
    }),
  } as HubService;

  return {
    hub,
    ingested,
    wechatSent,
    nudges,
    close: () => db.close(),
  };
}

function createDirectoryResolver(targets: MemoTargetBinding[]): MemoTargetResolver {
  return (query) => {
    const matches = targets.filter((t) => {
      if (query.roomKey && t.roomKey !== query.roomKey) return false;
      if (query.targetChatId && t.chatId !== query.targetChatId) return false;
      if (query.notifyWechatChatId && t.notifyWechatChatId !== query.notifyWechatChatId) return false;
      if (query.targetSessionId && t.targetSessionId && t.targetSessionId !== query.targetSessionId) {
        return false;
      }
      if (query.targetName && t.title !== query.targetName) return false;
      return true;
    });
    if (matches.length === 0) {
      return { status: 'not_found', detail: 'Target room not found' };
    }
    if (matches.length > 1) {
      return {
        status: 'ambiguous',
        candidates: matches.map((m) => ({
          chatId: m.chatId,
          roomKey: m.roomKey,
          title: m.title ?? null,
        })),
        detail: 'Multiple rooms match the requested target name',
      };
    }
    return { status: 'matched', target: matches[0] };
  };
}

function makeExec(
  sessionId: string,
  opts: { delegationDepth?: number; origin?: string } = {},
): ToolExecutionContext {
  return {
    agent: {
      id: sessionId,
      session: {
        header: {
          delegationDepth: opts.delegationDepth ?? 0,
          origin: opts.origin,
        },
      },
    },
  };
}

function mountTools(
  engine: MemoEngine,
  principals: Record<string, MemoCallerPrincipal>,
  directory?: MemoTargetResolver,
): {
  add: MemoToolDefinition;
  list: MemoToolDefinition;
  cancel: MemoToolDefinition;
} {
  const registered = new Map<string, MemoToolDefinition>();
  const services = new Map<string, unknown>([
    [
      'tools',
      {
        register(def: MemoToolDefinition) {
          registered.set(def.name, def);
          return () => registered.delete(def.name);
        },
      },
    ],
    [
      'wxarcSessionChat',
      (sessionId: string) => principals[sessionId]?.boundChatId ?? null,
    ],
    [
      'wxarcMemoPrincipal',
      (sessionId: string) => principals[sessionId] ?? null,
    ],
  ]);
  if (directory) {
    services.set('wxarcTargetDirectory', directory);
  }
  registerMemoTools({ get: (name) => services.get(name) }, engine);
  return {
    add: registered.get('watcher_memo_add') as MemoToolDefinition,
    list: registered.get('watcher_memo_list') as MemoToolDefinition,
    cancel: registered.get('watcher_memo_cancel') as MemoToolDefinition,
  };
}

describe('Redline #1: P0 cross-room cancel denied atomically with zero ownership leak', () => {
  it('blocks non-admin room from cancelling another room memo and returns identical non-leaking error', async () => {
    const harness = createHarness();
    try {
      const engine = new MemoEngine({
        hub: harness.hub,
        now: () => new Date('2026-11-26T08:00:00.000Z'),
      });
      const principals: Record<string, MemoCallerPrincipal> = {
        'sess-family': {
          sessionId: 'sess-family',
          boundChatId: 'family@chatroom',
          roomKey: 'wechat:family@chatroom',
          isAdminDm: false,
          delegationDepth: 0,
          allowCrossRoom: false,
        },
        'sess-work': {
          sessionId: 'sess-work',
          boundChatId: 'work@chatroom',
          roomKey: 'wechat:work@chatroom',
          isAdminDm: false,
          delegationDepth: 0,
          allowCrossRoom: false,
        },
        'sess-admin-dm': {
          sessionId: 'sess-admin-dm',
          boundChatId: 'wxid_owner',
          roomKey: 'wechat:wxid_owner',
          isAdminDm: true,
          adminId: 'wxid_owner',
          delegationDepth: 0,
          allowCrossRoom: true,
        },
      };
      const tools = mountTools(engine, principals);

      const created = (await tools.add.execute(
        {
          kind: 'time_nudge',
          title: '家庭提醒',
          basis: '提醒做八段锦',
          windowStart: '2026-11-26T09:00:00.000Z',
          windowEnd: '2026-11-26T10:00:00.000Z',
        },
        makeExec('sess-family'),
      )) as { ok: true; memo: MemoRecord };
      const beforeRow = engine.store.getMemo(created.memo.id) as MemoRecord;

      const crossCancel = (await tools.cancel.execute(
        { memoId: created.memo.id, reason: 'steal cancel' },
        makeExec('sess-work'),
      )) as { ok: boolean; memo: MemoRecord | null; detail: string };
      const missingCancel = (await tools.cancel.execute(
        { memoId: 'memo_does_not_exist_999', reason: 'probe' },
        makeExec('sess-work'),
      )) as { ok: boolean; memo: MemoRecord | null; detail: string };

      assert.equal(crossCancel.ok, false);
      assert.equal(crossCancel.memo, null);
      assert.equal(crossCancel.detail, missingCancel.detail);
      assert.doesNotMatch(crossCancel.detail, /family@chatroom/);

      const forgedArgsCancel = (await tools.cancel.execute(
        {
          memoId: created.memo.id,
          roomKey: 'wechat:family@chatroom',
          isAdmin: true,
          allowCrossRoom: true,
          adminPrincipal: 'wxid_owner',
        },
        makeExec('sess-work'),
      )) as { ok: boolean; memo: MemoRecord | null; detail: string };
      assert.equal(forgedArgsCancel.ok, false);
      assert.equal(forgedArgsCancel.memo, null);
      assert.equal(forgedArgsCancel.detail, missingCancel.detail);

      const afterFailedCancel = engine.store.getMemo(created.memo.id) as MemoRecord;
      assert.equal(afterFailedCancel.status, 'active');
      assert.equal(afterFailedCancel.updatedAt, beforeRow.updatedAt);
      assert.equal(afterFailedCancel.resultSummary, null);

      const adminWrongRoom = (await tools.cancel.execute(
        { memoId: created.memo.id, roomKey: 'wechat:work@chatroom', reason: 'wrong room check' },
        makeExec('sess-admin-dm'),
      )) as { ok: boolean; memo: MemoRecord | null };
      assert.equal(adminWrongRoom.ok, false);
      assert.equal(engine.store.getMemo(created.memo.id)?.status, 'active');

      const adminExactCancel = (await tools.cancel.execute(
        { memoId: created.memo.id, roomKey: 'wechat:family@chatroom', reason: 'admin verified' },
        makeExec('sess-admin-dm'),
      )) as { ok: boolean; memo: MemoRecord | null };
      assert.equal(adminExactCancel.ok, true);
      assert.equal(adminExactCancel.memo?.status, 'torn');
      assert.equal(engine.store.getMemo(created.memo.id)?.status, 'torn');
    } finally {
      harness.close();
    }
  });

  it('blocks cross-session cancel in non-WeChat DSH sessions and fails closed when store scope is missing', async () => {
    const harness = createHarness();
    try {
      const workerThreads: Record<string, string> = {
        'sess-alpha': 'room-alpha',
        'sess-beta': 'room-beta',
      };
      const engine = new MemoEngine({
        hub: {
          ...harness.hub,
          resolveSessionPrincipal: (exec) => {
            const sid = exec?.agent?.id ?? null;
            const thread = sid ? workerThreads[sid] : undefined;
            return {
              sessionId: sid,
              rootSessionId: sid,
              role: thread ? 'worker' : 'unknown',
              tier: thread ? 2 : 0,
              trustLevel: thread ? 'triage' : 'untrusted',
              delegationDepth: 0,
              isSubagent: false,
              tainted: false,
              turnPrivateRead: false,
              allowedCircles: thread ? ['external', 'work'] : [],
              boundThreadKey: thread ?? null,
            };
          },
        },
        now: () => new Date('2026-11-26T08:00:00.000Z'),
      });
      const registered = new Map<string, MemoToolDefinition>();
      registerMemoTools(
        {
          tools: {
            register(def) {
              registered.set(def.name, def);
              return () => registered.delete(def.name);
            },
          },
        },
        engine,
      );
      const add = registered.get('watcher_memo_add') as MemoToolDefinition;
      const cancel = registered.get('watcher_memo_cancel') as MemoToolDefinition;

      const created = (await add.execute(
        { kind: 'long_watch', roomKey: 'room-alpha', basis: 'Track official release' },
        makeExec('sess-alpha'),
      )) as { ok: true; memo: MemoRecord };

      const blocked = (await cancel.execute(
        { memoId: created.memo.id },
        makeExec('sess-beta'),
      )) as { ok: boolean; memo: MemoRecord | null };
      assert.equal(blocked.ok, false);
      assert.equal(engine.store.getMemo(created.memo.id)?.status, 'active');

      const failClosed = engine.store.cancelMemo(created.memo.id, 'no-scope', {
        allowCrossRoom: false,
      });
      assert.equal(failClosed, null);
      assert.equal(engine.store.getMemo(created.memo.id)?.status, 'active');

      const allowed = (await cancel.execute(
        { memoId: created.memo.id, reason: 'owner session' },
        makeExec('sess-alpha'),
      )) as { ok: boolean; memo: MemoRecord | null };
      assert.equal(allowed.ok, true);
      assert.equal(allowed.memo?.status, 'torn');
    } finally {
      harness.close();
    }
  });
});

describe('Redline #2: P1 explicit allRooms and strict denial for non-admin, owner-in-group, and delegated subagents', () => {
  it('never silently lists all rooms and denies allRooms or target override outside verified admin DM', async () => {
    const harness = createHarness();
    try {
      const engine = new MemoEngine({
        hub: harness.hub,
        now: () => new Date('2026-11-26T08:00:00.000Z'),
      });
      const principals: Record<string, MemoCallerPrincipal> = {
        'sess-admin-dm': {
          sessionId: 'sess-admin-dm',
          boundChatId: 'wxid_owner',
          roomKey: 'wechat:wxid_owner',
          isAdminDm: true,
          adminId: 'wxid_owner',
          delegationDepth: 0,
          allowCrossRoom: true,
        },
        'sess-owner-in-group': {
          sessionId: 'sess-owner-in-group',
          boundChatId: 'w-group@chatroom',
          roomKey: 'wechat:w-group@chatroom',
          isAdminDm: false,
          adminId: 'wxid_owner',
          delegationDepth: 0,
          allowCrossRoom: false,
        },
        'sess-non-admin-dm': {
          sessionId: 'sess-non-admin-dm',
          boundChatId: 'wxid_stranger',
          roomKey: 'wechat:wxid_stranger',
          isAdminDm: false,
          delegationDepth: 0,
          allowCrossRoom: false,
        },
        'sess-delegated-admin': {
          sessionId: 'sess-delegated-admin',
          boundChatId: 'wxid_owner',
          roomKey: 'wechat:wxid_owner',
          isAdminDm: true,
          adminId: 'wxid_owner',
          delegationDepth: 1,
          allowCrossRoom: true,
        },
      };
      const tools = mountTools(engine, principals);

      engine.createMemo({
        kind: 'long_watch',
        roomKey: 'wechat:wxid_owner',
        targetChatId: 'wxid_owner',
        targetSessionId: 'sess-admin-dm',
        title: 'Admin DM Memo',
        basis: 'Owner private reminder',
      });
      engine.createMemo({
        kind: 'long_watch',
        roomKey: 'wechat:w-group@chatroom',
        targetChatId: 'w-group@chatroom',
        targetSessionId: 'sess-owner-in-group',
        title: 'W Group Memo',
        basis: 'Family group reminder',
      });
      engine.createMemo({
        kind: 'long_watch',
        roomKey: 'wechat:family@chatroom',
        targetChatId: 'family@chatroom',
        title: 'Family Memo',
        basis: 'Another group reminder',
      });

      const adminDefaultList = (await tools.list.execute({}, makeExec('sess-admin-dm'))) as {
        ok: true;
        memos: MemoRecord[];
        count: number;
        scope: string;
        roomKey: string | null;
      };
      assert.equal(adminDefaultList.scope, 'room');
      assert.equal(adminDefaultList.roomKey, 'wechat:wxid_owner');
      assert.equal(adminDefaultList.count, 1);
      assert.equal(adminDefaultList.memos[0].roomKey, 'wechat:wxid_owner');

      const adminAllList = (await tools.list.execute(
        { allRooms: true },
        makeExec('sess-admin-dm'),
      )) as {
        ok: true;
        memos: MemoRecord[];
        count: number;
        scope: string;
        roomKey: string | null;
      };
      assert.equal(adminAllList.scope, 'all_rooms');
      assert.equal(adminAllList.roomKey, null);
      assert.equal(adminAllList.count, 3);

      await assert.rejects(
        () => tools.list.execute({ allRooms: true }, makeExec('sess-owner-in-group')),
        MemoAuthorizationError,
      );
      await assert.rejects(
        () =>
          tools.list.execute(
            { roomKey: 'wechat:family@chatroom' },
            makeExec('sess-owner-in-group'),
          ),
        MemoAuthorizationError,
      );
      await assert.rejects(
        () => tools.list.execute({ allRooms: true }, makeExec('sess-non-admin-dm')),
        MemoAuthorizationError,
      );
      await assert.rejects(
        () => tools.list.execute({ allRooms: true }, makeExec('sess-delegated-admin')),
        MemoAuthorizationError,
      );
      await assert.rejects(
        () =>
          tools.list.execute(
            { allRooms: true },
            makeExec('sess-admin-dm', { delegationDepth: 1 }),
          ),
        /Subagents/i,
      );
      await assert.rejects(
        () =>
          tools.list.execute(
            { allRooms: true },
            makeExec('sess-admin-dm', { origin: 'subagent' }),
          ),
        /Subagents/i,
      );

      await assert.rejects(
        () =>
          tools.add.execute(
            {
              kind: 'long_watch',
              roomKey: 'wechat:family@chatroom',
              basis: 'Attempt cross-room add from group',
            },
            makeExec('sess-owner-in-group'),
          ),
        MemoAuthorizationError,
      );
      await assert.rejects(
        () =>
          tools.add.execute(
            {
              kind: 'long_watch',
              notifyWechatChatId: 'family@chatroom',
              basis: 'Attempt notify override from group',
            },
            makeExec('sess-owner-in-group'),
          ),
        MemoAuthorizationError,
      );
      await assert.rejects(
        () =>
          tools.add.execute(
            {
              kind: 'long_watch',
              targetName: '相亲相爱群',
              basis: 'Attempt targetName lookup from non-admin DM',
            },
            makeExec('sess-non-admin-dm'),
          ),
        MemoAuthorizationError,
      );
      await assert.rejects(
        () =>
          tools.add.execute(
            {
              kind: 'long_watch',
              roomKey: 'wechat:family@chatroom',
              notifyWechatChatId: 'family@chatroom',
              basis: 'Delegated subagent cross-room attempt',
            },
            makeExec('sess-admin-dm', { delegationDepth: 1 }),
          ),
        /Subagents/i,
      );

      assert.equal(engine.store.listMemos({ roomKey: 'wechat:family@chatroom' }).length, 1);
    } finally {
      harness.close();
    }
  });
});

describe('Redline #3: P1 admin cross-room add binding, idempotency, rejection on ambiguity/mismatch, and lossless migration', () => {
  it('binds cross-room add strictly to resolved target, deduplicates retries, and fires only to target room', async () => {
    const harness = createHarness();
    try {
      let currentTime = new Date('2026-11-26T08:00:00.000Z');
      const engine = new MemoEngine({
        hub: harness.hub,
        now: () => currentTime,
        rng: () => 0.3,
      });

      const principals: Record<string, MemoCallerPrincipal> = {
        'sess-admin-dm': {
          sessionId: 'sess-admin-dm',
          boundChatId: 'wxid_owner',
          roomKey: 'wechat:wxid_owner',
          isAdminDm: true,
          adminId: 'wxid_owner',
          delegationDepth: 0,
          allowCrossRoom: true,
        },
      };
      const directory = createDirectoryResolver([
        {
          chatId: 'w-group@chatroom',
          roomKey: 'wechat:w-group@chatroom',
          notifyWechatChatId: 'w-group@chatroom',
          targetSessionId: 'sess-w-group',
          title: 'W 集团',
        },
        {
          chatId: 'proj-1@chatroom',
          roomKey: 'wechat:proj-1@chatroom',
          notifyWechatChatId: 'proj-1@chatroom',
          targetSessionId: 'sess-proj-1',
          title: '项目群',
        },
        {
          chatId: 'proj-2@chatroom',
          roomKey: 'wechat:proj-2@chatroom',
          notifyWechatChatId: 'proj-2@chatroom',
          targetSessionId: 'sess-proj-2',
          title: '项目群',
        },
      ]);
      const tools = mountTools(engine, principals, directory);

      const first = (await tools.add.execute(
        {
          kind: 'time_nudge',
          targetName: 'W 集团',
          idempotencyKey: 'admin-w-group-2026-11-27-0900',
          title: '明早9点出门提醒',
          basis: '提醒 W 集团明早9点准时出门',
          windowStart: '2026-11-26T09:00:00.000Z',
          windowEnd: '2026-11-26T09:05:00.000Z',
        },
        makeExec('sess-admin-dm'),
      )) as { ok: true; memo: MemoRecord; activeInRoom: number; deduplicated: boolean };

      assert.equal(first.deduplicated, false);
      assert.equal(first.activeInRoom, 1);
      assert.equal(first.memo.roomKey, 'wechat:w-group@chatroom');
      assert.equal(first.memo.targetChatId, 'w-group@chatroom');
      assert.equal(first.memo.notifyWechatChatId, 'w-group@chatroom');
      assert.equal(first.memo.targetSessionId, 'sess-w-group');

      const retry = (await tools.add.execute(
        {
          kind: 'time_nudge',
          targetName: 'W 集团',
          idempotencyKey: 'admin-w-group-2026-11-27-0900',
          title: '明早9点出门提醒',
          basis: '提醒 W 集团明早9点准时出门',
          windowStart: '2026-11-26T09:00:00.000Z',
          windowEnd: '2026-11-26T09:05:00.000Z',
        },
        makeExec('sess-admin-dm'),
      )) as { ok: true; memo: MemoRecord; activeInRoom: number; deduplicated: boolean };

      assert.equal(retry.deduplicated, true);
      assert.equal(retry.memo.id, first.memo.id);
      assert.equal(retry.activeInRoom, 1);
      assert.equal(engine.store.listMemos({ roomKey: 'wechat:w-group@chatroom' }).length, 1);
      assert.equal(engine.store.listMemos({ roomKey: 'wechat:wxid_owner' }).length, 0);

      await assert.rejects(
        () =>
          tools.add.execute(
            {
              kind: 'long_watch',
              roomKey: 'wechat:proj-1@chatroom',
              idempotencyKey: 'admin-w-group-2026-11-27-0900',
              basis: 'Reusing idempotencyKey for another room',
            },
            makeExec('sess-admin-dm'),
          ),
        MemoIdempotencyConflictError,
      );

      await assert.rejects(
        () =>
          tools.add.execute(
            {
              kind: 'time_nudge',
              targetName: '项目群',
              basis: 'Ambiguous target must reject',
              windowStart: '2026-11-26T09:00:00.000Z',
              windowEnd: '2026-11-26T09:30:00.000Z',
            },
            makeExec('sess-admin-dm'),
          ),
        (err: unknown) =>
          err instanceof MemoTargetError &&
          err.code === 'MEMO_TARGET_AMBIGUOUS' &&
          err.candidates?.length === 2,
      );

      await assert.rejects(
        () =>
          tools.add.execute(
            {
              kind: 'time_nudge',
              targetName: '不存在的群',
              basis: 'Missing target must reject',
              windowStart: '2026-11-26T09:00:00.000Z',
              windowEnd: '2026-11-26T09:30:00.000Z',
            },
            makeExec('sess-admin-dm'),
          ),
        (err: unknown) => err instanceof MemoTargetError && err.code === 'MEMO_TARGET_NOT_FOUND',
      );

      await assert.rejects(
        () =>
          tools.add.execute(
            {
              kind: 'time_nudge',
              roomKey: 'wechat:w-group@chatroom',
              notifyWechatChatId: 'wxid_owner',
              basis: 'Mismatched notify target must reject',
              windowStart: '2026-11-26T09:00:00.000Z',
              windowEnd: '2026-11-26T09:30:00.000Z',
            },
            makeExec('sess-admin-dm'),
          ),
        (err: unknown) => err instanceof MemoTargetError && err.code === 'MEMO_TARGET_MISMATCH',
      );

      assert.equal(engine.store.listMemos({ roomKey: 'wechat:wxid_owner' }).length, 0);

      currentTime = new Date('2026-11-26T09:01:00.000Z');
      const tickRes = await engine.tick();
      assert.equal(tickRes.results.length, 1);
      assert.equal(tickRes.results[0].action, 'fired');
      assert.equal(harness.nudges.length, 1);
      assert.equal(harness.nudges[0].chatId, 'w-group@chatroom');
      assert.equal(harness.nudges[0].targetSessionId, 'sess-w-group');
      assert.equal(harness.wechatSent.length, 0);
    } finally {
      harness.close();
    }
  });

  it('rejects missing notifyWechatChatId or admin session reuse on cross-room add without target directory', async () => {
    const harness = createHarness();
    try {
      const engine = new MemoEngine({
        hub: harness.hub,
        now: () => new Date('2026-11-26T08:00:00.000Z'),
      });
      const principals: Record<string, MemoCallerPrincipal> = {
        'sess-admin-dm': {
          sessionId: 'sess-admin-dm',
          boundChatId: 'wxid_owner',
          roomKey: 'wechat:wxid_owner',
          isAdminDm: true,
          adminId: 'wxid_owner',
          delegationDepth: 0,
          allowCrossRoom: true,
        },
      };
      const tools = mountTools(engine, principals);

      await assert.rejects(
        () =>
          tools.add.execute(
            {
              kind: 'time_nudge',
              roomKey: 'wechat:w-group@chatroom',
              basis: 'Missing notifyWechatChatId must not fall back to admin DM',
              windowStart: '2026-11-26T09:00:00.000Z',
              windowEnd: '2026-11-26T09:30:00.000Z',
            },
            makeExec('sess-admin-dm'),
          ),
        (err: unknown) => err instanceof MemoTargetError && err.code === 'MEMO_TARGET_INVALID',
      );

      await assert.rejects(
        () =>
          tools.add.execute(
            {
              kind: 'time_nudge',
              roomKey: 'wechat:w-group@chatroom',
              notifyWechatChatId: 'w-group@chatroom',
              targetSessionId: 'sess-admin-dm',
              basis: 'Admin session must not bind to foreign room',
              windowStart: '2026-11-26T09:00:00.000Z',
              windowEnd: '2026-11-26T09:30:00.000Z',
            },
            makeExec('sess-admin-dm'),
          ),
        (err: unknown) => err instanceof MemoTargetError && err.code === 'MEMO_TARGET_MISMATCH',
      );

      const explicitOk = (await tools.add.execute(
        {
          kind: 'time_nudge',
          roomKey: 'wechat:w-group@chatroom',
          notifyWechatChatId: 'w-group@chatroom',
          basis: 'Explicit verified binding without existing target session',
          windowStart: '2026-11-26T09:00:00.000Z',
          windowEnd: '2026-11-26T09:30:00.000Z',
        },
        makeExec('sess-admin-dm'),
      )) as { ok: true; memo: MemoRecord };
      assert.equal(explicitOk.memo.roomKey, 'wechat:w-group@chatroom');
      assert.equal(explicitOk.memo.targetChatId, 'w-group@chatroom');
      assert.equal(explicitOk.memo.notifyWechatChatId, 'w-group@chatroom');
      assert.equal(explicitOk.memo.targetSessionId, null);
      assert.equal(engine.store.listMemos({ roomKey: 'wechat:wxid_owner' }).length, 0);
    } finally {
      harness.close();
    }
  });

  it('uses STRICT memo_idempotency table and performs idempotent lossless backfill migration', () => {
    const db = openHubDb({ inMemory: true });
    try {
      const nowIso = '2026-11-26T08:00:00.000Z';
      db.db
        .prepare(
          `INSERT INTO memos (
             id, kind, room_key, target_session_id, target_chat_id, source, title, basis,
             status, notify_wechat_chat_id, metadata_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'memo_legacy_1',
          'long_watch',
          'wechat:w-group@chatroom',
          'sess-w-group',
          'w-group@chatroom',
          'tool',
          'Legacy Memo',
          'Legacy basis before migration',
          'active',
          'w-group@chatroom',
          JSON.stringify({ idempotencyKey: 'legacy-idem-key-1' }),
          nowIso,
          nowIso,
        );

      const store1 = new MemoStore(db);
      const store2 = new MemoStore(db);

      const tableDef = db.db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memo_idempotency'")
        .get() as { sql: string } | undefined;
      assert.ok(tableDef?.sql);
      assert.match(tableDef.sql, /STRICT/i);

      const deduped = store2.createMemoWithIdempotency({
        kind: 'long_watch',
        roomKey: 'wechat:w-group@chatroom',
        idempotencyKey: 'legacy-idem-key-1',
        basis: 'Retried after migration',
      });
      assert.equal(deduped.deduplicated, true);
      assert.equal(deduped.memo.id, 'memo_legacy_1');
      assert.equal(store1.listMemos({ roomKey: 'wechat:w-group@chatroom' }).length, 1);
    } finally {
      db.close();
    }
  });
});
