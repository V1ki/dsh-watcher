import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  FoundationBundle,
  FoundationSource,
  PersonaConfig,
  PersonaKind,
  PersonaWardrobe,
} from './contracts.js';
import { expandHome } from './db.js';
import type { CreatePersonaInput, PersonaWardrobeImpl } from './wardrobe.js';

const LOCAL_BASE_URL = 'http://127.0.0.1';
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const VALID_PERSONA_KINDS = new Set<PersonaKind>(['double', 'original', 'fiction']);

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

export interface PersonaHttpContext {
  webServer?: WebServerLike;
  connection?: ConnectionGate;
  get?: (name: string) => unknown;
}

export interface PersonaHttpOptions {
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
  wardrobe: PersonaWardrobe,
  options: PersonaHttpOptions,
): RouteDef[] {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const impl = wardrobe as PersonaWardrobeImpl;

  return [
    {
      method: 'GET',
      path: '/local-persona/sample-info',
      handle: () => ({ body: wardrobe.sampleInfo() }),
    },
    {
      method: 'GET',
      path: '/local-persona/personas',
      handle: () => ({ body: { personas: wardrobe.list() } }),
    },
    {
      method: 'POST',
      path: '/local-persona/personas',
      handle: async (req) => {
        const body = await readJsonBody(req, maxBodyBytes);
        const kind = String(body.kind ?? 'original') as PersonaKind;
        if (!VALID_PERSONA_KINDS.has(kind)) {
          throw new HttpRouteError(400, 'invalid_persona_kind');
        }
        const spec: CreatePersonaInput = {
          kind,
          id: optionalString(body.id) ?? undefined,
          name: optionalString(body.name) ?? undefined,
          definition: typeof body.definition === 'string' ? body.definition : undefined,
          learning: typeof body.learning === 'boolean' ? body.learning : undefined,
          work: typeof body.work === 'string' ? body.work : undefined,
          character: typeof body.character === 'string' ? body.character : undefined,
          style: typeof body.style === 'string' ? body.style : undefined,
        };
        const persona = impl.create(spec);
        return { status: 201, body: { persona } };
      },
    },
    {
      method: 'POST',
      path: '/local-persona/personas/import-foundation',
      handle: async (req) => {
        const body = await readJsonBody(req, maxBodyBytes);
        const bundle = (body.bundle ?? body) as FoundationBundle;
        if (!bundle || !Array.isArray(bundle.records)) {
          throw new HttpRouteError(400, 'foundation_bundle_required');
        }
        const sources = Array.isArray(body.sources) ? (body.sources as FoundationSource[]) : [];
        const result = wardrobe.importFoundation(bundle, sources);
        return { body: { ok: true, ...result } };
      },
    },
    {
      method: 'POST',
      path: '/local-persona/personas/import-wxarc',
      handle: async (req) => {
        const body = await readJsonBody(req, maxBodyBytes);
        const rawPath = optionalString(body.sqlitePath) ?? optionalString(body.path);
        if (!rawPath) {
          throw new HttpRouteError(400, 'sqlite_path_required');
        }
        const result = wardrobe.importFromWxarcSqlite(expandHome(rawPath));
        return { body: { ok: true, ...result } };
      },
    },
    {
      method: 'GET',
      path: '/local-persona/personas/:id',
      handle: (_req, params) => ({ body: { persona: wardrobe.get(params.id) } }),
    },
    {
      method: 'PUT',
      path: '/local-persona/personas/:id',
      handle: async (req, params) => {
        const body = await readJsonBody(req, maxBodyBytes);
        const rawPersona =
          body.persona && typeof body.persona === 'object' && !Array.isArray(body.persona)
            ? (body.persona as Record<string, unknown>)
            : body;
        const current = wardrobe.get(params.id);
        const revision =
          typeof body.revision === 'number'
            ? body.revision
            : typeof rawPersona.revision === 'number'
              ? rawPersona.revision
              : current.revision;
        const config: PersonaConfig = {
          id: params.id,
          kind: (rawPersona.kind as PersonaKind | undefined) ?? current.kind,
          name: typeof rawPersona.name === 'string' ? rawPersona.name : current.name,
          definition: typeof rawPersona.definition === 'string' ? rawPersona.definition : current.definition,
          learning: typeof rawPersona.learning === 'boolean' ? rawPersona.learning : current.learning,
          work: typeof rawPersona.work === 'string' ? rawPersona.work : current.work,
          character: typeof rawPersona.character === 'string' ? rawPersona.character : current.character,
          style: typeof rawPersona.style === 'string' ? rawPersona.style : current.style,
        };
        const persona = wardrobe.save(config, revision);
        return { body: { persona } };
      },
    },
    {
      method: 'DELETE',
      path: '/local-persona/personas/:id',
      handle: (_req, params) => {
        const deleted = wardrobe.delete(params.id);
        if (!deleted) {
          throw new HttpRouteError(404, `Persona not found: ${params.id}`);
        }
        return { body: { ok: true, deleted } };
      },
    },
    {
      method: 'GET',
      path: '/local-persona/personas/:id/memories',
      handle: (_req, params, url) => {
        const limitParam = url.searchParams.get('limit');
        const memories = wardrobe.listMemories(params.id, {
          scope: url.searchParams.get('scope') || undefined,
          limit: limitParam ? Math.min(200, Math.max(1, Number(limitParam) || 24)) : undefined,
        });
        return { body: { memories } };
      },
    },
    {
      method: 'PUT',
      path: '/local-persona/personas/:id/memories/:memId',
      handle: async (req, params) => {
        const memId = Number(params.memId);
        if (!Number.isInteger(memId) || memId <= 0) {
          throw new HttpRouteError(400, 'invalid_memory_id');
        }
        const body = await readJsonBody(req, maxBodyBytes);
        const note = typeof body.note === 'string' ? body.note.trim() : '';
        if (!note) throw new HttpRouteError(400, 'memory_note_required');
        wardrobe.editMemory(params.id, memId, note);
        return { body: { ok: true, id: memId, note } };
      },
    },
    {
      method: 'DELETE',
      path: '/local-persona/personas/:id/memories',
      handle: (_req, params, url) => {
        const result = wardrobe.clearMemories(params.id, url.searchParams.get('scope') || undefined);
        return { body: { ok: true, deleted: result.deleted } };
      },
    },
    {
      method: 'POST',
      path: '/local-persona/personas/:id/learn-style',
      handle: async (req, params) => {
        const body = await readJsonBody(req, maxBodyBytes);
        const current = wardrobe.get(params.id);
        const revision = typeof body.revision === 'number' ? body.revision : current.revision;
        const samples = Array.isArray(body.samples)
          ? (body.samples as Array<{ text: string; context?: string; scene?: string }>)
          : undefined;
        const persona = await wardrobe.learnStyleFromSamples(params.id, revision, {
          samplePath: optionalString(body.samplePath) ?? undefined,
          samples,
          source: optionalString(body.source) ?? undefined,
          policy:
            body.policy && typeof body.policy === 'object' && !Array.isArray(body.policy)
              ? (body.policy as Record<string, unknown>)
              : undefined,
        });
        return { body: { persona } };
      },
    },
    {
      method: 'POST',
      path: '/local-persona/personas/:id/preview',
      handle: async (req, params) => {
        const body = await readJsonBody(req, maxBodyBytes);
        const message =
          typeof body.message === 'string'
            ? body.message.trim()
            : typeof body.text === 'string'
              ? body.text.trim()
              : '';
        if (!message) throw new HttpRouteError(400, 'preview_message_required');
        const history = Array.isArray(body.history)
          ? (body.history as Array<{ role: 'user' | 'assistant'; content: string }>)
          : undefined;
        const result = await wardrobe.previewChat({
          personaId: params.id,
          message,
          history,
          scope: optionalString(body.scope) ?? undefined,
          channel: optionalString(body.channel) ?? undefined,
          ownerId: optionalString(body.ownerId) ?? undefined,
          queryText: optionalString(body.queryText) ?? undefined,
        });
        return { body: result };
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

export function createPersonaHttpHandler(
  wardrobe: PersonaWardrobe,
  options: PersonaHttpOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const compiled = buildRoutes(wardrobe, options).map((route) => ({
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

export function mountPersonaHttpRoutes(
  ctx: PersonaHttpContext,
  wardrobe: PersonaWardrobe,
  options: PersonaHttpOptions = {},
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
    const handler = createPersonaHttpHandler(wardrobe, {
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
    const off = (webServer.register as WebServerPrefixRegister)({
      kind: 'prefix',
      path: '/local-persona',
      handler,
    });
    return typeof off === 'function' ? off : () => {};
  }

  const routes = buildRoutes(wardrobe, { ...options, connection: resolveConnection() });
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
