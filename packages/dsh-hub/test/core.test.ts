import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  ActionSink,
  NormalizedEvent,
  PersonaWardrobe,
  WechatSendInput,
  WechatTransport,
  WechatTransportStatus,
} from '../src/contracts.js';
import { openHubDb } from '../src/db.js';
import { createDoorGuard } from '../src/guard.js';
import { createSessionBridge, type DshAgent, type SessionBridgeContext } from '../src/session-bridge.js';
import { createHubService } from '../src/service.js';
import { apply } from '../src/index.js';

function makeEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  const id = overrides.id ?? 'evt-1';
  return {
    id,
    source: 'github',
    type: 'issue_comment',
    dedupeKey: overrides.dedupeKey ?? `dedupe:${id}`,
    threadKey: 'github:org/repo#1',
    entityKey: 'github:org/repo#1',
    actor: { id: 'u1', login: 'example-owner' },
    trustLevel: 'owner',
    occurredAt: new Date().toISOString(),
    summary: 'Please review PR #1',
    payload: { body: 'looks good?' },
    ...overrides,
  };
}

function makeMockSessionContext() {
  const sent: Array<{ sessionId: string; mode: string; message: unknown }> = [];
  const agents = new Map<string, DshAgent>();
  let seq = 0;

  const ctx: SessionBridgeContext = {
    workspaceRegistry: {
      resolveByPath: async (p) => ({ id: `ws:${p}` }),
      create: async (p) => ({ id: `ws:${p}` }),
    },
    sessionController: {
      create: async () => {
        const sessionId = `sess-${++seq}`;
        agents.set(sessionId, {
          session: { id: sessionId },
          state: { running: false },
          followup: (msg) => {
            sent.push({ sessionId, mode: 'followup', message: msg });
          },
          steer: (msg) => {
            sent.push({ sessionId, mode: 'steer', message: msg });
          },
          whenIdle: async () => {},
        });
        return { sessionId };
      },
      resolveAgent: async (sessionId) => {
        const agent = agents.get(sessionId);
        return agent ? { agent } : { error: { code: 'session/not-found' } };
      },
    },
  };

  return { ctx, sent, agents };
}

test('ingest deduplicates events, routes via rule+resolver, and delivers through SessionBridge', async () => {
  const db = openHubDb({ inMemory: true });
  try {
    const guard = createDoorGuard();
    const { ctx, sent } = makeMockSessionContext();
    const bridge = createSessionBridge(ctx, db, null);
    const service = createHubService(undefined, { db, guard, sessionBridge: bridge });

    const first = await service.ingest(makeEvent({ id: 'e1' }));
    assert.equal(first.accepted, true);
    assert.equal(first.routedVia, 'inbox');
    assert.ok(first.inboxId);

    const dup = await service.ingest(makeEvent({ id: 'e1-dup', dedupeKey: 'dedupe:e1' }));
    assert.equal(dup.accepted, false);
    assert.equal(dup.deduped, true);

    service.registerResolver({
      id: 'gh-res',
      sources: ['github'],
      resolve: async () => ({
        workspacePath: '/repo/demo',
        workstreamKey: 'github:org/repo#1',
        suggestedTitle: 'Fix #1',
      }),
    });
    service.registerRule({
      id: 'rule-triage',
      name: 'Triage GH',
      enabled: true,
      priority: 10,
      match: { source: 'github' },
      handler: { tier: 'triage', sessionPolicy: 'reuse-or-spawn', maxWakeups: 5 },
    });

    const routed = await service.ingest(makeEvent({ id: 'e2' }));
    await new Promise((r) => setImmediate(r));
    assert.equal(routed.accepted, true);
    assert.equal(routed.routedVia, 'rule');
    assert.equal(sent.length, 1);
    assert.equal(service.listWorkstreams().length, 1);
    assert.equal(service.listWorkstreams()[0]?.deliveryCount, 1);
    assert.equal(service.listInbox({ source: 'github' }).length, 2);
  } finally {
    db.close();
  }
});

test('DoorGuard allows by default and blocks ingest & invokeSink when custom guard denies', async () => {
  const db = openHubDb({ inMemory: true });
  try {
    const guard = createDoorGuard();
    const service = createHubService(undefined, { db, guard });

    assert.equal((await guard.beforeEnterRoom()).allow, true);
    assert.equal((await guard.beforeSendOut()).allow, true);

    const unsub = guard.registerGuard({
      name: 'blocker',
      beforeEnterRoom: () => ({ allow: false, reason: 'room_closed' }),
      beforeSendOut: () => ({ allow: false, reason: 'outbound_frozen' }),
    });

    const blockedIngest = await service.ingest(makeEvent({ id: 'e-blocked' }));
    assert.equal(blockedIngest.accepted, false);

    service.registerSink({
      id: 'test-sink',
      label: 'Test Sink',
      kind: 'idempotent',
      invoke: async () => ({ status: 'executed' }),
    });
    const blockedSink = await service.invokeSink('test-sink', {
      action: 'reply',
      target: { id: 1 },
      payload: { text: 'hi' },
      idempotencyKey: 'k-block',
    });
    assert.equal(blockedSink.status, 'skipped');
    assert.equal(blockedSink.detail, 'outbound_frozen');

    unsub();
    const okSink = await service.invokeSink('test-sink', {
      action: 'reply',
      target: { id: 1 },
      payload: { text: 'hi' },
      idempotencyKey: 'k-ok',
    });
    assert.equal(okSink.status, 'executed');
  } finally {
    db.close();
  }
});

test('invokeSink stages drafts, supports approveDraft/discardDraft, and recovers executing -> uncertain', async () => {
  const db = openHubDb({ inMemory: true });
  try {
    const guard = createDoorGuard();
    let invoked = 0;
    const sink: ActionSink = {
      id: 'draft-sink',
      label: 'Draft Sink',
      kind: 'staged-draft',
      invoke: async () => {
        invoked += 1;
        return { status: 'executed', detail: 'sent' };
      },
    };
    const service = createHubService(undefined, { db, guard });
    service.registerSink(sink);

    const staged1 = await service.invokeSink('draft-sink', {
      action: 'comment',
      target: { issue: 1 },
      payload: { text: 'draft one' },
      idempotencyKey: 'k-draft-1',
    });
    assert.equal(staged1.status, 'staged');
    assert.ok(staged1.draftId);
    assert.equal(invoked, 0);

    const approved = await service.approveDraft(staged1.draftId);
    assert.equal(approved.status, 'executed');
    assert.equal(invoked, 1);

    const staged2 = await service.invokeSink('draft-sink', {
      action: 'comment',
      target: { issue: 2 },
      payload: { text: 'draft two' },
      idempotencyKey: 'k-draft-2',
    });
    assert.ok(staged2.draftId);
    await service.discardDraft(staged2.draftId, 'not needed');
    const rejected = service.listDrafts({ status: 'rejected' });
    assert.equal(rejected.some((d) => d.id === staged2.draftId), true);

    const now = new Date().toISOString();
    db.db
      .prepare(
        `INSERT INTO staged_drafts (
           id, sink_id, sink_kind, action, target_json, payload_json,
           preview_text, idempotency_key, status, created_at, updated_at
         ) VALUES ('orphan-1', 'draft-sink', 'idempotent', 'send', '{}', '{}', 'orphan', 'k-orphan', 'executing', ?, ?)`,
      )
      .run(now, now);

    const recovered = service.recoverOrphanedSinks();
    assert.equal(recovered, 1);
    const uncertain = service.listDrafts({ status: 'uncertain' });
    assert.equal(uncertain.some((d) => d.id === 'orphan-1'), true);
  } finally {
    db.close();
  }
});

test('WechatTransport registration, live personaWardrobe lookup, and apply() dual Cordis wiring', async () => {
  const provided = new Map<string, unknown>();
  const cleanups: Array<() => void> = [];
  let liveWardrobe: PersonaWardrobe | undefined = undefined;
  const service = apply(
    {
      get: (k) => (k === 'personaWardrobe' ? liveWardrobe : undefined),
      provide: (k, v) => provided.set(k, v),
      effect: (fn) => {
        const off = fn();
        if (off) cleanups.push(off);
      },
    },
    { inMemory: true, tickIntervalMs: 0 },
  );

  try {
    assert.equal(provided.get('hub'), service);
    assert.equal(provided.get('watcher'), service);
    assert.equal(provided.has('personaWardrobe'), false);
    assert.equal(service.getWardrobe(), null);

    liveWardrobe = { list: () => [] } as unknown as PersonaWardrobe;
    assert.equal(service.getWardrobe(), liveWardrobe);

    const transport: WechatTransport = {
      send: async () => ({ status: 'sent' }),
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
    };

    const off = service.registerWechatTransport(transport);
    assert.equal(service.getWechatTransport(), transport);
    assert.equal(service.getStatus().wechatTransportMode, 'cordis');
    off();
    assert.equal(service.getWechatTransport(), null);
    assert.equal(service.getStatus().wechatTransportMode, 'unavailable');
  } finally {
    for (const fn of cleanups) fn();
  }
});

test('Fast-path subscription routing, connectors registry, and onUnclaimedEvent hook', async () => {
  const db = openHubDb({ inMemory: true });
  try {
    const guard = createDoorGuard();
    const { ctx, sent, agents } = makeMockSessionContext();
    agents.set('sess-fast', {
      session: { id: 'sess-fast' },
      state: { running: false },
      followup: (msg) => {
        sent.push({ sessionId: 'sess-fast', mode: 'followup', message: msg });
      },
      whenIdle: async () => {},
    });
    const bridge = createSessionBridge(ctx, db, null);
    const service = createHubService(undefined, { db, guard, sessionBridge: bridge });

    const offConn = service.registerConnector({
      id: 'github',
      label: 'GitHub',
      kind: 'connector',
      panelId: 'dsh-github-panel',
      panelLabel: 'GitHub',
      health: () => ({ ok: true, detail: 'connected' }),
    });
    assert.equal(service.listConnectors().length, 1);
    assert.equal(service.getStatus().connectors.length, 1);

    const sub = service.registerSubscription({
      source: 'github',
      threadKey: 'github:org/repo#42',
      sessionId: 'sess-fast',
      owner: 'manual',
    });
    assert.equal(sub.sessionId, 'sess-fast');
    assert.equal(service.resolveSubscription('github', 'github:org/repo#42')?.id, sub.id);
    assert.equal(service.getStatus().activeSubscriptions, 1);

    let unclaimedCalls = 0;
    const offUnclaimed = service.onUnclaimedEvent(async (ev, { inboxId }) => {
      unclaimedCalls += 1;
      assert.ok(inboxId);
      if (ev.threadKey === 'wechat:room-router') {
        const claimed = service.registerSubscription({
          source: ev.source,
          threadKey: ev.threadKey,
          sessionId: 'sess-router',
          owner: 'router',
        });
        return { handled: true, subscription: claimed };
      }
      return { handled: false };
    });

    const fastRes = await service.ingest(
      makeEvent({ id: 'e-fast', threadKey: 'github:org/repo#42', entityKey: 'github:org/repo#42' }),
    );
    await new Promise((r) => setImmediate(r));
    assert.equal(fastRes.accepted, true);
    assert.equal(fastRes.routedVia, 'subscription');
    assert.equal(unclaimedCalls, 0);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.sessionId, 'sess-fast');

    const routerRes = await service.ingest(
      makeEvent({ id: 'e-router', source: 'wechat', threadKey: 'wechat:room-router', entityKey: 'wechat:room-router' }),
    );
    assert.equal(routerRes.accepted, true);
    assert.equal(routerRes.routedVia, 'router');
    assert.equal(unclaimedCalls, 1);
    assert.equal(service.listInbox({ source: 'wechat' })[0]?.sessionId, 'sess-router');

    const fallbackRes = await service.ingest(
      makeEvent({ id: 'e-fallback', source: 'wechat', threadKey: 'wechat:room-other', entityKey: 'wechat:room-other' }),
    );
    assert.equal(fallbackRes.accepted, true);
    assert.equal(fallbackRes.routedVia, 'inbox');
    assert.equal(unclaimedCalls, 2);

    assert.equal(service.removeSubscription('github', 'github:org/repo#42'), true);
    assert.equal(service.resolveSubscription('github', 'github:org/repo#42'), null);
    offUnclaimed();
    offConn();
    assert.equal(service.listConnectors().length, 0);
  } finally {
    db.close();
  }
});

test('handledByWechatSession memo event records inbox link to original WeChat session without waking Router or subscription', async () => {
  const db = openHubDb({ inMemory: true });
  try {
    const guard = createDoorGuard();
    const { ctx, sent, agents } = makeMockSessionContext();
    agents.set('sess-stale-router', {
      session: { id: 'sess-stale-router' },
      state: { running: false },
      followup: (msg) => {
        sent.push({ sessionId: 'sess-stale-router', mode: 'followup', message: msg });
      },
      whenIdle: async () => {},
    });
    const bridge = createSessionBridge(ctx, db, null);
    const service = createHubService(undefined, { db, guard, sessionBridge: bridge });

    service.registerSubscription({
      source: 'memo',
      threadKey: 'wechat:demo-family@chatroom',
      sessionId: 'sess-stale-router',
      owner: 'router',
    });

    let unclaimedCalls = 0;
    const offUnclaimed = service.onUnclaimedEvent(async () => {
      unclaimedCalls += 1;
      return { handled: true };
    });

    const res = await service.ingest(
      makeEvent({
        id: 'evt-memo-handled',
        source: 'memo',
        type: 'memo.time_nudge.due',
        threadKey: 'wechat:demo-family@chatroom',
        entityKey: 'wechat:demo-family@chatroom',
        summary: '[待惦记] 提醒小周做八段锦',
        payload: {
          handledByWechatSession: true,
          handledSessionId: 'sess-wechat-group',
        },
      }),
    );

    assert.equal(res.accepted, true);
    assert.equal(res.routedVia, 'inbox');
    assert.equal(unclaimedCalls, 0);
    assert.equal(sent.length, 0);

    const items = service.listInbox({ source: 'memo' });
    assert.equal(items.length, 1);
    assert.equal(items[0].sessionId, 'sess-wechat-group');
    assert.equal(items[0].status, 'resolved');
    offUnclaimed();
  } finally {
    db.close();
  }
});

test('registerAdminWechatHandler and dispatchAdminWechatMessage support ordered claim, error isolation, and cleanup', async () => {
  const db = openHubDb({ inMemory: true });
  const effectCleanups: Array<() => void> = [];
  try {
    const guard = createDoorGuard();
    const service = createHubService(
      {
        effect: (fn) => {
          const off = fn();
          if (off) effectCleanups.push(off);
        },
      },
      { db, guard },
    );

    const baseMessage = {
      session: 'filehelper',
      senderId: 'wxid_admin',
      text: '看看现在的页面',
      quotedText: '上一条提醒',
      seq: 42,
      timestamp: 1_700_000_000_000,
    };

    assert.deepEqual(await service.dispatchAdminWechatMessage(baseMessage), { handled: false });

    const calls: string[] = [];
    const offFirst = service.registerAdminWechatHandler(() => {
      calls.push('first-unclaimed');
      return { handled: false };
    });
    const offVoid = service.registerAdminWechatHandler(async () => {
      calls.push('second-void');
    });
    const offThrow = service.registerAdminWechatHandler(async () => {
      calls.push('third-throw');
      throw new Error('boom');
    });
    const offClaim = service.registerAdminWechatHandler(async (msg) => {
      calls.push(`fourth-claim:${msg.text}`);
      if (msg.text.includes('页面')) {
        return {
          handled: true,
          replyText: '已截图发你',
          imagePath: '/tmp/router-shot.png',
        };
      }
      return { handled: false };
    });
    const offAfter = service.registerAdminWechatHandler(() => {
      calls.push('fifth-should-not-run');
      return { handled: true, replyText: 'late' };
    });

    const claimed = await service.dispatchAdminWechatMessage(baseMessage);
    assert.deepEqual(claimed, {
      handled: true,
      replyText: '已截图发你',
      imagePath: '/tmp/router-shot.png',
    });
    assert.deepEqual(calls, ['first-unclaimed', 'second-void', 'third-throw', 'fourth-claim:看看现在的页面']);

    calls.length = 0;
    const offAfterResult = await service.dispatchAdminWechatMessage({
      ...baseMessage,
      text: '随便聊聊',
    });
    assert.deepEqual(offAfterResult, { handled: true, replyText: 'late' });
    assert.deepEqual(calls, [
      'first-unclaimed',
      'second-void',
      'third-throw',
      'fourth-claim:随便聊聊',
      'fifth-should-not-run',
    ]);

    offClaim();
    offAfter();
    calls.length = 0;
    const unclaimedAfterDispose = await service.dispatchAdminWechatMessage(baseMessage);
    assert.deepEqual(unclaimedAfterDispose, { handled: false });
    assert.deepEqual(calls, ['first-unclaimed', 'second-void', 'third-throw']);

    offFirst();
    offVoid();
    offThrow();

    let effectBoundCalls = 0;
    service.registerAdminWechatHandler(() => {
      effectBoundCalls += 1;
      return { handled: true, replyText: 'effect-bound' };
    });
    assert.deepEqual(await service.dispatchAdminWechatMessage(baseMessage), {
      handled: true,
      replyText: 'effect-bound',
    });
    assert.equal(effectBoundCalls, 1);

    for (const cleanup of effectCleanups) cleanup();
    calls.length = 0;
    assert.deepEqual(await service.dispatchAdminWechatMessage(baseMessage), { handled: false });
    assert.deepEqual(calls, []);
    assert.equal(effectBoundCalls, 1);

    const sendWithImage: WechatSendInput = {
      chatId: 'filehelper',
      text: '截图',
      idempotencyKey: 'img-1',
      imagePath: '/tmp/shot.png',
    };
    const statusWithController: WechatTransportStatus = {
      ok: true,
      mode: 'cordis',
      healthy: true,
      ownId: 'wxid_bot',
      controllerId: 'wxid_admin',
    };
    assert.equal(sendWithImage.imagePath, '/tmp/shot.png');
    assert.equal(statusWithController.controllerId, 'wxid_admin');
  } finally {
    db.close();
  }
});

function readDeliveredText(message: unknown): string {
  const msg = message as { content?: Array<{ text?: string }> } | undefined;
  return msg?.content?.map((item) => item.text ?? '').join('\n') ?? '';
}

test('GitHub PR inherits active Issue router subscription, forwards decisionId prompt, and reuses subscription on follow-ups', async () => {
  const db = openHubDb({ inMemory: true });
  try {
    const guard = createDoorGuard();
    const { ctx, sent, agents } = makeMockSessionContext();
    agents.set('sess-issue-243', {
      session: { id: 'sess-issue-243' },
      state: { running: false },
      followup: (msg) => {
        sent.push({ sessionId: 'sess-issue-243', mode: 'followup', message: msg });
      },
      whenIdle: async () => {},
    });
    agents.set('sess-manual', {
      session: { id: 'sess-manual' },
      state: { running: false },
      followup: (msg) => {
        sent.push({ sessionId: 'sess-manual', mode: 'followup', message: msg });
      },
      whenIdle: async () => {},
    });
    const bridge = createSessionBridge(ctx, db, null);
    const service = createHubService(undefined, { db, guard, sessionBridge: bridge });

    const now = new Date().toISOString();
    const ttl = new Date(Date.now() + 3600_000).toISOString();
    db.db
      .prepare(
        `INSERT INTO workstreams (
           id, source, workstream_key, primary_entity_key, entity_keys_json,
           workspace_path, session_id, status, mode, trust_mode,
           delivery_count, max_wakeups, ttl_expires_at, config_revision, created_at, updated_at
         ) VALUES ('ws-243', 'github', 'github:example-owner/example-repo#243', 'github:example-owner/example-repo#243', '["github:example-owner/example-repo#243"]', '/repo/example', 'sess-issue-243', 'active', 'repeat', 'triage', 0, 10, ?, 1, ?, ?)`,
      )
      .run(ttl, now, now);

    service.registerSubscription({
      source: 'github',
      threadKey: 'github:example-owner/example-repo#243',
      sessionId: 'sess-issue-243',
      workstreamId: 'ws-243',
      personaId: 'persona-gh',
      owner: 'router',
      metadata: {
        decisionId: 'dec-243',
        level: 'act',
      },
    });

    let unclaimedCalls = 0;
    const offUnclaimed = service.onUnclaimedEvent(async () => {
      unclaimedCalls += 1;
      return { handled: true };
    });

    const prRes = await service.ingest(
      makeEvent({
        id: 'evt-pr-246-review-1',
        type: 'github.pr.comment',
        threadKey: 'github:example-owner/example-repo#246',
        entityKey: 'github:example-owner/example-repo#246',
        summary: '[src/panel.ts:42] Please adjust the button padding and add a screenshot.',
        payload: {
          body: 'Please adjust the button padding and add a screenshot.',
          path: 'src/panel.ts',
          line: 42,
          linkedIssues: [243],
        },
        rawRef: {
          repo: 'example-owner/example-repo',
          number: 246,
          url: 'https://github.com/example-owner/example-repo/pull/246#discussion_r1',
        },
      }),
    );
    await new Promise((r) => setImmediate(r));

    assert.equal(prRes.accepted, true);
    assert.equal(prRes.routedVia, 'subscription');
    assert.equal(unclaimedCalls, 0);

    const inheritedSub = service.resolveSubscription('github', 'github:example-owner/example-repo#246');
    assert.ok(inheritedSub);
    assert.equal(inheritedSub.sessionId, 'sess-issue-243');
    assert.equal(inheritedSub.workstreamId, 'ws-243');
    assert.equal(inheritedSub.personaId, 'persona-gh');
    assert.equal(inheritedSub.owner, 'router');
    assert.equal(inheritedSub.metadata.decisionId, 'dec-243');
    assert.equal(inheritedSub.metadata.level, 'act');
    assert.equal(inheritedSub.metadata.linkedFromThreadKey, 'github:example-owner/example-repo#243');

    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.sessionId, 'sess-issue-243');
    const firstPrompt = readDeliveredText(sent[0]?.message);
    assert.match(firstPrompt, /"summary": "\[src\/panel\.ts:42\] Please adjust the button padding and add a screenshot\."/);
    assert.match(firstPrompt, /"path": "src\/panel\.ts"/);
    assert.match(firstPrompt, /"line": 42/);
    assert.match(firstPrompt, /decisionId: dec-243/);
    assert.match(firstPrompt, /github:example-owner\/example-repo#243/);
    assert.match(firstPrompt, /router_report_result/);
    assert.match(firstPrompt, /imagePath/);

    const followUpRes = await service.ingest(
      makeEvent({
        id: 'evt-pr-246-approved-empty-body',
        type: 'github.pr.comment',
        threadKey: 'github:example-owner/example-repo#246',
        entityKey: 'github:example-owner/example-repo#246',
        summary: '[APPROVED] example-reviewer approved PR #246',
        payload: {
          body: '',
          reviewState: 'APPROVED',
        },
      }),
    );
    await new Promise((r) => setImmediate(r));

    assert.equal(followUpRes.accepted, true);
    assert.equal(followUpRes.routedVia, 'subscription');
    assert.equal(unclaimedCalls, 0);
    assert.equal(sent.length, 2);
    assert.equal(sent[1]?.sessionId, 'sess-issue-243');
    const secondPrompt = readDeliveredText(sent[1]?.message);
    assert.match(secondPrompt, /"summary": "\[APPROVED\] example-reviewer approved PR #246"/);
    assert.match(secondPrompt, /"body": "\[APPROVED\] example-reviewer approved PR #246"/);
    assert.match(secondPrompt, /"reviewState": "APPROVED"/);
    assert.match(secondPrompt, /decisionId: dec-243/);
    assert.match(secondPrompt, /router_report_result/);

    const linkedFromRes = await service.ingest(
      makeEvent({
        id: 'evt-pr-247-linked-from',
        type: 'pull_request_review',
        threadKey: 'github:example-owner/example-repo#247',
        entityKey: 'github:example-owner/example-repo#247',
        summary: 'Linked PR #247 via linkedFromIssue',
        payload: {
          body: 'Checking linkedFromIssue compatibility.',
          linkedFromIssue: 243,
        },
      }),
    );
    await new Promise((r) => setImmediate(r));

    assert.equal(linkedFromRes.accepted, true);
    assert.equal(linkedFromRes.routedVia, 'subscription');
    assert.equal(unclaimedCalls, 0);
    const inheritedFromSingle = service.resolveSubscription('github', 'github:example-owner/example-repo#247');
    assert.equal(inheritedFromSingle?.sessionId, 'sess-issue-243');
    assert.equal(inheritedFromSingle?.metadata.linkedFromThreadKey, 'github:example-owner/example-repo#243');

    service.registerSubscription({
      source: 'github',
      threadKey: 'github:example-owner/example-repo#300',
      sessionId: 'sess-manual',
      owner: 'manual',
      metadata: {
        decisionId: 'ignored-for-non-router',
      },
    });
    const manualRes = await service.ingest(
      makeEvent({
        id: 'evt-manual-300',
        threadKey: 'github:example-owner/example-repo#300',
        entityKey: 'github:example-owner/example-repo#300',
        payload: { body: 'Manual watch event' },
      }),
    );
    await new Promise((r) => setImmediate(r));

    assert.equal(manualRes.routedVia, 'subscription');
    const manualPrompt = readDeliveredText(sent[sent.length - 1]?.message);
    assert.doesNotMatch(manualPrompt, /router_report_result/);
    assert.match(manualPrompt, /watch_stage_draft/);

    offUnclaimed();
  } finally {
    db.close();
  }
});
