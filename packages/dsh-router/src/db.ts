import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  NotifyChannel,
  RouterActionLevel,
  RouterDecisionRecord,
  RouterDecisionStatus,
  RouterNotificationRecord,
  RouterStatsView,
  WorkerReportMode,
} from './contracts.js';

export interface RouterDbOptions {
  stateDir?: string;
  homeDir?: string;
  inMemory?: boolean;
}

export interface ListDecisionsFilter {
  source?: string;
  status?: RouterDecisionStatus;
  level?: RouterActionLevel;
  since?: string;
  limit?: number;
}

export interface ListNotificationsFilter {
  status?: RouterNotificationRecord['status'];
  channel?: NotifyChannel;
  decisionId?: string;
  limit?: number;
}

type SqlRow = Record<string, unknown>;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS router_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS router_decisions (
  id TEXT PRIMARY KEY,
  inbox_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  source TEXT NOT NULL,
  thread_key TEXT NOT NULL,
  actor TEXT NOT NULL,
  level TEXT NOT NULL,
  summary TEXT NOT NULL,
  reason TEXT NOT NULL,
  question TEXT,
  options_json TEXT NOT NULL DEFAULT '[]',
  recommended_index INTEGER,
  answered_option TEXT,
  status TEXT NOT NULL,
  destination TEXT NOT NULL,
  worker_session_id TEXT,
  subscription_id TEXT,
  triage_restored INTEGER NOT NULL DEFAULT 0,
  raw_url TEXT,
  event_type TEXT,
  event_occurred_at TEXT,
  image_path TEXT,
  draft_text TEXT,
  blindspot TEXT,
  report_mode TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_router_decisions_source_created
  ON router_decisions (source, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_router_decisions_status_updated
  ON router_decisions (status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_router_decisions_thread
  ON router_decisions (source, thread_key);

CREATE TABLE IF NOT EXISTS router_notifications (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  target TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  reason TEXT NOT NULL,
  raw_url TEXT,
  status TEXT NOT NULL,
  due_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (decision_id) REFERENCES router_decisions(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_router_notifications_status_due
  ON router_notifications (status, due_at);

CREATE INDEX IF NOT EXISTS idx_router_notifications_decision
  ON router_notifications (decision_id, created_at DESC);
`;

export function resolveRouterStateDir(stateDir?: string, homeDir?: string): string {
  const baseHome = homeDir ?? os.homedir();
  if (typeof stateDir === 'string' && stateDir.trim()) {
    const trimmed = stateDir.trim();
    if (trimmed === '~') return baseHome;
    return trimmed.startsWith('~/') ? path.join(baseHome, trimmed.slice(2)) : path.resolve(trimmed);
  }
  return path.join(baseHome, '.dsh', 'storages', 'router');
}

function chmodSafe(filePath: string, mode: number): void {
  try {
    if (fs.existsSync(filePath)) fs.chmodSync(filePath, mode);
  } catch {
  }
}

function parseOptionsJson(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function mapDecisionRow(row: SqlRow): RouterDecisionRecord {
  const recIdx = row.recommended_index;
  return {
    id: String(row.id),
    inboxId: String(row.inbox_id),
    eventId: String(row.event_id),
    source: String(row.source),
    threadKey: String(row.thread_key),
    actor: String(row.actor),
    level: String(row.level) as RouterActionLevel,
    summary: String(row.summary),
    reason: String(row.reason),
    question: row.question == null ? null : String(row.question),
    options: parseOptionsJson(row.options_json),
    recommendedIndex: typeof recIdx === 'number' && Number.isFinite(recIdx) ? recIdx : null,
    answeredOption: row.answered_option == null ? null : String(row.answered_option),
    status: String(row.status) as RouterDecisionStatus,
    destination: String(row.destination) as NotifyChannel,
    workerSessionId: row.worker_session_id == null ? null : String(row.worker_session_id),
    subscriptionId: row.subscription_id == null ? null : String(row.subscription_id),
    triageRestored: Number(row.triage_restored ?? 0) !== 0,
    rawUrl: row.raw_url == null ? null : String(row.raw_url),
    eventType: row.event_type == null ? null : String(row.event_type),
    eventOccurredAt: row.event_occurred_at == null ? null : String(row.event_occurred_at),
    imagePath: row.image_path == null ? null : String(row.image_path),
    draftText: row.draft_text == null ? null : String(row.draft_text),
    blindspot: row.blindspot == null ? null : String(row.blindspot),
    reportMode: row.report_mode == null ? null : (String(row.report_mode) as WorkerReportMode),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapNotificationRow(row: SqlRow): RouterNotificationRecord {
  return {
    id: String(row.id),
    decisionId: String(row.decision_id),
    channel: String(row.channel) as NotifyChannel,
    target: String(row.target),
    title: String(row.title),
    summary: String(row.summary),
    reason: String(row.reason),
    rawUrl: row.raw_url == null ? null : String(row.raw_url),
    status: String(row.status) as RouterNotificationRecord['status'],
    dueAt: row.due_at == null ? null : String(row.due_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class RouterDb {
  readonly db: DatabaseSync;
  readonly stateDir: string;
  readonly inMemory: boolean;
  private txDepth = 0;
  private closed = false;

  constructor(options: RouterDbOptions = {}) {
    this.inMemory = Boolean(options.inMemory);
    this.stateDir = this.inMemory ? ':memory:' : resolveRouterStateDir(options.stateDir, options.homeDir);

    if (this.inMemory) {
      this.db = new DatabaseSync(':memory:');
      this.db.exec('PRAGMA foreign_keys = ON;');
      this.db.exec(SCHEMA_SQL);
      return;
    }

    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    chmodSafe(this.stateDir, 0o700);

    const statePath = path.join(this.stateDir, 'state.sqlite');
    this.db = new DatabaseSync(statePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA_SQL);
    this.ensureDecisionColumns();
    chmodSafe(statePath, 0o600);
  }

  private ensureDecisionColumns(): void {
    const cols = this.db.prepare('PRAGMA table_info(router_decisions)').all() as Array<{ name?: string }>;
    const existing = new Set(cols.map((c) => String(c.name ?? '')));
    if (!existing.has('event_type')) {
      this.db.exec('ALTER TABLE router_decisions ADD COLUMN event_type TEXT');
    }
    if (!existing.has('event_occurred_at')) {
      this.db.exec('ALTER TABLE router_decisions ADD COLUMN event_occurred_at TEXT');
    }
    if (!existing.has('image_path')) {
      this.db.exec('ALTER TABLE router_decisions ADD COLUMN image_path TEXT');
    }
    if (!existing.has('draft_text')) {
      this.db.exec('ALTER TABLE router_decisions ADD COLUMN draft_text TEXT');
    }
    if (!existing.has('blindspot')) {
      this.db.exec('ALTER TABLE router_decisions ADD COLUMN blindspot TEXT');
    }
    if (!existing.has('report_mode')) {
      this.db.exec('ALTER TABLE router_decisions ADD COLUMN report_mode TEXT');
    }
  }

  transaction<T>(fn: () => T): T {
    if (this.closed) throw new Error('RouterDb is closed');
    const isNested = this.txDepth > 0;
    const sp = isNested ? `router_sp_${this.txDepth}` : null;
    this.db.exec(isNested ? `SAVEPOINT ${sp}` : 'BEGIN IMMEDIATE');
    this.txDepth += 1;
    try {
      const result = fn();
      this.txDepth -= 1;
      this.db.exec(isNested ? `RELEASE SAVEPOINT ${sp}` : 'COMMIT');
      return result;
    } catch (err) {
      this.txDepth -= 1;
      try {
        this.db.exec(isNested ? `ROLLBACK TO SAVEPOINT ${sp}; RELEASE SAVEPOINT ${sp}` : 'ROLLBACK');
      } catch {
      }
      throw err;
    }
  }

  getMeta(key: string, fallback?: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM router_meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : fallback;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO router_meta (key, value)
         VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, String(value));
  }

  upsertDecision(record: RouterDecisionRecord): RouterDecisionRecord {
    this.db
      .prepare(
        `INSERT INTO router_decisions (
           id, inbox_id, event_id, source, thread_key, actor, level, summary, reason,
           question, options_json, recommended_index, answered_option, status, destination,
           worker_session_id, subscription_id, triage_restored, raw_url, event_type, event_occurred_at,
           image_path, draft_text, blindspot, report_mode,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           inbox_id = excluded.inbox_id,
           event_id = excluded.event_id,
           source = excluded.source,
           thread_key = excluded.thread_key,
           actor = excluded.actor,
           level = excluded.level,
           summary = excluded.summary,
           reason = excluded.reason,
           question = excluded.question,
           options_json = excluded.options_json,
           recommended_index = excluded.recommended_index,
           answered_option = excluded.answered_option,
           status = excluded.status,
           destination = excluded.destination,
           worker_session_id = excluded.worker_session_id,
           subscription_id = excluded.subscription_id,
           triage_restored = excluded.triage_restored,
           raw_url = excluded.raw_url,
           event_type = COALESCE(excluded.event_type, router_decisions.event_type),
           event_occurred_at = COALESCE(excluded.event_occurred_at, router_decisions.event_occurred_at),
           image_path = excluded.image_path,
           draft_text = excluded.draft_text,
           blindspot = excluded.blindspot,
           report_mode = excluded.report_mode,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.inboxId,
        record.eventId,
        record.source,
        record.threadKey,
        record.actor,
        record.level,
        record.summary,
        record.reason,
        record.question ?? null,
        JSON.stringify(record.options ?? []),
        record.recommendedIndex ?? null,
        record.answeredOption ?? null,
        record.status,
        record.destination,
        record.workerSessionId ?? null,
        record.subscriptionId ?? null,
        record.triageRestored ? 1 : 0,
        record.rawUrl ?? null,
        record.eventType ?? null,
        record.eventOccurredAt ?? null,
        record.imagePath ?? null,
        record.draftText ?? null,
        record.blindspot ?? null,
        record.reportMode ?? null,
        record.createdAt,
        record.updatedAt,
      );
    return this.getDecision(record.id) ?? record;
  }

  getDecision(id: string): RouterDecisionRecord | null {
    const row = this.db.prepare('SELECT * FROM router_decisions WHERE id = ?').get(id) as SqlRow | undefined;
    return row ? mapDecisionRow(row) : null;
  }

  findDecisionByEventId(eventId: string): RouterDecisionRecord | null {
    const row = this.db
      .prepare('SELECT * FROM router_decisions WHERE event_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(eventId) as SqlRow | undefined;
    return row ? mapDecisionRow(row) : null;
  }

  listDecisions(filter: ListDecisionsFilter = {}): RouterDecisionRecord[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.source) {
      clauses.push('source = ?');
      params.push(filter.source);
    }
    if (filter.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    if (filter.level) {
      clauses.push('level = ?');
      params.push(filter.level);
    }
    if (filter.since) {
      clauses.push('created_at >= ?');
      params.push(filter.since);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.max(1, Math.min(500, Number(filter.limit ?? 100) || 100));
    params.push(limit);
    const rows = this.db
      .prepare(`SELECT * FROM router_decisions ${where} ORDER BY updated_at DESC, created_at DESC LIMIT ?`)
      .all(...params) as SqlRow[];
    return rows.map(mapDecisionRow);
  }

  listRecentDecisionsForSource(source: string, sinceIso: string, limit = 6): RouterDecisionRecord[] {
    const safeLimit = Math.max(1, Math.min(20, limit));
    const rows = this.db
      .prepare(
        `SELECT * FROM router_decisions
         WHERE source = ? AND created_at >= ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(source, sinceIso, safeLimit) as SqlRow[];
    return rows.map(mapDecisionRow);
  }

  upsertNotification(record: RouterNotificationRecord): RouterNotificationRecord {
    this.db
      .prepare(
        `INSERT INTO router_notifications (
           id, decision_id, channel, target, title, summary, reason, raw_url,
           status, due_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           channel = excluded.channel,
           target = excluded.target,
           title = excluded.title,
           summary = excluded.summary,
           reason = excluded.reason,
           raw_url = excluded.raw_url,
           status = excluded.status,
           due_at = excluded.due_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.decisionId,
        record.channel,
        record.target,
        record.title,
        record.summary,
        record.reason,
        record.rawUrl ?? null,
        record.status,
        record.dueAt ?? null,
        record.createdAt,
        record.updatedAt,
      );
    return this.getNotification(record.id) ?? record;
  }

  getNotification(id: string): RouterNotificationRecord | null {
    const row = this.db.prepare('SELECT * FROM router_notifications WHERE id = ?').get(id) as SqlRow | undefined;
    return row ? mapNotificationRow(row) : null;
  }

  listNotifications(filter: ListNotificationsFilter = {}): RouterNotificationRecord[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    if (filter.channel) {
      clauses.push('channel = ?');
      params.push(filter.channel);
    }
    if (filter.decisionId) {
      clauses.push('decision_id = ?');
      params.push(filter.decisionId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.max(1, Math.min(500, Number(filter.limit ?? 100) || 100));
    params.push(limit);
    const rows = this.db
      .prepare(`SELECT * FROM router_notifications ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params) as SqlRow[];
    return rows.map(mapNotificationRow);
  }

  listDueDeferredNotifications(nowIso: string): RouterNotificationRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM router_notifications
         WHERE status = 'deferred' AND (due_at IS NULL OR due_at <= ?)
         ORDER BY created_at ASC`,
      )
      .all(nowIso) as SqlRow[];
    return rows.map(mapNotificationRow);
  }

  countUnreadNotifications(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM router_notifications WHERE channel IN ('web', 'wechat') AND status = 'delivered'")
      .get() as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  countPendingDecisions(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM router_decisions
         WHERE status IN ('notified', 'deferred', 'dispatched', 'restored')
           AND (answered_option IS NULL OR answered_option = '')`,
      )
      .get() as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  getStats(days: number, activeSubscriptions: number, now: Date = new Date()): RouterStatsView {
    const safeDays = days === 30 ? 30 : Math.max(1, Math.min(365, Math.floor(days) || 7));
    const since = new Date(now.getTime() - safeDays * 86_400_000).toISOString();
    const rows = this.db
      .prepare('SELECT * FROM router_decisions WHERE created_at >= ?')
      .all(since) as SqlRow[];
    const decisions = rows.map(mapDecisionRow);

    let notifiedCount = 0;
    let filteredCount = 0;
    let restoredCount = 0;
    let dispatchedWorkers = 0;
    let answeredDecisions = 0;
    let recommendedPickedCount = 0;

    for (const d of decisions) {
      if (d.status === 'filtered' || d.triageRestored) {
        filteredCount += 1;
      }
      if (d.triageRestored) {
        restoredCount += 1;
      }
      if (
        d.status === 'notified' ||
        d.status === 'restored' ||
        ((d.status === 'dispatched' || d.status === 'resolved') && (d.destination === 'web' || d.destination === 'wechat'))
      ) {
        notifiedCount += 1;
      }
      if (d.workerSessionId) {
        dispatchedWorkers += 1;
      }
      if (d.answeredOption && d.answeredOption.trim()) {
        answeredDecisions += 1;
        if (
          d.recommendedIndex !== null &&
          d.recommendedIndex >= 0 &&
          d.recommendedIndex < d.options.length &&
          d.options[d.recommendedIndex] === d.answeredOption
        ) {
          recommendedPickedCount += 1;
        }
      }
    }

    const restoreRate = filteredCount > 0 ? Number((restoredCount / filteredCount).toFixed(4)) : 0;

    return {
      days: safeDays,
      since,
      totalEvents: decisions.length,
      notifiedCount,
      filteredCount,
      restoredCount,
      restoreRate,
      dispatchedWorkers,
      activeSubscriptions,
      answeredDecisions,
      recommendedPickedCount,
    };
  }

  listTables(): string[] {
    const rows = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

export function openRouterDb(options: RouterDbOptions = {}): RouterDb {
  return new RouterDb(options);
}
