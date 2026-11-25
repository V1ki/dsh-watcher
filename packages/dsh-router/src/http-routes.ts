import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  AttentionPolicy,
  AttentionPreviewInput,
  NotifyChannel,
  RouterActionLevel,
  RouterDecisionStatus,
  RouterNotificationRecord,
} from './contracts.js';
import type { RouterRuntime, SimulateEventInput } from './service.js';

const LOCAL_BASE_URL = 'http://127.0.0.1';
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export interface ConnectionGate {
  requestRejection?: (req: IncomingMessage) => unknown | Promise<unknown>;
  admit?: (req: IncomingMessage) => Promise<{ peer?: { principal?: { kind?: string } } } | null | undefined>;
}

export interface WebServerRouteRegistration {
  kind: 'prefix' | 'exact';
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => unknown;
}

export type WebServerPrefixRegister = (route: WebServerRouteRegistration) => (() => void) | void;

export type WebServerMethodRegister = (
  method: string,
  path: string,
  handler: (req: IncomingMessage, res: ServerResponse, params?: Record<string, string>) => unknown,
) => (() => void) | void;

export interface WebServerLike {
  register?: WebServerPrefixRegister | WebServerMethodRegister;
}

export interface RouterHttpContext {
  webServer?: WebServerLike;
  connection?: ConnectionGate;
  get?: (name: string) => unknown;
}

export interface RouterHttpOptions {
  connection?: ConnectionGate;
  maxBodyBytes?: number;
}

export interface OwnerGateResult {
  ok: boolean;
  status: number;
  error?: string;
}

class HttpRouteError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface RouteResponse {
  status?: number;
  body: unknown;
}

interface RouteDef {
  method: string;
  path: string;
  handle: (
    req: IncomingMessage,
    params: Record<string, string>,
    url: URL,
  ) => RouteResponse | Promise<RouteResponse>;
}

function parseHostname(hostHeader: string): string {
  const trimmed = hostHeader.trim().toLowerCase();
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    return end >= 0 ? trimmed.slice(0, end + 1) : trimmed;
  }
  const colon = trimmed.indexOf(':');
  return colon >= 0 ? trimmed.slice(0, colon) : trimmed;
}

export async function checkLocalOwnerRequest(
  req: IncomingMessage,
  connection?: ConnectionGate,
): Promise<OwnerGateResult> {
  const remote = req.socket?.remoteAddress ?? '';
  if (!LOOPBACK_IPS.has(remote)) {
    return { ok: false, status: 403, error: 'loopback_only' };
  }

  const hostHeader = typeof req.headers?.host === 'string' ? req.headers.host : '';
  if (hostHeader && !LOOPBACK_HOSTS.has(parseHostname(hostHeader))) {
    return { ok: false, status: 403, error: 'loopback_host_only' };
  }

  const origin = typeof req.headers?.origin === 'string' ? req.headers.origin : '';
  if (origin) {
    try {
      const parsed = new URL(origin);
      if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
        return { ok: false, status: 403, error: 'origin_not_loopback' };
      }
      if (hostHeader && parsed.host.toLowerCase() !== hostHeader.trim().toLowerCase()) {
        return { ok: false, status: 403, error: 'origin_mismatch' };
      }
    } catch {
      return { ok: false, status: 403, error: 'invalid_origin' };
    }
  }

  const fetchSite = req.headers?.['sec-fetch-site'];
  if (fetchSite && !['same-origin', 'same-site', 'none'].includes(String(fetchSite))) {
    return { ok: false, status: 403, error: 'cross_site_blocked' };
  }

  if (connection?.requestRejection) {
    const rejected = await connection.requestRejection(req);
    if (rejected) {
      const status = typeof rejected === 'number' && rejected >= 400 && rejected < 600 ? rejected : 403;
      return { ok: false, status, error: 'connection_rejected' };
    }
  }

  if (connection?.admit) {
    const admission = await connection.admit(req);
    if (admission?.peer?.principal?.kind !== 'owner') {
      return { ok: false, status: 403, error: 'owner_required' };
    }
  }

  return { ok: true, status: 200 };
}

async function readJsonBody(
  req: IncomingMessage,
  maxBytes = DEFAULT_MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buf.length;
    if (total > maxBytes) {
      throw new HttpRouteError(413, 'payload_too_large');
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpRouteError(400, 'invalid_json');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpRouteError(400, 'json_object_required');
  }
  return parsed as Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  if (typeof res.writeHead === 'function') {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
  } else {
    res.statusCode = status;
    res.setHeader?.('content-type', 'application/json; charset=utf-8');
  }
  res.end(payload);
}

function normalizeRoutePathname(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

function compileRoutePath(pattern: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const escaped = pattern
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        paramNames.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return {
    regex: new RegExp(`^${escaped}$`),
    paramNames,
  };
}

function normalizeErrorStatus(err: unknown): { status: number; message: string } {
  if (err instanceof HttpRouteError) {
    return { status: err.status, message: err.message };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith('decision_not_found:') || message.startsWith('notification_not_found:')) {
    return { status: 404, message };
  }
  if (message.startsWith('invalid_option_index:')) {
    return { status: 400, message };
  }
  return { status: 500, message };
}

function buildRoutes(router: RouterRuntime, maxBodyBytes: number): RouteDef[] {
  return [
    {
      method: 'GET',
      path: '/local-router/status',
      handle: () => {
        router.touchWebPresence();
        return { body: router.getStatus() };
      },
    },
    {
      method: 'GET',
      path: '/local-router/decisions',
      handle: (_req, _params, url) => {
        const source = url.searchParams.get('source') ?? undefined;
        const status = (url.searchParams.get('status') as RouterDecisionStatus | null) ?? undefined;
        const level = (url.searchParams.get('level') as RouterActionLevel | null) ?? undefined;
        const limitRaw = url.searchParams.get('limit');
        const limit = limitRaw ? Number(limitRaw) : undefined;
        const decisions = router.listDecisions({ source, status, level, limit });
        return { body: { decisions } };
      },
    },
    {
      method: 'POST',
      path: '/local-router/decisions/:id/restore',
      handle: async (_req, params) => {
        const decision = await router.restoreDecision(params.id);
        return { body: { ok: true, decision } };
      },
    },
    {
      method: 'POST',
      path: '/local-router/decisions/:id/dispatch',
      handle: async (_req, params) => {
        const decision = await router.dispatchManual(params.id);
        return { body: { ok: true, decision } };
      },
    },
    {
      method: 'POST',
      path: '/local-router/decisions/:id/answer',
      handle: async (req, params) => {
        const body = await readJsonBody(req, maxBodyBytes);
        const optionIndex = Number(body.optionIndex);
        if (!Number.isInteger(optionIndex)) {
          throw new HttpRouteError(400, 'optionIndex_integer_required');
        }
        const decision = await router.answerDecision(params.id, optionIndex);
        return { body: { ok: true, decision } };
      },
    },
    {
      method: 'GET',
      path: '/local-router/notifications',
      handle: (_req, _params, url) => {
        const status =
          (url.searchParams.get('status') as RouterNotificationRecord['status'] | null) ?? undefined;
        const channel = (url.searchParams.get('channel') as NotifyChannel | null) ?? undefined;
        const decisionId = url.searchParams.get('decisionId') ?? undefined;
        const limitRaw = url.searchParams.get('limit');
        const limit = limitRaw ? Number(limitRaw) : undefined;
        const notifications = router.listNotifications({ status, channel, decisionId, limit });
        return { body: { notifications } };
      },
    },
    {
      method: 'POST',
      path: '/local-router/notifications/:id/read',
      handle: (_req, params) => {
        const notification = router.markNotificationRead(params.id);
        return { body: { ok: true, notification } };
      },
    },
    {
      method: 'GET',
      path: '/local-router/policy',
      handle: () => ({ body: router.getPolicy() }),
    },
    {
      method: 'PUT',
      path: '/local-router/policy',
      handle: async (req) => {
        const body = await readJsonBody(req, maxBodyBytes);
        const updated = router.updatePolicy(body as Partial<AttentionPolicy>);
        return { body: updated };
      },
    },
    {
      method: 'POST',
      path: '/local-router/preview',
      handle: async (req) => {
        const body = await readJsonBody(req, maxBodyBytes);
        const result = router.previewRoute(body as AttentionPreviewInput);
        return { body: result };
      },
    },
    {
      method: 'GET',
      path: '/local-router/stats',
      handle: (_req, _params, url) => {
        const daysRaw = url.searchParams.get('days');
        const days = daysRaw ? Number(daysRaw) : 7;
        return { body: router.getStats(Number.isFinite(days) ? days : 7) };
      },
    },
    {
      method: 'GET',
      path: '/local-router/subscriptions',
      handle: (_req, _params, url) => {
        const source = url.searchParams.get('source') ?? undefined;
        const status = url.searchParams.get('status') ?? undefined;
        const subscriptions = router.hub.listSubscriptions({ source, status });
        return { body: { subscriptions } };
      },
    },
    {
      method: 'DELETE',
      path: '/local-router/subscriptions',
      handle: async (req, _params, url) => {
        const body = await readJsonBody(req, maxBodyBytes);
        const source =
          (typeof body.source === 'string' && body.source.trim()) ||
          url.searchParams.get('source')?.trim() ||
          '';
        const threadKey =
          (typeof body.threadKey === 'string' && body.threadKey.trim()) ||
          url.searchParams.get('threadKey')?.trim() ||
          '';
        if (!source || !threadKey) {
          throw new HttpRouteError(400, 'source_and_threadKey_required');
        }
        const removed = router.hub.removeSubscription(source, threadKey);
        return { body: { ok: true, removed } };
      },
    },
    {
      method: 'POST',
      path: '/local-router/simulate-event',
      handle: async (req) => {
        const body = await readJsonBody(req, maxBodyBytes);
        const outcome = await router.simulateEvent(body as SimulateEventInput);
        return { body: outcome };
      },
    },
  ];
}

export function createRouterHttpHandler(
  router: RouterRuntime,
  options: RouterHttpOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const routes = buildRoutes(router, maxBodyBytes);
  const compiled = routes.map((route) => ({
    route,
    ...compileRoutePath(route.path),
  }));

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const gate = await checkLocalOwnerRequest(req, options.connection);
    if (!gate.ok) {
      sendJson(res, gate.status, { error: gate.error ?? 'forbidden' });
      return;
    }

    const method = (req.method ?? 'GET').toUpperCase();
    const url = new URL(req.url ?? '/', LOCAL_BASE_URL);
    const normalizedPath = normalizeRoutePathname(url.pathname);

    for (const entry of compiled) {
      if (entry.route.method !== method) continue;
      const match = entry.regex.exec(normalizedPath);
      if (!match) continue;
      const params: Record<string, string> = {};
      for (let i = 0; i < entry.paramNames.length; i += 1) {
        params[entry.paramNames[i]] = decodeURIComponent(match[i + 1] ?? '');
      }
      try {
        const result = await entry.route.handle(req, params, url);
        sendJson(res, result.status ?? 200, result.body);
      } catch (err) {
        const info = normalizeErrorStatus(err);
        sendJson(res, info.status, { error: info.message });
      }
      return;
    }

    sendJson(res, 404, { error: 'not_found' });
  };
}

export function mountRouterHttpRoutes(
  ctx: RouterHttpContext,
  router: RouterRuntime,
  options: RouterHttpOptions = {},
): () => void {
  const webServer =
    typeof ctx.get === 'function'
      ? (ctx.get('webServer') as WebServerLike | undefined)
      : ctx.webServer;
  if (!webServer?.register) return () => {};

  const resolveConnection = (): ConnectionGate | undefined =>
    options.connection ??
    (typeof ctx.get === 'function'
      ? (ctx.get('connection') as ConnectionGate | undefined)
      : ctx.connection);

  if (webServer.register.length <= 1) {
    const handler = createRouterHttpHandler(router, {
      ...options,
      connection: {
        requestRejection: async (req) => resolveConnection()?.requestRejection?.(req),
        admit: async (req) => {
          const conn = resolveConnection();
          if (!conn?.admit) return { peer: { principal: { kind: 'owner' } } };
          return conn.admit(req);
        },
      },
    });
    const registerPrefix = (webServer.register as WebServerPrefixRegister).bind(webServer);
    const off = registerPrefix({
      kind: 'prefix',
      path: '/local-router',
      handler,
    });
    return () => {
      if (typeof off === 'function') off();
    };
  }

  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const routes = buildRoutes(router, maxBodyBytes);
  const disposers: Array<() => void> = [];
  const registerMethod = (webServer.register as WebServerMethodRegister).bind(webServer);

  for (const route of routes) {
    const invokeRoute = async (
      req: IncomingMessage,
      res: ServerResponse,
      params?: Record<string, string>,
    ): Promise<void> => {
      const gate = await checkLocalOwnerRequest(req, resolveConnection());
      if (!gate.ok) {
        sendJson(res, gate.status, { error: gate.error ?? 'forbidden' });
        return;
      }
      try {
        const url = new URL(req.url ?? '/', LOCAL_BASE_URL);
        const result = await route.handle(req, params ?? {}, url);
        sendJson(res, result.status ?? 200, result.body);
      } catch (err) {
        const info = normalizeErrorStatus(err);
        sendJson(res, info.status, { error: info.message });
      }
    };
    const off = registerMethod(route.method, route.path, invokeRoute);
    if (typeof off === 'function') disposers.push(off);
  }

  return () => {
    while (disposers.length > 0) {
      disposers.pop()?.();
    }
  };
}
