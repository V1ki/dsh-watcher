import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { normalizeProactiveParts } from './automation.js';
import { loadLocalImage } from './outgoing-image.js';

const DEFAULT_FALLBACK_ORIGIN = 'http://localhost';
const MAX_BODY_BYTES = 65_536;
const DEFAULT_RECENT_LIMIT = 20;
const MAX_RECENT_LIMIT = 200;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export type HostBridgeDeliveryStatus = 'sent' | 'staged' | 'uncertain' | 'skipped' | 'failed';

export interface HostBridgeSendRequest {
  chatId: string;
  text: string | string[];
  imagePath?: string;
  idempotencyKey: string;
  mode?: 'send' | 'draft';
  reason?: string;
  expectedOwnId?: string;
}

export interface HostBridgeSendResponse {
  status: HostBridgeDeliveryStatus;
  deliveryId?: string;
  detail?: string;
}

export interface HostBridgeMessage {
  seq?: number;
  chatId: string;
  sender?: string;
  senderId?: string;
  isOwn?: boolean;
  text: string;
  timestamp: number;
}

export interface HostBridgeRecentParams {
  chatId: string;
  limit?: number;
  sinceTs?: number;
}

export interface HostBridgeRecentResponse {
  chatId: string;
  healthy: boolean;
  paused: boolean;
  ownId?: string;
  messages: HostBridgeMessage[];
  lastMessageAt: number | null;
  secondsSinceLastMessage: number | null;
  ownSpokeSince: boolean;
}

export interface HostBridgeStatusResponse {
  ok: boolean;
  healthy: boolean;
  ownId?: string;
  controllerId?: string;
  queueDepth: number;
  activeDeliveryId: string | null;
  detail?: string;
}

export interface HostBridgeListenerLike {
  status(): { healthy: boolean; [key: string]: unknown };
  tick?: () => Promise<void>;
}

export interface HostBridgeAutomationLike {
  active?: unknown;
  settings?: () => { policy?: { ownId?: string; personaId?: string; controllerId?: string } };
  stickers?: { lease?: unknown };
}

export interface HostBridgeDeliverContext {
  deliveryId: string;
  session: string;
  parts: string[];
  imagePath?: string;
  mode: 'send' | 'draft';
  reason: string;
  signal?: AbortSignal;
}

export interface HostBridgeOptions {
  db: DatabaseSync;
  token?: string | (() => string | null | undefined);
  ownId?: string | (() => string | null | undefined);
  controllerId?: string | (() => string | null | undefined);
  personaId?: string | (() => string | null | undefined);
  listener?: HostBridgeListenerLike;
  automation?: HostBridgeAutomationLike;
  allowLanHost?: boolean;
  verifyTarget?: (session: string, signal?: AbortSignal) => Promise<void> | void;
  prepareSend?: (ctx: HostBridgeDeliverContext) => Promise<void> | void;
  deliverParts?: (ctx: HostBridgeDeliverContext) => Promise<void> | void;
  now?: () => number;
}

interface ProactiveDeliveryRow {
  id: string;
  idempotency_key: string;
  session: string;
  parts_json: string;
  mode: string;
  status: string;
  detail: string;
  reason: string;
  clicked_at: number | null;
  created_at: number;
  updated_at: number;
}

interface EventTableRow {
  seq: number;
  payload: string;
}

export function ensureHostBridgeTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS proactive_deliveries (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    session TEXT NOT NULL,
    parts_json TEXT NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    clicked_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_proactive_deliveries_session_created ON proactive_deliveries (session, created_at DESC)',
  );
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { name?: string } | undefined;
  return Boolean(row?.name);
}

function normalizeParts(
  text: string | string[] | undefined,
  allowEmpty = false,
): { ok: true; parts: string[] } | { ok: false; error: string } {
  return normalizeProactiveParts(text, allowEmpty);
}

function normalizeTimestampMs(rawTs: unknown): number {
  const num = Number(rawTs);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return num < 10_000_000_000 ? Math.floor(num * 1000) : Math.floor(num);
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function constantTimeTokenMatch(expected: string, actual: string): boolean {
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(actual, 'utf8');
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

function extractHostname(hostHeader: string | undefined): string {
  if (!hostHeader) return '';
  const trimmed = hostHeader.trim();
  if (trimmed.startsWith('[')) {
    const closeIdx = trimmed.indexOf(']');
    return closeIdx > 0 ? trimmed.slice(0, closeIdx + 1).toLowerCase() : '';
  }
  const colonIdx = trimmed.lastIndexOf(':');
  return (colonIdx >= 0 ? trimmed.slice(0, colonIdx) : trimmed).toLowerCase();
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      const err = new Error('Request payload too large') as Error & { statusCode?: number };
      err.statusCode = 413;
      throw err;
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const err = new Error('JSON body must be an object') as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof Error && 'statusCode' in err) throw err;
    const parseErr = new Error('Invalid JSON body') as Error & { statusCode?: number };
    parseErr.statusCode = 400;
    throw parseErr;
  }
}

export class WxarcHostBridge {
  private readonly db: DatabaseSync;
  private readonly tokenProvider?: string | (() => string | null | undefined);
  private readonly ownIdProvider?: string | (() => string | null | undefined);
  private readonly controllerIdProvider?: string | (() => string | null | undefined);
  private readonly personaIdProvider?: string | (() => string | null | undefined);
  private readonly listener?: HostBridgeListenerLike;
  private readonly automation?: HostBridgeAutomationLike;
  private readonly allowLanHost: boolean;
  private readonly verifyTarget?: (session: string, signal?: AbortSignal) => Promise<void> | void;
  private readonly prepareSend?: (ctx: HostBridgeDeliverContext) => Promise<void> | void;
  private readonly deliverParts?: (ctx: HostBridgeDeliverContext) => Promise<void> | void;
  private readonly now: () => number;
  private queueTail: Promise<void>;
  private queueDepth: number;
  private activeDeliveryId: string | null;
  private readonly inFlightDeliveries: Map<string, Promise<HostBridgeSendResponse>>;

  constructor(options: HostBridgeOptions) {
    this.db = options.db;
    this.tokenProvider = options.token;
    this.ownIdProvider = options.ownId;
    this.controllerIdProvider = options.controllerId;
    this.personaIdProvider = options.personaId;
    this.listener = options.listener;
    this.automation = options.automation;
    this.allowLanHost = Boolean(options.allowLanHost);
    this.verifyTarget = options.verifyTarget;
    this.prepareSend = options.prepareSend;
    this.deliverParts = options.deliverParts;
    this.now = options.now ?? Date.now;
    this.queueTail = Promise.resolve();
    this.queueDepth = 0;
    this.activeDeliveryId = null;
    this.inFlightDeliveries = new Map();

    ensureHostBridgeTables(this.db);
    this.recoverInterruptedDeliveries();
  }

  private recoverInterruptedDeliveries(): void {
    this.db
      .prepare(
        `UPDATE proactive_deliveries
         SET status = 'uncertain',
             detail = 'Interrupted during active send before restart; never automatically replayed',
             updated_at = ?
         WHERE status = 'sending'`,
      )
      .run(this.now());
  }

  private resolveToken(): string {
    const raw =
      typeof this.tokenProvider === 'function' ? this.tokenProvider() : this.tokenProvider;
    return typeof raw === 'string' ? raw.trim() : '';
  }

  getOwnId(): string {
    const raw =
      typeof this.ownIdProvider === 'function'
        ? this.ownIdProvider()
        : this.ownIdProvider ?? this.automation?.settings?.().policy?.ownId;
    return typeof raw === 'string' ? raw.trim() : '';
  }

  getControllerId(): string {
    const raw =
      typeof this.controllerIdProvider === 'function'
        ? this.controllerIdProvider()
        : this.controllerIdProvider ?? this.automation?.settings?.().policy?.controllerId;
    return typeof raw === 'string' ? raw.trim() : '';
  }

  private getPersonaId(): string {
    const raw =
      typeof this.personaIdProvider === 'function'
        ? this.personaIdProvider()
        : this.personaIdProvider ?? this.automation?.settings?.().policy?.personaId;
    return typeof raw === 'string' ? raw.trim() : '';
  }

  private isHealthy(): boolean {
    if (!this.listener) return true;
    try {
      return Boolean(this.listener.status()?.healthy);
    } catch {
      return false;
    }
  }

  private isChatPaused(session: string): boolean {
    if (!tableExists(this.db, 'wxarc_chat_state')) return false;
    const ownId = this.getOwnId();
    const personaId = this.getPersonaId();
    if (ownId) {
      const exactScope = JSON.stringify([ownId, personaId, session]);
      const exactRow = this.db
        .prepare('SELECT paused FROM wxarc_chat_state WHERE scope = ?')
        .get(exactScope) as { paused?: number } | undefined;
      if (exactRow !== undefined) {
        return Number(exactRow.paused) === 1;
      }
    }
    const fallbackRow = this.db
      .prepare(
        "SELECT MAX(paused) AS paused FROM wxarc_chat_state WHERE json_extract(scope, '$[2]') = ?",
      )
      .get(session) as { paused?: number | null } | undefined;
    return Number(fallbackRow?.paused ?? 0) === 1;
  }

  status(): HostBridgeStatusResponse {
    const healthy = this.isHealthy();
    const ownId = this.getOwnId();
    const controllerId = this.getControllerId();
    return {
      ok: true,
      healthy,
      ownId: ownId || undefined,
      controllerId: controllerId || undefined,
      queueDepth: this.queueDepth,
      activeDeliveryId: this.activeDeliveryId,
      detail: healthy ? 'ready' : 'listener_unhealthy',
    };
  }

  listDeliveries(limit = 50): ProactiveDeliveryRow[] {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    return this.db
      .prepare('SELECT * FROM proactive_deliveries ORDER BY created_at DESC LIMIT ?')
      .all(safeLimit) as unknown as ProactiveDeliveryRow[];
  }

  async recentMessages(
    params: HostBridgeRecentParams,
    _signal?: AbortSignal,
  ): Promise<HostBridgeRecentResponse> {
    const chatId = String(params?.chatId || '').trim();
    if (!chatId) {
      throw new Error('chatId is required');
    }

    const limit = Math.max(
      1,
      Math.min(MAX_RECENT_LIMIT, Math.floor(Number(params.limit) || DEFAULT_RECENT_LIMIT)),
    );
    const sinceTsMs =
      params.sinceTs !== undefined && Number.isFinite(Number(params.sinceTs))
        ? normalizeTimestampMs(params.sinceTs)
        : 0;

    if (this.listener && !this.isHealthy() && typeof this.listener.tick === 'function') {
      try {
        await this.listener.tick();
      } catch {
        void 0;
      }
    }

    const healthy = this.isHealthy();
    const paused = this.isChatPaused(chatId);
    const ownId = this.getOwnId();
    const messages: HostBridgeMessage[] = [];

    if (tableExists(this.db, 'events')) {
      const rows = this.db
        .prepare(
          `SELECT seq, payload
           FROM events
           WHERE kind = 'text' AND json_extract(payload, '$.session') = ?
           ORDER BY seq DESC
           LIMIT ?`,
        )
        .all(chatId, limit) as unknown as EventTableRow[];

      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.payload) as Record<string, unknown>;
          const tsMs = normalizeTimestampMs(parsed.ts ?? parsed.timestamp);
          if (sinceTsMs > 0 && tsMs > 0 && tsMs < sinceTsMs) {
            continue;
          }
          const senderId =
            typeof parsed.senderId === 'string'
              ? parsed.senderId
              : typeof parsed.sender_id === 'string'
                ? parsed.sender_id
                : undefined;
          const sender = typeof parsed.sender === 'string' ? parsed.sender : undefined;
          const isOwn =
            parsed.isOwn === true ||
            parsed.is_own === true ||
            (Boolean(ownId) && (senderId === ownId || sender === ownId));
          const text = typeof parsed.text === 'string' ? parsed.text : '';
          messages.push({
            seq: row.seq,
            chatId,
            sender,
            senderId,
            isOwn,
            text,
            timestamp: tsMs,
          });
        } catch {
          void 0;
        }
      }
    }

    messages.reverse();

    let lastMessageAt: number | null = null;
    let ownSpokeSince = false;
    for (const msg of messages) {
      if (msg.timestamp > 0 && (lastMessageAt === null || msg.timestamp > lastMessageAt)) {
        lastMessageAt = msg.timestamp;
      }
      if (msg.isOwn && (sinceTsMs === 0 || msg.timestamp >= sinceTsMs)) {
        ownSpokeSince = true;
      }
    }

    const nowMs = this.now();
    const secondsSinceLastMessage =
      lastMessageAt !== null ? Math.max(0, Math.floor((nowMs - lastMessageAt) / 1000)) : null;

    return {
      chatId,
      healthy,
      paused,
      ownId: ownId || undefined,
      messages,
      lastMessageAt,
      secondsSinceLastMessage,
      ownSpokeSince,
    };
  }

  async send(
    input: HostBridgeSendRequest,
    signal?: AbortSignal,
  ): Promise<HostBridgeSendResponse> {
    const session = String(input?.chatId || '').trim();
    if (!session) {
      return { status: 'failed', detail: 'Missing chatId' };
    }

    const idempotencyKey = String(input?.idempotencyKey || '').trim();
    if (!idempotencyKey) {
      return { status: 'failed', detail: 'Missing idempotencyKey' };
    }

    const mode = input.mode === 'draft' ? 'draft' : 'send';
    const reason = typeof input.reason === 'string' ? input.reason.slice(0, 300) : '';

    if (input.imagePath !== undefined && typeof input.imagePath !== 'string') {
      return { status: 'failed', detail: 'Invalid imagePath' };
    }
    const imagePath = typeof input.imagePath === 'string' ? input.imagePath.trim() : '';
    if (imagePath) {
      try {
        loadLocalImage(imagePath);
      } catch (err) {
        return { status: 'failed', detail: formatError(err) };
      }
    }

    const normalized = normalizeParts(input.text, Boolean(imagePath));
    if (!normalized.ok) {
      return { status: 'failed', detail: normalized.error };
    }

    const currentOwnId = this.getOwnId();
    const expectedOwnId =
      typeof input.expectedOwnId === 'string' ? input.expectedOwnId.trim() : '';
    if (expectedOwnId && currentOwnId && expectedOwnId !== currentOwnId) {
      return {
        status: 'failed',
        detail: `Account ownId mismatch: expected "${expectedOwnId}", bridge bound to "${currentOwnId}"`,
      };
    }
    if (expectedOwnId && !currentOwnId) {
      return {
        status: 'failed',
        detail: `Account ownId verification failed: bridge has no configured ownId (expected "${expectedOwnId}")`,
      };
    }

    const inFlight = this.inFlightDeliveries.get(idempotencyKey);
    if (inFlight) {
      return inFlight;
    }

    const existing = this.db
      .prepare('SELECT * FROM proactive_deliveries WHERE idempotency_key = ?')
      .get(idempotencyKey) as ProactiveDeliveryRow | undefined;

    if (existing) {
      if (existing.status === 'sent') {
        return {
          status: 'sent',
          deliveryId: existing.id,
          detail: 'Idempotent replay: already sent',
        };
      }
      if (existing.status === 'uncertain' || existing.status === 'sending') {
        return {
          status: 'uncertain',
          deliveryId: existing.id,
          detail: existing.detail || 'Previous delivery uncertain; never automatically replayed',
        };
      }
      if (existing.status === 'staged' && mode === 'draft') {
        return {
          status: 'staged',
          deliveryId: existing.id,
          detail: existing.detail || 'Draft already staged',
        };
      }
    }

    const nowMs = this.now();
    const deliveryId = existing?.id ?? `wxp_${randomUUID()}`;
    const storedParts = imagePath ? [...normalized.parts, `[image:${imagePath}]`] : normalized.parts;

    if (mode === 'draft') {
      this.upsertDelivery({
        id: deliveryId,
        idempotencyKey,
        session,
        parts: storedParts,
        mode,
        status: 'staged',
        detail: 'Staged as proactive draft',
        reason,
        clickedAt: null,
        nowMs,
      });
      return {
        status: 'staged',
        deliveryId,
        detail: imagePath
          ? `Staged ${normalized.parts.length} segment(s) and 1 image for ${session}`
          : `Staged ${normalized.parts.length} segment(s) for ${session}`,
      };
    }

    this.upsertDelivery({
      id: deliveryId,
      idempotencyKey,
      session,
      parts: storedParts,
      mode,
      status: 'queued',
      detail: 'Queued for serialized GUI delivery',
      reason,
      clickedAt: null,
      nowMs,
    });

    const taskPromise: Promise<HostBridgeSendResponse> = this.enqueueSerialized<HostBridgeSendResponse>(
      async (): Promise<HostBridgeSendResponse> => {
      this.activeDeliveryId = deliveryId;
      try {
        const currentRow = this.db
          .prepare('SELECT id, status, detail FROM proactive_deliveries WHERE idempotency_key = ?')
          .get(idempotencyKey) as { id: string; status: string; detail: string } | undefined;
        if (currentRow?.status === 'sent') {
          return {
            status: 'sent' as const,
            deliveryId: currentRow.id,
            detail: 'Idempotent replay: already sent',
          };
        }
        if (currentRow?.status === 'uncertain' || currentRow?.status === 'sending') {
          return {
            status: 'uncertain' as const,
            deliveryId: currentRow.id,
            detail:
              currentRow.detail || 'Previous delivery uncertain; never automatically replayed',
          };
        }
        if (signal?.aborted) {
          this.updateDeliveryStatus(deliveryId, 'failed', 'Aborted before send started');
          return { status: 'failed', deliveryId, detail: 'Aborted before send started' };
        }

        if (this.automation?.stickers?.lease) {
          this.updateDeliveryStatus(
            deliveryId,
            'failed',
            'Sticker panel lease active; skipped GUI conflict',
          );
          return {
            status: 'skipped',
            deliveryId,
            detail: 'Sticker panel lease active; skipped GUI conflict',
          };
        }

        const deliverCtx: HostBridgeDeliverContext = {
          deliveryId,
          session,
          parts: normalized.parts,
          ...(imagePath ? { imagePath } : {}),
          mode,
          reason,
          signal,
        };

        if (this.verifyTarget) {
          try {
            await this.verifyTarget(session, signal);
          } catch (err) {
            const detail = `Target verification failed: ${formatError(err)}`;
            this.updateDeliveryStatus(deliveryId, 'failed', detail);
            return { status: 'failed', deliveryId, detail };
          }
        }

        if (this.prepareSend) {
          try {
            await this.prepareSend(deliverCtx);
          } catch (err) {
            const detail = `Pre-send prepare failed: ${formatError(err)}`;
            this.updateDeliveryStatus(deliveryId, 'failed', detail);
            return { status: 'failed', deliveryId, detail };
          }
        }

        const clickedAt = this.now();
        this.db
          .prepare(
            `UPDATE proactive_deliveries
             SET status = 'sending',
                 detail = 'Commit in progress',
                 clicked_at = ?,
                 updated_at = ?
             WHERE id = ?`,
          )
          .run(clickedAt, clickedAt, deliveryId);

        try {
          if (this.deliverParts) {
            await this.deliverParts(deliverCtx);
          }
        } catch (err) {
          const detail = `Mid-send failure (${formatError(err)}); marked uncertain and never automatically replayed`;
          this.updateDeliveryStatus(deliveryId, 'uncertain', detail);
          return { status: 'uncertain', deliveryId, detail };
        }

        const detail = imagePath
          ? normalized.parts.length > 0
            ? `Delivered ${normalized.parts.length} segment(s) and 1 image to ${session}`
            : `Delivered 1 image to ${session}`
          : `Delivered ${normalized.parts.length} segment(s) to ${session}`;
        this.updateDeliveryStatus(deliveryId, 'sent', detail);
        return {
          status: 'sent',
          deliveryId,
          detail,
        };
      } finally {
        this.activeDeliveryId = null;
      }
    }).finally(() => {
      this.inFlightDeliveries.delete(idempotencyKey);
    });
    this.inFlightDeliveries.set(idempotencyKey, taskPromise);
    return taskPromise;
  }

  private upsertDelivery(params: {
    id: string;
    idempotencyKey: string;
    session: string;
    parts: string[];
    mode: string;
    status: string;
    detail: string;
    reason: string;
    clickedAt: number | null;
    nowMs: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO proactive_deliveries (
           id, idempotency_key, session, parts_json, mode, status, detail, reason,
           clicked_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(idempotency_key) DO UPDATE SET
           parts_json = excluded.parts_json,
           mode = excluded.mode,
           status = excluded.status,
           detail = excluded.detail,
           reason = excluded.reason,
           updated_at = excluded.updated_at`,
      )
      .run(
        params.id,
        params.idempotencyKey,
        params.session,
        JSON.stringify(params.parts),
        params.mode,
        params.status,
        params.detail,
        params.reason,
        params.clickedAt,
        params.nowMs,
        params.nowMs,
      );
  }

  private updateDeliveryStatus(id: string, status: string, detail: string): void {
    this.db
      .prepare('UPDATE proactive_deliveries SET status = ?, detail = ?, updated_at = ? WHERE id = ?')
      .run(status, detail, this.now(), id);
  }

  private enqueueSerialized<T>(task: () => Promise<T>): Promise<T> {
    this.queueDepth += 1;
    const run = this.queueTail.then(async () => {
      try {
        return await task();
      } finally {
        this.queueDepth = Math.max(0, this.queueDepth - 1);
      }
    });
    this.queueTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const parsedUrl = new URL(req.url || '/', DEFAULT_FALLBACK_ORIGIN);
    const pathname = parsedUrl.pathname;
    if (!pathname.startsWith('/wxarc/bridge/')) {
      return false;
    }

    if (!this.allowLanHost) {
      const host = extractHostname(req.headers.host);
      if (host && !LOOPBACK_HOSTS.has(host)) {
        sendJson(res, 403, { error: 'Forbidden: loopback host required' });
        return true;
      }
    }

    const expectedToken = this.resolveToken();
    if (!expectedToken) {
      sendJson(res, 503, { error: 'Bridge Bearer token not configured' });
      return true;
    }

    const authHeader = String(req.headers.authorization || '');
    const prefix = 'Bearer ';
    if (!authHeader.startsWith(prefix)) {
      sendJson(res, 401, { error: 'Unauthorized: missing Bearer token' });
      return true;
    }
    const providedToken = authHeader.slice(prefix.length).trim();
    if (!providedToken || !constantTimeTokenMatch(expectedToken, providedToken)) {
      sendJson(res, 401, { error: 'Unauthorized: invalid Bearer token' });
      return true;
    }

    try {
      if (pathname === '/wxarc/bridge/status' && req.method === 'GET') {
        sendJson(res, 200, this.status());
        return true;
      }

      if (pathname === '/wxarc/bridge/recent' && (req.method === 'GET' || req.method === 'POST')) {
        let chatId = '';
        let limit: number | undefined;
        let sinceTs: number | undefined;

        if (req.method === 'GET') {
          chatId =
            parsedUrl.searchParams.get('chatId') || parsedUrl.searchParams.get('session') || '';
          const limitParam = parsedUrl.searchParams.get('limit');
          const sinceParam = parsedUrl.searchParams.get('sinceTs');
          if (limitParam !== null && limitParam !== '') limit = Number(limitParam);
          if (sinceParam !== null && sinceParam !== '') sinceTs = Number(sinceParam);
        } else {
          const body = await readJsonBody(req);
          chatId = String(body.chatId || body.session || '');
          if (body.limit !== undefined) limit = Number(body.limit);
          if (body.sinceTs !== undefined) sinceTs = Number(body.sinceTs);
        }

        if (!chatId.trim()) {
          sendJson(res, 400, { error: 'Missing chatId' });
          return true;
        }
        const result = await this.recentMessages({ chatId, limit, sinceTs });
        sendJson(res, 200, result);
        return true;
      }

      if (pathname === '/wxarc/bridge/send' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const result = await this.send({
          chatId: String(body.chatId || body.session || ''),
          text: body.text as string | string[],
          imagePath: typeof body.imagePath === 'string' ? body.imagePath : undefined,
          idempotencyKey: String(body.idempotencyKey || ''),
          mode: body.mode === 'draft' ? 'draft' : 'send',
          reason: typeof body.reason === 'string' ? body.reason : undefined,
          expectedOwnId:
            typeof body.expectedOwnId === 'string' ? body.expectedOwnId : undefined,
        });
        sendJson(res, 200, result);
        return true;
      }

      sendJson(res, 404, { error: 'Not found' });
      return true;
    } catch (err) {
      const statusCode =
        err instanceof Error && 'statusCode' in err && typeof err.statusCode === 'number'
          ? err.statusCode
          : 500;
      sendJson(res, statusCode, { error: formatError(err) });
      return true;
    }
  }

  asHttpListener(): (req: IncomingMessage, res: ServerResponse) => void {
    return (req, res) => {
      void this.handleHttpRequest(req, res).then((handled) => {
        if (!handled && !res.writableEnded) {
          sendJson(res, 404, { error: 'Not found' });
        }
      });
    };
  }
}

export function createWxarcHostBridge(options: HostBridgeOptions): WxarcHostBridge {
  return new WxarcHostBridge(options);
}
