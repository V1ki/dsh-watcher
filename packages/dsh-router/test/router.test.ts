import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Readable } from 'node:stream';
import { apply as applyHub, type HubService, type NormalizedEvent, type WechatSendInput } from '@local/dsh-hub';
import {
  apply as applyRouter,
  checkLocalOwnerRequest,
  createRouterHttpHandler,
  mountRouterHttpRoutes,
  openRouterDb,
  triageEvent,
  DEFAULT_ATTENTION_POLICY,
  type CordisRouterContext,
  type RouterPluginConfig,
  type ToolDefinitionLike,
  type TriageLlmLike,
  type WebServerRouteRegistration,
} from '../src/index.js';

function makeEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  const id = overrides.id ?? `evt-${Math.random().toString(36).slice(2, 10)}`;
  return {
    id,
    source: overrides.source ?? 'github',
    type: overrides.type ?? 'github.pr_review_requested',
    dedupeKey: overrides.dedupeKey ?? `dedupe:${id}`,
    threadKey: overrides.threadKey ?? 'org/repo#101',
    actor: overrides.actor ?? { id: 'alice', login: 'alice', isBot: false },
    trustLevel: overrides.trustLevel ?? 'triage',
    occurredAt: overrides.occurredAt ?? '2026-06-10T06:00:00.000Z',
    summary: overrides.summary ?? 'Please review PR #101 auth refactor',
    payload: overrides.payload ?? {},
    rawRef: overrides.rawRef ?? { url: 'https://github.com/org/repo/pull/101', repo: 'org/repo', number: 101 },
  };
}

function createMockSessionEnv() {
  const createdWorkspaces: string[] = [];
  const createdSessions: Array<{ workspaceId: string; sessionId: string }> = [];
  const followups: Array<{ sessionId: string; message: unknown }> = [];
  const tools = new Map<string, ToolDefinitionLike>();

  const workspaceRegistry = {
    resolveByPath: async (workspacePath: string) =>
      createdWorkspaces.includes(workspacePath) ? { id: `ws:${workspacePath}` } : null,
    create: async (workspacePath: string) => {
      createdWorkspaces.push(workspacePath);
      return { id: `ws:${workspacePath}` };
    },
  };

  const sessionController = {
    create: async (input: { workspaceId: string }) => {
      const sessionId = `sess_${createdSessions.length + 1}`;
      createdSessions.push({ workspaceId: input.workspaceId, sessionId });
      return { sessionId };
    },
    resolveAgent: async (sessionId: string) => ({
      agent: {
        id: sessionId,
        followup: (message: unknown) => {
          followups.push({ sessionId, message });
        },
      },
    }),
  };

  const toolsRegistry = {
    register: (def: ToolDefinitionLike) => {
      tools.set(def.name, def);
      return () => {
        tools.delete(def.name);
      };
    },
  };

  return {
    createdWorkspaces,
    createdSessions,
    followups,
    tools,
    workspaceRegistry,
    sessionController,
    toolsRegistry,
  };
}

function createHarness(options: {
  now?: () => Date;
  llm?: RouterPluginConfig['llm'];
  initialPolicy?: RouterPluginConfig['initialPolicy'];
  controllerId?: string;
  wechatSend?: (input: WechatSendInput) => Promise<{ status: 'sent' | 'staged' | 'failed'; detail?: string }>;
} = {}) {
  const disposers: Array<() => void> = [];
  const env = createMockSessionEnv();
  const hubServices = new Map<string, unknown>([
    ['workspaceRegistry', env.workspaceRegistry],
    ['sessionController', env.sessionController],
    ['tools', env.toolsRegistry],
  ]);

  const hubCtx = {
    get: (key: string) => hubServices.get(key),
    provide: (key: string, value: unknown) => {
      hubServices.set(key, value);
    },
    effect: (fn: () => (() => void) | void) => {
      const off = fn();
      if (typeof off === 'function') disposers.push(off);
    },
  };

  const hub = applyHub(hubCtx, { inMemory: true, tickIntervalMs: 0 });
  hubServices.set('hub', hub);

  if (options.wechatSend) {
    hub.registerWechatTransport({
      send: async (input) => options.wechatSend!(input),
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
      status: async () => ({
        ok: true,
        mode: 'cordis',
        healthy: true,
        ...(options.controllerId ? { controllerId: options.controllerId } : {}),
      }),
    });
  }

  const routerCtx: CordisRouterContext = {
    hub: hub as unknown as HubService,
    get: (key: string) => hubServices.get(key),
    provide: (key: string, value: unknown) => {
      hubServices.set(key, value);
    },
    inject: (deps, callback) => {
      if (deps.every((dep) => hubServices.has(dep))) {
        callback(routerCtx);
      }
    },
    effect: (fn) => {
      const off = fn();
      if (typeof off === 'function') disposers.push(off);
    },
  };

  const router = applyRouter(routerCtx, {
    inMemory: true,
    tickIntervalMs: 0,
    now: options.now ?? (() => new Date('2026-06-10T06:00:00.000Z')),
    llm: options.llm,
    initialPolicy: options.initialPolicy,
  });

  const cleanup = () => {
    while (disposers.length > 0) {
      disposers.pop()?.();
    }
  };

  return { hub, router, env, hubServices, routerCtx, cleanup };
}

async function httpRequest(
  port: number,
  method: string,
  reqPath: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        method,
        headers: {
          ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            json: text ? (JSON.parse(text) as Record<string, unknown>) : {},
          });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('@local/dsh-router backend', () => {
  it('routes cold-start event through Router, dispatches Worker + Hub subscription, and 2nd event takes Fast Path', async () => {
    const { hub, router, env, cleanup } = createHarness({
      initialPolicy: { presenceMode: 'present' },
    });
    try {
      const connectors = hub.listConnectors();
      assert.equal(connectors.some((c) => c.id === 'router' && c.panelId === 'dsh-router-panel'), true);

      const first = await hub.ingest(
        makeEvent({
          id: 'evt-1',
          threadKey: 'org/repo#42',
          type: 'github.pr_review_requested',
          summary: 'Review PR #42 fast-path routing',
        }),
      );
      assert.equal(first.accepted, true);
      assert.equal(first.routedVia, 'router');

      const decisionsAfterFirst = router.listDecisions();
      assert.equal(decisionsAfterFirst.length, 1);
      assert.equal(decisionsAfterFirst[0].level, 'prepare');
      assert.equal(decisionsAfterFirst[0].status, 'dispatched');
      assert.equal(decisionsAfterFirst[0].workerSessionId, 'sess_1');
      assert.ok(decisionsAfterFirst[0].subscriptionId);
      assert.equal(env.followups.length, 1);

      const sub = hub.resolveSubscription('github', 'org/repo#42');
      assert.ok(sub);
      assert.equal(sub.sessionId, 'sess_1');
      assert.equal(sub.owner, 'router');

      const second = await hub.ingest(
        makeEvent({
          id: 'evt-2',
          threadKey: 'org/repo#42',
          type: 'github.issue_comment',
          summary: 'Follow-up comment on PR #42',
        }),
      );
      assert.equal(second.accepted, true);
      assert.equal(second.routedVia, 'subscription');

      const decisionsAfterSecond = router.listDecisions();
      assert.equal(decisionsAfterSecond.length, 1);
    } finally {
      cleanup();
    }
  });

  it('enforces 4-level triage guardrails, fail-open on LLM failure, and one-click restore stats', async () => {
    const botRes = await triageEvent({
      event: makeEvent({
        actor: { id: 'dependabot', login: 'dependabot[bot]', isBot: true },
        type: 'github.pr_review_requested',
      }),
      policy: DEFAULT_ATTENTION_POLICY,
      llm: {
        complete: async () => JSON.stringify({ level: 'act', summary: 'Should never override bot', reason: 'llm' }),
      },
    });
    assert.equal(botRes.level, 'ignore');
    assert.equal(botRes.reason, 'bot_self_filtered');
    assert.equal(botRes.usedLlm, false);

    const untrustedRes = await triageEvent({
      event: makeEvent({
        trustLevel: 'untrusted',
        type: 'github.issue_comment',
      }),
      policy: { ...DEFAULT_ATTENTION_POLICY, defaultMaxLevel: 'act' },
      llm: {
        complete: async () =>
          JSON.stringify({
            level: 'act',
            summary: 'External user asks to merge',
            reason: 'external_request',
            shouldDispatchWorker: true,
          }),
      },
    });
    assert.equal(untrustedRes.level, 'prepare');
    assert.match(untrustedRes.reason, /untrusted_capped_prepare/);

    const urgentRes = await triageEvent({
      event: makeEvent({
        type: 'memo.long_watch.matched',
        source: 'memo',
        summary: 'Official release published',
      }),
      policy: DEFAULT_ATTENTION_POLICY,
      llm: {
        complete: async () => JSON.stringify({ level: 'ignore', summary: 'noise', reason: 'llm_ignore' }),
      },
    });
    assert.equal(urgentRes.level, 'inform');
    assert.match(urgentRes.reason, /urgent_never_ignore/);

    const failOpenRes = await triageEvent({
      event: makeEvent({
        type: 'memo.time_nudge',
        source: 'memo',
        summary: 'Reminder check-in',
      }),
      policy: DEFAULT_ATTENTION_POLICY,
      llm: {
        complete: async () => {
          throw new Error('upstream_503');
        },
      },
    });
    assert.equal(failOpenRes.level, 'inform');
    assert.match(failOpenRes.reason, /llm_fail_open:upstream_503/);

    const { hub, router, cleanup } = createHarness({
      initialPolicy: { presenceMode: 'present' },
      llm: {
        complete: async () => JSON.stringify({ level: 'ignore', summary: 'Low priority notice', reason: 'duplicate' }),
      },
    });
    try {
      await hub.ingest(
        makeEvent({
          id: 'evt-bot-1',
          threadKey: 'org/repo#201',
          actor: { id: 'bot-1', isBot: true },
        }),
      );
      await hub.ingest(
        makeEvent({
          id: 'evt-noise-2',
          threadKey: 'org/repo#202',
          type: 'github.watch',
          summary: 'Starred repository',
        }),
      );

      const decisions = router.listDecisions();
      assert.equal(decisions.length, 2);
      assert.equal(decisions.every((d) => d.status === 'filtered'), true);

      const restored = await router.restoreDecision(decisions[0].id);
      assert.equal(restored.triageRestored, true);
      assert.equal(restored.status, 'restored');
      assert.equal(restored.destination, 'web');

      const stats = router.getStats(7);
      assert.equal(stats.totalEvents, 2);
      assert.equal(stats.filteredCount, 2);
      assert.equal(stats.restoredCount, 1);
      assert.equal(stats.restoreRate, 0.5);

      router.updatePolicy({ enabled: false });
      const bypassed = await hub.ingest(
        makeEvent({
          id: 'evt-disabled-3',
          threadKey: 'org/repo#203',
        }),
      );
      assert.equal(bypassed.accepted, true);
      assert.equal(bypassed.routedVia, 'inbox');
    } finally {
      cleanup();
    }
  });

  it('evaluates AttentionPolicy previewRoute and delivers deferred notifications when presence flips', async () => {
    let currentNow = new Date('2026-06-13T06:00:00.000Z');
    const sentWechat: WechatSendInput[] = [];
    const { hub, router, cleanup } = createHarness({
      now: () => currentNow,
      initialPolicy: { presenceMode: 'away' },
      wechatSend: async (input) => {
        sentWechat.push(input);
        return { status: 'sent' };
      },
    });
    try {
      const workPresent = router.previewRoute({
        isoTime: '2026-06-10T06:00:00.000Z',
        presenceMode: 'present',
        urgent: false,
      });
      assert.equal(workPresent.slot, 'work');
      assert.equal(workPresent.present, true);
      assert.equal(workPresent.destination, 'web');

      const workAway = router.previewRoute({
        isoTime: '2026-06-10T06:00:00.000Z',
        presenceMode: 'away',
        urgent: false,
      });
      assert.equal(workAway.slot, 'work');
      assert.equal(workAway.present, false);
      assert.equal(workAway.destination, 'wechat');

      const weekendDeferred = router.previewRoute({
        isoTime: '2026-06-13T06:00:00.000Z',
        presenceMode: 'away',
        urgent: false,
      });
      assert.equal(weekendDeferred.slot, 'weekend');
      assert.equal(weekendDeferred.destination, 'defer');
      assert.ok(weekendDeferred.dueAt);

      const weekendUrgent = router.previewRoute({
        isoTime: '2026-06-13T06:00:00.000Z',
        presenceMode: 'away',
        urgent: true,
      });
      assert.equal(weekendUrgent.slot, 'weekend');
      assert.equal(weekendUrgent.destination, 'wechat');

      await hub.ingest(
        makeEvent({
          id: 'evt-weekend-1',
          source: 'memo',
          type: 'memo.time_nudge',
          threadKey: 'memo:weekly',
          summary: 'Non-urgent weekend memo',
        }),
      );
      const deferredNotifs = router.listNotifications({ status: 'deferred' });
      assert.equal(deferredNotifs.length, 1);
      assert.equal(router.listDecisions()[0].status, 'deferred');

      const stillWeekendTick = await router.tickDeferred();
      assert.equal(stillWeekendTick.delivered, 0);

      currentNow = new Date('2026-06-15T02:00:00.000Z');
      router.updatePolicy({ presenceMode: 'present' });
      const deliveredTick = await router.tickDeferred();
      assert.equal(deliveredTick.delivered, 1);

      const webDelivered = router.listNotifications({ status: 'delivered', channel: 'web' });
      assert.equal(webDelivered.length, 1);
      assert.equal(router.listDecisions()[0].status, 'notified');

      router.updatePolicy({ presenceMode: 'away' });
      await hub.ingest(
        makeEvent({
          id: 'evt-wechat-inform-quiet',
          source: 'memo',
          type: 'memo.time_nudge',
          threadKey: 'memo:away-quiet',
          trustLevel: 'owner',
          summary: 'Non-urgent owner inform stays on web',
        }),
      );
      assert.equal(sentWechat.length, 0);

      await hub.ingest(
        makeEvent({
          id: 'evt-wechat-1',
          source: 'memo',
          type: 'memo.time_nudge',
          threadKey: 'memo:away-ping',
          summary: 'Urgent ping while away during work hours',
          payload: { urgent: true },
        }),
      );
      assert.equal(sentWechat.length, 1);
      assert.equal(sentWechat[0].chatId, 'filehelper');
      assert.equal(sentWechat[0].mode, 'send');
    } finally {
      cleanup();
    }
  });

  it('handles Worker router_report_result tool and tracks recommendedPickedCount on answerDecision', async () => {
    const { hub, router, env, cleanup } = createHarness({
      initialPolicy: { presenceMode: 'present' },
    });
    try {
      await hub.ingest(
        makeEvent({
          id: 'evt-worker-1',
          threadKey: 'org/repo#77',
          type: 'github.pr_review_requested',
          summary: 'PR #77 cache invalidation',
        }),
      );
      const [decision] = router.listDecisions();
      assert.ok(decision);

      const reportTool = env.tools.get('router_report_result');
      assert.ok(reportTool);

      await reportTool.execute({
        decisionId: decision.id,
        conclusion: 'Root cause isolated and patch staged',
        changes: ['src/cache.ts', 'test/cache.test.ts'],
        question: 'How should we proceed with PR #77?',
        options: ['Approve and post review', 'Request follow-up test', 'Ignore for now'],
        recommendedIndex: 0,
      });

      const reported = router.listDecisions().find((d) => d.id === decision.id)!;
      assert.match(reported.summary, /Root cause isolated/);
      assert.equal(reported.options.length, 3);
      assert.equal(reported.recommendedIndex, 0);

      const answered = await router.answerDecision(decision.id, 0);
      assert.equal(answered.status, 'resolved');
      assert.equal(answered.answeredOption, 'Approve and post review');
      assert.equal(env.followups.length, 2);

      const stats = router.getStats(7);
      assert.equal(stats.dispatchedWorkers, 1);
      assert.equal(stats.answeredDecisions, 1);
      assert.equal(stats.recommendedPickedCount, 1);
    } finally {
      cleanup();
    }
  });

  it('mounts bound /local-router/* HTTP routes with loopback owner gate', async () => {
    const { router, cleanup } = createHarness({
      initialPolicy: { presenceMode: 'auto' },
    });

    class BoundWebServer {
      readonly mounted: WebServerRouteRegistration[] = [];

      register(route: WebServerRouteRegistration): () => void {
        this.mounted.push(route);
        return () => {
          const idx = this.mounted.indexOf(route);
          if (idx >= 0) this.mounted.splice(idx, 1);
        };
      }
    }

    const webServer = new BoundWebServer();
    const unmount = mountRouterHttpRoutes({ webServer }, router);
    assert.equal(webServer.mounted.length, 1);
    assert.equal(webServer.mounted[0].path, '/local-router');

    const server = http.createServer((req, res) => {
      void webServer.mounted[0].handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const port = address.port;

    try {
      const nonLoopbackGate = await checkLocalOwnerRequest({
        socket: { remoteAddress: '192.0.2.50' },
        headers: { host: '127.0.0.1:3000' },
      } as unknown as http.IncomingMessage);
      assert.equal(nonLoopbackGate.ok, false);
      assert.equal(nonLoopbackGate.error, 'loopback_only');

      const nonOwnerGate = await checkLocalOwnerRequest(
        {
          socket: { remoteAddress: '127.0.0.1' },
          headers: { host: '127.0.0.1:3000' },
        } as unknown as http.IncomingMessage,
        { admit: async () => ({ peer: { principal: { kind: 'guest' } } }) },
      );
      assert.equal(nonOwnerGate.ok, false);
      assert.equal(nonOwnerGate.error, 'owner_required');

      const crossSiteRes = await httpRequest(port, 'GET', '/local-router/status', undefined, {
        'sec-fetch-site': 'cross-site',
      });
      assert.equal(crossSiteRes.status, 403);

      const statusRes = await httpRequest(port, 'GET', '/local-router/status');
      assert.equal(statusRes.status, 200);
      assert.equal(statusRes.json.ok, true);
      assert.equal(statusRes.json.webActive, true);

      const policyPut = await httpRequest(port, 'PUT', '/local-router/policy', {
        wechatTarget: 'owner-chat',
        workEndHour: 20,
      });
      assert.equal(policyPut.status, 200);
      assert.equal(policyPut.json.wechatTarget, 'owner-chat');
      assert.equal(policyPut.json.workEndHour, 20);

      const previewRes = await httpRequest(port, 'POST', '/local-router/preview', {
        isoTime: '2026-06-13T06:00:00.000Z',
        presenceMode: 'away',
        urgent: false,
      });
      assert.equal(previewRes.status, 200);
      assert.equal(previewRes.json.destination, 'defer');

      const sim1 = await httpRequest(port, 'POST', '/local-router/simulate-event', {
        source: 'github',
        threadKey: 'org/repo#900',
        summary: 'Review PR #900 router test',
      });
      assert.equal(sim1.status, 200);
      assert.equal((sim1.json.result as { routedVia?: string }).routedVia, 'router');
      const createdDecision = sim1.json.decision as { id: string };
      assert.ok(createdDecision?.id);

      const sim2 = await httpRequest(port, 'POST', '/local-router/simulate-event', {
        source: 'github',
        threadKey: 'org/repo#900',
        summary: 'Second comment on PR #900',
      });
      assert.equal(sim2.status, 200);
      assert.equal((sim2.json.result as { routedVia?: string }).routedVia, 'subscription');

      const subsRes = await httpRequest(port, 'GET', '/local-router/subscriptions');
      assert.equal(subsRes.status, 200);
      assert.equal((subsRes.json.subscriptions as unknown[]).length, 1);

      const notifsRes = await httpRequest(port, 'GET', '/local-router/notifications');
      assert.equal(notifsRes.status, 200);
      const notifications = notifsRes.json.notifications as Array<{ id: string }>;
      assert.ok(notifications.length >= 1);

      const readRes = await httpRequest(port, 'POST', `/local-router/notifications/${notifications[0].id}/read`);
      assert.equal(readRes.status, 200);
      assert.equal(readRes.json.ok, true);

      await router.submitWorkerReport({
        decisionId: createdDecision.id,
        conclusion: 'Checked PR #900',
        options: ['Ship it', 'Hold'],
        recommendedIndex: 0,
      });

      const answerRes = await httpRequest(port, 'POST', `/local-router/decisions/${createdDecision.id}/answer`, {
        optionIndex: 0,
      });
      assert.equal(answerRes.status, 200);
      assert.equal((answerRes.json.decision as { status: string }).status, 'resolved');

      const statsRes = await httpRequest(port, 'GET', '/local-router/stats?days=7');
      assert.equal(statsRes.status, 200);
      assert.equal(statsRes.json.recommendedPickedCount, 1);

      const delSubRes = await httpRequest(port, 'DELETE', '/local-router/subscriptions', {
        source: 'github',
        threadKey: 'org/repo#900',
      });
      assert.equal(delSubRes.status, 200);
      assert.equal(delSubRes.json.removed, true);

      const handler = createRouterHttpHandler(router);
      const fakeReq = Object.assign(Readable.from([]), {
        method: 'GET',
        url: '/local-router/unknown',
        headers: { host: '127.0.0.1' },
        socket: { remoteAddress: '127.0.0.1' },
      }) as unknown as http.IncomingMessage;
      let status404 = 0;
      const fakeRes = {
        writeHead: (code: number) => {
          status404 = code;
        },
        end: () => {},
      } as unknown as http.ServerResponse;
      await handler(fakeReq, fakeRes);
      assert.equal(status404, 404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      unmount();
      cleanup();
    }
  });

  it('persists SQLite state on disk in WAL mode with strict tables', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-router-db-'));
    try {
      const db1 = openRouterDb({ stateDir: tmpDir });
      assert.deepEqual(db1.listTables(), ['router_decisions', 'router_meta', 'router_notifications']);
      db1.setMeta('attention_policy', JSON.stringify({ ...DEFAULT_ATTENTION_POLICY, wechatTarget: 'persisted-target' }));
      db1.close();

      const stateFile = path.join(tmpDir, 'state.sqlite');
      assert.equal(fs.existsSync(stateFile), true);

      const db2 = openRouterDb({ stateDir: tmpDir });
      const raw = db2.getMeta('attention_policy');
      assert.ok(raw);
      assert.equal((JSON.parse(raw) as { wechatTarget: string }).wechatTarget, 'persisted-target');
      db2.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('supports DSH 0.2.2 prepareCall/stream LLM triage and workspaceController real session dispatch', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-router-real-dsh-'));
    const attached: Array<{ wsId: string; sessionId: string }> = [];
    const renamedSessions: Array<{ sessionId: string; title: string }> = [];
    const followups: Array<{ sessionId: string; msg: unknown }> = [];

    const dshLlm: TriageLlmLike = {
      listProviders: () => [{ id: 'deepseek' }],
      listModels: async () => [{ id: 'deepseek-chat' }],
      prepareCall: async (cfg) => {
        if (!cfg.provider) throw new Error('provider_required');
        return {
          config: { provider: cfg.provider, model: cfg.model },
          async *stream() {
            yield {
              type: 'text-delta',
              text: JSON.stringify({
                level: 'prepare',
                summary: 'Real DSH LLM triaged PR #99',
                reason: 'llm_real_dsh_prepare_call',
                shouldDispatchWorker: true,
                urgent: false,
                personaId: null,
                question: null,
                options: [],
                recommendedIndex: null,
              }),
            };
            yield { type: 'finish', reason: { kind: 'stop' } };
          },
        };
      },
    };

    const hub = applyHub({}, { inMemory: true, tickIntervalMs: 0 });
    const services: Record<string, unknown> = {
      hub,
      llm: dshLlm,
      workspaceController: {
        create: async ({ path: dir }: { path: string }) => {
          assert.equal(fs.existsSync(dir), true);
          return { created: true, workspace: { workspaceId: 'ws-real-1' } };
        },
        rename: async () => ({}),
      },
      workspaceRegistry: {
        get: (wsId: string) => ({
          attachSession: async (sessionId: string) => {
            attached.push({ wsId, sessionId });
          },
        }),
      },
      sessionController: {
        create: async ({ sessionId }: { sessionId?: string; cwd?: string }) => ({
          sessionId: sessionId || 'sess-real-fallback',
        }),
        rename: async (input: { sessionId: string; title: string }) => {
          renamedSessions.push(input);
        },
        resolveAgent: async (sessionId: string) => ({
          agent: {
            id: sessionId,
            followup: (msg: unknown) => {
              followups.push({ sessionId, msg });
            },
          },
        }),
      },
    };

    const router = applyRouter(
      {
        hub,
        get: (name: string) => services[name],
      },
      { inMemory: true, tickIntervalMs: 0, homeDir: tmpHome },
    );

    try {
      const res = await hub.ingest(
        makeEvent({
          id: 'evt-dsh-real-1',
          source: 'github',
          type: 'github.pr_review_requested',
          threadKey: 'example-owner/real#99',
          summary: 'Please review PR #99',
        }),
      );
      assert.equal(res.routedVia, 'router');
      const [dec] = router.listDecisions();
      assert.equal(dec.reason, 'llm_real_dsh_prepare_call');
      assert.equal(dec.status, 'dispatched');
      assert.ok(dec.workerSessionId && !dec.workerSessionId.startsWith('worker_'));
      assert.equal(attached.length, 1);
      assert.equal(attached[0].wsId, 'ws-real-1');
      assert.equal(attached[0].sessionId, dec.workerSessionId);
      assert.equal(renamedSessions.length, 1);
      assert.equal(followups.length, 1);
    } finally {
      router.dispose();
      hub.db.close();
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('auto-resolves controllerId, suppresses pre-report WeChat noise, and respects explicit wechatTarget', async () => {
    const sentWechat: WechatSendInput[] = [];
    const { hub, router, env, cleanup } = createHarness({
      initialPolicy: { presenceMode: 'away' },
      controllerId: 'wxid_admin_demo',
      wechatSend: async (input) => {
        sentWechat.push(input);
        return { status: 'sent' };
      },
    });
    try {
      await hub.ingest(
        makeEvent({
          id: 'evt-noise-owner',
          source: 'github',
          type: 'github.issue.updated',
          threadKey: 'org/repo#140',
          actor: { id: 'owner', login: 'example-owner', isBot: false },
          trustLevel: 'owner',
          summary: 'Routine owner inform update',
        }),
      );
      assert.equal(sentWechat.length, 0);
      assert.equal(router.listNotifications({ channel: 'web' }).length, 1);

      await hub.ingest(
        makeEvent({
          id: 'evt-prep-150',
          source: 'github',
          type: 'github.pr_review_requested',
          threadKey: 'org/repo#150',
          summary: 'Adjust button spacing on settings page',
        }),
      );
      assert.equal(sentWechat.length, 0);
      const dec150 = router.listDecisions().find((d) => d.threadKey === 'org/repo#150')!;
      assert.equal(dec150.status, 'dispatched');
      assert.equal(env.followups.length, 1);
      const briefText = (env.followups[0].message as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? '';
      assert.match(briefText, /200 字以内/);
      assert.match(briefText, /imagePath/);
      assert.match(briefText, /draftText/);
      assert.match(briefText, /blindspot/);

      const reportTool = env.tools.get('router_report_result')!;
      await reportTool.execute({
        decisionId: dec150.id,
        conclusion: '按钮间距已经按暗色主题调齐了',
        imagePath: '/tmp/settings-ui-1.png',
        draftText: 'Adjusted spacing to align with dark theme.',
        blindspot: '还没在窄屏下测过',
        question: '这个草稿直接发 GitHub 行吗？',
        mode: 'review_draft',
      });

      assert.equal(sentWechat.length, 1);
      assert.equal(sentWechat[0].chatId, 'wxid_admin_demo');
      assert.equal(sentWechat[0].imagePath, '/tmp/settings-ui-1.png');
      assert.match(String(sentWechat[0].text), /^\[#150\] 按钮间距已经按暗色主题调齐了/);
      assert.match(String(sentWechat[0].text), /拟发草稿：/);
      assert.match(String(sentWechat[0].text), /还没验证：还没在窄屏下测过/);
      assert.match(String(sentWechat[0].text), /想确认下：这个草稿直接发 GitHub 行吗？/);
      assert.match(String(sentWechat[0].text), /直接回复就能接着聊/);
      assert.ok(router.listNotifications({ channel: 'wechat', status: 'delivered' }).length >= 1);

      router.updatePolicy({ wechatTarget: 'wxid_explicit_group' });
      await router.submitWorkerReport({
        decisionId: dec150.id,
        conclusion: '窄屏也顺手验证通过了',
        mode: 'done',
      });
      assert.equal(sentWechat.length, 2);
      assert.equal(sentWechat[1].chatId, 'wxid_explicit_group');
    } finally {
      cleanup();
    }
  });

  it('enforces single-focus queuing, list/next/defer/ref switching, multi-round WeChat chat with unique keys, and 24h timeout', async () => {
    let currentNow = new Date('2026-06-10T06:00:00.000Z');
    const sentWechat: WechatSendInput[] = [];
    const { hub, router, env, cleanup } = createHarness({
      now: () => currentNow,
      initialPolicy: { presenceMode: 'away' },
      controllerId: 'wxid_admin_demo',
      wechatSend: async (input) => {
        sentWechat.push(input);
        return { status: 'sent' };
      },
    });
    try {
      const idleReply = await hub.dispatchAdminWechatMessage!({
        session: 'wxid_admin_demo',
        senderId: 'wxid_admin_demo',
        text: '晚上吃什么',
      });
      assert.equal(idleReply.handled, false);

      const idleNext = await hub.dispatchAdminWechatMessage!({
        session: 'wxid_admin_demo',
        senderId: 'wxid_admin_demo',
        text: '下一个',
      });
      assert.equal(idleNext.handled, false);

      await hub.ingest(
        makeEvent({
          id: 'evt-focus-150',
          threadKey: 'org/repo#150',
          type: 'github.pr_review_requested',
          summary: 'Fix header alignment',
        }),
      );
      await hub.ingest(
        makeEvent({
          id: 'evt-focus-151',
          threadKey: 'org/repo#151',
          type: 'github.issue_comment',
          summary: 'Investigate login timeout',
        }),
      );

      const dec150 = router.listDecisions().find((d) => d.threadKey === 'org/repo#150')!;
      const dec151 = router.listDecisions().find((d) => d.threadKey === 'org/repo#151')!;

      await router.submitWorkerReport({
        decisionId: dec150.id,
        conclusion: '顶部栏对齐修好了',
        imagePath: '/tmp/header-v1.png',
        mode: 'discuss',
      });
      assert.equal(sentWechat.length, 1);
      assert.equal(sentWechat[0].imagePath, '/tmp/header-v1.png');
      assert.equal(router.db.getMeta('focused_decision_id'), dec150.id);

      currentNow = new Date('2026-06-10T06:01:00.000Z');
      await router.submitWorkerReport({
        decisionId: dec151.id,
        conclusion: '登录超时是因为重连退避太长',
        imagePath: '/tmp/login-v1.png',
        blindspot: '没测弱网断连',
        mode: 'discuss',
      });
      assert.equal(sentWechat.length, 1);
      const dec151After = router.listDecisions().find((d) => d.id === dec151.id)!;
      assert.equal(dec151After.status, 'deferred');
      const queuedNotif = router.listNotifications({ decisionId: dec151.id, status: 'deferred' })[0];
      assert.ok(queuedNotif);
      assert.match(queuedNotif.reason, /queued_behind_focus/);

      const blockedTick = await router.tickDeferred();
      assert.equal(blockedTick.delivered, 0);
      assert.equal(sentWechat.length, 1);

      const listRes = await hub.dispatchAdminWechatMessage!({
        session: 'wxid_admin_demo',
        senderId: 'wxid_admin_demo',
        text: '列表',
      });
      assert.equal(listRes.handled, true);
      assert.match(listRes.replyText ?? '', /\[#150\]/);
      assert.match(listRes.replyText ?? '', /\[#151\]/);

      const followCountBefore = env.followups.length;
      const chatRes = await hub.dispatchAdminWechatMessage!({
        session: 'wxid_admin_demo',
        senderId: 'wxid_admin_demo',
        text: '字号再调大 2px 看看',
        quotedText: '[#150] 顶部栏对齐修好了',
      });
      assert.equal(chatRes.handled, true);
      assert.equal(chatRes.replyText, undefined);
      assert.equal(env.followups.length, followCountBefore + 1);
      const forwarded = env.followups[env.followups.length - 1];
      assert.equal(forwarded.sessionId, dec150.workerSessionId);
      const forwardedText = (forwarded.message as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? '';
      assert.match(forwardedText, /字号再调大 2px 看看/);
      assert.match(forwardedText, /router_report_result/);
      assert.match(forwardedText, /imagePath/);

      currentNow = new Date('2026-06-10T06:02:00.000Z');
      await router.submitWorkerReport({
        decisionId: dec150.id,
        conclusion: '字号加大 2px 了，看下新图',
        imagePath: '/tmp/header-v2.png',
        mode: 'discuss',
      });
      assert.equal(sentWechat.length, 2);
      assert.equal(sentWechat[1].imagePath, '/tmp/header-v2.png');
      assert.notEqual(sentWechat[1].idempotencyKey, sentWechat[0].idempotencyKey);

      const switchRes = await hub.dispatchAdminWechatMessage!({
        session: 'wxid_admin_demo',
        senderId: 'wxid_admin_demo',
        text: '#151 把重试间隔改成 3 秒',
      });
      assert.equal(switchRes.handled, true);
      assert.equal(router.db.getMeta('focused_decision_id'), dec151.id);
      const lastFollowup = env.followups[env.followups.length - 1];
      assert.equal(lastFollowup.sessionId, dec151.workerSessionId);
      assert.match(
        (lastFollowup.message as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? '',
        /把重试间隔改成 3 秒/,
      );

      const deferRes = await hub.dispatchAdminWechatMessage!({
        session: 'wxid_admin_demo',
        senderId: 'wxid_admin_demo',
        text: '先放着',
      });
      assert.equal(deferRes.handled, true);
      assert.equal(router.listDecisions().find((d) => d.id === dec151.id)?.status, 'deferred');
      assert.match(deferRes.replyText ?? '', /这条先收起了，后面暂时没有别的事。/);

      const quoteSwitch = await hub.dispatchAdminWechatMessage!({
        session: 'wxid_admin_demo',
        senderId: 'wxid_admin_demo',
        text: '现在继续看这个',
        quotedText: '[#150] 字号加大 2px 了',
      });
      assert.equal(quoteSwitch.handled, true);
      assert.equal(router.db.getMeta('focused_decision_id'), dec150.id);

      const nextRes = await hub.dispatchAdminWechatMessage!({
        session: 'wxid_admin_demo',
        senderId: 'wxid_admin_demo',
        text: '下一个',
      });
      assert.equal(nextRes.handled, true);
      assert.equal(router.listDecisions().find((d) => d.id === dec150.id)?.status, 'resolved');
      assert.equal(router.db.getMeta('focused_decision_id'), dec151.id);
      assert.match(nextRes.replyText ?? '', /\[#151\]/);
      assert.equal(nextRes.imagePath, '/tmp/login-v1.png');

      await hub.ingest(
        makeEvent({
          id: 'evt-focus-152',
          threadKey: 'org/repo#152',
          type: 'github.pr_review_requested',
          summary: 'Check metrics chart',
        }),
      );
      await hub.ingest(
        makeEvent({
          id: 'evt-focus-153',
          threadKey: 'org/repo#153',
          type: 'github.pr_review_requested',
          summary: 'Fix export CSV encoding',
        }),
      );
      const dec152 = router.listDecisions().find((d) => d.threadKey === 'org/repo#152')!;
      const dec153 = router.listDecisions().find((d) => d.threadKey === 'org/repo#153')!;
      currentNow = new Date('2026-06-10T06:05:00.000Z');
      await router.submitWorkerReport({
        decisionId: dec152.id,
        conclusion: '图表样式修好了',
        imagePath: '/tmp/metrics-v1.png',
      });
      currentNow = new Date('2026-06-10T06:06:00.000Z');
      await router.submitWorkerReport({
        decisionId: dec153.id,
        conclusion: 'CSV 导出乱码改成 UTF-8 BOM 了',
      });
      assert.equal(sentWechat.length, 2);

      currentNow = new Date('2026-06-11T07:00:00.000Z');
      const afterTimeoutTick = await router.tickDeferred();
      assert.equal(afterTimeoutTick.delivered, 1);
      assert.equal(sentWechat.length, 3);
      assert.equal(sentWechat[2].chatId, 'wxid_admin_demo');
      assert.match(String(sentWechat[2].text), /^\[#153\]/);
      assert.equal(router.db.getMeta('focused_decision_id'), dec153.id);

      const doneRes = await hub.dispatchAdminWechatMessage!({
        session: 'wxid_admin_demo',
        senderId: 'wxid_admin_demo',
        text: '完成',
      });
      assert.equal(doneRes.handled, true);
      assert.equal(router.listDecisions().find((d) => d.id === dec153.id)?.status, 'resolved');
      assert.match(doneRes.replyText ?? '', /\[#152\]/);
      assert.equal(doneRes.imagePath, '/tmp/metrics-v1.png');

      const doneEmpty = await hub.dispatchAdminWechatMessage!({
        session: 'wxid_admin_demo',
        senderId: 'wxid_admin_demo',
        text: '完成',
      });
      assert.equal(doneEmpty.handled, true);
      assert.equal(doneEmpty.replyText, '这条先收起了，后面暂时没有别的事。');

      const normalAfterDone = await hub.dispatchAdminWechatMessage!({
        session: 'wxid_admin_demo',
        senderId: 'wxid_admin_demo',
        text: '明天见',
      });
      assert.equal(normalAfterDone.handled, false);

      const reopenByPrefix = await hub.dispatchAdminWechatMessage!({
        session: 'wxid_admin_demo',
        senderId: 'wxid_admin_demo',
        text: '#150',
      });
      assert.equal(reopenByPrefix.handled, true);
      assert.match(reopenByPrefix.replyText ?? '', /\[#150\]/);
      assert.equal(router.listDecisions().find((d) => d.id === dec150.id)?.status, 'notified');
      assert.equal(router.db.getMeta('focused_decision_id'), dec150.id);

      const followCountBeforeReopen = env.followups.length;
      const plainAfterPrefixReopen = await hub.dispatchAdminWechatMessage!({
        session: 'wxid_admin_demo',
        senderId: 'wxid_admin_demo',
        text: '再把左边距加 4px',
      });
      assert.equal(plainAfterPrefixReopen.handled, true);
      assert.equal(env.followups.length, followCountBeforeReopen + 1);
      assert.equal(env.followups[env.followups.length - 1].sessionId, dec150.workerSessionId);

      const reopenByQuote = await hub.dispatchAdminWechatMessage!({
        session: 'wxid_admin_demo',
        senderId: 'wxid_admin_demo',
        text: '顺便把图例文字调深一点',
        quotedText: '[#152] 图表样式修好了',
      });
      assert.equal(reopenByQuote.handled, true);
      assert.equal(router.listDecisions().find((d) => d.id === dec152.id)?.status, 'notified');
      assert.equal(router.db.getMeta('focused_decision_id'), dec152.id);
      assert.equal(env.followups[env.followups.length - 1].sessionId, dec152.workerSessionId);

      const followCountBeforeQuoteNext = env.followups.length;
      const plainAfterQuoteReopen = await hub.dispatchAdminWechatMessage!({
        session: 'wxid_admin_demo',
        senderId: 'wxid_admin_demo',
        text: '改完截张新图给我',
      });
      assert.equal(plainAfterQuoteReopen.handled, true);
      assert.equal(env.followups.length, followCountBeforeQuoteNext + 1);
      assert.equal(env.followups[env.followups.length - 1].sessionId, dec152.workerSessionId);
    } finally {
      cleanup();
    }
  });

  it('clears stale question/options across multi-round reports, avoids duplicate recommended tags, and uses compact WeChat format only on same-focus follow-ups', async () => {
    let currentNow = new Date('2026-06-10T06:00:00.000Z');
    const sentWechat: WechatSendInput[] = [];
    const { hub, router, cleanup } = createHarness({
      now: () => currentNow,
      initialPolicy: { presenceMode: 'away' },
      controllerId: 'wxid_admin_demo',
      wechatSend: async (input) => {
        sentWechat.push(input);
        return { status: 'sent' };
      },
    });
    const footer = '直接回复就能接着聊；回“下一个”切下一条';
    const url160 = 'https://github.com/org/repo/pull/160';
    const url161 = 'https://github.com/org/repo/pull/161';

    try {
      await hub.ingest(
        makeEvent({
          id: 'evt-compact-160',
          threadKey: 'org/repo#160',
          type: 'github.pr_review_requested',
          summary: 'Refactor notification formatter',
          rawRef: { url: url160, repo: 'org/repo', number: 160 },
        }),
      );
      await hub.ingest(
        makeEvent({
          id: 'evt-compact-161',
          threadKey: 'org/repo#161',
          type: 'github.pr_review_requested',
          summary: 'Fix retry backoff jitter',
          rawRef: { url: url161, repo: 'org/repo', number: 161 },
        }),
      );

      const dec160 = router.listDecisions().find((d) => d.threadKey === 'org/repo#160')!;
      const dec161 = router.listDecisions().find((d) => d.threadKey === 'org/repo#161')!;

      const round1 = await router.submitWorkerReport({
        decisionId: dec160.id,
        conclusion: '第一轮查完了，准备好了改动方案',
        draftText: 'First draft reply.',
        blindspot: '还没在窄屏测',
        question: '先按哪个方案改？',
        options: ['方案A（推荐）', '方案B'],
        recommendedIndex: 0,
        mode: 'discuss',
      });
      assert.equal(round1.question, '先按哪个方案改？');
      assert.deepEqual(round1.options, ['方案A（推荐）', '方案B']);
      assert.equal(round1.recommendedIndex, 0);

      assert.equal(sentWechat.length, 1);
      const msg1 = String(sentWechat[0].text);
      assert.match(msg1, /^\[#160\] 第一轮查完了，准备好了改动方案/);
      assert.match(msg1, /拟发草稿：\nFirst draft reply\./);
      assert.match(msg1, /还没验证：还没在窄屏测/);
      assert.match(msg1, /想确认下：先按哪个方案改？/);
      assert.match(msg1, /可选：1\. 方案A（推荐） \/ 2\. 方案B/);
      assert.doesNotMatch(msg1, /（推荐）（推荐）/);
      assert.equal(msg1.includes(url160), true);
      assert.equal(msg1.includes(footer), true);

      currentNow = new Date('2026-06-10T06:01:00.000Z');
      const round2 = await router.submitWorkerReport({
        decisionId: dec160.id,
        conclusion: '第二轮已改完，不需要再选方案了',
        question: '   ',
        recommendedIndex: 0,
        mode: 'done',
      });
      assert.equal(round2.question, null);
      assert.deepEqual(round2.options, []);
      assert.equal(round2.recommendedIndex, null);
      const persisted2 = router.db.getDecision(dec160.id)!;
      assert.equal(persisted2.question, null);
      assert.deepEqual(persisted2.options, []);
      assert.equal(persisted2.recommendedIndex, null);

      assert.equal(sentWechat.length, 2);
      const msg2 = String(sentWechat[1].text);
      assert.equal(msg2, '[#160] 第二轮已改完，不需要再选方案了');
      assert.equal(msg2.includes('想确认下：'), false);
      assert.equal(msg2.includes('可选：'), false);
      assert.equal(msg2.includes(url160), false);
      assert.equal(msg2.includes(footer), false);

      currentNow = new Date('2026-06-10T06:02:00.000Z');
      const round3 = await router.submitWorkerReport({
        decisionId: dec160.id,
        conclusion: '第三轮补了一版草稿',
        draftText: 'Updated draft text.',
        blindspot: '只跑了单测',
        question: '这份草稿直接发吗？',
        options: ['先留着', '直接发(推荐)', '再改改'],
        recommendedIndex: 1,
        mode: 'review_draft',
      });
      assert.equal(round3.question, '这份草稿直接发吗？');
      assert.deepEqual(round3.options, ['先留着', '直接发(推荐)', '再改改']);
      assert.equal(round3.recommendedIndex, 1);
      const persisted3 = router.db.getDecision(dec160.id)!;
      assert.equal(persisted3.question, '这份草稿直接发吗？');
      assert.deepEqual(persisted3.options, ['先留着', '直接发(推荐)', '再改改']);
      assert.equal(persisted3.recommendedIndex, 1);

      assert.equal(sentWechat.length, 3);
      const msg3 = String(sentWechat[2].text);
      assert.match(msg3, /^\[#160\] 第三轮补了一版草稿/);
      assert.match(msg3, /拟发草稿：\nUpdated draft text\./);
      assert.match(msg3, /还没验证：只跑了单测/);
      assert.match(msg3, /想确认下：这份草稿直接发吗？/);
      assert.match(msg3, /可选：1\. 先留着 \/ 2\. 直接发\(推荐\) \/ 3\. 再改改/);
      assert.doesNotMatch(msg3, /\(推荐\)（推荐）/);
      assert.equal(msg3.includes(url160), false);
      assert.equal(msg3.includes(footer), false);

      currentNow = new Date('2026-06-10T06:03:00.000Z');
      await router.submitWorkerReport({
        decisionId: dec161.id,
        conclusion: '退避抖动定位清楚了',
        question: '按默认上限 30s 改行吗？',
        options: ['按 30s 改', '改成 60s'],
        recommendedIndex: 0,
        mode: 'discuss',
      });
      assert.equal(sentWechat.length, 3);

      const manualSwitch = await hub.dispatchAdminWechatMessage!({
        session: 'wxid_admin_demo',
        senderId: 'wxid_admin_demo',
        text: '#161',
      });
      assert.equal(manualSwitch.handled, true);
      const switchText = manualSwitch.replyText ?? '';
      assert.match(switchText, /^\[#161\] 退避抖动定位清楚了/);
      assert.match(switchText, /可选：1\. 按 30s 改（推荐） \/ 2\. 改成 60s/);
      assert.equal(switchText.includes(url161), true);
      assert.equal(switchText.includes(footer), true);

      currentNow = new Date('2026-06-10T06:04:00.000Z');
      await router.submitWorkerReport({
        decisionId: dec161.id,
        conclusion: '已按 30s 改完并跑过测试',
        mode: 'done',
      });
      assert.equal(sentWechat.length, 4);
      const msg4 = String(sentWechat[3].text);
      assert.equal(msg4, '[#161] 已按 30s 改完并跑过测试');
      assert.equal(msg4.includes(url161), false);
      assert.equal(msg4.includes(footer), false);

      await hub.dispatchAdminWechatMessage!({
        session: 'wxid_admin_demo',
        senderId: 'wxid_admin_demo',
        text: '先放着',
      });
      const backTo160 = await hub.dispatchAdminWechatMessage!({
        session: 'wxid_admin_demo',
        senderId: 'wxid_admin_demo',
        text: '#160',
      });
      assert.equal(backTo160.handled, true);
      assert.equal((backTo160.replyText ?? '').includes(url160), true);
      assert.equal((backTo160.replyText ?? '').includes(footer), true);

      const nextTo161 = await hub.dispatchAdminWechatMessage!({
        session: 'wxid_admin_demo',
        senderId: 'wxid_admin_demo',
        text: '下一个',
      });
      assert.equal(nextTo161.handled, true);
      const nextText = nextTo161.replyText ?? '';
      assert.match(nextText, /^\[#161\]/);
      assert.equal(nextText.includes(url161), true);
      assert.equal(nextText.includes(footer), true);

      currentNow = new Date('2026-06-11T07:00:00.000Z');
      await hub.dispatchAdminWechatMessage!({
        session: 'wxid_admin_demo',
        senderId: 'wxid_admin_demo',
        text: '完成',
      });
      await router.submitWorkerReport({
        decisionId: dec161.id,
        conclusion: '焦点清空后再次汇报应发完整版',
      });
      assert.equal(sentWechat.length, 5);
      const msg5 = String(sentWechat[4].text);
      assert.match(msg5, /^\[#161\] 焦点清空后再次汇报应发完整版/);
      assert.equal(msg5.includes(url161), true);
      assert.equal(msg5.includes(footer), true);

      await hub.ingest(
        makeEvent({
          id: 'evt-compact-162',
          threadKey: 'org/repo#162',
          type: 'github.pr_review_requested',
          summary: 'Check deferred tick full format',
          rawRef: { url: 'https://github.com/org/repo/pull/162', repo: 'org/repo', number: 162 },
        }),
      );
      const dec162 = router.listDecisions().find((d) => d.threadKey === 'org/repo#162')!;
      await router.submitWorkerReport({
        decisionId: dec162.id,
        conclusion: '排队项等待弹出',
      });
      assert.equal(sentWechat.length, 5);

      currentNow = new Date('2026-06-12T08:00:00.000Z');
      const poppedTick = await router.tickDeferred();
      assert.equal(poppedTick.delivered, 1);
      assert.equal(sentWechat.length, 6);
      const msg6 = String(sentWechat[5].text);
      assert.match(msg6, /^\[#162\] 排队项等待弹出/);
      assert.equal(msg6.includes('https://github.com/org/repo/pull/162'), true);
      assert.equal(msg6.includes(footer), true);
    } finally {
      cleanup();
    }
  });
});
