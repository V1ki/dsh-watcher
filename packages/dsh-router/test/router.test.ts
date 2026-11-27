import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { Readable } from 'node:stream';
import {
  apply as applyHub,
  PUBLIC_TAINT_WARNING_TEXT,
  type HubService,
  type NormalizedEvent,
  type WechatSendInput,
} from '@local/dsh-hub';
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

function createMockSessionEnv(options: {
  preserveSessionId?: boolean;
  onPrompt?: (input: Record<string, unknown>) => Promise<unknown> | unknown;
} = {}) {
  const createdWorkspaces: string[] = [];
  const createdSessions: Array<{ workspaceId: string; sessionId: string }> = [];
  const followups: Array<{ sessionId: string; message: unknown }> = [];
  const injected: Array<{ sessionId: string; message: unknown }> = [];
  const prompts: Array<Record<string, unknown>> = [];
  const presetCalls: Array<{ session: unknown; preset: string }> = [];
  const sandboxCalls: Array<{ session: unknown; mode: string }> = [];
  const tools = new Map<string, ToolDefinitionLike>();
  const eventListeners = new Map<string, Array<(...args: any[]) => any>>();

  const workspaceRegistry = {
    resolveByPath: async (workspacePath: string) =>
      createdWorkspaces.includes(workspacePath) ? { id: `ws:${workspacePath}` } : null,
    create: async (workspacePath: string) => {
      createdWorkspaces.push(workspacePath);
      return { id: `ws:${workspacePath}` };
    },
  };

  const sessionController: {
    create: (input: { sessionId?: string; workspaceId?: string; cwd?: string }) => Promise<{ sessionId: string }>;
    resolveAgent: (sessionId: string) => Promise<{
      agent: {
        id: string;
        session: { id: string };
        followup: (message: unknown) => void;
        inject: (message: unknown) => void;
      };
    }>;
    prompt?: (input: Record<string, unknown>) => Promise<unknown>;
  } = {
    create: async (input: { sessionId?: string; workspaceId?: string; cwd?: string }) => {
      const sessionId =
        options.preserveSessionId && input.sessionId
          ? input.sessionId
          : `sess_${createdSessions.length + 1}`;
      createdSessions.push({ workspaceId: input.workspaceId ?? input.cwd ?? '', sessionId });
      return { sessionId };
    },
    resolveAgent: async (sessionId: string) => ({
      agent: {
        id: sessionId,
        session: { id: sessionId },
        followup: (message: unknown) => {
          followups.push({ sessionId, message });
        },
        inject: (message: unknown) => {
          injected.push({ sessionId, message });
        },
      },
    }),
  };

  if (options.onPrompt) {
    sessionController.prompt = async (input: Record<string, unknown>) => {
      prompts.push(input);
      return options.onPrompt!(input);
    };
  }

  const toolsRegistry = {
    register: (def: ToolDefinitionLike) => {
      tools.set(def.name, def);
      return () => {
        tools.delete(def.name);
      };
    },
  };

  const permissionPresets = {
    set: async (session: unknown, preset: string) => {
      presetCalls.push({ session, preset });
    },
  };

  const sandboxPolicy = {
    setMode: async (session: unknown, mode: string) => {
      sandboxCalls.push({ session, mode });
    },
  };

  const on = (
    event: string,
    listener: (...args: any[]) => any,
    opts?: { prepend?: boolean },
  ): (() => void) => {
    const list = eventListeners.get(event) ?? [];
    if (opts?.prepend) {
      list.unshift(listener);
    } else {
      list.push(listener);
    }
    eventListeners.set(event, list);
    return () => {
      const cur = eventListeners.get(event);
      if (!cur) return;
      const idx = cur.indexOf(listener);
      if (idx >= 0) cur.splice(idx, 1);
    };
  };

  const emitEvent = (event: string, ...args: unknown[]): void => {
    for (const listener of [...(eventListeners.get(event) ?? [])]) {
      listener(...args);
    }
  };

  const runMiddleware = async <T>(
    event: string,
    payload: unknown,
    fallback: () => Promise<T> | T,
  ): Promise<T> => {
    const list = [...(eventListeners.get(event) ?? [])];
    const dispatch = async (idx: number): Promise<T> => {
      if (idx >= list.length) {
        return fallback();
      }
      return list[idx](payload, () => dispatch(idx + 1));
    };
    return dispatch(0);
  };

  return {
    createdWorkspaces,
    createdSessions,
    followups,
    injected,
    prompts,
    presetCalls,
    sandboxCalls,
    tools,
    workspaceRegistry,
    sessionController,
    toolsRegistry,
    permissionPresets,
    sandboxPolicy,
    on,
    emitEvent,
    runMiddleware,
  };
}

function createHarness(options: {
  now?: () => Date;
  llm?: RouterPluginConfig['llm'];
  initialPolicy?: RouterPluginConfig['initialPolicy'];
  controllerId?: string;
  homeDir?: string;
  ownerDebounceMs?: number;
  approvalTtlMs?: number;
  legacyWxarcDbPath?: string;
  preserveSessionId?: boolean;
  onPrompt?: (input: Record<string, unknown>) => Promise<unknown> | unknown;
  wechatSend?: (input: WechatSendInput) => Promise<{ status: 'sent' | 'staged' | 'failed'; detail?: string }>;
} = {}) {
  const disposers: Array<() => void> = [];
  const env = createMockSessionEnv({
    preserveSessionId: options.preserveSessionId,
    onPrompt: options.onPrompt,
  });
  const hubServices = new Map<string, unknown>([
    ['workspaceRegistry', env.workspaceRegistry],
    ['sessionController', env.sessionController],
    ['tools', env.toolsRegistry],
    ['permissionPresets', env.permissionPresets],
    ['sandboxPolicy', env.sandboxPolicy],
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
    on: env.on,
  };

  const router = applyRouter(routerCtx, {
    inMemory: true,
    tickIntervalMs: 0,
    now: options.now ?? (() => new Date('2026-06-10T06:00:00.000Z')),
    llm: options.llm,
    homeDir: options.homeDir,
    ownerDebounceMs: options.ownerDebounceMs,
    approvalTtlMs: options.approvalTtlMs,
    legacyWxarcDbPath: options.legacyWxarcDbPath,
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
      assert.equal(reported.summary, 'Root cause isolated and patch staged');
      assert.equal(reported.summary.includes('src/cache.ts'), false);
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
      assert.deepEqual(db1.listTables(), [
        'router_approvals',
        'router_decisions',
        'router_meta',
        'router_notifications',
        'router_task_uses',
      ]);
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
      assert.match(String(sentWechat[0].text), /引用本条或回 #150 接着聊$/);
      assert.equal(String(sentWechat[0].text).includes("下一个"), false);
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

  it('pushes multiple worker reports without focus lock, supports list/quote/#ref routing, and clears stale question/options across rounds', async () => {
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
    const footerFor = (shortId: string) => `引用本条或回 #${shortId} 接着聊`;
    const url160 = 'https://github.com/org/repo/pull/160';
    const url161 = 'https://github.com/org/repo/pull/161';

    try {
      await hub.ingest(
        makeEvent({
          id: 'evt-lockless-160',
          threadKey: 'org/repo#160',
          type: 'github.pr_review_requested',
          summary: 'Refactor notification formatter',
          rawRef: { url: url160, repo: 'org/repo', number: 160 },
        }),
      );
      await hub.ingest(
        makeEvent({
          id: 'evt-lockless-161',
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
        imagePath: '/tmp/header-v1.png',
        mode: 'discuss',
      });
      assert.equal(round1.question, '先按哪个方案改？');
      assert.equal(sentWechat.length, 1);
      assert.equal(sentWechat[0].imagePath, '/tmp/header-v1.png');
      assert.equal(router.db.getMeta('focused_decision_id'), undefined);
      const msg1 = String(sentWechat[0].text);
      assert.match(msg1, /^\[#160\] 第一轮查完了，准备好了改动方案/);
      assert.match(msg1, /拟发草稿：\nFirst draft reply\./);
      assert.match(msg1, /还没验证：还没在窄屏测/);
      assert.match(msg1, /想确认下：先按哪个方案改？/);
      assert.match(msg1, /可选：1\. 方案A（推荐） \/ 2\. 方案B/);
      assert.doesNotMatch(msg1, /（推荐）（推荐）/);
      assert.equal(msg1.includes(url160), true);
      assert.equal(msg1.includes(footerFor('160')), true);
      assert.equal(msg1.includes('下一个'), false);

      currentNow = new Date('2026-06-10T06:01:00.000Z');
      await router.submitWorkerReport({
        decisionId: dec161.id,
        conclusion: '退避抖动定位清楚了',
        question: '按默认上限 30s 改行吗？',
        options: ['按 30s 改', '改成 60s'],
        recommendedIndex: 0,
        mode: 'discuss',
      });
      assert.equal(sentWechat.length, 2);
      const msg161 = String(sentWechat[1].text);
      assert.match(msg161, /^\[#161\] 退避抖动定位清楚了/);
      assert.equal(msg161.includes(url161), true);
      assert.equal(msg161.includes(footerFor('161')), true);

      currentNow = new Date('2026-06-10T06:02:00.000Z');
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
      assert.equal(sentWechat.length, 3);
      assert.notEqual(sentWechat[2].idempotencyKey, sentWechat[0].idempotencyKey);
      assert.equal(String(sentWechat[2].text).includes('想确认下：'), false);
      assert.equal(String(sentWechat[2].text).includes('可选：'), false);

      const listRes = await hub.dispatchAdminWechatMessage!({
        session: 'wxid_admin_demo',
        senderId: 'wxid_admin_demo',
        text: '列表',
      });
      assert.equal(listRes.handled, true);
      assert.match(listRes.replyText ?? '', /\[#160\]/);
      assert.match(listRes.replyText ?? '', /\[#161\]/);

      const followBefore = env.followups.length;
      const quoteRes = await hub.dispatchAdminWechatMessage!({
        session: 'wxid_admin_demo',
        senderId: 'wxid_admin_demo',
        text: '字号再调大 2px 看看',
        quotedText: '[#160] 第一轮查完了',
      });
      assert.equal(quoteRes.handled, true);
      assert.equal(env.followups.length, followBefore + 1);
      assert.equal(env.followups[env.followups.length - 1].sessionId, dec160.workerSessionId);

      const prefixRes = await hub.dispatchAdminWechatMessage!({
        session: 'wxid_admin_demo',
        senderId: 'wxid_admin_demo',
        text: '#161 把重试间隔改成 3 秒',
      });
      assert.equal(prefixRes.handled, true);
      assert.equal(env.followups.length, followBefore + 2);
      assert.equal(env.followups[env.followups.length - 1].sessionId, dec161.workerSessionId);

      const cardRes = await hub.dispatchAdminWechatMessage!({
        session: 'wxid_admin_demo',
        senderId: 'wxid_admin_demo',
        text: '#161',
      });
      assert.equal(cardRes.handled, true);
      assert.match(cardRes.replyText ?? '', /^\[#161\]/);
      assert.equal((cardRes.replyText ?? '').includes(footerFor('161')), true);
    } finally {
      cleanup();
    }
  });

  it('keeps submitWorkerReport summary slim without appending changes and enforces concise brief/tool/followup rules', async () => {
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
          id: 'evt-slim-210',
          threadKey: 'org/repo#210',
          type: 'github.pr_review_requested',
          summary: 'Check PR #210 error handling',
        }),
      );
      const dec210 = router.listDecisions().find((d) => d.threadKey === 'org/repo#210')!;
      assert.ok(dec210);

      const briefText = (env.followups[0].message as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? '';
      assert.match(briefText, /200 字以内/);
      assert.match(briefText, /3–6 句话/);
      assert.match(briefText, /500–600 字符/);
      assert.match(briefText, /不会自动发到 GitHub/);

      const reportTool = env.tools.get('router_report_result')!;
      assert.match(reportTool.description, /200 chars/);
      assert.match(reportTool.description, /NEVER posted to GitHub automatically/);
      const props = (reportTool.inputSchema as { properties?: Record<string, { description?: string }> }).properties!;
      assert.match(props.conclusion.description ?? '', /200 chars/);
      assert.match(props.draftText.description ?? '', /3-6 concise sentences/);
      assert.match(props.draftText.description ?? '', /NEVER posts to GitHub automatically/);

      const reported = await router.submitWorkerReport({
        decisionId: dec210.id,
        conclusion: '已定位空指针风险，建议先补空值保护再合并。',
        changes: [
          'packages/core/src/long-path/handler.ts: handleEvent()',
          'packages/core/test/long-path/handler.test.ts: added 5 cases',
        ],
        draftText: '空指针路径还没兜底，建议在 parsePayload 里加空值判断并补一条回归测试，改完就能合。',
        mode: 'review_draft',
      });

      assert.equal(reported.summary, '已定位空指针风险，建议先补空值保护再合并。');
      assert.equal(reported.summary.includes('handler.ts'), false);
      assert.equal(sentWechat.length, 1);
      assert.equal(String(sentWechat[0].text).includes('handler.ts'), false);
      assert.match(String(sentWechat[0].text), /^\[#210\] 已定位空指针风险，建议先补空值保护再合并。/);

      const followupCount = env.followups.length;
      const adminReply = await hub.dispatchAdminWechatMessage!({
        session: 'wxid_admin_demo',
        senderId: 'wxid_admin_demo',
        text: '语气再直接一点',
        quotedText: '[#210] 已定位空指针风险，建议先补空值保护再合并。',
      });
      assert.equal(adminReply.handled, true);
      assert.equal(env.followups.length, followupCount + 1);
      const followupText =
        (env.followups[env.followups.length - 1].message as { content?: Array<{ text?: string }> }).content?.[0]?.text ??
        '';
      assert.match(followupText, /200 字以内/);
      assert.match(followupText, /3–6 句话/);
      assert.match(followupText, /不会自动发到 GitHub/);
    } finally {
      cleanup();
    }
  });

  it('uses 2400 maxTokens, retries once on invalid JSON, logs bounded snippet, and fails open to prepare for open GitHub updates while keeping guardrails', async () => {
    const seenMaxTokens: Array<number | undefined> = [];
    let attemptCount = 0;
    const warnings: string[] = [];

    const retrySuccessLlm: TriageLlmLike = {
      prepareCall: async (cfg) => {
        seenMaxTokens.push(cfg.maxTokens);
        return {
          config: cfg,
          async *stream() {
            attemptCount += 1;
            if (attemptCount === 1) {
              yield { type: 'text-delta', text: '{"level":"prepare","summary":"truncated without closing brace' };
              return;
            }
            yield {
              type: 'text-delta',
              text: JSON.stringify({
                level: 'prepare',
                summary: 'Issue #249 crash bug confirmed',
                reason: 'llm_retry_ok',
                shouldDispatchWorker: true,
                urgent: false,
                personaId: null,
                question: null,
                options: [],
                recommendedIndex: null,
              }),
            };
          },
        };
      },
    };

    const retryOk = await triageEvent({
      event: makeEvent({
        id: 'evt-retry-ok',
        type: 'github.issue.updated',
        threadKey: 'org/repo#249',
        payload: { state: 'open' },
      }),
      policy: DEFAULT_ATTENTION_POLICY,
      llm: retrySuccessLlm,
      logger: { warn: (msg) => warnings.push(msg) },
    });
    assert.deepEqual(seenMaxTokens, [2400, 2400]);
    assert.equal(attemptCount, 2);
    assert.equal(retryOk.usedLlm, true);
    assert.equal(retryOk.level, 'prepare');
    assert.equal(retryOk.reason, 'llm_retry_ok');
    assert.equal(warnings.length, 0);

    let failedCalls = 0;
    const alwaysBrokenText = `not-json-${'x'.repeat(350)}`;
    const alwaysInvalidLlm: TriageLlmLike = {
      complete: async () => {
        failedCalls += 1;
        return alwaysBrokenText;
      },
    };

    const openIssueFailOpen = await triageEvent({
      event: makeEvent({
        id: 'evt-failopen-issue-250',
        type: 'github.issue.updated',
        threadKey: 'org/repo#250',
        trustLevel: 'untrusted',
        payload: { state: 'open', title: 'Crash on missing CLI' },
      }),
      policy: { ...DEFAULT_ATTENTION_POLICY, defaultMaxLevel: 'act' },
      llm: alwaysInvalidLlm,
      logger: { warn: (msg) => warnings.push(msg) },
    });
    assert.equal(failedCalls, 2);
    assert.equal(openIssueFailOpen.usedLlm, false);
    assert.equal(openIssueFailOpen.level, 'prepare');
    assert.equal(openIssueFailOpen.shouldDispatchWorker, true);
    assert.match(openIssueFailOpen.reason, /llm_fail_open:triage_llm_invalid_json/);
    assert.match(openIssueFailOpen.reason, /deterministic_fail_open_github\.issue\.updated/);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /triage_llm_invalid_json/);
    assert.equal(warnings[0].includes('x'.repeat(250)), false);

    const openPrFailOpen = await triageEvent({
      event: makeEvent({
        id: 'evt-failopen-pr-251',
        type: 'github.pr.updated',
        threadKey: 'org/repo#251',
        trustLevel: 'owner',
        payload: { state: 'open', isPr: true },
      }),
      policy: DEFAULT_ATTENTION_POLICY,
      llm: alwaysInvalidLlm,
      logger: { warn: (msg) => warnings.push(msg) },
    });
    assert.equal(openPrFailOpen.level, 'prepare');
    assert.equal(openPrFailOpen.shouldDispatchWorker, true);

    const closedIssueFailOpen = await triageEvent({
      event: makeEvent({
        id: 'evt-failopen-closed-252',
        type: 'github.issue.updated',
        threadKey: 'org/repo#252',
        payload: { state: 'closed' },
      }),
      policy: DEFAULT_ATTENTION_POLICY,
      llm: alwaysInvalidLlm,
      logger: { warn: (msg) => warnings.push(msg) },
    });
    assert.equal(closedIssueFailOpen.level, 'inform');
    assert.equal(closedIssueFailOpen.shouldDispatchWorker, false);

    const mergedPrFailOpen = await triageEvent({
      event: makeEvent({
        id: 'evt-failopen-merged-253',
        type: 'github.pr.updated',
        threadKey: 'org/repo#253',
        payload: { state: 'closed', merged: true },
      }),
      policy: DEFAULT_ATTENTION_POLICY,
      llm: alwaysInvalidLlm,
      logger: { warn: (msg) => warnings.push(msg) },
    });
    assert.equal(mergedPrFailOpen.level, 'inform');
    assert.equal(mergedPrFailOpen.shouldDispatchWorker, false);

    const callsBeforeBot = failedCalls;
    const botUpdate = await triageEvent({
      event: makeEvent({
        id: 'evt-failopen-bot-254',
        type: 'github.issue.updated',
        threadKey: 'org/repo#254',
        actor: { id: 'gh-bot', login: 'github-actions[bot]', isBot: true },
        payload: { state: 'open' },
      }),
      policy: DEFAULT_ATTENTION_POLICY,
      llm: alwaysInvalidLlm,
      logger: { warn: (msg) => warnings.push(msg) },
    });
    assert.equal(failedCalls, callsBeforeBot);
    assert.equal(botUpdate.level, 'ignore');
    assert.equal(botUpdate.reason, 'bot_self_filtered');
  });

  it('deduplicates deferred rows in-place on repeated reports and retries cleanly when WeChat delivery recovers', async () => {
    let currentNow = new Date('2026-06-13T06:00:00.000Z');
    let failWechat = false;
    const sentWechat: WechatSendInput[] = [];
    const { hub, router, cleanup } = createHarness({
      now: () => currentNow,
      initialPolicy: { presenceMode: 'away' },
      controllerId: 'wxid_admin_demo',
      wechatSend: async (input) => {
        if (failWechat) {
          return { status: 'failed', detail: 'simulated_send_error' };
        }
        sentWechat.push(input);
        return { status: 'sent' };
      },
    });
    try {
      await hub.ingest(
        makeEvent({
          id: 'evt-defer-241',
          threadKey: 'org/repo#241',
          type: 'github.pr_review_requested',
          summary: 'Weekend PR #241',
        }),
      );
      await hub.ingest(
        makeEvent({
          id: 'evt-defer-248',
          threadKey: 'org/repo#248',
          type: 'github.pr_review_requested',
          summary: 'Weekend PR #248',
        }),
      );

      const dec241 = router.listDecisions().find((d) => d.threadKey === 'org/repo#241')!;
      const dec248 = router.listDecisions().find((d) => d.threadKey === 'org/repo#248')!;

      await router.submitWorkerReport({
        decisionId: dec241.id,
        conclusion: '#241 第一版汇报',
      });
      const first241 = router.listNotifications({ decisionId: dec241.id, status: 'deferred' });
      assert.equal(first241.length, 1);
      const firstId = first241[0].id;
      const firstCreatedAt = first241[0].createdAt;

      currentNow = new Date('2026-06-13T06:02:00.000Z');
      await router.submitWorkerReport({
        decisionId: dec248.id,
        conclusion: '#248 周末汇报',
      });

      currentNow = new Date('2026-06-13T06:04:00.000Z');
      await router.submitWorkerReport({
        decisionId: dec241.id,
        conclusion: '#241 最新覆写汇报',
      });

      const deduped241 = router.listNotifications({ decisionId: dec241.id, status: 'deferred' });
      assert.equal(deduped241.length, 1);
      assert.equal(deduped241[0].id, firstId);
      assert.equal(deduped241[0].createdAt, firstCreatedAt);
      assert.equal(deduped241[0].summary, '#241 最新覆写汇报');

      currentNow = new Date('2026-06-15T02:00:00.000Z');
      failWechat = true;
      const failedTick = await router.tickDeferred();
      assert.equal(failedTick.delivered, 0);
      assert.match(
        router.listNotifications({ decisionId: dec241.id, status: 'deferred' })[0].reason,
        /wechat_delivery_failed/,
      );

      failWechat = false;
      currentNow = new Date('2026-06-15T02:01:00.000Z');
      const recoveredTick = await router.tickDeferred();
      assert.equal(recoveredTick.delivered, 2);
      assert.equal(sentWechat.length, 2);
      assert.match(String(sentWechat[0].text), /^\[#241\] #241 最新覆写汇报/);
      assert.match(String(sentWechat[1].text), /^\[#248\] #248 周末汇报/);
      assert.equal(router.listNotifications({ status: 'deferred' }).length, 0);
    } finally {
      cleanup();
    }
  });

  it('routes plain admin WeChat messages to owner_session asynchronously without ever hijacking task Workers', async () => {
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
          id: 'evt-no-hijack-247',
          threadKey: 'org/repo#247',
          type: 'github.pr_review_requested',
          summary: 'Review PR #247 config migration',
        }),
      );
      const dec247 = router.listDecisions().find((d) => d.threadKey === 'org/repo#247')!;
      await router.submitWorkerReport({
        decisionId: dec247.id,
        conclusion: 'PR #247 配置迁移查完了，建议补一条兼容性单测。',
        mode: 'discuss',
      });

      const workerFollowupsBefore = env.followups.filter((f) => f.sessionId === dec247.workerSessionId).length;
      const plainRes = await hub.dispatchAdminWechatMessage!({
        session: 'wxid_admin_demo',
        senderId: 'wxid_admin_demo',
        text: '帮我查一下明天的天气',
      });
      assert.equal(plainRes.handled, true);
      assert.equal(plainRes.replyText, undefined);
      const workerFollowupsAfter = env.followups.filter((f) => f.sessionId === dec247.workerSessionId).length;
      assert.equal(workerFollowupsAfter, workerFollowupsBefore);

      const quoteRes = await hub.dispatchAdminWechatMessage!({
        session: 'wxid_admin_demo',
        senderId: 'wxid_admin_demo',
        text: '把边界用例补全再推一版',
        quotedText: '[#247] PR #247 配置迁移查完了',
      });
      assert.equal(quoteRes.handled, true);
      const workerFollowupsAfterQuote = env.followups.filter((f) => f.sessionId === dec247.workerSessionId).length;
      assert.equal(workerFollowupsAfterQuote, workerFollowupsBefore + 1);
    } finally {
      cleanup();
    }
  });

  it('merges >=3 due deferred notifications into 1 lockless summary card and auto-resolves on hub.onThreadLifecycle', async () => {
    let currentNow = new Date('2026-06-13T06:00:00.000Z');
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
      for (const num of [301, 302, 303, 304]) {
        await hub.ingest(
          makeEvent({
            id: `evt-batch-${num}`,
            threadKey: `github:org/repo#${num}`,
            type: 'github.pr_review_requested',
            summary: `Weekend PR #${num}`,
          }),
        );
      }

      const dec301 = router.listDecisions().find((d) => d.threadKey === 'github:org/repo#301')!;
      const dec302 = router.listDecisions().find((d) => d.threadKey === 'github:org/repo#302')!;
      const dec303 = router.listDecisions().find((d) => d.threadKey === 'github:org/repo#303')!;
      const dec304 = router.listDecisions().find((d) => d.threadKey === 'github:org/repo#304')!;

      await router.submitWorkerReport({ decisionId: dec301.id, conclusion: 'PR #301 查完了' });
      await router.submitWorkerReport({ decisionId: dec302.id, conclusion: 'PR #302 查完了' });
      await router.submitWorkerReport({ decisionId: dec303.id, conclusion: 'PR #303 查完了' });
      await router.submitWorkerReport({ decisionId: dec304.id, conclusion: 'PR #304 已准备合并' });
      assert.equal(router.listNotifications({ status: 'deferred' }).length, 4);

      hub.setSessionTurnOverride(dec304.workerSessionId!, 3, 60_000);
      assert.equal(hub.resolveSessionPrincipal({ agent: { id: dec304.workerSessionId! } }).tier, 3);

      const lifecycleRes = await hub.ingest(
        makeEvent({
          id: 'evt-lifecycle-merged-304',
          threadKey: 'github:org/repo#304',
          type: 'github.pr.merged',
          actor: { id: 'gh-bot', login: 'github-actions[bot]', isBot: true },
          payload: { state: 'closed', merged: true, lifecycleOnly: true },
          summary: 'PR #304 merged by bot',
        }),
      );
      assert.equal(lifecycleRes.routedVia, 'lifecycle');
      assert.equal(router.db.getDecision(dec304.id)?.status, 'resolved');
      assert.equal(router.listNotifications({ decisionId: dec304.id, status: 'deferred' }).length, 0);
      assert.equal(hub.resolveSessionPrincipal({ agent: { id: dec304.workerSessionId! } }).tier, 1);

      currentNow = new Date('2026-06-15T02:00:00.000Z');
      const tickRes = await router.tickDeferred();
      assert.equal(tickRes.delivered, 3);
      assert.equal(sentWechat.length, 1);
      const summaryText = String(sentWechat[0].text);
      assert.match(summaryText, /你有 3 条待处理更新：/);
      assert.match(summaryText, /\[#301\] PR #301 查完了/);
      assert.match(summaryText, /\[#302\] PR #302 查完了/);
      assert.match(summaryText, /\[#303\] PR #303 查完了/);
      assert.equal(summaryText.includes('#304'), false);
      assert.match(summaryText, /引用或回 #编号 可直接处理对应任务/);
      assert.equal(summaryText.includes('下一个'), false);
      assert.equal(router.listNotifications({ status: 'deferred' }).length, 0);

      assert.equal(env.injected.length, 1);
      const receiptText = (env.injected[0].message as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? '';
      assert.match(receiptText, /\[已推送给主人\] \[#301\] PR #301 查完了/);
      assert.match(receiptText, /\[已推送给主人\] \[#302\] PR #302 查完了/);
      assert.match(receiptText, /\[已推送给主人\] \[#303\] PR #303 查完了/);
    } finally {
      cleanup();
    }
  });

  it('bridges owner_session asynchronously with debounce, multimodal fields, silent push receipts, and enforces bridge tool auth', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-router-owner-'));
    const sentWechat: WechatSendInput[] = [];
    const { hub, router, env, cleanup } = createHarness({
      homeDir: tmpHome,
      ownerDebounceMs: 15,
      preserveSessionId: true,
      initialPolicy: { presenceMode: 'away' },
      controllerId: 'wxid_admin_demo',
      onPrompt: async () => ({ ok: true }),
      wechatSend: async (input) => {
        sentWechat.push(input);
        return { status: 'sent' };
      },
    });
    try {
      await hub.ingest(
        makeEvent({
          id: 'evt-bridge-310',
          threadKey: 'github:org/repo#310',
          type: 'github.pr_review_requested',
          summary: 'Review PR #310 bridge tool test',
        }),
      );
      const dec310 = router.listDecisions().find((d) => d.threadKey === 'github:org/repo#310')!;
      await router.submitWorkerReport({
        decisionId: dec310.id,
        conclusion: 'PR #310 结论已就绪',
        mode: 'discuss',
      });

      const ownerSid = router.ownerSession.getSessionId()!;
      assert.ok(ownerSid);
      assert.equal(hub.getSessionPrincipal(ownerSid)?.role, 'owner_session');
      assert.equal(hub.getSessionPrincipal(ownerSid)?.tier, 3);
      assert.equal(env.injected.length, 1);
      assert.equal(env.injected[0].sessionId, ownerSid);
      const injectText = (env.injected[0].message as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? '';
      assert.match(injectText, /^\[已推送给主人\] \[#310\] PR #310 结论已就绪$/);
      assert.equal(env.prompts.length, 0);

      const res1 = await hub.dispatchAdminWechatMessage!({
        session: 'wxid_admin_demo',
        senderId: 'wxid_admin_demo',
        text: '先帮我看下这张截图',
        imagePath: '/tmp/screenshot.png',
      });
      const res2 = await hub.dispatchAdminWechatMessage!({
        session: 'wxid_admin_demo',
        senderId: 'wxid_admin_demo',
        text: '还有刚才那条语音',
        voiceTranscript: '明天上午十点开会',
        articleSummary: '架构周报摘要',
        mediaPaths: ['/tmp/audio.silk'],
      });
      assert.equal(res1.handled, true);
      assert.equal(res2.handled, true);
      assert.equal(res1.replyText, undefined);
      assert.equal(res2.replyText, undefined);

      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(env.prompts.length, 1);
      assert.equal(env.prompts[0].sessionId, ownerSid);
      const promptBody = (env.prompts[0].content as Array<{ text?: string }>)[0]?.text ?? '';
      assert.match(promptBody, /先帮我看下这张截图/);
      assert.match(promptBody, /\[图片路径\] \/tmp\/screenshot\.png/);
      assert.match(promptBody, /\[语音转写\] 明天上午十点开会/);
      assert.match(promptBody, /\[文章摘要\] 架构周报摘要/);
      assert.match(promptBody, /\[媒体文件\] \/tmp\/audio\.silk/);

      hub.markTurnPrivateRead(ownerSid);
      assert.equal(hub.isTurnPrivateRead(ownerSid), true);

      env.emitEvent('session/event', { id: ownerSid }, { type: 'turn/start', data: { turn: 1 } });
      env.emitEvent('session/event', { id: ownerSid }, {
        type: 'assistant/message',
        data: { turn: 1, message: { content: [{ type: 'text', text: '收到，已经记好明天十点会议。' }] } },
      });
      env.emitEvent('session/event', { id: ownerSid }, {
        type: 'turn/end',
        data: { turn: 1, reason: { kind: 'completed' } },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.equal(hub.isTurnPrivateRead(ownerSid), false);
      const ownerReply = sentWechat.find((m) => String(m.idempotencyKey ?? '').startsWith('router-owner-reply:'));
      assert.ok(ownerReply);
      assert.equal(ownerReply.text, '收到，已经记好明天十点会议。');
      assert.equal(ownerReply.chatId, 'wxid_admin_demo');

      const tasksTool = env.tools.get('router_tasks')!;
      const sendTool = env.tools.get('router_send_to_task')!;
      const reportTool = env.tools.get('router_report_result')!;

      await assert.rejects(() => tasksTool.execute({}, undefined), /router_tasks_forbidden/);
      await assert.rejects(
        () => tasksTool.execute({}, { agent: { id: dec310.workerSessionId! } }),
        /router_tasks_forbidden/,
      );
      await assert.rejects(
        () =>
          tasksTool.execute(
            {},
            {
              agent: {
                id: 'sub-owner-1',
                session: { header: { delegationDepth: 1, parentSessionId: ownerSid } },
              },
            },
          ),
        /router_tasks_forbidden/,
      );

      const tasksResult = (await tasksTool.execute({}, { agent: { id: ownerSid } })) as {
        ok: boolean;
        tasks: Array<{ shortId: string }>;
      };
      assert.equal(tasksResult.ok, true);
      assert.equal(tasksResult.tasks.some((t) => t.shortId === '310'), true);

      const interactiveTasks = (await tasksTool.execute({}, { agent: { id: 'interactive-web-1' } })) as {
        ok: boolean;
      };
      assert.equal(interactiveTasks.ok, true);

      const followBefore = env.followups.length;
      const sendRes = (await sendTool.execute(
        { action: 'message', taskRef: '#310', message: '按刚才微信讨论的方案补一条说明' },
        { agent: { id: ownerSid } },
      )) as { ok: boolean; delivered: boolean };
      assert.equal(sendRes.ok, true);
      assert.equal(sendRes.delivered, true);
      assert.equal(env.followups.length, followBefore + 1);
      assert.equal(hub.resolveSessionPrincipal({ agent: { id: dec310.workerSessionId! } }).tier, 3);

      hub.registerSink({
        id: 'mock-sink',
        label: 'Mock Sink',
        kind: 'staged-draft',
        invoke: async () => ({ status: 'executed', detail: 'sent' }),
      });
      const staged1 = await hub.invokeSink('mock-sink', {
        action: 'post_comment',
        target: { repo: 'org/repo', number: 310 },
        payload: { text: 'draft-approve' },
        idempotencyKey: 'draft-approve-1',
        stageOnly: true,
      });
      const staged2 = await hub.invokeSink('mock-sink', {
        action: 'post_comment',
        target: { repo: 'org/repo', number: 310 },
        payload: { text: 'draft-discard' },
        idempotencyKey: 'draft-discard-2',
        stageOnly: true,
      });

      const approveRes = (await sendTool.execute(
        { action: 'approve_draft', draftId: staged1.draftId },
        { agent: { id: ownerSid } },
      )) as { ok: boolean };
      assert.equal(approveRes.ok, true);
      const discardRes = (await sendTool.execute(
        { action: 'discard_draft', draftId: staged2.draftId, reason: 'not_needed' },
        { agent: { id: ownerSid } },
      )) as { ok: boolean; discarded: boolean };
      assert.equal(discardRes.discarded, true);

      await assert.rejects(
        () =>
          reportTool.execute(
            { decisionId: dec310.id, conclusion: 'unauthorized' },
            { agent: { id: ownerSid } },
          ),
        /router_report_result_forbidden/,
      );
      await assert.rejects(
        () =>
          reportTool.execute(
            { decisionId: dec310.id, conclusion: 'subagent unauthorized' },
            {
              agent: {
                id: 'sub-worker-1',
                session: { header: { delegationDepth: 1, parentSessionId: dec310.workerSessionId! } },
              },
            },
          ),
        /router_report_result_forbidden/,
      );
      const validReport = (await reportTool.execute(
        { decisionId: dec310.id, conclusion: '合法 Worker 回报' },
        { agent: { id: dec310.workerSessionId! } },
      )) as { ok: boolean };
      assert.equal(validReport.ok, true);
    } finally {
      cleanup();
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('registers four-tier Worker principals with native sandbox, warms up historical Workers on startup, and enforces public PR single-turn elevation, fallback, and taint warning', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-router-tier-'));
    const sentWechat: WechatSendInput[] = [];
    const { hub, router, env, cleanup } = createHarness({
      initialPolicy: { presenceMode: 'away', defaultMaxLevel: 'act' },
      controllerId: 'wxid_admin_demo',
      preserveSessionId: true,
      llm: {
        complete: async (req) => {
          const isAct = req.prompt.includes('Act PR #323');
          return JSON.stringify({
            level: isAct ? 'act' : 'prepare',
            summary: isAct ? 'Act PR #323' : 'Prepared task',
            reason: 'llm_test',
            shouldDispatchWorker: true,
            urgent: false,
          });
        },
      },
      wechatSend: async (input) => {
        sentWechat.push(input);
        return { status: 'sent' };
      },
    });
    try {
      await hub.ingest(
        makeEvent({
          id: 'evt-tier-1',
          source: 'github',
          threadKey: 'github:org/public-repo#321',
          actor: { id: 'stranger', login: 'stranger', isBot: false },
          trustLevel: 'untrusted',
          summary: 'Stranger PR #321',
          rawRef: { url: 'https://github.com/org/public-repo/pull/321', repo: 'org/public-repo', number: 321 },
        }),
      );
      const dec1 = router.listDecisions().find((d) => d.threadKey === 'github:org/public-repo#321')!;
      const p1 = hub.getSessionPrincipal(dec1.workerSessionId!)!;
      assert.equal(p1.tier, 1);
      assert.equal(p1.targetCircle, 'external');
      assert.equal(p1.boundRepo, 'org/public-repo');
      assert.equal(env.presetCalls[0]?.preset, 'read-only');
      assert.equal(env.sandboxCalls[0]?.mode, 'read-only');

      await hub.ingest(
        makeEvent({
          id: 'evt-tier-2-priv',
          source: 'github',
          threadKey: 'github:corp/private-repo#322',
          actor: { id: 'coworker', login: 'coworker', isBot: false },
          trustLevel: 'triage',
          payload: { private: true },
          summary: 'Private repo PR #322',
          rawRef: { url: 'https://github.com/corp/private-repo/pull/322', repo: 'corp/private-repo', number: 322 },
        }),
      );
      const dec2 = router.listDecisions().find((d) => d.threadKey === 'github:corp/private-repo#322')!;
      assert.equal(hub.getSessionPrincipal(dec2.workerSessionId!)?.tier, 2);
      assert.equal(hub.getSessionPrincipal(dec2.workerSessionId!)?.targetCircle, 'work');

      await hub.ingest(
        makeEvent({
          id: 'evt-tier-2-dt',
          source: 'dingtalk',
          threadKey: 'dingtalk:cid_work_1',
          type: 'dingtalk.task',
          actor: { id: 'colleague', login: 'colleague', isBot: false },
          trustLevel: 'triage',
          summary: 'DingTalk work task',
        }),
      );
      const decDt = router.listDecisions().find((d) => d.threadKey === 'dingtalk:cid_work_1')!;
      assert.equal(hub.getSessionPrincipal(decDt.workerSessionId!)?.tier, 2);

      await hub.ingest(
        makeEvent({
          id: 'evt-tier-3-act',
          source: 'github',
          threadKey: 'github:org/public-repo#323',
          actor: { id: 'owner', login: 'owner', isBot: false },
          trustLevel: 'owner',
          summary: 'Act PR #323',
          rawRef: { url: 'https://github.com/org/public-repo/pull/323', repo: 'org/public-repo', number: 323 },
        }),
      );
      const dec3 = router.listDecisions().find((d) => d.threadKey === 'github:org/public-repo#323')!;
      assert.equal(hub.getSessionPrincipal(dec3.workerSessionId!)?.tier, 3);
      assert.equal(env.sandboxCalls.at(-1)?.mode, 'workspace-write');

      assert.deepEqual(
        hub.resolveSessionPrincipal({ agent: { id: dec1.workerSessionId! } }).allowedCircles,
        ['external'],
      );
      const quoteElevation = await hub.dispatchAdminWechatMessage!({
        session: 'wxid_admin_demo',
        senderId: 'wxid_admin_demo',
        text: '结合微信里刚才聊的背景看一下',
        quotedText: '[#321] Stranger PR #321',
      });
      assert.equal(quoteElevation.handled, true);
      const elevated = hub.resolveSessionPrincipal({ agent: { id: dec1.workerSessionId! } });
      assert.equal(elevated.tier, 3);
      assert.equal(elevated.allowedCircles.includes('owner_private'), true);

      hub.markSessionTainted(dec1.workerSessionId!, 'vault_search:owner_private');
      await router.submitWorkerReport({
        decisionId: dec1.id,
        conclusion: '已结合内部背景整理好评审意见',
        draftText: 'Please add a null check before accessing config.',
        mode: 'review_draft',
      });
      assert.equal(sentWechat.length, 1);
      assert.equal(String(sentWechat[0].text).startsWith(PUBLIC_TAINT_WARNING_TEXT), true);
      assert.equal(hub.resolveSessionPrincipal({ agent: { id: dec1.workerSessionId! } }).tier, 1);

      hub.setSessionTurnOverride(dec1.workerSessionId!, 3, 60_000);
      assert.equal(hub.resolveSessionPrincipal({ agent: { id: dec1.workerSessionId! } }).tier, 3);
      await hub.ingest(
        makeEvent({
          id: 'evt-tier-1-external-followup',
          source: 'github',
          threadKey: 'github:org/public-repo#321',
          type: 'github.issue_comment',
          actor: { id: 'stranger', login: 'stranger', isBot: false },
          trustLevel: 'untrusted',
          summary: 'External follow-up comment',
        }),
      );
      const afterExternal = hub.resolveSessionPrincipal({ agent: { id: dec1.workerSessionId! } });
      assert.equal(afterExternal.tier, 1);
      assert.equal(afterExternal.tainted, true);

      const dbPath = path.join(tmpDir, 'router-state');
      const seededDb = openRouterDb({ stateDir: dbPath });
      seededDb.setMeta('owner_session_id', 'persisted-owner-sid');
      seededDb.upsertDecision({
        ...dec1,
        id: 'hist-dec-1',
        workerSessionId: 'hist-worker-1',
        trustLevel: 'untrusted',
        targetCircle: 'external',
      });
      seededDb.upsertDecision({
        ...dec2,
        id: 'hist-dec-2',
        workerSessionId: 'hist-worker-2',
        trustLevel: 'triage',
        targetCircle: 'work',
      });
      seededDb.close();

      const hub2 = applyHub({}, { inMemory: true, tickIntervalMs: 0 });
      const router2 = applyRouter(
        { hub: hub2 },
        { stateDir: dbPath, tickIntervalMs: 0 },
      );
      try {
        assert.equal(hub2.getSessionPrincipal('persisted-owner-sid')?.role, 'owner_session');
        assert.equal(hub2.getSessionPrincipal('persisted-owner-sid')?.tier, 3);
        assert.equal(hub2.getSessionPrincipal('hist-worker-1')?.role, 'worker');
        assert.equal(hub2.getSessionPrincipal('hist-worker-1')?.tier, 1);
        assert.equal(hub2.getSessionPrincipal('hist-worker-1')?.boundRepo, 'org/public-repo');
        assert.equal(hub2.getSessionPrincipal('hist-worker-2')?.tier, 2);
      } finally {
        router2.dispose();
        router2.db.close();
        hub2.db.close();
      }
    } finally {
      cleanup();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('migrates legacy wechat_approvals read-only and enforces RouterApprovals + tools/pre-execute guardrails', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-router-approvals-'));
    const legacyDbPath = path.join(tmpDir, 'legacy-events.sqlite');
    const legacyDb = new DatabaseSync(legacyDbPath);
    legacyDb.exec(`
      CREATE TABLE wechat_approvals (
        code TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        call_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        args TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        status TEXT NOT NULL,
        notice_status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        decision_source TEXT,
        detail TEXT NOT NULL,
        notified_at INTEGER,
        task_eligible INTEGER NOT NULL,
        scope TEXT NOT NULL
      );
      CREATE TABLE wechat_task_uses (
        run_id TEXT NOT NULL,
        call_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        grant_code TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    legacyDb
      .prepare('INSERT INTO wechat_approvals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        'AAAA1111',
        'old-run-1',
        'old-sess-1',
        'call-1',
        'bash',
        '{"command":"rm -rf /tmp/a"}',
        'wxid_admin_demo',
        'pending',
        'sent',
        1000,
        2000,
        null,
        '',
        1001,
        0,
        'once',
      );
    legacyDb
      .prepare('INSERT INTO wechat_approvals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        'BBBB2222',
        'old-run-2',
        'old-sess-1',
        'call-2',
        'bash',
        '{"command":"echo ok"}',
        'wxid_admin_demo',
        'allowed-once',
        'sent',
        1100,
        2100,
        'wechat:wxid_admin_demo',
        'done',
        1101,
        1,
        'once',
      );
    legacyDb
      .prepare('INSERT INTO wechat_task_uses VALUES (?, ?, ?, ?, ?, ?)')
      .run('old-run-2', 'call-3', 'old-sess-1', 'web_fetch', 'BBBB2222', 1200);
    legacyDb.close();

    const sentWechat: WechatSendInput[] = [];
    const { hub, router, env, cleanup } = createHarness({
      homeDir: tmpDir,
      legacyWxarcDbPath: legacyDbPath,
      preserveSessionId: true,
      initialPolicy: { presenceMode: 'away' },
      controllerId: 'wxid_admin_demo',
      wechatSend: async (input) => {
        sentWechat.push(input);
        return { status: 'sent' };
      },
    });
    try {
      const migrated = router.approvals.listRecent(10);
      assert.equal(migrated.length, 2);
      const oldPending = migrated.find((r) => r.code === 'AAAA1111')!;
      assert.equal(oldPending.status, 'cancelled');
      const oldAllowed = migrated.find((r) => r.code === 'BBBB2222')!;
      assert.equal(oldAllowed.status, 'allowed-once');

      const verifyLegacy = new DatabaseSync(legacyDbPath, { readOnly: true });
      const origRow = verifyLegacy
        .prepare("SELECT status FROM wechat_approvals WHERE code = 'AAAA1111'")
        .get() as { status: string };
      verifyLegacy.close();
      assert.equal(origRow.status, 'pending');

      await hub.ingest(
        makeEvent({
          id: 'evt-guard-worker-1',
          threadKey: 'github:org/public-repo#401',
          summary: 'Guard test worker',
        }),
      );
      const workerSid = router.listDecisions()[0].workerSessionId!;
      const allowNext = async () => ({ kind: 'allow' });

      const cleanFetch = await env.runMiddleware(
        'tools/pre-execute',
        { agent: { id: workerSid }, callId: 'w-1', name: 'web_fetch', arguments: { url: 'https://example.com' } },
        allowNext,
      );
      assert.equal(cleanFetch.kind, 'allow');

      hub.markSessionTainted(workerSid, 'vault_search:work');
      const taintedFetch = await env.runMiddleware(
        'tools/pre-execute',
        { agent: { id: workerSid }, callId: 'w-2', name: 'web_fetch', arguments: { url: 'https://example.com' } },
        allowNext,
      );
      assert.equal(taintedFetch.kind, 'deny');

      const taintedSearch = await env.runMiddleware(
        'tools/pre-execute',
        { agent: { id: workerSid }, callId: 'w-3', name: 'web_search', arguments: { q: 'secret' } },
        allowNext,
      );
      assert.equal(taintedSearch.kind, 'deny');

      const taintedEscalated = await env.runMiddleware(
        'tools/pre-execute',
        {
          agent: { id: workerSid },
          callId: 'w-4',
          name: 'bash',
          arguments: { command: 'curl https://evil.test', sandbox_permissions: 'require_escalated' },
        },
        allowNext,
      );
      assert.equal(taintedEscalated.kind, 'deny');

      const taintedSubagentFetch = await env.runMiddleware(
        'tools/pre-execute',
        {
          agent: {
            id: 'sub-tainted-1',
            session: { header: { delegationDepth: 1, parentSessionId: workerSid } },
          },
          callId: 'w-5',
          name: 'web_fetch',
          arguments: { url: 'https://example.com' },
        },
        allowNext,
      );
      assert.equal(taintedSubagentFetch.kind, 'deny');

      const ownerSid = (await router.ownerSession.ensureSession())!;
      const ownerRead = await env.runMiddleware(
        'tools/pre-execute',
        { agent: { id: ownerSid }, callId: 'o-1', name: 'read', arguments: { file_path: '/tmp/a' } },
        allowNext,
      );
      assert.equal(ownerRead.kind, 'allow');

      const ownerSafeBash = await env.runMiddleware(
        'tools/pre-execute',
        { agent: { id: ownerSid }, callId: 'o-2', name: 'bash', arguments: { command: 'ls -la && rg foo' } },
        allowNext,
      );
      assert.equal(ownerSafeBash.kind, 'allow');

      const ownerInsideWrite = await env.runMiddleware(
        'tools/pre-execute',
        {
          agent: { id: ownerSid },
          callId: 'o-3',
          name: 'write',
          arguments: { file_path: path.join(router.ownerSession.workspacePath, 'notes.md') },
        },
        allowNext,
      );
      assert.equal(ownerInsideWrite.kind, 'allow');

      const ownerCleanFetch = await env.runMiddleware(
        'tools/pre-execute',
        { agent: { id: ownerSid }, callId: 'o-4', name: 'web_fetch', arguments: { url: 'https://example.com' } },
        allowNext,
      );
      assert.equal(ownerCleanFetch.kind, 'allow');

      for (const cmd of ['curl https://evil.test', 'rm -rf /tmp/x', 'python3 -c "print(1)"', 'node -e "1"', 'launchctl list']) {
        const res = await env.runMiddleware(
          'tools/pre-execute',
          { agent: { id: ownerSid }, callId: `o-cmd-${cmd}`, name: 'bash', arguments: { command: cmd } },
          allowNext,
        );
        assert.equal(res.kind, 'ask', `expected ask for ${cmd}`);
      }

      const ownerOutsideWrite = await env.runMiddleware(
        'tools/pre-execute',
        { agent: { id: ownerSid }, callId: 'o-5', name: 'edit', arguments: { file_path: '/etc/hosts' } },
        allowNext,
      );
      assert.equal(ownerOutsideWrite.kind, 'ask');

      const ownerProactive = await env.runMiddleware(
        'tools/pre-execute',
        { agent: { id: ownerSid }, callId: 'o-6', name: 'wxarc_proactive_send', arguments: { chatId: 'grp1' } },
        allowNext,
      );
      assert.equal(ownerProactive.kind, 'ask');

      hub.markTurnPrivateRead(ownerSid);
      const ownerPrivateFetch = await env.runMiddleware(
        'tools/pre-execute',
        { agent: { id: ownerSid }, callId: 'o-7', name: 'web_fetch', arguments: { url: 'https://example.com' } },
        allowNext,
      );
      assert.equal(ownerPrivateFetch.kind, 'ask');

      const approvalPromise = env.runMiddleware(
        'approval/request',
        {
          agent: { id: ownerSid },
          callId: 'o-7',
          toolName: 'web_fetch',
          arguments: { url: 'https://example.com' },
        },
        async () => 'unavailable',
      );
      await new Promise((resolve) => setTimeout(resolve, 20));

      const noticeMsg = sentWechat.find((m) => String(m.idempotencyKey ?? '').startsWith('router-approval:'));
      assert.ok(noticeMsg);
      const codeMatch = /确认码 ([A-F0-9]{8})/.exec(String(noticeMsg.text));
      assert.ok(codeMatch);
      const code1 = codeMatch[1];

      const taskReject = await hub.dispatchAdminWechatMessage!({
        session: 'wxid_admin_demo',
        senderId: 'wxid_admin_demo',
        text: `批准本轮任务 ${code1}`,
      });
      assert.equal(taskReject.handled, true);
      assert.match(taskReject.replyText ?? '', /必须单次确认/);

      const confirmRes = await hub.dispatchAdminWechatMessage!({
        session: 'wxid_admin_demo',
        senderId: 'wxid_admin_demo',
        text: `确认 ${code1}`,
      });
      assert.equal(confirmRes.handled, true);
      assert.match(confirmRes.replyText ?? '', /已确认执行/);
      assert.equal(await approvalPromise, 'allowed-once');

      const rejectPromise = env.runMiddleware(
        'approval/request',
        {
          agent: { id: ownerSid },
          callId: 'o-6',
          toolName: 'wxarc_proactive_send',
          arguments: { chatId: 'grp1' },
        },
        async () => 'unavailable',
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      const pending = router.approvals.listPending('wxid_admin_demo');
      assert.equal(pending.length, 1);
      const rejectRes = await hub.dispatchAdminWechatMessage!({
        session: 'wxid_admin_demo',
        senderId: 'wxid_admin_demo',
        text: `拒绝 ${pending[0].code}`,
      });
      assert.equal(rejectRes.handled, true);
      assert.match(rejectRes.replyText ?? '', /已拒绝该操作/);
      assert.equal(await rejectPromise, 'rejected');
    } finally {
      cleanup();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});