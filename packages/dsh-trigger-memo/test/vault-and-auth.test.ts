import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createDoorGuard,
  createHubService,
  openHubDb,
  VaultError,
  type HubRuntime,
} from '@local/dsh-hub';
import type {
  HubService,
  MemoRecord,
  PersonaWardrobe,
  TargetDirectoryEntry,
  TargetDirectoryProvider,
  VaultVisibility,
  WechatTransport,
} from '@local/dsh-hub/contracts';
import {
  apply,
  MemoAuthorizationError,
  MemoEngine,
  MemoTargetError,
  registerMemoTools,
  resolveMemoVaultVisibility,
  type MemoToolDefinition,
  type ToolExecutionContext,
} from '../src/index.js';

function makeExec(
  sessionId: string,
  opts: {
    delegationDepth?: number;
    origin?: string;
    parentSessionId?: string;
    rootSessionId?: string;
  } = {},
): ToolExecutionContext {
  return {
    agent: {
      id: sessionId,
      session: {
        header: {
          delegationDepth: opts.delegationDepth ?? 0,
          origin: opts.origin,
          parentSessionId: opts.parentSessionId,
          rootSessionId: opts.rootSessionId,
        },
      },
    },
  };
}

function createMockWechatTransport(controllerId?: string): WechatTransport {
  return {
    async send() {
      return { status: 'sent', deliveryId: 'wx-1' };
    },
    async recentMessages() {
      return [];
    },
    async getAtmosphere(params) {
      return {
        chatId: params.chatId,
        healthy: true,
        paused: false,
        messageCount: 0,
        lastMessageAt: null,
        secondsSinceLastMessage: 3600,
        ownSpokeSince: false,
        quiet: true,
        recentMessages: [],
      };
    },
    async status() {
      return {
        ok: true,
        mode: 'cordis',
        healthy: true,
        controllerId,
      };
    },
  };
}

function createHubTargetProvider(entries: TargetDirectoryEntry[]): TargetDirectoryProvider {
  return {
    id: 'wxarc-test-dir',
    source: 'wechat',
    resolveTarget(query) {
      const matches = entries.filter((entry) => {
        if (query.roomKey && entry.roomKey !== query.roomKey) return false;
        if (query.targetChatId && entry.chatId !== query.targetChatId) return false;
        if (
          query.notifyWechatChatId &&
          entry.notifyWechatChatId !== query.notifyWechatChatId
        ) {
          return false;
        }
        if (
          query.targetSessionId &&
          entry.targetSessionId &&
          entry.targetSessionId !== query.targetSessionId
        ) {
          return false;
        }
        if (query.targetName && entry.title !== query.targetName) return false;
        return true;
      });
      if (matches.length === 0) return { status: 'not_found', detail: 'no match' };
      if (matches.length > 1) {
        return { status: 'ambiguous', candidates: matches, detail: 'multiple targets' };
      }
      return { status: 'matched', target: matches[0] };
    },
    listTargets() {
      return [...entries];
    },
  };
}

function createRealHubFixture(opts: {
  controllerId?: string;
  wardrobe?: PersonaWardrobe | null;
} = {}): {
  hub: HubRuntime;
  tools: {
    add: MemoToolDefinition;
    list: MemoToolDefinition;
    cancel: MemoToolDefinition;
  };
  engine: MemoEngine;
  dispose: () => void;
  close: () => void;
} {
  const db = openHubDb({ inMemory: true });
  const guard = createDoorGuard();
  const hub = createHubService(undefined, {
    db,
    guard,
    wardrobe: opts.wardrobe ?? null,
  });
  hub.registerWechatTransport(createMockWechatTransport(opts.controllerId));

  const registered = new Map<string, MemoToolDefinition>();
  const disposeListeners: Array<() => void> = [];
  const applied = apply(
    {
      hub,
      tools: {
        register(def) {
          registered.set(def.name, def);
          return () => registered.delete(def.name);
        },
      },
      on(event, listener) {
        if (event === 'dispose') disposeListeners.push(listener);
      },
    },
    { tickIntervalMs: 60_000 },
  );

  return {
    hub,
    engine: applied.engine,
    tools: {
      add: registered.get('watcher_memo_add') as MemoToolDefinition,
      list: registered.get('watcher_memo_list') as MemoToolDefinition,
      cancel: registered.get('watcher_memo_cancel') as MemoToolDefinition,
    },
    dispose: () => {
      for (const fn of disposeListeners) fn();
    },
    close: () => {
      for (const fn of disposeListeners) fn();
      db.close();
    },
  };
}

describe('Memo Tool Authorization Hardening & Hub Principal Integration', () => {
  it('blocks currentRoomKey === null unauthorized sessions from writing arbitrary cross-group memos', async () => {
    const fixture = createRealHubFixture({ controllerId: 'wxid_owner' });
    try {
      fixture.hub.registerSessionPrincipal({
        sessionId: 'sess-unknown-t0',
        role: 'unknown',
        tier: 0,
        trustLevel: 'untrusted',
      });
      fixture.hub.registerSessionPrincipal({
        sessionId: 'sess-unbound-ext',
        role: 'external_chat',
        tier: 1,
        trustLevel: 'untrusted',
        boundRoomKey: null,
      });
      fixture.hub.registerSessionPrincipal({
        sessionId: 'sess-unbound-worker',
        role: 'worker',
        tier: 2,
        trustLevel: 'owner',
        boundThreadKey: null,
      });
      fixture.hub.registerSessionPrincipal({
        sessionId: 'sess-downgraded-owner',
        role: 'owner_session',
        tier: 0,
        trustLevel: 'owner',
        boundRoomKey: null,
      });

      for (const sid of [
        'sess-unknown-t0',
        'sess-unbound-ext',
        'sess-unbound-worker',
        'sess-downgraded-owner',
      ]) {
        await assert.rejects(
          () =>
            fixture.tools.add.execute(
              {
                kind: 'time_nudge',
                roomKey: 'wechat:victim-group@chatroom',
                targetChatId: 'victim-group@chatroom',
                notifyWechatChatId: 'victim-group@chatroom',
                basis: 'Attempt backdoor write with currentRoomKey === null',
                windowStart: '2026-11-27T09:00:00.000Z',
                windowEnd: '2026-11-27T10:00:00.000Z',
              },
              makeExec(sid),
            ),
          MemoAuthorizationError,
        );

        await assert.rejects(
          () => fixture.tools.list.execute({}, makeExec(sid)),
          MemoAuthorizationError,
        );
      }

      const bareDb = openHubDb({ inMemory: true });
      try {
        const bareHub = {
          db: bareDb,
          getWechatTransport: () => null,
        } as unknown as HubService;
        const bareEngine = new MemoEngine({ hub: bareHub });
        const bareTools = new Map<string, MemoToolDefinition>();
        registerMemoTools(
          {
            tools: {
              register(def) {
                bareTools.set(def.name, def);
                return () => bareTools.delete(def.name);
              },
            },
          },
          bareEngine,
        );
        const bareAdd = bareTools.get('watcher_memo_add') as MemoToolDefinition;
        const bareCancel = bareTools.get('watcher_memo_cancel') as MemoToolDefinition;

        await assert.rejects(
          () =>
            bareAdd.execute(
              {
                kind: 'time_nudge',
                targetChatId: 'victim-group@chatroom',
                notifyWechatChatId: 'victim-group@chatroom',
                basis: 'Legacy mock hub without principal must fail closed',
                windowStart: '2026-11-27T09:00:00.000Z',
                windowEnd: '2026-11-27T10:00:00.000Z',
              },
              makeExec('sess-anonymous'),
            ),
          MemoAuthorizationError,
        );

        const cancelRes = (await bareCancel.execute(
          { memoId: 'memo_any' },
          makeExec('sess-anonymous'),
        )) as { ok: boolean; memo: MemoRecord | null };
        assert.equal(cancelRes.ok, false);
        assert.equal(cancelRes.memo, null);
      } finally {
        bareDb.close();
      }
    } finally {
      fixture.close();
    }
  });

  it('allows tier-3 owner_session and interactive cross-room add/list via Hub TargetDirectory and rejects ambiguous/missing', async () => {
    const fixture = createRealHubFixture({ controllerId: 'wxid_owner' });
    try {
      fixture.hub.registerSessionPrincipal({
        sessionId: 'sess-owner-dm',
        role: 'owner_session',
        tier: 3,
        trustLevel: 'owner',
        boundRoomKey: 'wechat:wxid_owner',
      });

      fixture.hub.registerTargetDirectory(
        createHubTargetProvider([
          {
            source: 'wechat',
            targetId: 'family@chatroom',
            roomKey: 'wechat:family@chatroom',
            chatId: 'family@chatroom',
            notifyWechatChatId: 'family@chatroom',
            targetSessionId: 'sess-family',
            title: '相亲相爱一家人',
          },
          {
            source: 'wechat',
            targetId: 'work-a@chatroom',
            roomKey: 'wechat:work-a@chatroom',
            chatId: 'work-a@chatroom',
            notifyWechatChatId: 'work-a@chatroom',
            targetSessionId: 'sess-work-a',
            title: '项目群',
          },
          {
            source: 'wechat',
            targetId: 'work-b@chatroom',
            roomKey: 'wechat:work-b@chatroom',
            chatId: 'work-b@chatroom',
            notifyWechatChatId: 'work-b@chatroom',
            targetSessionId: 'sess-work-b',
            title: '项目群',
          },
        ]),
      );

      const added = (await fixture.tools.add.execute(
        {
          kind: 'time_nudge',
          targetName: '相亲相爱一家人',
          title: '家庭提醒',
          basis: '提醒周末一起吃晚饭',
          windowStart: '2026-11-27T09:00:00.000Z',
          windowEnd: '2026-11-27T10:00:00.000Z',
        },
        makeExec('sess-owner-dm'),
      )) as { ok: true; memo: MemoRecord };
      assert.equal(added.memo.roomKey, 'wechat:family@chatroom');
      assert.equal(added.memo.targetChatId, 'family@chatroom');
      assert.equal(added.memo.notifyWechatChatId, 'family@chatroom');
      assert.equal(added.memo.targetSessionId, 'sess-family');

      const interactiveList = (await fixture.tools.list.execute(
        { targetName: '相亲相爱一家人' },
        makeExec('sess-interactive-cli'),
      )) as { ok: true; memos: MemoRecord[]; roomKey: string };
      assert.equal(interactiveList.roomKey, 'wechat:family@chatroom');
      assert.equal(interactiveList.memos.length, 1);

      const interactiveAll = (await fixture.tools.list.execute(
        { allRooms: true },
        makeExec('sess-interactive-cli'),
      )) as { ok: true; count: number; scope: string };
      assert.equal(interactiveAll.scope, 'all_rooms');
      assert.equal(interactiveAll.count, 1);

      await assert.rejects(
        () =>
          fixture.tools.add.execute(
            {
              kind: 'time_nudge',
              targetName: '项目群',
              basis: 'Ambiguous must fail',
              windowStart: '2026-11-27T09:00:00.000Z',
              windowEnd: '2026-11-27T10:00:00.000Z',
            },
            makeExec('sess-interactive-cli'),
          ),
        (err: unknown) =>
          err instanceof MemoTargetError &&
          err.code === 'MEMO_TARGET_AMBIGUOUS' &&
          err.candidates?.length === 2,
      );

      await assert.rejects(
        () =>
          fixture.tools.add.execute(
            {
              kind: 'time_nudge',
              roomKey: 'wechat:nonexistent@chatroom',
              notifyWechatChatId: 'nonexistent@chatroom',
              basis: 'Unlisted group must fail when directory exists',
              windowStart: '2026-11-27T09:00:00.000Z',
              windowEnd: '2026-11-27T10:00:00.000Z',
            },
            makeExec('sess-owner-dm'),
          ),
        (err: unknown) => err instanceof MemoTargetError && err.code === 'MEMO_TARGET_NOT_FOUND',
      );

      await assert.rejects(
        () =>
          fixture.tools.add.execute(
            {
              kind: 'long_watch',
              roomKey: 'wechat:family@chatroom',
              basis: 'Subagent of owner must still be blocked',
            },
            makeExec('sess-owner-sub', {
              delegationDepth: 1,
              parentSessionId: 'sess-owner-dm',
            }),
          ),
        MemoAuthorizationError,
      );
    } finally {
      fixture.close();
    }
  });

  it('allows controlled non-untrusted #223 worker long_watch in own room with owner controllerId only, blocks cross-room and untrusted workers', async () => {
    const fixture = createRealHubFixture({ controllerId: 'wxid_owner_ctrl' });
    try {
      fixture.hub.registerSessionPrincipal({
        sessionId: 'sess-worker-223',
        role: 'worker',
        tier: 2,
        trustLevel: 'owner',
        boundSource: 'github',
        boundThreadKey: 'github:example-owner/dsh-watcher#223',
      });
      fixture.hub.registerSessionPrincipal({
        sessionId: 'sess-worker-untrusted',
        role: 'worker',
        tier: 1,
        trustLevel: 'untrusted',
        boundSource: 'github',
        boundThreadKey: 'github:example-owner/dsh-watcher#456',
      });

      const ownNoNotify = (await fixture.tools.add.execute(
        {
          kind: 'long_watch',
          roomKey: 'github:example-owner/dsh-watcher#223',
          title: 'Issue #223 ACP watch',
          basis: 'Watch official Gemini ACP release',
          officialDomains: ['ai.google.dev'],
        },
        makeExec('sess-worker-223'),
      )) as { ok: true; memo: MemoRecord };
      assert.equal(ownNoNotify.memo.roomKey, 'github:example-owner/dsh-watcher#223');
      assert.equal(ownNoNotify.memo.notifyWechatChatId, null);
      assert.equal(ownNoNotify.memo.targetChatId, null);

      const ownWithController = (await fixture.tools.add.execute(
        {
          kind: 'long_watch',
          title: 'Issue #223 ACP watch with owner ping',
          basis: 'Ping owner when official ACP ships',
          notifyWechatChatId: 'wxid_owner_ctrl',
        },
        makeExec('sess-worker-223'),
      )) as { ok: true; memo: MemoRecord };
      assert.equal(ownWithController.memo.roomKey, 'github:example-owner/dsh-watcher#223');
      assert.equal(ownWithController.memo.notifyWechatChatId, 'wxid_owner_ctrl');

      await assert.rejects(
        () =>
          fixture.tools.add.execute(
            {
              kind: 'long_watch',
              roomKey: 'github:example-owner/dsh-watcher#223',
              notifyWechatChatId: 'family@chatroom',
              basis: 'Worker cannot notify arbitrary group',
            },
            makeExec('sess-worker-223'),
          ),
        MemoAuthorizationError,
      );

      await assert.rejects(
        () =>
          fixture.tools.add.execute(
            {
              kind: 'long_watch',
              roomKey: 'github:example-owner/dsh-watcher#223',
              notifyWechatChatId: 'wxid_stranger',
              basis: 'Worker cannot notify non-controller chat',
            },
            makeExec('sess-worker-223'),
          ),
        MemoAuthorizationError,
      );

      await assert.rejects(
        () =>
          fixture.tools.add.execute(
            {
              kind: 'long_watch',
              roomKey: 'github:example-owner/dsh-watcher#999',
              basis: 'Worker cannot cross-room add',
            },
            makeExec('sess-worker-223'),
          ),
        MemoAuthorizationError,
      );

      await assert.rejects(
        () =>
          fixture.tools.list.execute(
            { allRooms: true },
            makeExec('sess-worker-223'),
          ),
        MemoAuthorizationError,
      );

      await assert.rejects(
        () =>
          fixture.tools.list.execute(
            { roomKey: 'wechat:family@chatroom' },
            makeExec('sess-worker-223'),
          ),
        MemoAuthorizationError,
      );

      const workerOwnList = (await fixture.tools.list.execute(
        {},
        makeExec('sess-worker-223'),
      )) as { ok: true; count: number; roomKey: string };
      assert.equal(workerOwnList.roomKey, 'github:example-owner/dsh-watcher#223');
      assert.equal(workerOwnList.count, 2);

      await assert.rejects(
        () =>
          fixture.tools.add.execute(
            {
              kind: 'long_watch',
              roomKey: 'github:example-owner/dsh-watcher#456',
              basis: 'Untrusted worker must not write memos',
            },
            makeExec('sess-worker-untrusted'),
          ),
        MemoAuthorizationError,
      );

      const untrustedCancel = (await fixture.tools.cancel.execute(
        { memoId: ownNoNotify.memo.id },
        makeExec('sess-worker-untrusted'),
      )) as { ok: boolean; memo: MemoRecord | null };
      assert.equal(untrustedCancel.ok, false);
      assert.equal(fixture.engine.store.getMemo(ownNoNotify.memo.id)?.status, 'active');
    } finally {
      fixture.close();
    }
  });

  it('strictly locks external_chat to boundRoomKey and forces roomKey and targetChatId', async () => {
    const fixture = createRealHubFixture({ controllerId: 'wxid_owner' });
    try {
      fixture.hub.registerSessionPrincipal({
        sessionId: 'sess-ext-group',
        role: 'external_chat',
        tier: 1,
        trustLevel: 'untrusted',
        boundRoomKey: 'wechat:group-1@chatroom',
      });

      const created = (await fixture.tools.add.execute(
        {
          kind: 'time_nudge',
          title: '群内提醒',
          basis: '下午提醒大家提交周报',
          windowStart: '2026-11-27T09:00:00.000Z',
          windowEnd: '2026-11-27T10:00:00.000Z',
        },
        makeExec('sess-ext-group'),
      )) as { ok: true; memo: MemoRecord };
      assert.equal(created.memo.roomKey, 'wechat:group-1@chatroom');
      assert.equal(created.memo.targetChatId, 'group-1@chatroom');
      assert.equal(created.memo.notifyWechatChatId, 'group-1@chatroom');

      await assert.rejects(
        () =>
          fixture.tools.add.execute(
            {
              kind: 'time_nudge',
              roomKey: 'wechat:group-2@chatroom',
              basis: 'Cross-room attempt from external_chat',
              windowStart: '2026-11-27T09:00:00.000Z',
              windowEnd: '2026-11-27T10:00:00.000Z',
            },
            makeExec('sess-ext-group'),
          ),
        MemoAuthorizationError,
      );

      await assert.rejects(
        () =>
          fixture.tools.add.execute(
            {
              kind: 'time_nudge',
              targetChatId: 'group-2@chatroom',
              basis: 'targetChatId override attempt',
              windowStart: '2026-11-27T09:00:00.000Z',
              windowEnd: '2026-11-27T10:00:00.000Z',
            },
            makeExec('sess-ext-group'),
          ),
        MemoAuthorizationError,
      );

      const listed = (await fixture.tools.list.execute(
        {},
        makeExec('sess-ext-group'),
      )) as { ok: true; roomKey: string; count: number };
      assert.equal(listed.roomKey, 'wechat:group-1@chatroom');
      assert.equal(listed.count, 1);
    } finally {
      fixture.close();
    }
  });
});

describe('VaultProvider("memo") read-only search, context & visibility circle filtering', () => {
  it('registers memo provider via apply(), enforces circle visibility, snippet<=220, filters, and context window', async () => {
    const circleMap: Record<string, VaultVisibility> = {
      'wechat:ext-group@chatroom': 'external',
      'wechat:work-group@chatroom': 'work',
      'wechat:family@chatroom': 'family',
      'github:example-owner/dsh-watcher#223': 'work',
    };
    const mockWardrobe = {
      resolveVaultVisibility(roomKey: string): VaultVisibility {
        return circleMap[roomKey] ?? 'owner_private';
      },
    } as unknown as PersonaWardrobe;

    const fixture = createRealHubFixture({ wardrobe: mockWardrobe });
    try {
      const providers = fixture.hub.vault.listProviders();
      assert.deepEqual(providers, [
        { id: 'memo', label: '便签提醒', supportsContext: true },
      ]);

      fixture.hub.registerSessionPrincipal({
        sessionId: 'sess-t0',
        role: 'unknown',
        tier: 0,
        trustLevel: 'untrusted',
      });
      fixture.hub.registerSessionPrincipal({
        sessionId: 'sess-t1',
        role: 'external_chat',
        tier: 1,
        trustLevel: 'untrusted',
        boundRoomKey: 'wechat:ext-group@chatroom',
      });
      fixture.hub.registerSessionPrincipal({
        sessionId: 'sess-t2',
        role: 'worker',
        tier: 2,
        trustLevel: 'owner',
        boundThreadKey: 'github:example-owner/dsh-watcher#223',
      });
      fixture.hub.registerSessionPrincipal({
        sessionId: 'sess-t3',
        role: 'owner_session',
        tier: 3,
        trustLevel: 'owner',
        boundRoomKey: 'wechat:wxid_owner',
      });

      const longBasis = `超长便签内容测试：${'提醒会议议程与重点交付事项需要提前确认并同步到群内成员'.repeat(12)}`;

      const extMemo = fixture.engine.store.createMemo(
        {
          kind: 'time_nudge',
          roomKey: 'wechat:ext-group@chatroom',
          title: '公开交流会提醒',
          basis: `小王提到的开源交流会安排 ${longBasis}`,
          keywords: ['交流会', '开源'],
          windowStart: '2026-11-27T09:00:00.000Z',
          windowEnd: '2026-11-27T10:00:00.000Z',
        },
        { now: new Date('2026-11-25T10:00:00.000Z') },
      );

      const workMemo1 = fixture.engine.store.createMemo(
        {
          kind: 'long_watch',
          roomKey: 'wechat:work-group@chatroom',
          title: '工作发布排查',
          basis: '小李说周五前要检查核心发布流水线和回滚预案',
          keywords: ['发布', '流水线'],
        },
        { now: new Date('2026-11-26T09:00:00.000Z') },
      );

      const workMemo2 = fixture.engine.store.createMemo(
        {
          kind: 'news_followup',
          roomKey: 'wechat:work-group@chatroom',
          title: '工作发布复盘',
          basis: '小李补充发布完成后要跟进监控指标与客户反馈',
          keywords: ['发布', '复盘'],
        },
        { now: new Date('2026-11-26T15:00:00.000Z') },
      );

      const familyMemo = fixture.engine.store.createMemo(
        {
          kind: 'time_nudge',
          roomKey: 'wechat:family@chatroom',
          title: '家庭体检提醒',
          basis: '提醒爸妈下周体检记得空腹，顺便带社保卡',
          keywords: ['体检', '家庭'],
          windowStart: '2026-11-28T01:00:00.000Z',
          windowEnd: '2026-11-28T02:00:00.000Z',
        },
        { now: new Date('2026-11-26T18:00:00.000Z') },
      );

      const unlabeledMemo = fixture.engine.store.createMemo(
        {
          kind: 'long_watch',
          roomKey: 'wechat:unlabeled-secret@chatroom',
          title: '未打标私密提醒',
          basis: '提醒检查个人银行卡与私密合同归档',
          keywords: ['提醒', '归档'],
        },
        { now: new Date('2026-11-27T08:00:00.000Z') },
      );

      assert.equal(resolveMemoVaultVisibility(unlabeledMemo, mockWardrobe), 'owner_private');
      assert.equal(resolveMemoVaultVisibility(workMemo1, null), 'owner_private');
      assert.equal(resolveMemoVaultVisibility({ roomKey: 'session:sess-t3' }, mockWardrobe), 'owner_private');

      await assert.rejects(
        () => fixture.hub.vault.search({ query: '提醒', sources: ['memo'] }, makeExec('sess-t0')),
        (err: unknown) => err instanceof VaultError && err.code === 'VAULT_FORBIDDEN',
      );

      const t1Res = await fixture.hub.vault.search(
        { query: '提醒', sources: ['memo'] },
        makeExec('sess-t1'),
      );
      assert.equal(t1Res.total, 1);
      assert.equal(t1Res.hits[0].itemId, extMemo.id);
      assert.equal(t1Res.hits[0].circle, 'external');
      assert.ok(t1Res.hits[0].snippet.length <= 220);
      assert.equal(t1Res.tainted, false);

      const t1FamilyCtx = await fixture.hub.vault.context(
        'memo',
        familyMemo.id,
        { before: 2, after: 2 },
        makeExec('sess-t1'),
      );
      assert.equal(t1FamilyCtx.result, null);

      const t2Res = await fixture.hub.vault.search(
        { query: '发布', sources: ['memo'], person: '小李', limit: 5 },
        makeExec('sess-t2'),
      );
      assert.equal(t2Res.total, 2);
      assert.equal(
        t2Res.hits.every((h) => h.circle === 'work'),
        true,
      );
      assert.equal(t2Res.tainted, true);

      const t2SinceRes = await fixture.hub.vault.search(
        {
          query: '发布',
          sources: ['memo'],
          since: '2026-11-26T12:00:00.000Z',
          until: '2026-11-26T20:00:00.000Z',
        },
        makeExec('sess-t2'),
      );
      assert.equal(t2SinceRes.total, 1);
      assert.equal(t2SinceRes.hits[0].itemId, workMemo2.id);

      const t2Ctx = await fixture.hub.vault.context(
        'memo',
        workMemo2.id,
        { before: 3, after: 1 },
        makeExec('sess-t2'),
      );
      assert.ok(t2Ctx.result);
      assert.equal(t2Ctx.result.circle, 'work');
      assert.equal(t2Ctx.result.items.length, 2);
      assert.equal(t2Ctx.result.items[0].itemId, workMemo1.id);
      assert.equal(t2Ctx.result.items[1].itemId, workMemo2.id);
      assert.equal(t2Ctx.result.items[1].isTarget, true);

      const t2Unlabeled = await fixture.hub.vault.search(
        { query: '银行卡', sources: ['memo'] },
        makeExec('sess-t2'),
      );
      assert.equal(t2Unlabeled.total, 0);

      const t3Res = await fixture.hub.vault.search(
        { query: '提醒', sources: ['memo'], limit: 10 },
        makeExec('sess-t3'),
      );
      const t3Ids = new Set(t3Res.hits.map((h) => h.itemId));
      assert.equal(t3Ids.has(extMemo.id), true);
      assert.equal(t3Ids.has(familyMemo.id), true);
      assert.equal(t3Ids.has(unlabeledMemo.id), true);
      assert.equal(t3Res.tainted, true);

      const t3PrivateOnly = await fixture.hub.vault.search(
        { query: '归档', sources: ['memo'], circle: 'owner_private' },
        makeExec('sess-t3'),
      );
      assert.equal(t3PrivateOnly.total, 1);
      assert.equal(t3PrivateOnly.hits[0].itemId, unlabeledMemo.id);
      assert.equal(t3PrivateOnly.hits[0].circle, 'owner_private');

      fixture.dispose();
      assert.deepEqual(fixture.hub.vault.listProviders(), []);
    } finally {
      fixture.close();
    }
  });
});
