import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  GitHubAdminAdapter,
  GitHubAdminConfigView,
  InboxItem,
  PersonaConfig,
  PersonaKind,
  PersonaMemoryRecord,
  PersonaRecord,
  PersonaWardrobe,
  StagedDraft,
  WorkstreamRecord,
} from '../src/contracts.js';
import { openWatcherDb } from '../src/db.js';
import { createDoorGuard } from '../src/guard.js';
import {
  checkLocalOwnerRequest,
  createWatcherHttpHandler,
  mountHttpRoutes,
  type WatcherHttpTarget,
} from '../src/http-routes.js';

const LOOPBACK_ORIGIN_PREFIX = 'http://127.0.0.1:';

function createMemoryWardrobe(): PersonaWardrobe {
  const personas = new Map<string, PersonaRecord>();
  const memories = new Map<string, PersonaMemoryRecord[]>();
  let nextMemId = 1;

  const seed: PersonaRecord = {
    id: 'double',
    kind: 'double',
    name: '我的分身',
    definition: '克制直接',
    learning: true,
    work: '',
    character: '',
    style: '简短直接',
    styleMeta: {},
    revision: 1,
    memoryCount: 1,
  };
  personas.set(seed.id, seed);
  memories.set(seed.id, [
    {
      id: nextMemId++,
      personaId: 'double',
      scope: 'text:room1',
      eventSeq: 1,
      note: '少用感叹号',
      quote: '别太浮夸',
      at: Date.now(),
      sourceKey: 's1',
      category: '聊天偏好',
      metadata: {},
    },
  ]);

  return {
    list: () => Array.from(personas.values()),
    get: (id: string) => {
      const found = personas.get(id);
      if (!found) throw new Error(`Persona not found: ${id}`);
      return found;
    },
    create: (kind: PersonaKind) => {
      const id = `${kind}-${personas.size + 1}`;
      const record: PersonaRecord = {
        id,
        kind,
        name: kind === 'fiction' ? '新角色' : '新人物',
        definition: '',
        learning: true,
        work: '',
        character: '',
        style: '',
        styleMeta: {},
        revision: 1,
        memoryCount: 0,
      };
      personas.set(id, record);
      memories.set(id, []);
      return record;
    },
    save: (value: PersonaConfig, revision: number) => {
      const cur = personas.get(value.id);
      if (!cur) throw new Error(`Persona not found: ${value.id}`);
      if (cur.revision !== revision) throw new Error('revision conflict');
      const next: PersonaRecord = {
        ...cur,
        ...value,
        style: value.style ?? cur.style,
        revision: cur.revision + 1,
      };
      personas.set(value.id, next);
      return next;
    },
    delete: (id: string) => personas.delete(id),
    getDynamicCard: () => null,
    recordTurnPreference: () => ({ recorded: 0 }),
    listMemories: (id: string, filter?: { scope?: string; limit?: number }) => {
      const list = memories.get(id) ?? [];
      const filtered = filter?.scope ? list.filter((m) => m.scope === filter.scope) : list;
      return filter?.limit ? filtered.slice(0, filter.limit) : filtered;
    },
    editMemory: (id: string, memoryId: number, note: string) => {
      const list = memories.get(id) ?? [];
      const hit = list.find((m) => m.id === memoryId);
      if (!hit) throw new Error('memory not found');
      hit.note = note;
    },
    clearMemories: (id: string, scope?: string) => {
      const list = memories.get(id) ?? [];
      const remaining = scope ? list.filter((m) => m.scope !== scope) : [];
      const deleted = list.length - remaining.length;
      memories.set(id, remaining);
      const cur = personas.get(id);
      if (cur) cur.memoryCount = remaining.length;
      return { deleted };
    },
    learnStyleFromSamples: async (id: string, revision: number) => {
      const cur = personas.get(id);
      if (!cur) throw new Error(`Persona not found: ${id}`);
      if (cur.revision !== revision) throw new Error('revision conflict');
      const next: PersonaRecord = { ...cur, style: '已从样本提炼的短句风格', revision: cur.revision + 1 };
      personas.set(id, next);
      return next;
    },
    previewChat: async (input) => ({
      reply: `[${input.personaId}] 收到：${input.message}`,
      personaId: input.personaId,
      dryRun: true,
      memoryMutated: false,
    }),
    importFromWxarcSqlite: (sourcePath: string) => ({
      personasImported: 0,
      memoriesImported: 0,
      sourcePath,
    }),
  };
}

function createStubWatcher() {
  const db = openWatcherDb({ inMemory: true });
  const guard = createDoorGuard();
  const wardrobe = createMemoryWardrobe();
  const now = new Date().toISOString();

  const inboxItems: InboxItem[] = [
    {
      id: 'ib-1',
      eventId: 'ev-1',
      source: 'github',
      type: 'issue_comment',
      entityKey: 'gh:example-owner/demo#1',
      workstreamId: 'ws-1',
      sessionId: 'sess-1',
      actor: 'alice',
      summary: 'Issue #1 has a new comment',
      tier: 'triage',
      preGateTags: ['external'],
      status: 'unread',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'ib-2',
      eventId: 'ev-2',
      source: 'wechat',
      type: 'text',
      entityKey: 'wx:room1',
      workstreamId: null,
      sessionId: 'sess-2',
      actor: 'bob',
      summary: '周五演示准备好了吗',
      tier: 'inbox-only',
      preGateTags: [],
      status: 'unread',
      createdAt: now,
      updatedAt: now,
    },
  ];

  const workstreams: WorkstreamRecord[] = [
    {
      id: 'ws-1',
      source: 'github',
      workstreamKey: 'gh:example-owner/demo#1',
      primaryEntityKey: 'gh:example-owner/demo#1',
      entityKeys: ['gh:example-owner/demo#1'],
      workspacePath: '/tmp/demo',
      sessionId: 'sess-1',
      supersededBy: null,
      status: 'active',
      mode: 'repeat',
      trustMode: 'triage',
      deliveryCount: 1,
      maxWakeups: 5,
      ttlExpiresAt: now,
      lastWakeupAt: now,
      configRevision: 1,
      createdAt: now,
      updatedAt: now,
    },
  ];

  const drafts: StagedDraft[] = [
    {
      id: 'dr-1',
      sinkId: 'github.comment',
      action: 'comment',
      workstreamId: 'ws-1',
      sessionId: 'sess-1',
      target: { repo: 'example-owner/demo', number: 1 },
      payload: { body: 'Looks good' },
      previewText: 'Looks good',
      idempotencyKey: 'idem-1',
      status: 'pending_approval',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'dr-2',
      sinkId: 'wechat.send',
      action: 'send',
      workstreamId: null,
      sessionId: 'sess-2',
      target: { chatId: 'room1' },
      payload: { text: '收到' },
      previewText: '收到',
      idempotencyKey: 'idem-2',
      status: 'uncertain',
      createdAt: now,
      updatedAt: now,
    },
  ];

  const polledSources: string[] = [];
  const connectors = new Map<string, { id: string; label: string; kind: string; panelId?: string; panelLabel?: string }>();
  const subscriptions = new Map<
    string,
    {
      id: string;
      source: string;
      threadKey: string;
      workstreamId: string | null;
      sessionId: string;
      personaId: string | null;
      owner: string;
      status: string;
      metadata: Record<string, unknown>;
      createdAt: string;
      updatedAt: string;
    }
  >();

  const watcher: WatcherHttpTarget = {
    configRevision: 1,
    wardrobe,
    getWardrobe: () => wardrobe,
    guard,
    db,
    registerConnector: (desc) => {
      connectors.set(desc.id, desc);
      return () => connectors.delete(desc.id);
    },
    listConnectors: () => [...connectors.values()],
    registerSubscription: (input) => {
      const key = `${input.source}::${input.threadKey}`;
      const sub = {
        id: `sub-${subscriptions.size + 1}`,
        source: input.source,
        threadKey: input.threadKey,
        workstreamId: input.workstreamId ?? null,
        sessionId: input.sessionId,
        personaId: input.personaId ?? null,
        owner: input.owner ?? 'manual',
        status: input.status ?? 'active',
        metadata: input.metadata ?? {},
        createdAt: now,
        updatedAt: now,
      };
      subscriptions.set(key, sub);
      return sub;
    },
    resolveSubscription: (source, threadKey) => subscriptions.get(`${source}::${threadKey}`) ?? null,
    removeSubscription: (source, threadKey) => subscriptions.delete(`${source}::${threadKey}`),
    listSubscriptions: (filter) =>
      [...subscriptions.values()].filter(
        (s) => (!filter?.source || s.source === filter.source) && (!filter?.status || s.status === filter.status),
      ),
    onUnclaimedEvent: () => () => {},
    registerSource: () => () => {},
    registerResolver: () => () => {},
    registerSink: () => () => {},
    registerRule: () => () => {},
    registerWechatTransport: () => () => {},
    getWechatTransport: () => null,
    ingest: async () => ({ accepted: true }),
    invokeSink: async () => ({ status: 'executed' }),
    approveDraft: async (draftId: string) => {
      const d = drafts.find((x) => x.id === draftId);
      if (!d) throw new Error('draft not found');
      d.status = 'executed';
      return { status: 'executed', draftId };
    },
    discardDraft: async (draftId: string) => {
      const d = drafts.find((x) => x.id === draftId);
      if (!d) throw new Error('draft not found');
      d.status = 'rejected';
    },
    listInbox: (filter) =>
      inboxItems.filter(
        (i) => (!filter?.source || i.source === filter.source) && (!filter?.status || i.status === filter.status),
      ),
    listWorkstreams: (filter) =>
      workstreams.filter(
        (w) =>
          (!filter?.sessionId || w.sessionId === filter.sessionId) &&
          (!filter?.status || w.status === filter.status),
      ),
    cancelWorkstream: (id: string) => {
      const ws = workstreams.find((w) => w.id === id);
      if (!ws) return false;
      ws.status = 'ended';
      return true;
    },
    listDrafts: (filter) => drafts.filter((d) => !filter?.status || d.status === filter.status),
    pollSourceNow: async (sourceId: string) => {
      polledSources.push(sourceId);
      return { polled: 1, events: 2 };
    },
    getStatus: () => ({
      sources: [{ id: 'github', label: 'GitHub' }],
      connectors: [...connectors.values()],
      sinks: [{ id: 'github.comment', label: 'GitHub Comment', kind: 'staged-draft' }],
      wechatTransportMode: 'unavailable',
      activeWorkstreams: workstreams.filter((w) => w.status === 'active').length,
      activeSubscriptions: subscriptions.size,
      unreadInbox: inboxItems.filter((i) => i.status === 'unread').length,
      pendingDrafts: drafts.filter((d) => d.status === 'pending_approval').length,
      autoSessionsThisHour: 0,
      configRevision: 1,
    }),
  };

  return { watcher, db, polledSources };
}

function sendRawRequest(
  port: number,
  method: string,
  reqPath: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path: reqPath,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('HTTP routes serve status, inbox, workstreams, drafts, memos, personas, source poll, and reject non-loopback requests', async () => {
  const { watcher, db, polledSources } = createStubWatcher();
  const checkedMemos: string[] = [];
  const handler = createWatcherHttpHandler(watcher, {
    memoEngine: {
      checkNow: async (memoId: string) => {
        checkedMemos.push(memoId);
        return { triggered: true };
      },
    },
  });

  const server = http.createServer((req, res) => {
    void handler(req, res);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = LOOPBACK_ORIGIN_PREFIX + String(port);

  try {
    const statusRes = await fetch(baseUrl + '/local-watcher/status');
    assert.equal(statusRes.status, 200);
    const statusJson = (await statusRes.json()) as Record<string, unknown>;
    assert.equal(statusJson.activeWorkstreams, 1);
    assert.equal(statusJson.unreadInbox, 2);
    assert.equal(statusJson.pendingDrafts, 1);

    const inboxRes = await fetch(baseUrl + '/local-watcher/inbox?source=github');
    const inboxJson = (await inboxRes.json()) as { items: InboxItem[] };
    assert.equal(inboxJson.items.length, 1);
    assert.equal(inboxJson.items[0].source, 'github');

    const wsCancel = await sendRawRequest(port, 'POST', '/local-watcher/workstreams/ws-1/cancel', {}, {});
    assert.equal(wsCancel.status, 200);
    assert.equal(wsCancel.json.ok, true);

    const draftsRes = await fetch(baseUrl + '/local-watcher/drafts');
    const draftsJson = (await draftsRes.json()) as { drafts: StagedDraft[] };
    assert.equal(draftsJson.drafts.length, 2);

    const approveRes = await sendRawRequest(port, 'POST', '/local-watcher/drafts/dr-1/approve', {}, {});
    assert.equal(approveRes.status, 200);
    assert.equal(approveRes.json.status, 'executed');

    const discardRes = await sendRawRequest(port, 'POST', '/local-watcher/drafts/dr-2/discard', {}, { reason: 'stale' });
    assert.equal(discardRes.status, 200);
    assert.equal(discardRes.json.ok, true);

    const createMemoRes = await sendRawRequest(port, 'POST', '/local-watcher/memos', {}, {
      kind: 'long_watch',
      roomKey: 'gh:example-owner/demo#223',
      targetSessionId: 'sess-223',
      title: '蹲官方 ACP 发布',
      basis: '等官方正式发布文档后提醒',
      keywords: ['ACP', 'release'],
    });
    assert.equal(createMemoRes.status, 201);
    const createdMemo = createMemoRes.json.memo as { id: string; kind: string; status: string };
    assert.equal(createdMemo.kind, 'long_watch');
    assert.equal(createdMemo.status, 'active');

    const listMemosRes = await fetch(baseUrl + '/local-watcher/memos?status=active');
    const listMemosJson = (await listMemosRes.json()) as { memos: Array<{ id: string }> };
    assert.equal(listMemosJson.memos.length, 1);

    const checkMemoRes = await sendRawRequest(port, 'POST', `/local-watcher/memos/${createdMemo.id}/check`, {}, {});
    assert.equal(checkMemoRes.status, 200);
    assert.equal(checkMemoRes.json.checked, true);
    assert.deepEqual(checkedMemos, [createdMemo.id]);

    const cancelMemoRes = await sendRawRequest(port, 'POST', `/local-watcher/memos/${createdMemo.id}/cancel`, {}, {});
    assert.equal(cancelMemoRes.status, 200);
    assert.equal((cancelMemoRes.json.memo as { status: string }).status, 'torn');

    const personasRes = await fetch(baseUrl + '/local-watcher/personas');
    const personasJson = (await personasRes.json()) as { personas: PersonaRecord[] };
    assert.equal(personasJson.personas.length, 1);

    const createdPersonaRes = await sendRawRequest(port, 'POST', '/local-watcher/personas', {}, { kind: 'fiction' });
    assert.equal(createdPersonaRes.status, 201);
    const newPersona = createdPersonaRes.json.persona as PersonaRecord;

    const updatedPersonaRes = await sendRawRequest(port, 'PUT', `/local-watcher/personas/${newPersona.id}`, {}, {
      revision: newPersona.revision,
      persona: { ...newPersona, name: '星野', work: '测试作品', character: '星野' },
    });
    assert.equal(updatedPersonaRes.status, 200);
    assert.equal((updatedPersonaRes.json.persona as PersonaRecord).name, '星野');

    const memoriesRes = await fetch(baseUrl + '/local-watcher/personas/double/memories');
    const memoriesJson = (await memoriesRes.json()) as { memories: PersonaMemoryRecord[] };
    assert.equal(memoriesJson.memories.length, 1);

    const editMemRes = await sendRawRequest(port, 'PUT', '/local-watcher/personas/double/memories/1', {}, {
      note: '更简短',
    });
    assert.equal(editMemRes.status, 200);
    assert.equal(editMemRes.json.note, '更简短');

    const learnRes = await sendRawRequest(port, 'POST', '/local-watcher/personas/double/learn-style', {}, {});
    assert.equal(learnRes.status, 200);
    assert.equal((learnRes.json.persona as PersonaRecord).style, '已从样本提炼的短句风格');

    const previewRes = await sendRawRequest(port, 'POST', '/local-watcher/personas/double/preview', {}, {
      message: '明天去不去？',
    });
    assert.equal(previewRes.status, 200);
    assert.equal(previewRes.json.dryRun, true);
    assert.equal(previewRes.json.memoryMutated, false);

    const delMemRes = await sendRawRequest(port, 'DELETE', '/local-watcher/personas/double/memories');
    assert.equal(delMemRes.status, 200);
    assert.equal(delMemRes.json.deleted, 1);

    const pollRes = await sendRawRequest(port, 'POST', '/local-watcher/sources/github/poll', {}, {});
    assert.equal(pollRes.status, 200);
    assert.deepEqual(polledSources, ['github']);

    const badHost = await sendRawRequest(port, 'GET', '/local-watcher/status', { Host: 'evil.example.com' });
    assert.equal(badHost.status, 403);
    assert.equal(badHost.json.error, 'loopback_host_only');

    const crossSite = await sendRawRequest(port, 'GET', '/local-watcher/status', {
      'Sec-Fetch-Site': 'cross-site',
    });
    assert.equal(crossSite.status, 403);
    assert.equal(crossSite.json.error, 'cross_site_blocked');

    const remoteGate = await checkLocalOwnerRequest(
      {
        socket: { remoteAddress: '203.0.113.10' },
        headers: { host: '127.0.0.1' },
      } as unknown as http.IncomingMessage,
    );
    assert.equal(remoteGate.ok, false);
    assert.equal(remoteGate.status, 403);

    const connGate = await checkLocalOwnerRequest(
      {
        socket: { remoteAddress: '127.0.0.1' },
        headers: { host: '127.0.0.1' },
      } as unknown as http.IncomingMessage,
      { requestRejection: () => 'denied' },
    );
    assert.equal(connGate.ok, false);
    assert.equal(connGate.status, 403);
    assert.equal(connGate.error, 'connection_rejected');

    const registered: string[] = [];
    const dispose = mountHttpRoutes(
      {
        webServer: {
          register: (method, routePath) => {
            registered.push(`${method} ${routePath}`);
            return () => {};
          },
        },
      },
      watcher,
    );
    assert.ok(registered.includes('GET /local-watcher/status'));
    assert.ok(registered.includes('POST /local-watcher/memos'));
    assert.ok(registered.includes('POST /local-watcher/personas/:id/preview'));
    assert.ok(registered.includes('GET /local-watcher/github/config'));
    assert.ok(registered.includes('PUT /local-watcher/github/config'));
    assert.ok(registered.includes('POST /local-watcher/github/token'));
    assert.ok(registered.includes('POST /local-watcher/github/app'));
    assert.ok(registered.includes('POST /local-watcher/github/app/verify'));
    assert.ok(registered.includes('DELETE /local-watcher/github/app'));
    assert.ok(registered.includes('POST /local-watcher/github/poll'));
    dispose();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});

test('HTTP routes expose /local-watcher/github/* config, masked token save, poll, and 503 when unregistered', async () => {
  const { watcher, db } = createStubWatcher();
  let registeredAdmin: GitHubAdminAdapter | null = null;
  watcher.getGitHubAdmin = () => registeredAdmin;

  const handler = createWatcherHttpHandler(watcher);
  const server = http.createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const unavailable = await sendRawRequest(port, 'GET', '/local-watcher/github/config');
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.json.error, 'github_adapter_unavailable');

    const state: GitHubAdminConfigView = {
      authStatus: {
        configured: false,
        source: 'none',
        login: null,
        scopes: [],
        notificationsScopeMissing: true,
        hasBotToken: false,
      },
      enableNotifications: true,
      pollIntervalMs: 60_000,
      autoSendOwners: ['example-owner'],
      repos: [],
      pinnedItems: [],
    };
    const savedTokens: Array<{ slot: string; token: string }> = [];
    let pollCalls = 0;

    registeredAdmin = {
      getConfig: () => state,
      updateConfig: (next) => {
        if (typeof next.enableNotifications === 'boolean') state.enableNotifications = next.enableNotifications;
        if (typeof next.pollIntervalMs === 'number') state.pollIntervalMs = next.pollIntervalMs;
        if (Array.isArray(next.autoSendOwners)) state.autoSendOwners = next.autoSendOwners;
        if (Array.isArray(next.repos)) state.repos = next.repos;
        if (Array.isArray(next.pinnedItems)) {
          state.pinnedItems = next.pinnedItems.map((p) => ({
            repo: p.repo,
            number: p.number,
            linkedPrs: p.linkedPrs ?? [],
            watchReactions: p.watchReactions !== false,
          }));
        }
        return state;
      },
      saveToken: async (input) => {
        savedTokens.push({ slot: input.slot, token: input.token });
        state.authStatus = {
          configured: true,
          source: 'credentials',
          login: 'example-owner',
          scopes: ['repo', 'notifications'],
          notificationsScopeMissing: false,
          hasBotToken: input.slot === 'act',
        };
        return {
          ok: true,
          slot: input.slot,
          savedTo: 'file',
          verified: {
            ok: true,
            login: 'example-owner',
            scopes: ['repo', 'notifications'],
            notificationsScopeMissing: false,
            status: 200,
          },
          authStatus: state.authStatus,
        };
      },
      verifyToken: async () => ({
        ok: true,
        login: 'example-owner',
        scopes: ['repo', 'notifications'],
        notificationsScopeMissing: false,
        status: 200,
      }),
      pollNow: async () => {
        pollCalls += 1;
        return { polled: 2, events: 1, authStatus: state.authStatus };
      },
    };

    const getRes = await sendRawRequest(port, 'GET', '/local-watcher/github/config');
    assert.equal(getRes.status, 200);
    assert.deepEqual(getRes.json.autoSendOwners, ['example-owner']);

    const putRes = await sendRawRequest(port, 'PUT', '/local-watcher/github/config', {}, {
      enableNotifications: false,
      pollIntervalMs: 30_000,
      autoSendOwners: ['example-owner', 'TeamOrg'],
      repos: [{ repo: 'example-owner/example-repo', localPath: '/tmp/subs', autoSend: true, enabled: true }],
      pinnedItems: [{ repo: 'example-owner/example-repo', number: 222, linkedPrs: [221], watchReactions: true }],
    });
    assert.equal(putRes.status, 200);
    assert.equal(putRes.json.enableNotifications, false);
    assert.equal((putRes.json.repos as unknown[]).length, 1);
    assert.equal((putRes.json.pinnedItems as unknown[]).length, 1);

    const badSlot = await sendRawRequest(port, 'POST', '/local-watcher/github/token', {}, {
      slot: 'invalid',
      token: 'ghp_x',
    });
    assert.equal(badSlot.status, 400);
    assert.equal(badSlot.json.error, 'invalid_token_slot');

    const emptyToken = await sendRawRequest(port, 'POST', '/local-watcher/github/token', {}, {
      slot: 'read',
      token: '   ',
    });
    assert.equal(emptyToken.status, 400);
    assert.equal(emptyToken.json.error, 'token_required');

    const secretValue = 'ghp_super_secret_token_never_echo_12345';
    const tokenRes = await sendRawRequest(port, 'POST', '/local-watcher/github/token', {}, {
      slot: 'read',
      token: secretValue,
    });
    assert.equal(tokenRes.status, 200);
    assert.equal(tokenRes.json.ok, true);
    assert.equal(savedTokens.length, 1);
    assert.equal(savedTokens[0].token, secretValue);
    assert.equal(JSON.stringify(tokenRes.json).includes(secretValue), false);
    assert.equal((tokenRes.json.authStatus as Record<string, unknown>).login, 'example-owner');

    const pollRes = await sendRawRequest(port, 'POST', '/local-watcher/github/poll', {}, {});
    assert.equal(pollRes.status, 200);
    assert.equal(pollRes.json.ok, true);
    assert.equal(pollRes.json.polled, 2);
    assert.equal(pollCalls, 1);

    const unsupportedApp = await sendRawRequest(port, 'POST', '/local-watcher/github/app', {}, { appId: 123 });
    assert.equal(unsupportedApp.status, 501);
    assert.equal(unsupportedApp.json.error, 'github_app_unsupported');

    const savedApps: Array<{ appId: number; privateKeyPem?: string; repo?: string }> = [];
    registeredAdmin.saveApp = async (input) => {
      savedApps.push({ appId: input.appId, privateKeyPem: input.privateKeyPem, repo: input.repo });
      state.authStatus = {
        ...state.authStatus,
        hasBotToken: true,
        botLogin: 'demo-app[bot]',
        actMode: 'app',
        githubApp: {
          configured: true,
          appId: input.appId,
          slug: input.slug ?? 'demo-app',
          defaultRepo: input.repo ?? null,
          installationId: input.installationId ?? 9001,
          botLogin: 'demo-app[bot]',
          permissions: { issues: 'write', pull_requests: 'write' },
        },
      };
      return {
        ok: true,
        savedTo: 'file',
        verified: {
          ok: true,
          appId: input.appId,
          slug: input.slug ?? 'demo-app',
          botLogin: 'demo-app[bot]',
          installationId: input.installationId ?? 9001,
          repository: input.repo ?? null,
          permissions: { issues: 'write', pull_requests: 'write' },
          commentsAllowed: true,
          pullRequestsAllowed: true,
          status: 200,
        },
        authStatus: state.authStatus,
      };
    };
    registeredAdmin.verifyApp = async (opts) => ({
      ok: true,
      appId: 12345,
      slug: 'demo-app',
      botLogin: 'demo-app[bot]',
      installationId: 9001,
      repository: opts?.repo ?? null,
      permissions: { issues: 'write', pull_requests: 'write' },
      commentsAllowed: true,
      pullRequestsAllowed: true,
      status: 200,
    });
    registeredAdmin.deleteApp = async () => {
      state.authStatus = {
        ...state.authStatus,
        hasBotToken: false,
        botLogin: null,
        actMode: 'read-fallback',
        githubApp: {
          configured: false,
          appId: null,
          slug: null,
          defaultRepo: null,
          installationId: null,
          botLogin: null,
        },
      };
      return { ok: true, authStatus: state.authStatus };
    };

    const badAppId = await sendRawRequest(port, 'POST', '/local-watcher/github/app', {}, { appId: -1 });
    assert.equal(badAppId.status, 400);
    assert.equal(badAppId.json.error, 'invalid_app_id');

    const badInstId = await sendRawRequest(port, 'POST', '/local-watcher/github/app', {}, {
      appId: 12345,
      installationId: 0,
    });
    assert.equal(badInstId.status, 400);
    assert.equal(badInstId.json.error, 'invalid_installation_id');

    const fakePem = '-----BEGIN PRIVATE KEY-----\nSUPER_SECRET_KEY_MATERIAL\n-----END PRIVATE KEY-----';
    const saveAppRes = await sendRawRequest(port, 'POST', '/local-watcher/github/app', {}, {
      appId: 12345,
      privateKeyPem: fakePem,
      repo: 'example-owner/example-repo',
    });
    assert.equal(saveAppRes.status, 200);
    assert.equal(saveAppRes.json.ok, true);
    assert.equal(savedApps.length, 1);
    assert.equal(savedApps[0].privateKeyPem, fakePem);
    assert.equal(JSON.stringify(saveAppRes.json).includes('SUPER_SECRET_KEY_MATERIAL'), false);
    assert.equal((saveAppRes.json.authStatus as Record<string, unknown>).actMode, 'app');

    const verifyAppRes = await sendRawRequest(port, 'POST', '/local-watcher/github/app/verify', {}, {
      repo: 'example-owner/example-repo',
    });
    assert.equal(verifyAppRes.status, 200);
    assert.equal(verifyAppRes.json.ok, true);
    assert.equal(verifyAppRes.json.commentsAllowed, true);
    assert.equal(verifyAppRes.json.pullRequestsAllowed, true);

    const deleteAppRes = await sendRawRequest(port, 'DELETE', '/local-watcher/github/app');
    assert.equal(deleteAppRes.status, 200);
    assert.equal(deleteAppRes.json.ok, true);
    assert.equal((deleteAppRes.json.authStatus as Record<string, unknown>).actMode, 'read-fallback');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});

test('HTTP routes normalize /local-hub/* and /local-watcher/*, serve connectors & subscriptions, and return 503 without personaWardrobe', async () => {
  const { watcher, db } = createStubWatcher();
  watcher.registerConnector({
    id: 'github',
    label: 'GitHub',
    kind: 'connector',
    panelId: 'dsh-github-panel',
    panelLabel: 'GitHub',
  });
  const noWardrobeHub: WatcherHttpTarget = {
    ...watcher,
    wardrobe: null,
    getWardrobe: () => null,
  };

  const mountedPrefixes: string[] = [];
  const disposeMounted = mountHttpRoutes(
    {
      webServer: {
        register: (route: { path: string }) => {
          mountedPrefixes.push(route.path);
          return () => {};
        },
      },
    },
    noWardrobeHub,
  );
  assert.deepEqual(mountedPrefixes, ['/local-hub', '/local-watcher']);
  disposeMounted();

  const handler = createWatcherHttpHandler(noWardrobeHub);
  const server = http.createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const hubStatus = await sendRawRequest(port, 'GET', '/local-hub/status');
    assert.equal(hubStatus.status, 200);
    assert.equal(Array.isArray(hubStatus.json.connectors), true);

    const connRes = await sendRawRequest(port, 'GET', '/local-hub/connectors');
    assert.equal(connRes.status, 200);
    assert.equal((connRes.json.connectors as unknown[]).length, 1);

    const createdSub = await sendRawRequest(port, 'POST', '/local-hub/subscriptions', {}, {
      source: 'github',
      threadKey: 'github:example-owner/demo#9',
      sessionId: 'sess-9',
      owner: 'manual',
    });
    assert.equal(createdSub.status, 201);
    assert.equal((createdSub.json.subscription as { sessionId: string }).sessionId, 'sess-9');

    const listedSub = await sendRawRequest(port, 'GET', '/local-watcher/subscriptions?source=github');
    assert.equal(listedSub.status, 200);
    assert.equal((listedSub.json.subscriptions as unknown[]).length, 1);

    const delSub = await sendRawRequest(
      port,
      'DELETE',
      '/local-hub/subscriptions?source=github&threadKey=' + encodeURIComponent('github:example-owner/demo#9'),
    );
    assert.equal(delSub.status, 200);
    assert.equal(delSub.json.ok, true);

    const persona503 = await sendRawRequest(port, 'GET', '/local-hub/personas');
    assert.equal(persona503.status, 503);
    assert.equal(persona503.json.error, 'persona_service_unavailable');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});
