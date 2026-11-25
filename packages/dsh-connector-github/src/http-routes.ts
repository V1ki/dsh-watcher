import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  GitHubAdminAdapter,
  GitHubAdminConfigUpdate,
  HubService,
  PersonaWardrobe,
} from '@local/dsh-hub/contracts';

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

export interface GitHubConnectorHttpContext {
  webServer?: WebServerLike;
  connection?: ConnectionGate;
  personaWardrobe?: PersonaWardrobe;
  hub?: HubService;
  watcher?: HubService;
  get?: (name: string) => unknown;
}

export interface GitHubConnectorHttpOptions {
  connection?: ConnectionGate;
  getWardrobe?: () => PersonaWardrobe | null;
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
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    total += buf.length;
    if (total > maxBytes) {
      throw new HttpRouteError(413, 'payload_too_large');
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpRouteError(400, 'json_object_required');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof HttpRouteError) throw err;
    throw new HttpRouteError(400, 'invalid_json');
  }
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

function optionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function buildRoutes(
  admin: GitHubAdminAdapter,
  options: GitHubConnectorHttpOptions,
): RouteDef[] {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return [
    {
      method: 'GET',
      path: '/connector/github/config',
      handle: async () => {
        const config = await admin.getConfig();
        return { body: config };
      },
    },
    {
      method: 'PUT',
      path: '/connector/github/config',
      handle: async (req) => {
        const body = await readJsonBody(req, maxBodyBytes);
        const updated = await admin.updateConfig(body as GitHubAdminConfigUpdate);
        return { body: updated };
      },
    },
    {
      method: 'POST',
      path: '/connector/github/token',
      handle: async (req) => {
        const body = await readJsonBody(req, maxBodyBytes);
        const slotRaw = body.slot === undefined ? 'read' : String(body.slot);
        if (slotRaw !== 'read' && slotRaw !== 'act') {
          throw new HttpRouteError(400, 'invalid_token_slot');
        }
        const token = typeof body.token === 'string' ? body.token.trim() : '';
        if (!token) {
          throw new HttpRouteError(400, 'token_required');
        }
        const result = await admin.saveToken({
          slot: slotRaw,
          token,
          login: optionalString(body.login) ?? undefined,
          isBot: typeof body.isBot === 'boolean' ? body.isBot : undefined,
        });
        return {
          body: {
            ok: result.ok,
            slot: result.slot,
            savedTo: result.savedTo,
            verified: result.verified,
            authStatus: result.authStatus,
          },
        };
      },
    },
    {
      method: 'POST',
      path: '/connector/github/app',
      handle: async (req) => {
        if (!admin.saveApp) {
          throw new HttpRouteError(501, 'github_app_unsupported');
        }
        const body = await readJsonBody(req, maxBodyBytes);
        const appId = Number(body.appId);
        if (!Number.isInteger(appId) || appId <= 0) {
          throw new HttpRouteError(400, 'invalid_app_id');
        }
        let installationId: number | undefined = undefined;
        if (body.installationId !== undefined && body.installationId !== null && body.installationId !== '') {
          const parsedInstallation = Number(body.installationId);
          if (!Number.isInteger(parsedInstallation) || parsedInstallation <= 0) {
            throw new HttpRouteError(400, 'invalid_installation_id');
          }
          installationId = parsedInstallation;
        }
        const privateKeyPem =
          typeof body.privateKeyPem === 'string' && body.privateKeyPem.trim()
            ? body.privateKeyPem
            : undefined;
        const result = await admin.saveApp({
          appId,
          slug: optionalString(body.slug) ?? undefined,
          privateKeyPem,
          installationId,
          repo: optionalString(body.repo) ?? undefined,
        });
        return {
          body: {
            ok: result.ok,
            savedTo: result.savedTo,
            verified: result.verified,
            authStatus: result.authStatus,
          },
        };
      },
    },
    {
      method: 'POST',
      path: '/connector/github/app/verify',
      handle: async (req) => {
        if (!admin.verifyApp) {
          throw new HttpRouteError(501, 'github_app_unsupported');
        }
        const body = await readJsonBody(req, maxBodyBytes);
        const result = await admin.verifyApp({
          repo: optionalString(body.repo) ?? undefined,
        });
        return { body: result };
      },
    },
    {
      method: 'DELETE',
      path: '/connector/github/app',
      handle: async () => {
        if (!admin.deleteApp) {
          throw new HttpRouteError(501, 'github_app_unsupported');
        }
        const result = await admin.deleteApp();
        return {
          body: {
            ok: result.ok,
            authStatus: result.authStatus,
          },
        };
      },
    },
    {
      method: 'POST',
      path: '/connector/github/poll',
      handle: async () => {
        const result = await admin.pollNow();
        return { body: { ok: true, ...result } };
      },
    },
    {
      method: 'GET',
      path: '/connector/github/events',
      handle: async () => {
        const events = admin.listRecentEvents ? await admin.listRecentEvents() : [];
        return { body: { events } };
      },
    },
    {
      method: 'GET',
      path: '/connector/github/personas',
      handle: () => {
        const wardrobe = options.getWardrobe?.() ?? null;
        const personas = wardrobe ? wardrobe.list() : [];
        return { body: { personas } };
      },
    },
  ];
}

function compileRoutePattern(routePath: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const escaped = routePath
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        paramNames.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${escaped}$`), paramNames };
}

function normalizeErrorStatus(err: unknown): { status: number; message: string } {
  if (err instanceof HttpRouteError) {
    return { status: err.status, message: err.message };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/not found/i.test(message)) return { status: 404, message };
  if (/revision|conflict/i.test(message)) return { status: 409, message };
  return { status: 400, message };
}

export function createGitHubConnectorHttpHandler(
  admin: GitHubAdminAdapter,
  options: GitHubConnectorHttpOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const compiled = buildRoutes(admin, options).map((route) => ({
    route,
    ...compileRoutePattern(route.path),
  }));

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const gate = await checkLocalOwnerRequest(req, options.connection);
    if (!gate.ok) {
      sendJson(res, gate.status, { error: gate.error ?? 'forbidden' });
      return;
    }

    const method = (req.method ?? 'GET').toUpperCase();
    const url = new URL(req.url ?? '/', LOCAL_BASE_URL);

    for (const entry of compiled) {
      if (entry.route.method !== method) continue;
      const match = entry.regex.exec(url.pathname);
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

export function mountGitHubConnectorHttpRoutes(
  ctx: GitHubConnectorHttpContext,
  admin: GitHubAdminAdapter,
  options: GitHubConnectorHttpOptions = {},
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

  const resolveWardrobe = (): PersonaWardrobe | null => {
    if (options.getWardrobe) return options.getWardrobe();
    const fromCtx =
      typeof ctx.get === 'function'
        ? (ctx.get('personaWardrobe') as PersonaWardrobe | undefined)
        : ctx.personaWardrobe;
    if (fromCtx) return fromCtx;
    const bus =
      typeof ctx.get === 'function'
        ? ((ctx.get('hub') ?? ctx.get('watcher')) as typeof ctx.hub)
        : (ctx.hub ?? ctx.watcher);
    return bus?.getWardrobe?.() ?? bus?.wardrobe ?? null;
  };

  if (webServer.register.length <= 1) {
    const handler = createGitHubConnectorHttpHandler(admin, {
      ...options,
      getWardrobe: resolveWardrobe,
      connection: {
        requestRejection: async (req) => resolveConnection()?.requestRejection?.(req),
        admit: async (req) => {
          const conn = resolveConnection();
          if (!conn?.admit) return { peer: { principal: { kind: 'owner' } } };
          return conn.admit(req);
        },
      },
    });
    const off = (webServer.register as WebServerPrefixRegister)({
      kind: 'prefix',
      path: '/connector/github',
      handler,
    });
    return typeof off === 'function' ? off : () => {};
  }

  const routes = buildRoutes(admin, {
    ...options,
    getWardrobe: resolveWardrobe,
    connection: resolveConnection(),
  });
  const disposers: Array<() => void> = [];
  const registerMethod = (webServer.register as WebServerMethodRegister).bind(webServer);

  for (const route of routes) {
    const off = registerMethod(route.method, route.path, async (req, res, params) => {
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
    });
    if (typeof off === 'function') disposers.push(off);
  }

  return () => {
    while (disposers.length > 0) {
      disposers.pop()?.();
    }
  };
}
