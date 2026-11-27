import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  NormalizedEvent,
  PersonaWardrobe,
  ThreadLifecycleEvent,
} from '@local/dsh-hub/contracts';
import {
  createDoorGuard,
  createHubService,
  openHubDb,
  PUBLIC_TAINT_WARNING_TEXT,
  VAULT_SNIPPET_MAX_LENGTH,
} from '@local/dsh-hub';
import {
  apply,
  appendSelfTriggerMarker,
  createGitHubSink,
  createGitHubVaultProvider,
  GitHubPoller,
  normalizeConfig,
  registerGitHubStageTools,
  resolveGitHubOutboundTargetCircle,
  resolveGitHubRepoVaultVisibility,
} from '../src/index.js';
import type { GitHubAuthToken } from '../src/auth.js';
import type { FetchResponseLike, ToolDefinition } from '../src/sink.js';

function makeResponse(
  status: number,
  body: unknown,
  headersObj: Record<string, string> = {},
): FetchResponseLike {
  const map = new Map(Object.entries(headersObj).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name: string) => map.get(String(name).toLowerCase()) ?? null,
    },
    async json() {
      return body;
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body ?? '');
    },
  };
}

test('poller + hub: bot/self PR and issue open->closed emit lifecycleOnly terminal events without waking workers, while human PR emits normal update', async () => {
  const db = openHubDb({ inMemory: true });
  try {
    const guard = createDoorGuard();
    const hub = createHubService(undefined, { db, guard });
    const repo = 'acme/demo-repo';
    const config = normalizeConfig({
      ownerLogins: ['alice-owner'],
      botLogin: 'acme-bot[bot]',
      enableNotifications: false,
      repoMap: { [repo]: { localPath: '/tmp/acme-demo' } },
    });

    const credentials = {
      readSlot: async (): Promise<GitHubAuthToken> => ({
        token: 'tok_read',
        slot: 'read',
        source: 'credentials',
        isBot: false,
        login: 'alice-owner',
      }),
      clearCache: () => {},
    };

    const lifecycleEvents: ThreadLifecycleEvent[] = [];
    const unclaimedEvents: NormalizedEvent[] = [];
    hub.onThreadLifecycle((ev) => {
      lifecycleEvents.push(ev);
    });
    hub.onUnclaimedEvent((ev) => {
      unclaimedEvents.push(ev);
      return { handled: true };
    });

    hub.registerSubscription({
      source: 'github',
      threadKey: `github:${repo}#101`,
      sessionId: 'worker_pr_101',
      owner: 'router',
    });

    let round = 1;
    const mockFetch = async (url: string): Promise<FetchResponseLike> => {
      if (url.includes(`/repos/${repo}/issues?`)) {
        if (round === 1) {
          return makeResponse(
            200,
            [
              {
                id: 1010,
                number: 101,
                title: 'Bot PR to be merged',
                state: 'open',
                comments: 0,
                pull_request: {
                  url: `https://api.github.com/repos/${repo}/pulls/101`,
                  merged_at: null,
                },
                user: { id: 900, login: 'acme-bot[bot]', type: 'Bot' },
                body: 'Automated fix.\n\nFixes #50',
                labels: ['automation'],
                updated_at: '2026-11-27T10:00:00Z',
                html_url: `https://github.com/${repo}/pull/101`,
              },
              {
                id: 1020,
                number: 102,
                title: 'Self-marker issue to be closed',
                state: 'open',
                comments: 0,
                user: { id: 1, login: 'alice-owner', type: 'User' },
                body: appendSelfTriggerMarker('Self opened tracking issue', 'self-102'),
                labels: [],
                updated_at: '2026-11-27T10:05:00Z',
                html_url: `https://github.com/${repo}/issues/102`,
              },
              {
                id: 1030,
                number: 103,
                title: 'Contributor PR to be merged',
                state: 'open',
                comments: 0,
                pull_request: {
                  url: `https://api.github.com/repos/${repo}/pulls/103`,
                  merged_at: null,
                },
                user: { id: 22, login: 'bob-contrib', type: 'User' },
                body: 'Contributor patch',
                labels: [],
                updated_at: '2026-11-27T10:10:00Z',
                html_url: `https://github.com/${repo}/pull/103`,
              },
            ],
            { etag: '"etag-r1"' },
          );
        }
        return makeResponse(
          200,
          [
            {
              id: 1010,
              number: 101,
              title: 'Bot PR to be merged',
              state: 'closed',
              comments: 0,
              pull_request: {
                url: `https://api.github.com/repos/${repo}/pulls/101`,
                merged_at: '2026-11-27T11:00:00Z',
              },
              user: { id: 900, login: 'acme-bot[bot]', type: 'Bot' },
              body: 'Automated fix.\n\nFixes #50',
              labels: ['automation'],
              updated_at: '2026-11-27T11:00:00Z',
              html_url: `https://github.com/${repo}/pull/101`,
            },
            {
              id: 1020,
              number: 102,
              title: 'Self-marker issue to be closed',
              state: 'closed',
              comments: 0,
              user: { id: 1, login: 'alice-owner', type: 'User' },
              body: appendSelfTriggerMarker('Self opened tracking issue', 'self-102'),
              labels: [],
              updated_at: '2026-11-27T11:05:00Z',
              html_url: `https://github.com/${repo}/issues/102`,
            },
            {
              id: 1030,
              number: 103,
              title: 'Contributor PR to be merged',
              state: 'closed',
              comments: 0,
              pull_request: {
                url: `https://api.github.com/repos/${repo}/pulls/103`,
                merged_at: '2026-11-27T11:10:00Z',
              },
              user: { id: 22, login: 'bob-contrib', type: 'User' },
              body: 'Contributor patch',
              labels: [],
              updated_at: '2026-11-27T11:10:00Z',
              html_url: `https://github.com/${repo}/pull/103`,
            },
          ],
          { etag: '"etag-r2"' },
        );
      }
      if (url.includes('/reviews') || url.includes('/comments')) {
        return makeResponse(200, []);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const emitted: NormalizedEvent[] = [];
    const ingestResults: Array<{ event: NormalizedEvent; routedVia?: string }> = [];
    const poller = new GitHubPoller({
      config,
      credentials,
      db,
      fetchImpl: mockFetch,
      onEvent: async (ev) => {
        emitted.push(ev);
        const res = await hub.ingest(ev);
        ingestResults.push({ event: ev, routedVia: res.routedVia });
      },
    });

    await poller.pollOnce();
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].entityKey, `github:${repo}#103`);

    emitted.length = 0;
    ingestResults.length = 0;
    lifecycleEvents.length = 0;
    unclaimedEvents.length = 0;
    round = 2;

    await poller.pollOnce();

    const botPrEvent = emitted.find((e) => e.entityKey === `github:${repo}#101`);
    assert.ok(botPrEvent);
    assert.equal(botPrEvent.type, 'github.pr.merged');
    assert.equal(botPrEvent.payload.state, 'closed');
    assert.equal(botPrEvent.payload.merged, true);
    assert.equal(botPrEvent.payload.lifecycleOnly, true);
    assert.deepEqual(botPrEvent.payload.linkedIssues, [50]);

    const botIngest = ingestResults.find((r) => r.event.entityKey === `github:${repo}#101`);
    assert.equal(botIngest?.routedVia, 'lifecycle');

    const selfIssueEvent = emitted.find((e) => e.entityKey === `github:${repo}#102`);
    assert.ok(selfIssueEvent);
    assert.equal(selfIssueEvent.type, 'github.issue.closed');
    assert.equal(selfIssueEvent.payload.state, 'closed');
    assert.equal(selfIssueEvent.payload.merged, undefined);
    assert.equal(selfIssueEvent.payload.lifecycleOnly, true);

    const selfIngest = ingestResults.find((r) => r.event.entityKey === `github:${repo}#102`);
    assert.equal(selfIngest?.routedVia, 'lifecycle');

    const humanPrEvent = emitted.find((e) => e.entityKey === `github:${repo}#103`);
    assert.ok(humanPrEvent);
    assert.equal(humanPrEvent.type, 'github.pr.updated');
    assert.equal(humanPrEvent.payload.state, 'closed');
    assert.equal(humanPrEvent.payload.merged, true);
    assert.equal(humanPrEvent.payload.lifecycleOnly, undefined);

    assert.equal(unclaimedEvents.length, 1);
    assert.equal(unclaimedEvents[0].entityKey, `github:${repo}#103`);

    const lc101 = lifecycleEvents.find((l) => l.threadKey === `github:${repo}#101`);
    assert.ok(lc101);
    assert.equal(lc101.state, 'merged');
    assert.equal(lc101.lifecycleOnly, true);
    assert.equal(lc101.subscription?.sessionId, 'worker_pr_101');

    const lc102 = lifecycleEvents.find((l) => l.threadKey === `github:${repo}#102`);
    assert.ok(lc102);
    assert.equal(lc102.state, 'closed');
    assert.equal(lc102.lifecycleOnly, true);

    const lc103 = lifecycleEvents.find((l) => l.threadKey === `github:${repo}#103`);
    assert.ok(lc103);
    assert.equal(lc103.state, 'merged');
    assert.equal(lc103.lifecycleOnly, false);
  } finally {
    db.close();
  }
});

test('vault-provider: searches source_cursors snapshots and Hub inbox events with visibility circles, filters, truncation, and context', async () => {
  const db = openHubDb({ inMemory: true });
  try {
    const guard = createDoorGuard();
    const wardrobeStub = {
      resolveChatCircle(roomKey: string) {
        if (roomKey === 'github:acme/labeled-family') {
          return { chatId: roomKey, circle: 'family', label: 'Family Repo', updatedAt: 1, labeled: true };
        }
        return { chatId: roomKey, circle: 'external', label: '', updatedAt: 0, labeled: false };
      },
      resolveVaultVisibility(roomKey: string) {
        if (roomKey === 'github:acme/labeled-family') return 'family' as const;
        return 'owner_private' as const;
      },
    } as unknown as PersonaWardrobe;

    const hub = createHubService(undefined, { db, guard, wardrobe: wardrobeStub });

    const instance = apply(
      { hub, watcher: hub },
      {
        enableNotifications: false,
        repoMap: {
          'acme/public-oss': { localPath: '/tmp/pub', private: false },
          'acme/internal-core': { localPath: '/tmp/priv', sensitive: true },
          'acme/unknown-repo': { localPath: '/tmp/unk' },
          'acme/labeled-family': { localPath: '/tmp/fam', private: false },
        },
      },
    );

    try {
      const providers = hub.vault.listProviders();
      assert.ok(providers.some((p) => p.id === 'github' && p.label === 'GitHub Issues & PRs' && p.supportsContext));

      const now = '2026-11-27T12:00:00Z';
      const longBody = 'Release checklist item: '.repeat(25);
      const insertCursor = db.db.prepare(
        `INSERT INTO source_cursors (source_id, cursor_key, cursor_value, config_rev, updated_at)
         VALUES ('github', ?, ?, 1, ?)`,
      );
      insertCursor.run(
        'state:repo_issues:acme/public-oss',
        JSON.stringify({
          lastMaxUpdatedAt: '2026-11-26T10:00:00Z',
          items: {
            '12': {
              updatedAt: '2026-11-26T10:00:00Z',
              title: 'Public roadmap release sync',
              state: 'open',
              draft: false,
              labels: ['release', 'public'],
              bodyHash: 'h1',
              commentsCount: 2,
              isPr: false,
              author: 'alice',
              url: 'https://github.com/acme/public-oss/issues/12',
              bodySnippet: longBody,
            },
          },
        }),
        now,
      );
      insertCursor.run(
        'state:repo_issues:acme/internal-core',
        JSON.stringify({
          lastMaxUpdatedAt: '2026-11-26T11:00:00Z',
          items: {
            '88': {
              updatedAt: '2026-11-26T11:00:00Z',
              title: 'Internal roadmap architecture memo',
              state: 'open',
              draft: false,
              labels: ['internal'],
              bodyHash: 'h2',
              commentsCount: 1,
              isPr: true,
              author: 'bob',
            },
          },
        }),
        now,
      );
      insertCursor.run(
        'state:repo_issues:acme/unknown-repo',
        JSON.stringify({
          lastMaxUpdatedAt: '2026-11-26T12:00:00Z',
          items: {
            '99': {
              updatedAt: '2026-11-26T12:00:00Z',
              title: 'Unknown repo roadmap draft',
              state: 'open',
              draft: true,
              labels: [],
              bodyHash: 'h3',
              commentsCount: 0,
              author: 'carol',
            },
          },
        }),
        now,
      );
      insertCursor.run(
        'state:repo_issues:acme/labeled-family',
        JSON.stringify({
          lastMaxUpdatedAt: '2026-11-26T13:00:00Z',
          items: {
            '7': {
              updatedAt: '2026-11-26T13:00:00Z',
              title: 'Family roadmap photo album',
              state: 'open',
              draft: false,
              labels: [],
              bodyHash: 'h4',
              commentsCount: 0,
              author: 'dana',
            },
          },
        }),
        now,
      );

      await hub.ingest({
        id: 'ev-pub-comment-1',
        source: 'github',
        type: 'github.issue.comment',
        dedupeKey: 'dk-pub-1',
        threadKey: 'github:acme/public-oss#12',
        entityKey: 'github:acme/public-oss#12',
        actor: { id: 'u-alice', login: 'alice', isBot: false },
        trustLevel: 'untrusted',
        occurredAt: '2026-11-26T10:30:00Z',
        summary: 'alice confirmed roadmap milestone v2',
        payload: {
          repo: 'acme/public-oss',
          number: 12,
          title: 'Public roadmap release sync',
          body: 'Confirmed roadmap milestone v2 details.',
        },
        rawRef: { repo: 'acme/public-oss', number: 12, url: 'https://github.com/acme/public-oss/issues/12#c1' },
      });

      await hub.ingest({
        id: 'ev-pub-comment-2',
        source: 'github',
        type: 'github.issue.comment',
        dedupeKey: 'dk-pub-2',
        threadKey: 'github:acme/public-oss#12',
        entityKey: 'github:acme/public-oss#12',
        actor: { id: 'u-dave', login: 'dave', isBot: false },
        trustLevel: 'untrusted',
        occurredAt: '2026-11-27T09:00:00Z',
        summary: 'dave reviewed roadmap checklist',
        payload: {
          repo: 'acme/public-oss',
          number: 12,
          body: 'Checked all public release notes.',
        },
        rawRef: { repo: 'acme/public-oss', number: 12 },
      });

      hub.registerSessionPrincipal({
        sessionId: 'sess_tier1',
        role: 'external_chat',
        tier: 1,
        trustLevel: 'untrusted',
      });
      hub.registerSessionPrincipal({
        sessionId: 'sess_tier2',
        role: 'worker',
        tier: 2,
        trustLevel: 'triage',
        boundRepo: 'acme/internal-core',
      });
      hub.registerSessionPrincipal({
        sessionId: 'sess_tier3',
        role: 'owner_session',
        tier: 3,
        trustLevel: 'owner',
      });

      const resTier1 = await hub.vault.search(
        { query: 'roadmap', sources: ['github'] },
        { agent: { id: 'sess_tier1' } },
      );
      assert.equal(resTier1.tainted, false);
      assert.ok(resTier1.hits.length >= 2);
      assert.ok(resTier1.hits.every((h) => h.circle === 'external' && h.roomName === 'acme/public-oss'));
      assert.ok(resTier1.hits.every((h) => h.snippet.length <= VAULT_SNIPPET_MAX_LENGTH));

      const resTier2 = await hub.vault.search(
        { query: 'roadmap', sources: ['github'] },
        { agent: { id: 'sess_tier2' } },
      );
      assert.equal(resTier2.tainted, true);
      assert.ok(resTier2.hits.some((h) => h.itemId === 'github:acme/internal-core#88' && h.circle === 'work'));
      assert.ok(resTier2.hits.some((h) => h.itemId === 'github:acme/unknown-repo#99' && h.circle === 'work'));
      assert.equal(resTier2.hits.some((h) => h.roomName === 'acme/labeled-family'), false);

      const resTier3 = await hub.vault.search(
        { query: 'roadmap', sources: ['github'] },
        { agent: { id: 'sess_tier3' } },
      );
      assert.ok(resTier3.hits.some((h) => h.itemId === 'github:acme/labeled-family#7' && h.circle === 'family'));

      const filteredPerson = await hub.vault.search(
        {
          query: 'roadmap',
          sources: ['github'],
          person: 'dave',
          since: '2026-11-27T00:00:00Z',
          until: '2026-11-27T23:59:59Z',
          limit: 1,
        },
        { agent: { id: 'sess_tier3' } },
      );
      assert.equal(filteredPerson.hits.length, 1);
      assert.equal(filteredPerson.hits[0].itemId, 'event:ev-pub-comment-2');

      const ctxAllowed = await hub.vault.context(
        'github',
        'event:ev-pub-comment-1',
        { before: 1, after: 1 },
        { agent: { id: 'sess_tier1' } },
      );
      assert.ok(ctxAllowed.result);
      assert.equal(ctxAllowed.result.circle, 'external');
      assert.equal(ctxAllowed.result.items.length, 3);
      assert.equal(ctxAllowed.result.items[0].itemId, 'github:acme/public-oss#12');
      assert.equal(ctxAllowed.result.items[1].itemId, 'event:ev-pub-comment-1');
      assert.equal(ctxAllowed.result.items[1].isTarget, true);
      assert.equal(ctxAllowed.result.items[2].itemId, 'event:ev-pub-comment-2');

      const ctxDenied = await hub.vault.context(
        'github',
        'github:acme/internal-core#88',
        { before: 2, after: 2 },
        { agent: { id: 'sess_tier1' } },
      );
      assert.equal(ctxDenied.result, null);

      assert.equal(
        resolveGitHubRepoVaultVisibility('acme/override', {
          config: { repoMap: { 'acme/override': { private: false } } },
          getWardrobe: () =>
            ({
              resolveVaultVisibility: () => 'owner_private',
            }) as unknown as PersonaWardrobe,
        }),
        'owner_private',
      );
      assert.equal(
        resolveGitHubOutboundTargetCircle('acme/internal-core', {
          config: { repoMap: { 'acme/internal-core': { sensitive: true } } },
        }),
        'work',
      );
      assert.equal(
        resolveGitHubOutboundTargetCircle('acme/public-oss', {
          config: { repoMap: { 'acme/public-oss': { private: false } } },
        }),
        'external',
      );

      const standaloneProvider = createGitHubVaultProvider({
        db,
        getConfig: () => instance.config,
        getWardrobe: () => wardrobeStub,
      });
      const directHits = await standaloneProvider.search(
        { query: 'roadmap' },
        {
          allowedCircles: ['external'],
          tier: 1,
          sessionId: 's1',
          rootSessionId: 's1',
          role: 'external_chat',
        },
      );
      assert.ok(directHits.every((h) => h.circle === 'external'));
    } finally {
      instance.dispose();
    }
  } finally {
    db.close();
  }
});

test('sink & stage tools: principal role/boundRepo enforcement, sticky taint forced staging + public warning, and approved publish without leaking warning', async () => {
  const db = openHubDb({ inMemory: true });
  try {
    const guard = createDoorGuard();
    const hub = createHubService(undefined, { db, guard });
    const config = normalizeConfig({
      ownerLogins: ['alice-owner'],
      autoSendOwners: ['acme'],
      repoMap: {
        'acme/public-app': { localPath: '/tmp/pub', private: false, autoSend: true },
        'acme/private-app': { localPath: '/tmp/priv', private: true, autoSend: true },
      },
    });

    const apiCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const sink = createGitHubSink({
      config,
      db,
      credentials: {
        readSlot: async () => ({
          token: 'ghs_bot_token',
          slot: 'act',
          source: 'credentials',
          isBot: true,
          login: 'acme-bot[bot]',
        }),
        clearCache: () => {},
      },
      fetchImpl: async (url: string, opts?: RequestInit) => {
        apiCalls.push({
          url,
          body: JSON.parse(String(opts?.body || '{}')) as Record<string, unknown>,
        });
        return makeResponse(201, {
          id: 5000 + apiCalls.length,
          html_url: `${url}#ok-${apiCalls.length}`,
        });
      },
    });
    hub.registerSink(sink);

    const registeredTools = new Map<string, ToolDefinition>();
    registerGitHubStageTools(
      {
        hub,
        tools: {
          register: (def) => {
            registeredTools.set(def.name, def);
            return () => registeredTools.delete(def.name);
          },
        },
      },
      { config, sinkId: sink.id },
    );

    const replyTool = registeredTools.get('gh_stage_reply')!;
    const reviewTool = registeredTools.get('gh_stage_review')!;
    assert.ok(replyTool && reviewTool);

    hub.registerSessionPrincipal({
      sessionId: 'sess_owner',
      role: 'owner_session',
      tier: 3,
      trustLevel: 'owner',
    });
    hub.registerSessionPrincipal({
      sessionId: 'sess_worker_pub',
      role: 'worker',
      tier: 2,
      trustLevel: 'triage',
      boundRepo: 'acme/public-app',
    });
    hub.registerSessionPrincipal({
      sessionId: 'sess_external',
      role: 'external_chat',
      tier: 1,
      trustLevel: 'untrusted',
    });

    await assert.rejects(
      () =>
        replyTool.execute(
          { repo: 'acme/public-app', number: 1, body: 'nope' },
          { agent: { id: 'sess_external' } },
        ),
      /external_chat.*not permitted/i,
    );

    await assert.rejects(
      () =>
        replyTool.execute(
          { repo: 'acme/private-app', number: 2, body: 'cross-repo' },
          { agent: { id: 'sess_worker_pub' } },
        ),
      /bound to "acme\/public-app"/,
    );

    await assert.rejects(
      () =>
        reviewTool.execute(
          { repo: 'acme/public-app', number: 3, body: 'subagent review' },
          {
            agent: {
              id: 'sess_sub',
              session: {
                header: {
                  delegationDepth: 1,
                  origin: 'subagent',
                  parentSessionId: 'sess_owner',
                },
              },
            },
          },
        ),
      /Subagents are not permitted/,
    );

    const cleanWorkerRes = await replyTool.execute(
      { repo: 'acme/public-app', number: 10, body: 'Clean worker reply' },
      { agent: { id: 'sess_worker_pub' } },
    );
    assert.equal(cleanWorkerRes.status, 'executed');
    assert.equal(apiCalls.length, 1);

    hub.markSessionTainted('sess_worker_pub', 'vault_read_work');
    const taintedPubRes = await replyTool.execute(
      { repo: 'acme/public-app', number: 10, body: 'Draft after reading internal vault' },
      { agent: { id: 'sess_worker_pub' } },
    );
    assert.equal(taintedPubRes.status, 'staged');
    assert.equal(taintedPubRes.stageOnlyForced, true);
    assert.equal(taintedPubRes.publicTaintWarning, true);
    assert.equal(taintedPubRes.warningText, PUBLIC_TAINT_WARNING_TEXT);
    assert.equal(apiCalls.length, 1);

    const pubDrafts = hub.listDrafts({ status: 'pending_approval' });
    const pubDraft = pubDrafts.find((d) => d.id === taintedPubRes.draftId);
    assert.ok(pubDraft);
    assert.ok(pubDraft.previewText.includes(PUBLIC_TAINT_WARNING_TEXT));
    assert.equal(pubDraft.payload.publicTaintWarning, true);
    assert.equal(pubDraft.payload.taintWarning, PUBLIC_TAINT_WARNING_TEXT);

    const approvedRes = await hub.approveDraft(pubDraft.id);
    assert.equal(approvedRes.status, 'executed');
    assert.equal(apiCalls.length, 2);
    assert.equal(String(apiCalls[1].body.body).includes(PUBLIC_TAINT_WARNING_TEXT), false);
    assert.ok(String(apiCalls[1].body.body).includes('Draft after reading internal vault'));

    hub.markSessionTainted('sess_owner', 'vault_read_owner_private');
    const taintedPrivRes = await reviewTool.execute(
      { repo: 'acme/private-app', number: 20, body: 'Internal review', event: 'COMMENT' },
      { agent: { id: 'sess_owner' } },
    );
    assert.equal(taintedPrivRes.status, 'staged');
    assert.equal(taintedPrivRes.stageOnlyForced, true);
    assert.equal(taintedPrivRes.publicTaintWarning, undefined);
    assert.equal(apiCalls.length, 2);

    const directGuard = createDoorGuard({
      isSessionTainted: (sid) => sid === 'sess_direct_tainted',
    });
    const directSink = createGitHubSink({
      config,
      db,
      guard: directGuard,
      credentials: {
        readSlot: async () => ({
          token: 'ghs_bot_token',
          slot: 'act',
          source: 'credentials',
          isBot: true,
          login: 'acme-bot[bot]',
        }),
        clearCache: () => {},
      },
      fetchImpl: async () => {
        throw new Error('should not post when DoorGuard forces stageOnly');
      },
    });
    const directRes = await directSink.invoke({
      action: 'issue_comment',
      target: { repo: 'acme/public-app', number: 30 },
      payload: { body: 'Direct sink call from tainted session' },
      idempotencyKey: 'direct-taint-30',
      sessionId: 'sess_direct_tainted',
      targetCircle: 'external',
    });
    assert.equal(directRes.status, 'staged');
    assert.ok(directRes.draftId);
    assert.equal(directRes.stageOnlyForced, true);
    assert.equal(directRes.publicTaintWarning, true);
    assert.equal(directRes.warningText, PUBLIC_TAINT_WARNING_TEXT);
    const directDraft = db.db
      .prepare('SELECT preview_text, payload_json FROM staged_drafts WHERE id = ?')
      .get(directRes.draftId) as { preview_text: string; payload_json: string };
    assert.ok(directDraft.preview_text.includes(PUBLIC_TAINT_WARNING_TEXT));
    const parsedPayload = JSON.parse(directDraft.payload_json) as Record<string, unknown>;
    assert.equal(parsedPayload.publicTaintWarning, true);
    assert.equal(parsedPayload.taintWarning, PUBLIC_TAINT_WARNING_TEXT);
  } finally {
    db.close();
  }
});
