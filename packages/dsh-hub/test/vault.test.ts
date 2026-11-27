import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  ActionSink,
  AdminWechatMessage,
  NormalizedEvent,
  PersonaWardrobe,
  TargetDirectoryProvider,
  ThreadLifecycleEvent,
  ToolExecutionContext,
  VaultProvider,
  VaultScope,
} from '../src/contracts.js';
import { openHubDb } from '../src/db.js';
import { PUBLIC_TAINT_WARNING_TEXT, createDoorGuard } from '../src/guard.js';
import { apply } from '../src/index.js';
import { createHubService } from '../src/service.js';
import { createSessionBridge, type DshAgent, type SessionBridgeContext } from '../src/session-bridge.js';
import { VaultError, type VaultToolDefinition } from '../src/vault.js';

function makeExec(
  sessionId: string,
  header?: NonNullable<NonNullable<ToolExecutionContext['agent']>['session']>['header'],
): ToolExecutionContext {
  return {
    agent: {
      id: sessionId,
      session: {
        id: sessionId,
        header: {
          delegationDepth: 0,
          ...header,
        },
      },
    },
  };
}

function makeEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  const id = overrides.id ?? 'evt-vault-1';
  return {
    id,
    source: 'github',
    type: 'github.pr.closed',
    dedupeKey: overrides.dedupeKey ?? `dedupe:${id}`,
    threadKey: 'github:org/repo#99',
    entityKey: 'github:org/repo#99',
    actor: { id: 'u1', login: 'example-user' },
    trustLevel: 'owner',
    occurredAt: new Date().toISOString(),
    summary: 'PR #99 closed',
    payload: {},
    ...overrides,
  };
}

test('Vault enforces four-tier visibility, double-lock filtering, snippet truncation, turn overrides, and sticky taint', async () => {
  const db = openHubDb({ inMemory: true });
  try {
    const guard = createDoorGuard();
    const service = createHubService(undefined, { db, guard });

    const seenScopes: VaultScope[] = [];
    const longSnippet = 'A'.repeat(300);

    const leakyProvider: VaultProvider = {
      id: 'multi',
      label: 'Multi-Circle Provider',
      search: (_query, scope) => {
        seenScopes.push(scope);
        return [
          {
            source: 'multi',
            itemId: 'item-ext',
            circle: 'external',
            occurredAt: '2026-11-01T10:00:00.000Z',
            snippet: longSnippet,
            author: 'public-author',
          },
          {
            source: 'multi',
            itemId: 'item-work',
            circle: 'work',
            occurredAt: '2026-11-02T10:00:00.000Z',
            snippet: 'Internal sprint note about release cadence',
            author: 'colleague',
          },
          {
            source: 'multi',
            itemId: 'item-family',
            circle: 'family',
            occurredAt: '2026-11-03T10:00:00.000Z',
            snippet: 'Family weekend dinner plan',
            author: 'relative',
          },
          {
            source: 'multi',
            itemId: 'item-priv',
            circle: 'owner_private',
            occurredAt: '2026-11-04T10:00:00.000Z',
            snippet: 'Owner private journal entry',
            author: 'owner',
          },
        ];
      },
      context: (itemId, opts) => {
        if (itemId === 'item-work') {
          return {
            source: 'multi',
            itemId,
            circle: 'work',
            roomKey: 'dingtalk:work-1',
            items: [
              {
                itemId: 'item-work-prev',
                circle: 'work',
                occurredAt: '2026-11-02T09:59:00.000Z',
                text: `before=${opts.before},after=${opts.after}`,
              },
              {
                itemId: 'item-priv-leak',
                circle: 'owner_private',
                occurredAt: '2026-11-02T10:01:00.000Z',
                text: 'should be filtered out for tier 2',
              },
            ],
          };
        }
        return {
          source: 'multi',
          itemId,
          circle: 'owner_private',
          items: [
            {
              itemId,
              circle: 'owner_private',
              occurredAt: '2026-11-04T10:00:00.000Z',
              text: 'private full text',
              isTarget: true,
            },
          ],
        };
      },
    };

    const offProvider = service.vault.registerProvider(leakyProvider);
    assert.deepEqual(service.vault.listProviders(), [
      { id: 'multi', label: 'Multi-Circle Provider', supportsContext: true },
    ]);

    const missingPrincipal = service.resolveSessionPrincipal(undefined);
    assert.equal(missingPrincipal.role, 'unknown');
    assert.equal(missingPrincipal.tier, 0);
    assert.equal(missingPrincipal.trustLevel, 'untrusted');
    assert.equal(missingPrincipal.rootSessionId, null);
    assert.deepEqual(missingPrincipal.allowedCircles, []);

    await assert.rejects(
      () => service.vault.search({ query: 'plan' }, undefined),
      (err: unknown) => err instanceof VaultError && err.code === 'VAULT_FORBIDDEN',
    );
    await assert.rejects(
      () => service.vault.context('multi', 'item-ext', undefined, undefined),
      (err: unknown) => err instanceof VaultError && err.code === 'VAULT_FORBIDDEN',
    );

    const offTier0 = service.registerSessionPrincipal({
      sessionId: 'sess-ext-chat',
      role: 'external_chat',
      tier: 0,
      trustLevel: 'untrusted',
      boundRoomKey: 'wechat:ext-group@chatroom',
    });
    await assert.rejects(
      () => service.vault.search({ query: 'plan' }, makeExec('sess-ext-chat')),
      (err: unknown) => err instanceof VaultError && err.code === 'VAULT_FORBIDDEN',
    );

    service.registerSessionPrincipal({
      sessionId: 'sess-public-pr',
      role: 'worker',
      tier: 1,
      trustLevel: 'triage',
      boundSource: 'github',
      boundRepo: 'org/public-repo',
      targetCircle: 'external',
    });
    const tier1Res = await service.vault.search({ query: 'plan', limit: 50 }, makeExec('sess-public-pr'));
    assert.equal(tier1Res.tier, 1);
    assert.deepEqual(tier1Res.allowedCircles, ['external']);
    assert.deepEqual(
      tier1Res.hits.map((h) => h.itemId),
      ['item-ext'],
    );
    assert.equal(tier1Res.hits[0]!.snippet.length, 220);
    assert.equal(seenScopes[seenScopes.length - 1]?.allowedCircles.join(','), 'external');
    assert.equal(service.isSessionTainted('sess-public-pr'), false);
    assert.equal(service.isTurnPrivateRead('sess-public-pr'), false);

    const tier1ContextLeak = await service.vault.context(
      'multi',
      'item-priv',
      { before: 50, after: 50 },
      makeExec('sess-public-pr'),
    );
    assert.equal(tier1ContextLeak.result, null);
    assert.equal(service.isSessionTainted('sess-public-pr'), false);

    service.setSessionTurnOverride('sess-public-pr', 3, 60_000);
    const elevatedRes = await service.vault.search({ query: 'plan' }, makeExec('sess-public-pr'));
    assert.equal(elevatedRes.tier, 3);
    assert.equal(elevatedRes.hits.length, 4);
    assert.equal(service.isSessionTainted('sess-public-pr'), true);
    assert.equal(service.isTurnPrivateRead('sess-public-pr'), true);

    service.clearSessionTurnOverride('sess-public-pr');
    service.clearTurnPrivateRead('sess-public-pr');
    assert.equal(service.isTurnPrivateRead('sess-public-pr'), false);
    assert.equal(service.isSessionTainted('sess-public-pr'), true);
    const revertedPrincipal = service.resolveSessionPrincipal(makeExec('sess-public-pr'));
    assert.equal(revertedPrincipal.tier, 1);

    service.registerSessionPrincipal({
      sessionId: 'sess-work-pr',
      role: 'worker',
      tier: 2,
      trustLevel: 'triage',
      boundSource: 'github',
      boundRepo: 'corp/private-repo',
      targetCircle: 'work',
    });
    const tier2Res = await service.vault.search({ query: 'plan' }, makeExec('sess-work-pr'));
    assert.equal(tier2Res.tier, 2);
    assert.deepEqual(tier2Res.allowedCircles, ['external', 'work']);
    assert.deepEqual(
      tier2Res.hits.map((h) => h.itemId),
      ['item-work', 'item-ext'],
    );
    assert.equal(service.isSessionTainted('sess-work-pr'), true);
    assert.equal(service.isTurnPrivateRead('sess-work-pr'), true);

    const tier2Ctx = await service.vault.context(
      'multi',
      'item-work',
      { before: 30, after: 25 },
      makeExec('sess-work-pr'),
    );
    assert.ok(tier2Ctx.result);
    assert.deepEqual(
      tier2Ctx.result.items.map((i) => i.itemId),
      ['item-work-prev'],
    );
    assert.equal(tier2Ctx.result.items[0]?.text, 'before=15,after=15');

    const interactivePrincipal = service.resolveSessionPrincipal(makeExec('sess-local-dsh-ui'));
    assert.equal(interactivePrincipal.role, 'interactive');
    assert.equal(interactivePrincipal.tier, 3);
    assert.equal(interactivePrincipal.trustLevel, 'owner');
    assert.equal(interactivePrincipal.rootSessionId, 'sess-local-dsh-ui');
    const interactiveRes = await service.vault.search({ query: 'plan' }, makeExec('sess-local-dsh-ui'));
    assert.equal(interactiveRes.hits.length, 4);
    assert.equal(service.isSessionTainted('sess-local-dsh-ui'), true);

    offTier0();
    assert.equal(service.getSessionPrincipal('sess-ext-chat'), null);
    offProvider();
    assert.equal(service.vault.listProviders().length, 0);
  } finally {
    db.close();
  }
});

test('Vault supports empty-query chronological browsing with filters, roomKey passthrough/filtering, and still rejects bare empty queries', async () => {
  const db = openHubDb({ inMemory: true });
  try {
    const guard = createDoorGuard();
    const service = createHubService(undefined, { db, guard });
    const receivedQueries: Array<{ query?: string; roomKey?: string; sources?: string[] }> = [];

    service.vault.registerProvider({
      id: 'wechat',
      label: 'WeChat Mock',
      search: (q) => {
        receivedQueries.push({ query: q.query, roomKey: q.roomKey, sources: q.sources });
        return [
          {
            source: 'wechat',
            itemId: 'seq:1',
            circle: 'external',
            roomKey: 'wechat:room-a',
            occurredAt: '2026-11-20T08:00:00.000Z',
            snippet: 'older external message',
            author: 'alice',
          },
          {
            source: 'wechat',
            itemId: 'seq:2',
            circle: 'owner_private',
            roomKey: 'wechat:owner-dm',
            occurredAt: '2026-11-20T09:00:00.000Z',
            snippet: 'newer private dm message',
            author: 'owner',
          },
          {
            source: 'wechat',
            itemId: 'seq:3',
            circle: 'owner_private',
            roomKey: 'wechat:other-dm',
            occurredAt: '2026-11-20T10:00:00.000Z',
            snippet: 'other private dm message',
            author: 'friend',
          },
        ];
      },
    });

    service.registerSessionPrincipal({
      sessionId: 'sess-owner',
      role: 'owner_session',
      tier: 3,
      trustLevel: 'owner',
    });
    service.registerSessionPrincipal({
      sessionId: 'sess-tier1',
      role: 'worker',
      tier: 1,
      trustLevel: 'triage',
    });

    await assert.rejects(
      () => service.vault.search({ query: '' }, makeExec('sess-owner')),
      (err: unknown) => err instanceof VaultError && err.code === 'VAULT_INVALID_QUERY',
    );
    await assert.rejects(
      () => service.vault.search({}, makeExec('sess-owner')),
      (err: unknown) => err instanceof VaultError && err.code === 'VAULT_INVALID_QUERY',
    );

    const recentBySource = await service.vault.search(
      { query: '', sources: ['wechat'], limit: 10 },
      makeExec('sess-owner'),
    );
    assert.deepEqual(
      recentBySource.hits.map((h) => h.itemId),
      ['seq:3', 'seq:2', 'seq:1'],
    );
    assert.equal(service.isSessionTainted('sess-owner'), true);
    assert.equal(service.isTurnPrivateRead('sess-owner'), true);

    const byRoomKey = await service.vault.search(
      { sources: ['wechat'], roomKey: 'wechat:owner-dm', limit: 10 },
      makeExec('sess-owner'),
    );
    assert.equal(receivedQueries.at(-1)?.roomKey, 'wechat:owner-dm');
    assert.deepEqual(
      byRoomKey.hits.map((h) => h.itemId),
      ['seq:2'],
    );

    const byBareRoomKey = await service.vault.search(
      { roomKey: 'owner-dm' },
      makeExec('sess-owner'),
    );
    assert.deepEqual(
      byBareRoomKey.hits.map((h) => h.itemId),
      ['seq:2'],
    );

    const tier1Browse = await service.vault.search(
      { query: '', sources: ['wechat'] },
      makeExec('sess-tier1'),
    );
    assert.deepEqual(
      tier1Browse.hits.map((h) => h.itemId),
      ['seq:1'],
    );
    assert.equal(service.isSessionTainted('sess-tier1'), false);
  } finally {
    db.close();
  }
});

test('Subagent strictly inherits parent tier (never escalates), fail-closes without parent, and propagates taint to rootSessionId', async () => {
  const db = openHubDb({ inMemory: true });
  try {
    const guard = createDoorGuard();
    const agentsMap = new Map<string, { id: string; session: { header: { parentSession?: string } } }>([
      ['sess-mid-sub', { id: 'sess-mid-sub', session: { header: { parentSession: 'sess-work-root' } } }],
    ]);
    const service = createHubService(
      {
        agents: {
          get: (id) => agentsMap.get(id),
        },
      },
      { db, guard },
    );

    service.vault.registerProvider({
      id: 'wxarc',
      label: 'WeChat Archive',
      search: () => [
        {
          source: 'wxarc',
          itemId: 'msg-work-1',
          circle: 'work',
          occurredAt: '2026-11-10T08:00:00.000Z',
          snippet: 'Work group discussion',
        },
        {
          source: 'wxarc',
          itemId: 'msg-priv-1',
          circle: 'owner_private',
          occurredAt: '2026-11-10T09:00:00.000Z',
          snippet: 'Private chat note',
        },
      ],
    });

    const orphanSubExec = makeExec('sess-orphan-sub', {
      delegationDepth: 1,
      origin: 'subagent',
      parentSessionId: 'sess-unregistered-parent',
    });
    const orphanPrincipal = service.resolveSessionPrincipal(orphanSubExec);
    assert.equal(orphanPrincipal.tier, 0);
    assert.equal(orphanPrincipal.role, 'unknown');
    assert.equal(orphanPrincipal.trustLevel, 'untrusted');
    await assert.rejects(
      () => service.vault.search({ query: 'work' }, orphanSubExec),
      (err: unknown) => err instanceof VaultError && err.code === 'VAULT_FORBIDDEN',
    );

    service.registerSessionPrincipal({
      sessionId: 'sess-work-root',
      role: 'worker',
      tier: 2,
      trustLevel: 'triage',
      boundRepo: 'corp/app',
      targetCircle: 'work',
    });

    service.registerSessionPrincipal({
      sessionId: 'sess-sneaky-sub',
      role: 'owner_session',
      tier: 3,
      trustLevel: 'owner',
    });
    const sneakyExec = makeExec('sess-sneaky-sub', {
      delegationDepth: 1,
      origin: 'subagent',
      parentSessionId: 'sess-work-root',
    });
    const sneakyResolved = service.resolveSessionPrincipal(sneakyExec);
    assert.equal(sneakyResolved.tier, 2);
    assert.equal(sneakyResolved.rootSessionId, 'sess-work-root');
    assert.deepEqual(sneakyResolved.allowedCircles, ['external', 'work']);

    const grandChildExec = makeExec('sess-grandchild-sub', {
      delegationDepth: 2,
      origin: 'subagent',
      parentSession: 'sess-mid-sub',
    });
    const grandChildResolved = service.resolveSessionPrincipal(grandChildExec);
    assert.equal(grandChildResolved.tier, 2);
    assert.equal(grandChildResolved.rootSessionId, 'sess-work-root');
    assert.equal(service.isSessionTainted('sess-work-root'), false);

    const res = await service.vault.search({ query: 'work' }, grandChildExec);
    assert.deepEqual(
      res.hits.map((h) => h.itemId),
      ['msg-work-1'],
    );
    assert.equal(service.isSessionTainted('sess-work-root'), true);
    assert.equal(service.isTurnPrivateRead('sess-work-root'), true);
    assert.equal(service.isSessionTainted('sess-grandchild-sub'), true);
  } finally {
    db.close();
  }
});

test('DoorGuard forces tainted sessions to stageOnly and attaches public taint warning on external targets', async () => {
  const db = openHubDb({ inMemory: true });
  try {
    const guard = createDoorGuard();
    const service = createHubService(undefined, { db, guard });

    let executedCount = 0;
    const autoSendSink: ActionSink = {
      id: 'github.comment',
      label: 'GitHub Comment Auto-Send',
      kind: 'idempotent',
      requiresApproval: false,
      invoke: async () => {
        executedCount += 1;
        return { status: 'executed', receiptId: `r-${executedCount}` };
      },
    };
    service.registerSink(autoSendSink);

    service.registerSessionPrincipal({
      sessionId: 'sess-pub',
      role: 'worker',
      tier: 1,
      trustLevel: 'triage',
      targetCircle: 'external',
    });

    const cleanGate = await guard.beforeSendOut({
      sinkId: 'github.comment',
      sessionId: 'sess-pub',
      targetCircle: 'external',
    });
    assert.deepEqual(cleanGate, { allow: true, reason: 'passthrough' });

    const cleanSend = await service.invokeSink('github.comment', {
      action: 'comment',
      target: { repo: 'org/public', number: 1 },
      payload: { body: 'Clean public review' },
      idempotencyKey: 'k-clean-1',
      sessionId: 'sess-pub',
      targetCircle: 'external',
    });
    assert.equal(cleanSend.status, 'executed');
    assert.equal(executedCount, 1);

    service.markSessionTainted('sess-pub', 'vault_search_non_external');

    const workGate = await guard.beforeSendOut({
      sinkId: 'github.comment',
      sessionId: 'sess-pub',
      targetCircle: 'work',
    });
    assert.equal(workGate.allow, true);
    assert.equal(workGate.stageOnly, true);
    assert.equal(workGate.tainted, true);
    assert.equal(workGate.publicTaintWarning, undefined);

    const publicGate = await guard.beforeSendOut({
      sinkId: 'github.comment',
      sessionId: 'sess-pub',
      targetCircle: 'external',
    });
    assert.equal(publicGate.allow, true);
    assert.equal(publicGate.stageOnly, true);
    assert.equal(publicGate.tainted, true);
    assert.equal(publicGate.publicTaintWarning, true);
    assert.equal(publicGate.warningText, PUBLIC_TAINT_WARNING_TEXT);

    const taintedSend = await service.invokeSink('github.comment', {
      action: 'comment',
      target: { repo: 'org/public', number: 2 },
      payload: { body: 'Review drafted after reading private context' },
      idempotencyKey: 'k-tainted-1',
      sessionId: 'sess-pub',
    });
    assert.equal(taintedSend.status, 'staged');
    assert.equal(taintedSend.stageOnlyForced, true);
    assert.equal(taintedSend.publicTaintWarning, true);
    assert.equal(taintedSend.warningText, PUBLIC_TAINT_WARNING_TEXT);
    assert.ok(taintedSend.draftId);
    assert.equal(executedCount, 1);

    const pending = service.listDrafts({ status: 'pending_approval' });
    const draft = pending.find((d) => d.id === taintedSend.draftId);
    assert.ok(draft);
    assert.ok(draft.previewText.startsWith(PUBLIC_TAINT_WARNING_TEXT));

    const approved = await service.approveDraft(taintedSend.draftId);
    assert.equal(approved.status, 'executed');
    assert.equal(executedCount, 2);
  } finally {
    db.close();
  }
});

test('apply() provides vault service, registers vault_search & vault_context tools, and bridges personaWardrobe', async () => {
  const provided = new Map<string, unknown>();
  const tools = new Map<string, VaultToolDefinition>();
  const cleanups: Array<() => void> = [];

  const mockWardrobe = {
    list: () => [],
    searchVaultKnowledge: ({ query }: { query: string }) => [
      {
        source: 'persona',
        itemId: 'persona-fact-1',
        circle: 'owner_private' as const,
        occurredAt: '2026-11-15T12:00:00.000Z',
        snippet: `Matched persona knowledge for ${query}`,
      },
    ],
    getVaultKnowledgeContext: (itemId: string) => ({
      source: 'persona' as const,
      itemId,
      kind: 'foundation' as const,
      circle: 'owner_private' as const,
      occurredAt: '2026-11-15T12:00:00.000Z',
      content: 'Expanded persona fact text',
      before: [
        {
          itemId: 'persona-fact-0',
          kind: 'foundation' as const,
          circle: 'owner_private' as const,
          occurredAt: '2026-11-15T11:55:00.000Z',
          text: 'Preceding persona entry',
        },
      ],
      after: [],
    }),
  } as unknown as PersonaWardrobe;

  const service = apply(
    {
      personaWardrobe: mockWardrobe,
      provide: (k, v) => provided.set(k, v),
      tools: {
        register: (def) => {
          tools.set(def.name, def as VaultToolDefinition);
          return () => {
            tools.delete(def.name);
          };
        },
      },
      effect: (fn) => {
        const off = fn();
        if (off) cleanups.push(off);
      },
    },
    { inMemory: true, tickIntervalMs: 0 },
  );

  try {
    assert.equal(provided.get('vault'), service.vault);
    assert.ok(tools.has('vault_search'));
    assert.ok(tools.has('vault_context'));
    assert.equal(service.vault.listProviders().some((p) => p.id === 'persona'), true);

    const searchTool = tools.get('vault_search')!;
    const contextTool = tools.get('vault_context')!;
    assert.equal(searchTool.isConcurrencySafe(), true);
    assert.equal(contextTool.isConcurrencySafe(), true);
    assert.equal(Array.isArray(searchTool.inputSchema.required), false);
    assert.ok((searchTool.inputSchema.properties as Record<string, unknown>).roomKey);

    const searchRes = (await searchTool.execute(
      { query: 'deadline', sources: ['persona'] },
      makeExec('sess-owner-interactive'),
    )) as { hits: Array<{ itemId: string; source: string }>; tainted: boolean };
    assert.equal(searchRes.hits.length, 1);
    assert.equal(searchRes.hits[0]?.itemId, 'persona-fact-1');
    assert.equal(searchRes.tainted, true);

    const ctxRes = (await contextTool.execute(
      { source: 'persona', itemId: 'persona-fact-1', before: 2, after: 2 },
      makeExec('sess-owner-interactive'),
    )) as { result: { items: Array<{ text: string; isTarget?: boolean }> } | null };
    assert.equal(ctxRes.result?.items.length, 2);
    assert.equal(ctxRes.result?.items[0]?.text, 'Preceding persona entry');
    assert.equal(ctxRes.result?.items[1]?.text, 'Expanded persona fact text');
    assert.equal(ctxRes.result?.items[1]?.isTarget, true);
  } finally {
    for (const fn of cleanups) fn();
  }
});

test('TargetDirectoryProvider resolution/listing and extended AdminWechatMessage fields work end-to-end', async () => {
  const db = openHubDb({ inMemory: true });
  try {
    const guard = createDoorGuard();
    const service = createHubService(undefined, { db, guard });

    assert.deepEqual(await service.resolveTarget({ targetName: 'Core Team' }), { status: 'not_found' });
    assert.deepEqual(await service.listTargets(), []);

    const wxProvider: TargetDirectoryProvider = {
      id: 'wxarc',
      source: 'wechat',
      resolveTarget: (query) => {
        if (query.targetName === 'Core Team') {
          return {
            status: 'matched',
            target: {
              source: 'wechat',
              targetId: '12345@chatroom',
              roomKey: 'wechat:12345@chatroom',
              chatId: '12345@chatroom',
              title: 'Core Team',
              circle: 'work',
            },
          };
        }
        if (query.targetName === 'Project') {
          return {
            status: 'ambiguous',
            candidates: [
              { source: 'wechat', targetId: 'p1@chatroom', roomKey: 'wechat:p1@chatroom', title: 'Project A' },
              { source: 'wechat', targetId: 'p2@chatroom', roomKey: 'wechat:p2@chatroom', title: 'Project B' },
            ],
          };
        }
        return { status: 'not_found' };
      },
      listTargets: () => [
        { source: 'wechat', targetId: '12345@chatroom', roomKey: 'wechat:12345@chatroom', title: 'Core Team' },
        { source: 'wechat', targetId: 'p1@chatroom', roomKey: 'wechat:p1@chatroom', title: 'Project A' },
      ],
    };

    const brokenProvider: TargetDirectoryProvider = {
      id: 'broken',
      source: 'dingtalk',
      resolveTarget: () => {
        throw new Error('provider down');
      },
      listTargets: () => {
        throw new Error('provider down');
      },
    };

    const offWx = service.registerTargetDirectory(wxProvider);
    const offBroken = service.registerTargetDirectory(brokenProvider);

    const matched = await service.resolveTarget({ targetName: 'Core Team' });
    assert.equal(matched.status, 'matched');
    assert.equal(matched.target?.roomKey, 'wechat:12345@chatroom');

    const ambiguous = await service.resolveTarget({ targetName: 'Project' });
    assert.equal(ambiguous.status, 'ambiguous');
    assert.equal(ambiguous.candidates?.length, 2);

    const limited = await service.listTargets({ source: 'wechat', limit: 1 });
    assert.equal(limited.length, 1);

    let receivedAdminMsg: AdminWechatMessage | null = null;
    service.registerAdminWechatHandler((msg) => {
      receivedAdminMsg = msg;
      return { handled: true, replyText: 'ok' };
    });

    const extendedMsg: AdminWechatMessage = {
      session: 'filehelper',
      senderId: 'wxid_owner',
      text: '看看语音和图片',
      sourceKey: 'wxarc:filehelper:101',
      localType: 3,
      imagePath: '/tmp/sample.png',
      voiceTranscript: '帮我查下昨天会议纪要',
      articleSummary: '技术周报摘要',
      mediaPaths: ['/tmp/sample.png', '/tmp/clip.mp4'],
    };
    const adminRes = await service.dispatchAdminWechatMessage(extendedMsg);
    assert.equal(adminRes.handled, true);
    assert.deepEqual(receivedAdminMsg, extendedMsg);

    offWx();
    offBroken();
    assert.deepEqual(await service.resolveTarget({ targetName: 'Core Team' }), { status: 'not_found' });
  } finally {
    db.close();
  }
});

test('onThreadLifecycle fires for terminal events and lifecycleOnly suppresses Fast Path Worker & onUnclaimedEvent', async () => {
  const db = openHubDb({ inMemory: true });
  try {
    const guard = createDoorGuard();
    const sent: Array<{ sessionId: string; message: unknown }> = [];
    const agents = new Map<string, DshAgent>();
    agents.set('sess-pr-worker', {
      id: 'sess-pr-worker',
      session: { id: 'sess-pr-worker' },
      state: { running: false },
      followup: (msg) => {
        sent.push({ sessionId: 'sess-pr-worker', message: msg });
      },
      whenIdle: async () => {},
    });
    const bridgeCtx: SessionBridgeContext = {
      sessionController: {
        resolveAgent: async (id) => {
          const agent = agents.get(id);
          return agent ? { agent } : { error: { code: 'session/not-found' } };
        },
      },
    };
    const bridge = createSessionBridge(bridgeCtx, db, null);
    const service = createHubService(undefined, { db, guard, sessionBridge: bridge });

    service.registerSubscription({
      source: 'github',
      threadKey: 'github:org/repo#99',
      sessionId: 'sess-pr-worker',
      owner: 'router',
    });

    let unclaimedCalls = 0;
    service.onUnclaimedEvent(() => {
      unclaimedCalls += 1;
      return { handled: true };
    });

    const lifecycleEvents: ThreadLifecycleEvent[] = [];
    const offLifecycle = service.onThreadLifecycle((ev) => {
      lifecycleEvents.push(ev);
    });

    const pureClose = await service.ingest(
      makeEvent({
        id: 'evt-lifecycle-only-1',
        type: 'github.pr.merged',
        threadKey: 'github:org/repo#99',
        payload: { merged: true, lifecycleOnly: true },
      }),
    );
    await new Promise((r) => setImmediate(r));
    assert.equal(pureClose.accepted, true);
    assert.equal(pureClose.routedVia, 'lifecycle');
    assert.equal(sent.length, 0);
    assert.equal(unclaimedCalls, 0);
    assert.equal(lifecycleEvents.length, 1);
    assert.equal(lifecycleEvents[0]?.state, 'merged');
    assert.equal(lifecycleEvents[0]?.lifecycleOnly, true);
    assert.equal(lifecycleEvents[0]?.subscription?.sessionId, 'sess-pr-worker');

    const pureUnclaimedClose = await service.ingest(
      makeEvent({
        id: 'evt-lifecycle-only-2',
        type: 'github.issue.updated',
        threadKey: 'github:org/repo#100',
        payload: { state: 'closed', lifecycleOnly: true },
      }),
    );
    assert.equal(pureUnclaimedClose.accepted, true);
    assert.equal(pureUnclaimedClose.routedVia, 'lifecycle');
    assert.equal(unclaimedCalls, 0);
    assert.equal(lifecycleEvents.length, 2);
    assert.equal(lifecycleEvents[1]?.state, 'closed');
    assert.equal(lifecycleEvents[1]?.subscription, null);

    const normalClose = await service.ingest(
      makeEvent({
        id: 'evt-normal-closed-3',
        type: 'github.pr.closed',
        threadKey: 'github:org/repo#99',
        payload: { state: 'closed', body: 'Closing with note' },
      }),
    );
    await new Promise((r) => setImmediate(r));
    assert.equal(normalClose.accepted, true);
    assert.equal(normalClose.routedVia, 'subscription');
    assert.equal(sent.length, 1);
    assert.equal(lifecycleEvents.length, 3);
    assert.equal(lifecycleEvents[2]?.state, 'closed');
    assert.equal(lifecycleEvents[2]?.lifecycleOnly, false);

    offLifecycle();
  } finally {
    db.close();
  }
});
