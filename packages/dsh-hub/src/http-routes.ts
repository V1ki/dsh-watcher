import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  GitHubAdminAdapter,
  GitHubAdminConfigUpdate,
  HubService,
  InboxItem,
  MemoKind,
  MemoRecord,
  MemoStatus,
  PersonaConfig,
  PersonaKind,
  PersonaWardrobe,
  StagedDraft,
  WatchStatus,
  WatcherDb,
} from './contracts.js';

const LOCAL_BASE_URL = 'http://127.0.0.1';
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const VALID_MEMO_KINDS = new Set<MemoKind>(['time_nudge', 'news_followup', 'long_watch']);
const VALID_PERSONA_KINDS = new Set<PersonaKind>(['double', 'original', 'fiction']);

export interface ConnectionGate {
  requestRejection?: (req: IncomingMessage) => unknown | Promise<unknown>;
  admit?: (req: IncomingMessage) => Promise<{ peer?: { principal?: { kind?: string } } } | null | undefined>;
}

export interface MemoEngineLike {
  checkNow?: (memoId: string) => Promise<unknown>;
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

export interface HubHttpContext {
  webServer?: WebServerLike;
  connection?: ConnectionGate;
  memoEngine?: MemoEngineLike;
  get?: (name: string) => unknown;
}

export type WatcherHttpContext = HubHttpContext;

export type HubHttpTarget = HubService & {
  cancelWorkstream?: (id: string, reason?: string) => boolean | Promise<boolean>;
  pollSourceNow?: (sourceId: string) => Promise<{ polled: number; events: number }>;
  memoEngine?: MemoEngineLike;
};

export type WatcherHttpTarget = HubHttpTarget;

export interface HubHttpOptions {
  connection?: ConnectionGate;
  memoEngine?: MemoEngineLike;
  githubAdmin?: GitHubAdminAdapter;
  pollSource?: (sourceId: string) => Promise<{ polled: number; events: number }>;
  maxBodyBytes?: number;
}

export type WatcherHttpOptions = HubHttpOptions;

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

interface MemoSqlRow {
  id: string;
  kind: MemoKind;
  room_key: string;
  target_session_id: string | null;
  target_chat_id: string | null;
  source: string;
  title: string;
  basis: string;
  window_start: string | null;
  window_end: string | null;
  random_fire_at: string | null;
  interval_hours: number | null;
  expires_at: string | null;
  keywords_json: string;
  known_facts_json: string;
  accept_criteria: string | null;
  official_domains_json: string;
  status: MemoStatus;
  last_checked_at: string | null;
  next_check_at: string | null;
  notify_wechat_chat_id: string | null;
  result_summary: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
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

function parseJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function optionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function mapMemoRow(row: MemoSqlRow): MemoRecord {
  return {
    id: row.id,
    kind: row.kind,
    roomKey: row.room_key,
    targetSessionId: row.target_session_id,
    targetChatId: row.target_chat_id,
    source: row.source,
    title: row.title,
    basis: row.basis,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    randomFireAt: row.random_fire_at,
    intervalHours: row.interval_hours,
    expiresAt: row.expires_at,
    keywords: parseJsonArray(row.keywords_json),
    knownFacts: parseJsonArray(row.known_facts_json),
    acceptCriteria: row.accept_criteria,
    officialDomains: parseJsonArray(row.official_domains_json),
    status: row.status,
    lastCheckedAt: row.last_checked_at,
    nextCheckAt: row.next_check_at,
    notifyWechatChatId: row.notify_wechat_chat_id,
    resultSummary: row.result_summary,
    metadata: parseJsonObject(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getMemoById(store: WatcherDb, id: string): MemoRecord | null {
  const row = store.db.prepare('SELECT * FROM memos WHERE id = ?').get(id) as MemoSqlRow | undefined;
  return row ? mapMemoRow(row) : null;
}

function listMemosFromDb(
  store: WatcherDb,
  filter: { status?: string; kind?: string; roomKey?: string; sessionId?: string; limit?: number },
): MemoRecord[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (filter.status) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  if (filter.kind) {
    clauses.push('kind = ?');
    params.push(filter.kind);
  }
  if (filter.roomKey) {
    clauses.push('room_key = ?');
    params.push(filter.roomKey);
  }
  if (filter.sessionId) {
    clauses.push('target_session_id = ?');
    params.push(filter.sessionId);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.min(200, Math.max(1, filter.limit ?? 100));
  params.push(limit);
  const rows = store.db
    .prepare(`SELECT * FROM memos ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params) as unknown as MemoSqlRow[];
  return rows.map(mapMemoRow);
}

function insertMemoIntoDb(store: WatcherDb, body: Record<string, unknown>): MemoRecord {
  const kind = String(body.kind ?? 'time_nudge') as MemoKind;
  if (!VALID_MEMO_KINDS.has(kind)) {
    throw new HttpRouteError(400, 'invalid_memo_kind');
  }
  const basis = typeof body.basis === 'string' ? body.basis.trim() : '';
  if (!basis) {
    throw new HttpRouteError(400, 'memo_basis_required');
  }
  const now = new Date().toISOString();
  const id = randomUUID();
  const targetSessionId = optionalString(body.targetSessionId);
  const targetChatId = optionalString(body.targetChatId);
  const roomKey = optionalString(body.roomKey) ?? targetSessionId ?? targetChatId ?? 'default';
  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : basis.slice(0, 60);
  const intervalHours =
    typeof body.intervalHours === 'number' && Number.isFinite(body.intervalHours) ? body.intervalHours : null;
  const metadata =
    body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata) ? body.metadata : {};

  store.db
    .prepare(
      `INSERT INTO memos (
         id, kind, room_key, target_session_id, target_chat_id, source, title, basis,
         window_start, window_end, random_fire_at, interval_hours, expires_at,
         keywords_json, known_facts_json, accept_criteria, official_domains_json,
         status, last_checked_at, next_check_at, notify_wechat_chat_id, result_summary,
         metadata_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, NULL, ?, ?, ?)`,
    )
    .run(
      id,
      kind,
      roomKey,
      targetSessionId,
      targetChatId,
      optionalString(body.source) ?? 'ui',
      title,
      basis,
      optionalString(body.windowStart),
      optionalString(body.windowEnd),
      optionalString(body.randomFireAt),
      intervalHours,
      optionalString(body.expiresAt),
      JSON.stringify(toStringArray(body.keywords)),
      JSON.stringify(toStringArray(body.knownFacts)),
      optionalString(body.acceptCriteria),
      JSON.stringify(toStringArray(body.officialDomains)),
      optionalString(body.nextCheckAt) ?? optionalString(body.windowStart) ?? now,
      optionalString(body.notifyWechatChatId),
      JSON.stringify(metadata),
      now,
      now,
    );

  return getMemoById(store, id) as MemoRecord;
}

function buildRoutes(watcher: HubHttpTarget, options: HubHttpOptions): RouteDef[] {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const memoEngine = options.memoEngine ?? watcher.memoEngine;
  const requireWardrobe = (): PersonaWardrobe => {
    const wardrobe = watcher.getWardrobe?.() ?? watcher.wardrobe ?? null;
    if (!wardrobe) {
      throw new HttpRouteError(503, 'persona_service_unavailable');
    }
    return wardrobe;
  };
  const requireGitHubAdmin = (): GitHubAdminAdapter => {
    const admin = watcher.getGitHubAdmin?.() ?? options.githubAdmin ?? null;
    if (!admin) {
      throw new HttpRouteError(503, 'github_adapter_unavailable');
    }
    return admin;
  };

  return [
    {
      method: 'GET',
      path: '/local-watcher/connectors',
      handle: () => {
        const status = watcher.getStatus();
        return {
          body: {
            connectors: watcher.listConnectors(),
            sources: status.sources,
            sinks: status.sinks,
          },
        };
      },
    },
    {
      method: 'GET',
      path: '/local-watcher/subscriptions',
      handle: (_req, _params, url) => {
        const subscriptions = watcher.listSubscriptions({
          source: url.searchParams.get('source') || undefined,
          status: url.searchParams.get('status') || undefined,
        });
        return { body: { subscriptions } };
      },
    },
    {
      method: 'POST',
      path: '/local-watcher/subscriptions',
      handle: async (req) => {
        const body = await readJsonBody(req, maxBodyBytes);
        const source = optionalString(body.source);
        const threadKey = optionalString(body.threadKey);
        const sessionId = optionalString(body.sessionId);
        if (!source || !threadKey || !sessionId) {
          throw new HttpRouteError(400, 'subscription_fields_required');
        }
        const metadata =
          body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
            ? (body.metadata as Record<string, unknown>)
            : undefined;
        const subscription = watcher.registerSubscription({
          source,
          threadKey,
          sessionId,
          workstreamId: optionalString(body.workstreamId),
          personaId: optionalString(body.personaId),
          owner: optionalString(body.owner) ?? undefined,
          status: optionalString(body.status) ?? undefined,
          metadata,
        });
        return { status: 201, body: { subscription } };
      },
    },
    {
      method: 'DELETE',
      path: '/local-watcher/subscriptions',
      handle: async (req, _params, url) => {
        let source = url.searchParams.get('source')?.trim() || '';
        let threadKey = url.searchParams.get('threadKey')?.trim() || '';
        if (!source || !threadKey) {
          const body = await readJsonBody(req, maxBodyBytes);
          source = source || optionalString(body.source) || '';
          threadKey = threadKey || optionalString(body.threadKey) || '';
        }
        if (!source || !threadKey) {
          throw new HttpRouteError(400, 'subscription_key_required');
        }
        const ok = watcher.removeSubscription(source, threadKey);
        return { body: { ok, source, threadKey } };
      },
    },
    {
      method: 'GET',
      path: '/local-watcher/status',
      handle: async () => {
        const status = watcher.getStatus();
        const transport = watcher.getWechatTransport?.() ?? null;
        let wechatTransport: unknown = null;
        if (transport) {
          try {
            const st = await transport.status();
            wechatTransport = st;
            status.wechatTransportMode = st.mode;
          } catch {
            wechatTransport = null;
          }
        }
        const row = watcher.db.db
          .prepare("SELECT COUNT(*) AS cnt FROM memos WHERE status = 'active'")
          .get() as { cnt: number } | undefined;
        return { body: { ...status, wechatTransport, activeMemos: Number(row?.cnt ?? 0) } };
      },
    },
    {
      method: 'GET',
      path: '/local-watcher/inbox',
      handle: (_req, _params, url) => {
        const limitParam = url.searchParams.get('limit');
        const limit = limitParam ? Math.min(200, Math.max(1, Number(limitParam) || 50)) : 50;
        const items = watcher.listInbox({
          source: url.searchParams.get('source') || undefined,
          status: (url.searchParams.get('status') as InboxItem['status'] | null) || undefined,
          limit,
        });
        return { body: { items } };
      },
    },
    {
      method: 'GET',
      path: '/local-watcher/workstreams',
      handle: (_req, _params, url) => {
        const workstreams = watcher.listWorkstreams({
          sessionId: url.searchParams.get('sessionId') || undefined,
          status: (url.searchParams.get('status') as WatchStatus | null) || undefined,
        });
        return { body: { workstreams } };
      },
    },
    {
      method: 'POST',
      path: '/local-watcher/workstreams/:id/cancel',
      handle: async (req, params) => {
        const body = await readJsonBody(req, maxBodyBytes);
        const reason = optionalString(body.reason) ?? 'cancelled_by_ui';
        if (watcher.cancelWorkstream) {
          const ok = Boolean(await watcher.cancelWorkstream(params.id, reason));
          return { body: { ok, id: params.id } };
        }
        const now = new Date().toISOString();
        const result = watcher.db.db
          .prepare("UPDATE workstreams SET status = 'ended', end_reason = ?, updated_at = ? WHERE id = ?")
          .run(reason, now, params.id);
        return { body: { ok: Number(result.changes) > 0, id: params.id } };
      },
    },
    {
      method: 'GET',
      path: '/local-watcher/drafts',
      handle: (_req, _params, url) => {
        const status = url.searchParams.get('status') as StagedDraft['status'] | null;
        return { body: { drafts: watcher.listDrafts(status ? { status } : undefined) } };
      },
    },
    {
      method: 'POST',
      path: '/local-watcher/drafts/:id/approve',
      handle: async (_req, params) => {
        const result = await watcher.approveDraft(params.id);
        return { body: result };
      },
    },
    {
      method: 'POST',
      path: '/local-watcher/drafts/:id/discard',
      handle: async (req, params) => {
        const body = await readJsonBody(req, maxBodyBytes);
        await watcher.discardDraft(params.id, optionalString(body.reason) ?? undefined);
        return { body: { ok: true, id: params.id } };
      },
    },
    {
      method: 'GET',
      path: '/local-watcher/memos',
      handle: (_req, _params, url) => {
        const limitParam = url.searchParams.get('limit');
        const memos = listMemosFromDb(watcher.db, {
          status: url.searchParams.get('status') || undefined,
          kind: url.searchParams.get('kind') || undefined,
          roomKey: url.searchParams.get('roomKey') || undefined,
          sessionId: url.searchParams.get('sessionId') || undefined,
          limit: limitParam ? Number(limitParam) || 100 : 100,
        });
        return { body: { memos } };
      },
    },
    {
      method: 'POST',
      path: '/local-watcher/memos',
      handle: async (req) => {
        const body = await readJsonBody(req, maxBodyBytes);
        const memo = insertMemoIntoDb(watcher.db, body);
        return { status: 201, body: { memo } };
      },
    },
    {
      method: 'POST',
      path: '/local-watcher/memos/:id/cancel',
      handle: (_req, params) => {
        const existing = getMemoById(watcher.db, params.id);
        if (!existing) throw new HttpRouteError(404, 'memo_not_found');
        const now = new Date().toISOString();
        watcher.db.db
          .prepare("UPDATE memos SET status = 'torn', updated_at = ? WHERE id = ?")
          .run(now, params.id);
        return { body: { ok: true, memo: getMemoById(watcher.db, params.id) } };
      },
    },
    {
      method: 'POST',
      path: '/local-watcher/memos/:id/check',
      handle: async (_req, params) => {
        const existing = getMemoById(watcher.db, params.id);
        if (!existing) throw new HttpRouteError(404, 'memo_not_found');
        if (memoEngine?.checkNow) {
          const result = await memoEngine.checkNow(params.id);
          return { body: { ok: true, checked: true, result, memo: getMemoById(watcher.db, params.id) } };
        }
        const now = new Date().toISOString();
        watcher.db.db
          .prepare('UPDATE memos SET last_checked_at = ?, updated_at = ? WHERE id = ?')
          .run(now, now, params.id);
        return { body: { ok: true, checked: false, memo: getMemoById(watcher.db, params.id) } };
      },
    },
    {
      method: 'GET',
      path: '/local-watcher/personas',
      handle: () => ({ body: { personas: requireWardrobe().list() } }),
    },
    {
      method: 'POST',
      path: '/local-watcher/personas',
      handle: async (req) => {
        const body = await readJsonBody(req, maxBodyBytes);
        const kind = String(body.kind ?? 'original') as PersonaKind;
        if (!VALID_PERSONA_KINDS.has(kind)) {
          throw new HttpRouteError(400, 'invalid_persona_kind');
        }
        const persona = requireWardrobe().create(kind);
        return { status: 201, body: { persona } };
      },
    },
    {
      method: 'PUT',
      path: '/local-watcher/personas/:id',
      handle: async (req, params) => {
        const wardrobe = requireWardrobe();
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
      method: 'GET',
      path: '/local-watcher/personas/:id/memories',
      handle: (_req, params, url) => {
        const limitParam = url.searchParams.get('limit');
        const memories = requireWardrobe().listMemories(params.id, {
          scope: url.searchParams.get('scope') || undefined,
          limit: limitParam ? Math.min(200, Math.max(1, Number(limitParam) || 24)) : undefined,
        });
        return { body: { memories } };
      },
    },
    {
      method: 'PUT',
      path: '/local-watcher/personas/:id/memories/:memId',
      handle: async (req, params) => {
        const memId = Number(params.memId);
        if (!Number.isInteger(memId) || memId <= 0) {
          throw new HttpRouteError(400, 'invalid_memory_id');
        }
        const body = await readJsonBody(req, maxBodyBytes);
        const note = typeof body.note === 'string' ? body.note.trim() : '';
        if (!note) throw new HttpRouteError(400, 'memory_note_required');
        requireWardrobe().editMemory(params.id, memId, note);
        return { body: { ok: true, id: memId, note } };
      },
    },
    {
      method: 'DELETE',
      path: '/local-watcher/personas/:id/memories',
      handle: (_req, params, url) => {
        const result = requireWardrobe().clearMemories(params.id, url.searchParams.get('scope') || undefined);
        return { body: { ok: true, deleted: result.deleted } };
      },
    },
    {
      method: 'POST',
      path: '/local-watcher/personas/:id/learn-style',
      handle: async (req, params) => {
        const wardrobe = requireWardrobe();
        const body = await readJsonBody(req, maxBodyBytes);
        const current = wardrobe.get(params.id);
        const revision = typeof body.revision === 'number' ? body.revision : current.revision;
        const samples = Array.isArray(body.samples)
          ? (body.samples as Array<{ text: string; context?: string }>)
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
      path: '/local-watcher/personas/:id/preview',
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
        const result = await requireWardrobe().previewChat({
          personaId: params.id,
          message,
          history,
          scope: optionalString(body.scope) ?? undefined,
          channel: optionalString(body.channel) ?? undefined,
          ownerId: optionalString(body.ownerId) ?? undefined,
        });
        return { body: result };
      },
    },
    {
      method: 'POST',
      path: '/local-watcher/sources/:id/poll',
      handle: async (_req, params) => {
        const poller = watcher.pollSourceNow
          ? (sourceId: string) => watcher.pollSourceNow!(sourceId)
          : options.pollSource;
        if (!poller) {
          throw new HttpRouteError(404, 'source_poller_unavailable');
        }
        const result = await poller(params.id);
        return { body: { ok: true, sourceId: params.id, ...result } };
      },
    },
    {
      method: 'GET',
      path: '/local-watcher/github/config',
      handle: async () => {
        const admin = requireGitHubAdmin();
        const config = await admin.getConfig();
        return { body: config };
      },
    },
    {
      method: 'PUT',
      path: '/local-watcher/github/config',
      handle: async (req) => {
        const admin = requireGitHubAdmin();
        const body = await readJsonBody(req, maxBodyBytes);
        const updated = await admin.updateConfig(body as GitHubAdminConfigUpdate);
        return { body: updated };
      },
    },
    {
      method: 'POST',
      path: '/local-watcher/github/token',
      handle: async (req) => {
        const admin = requireGitHubAdmin();
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
      path: '/local-watcher/github/app',
      handle: async (req) => {
        const admin = requireGitHubAdmin();
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
      path: '/local-watcher/github/app/verify',
      handle: async (req) => {
        const admin = requireGitHubAdmin();
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
      path: '/local-watcher/github/app',
      handle: async () => {
        const admin = requireGitHubAdmin();
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
      path: '/local-watcher/github/poll',
      handle: async () => {
        const admin = requireGitHubAdmin();
        const result = await admin.pollNow();
        return { body: { ok: true, ...result } };
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

function normalizeRoutePathname(pathname: string): string {
  return pathname.replace(/^\/local-hub(?=\/|$)/, '/local-watcher');
}

export function createHubHttpHandler(
  watcher: HubHttpTarget,
  options: HubHttpOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const compiled = buildRoutes(watcher, options).map((route) => ({
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

export const createWatcherHttpHandler = createHubHttpHandler;

export function mountHttpRoutes(
  ctx: HubHttpContext,
  watcher: HubHttpTarget,
  options: HubHttpOptions = {},
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
  const ctxMemoEngine =
    typeof ctx.get === 'function'
      ? (ctx.get('memoEngine') as MemoEngineLike | undefined)
      : ctx.memoEngine;
  const mergedOptions: HubHttpOptions = {
    ...options,
    connection: resolveConnection(),
    memoEngine: options.memoEngine ?? ctxMemoEngine ?? watcher.memoEngine,
  };

  if (webServer.register.length <= 1) {
    const handler = createHubHttpHandler(watcher, {
      ...mergedOptions,
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
    const offHub = registerPrefix({
      kind: 'prefix',
      path: '/local-hub',
      handler,
    });
    const offWatcher = registerPrefix({
      kind: 'prefix',
      path: '/local-watcher',
      handler,
    });
    return () => {
      if (typeof offHub === 'function') offHub();
      if (typeof offWatcher === 'function') offWatcher();
    };
  }

  const routes = buildRoutes(watcher, mergedOptions);
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
    const hubPath = route.path.replace(/^\/local-watcher(?=\/|$)/, '/local-hub');
    const offHub = registerMethod(route.method, hubPath, invokeRoute);
    if (typeof offHub === 'function') disposers.push(offHub);
    const offWatcher = registerMethod(route.method, route.path, invokeRoute);
    if (typeof offWatcher === 'function') disposers.push(offWatcher);
  }

  return () => {
    while (disposers.length > 0) {
      disposers.pop()?.();
    }
  };
}
