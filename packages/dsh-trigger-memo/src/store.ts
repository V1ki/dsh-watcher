import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  HubDb,
  MemoKind,
  MemoRecord,
  MemoStatus,
} from '@local/dsh-hub/contracts';

export type DbHandle = HubDb | DatabaseSync;

export interface CreateMemoInput {
  id?: string;
  kind: MemoKind;
  roomKey: string;
  targetSessionId?: string | null;
  targetChatId?: string | null;
  source?: string;
  title?: string;
  basis: string;
  windowStart?: string | null;
  windowEnd?: string | null;
  randomFireAt?: string | null;
  intervalHours?: number | null;
  expiresAt?: string | null;
  keywords?: string[];
  knownFacts?: string[];
  knownFactsUpdatedAt?: string | null;
  acceptCriteria?: string | null;
  officialDomains?: string[];
  status?: MemoStatus;
  nextCheckAt?: string | null;
  notifyWechatChatId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ListMemosFilter {
  roomKey?: string;
  status?: MemoStatus | MemoStatus[];
  kind?: MemoKind;
  targetSessionId?: string;
  limit?: number;
}

export interface MemoSeenUrlRecord {
  memoId: string;
  url: string;
  title: string;
  publishedAt: string | null;
  verdict: string;
  seenAt: string;
}

export interface ProactiveBudgetRecord {
  id: number;
  roomKey: string;
  channel: string;
  memoId: string | null;
  sentAt: string;
  summary: string;
}

export type ProactiveBudgetMode = 'calendar_day' | 'rolling';

export interface MemoStoreOptions {
  maxActivePerRoom?: number;
  proactiveBudgetMode?: ProactiveBudgetMode;
  proactiveBudgetHours?: number;
  proactiveBudgetMaxPerRoom?: number;
}

export class MemoRoomCapError extends Error {
  readonly code = 'MEMO_ROOM_CAP_EXCEEDED';
  readonly roomKey: string;
  readonly activeCount: number;
  readonly limit: number;

  constructor(roomKey: string, activeCount: number, limit: number) {
    super(`Room "${roomKey}" already has ${activeCount} active memo(s), reaching cap ${limit}`);
    this.name = 'MemoRoomCapError';
    this.roomKey = roomKey;
    this.activeCount = activeCount;
    this.limit = limit;
  }
}

interface RawMemoRow {
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

interface RawSeenUrlRow {
  memo_id: string;
  url: string;
  title: string;
  published_at: string | null;
  verdict: string;
  seen_at: string;
}

interface RawBudgetRow {
  id: number;
  room_key: string;
  channel: string;
  memo_id: string | null;
  sent_at: string;
  summary: string;
}

const VALID_KINDS = new Set<MemoKind>(['time_nudge', 'news_followup', 'long_watch']);
const VALID_STATUSES = new Set<MemoStatus>(['active', 'fired', 'torn', 'completed', 'expired']);
const SCHEME_SEP = '//';
const TRACKING_QUERY_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'spm',
  'from',
  'ref',
  'fbclid',
  'gclid',
]);

function resolveSqlite(handle: DbHandle): DatabaseSync {
  if ('prepare' in handle && typeof handle.prepare === 'function') {
    return handle;
  }
  if ('db' in handle && handle.db && typeof handle.db.prepare === 'function') {
    return handle.db;
  }
  throw new TypeError('MemoStore requires a WatcherDb or node:sqlite DatabaseSync instance');
}

function safeParseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((v) => String(v).trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function safeParseRecord(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function normalizeStringList(items?: string[]): string[] {
  if (!Array.isArray(items)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const trimmed = String(item ?? '').trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function mapMemoRow(row: RawMemoRow): MemoRecord {
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
    keywords: safeParseStringArray(row.keywords_json),
    knownFacts: safeParseStringArray(row.known_facts_json),
    acceptCriteria: row.accept_criteria,
    officialDomains: safeParseStringArray(row.official_domains_json),
    status: row.status,
    lastCheckedAt: row.last_checked_at,
    nextCheckAt: row.next_check_at,
    notifyWechatChatId: row.notify_wechat_chat_id,
    resultSummary: row.result_summary,
    metadata: safeParseRecord(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function normalizeUrlKey(rawUrl: string): string {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    parsed.hash = '';
    const keptParams: Array<[string, string]> = [];
    for (const [k, v] of parsed.searchParams.entries()) {
      if (!TRACKING_QUERY_PARAMS.has(k.toLowerCase())) {
        keptParams.push([k, v]);
      }
    }
    keptParams.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
    parsed.search = '';
    for (const [k, v] of keptParams) {
      parsed.searchParams.append(k, v);
    }
    const hostname = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    const search = parsed.search;
    const protocol = parsed.protocol.toLowerCase();
    const port = parsed.port ? `:${parsed.port}` : '';
    return protocol + SCHEME_SEP + hostname + port + pathname + search;
  } catch {
    return trimmed.toLowerCase().replace(/\/+$/, '');
  }
}

export class MemoStore {
  readonly db: DatabaseSync;
  readonly maxActivePerRoom: number;
  readonly proactiveBudgetMode: ProactiveBudgetMode;
  readonly proactiveBudgetHours: number;
  readonly proactiveBudgetMaxPerRoom: number;

  constructor(handle: DbHandle, options: MemoStoreOptions = {}) {
    this.db = resolveSqlite(handle);
    this.maxActivePerRoom = Math.max(1, Number(options.maxActivePerRoom) || 5);
    this.proactiveBudgetMode =
      options.proactiveBudgetMode === 'rolling' ? 'rolling' : 'calendar_day';
    this.proactiveBudgetHours = Math.max(1, Number(options.proactiveBudgetHours) || 18);
    this.proactiveBudgetMaxPerRoom = Math.max(1, Number(options.proactiveBudgetMaxPerRoom) || 1);
  }

  countActiveMemos(roomKey: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS cnt FROM memos WHERE room_key = ? AND status = 'active'")
      .get(roomKey) as { cnt: number } | undefined;
    return Number(row?.cnt ?? 0);
  }

  createMemo(
    input: CreateMemoInput,
    options: { maxActivePerRoom?: number; now?: Date } = {},
  ): MemoRecord {
    if (!VALID_KINDS.has(input.kind)) {
      throw new TypeError(`Invalid memo kind: ${String(input.kind)}`);
    }
    const roomKey = String(input.roomKey || '').trim();
    if (!roomKey) {
      throw new TypeError('Memo requires a non-empty roomKey');
    }
    const basis = String(input.basis || '').trim();
    if (!basis) {
      throw new TypeError('Memo requires a non-empty basis');
    }
    const status: MemoStatus = input.status ?? 'active';
    if (!VALID_STATUSES.has(status)) {
      throw new TypeError(`Invalid memo status: ${String(status)}`);
    }

    const cap = Math.max(1, Number(options.maxActivePerRoom) || this.maxActivePerRoom);
    if (status === 'active') {
      const activeCount = this.countActiveMemos(roomKey);
      if (activeCount >= cap) {
        throw new MemoRoomCapError(roomKey, activeCount, cap);
      }
    }

    const nowIso = (options.now ?? new Date()).toISOString();
    const id = input.id?.trim() || `memo_${randomUUID()}`;
    const metadata: Record<string, unknown> = { ...(input.metadata ?? {}) };
    if (input.knownFactsUpdatedAt) {
      metadata.knownFactsUpdatedAt = input.knownFactsUpdatedAt;
    } else if (
      input.kind !== 'time_nudge' &&
      typeof metadata.knownFactsUpdatedAt !== 'string'
    ) {
      metadata.knownFactsUpdatedAt = nowIso;
    }

    this.db
      .prepare(
        `INSERT INTO memos (
           id, kind, room_key, target_session_id, target_chat_id, source, title, basis,
           window_start, window_end, random_fire_at, interval_hours, expires_at,
           keywords_json, known_facts_json, accept_criteria, official_domains_json,
           status, last_checked_at, next_check_at, notify_wechat_chat_id, result_summary,
           metadata_json, created_at, updated_at
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?,
           ?, ?, ?, ?,
           ?, ?, ?, ?, ?,
           ?, ?, ?
         )`,
      )
      .run(
        id,
        input.kind,
        roomKey,
        input.targetSessionId ?? null,
        input.targetChatId ?? null,
        input.source?.trim() || 'manual',
        String(input.title ?? '').trim(),
        basis,
        input.windowStart ?? null,
        input.windowEnd ?? null,
        input.randomFireAt ?? null,
        input.intervalHours ?? null,
        input.expiresAt ?? null,
        JSON.stringify(normalizeStringList(input.keywords)),
        JSON.stringify(normalizeStringList(input.knownFacts)),
        input.acceptCriteria?.trim() || null,
        JSON.stringify(normalizeStringList(input.officialDomains)),
        status,
        null,
        input.nextCheckAt ?? input.randomFireAt ?? null,
        input.notifyWechatChatId ?? null,
        null,
        JSON.stringify(metadata),
        nowIso,
        nowIso,
      );

    const created = this.getMemo(id);
    if (!created) {
      throw new Error(`Failed to persist memo ${id}`);
    }
    return created;
  }

  getMemo(id: string): MemoRecord | null {
    const row = this.db.prepare('SELECT * FROM memos WHERE id = ?').get(id) as
      | RawMemoRow
      | undefined;
    return row ? mapMemoRow(row) : null;
  }

  listMemos(filter: ListMemosFilter = {}): MemoRecord[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (filter.roomKey) {
      clauses.push('room_key = ?');
      params.push(filter.roomKey);
    }
    if (filter.kind) {
      clauses.push('kind = ?');
      params.push(filter.kind);
    }
    if (filter.targetSessionId) {
      clauses.push('target_session_id = ?');
      params.push(filter.targetSessionId);
    }
    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      if (statuses.length > 0) {
        clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`);
        params.push(...statuses);
      }
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.max(1, Math.min(500, Number(filter.limit) || 100));
    params.push(limit);

    const rows = this.db
      .prepare(`SELECT * FROM memos ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params) as unknown as RawMemoRow[];
    return rows.map(mapMemoRow);
  }

  listDueMemos(now: Date = new Date(), limit = 50): MemoRecord[] {
    const nowIso = now.toISOString();
    const maxRows = Math.max(1, Math.min(200, Number(limit) || 50));
    const rows = this.db
      .prepare(
        `SELECT * FROM memos
         WHERE status = 'active'
           AND (
             (expires_at IS NOT NULL AND expires_at <= ?)
             OR (next_check_at IS NULL)
             OR (next_check_at <= ?)
             OR (kind = 'time_nudge' AND random_fire_at IS NOT NULL AND random_fire_at <= ?)
           )
         ORDER BY COALESCE(next_check_at, random_fire_at, created_at) ASC
         LIMIT ?`,
      )
      .all(nowIso, nowIso, nowIso, maxRows) as unknown as RawMemoRow[];
    return rows.map(mapMemoRow);
  }

  updateMemoStatus(
    id: string,
    status: MemoStatus,
    patch: {
      resultSummary?: string | null;
      lastCheckedAt?: string | null;
      nextCheckAt?: string | null;
      metadata?: Record<string, unknown>;
      now?: Date;
    } = {},
  ): MemoRecord | null {
    if (!VALID_STATUSES.has(status)) {
      throw new TypeError(`Invalid memo status: ${String(status)}`);
    }
    const existing = this.getMemo(id);
    if (!existing) return null;

    const nowIso = (patch.now ?? new Date()).toISOString();
    const nextMetadata = patch.metadata
      ? { ...existing.metadata, ...patch.metadata }
      : existing.metadata;

    this.db
      .prepare(
        `UPDATE memos
         SET status = ?,
             result_summary = ?,
             last_checked_at = ?,
             next_check_at = ?,
             metadata_json = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        status,
        patch.resultSummary !== undefined ? patch.resultSummary : existing.resultSummary,
        patch.lastCheckedAt !== undefined ? patch.lastCheckedAt : existing.lastCheckedAt,
        patch.nextCheckAt !== undefined ? patch.nextCheckAt : null,
        JSON.stringify(nextMetadata),
        nowIso,
        id,
      );

    return this.getMemo(id);
  }

  updateMemoSchedule(
    id: string,
    patch: {
      lastCheckedAt?: string | null;
      nextCheckAt?: string | null;
      randomFireAt?: string | null;
      resultSummary?: string | null;
      knownFacts?: string[];
      metadata?: Record<string, unknown>;
      now?: Date;
    },
  ): MemoRecord | null {
    const existing = this.getMemo(id);
    if (!existing) return null;

    const nowIso = (patch.now ?? new Date()).toISOString();
    const nextMetadata = patch.metadata
      ? { ...existing.metadata, ...patch.metadata }
      : existing.metadata;

    this.db
      .prepare(
        `UPDATE memos
         SET last_checked_at = ?,
             next_check_at = ?,
             random_fire_at = ?,
             result_summary = ?,
             known_facts_json = ?,
             metadata_json = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        patch.lastCheckedAt !== undefined ? patch.lastCheckedAt : existing.lastCheckedAt,
        patch.nextCheckAt !== undefined ? patch.nextCheckAt : existing.nextCheckAt,
        patch.randomFireAt !== undefined ? patch.randomFireAt : existing.randomFireAt,
        patch.resultSummary !== undefined ? patch.resultSummary : existing.resultSummary,
        JSON.stringify(
          patch.knownFacts !== undefined
            ? normalizeStringList(patch.knownFacts)
            : existing.knownFacts,
        ),
        JSON.stringify(nextMetadata),
        nowIso,
        id,
      );

    return this.getMemo(id);
  }

  cancelMemo(id: string, reason = 'cancelled', now: Date = new Date()): MemoRecord | null {
    return this.updateMemoStatus(id, 'torn', {
      resultSummary: reason,
      nextCheckAt: null,
      now,
    });
  }

  deleteMemo(id: string): boolean {
    const res = this.db.prepare('DELETE FROM memos WHERE id = ?').run(id);
    return Number(res.changes) > 0;
  }

  hasSeenUrl(memoId: string, rawUrl: string): boolean {
    const key = normalizeUrlKey(rawUrl);
    if (!key) return false;
    const row = this.db
      .prepare('SELECT 1 AS found FROM memo_seen_urls WHERE memo_id = ? AND url = ?')
      .get(memoId, key) as { found: number } | undefined;
    return Boolean(row?.found);
  }

  getSeenUrlSet(memoId: string): Set<string> {
    const rows = this.db
      .prepare('SELECT url FROM memo_seen_urls WHERE memo_id = ?')
      .all(memoId) as unknown as Array<{ url: string }>;
    return new Set(rows.map((r) => r.url));
  }

  listSeenUrls(memoId: string): MemoSeenUrlRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM memo_seen_urls WHERE memo_id = ? ORDER BY seen_at DESC')
      .all(memoId) as unknown as RawSeenUrlRow[];
    return rows.map((r) => ({
      memoId: r.memo_id,
      url: r.url,
      title: r.title,
      publishedAt: r.published_at,
      verdict: r.verdict,
      seenAt: r.seen_at,
    }));
  }

  recordSeenUrl(
    memoId: string,
    entry: {
      url: string;
      title?: string;
      publishedAt?: string | null;
      verdict?: string;
      seenAt?: string;
    },
  ): void {
    const key = normalizeUrlKey(entry.url);
    if (!key) return;
    const seenAt = entry.seenAt || new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO memo_seen_urls (memo_id, url, title, published_at, verdict, seen_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(memo_id, url) DO UPDATE SET
           title = CASE WHEN excluded.title != '' THEN excluded.title ELSE memo_seen_urls.title END,
           published_at = COALESCE(excluded.published_at, memo_seen_urls.published_at),
           verdict = excluded.verdict,
           seen_at = excluded.seen_at`,
      )
      .run(
        memoId,
        key,
        String(entry.title ?? '').trim(),
        entry.publishedAt ?? null,
        entry.verdict ?? 'seen',
        seenAt,
      );
  }

  private resolveBudgetWindowStart(
    now: Date,
    mode: ProactiveBudgetMode,
    windowHours: number,
  ): Date {
    if (mode === 'calendar_day') {
      return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    }
    return new Date(now.getTime() - windowHours * 3_600_000);
  }

  countProactiveInWindow(
    roomKey: string,
    options: {
      mode?: ProactiveBudgetMode;
      windowHours?: number;
      now?: Date;
      channel?: string;
    } = {},
  ): number {
    const mode = options.mode ?? this.proactiveBudgetMode;
    const windowHours = Math.max(1, Number(options.windowHours) || this.proactiveBudgetHours);
    const now = options.now ?? new Date();
    const sinceIso = this.resolveBudgetWindowStart(now, mode, windowHours).toISOString();

    if (options.channel) {
      const row = this.db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM proactive_budget
           WHERE room_key = ? AND channel = ? AND sent_at >= ?`,
        )
        .get(roomKey, options.channel, sinceIso) as { cnt: number } | undefined;
      return Number(row?.cnt ?? 0);
    }

    const row = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM proactive_budget WHERE room_key = ? AND sent_at >= ?')
      .get(roomKey, sinceIso) as { cnt: number } | undefined;
    return Number(row?.cnt ?? 0);
  }

  hasProactiveBudget(
    roomKey: string,
    options: {
      mode?: ProactiveBudgetMode;
      windowHours?: number;
      maxPerRoom?: number;
      now?: Date;
      channel?: string;
    } = {},
  ): boolean {
    const limit = Math.max(1, Number(options.maxPerRoom) || this.proactiveBudgetMaxPerRoom);
    const used = this.countProactiveInWindow(roomKey, options);
    return used < limit;
  }

  getNextProactiveBudgetAt(
    roomKey: string,
    options: {
      mode?: ProactiveBudgetMode;
      windowHours?: number;
      maxPerRoom?: number;
      now?: Date;
      channel?: string;
    } = {},
  ): Date | null {
    const mode = options.mode ?? this.proactiveBudgetMode;
    const windowHours = Math.max(1, Number(options.windowHours) || this.proactiveBudgetHours);
    const limit = Math.max(1, Number(options.maxPerRoom) || this.proactiveBudgetMaxPerRoom);
    const now = options.now ?? new Date();
    const sinceIso = this.resolveBudgetWindowStart(now, mode, windowHours).toISOString();

    const rows = options.channel
      ? (this.db
          .prepare(
            `SELECT sent_at FROM proactive_budget
             WHERE room_key = ? AND channel = ? AND sent_at >= ?
             ORDER BY sent_at DESC`,
          )
          .all(roomKey, options.channel, sinceIso) as unknown as Array<{ sent_at: string }>)
      : (this.db
          .prepare(
            `SELECT sent_at FROM proactive_budget
             WHERE room_key = ? AND sent_at >= ?
             ORDER BY sent_at DESC`,
          )
          .all(roomKey, sinceIso) as unknown as Array<{ sent_at: string }>);

    if (rows.length < limit) {
      return null;
    }

    if (mode === 'calendar_day') {
      return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
    }

    const blockingRow = rows[limit - 1];
    const blockingMs = Date.parse(blockingRow.sent_at);
    if (!Number.isFinite(blockingMs)) {
      return new Date(now.getTime() + windowHours * 3_600_000);
    }
    return new Date(blockingMs + windowHours * 3_600_000 + 1_000);
  }

  recordProactiveSend(entry: {
    roomKey: string;
    channel?: string;
    memoId?: string | null;
    summary?: string;
    sentAt?: string;
  }): ProactiveBudgetRecord {
    const sentAt = entry.sentAt || new Date().toISOString();
    const channel = entry.channel || 'wechat';
    const summary = String(entry.summary ?? '').slice(0, 300);
    const res = this.db
      .prepare(
        `INSERT INTO proactive_budget (room_key, channel, memo_id, sent_at, summary)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(entry.roomKey, channel, entry.memoId ?? null, sentAt, summary);

    return {
      id: Number(res.lastInsertRowid),
      roomKey: entry.roomKey,
      channel,
      memoId: entry.memoId ?? null,
      sentAt,
      summary,
    };
  }

  listProactiveBudget(roomKey: string, limit = 20): ProactiveBudgetRecord[] {
    const maxRows = Math.max(1, Math.min(200, Number(limit) || 20));
    const rows = this.db
      .prepare(
        'SELECT * FROM proactive_budget WHERE room_key = ? ORDER BY sent_at DESC LIMIT ?',
      )
      .all(roomKey, maxRows) as unknown as RawBudgetRow[];
    return rows.map((r) => ({
      id: r.id,
      roomKey: r.room_key,
      channel: r.channel,
      memoId: r.memo_id,
      sentAt: r.sent_at,
      summary: r.summary,
    }));
  }
}

export function createMemoStore(handle: DbHandle, options?: MemoStoreOptions): MemoStore {
  return new MemoStore(handle, options);
}
