import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { NormalizedEvent, TrustLevel, WatchSource } from '@local/dsh-hub/contracts';
import {
  isMissingNotificationsScope,
  MISSING_NOTIFICATIONS_SCOPE_HINT,
  type GitHubAuthAccessor,
  type GitHubLogger,
} from './auth.js';
import {
  hasSelfTriggerMarker,
  type DbHandle,
  type FetchLike,
  type FetchResponseLike,
  type GitHubRepoEntry,
} from './sink.js';

const GITHUB_API = 'https://api.github.com';
const SOURCE_ID = 'github';
const MAX_LEDGER_SIZE = 500;
const MAX_SEEN_COMMENTS = 2000;
const MAX_TRACKED_ISSUES_PER_REPO = 200;
const MAX_COMMENT_SUMMARY_CHARS = 200;
export const MAX_RECENT_EVENTS = 50;

export interface GitHubRecentEvent {
  id: string;
  source: string;
  type: string;
  repo: string | null;
  number: number | null;
  entityKey: string | null;
  threadKey: string;
  actor: string;
  summary: string;
  url: string | null;
  occurredAt: string;
  ingestedAt?: string;
  payload: Record<string, unknown>;
}

export interface GitHubPinnedItem {
  repo: string;
  number: number;
  linkedPrs?: number[];
  watchReactions?: boolean;
}

export interface GitHubPollerConfig {
  ownerLogins: string[];
  botLogin: string;
  enableNotifications: boolean;
  notificationsEnabled?: boolean;
  pollIntervalMs: number;
  pinnedPollIntervalMs: number;
  repoMap: Record<string, GitHubRepoEntry>;
  pinnedItems: GitHubPinnedItem[];
}

export interface GitHubPollerOptions {
  config: GitHubPollerConfig;
  credentials: GitHubAuthAccessor;
  onEvent: (event: NormalizedEvent) => Promise<unknown>;
  db?: DbHandle;
  fetchImpl?: FetchLike;
  logger?: GitHubLogger;
  getConfigRevision?: () => number;
}

export interface GitHubPollerHealth {
  ok: boolean;
  consecutiveErrors: number;
  lastError?: string;
  nextPollAt?: string;
  notificationsScopeMissing?: boolean;
  notificationsPollIntervalMs?: number | null;
}

interface CursorRecord {
  value: Record<string, unknown>;
  etag?: string;
  lastModified?: string;
  configRev?: number;
  updatedAt?: string;
}

interface ReactionCounts {
  plusOne: number;
  total: number;
}

interface ExtractedReactions extends ReactionCounts {
  raw: Record<string, unknown>;
}

interface ReactionState {
  issue: ReactionCounts | null;
  comments: Record<string, ReactionCounts>;
}

export interface IssueSnapshotState {
  updatedAt: string | null;
  title: string;
  state: string;
  draft: boolean;
  labels: string[];
  bodyHash: string;
  commentsCount: number;
  lastCommentSyncAt?: string;
  lastReviewSyncAt?: string;
  isPr?: boolean;
  author?: string;
  url?: string;
  bodySnippet?: string;
  merged?: boolean;
}

export interface RepoIssueSnapshotEntry {
  repo: string;
  number: number;
  isPrivate?: boolean;
  snapshot: IssueSnapshotState;
}

interface RepoIssueSnapshotStore {
  lastMaxUpdatedAt?: string;
  isPrivate?: boolean;
  items: Record<string, IssueSnapshotState>;
}

interface IssueSnapshotDiff {
  changes: string[];
  addedLabels: string[];
  removedLabels: string[];
  onlyLabelsChanged: boolean;
}

interface GitHubUserLike {
  id?: string | number;
  login?: string;
  name?: string;
  type?: string;
}

interface GitHubNotificationLike {
  id: string | number;
  reason?: string;
  updated_at?: string;
  repository?: { full_name?: string };
  subject?: { url?: string; title?: string; type?: string };
}

interface GitHubPullRequestRefLike {
  url?: string;
  html_url?: string;
  merged_at?: string | null;
  merged?: boolean;
}

interface GitHubIssueLike {
  id?: string | number;
  number: number;
  title?: string;
  body?: string | null;
  state?: string;
  draft?: boolean;
  comments?: number;
  merged?: boolean;
  merged_at?: string | null;
  pull_request?: GitHubPullRequestRefLike | boolean | null;
  repository?: { private?: boolean; visibility?: string };
  html_url?: string;
  created_at?: string;
  updated_at?: string;
  user?: GitHubUserLike;
  labels?: Array<string | { name?: string }>;
  reactions?: Record<string, unknown>;
}

interface GitHubCommentLike {
  id: string | number;
  body?: string | null;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
  user?: GitHubUserLike;
  reactions?: Record<string, unknown>;
}

interface GitHubPrReviewLike {
  id: string | number;
  state?: string;
  body?: string | null;
  html_url?: string;
  submitted_at?: string;
  user?: GitHubUserLike;
}

interface GitHubPrReviewCommentLike {
  id: string | number;
  body?: string | null;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  pull_request_review_id?: string | number | null;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
  user?: GitHubUserLike;
  reactions?: Record<string, unknown>;
}

interface ConditionalGetResult {
  status: number;
  notModified: boolean;
  data: unknown;
  headers?: FetchResponseLike['headers'];
  bodyText?: string;
  pollIntervalMs: number | null;
}

function resolveSqlite(db: DbHandle): DatabaseSync | null {
  if (!db) return null;
  if ('prepare' in db && typeof db.prepare === 'function') return db;
  if ('db' in db && db.db && typeof db.db.prepare === 'function') return db.db;
  return null;
}

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function extractReactions(obj: { reactions?: Record<string, unknown> } | null | undefined): ExtractedReactions | null {
  const r = obj?.reactions;
  if (!r || typeof r !== 'object') return null;
  const plusOne = Number(r['+1'] ?? 0) || 0;
  const total = Number(r.total_count ?? plusOne) || 0;
  return { plusOne, total, raw: r };
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function normalizeLabels(labels: GitHubIssueLike['labels']): string[] {
  const out = new Set<string>();
  for (const entry of labels || []) {
    const label = typeof entry === 'string' ? entry.trim() : String(entry?.name || '').trim();
    if (label) out.add(label);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

function isPullRequestMerged(item: GitHubIssueLike, isPr: boolean): boolean {
  if (!isPr) return false;
  if (item.merged === true) return true;
  if (typeof item.merged_at === 'string' && item.merged_at.trim().length > 0) return true;
  if (item.pull_request && typeof item.pull_request === 'object') {
    if (item.pull_request.merged === true) return true;
    if (typeof item.pull_request.merged_at === 'string' && item.pull_request.merged_at.trim().length > 0) {
      return true;
    }
  }
  return false;
}

function buildCompactBodySnippet(body: string | null | undefined): string | undefined {
  const cleaned = String(body || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return undefined;
  return cleaned.length > 220 ? `${cleaned.slice(0, 219).trimEnd()}…` : cleaned;
}

function buildIssueSnapshot(
  item: GitHubIssueLike,
  labels: string[],
  isPr: boolean,
  merged: boolean,
): IssueSnapshotState {
  const commentsCount =
    typeof item.comments === 'number' && Number.isFinite(item.comments) && item.comments >= 0
      ? Math.floor(item.comments)
      : 0;
  const author = typeof item.user?.login === 'string' && item.user.login.trim() ? item.user.login.trim() : undefined;
  const url = typeof item.html_url === 'string' && item.html_url.trim() ? item.html_url.trim() : undefined;
  const bodySnippet = buildCompactBodySnippet(item.body);
  return {
    updatedAt: item.updated_at || null,
    title: item.title || '',
    state: item.state || '',
    draft: Boolean(item.draft),
    labels,
    bodyHash: hashText(item.body || ''),
    commentsCount,
    isPr,
    ...(author ? { author } : {}),
    ...(url ? { url } : {}),
    ...(bodySnippet ? { bodySnippet } : {}),
    ...(isPr && merged ? { merged: true } : {}),
  };
}

function diffIssueSnapshots(
  prev: IssueSnapshotState,
  next: IssueSnapshotState,
  isPr: boolean,
): IssueSnapshotDiff {
  const changes: string[] = [];
  const prevSet = new Set(prev.labels);
  const nextSet = new Set(next.labels);
  const addedLabels = next.labels.filter((l) => !prevSet.has(l));
  const removedLabels = prev.labels.filter((l) => !nextSet.has(l));

  if (next.state && next.state !== prev.state) {
    changes.push(`状态: ${prev.state || 'unknown'} → ${next.state}`);
  }
  if (isPr && next.draft !== prev.draft) {
    changes.push(next.draft ? '转为 Draft' : 'Ready for review');
  }
  if (next.title !== prev.title) {
    changes.push('标题已更新');
  }
  if (addedLabels.length > 0 || removedLabels.length > 0) {
    const tokens = [...addedLabels.map((l) => `+${l}`), ...removedLabels.map((l) => `-${l}`)];
    changes.push(`标签 ${tokens.join(' ')}`);
  }
  if (next.bodyHash !== prev.bodyHash) {
    changes.push('正文已更新');
  }

  const onlyLabelsChanged =
    changes.length === 1 && (addedLabels.length > 0 || removedLabels.length > 0);
  return { changes, addedLabels, removedLabels, onlyLabelsChanged };
}

const LINKED_ISSUE_REGEX =
  /\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)(?:\s*:\s*|\s+)(?:([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+))?#(\d+)\b/gi;

export function extractLinkedIssues(body: string | null | undefined, repo: string): number[] {
  if (!body) return [];
  const cleaned = String(body).replace(/<!--[\s\S]*?-->/g, ' ');
  const repoLower = String(repo || '').trim().toLowerCase();
  const matched = new Set<number>();
  LINKED_ISSUE_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LINKED_ISSUE_REGEX.exec(cleaned)) !== null) {
    const refRepo = m[1] ? m[1].trim().toLowerCase() : '';
    if (refRepo && refRepo !== repoLower) continue;
    const num = Number(m[2]);
    if (Number.isInteger(num) && num > 0) {
      matched.add(num);
    }
  }
  return [...matched].sort((a, b) => a - b);
}

function buildCommentSummary(
  body: string | null | undefined,
  actorLogin: string,
  repo: string,
  number: number,
): string {
  const cleaned = String(body || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) {
    return `${actorLogin} commented on ${repo}#${number}`;
  }
  return cleaned.length > MAX_COMMENT_SUMMARY_CHARS
    ? `${cleaned.slice(0, MAX_COMMENT_SUMMARY_CHARS - 1)}…`
    : cleaned;
}

function buildReviewSummary(
  state: string,
  body: string | null | undefined,
  actorLogin: string,
  repo: string,
  number: number,
): string {
  const stateTag = state || 'REVIEWED';
  const cleaned = String(body || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) {
    return `[${stateTag}] ${actorLogin} reviewed ${repo}#${number}`;
  }
  const prefix = `[${stateTag}] `;
  const maxBody = Math.max(20, MAX_COMMENT_SUMMARY_CHARS - prefix.length);
  const excerpt = cleaned.length > maxBody ? `${cleaned.slice(0, maxBody - 1)}…` : cleaned;
  return `${prefix}${excerpt}`;
}

function buildInlineReviewCommentSummary(
  filePath: string | undefined,
  line: number | null | undefined,
  body: string | null | undefined,
  actorLogin: string,
  repo: string,
  number: number,
): string {
  const location = filePath
    ? typeof line === 'number' && Number.isFinite(line)
      ? `${filePath}:${line}`
      : filePath
    : '';
  const cleaned = String(body || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) {
    return location
      ? `[${location}] ${actorLogin} commented on ${repo}#${number}`
      : `${actorLogin} commented on ${repo}#${number}`;
  }
  const prefix = location ? `[${location}] ` : '';
  const maxBody = Math.max(20, MAX_COMMENT_SUMMARY_CHARS - prefix.length);
  const excerpt = cleaned.length > maxBody ? `${cleaned.slice(0, maxBody - 1)}…` : cleaned;
  return `${prefix}${excerpt}`;
}

function maxIsoTimestamp(a: string | null | undefined, b: string | null | undefined): string | undefined {
  const ta = a ? Date.parse(a) : Number.NaN;
  const tb = b ? Date.parse(b) : Number.NaN;
  if (Number.isFinite(ta) && Number.isFinite(tb)) return ta >= tb ? (a as string) : (b as string);
  if (Number.isFinite(ta)) return a as string;
  if (Number.isFinite(tb)) return b as string;
  return undefined;
}

export class GitHubPoller {
  config: GitHubPollerConfig;
  readonly credentials: GitHubAuthAccessor;
  readonly onEvent: (event: NormalizedEvent) => Promise<unknown>;
  readonly sqlite: DatabaseSync | null;
  readonly fetchImpl: FetchLike;
  readonly logger: GitHubLogger;
  readonly getConfigRevision: () => number;

  private readonly memCursors = new Map<string, CursorRecord>();
  private readonly recentEvents: GitHubRecentEvent[] = [];
  readonly selfPublishedIds: Set<string>;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private activeSignal: AbortSignal | undefined = undefined;
  private inFlight = false;
  lastTickAt = 0;
  consecutiveErrors = 0;
  lastError: string | undefined = undefined;
  nextPollAt: string | undefined = undefined;
  notificationsScopeWarned = false;
  notificationsScopeMissing = false;
  notificationsPollIntervalMs: number | null = null;

  constructor(opts: GitHubPollerOptions) {
    this.config = opts.config;
    this.credentials = opts.credentials;
    this.onEvent = opts.onEvent;
    this.sqlite = resolveSqlite(opts.db);
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.logger = opts.logger ?? console;
    this.getConfigRevision = opts.getConfigRevision ?? (() => 1);
    this.selfPublishedIds = new Set(this._loadSelfPublishedIds());
  }

  private _readCursor(cursorKey: string): CursorRecord | null {
    if (!this.sqlite) {
      return this.memCursors.get(cursorKey) ?? null;
    }
    const row = this.sqlite
      .prepare(
        `SELECT cursor_value, etag, last_modified, config_rev, updated_at
         FROM source_cursors
         WHERE source_id = ? AND cursor_key = ?`,
      )
      .get(SOURCE_ID, cursorKey) as
      | {
          cursor_value: string;
          etag: string | null;
          last_modified: string | null;
          config_rev: number;
          updated_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      value: safeJsonParse<Record<string, unknown>>(row.cursor_value, {}),
      etag: row.etag || undefined,
      lastModified: row.last_modified || undefined,
      configRev: row.config_rev,
      updatedAt: row.updated_at,
    };
  }

  private _writeCursor(
    cursorKey: string,
    params: { value?: Record<string, unknown>; etag?: string | null; lastModified?: string | null } = {},
  ): void {
    const { value = {}, etag = null, lastModified = null } = params;
    const now = new Date().toISOString();
    const configRev = Number(this.getConfigRevision() || 1);
    if (!this.sqlite) {
      const prev = this.memCursors.get(cursorKey);
      this.memCursors.set(cursorKey, {
        value,
        etag: etag ?? prev?.etag,
        lastModified: lastModified ?? prev?.lastModified,
        configRev,
        updatedAt: now,
      });
      return;
    }
    this.sqlite
      .prepare(
        `INSERT INTO source_cursors (source_id, cursor_key, cursor_value, etag, last_modified, config_rev, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_id, cursor_key) DO UPDATE SET
           cursor_value = excluded.cursor_value,
           etag = COALESCE(excluded.etag, source_cursors.etag),
           last_modified = COALESCE(excluded.last_modified, source_cursors.last_modified),
           config_rev = excluded.config_rev,
           updated_at = excluded.updated_at`,
      )
      .run(SOURCE_ID, cursorKey, JSON.stringify(value), etag, lastModified, configRev, now);
  }

  private _loadSelfPublishedIds(): string[] {
    const rec = this._readCursor('state:self_published');
    const ids = rec?.value?.ids;
    return Array.isArray(ids) ? ids.map(String) : [];
  }

  private _saveSelfPublishedIds(): void {
    const ids = [...this.selfPublishedIds].slice(-MAX_LEDGER_SIZE);
    this._writeCursor('state:self_published', { value: { ids } });
  }

  private _loadSeenIds(cursorKey: string): Set<string> {
    const rec = this._readCursor(cursorKey);
    const ids = rec?.value?.ids;
    return new Set(Array.isArray(ids) ? ids.map(String) : []);
  }

  private _saveSeenIds(cursorKey: string, seenSet: Set<string>): void {
    const ids = [...seenSet].slice(-MAX_SEEN_COMMENTS);
    this._writeCursor(cursorKey, { value: { ids } });
  }

  private _loadSeenComments(entityKey: string): Set<string> {
    return this._loadSeenIds(`seen:comments:${entityKey}`);
  }

  private _saveSeenComments(entityKey: string, seenSet: Set<string>): void {
    this._saveSeenIds(`seen:comments:${entityKey}`, seenSet);
  }

  private _loadReactionState(entityKey: string): ReactionState {
    const rec = this._readCursor(`reactions:${entityKey}`);
    const val = rec?.value;
    const issue = val?.issue && typeof val.issue === 'object' ? (val.issue as ReactionCounts) : null;
    const comments =
      val?.comments && typeof val.comments === 'object'
        ? { ...(val.comments as Record<string, ReactionCounts>) }
        : {};
    return { issue, comments };
  }

  private _saveReactionState(entityKey: string, state: ReactionState): void {
    this._writeCursor(`reactions:${entityKey}`, {
      value: { issue: state.issue, comments: state.comments },
    });
  }

  private _loadRepoIssueSnapshots(repo: string): RepoIssueSnapshotStore {
    const rec = this._readCursor(`state:repo_issues:${repo}`);
    const val = rec?.value;
    const rawItems =
      val?.items && typeof val.items === 'object' && !Array.isArray(val.items)
        ? (val.items as Record<string, unknown>)
        : {};
    const items: Record<string, IssueSnapshotState> = {};
    for (const [key, entry] of Object.entries(rawItems)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const e = entry as Record<string, unknown>;
      items[key] = {
        updatedAt: typeof e.updatedAt === 'string' ? e.updatedAt : null,
        title: typeof e.title === 'string' ? e.title : '',
        state: typeof e.state === 'string' ? e.state : '',
        draft: Boolean(e.draft),
        labels: Array.isArray(e.labels) ? e.labels.map(String) : [],
        bodyHash: typeof e.bodyHash === 'string' ? e.bodyHash : '',
        commentsCount:
          typeof e.commentsCount === 'number' && Number.isFinite(e.commentsCount)
            ? e.commentsCount
            : 0,
        lastCommentSyncAt: typeof e.lastCommentSyncAt === 'string' ? e.lastCommentSyncAt : undefined,
        lastReviewSyncAt: typeof e.lastReviewSyncAt === 'string' ? e.lastReviewSyncAt : undefined,
        ...(typeof e.isPr === 'boolean' ? { isPr: e.isPr } : {}),
        ...(typeof e.author === 'string' && e.author ? { author: e.author } : {}),
        ...(typeof e.url === 'string' && e.url ? { url: e.url } : {}),
        ...(typeof e.bodySnippet === 'string' && e.bodySnippet ? { bodySnippet: e.bodySnippet } : {}),
        ...(e.merged === true ? { merged: true } : {}),
      };
    }
    return {
      lastMaxUpdatedAt: typeof val?.lastMaxUpdatedAt === 'string' ? val.lastMaxUpdatedAt : undefined,
      isPrivate: typeof val?.isPrivate === 'boolean' ? val.isPrivate : undefined,
      items,
    };
  }

  private _saveRepoIssueSnapshots(repo: string, store: RepoIssueSnapshotStore): void {
    const entries = Object.entries(store.items);
    let trimmed = store.items;
    if (entries.length > MAX_TRACKED_ISSUES_PER_REPO) {
      entries.sort((a, b) => {
        const ta = a[1].updatedAt ? Date.parse(a[1].updatedAt) : 0;
        const tb = b[1].updatedAt ? Date.parse(b[1].updatedAt) : 0;
        return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
      });
      trimmed = Object.fromEntries(entries.slice(0, MAX_TRACKED_ISSUES_PER_REPO));
    }
    this._writeCursor(`state:repo_issues:${repo}`, {
      value: {
        ...(store.lastMaxUpdatedAt ? { lastMaxUpdatedAt: store.lastMaxUpdatedAt } : {}),
        ...(typeof store.isPrivate === 'boolean' ? { isPrivate: store.isPrivate } : {}),
        items: trimmed,
      },
    });
  }

  listIssueSnapshots(): RepoIssueSnapshotEntry[] {
    const results: RepoIssueSnapshotEntry[] = [];
    const prefix = 'state:repo_issues:';
    const parseStore = (repo: string, rawVal: Record<string, unknown>): void => {
      const isPrivate = typeof rawVal.isPrivate === 'boolean' ? rawVal.isPrivate : undefined;
      const rawItems =
        rawVal.items && typeof rawVal.items === 'object' && !Array.isArray(rawVal.items)
          ? (rawVal.items as Record<string, unknown>)
          : {};
      for (const [key, entry] of Object.entries(rawItems)) {
        const number = Number(key);
        if (!Number.isInteger(number) || number <= 0) continue;
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const e = entry as Record<string, unknown>;
        results.push({
          repo,
          number,
          isPrivate,
          snapshot: {
            updatedAt: typeof e.updatedAt === 'string' ? e.updatedAt : null,
            title: typeof e.title === 'string' ? e.title : '',
            state: typeof e.state === 'string' ? e.state : '',
            draft: Boolean(e.draft),
            labels: Array.isArray(e.labels) ? e.labels.map(String) : [],
            bodyHash: typeof e.bodyHash === 'string' ? e.bodyHash : '',
            commentsCount:
              typeof e.commentsCount === 'number' && Number.isFinite(e.commentsCount)
                ? e.commentsCount
                : 0,
            lastCommentSyncAt: typeof e.lastCommentSyncAt === 'string' ? e.lastCommentSyncAt : undefined,
            lastReviewSyncAt: typeof e.lastReviewSyncAt === 'string' ? e.lastReviewSyncAt : undefined,
            ...(typeof e.isPr === 'boolean' ? { isPr: e.isPr } : {}),
            ...(typeof e.author === 'string' && e.author ? { author: e.author } : {}),
            ...(typeof e.url === 'string' && e.url ? { url: e.url } : {}),
            ...(typeof e.bodySnippet === 'string' && e.bodySnippet ? { bodySnippet: e.bodySnippet } : {}),
            ...(e.merged === true ? { merged: true } : {}),
          },
        });
      }
    };

    if (this.sqlite) {
      try {
        const rows = this.sqlite
          .prepare(
            `SELECT cursor_key, cursor_value
             FROM source_cursors
             WHERE source_id = ? AND cursor_key LIKE 'state:repo_issues:%'`,
          )
          .all(SOURCE_ID) as Array<{ cursor_key: string; cursor_value: string }>;
        for (const row of rows) {
          const repo = row.cursor_key.slice(prefix.length).trim();
          if (!repo) continue;
          const val = safeJsonParse<Record<string, unknown>>(row.cursor_value, {});
          parseStore(repo, val);
        }
      } catch {
      }
      return results;
    }

    for (const [key, rec] of this.memCursors.entries()) {
      if (!key.startsWith(prefix)) continue;
      const repo = key.slice(prefix.length).trim();
      if (!repo) continue;
      parseStore(repo, rec.value);
    }
    return results;
  }

  private _isPinnedTarget(repo: string, number: number): boolean {
    const repoLower = repo.toLowerCase();
    for (const pinned of this.config.pinnedItems || []) {
      if (pinned.repo.toLowerCase() !== repoLower) continue;
      if (pinned.number === number) return true;
      if (Array.isArray(pinned.linkedPrs) && pinned.linkedPrs.includes(number)) return true;
    }
    return false;
  }

  private async _pollRepoIssueComments(params: {
    repo: string;
    item: GitHubIssueLike;
    isPr: boolean;
    entityKey: string;
    since?: string;
    baselineMs?: number;
    linkedIssues?: number[];
    token: string;
    signal?: AbortSignal;
  }): Promise<{ emitted: number; latestCommentAt?: string; ok: boolean }> {
    const { repo, item, isPr, entityKey, since, baselineMs, linkedIssues = [], token, signal } = params;
    const query = since ? `?since=${encodeURIComponent(since)}&per_page=100` : '?per_page=100';
    const path = `/repos/${repo}/issues/${item.number}/comments${query}`;
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'dsh-connector-github/0.1.0',
    };

    let resp: FetchResponseLike;
    try {
      resp = await this.fetchImpl(`${GITHUB_API}${path}`, { headers, signal });
    } catch (err) {
      this.logger?.warn?.(
        `[connector-github] Failed to fetch comments for ${repo}#${item.number}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { emitted: 0, ok: false };
    }

    if (resp.status === 404) {
      return { emitted: 0, ok: false };
    }
    if (!resp.ok) {
      this.logger?.warn?.(
        `[connector-github] Failed to fetch comments for ${repo}#${item.number}: HTTP ${resp.status}`,
      );
      return { emitted: 0, ok: false };
    }

    const data = await resp.json().catch(() => null);
    if (!Array.isArray(data)) {
      return { emitted: 0, ok: false };
    }

    const seen = this._loadSeenComments(entityKey);
    let seenDirty = false;
    let emitted = 0;
    let latestCommentAt: string | undefined = undefined;

    for (const comment of data as GitHubCommentLike[]) {
      const cid = String(comment.id);
      const commentAt = maxIsoTimestamp(comment.updated_at, comment.created_at);
      latestCommentAt = maxIsoTimestamp(latestCommentAt, commentAt);

      if (seen.has(cid)) continue;
      seen.add(cid);
      seenDirty = true;

      if (typeof baselineMs === 'number' && Number.isFinite(baselineMs)) {
        const commentMs = commentAt ? Date.parse(commentAt) : Number.NaN;
        if (Number.isFinite(commentMs) && commentMs <= baselineMs) continue;
      }

      if (this.shouldDropSelfOrBot(comment.user, comment.body, cid)) continue;

      const reactions = extractReactions(comment);
      await this._emitEvent({
        id: randomUUID(),
        source: SOURCE_ID,
        type: isPr ? 'github.pr.comment' : 'github.issue.comment',
        dedupeKey: `github:${repo}#${item.number}:comment:${cid}`,
        threadKey: entityKey,
        entityKey,
        actor: this.toActor(comment.user),
        trustLevel: this.classifyTrust(comment.user),
        occurredAt: comment.created_at || comment.updated_at || new Date().toISOString(),
        summary: buildCommentSummary(comment.body, comment.user?.login || 'someone', repo, item.number),
        payload: {
          repo,
          number: item.number,
          isPr,
          title: item.title || '',
          commentId: cid,
          body: comment.body || '',
          reactions: reactions?.raw,
          ...(isPr && linkedIssues.length > 0 ? { linkedIssues } : {}),
        },
        rawRef: {
          url: comment.html_url || item.html_url,
          externalId: cid,
          repo,
          number: item.number,
        },
      });
      emitted += 1;
    }

    if (seenDirty) {
      this._saveSeenComments(entityKey, seen);
    }

    return { emitted, latestCommentAt, ok: true };
  }

  private async _pollRepoPrReviews(params: {
    repo: string;
    item: GitHubIssueLike;
    entityKey: string;
    baselineMs?: number;
    linkedIssues?: number[];
    token: string;
    signal?: AbortSignal;
  }): Promise<{ emitted: number; latestReviewAt?: string; ok: boolean }> {
    const { repo, item, entityKey, baselineMs, linkedIssues = [], token, signal } = params;
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'dsh-connector-github/0.1.0',
    };

    let emitted = 0;
    let latestReviewAt: string | undefined = undefined;
    let reviewsOk = false;
    let inlineOk = false;

    const reviewsPath = `/repos/${repo}/pulls/${item.number}/reviews?per_page=100`;
    try {
      const resp = await this.fetchImpl(`${GITHUB_API}${reviewsPath}`, { headers, signal });
      if (!resp.ok) {
        this.logger?.warn?.(
          `[connector-github] Failed to fetch PR reviews for ${repo}#${item.number}: HTTP ${resp.status}`,
        );
      } else {
        const data = await resp.json().catch(() => null);
        if (Array.isArray(data)) {
          reviewsOk = true;
          const cursorKey = `seen:pr_reviews:${entityKey}`;
          const seen = this._loadSeenIds(cursorKey);
          let seenDirty = false;

          for (const review of data as GitHubPrReviewLike[]) {
            const reviewId = String(review.id);
            const reviewState = String(review.state || '').toUpperCase();
            if (reviewState === 'PENDING') continue;

            latestReviewAt = maxIsoTimestamp(latestReviewAt, review.submitted_at);
            if (seen.has(reviewId)) continue;
            seen.add(reviewId);
            seenDirty = true;

            const trimmedBody = String(review.body || '')
              .replace(/<!--[\s\S]*?-->/g, ' ')
              .trim();
            if (!trimmedBody && reviewState === 'COMMENTED') continue;

            if (typeof baselineMs === 'number' && Number.isFinite(baselineMs)) {
              const submittedMs = review.submitted_at ? Date.parse(review.submitted_at) : Number.NaN;
              if (Number.isFinite(submittedMs) && submittedMs <= baselineMs) continue;
            }

            if (this.shouldDropSelfOrBot(review.user, review.body, reviewId)) continue;

            await this._emitEvent({
              id: randomUUID(),
              source: SOURCE_ID,
              type: 'github.pr.comment',
              dedupeKey: `github:${repo}#${item.number}:review:${reviewId}`,
              threadKey: entityKey,
              entityKey,
              actor: this.toActor(review.user),
              trustLevel: this.classifyTrust(review.user),
              occurredAt: review.submitted_at || new Date().toISOString(),
              summary: buildReviewSummary(
                reviewState,
                review.body,
                review.user?.login || 'someone',
                repo,
                item.number,
              ),
              payload: {
                repo,
                number: item.number,
                isPr: true,
                title: item.title || '',
                reviewId,
                reviewState,
                body: review.body || '',
                ...(linkedIssues.length > 0 ? { linkedIssues } : {}),
              },
              rawRef: {
                url: review.html_url || item.html_url,
                externalId: reviewId,
                repo,
                number: item.number,
              },
            });
            emitted += 1;
          }

          if (seenDirty) {
            this._saveSeenIds(cursorKey, seen);
          }
        }
      }
    } catch (err) {
      this.logger?.warn?.(
        `[connector-github] Failed to fetch PR reviews for ${repo}#${item.number}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const inlinePath = `/repos/${repo}/pulls/${item.number}/comments?per_page=100`;
    try {
      const resp = await this.fetchImpl(`${GITHUB_API}${inlinePath}`, { headers, signal });
      if (!resp.ok) {
        this.logger?.warn?.(
          `[connector-github] Failed to fetch PR review comments for ${repo}#${item.number}: HTTP ${resp.status}`,
        );
      } else {
        const data = await resp.json().catch(() => null);
        if (Array.isArray(data)) {
          inlineOk = true;
          const cursorKey = `seen:pr_review_comments:${entityKey}`;
          const seen = this._loadSeenIds(cursorKey);
          let seenDirty = false;

          for (const comment of data as GitHubPrReviewCommentLike[]) {
            const cid = String(comment.id);
            const commentAt = maxIsoTimestamp(comment.updated_at, comment.created_at);
            latestReviewAt = maxIsoTimestamp(latestReviewAt, commentAt);

            if (seen.has(cid)) continue;
            seen.add(cid);
            seenDirty = true;

            if (typeof baselineMs === 'number' && Number.isFinite(baselineMs)) {
              const commentMs = commentAt ? Date.parse(commentAt) : Number.NaN;
              if (Number.isFinite(commentMs) && commentMs <= baselineMs) continue;
            }

            if (this.shouldDropSelfOrBot(comment.user, comment.body, cid)) continue;

            const line = comment.line ?? comment.original_line ?? undefined;
            const reactions = extractReactions(comment);
            await this._emitEvent({
              id: randomUUID(),
              source: SOURCE_ID,
              type: 'github.pr.comment',
              dedupeKey: `github:${repo}#${item.number}:review_comment:${cid}`,
              threadKey: entityKey,
              entityKey,
              actor: this.toActor(comment.user),
              trustLevel: this.classifyTrust(comment.user),
              occurredAt: comment.created_at || comment.updated_at || new Date().toISOString(),
              summary: buildInlineReviewCommentSummary(
                comment.path,
                line,
                comment.body,
                comment.user?.login || 'someone',
                repo,
                item.number,
              ),
              payload: {
                repo,
                number: item.number,
                isPr: true,
                title: item.title || '',
                commentId: cid,
                reviewCommentId: cid,
                ...(comment.pull_request_review_id !== undefined && comment.pull_request_review_id !== null
                  ? { reviewId: String(comment.pull_request_review_id) }
                  : {}),
                ...(comment.path ? { path: comment.path } : {}),
                ...(typeof line === 'number' && Number.isFinite(line) ? { line } : {}),
                body: comment.body || '',
                reactions: reactions?.raw,
                ...(linkedIssues.length > 0 ? { linkedIssues } : {}),
              },
              rawRef: {
                url: comment.html_url || item.html_url,
                externalId: cid,
                repo,
                number: item.number,
              },
            });
            emitted += 1;
          }

          if (seenDirty) {
            this._saveSeenIds(cursorKey, seen);
          }
        }
      }
    } catch (err) {
      this.logger?.warn?.(
        `[connector-github] Failed to fetch PR review comments for ${repo}#${item.number}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return { emitted, latestReviewAt, ok: reviewsOk && inlineOk };
  }

  listRecentEvents(): GitHubRecentEvent[] {
    return this.recentEvents.map((ev) => ({ ...ev }));
  }

  private _recordRecentEvent(event: NormalizedEvent): void {
    const repo =
      typeof event.rawRef?.repo === 'string' && event.rawRef.repo
        ? event.rawRef.repo
        : typeof event.payload?.repo === 'string' && event.payload.repo
          ? event.payload.repo
          : null;
    const rawNumber = event.rawRef?.number ?? event.payload?.number;
    const number = typeof rawNumber === 'number' && Number.isFinite(rawNumber) ? rawNumber : null;
    const entry: GitHubRecentEvent = {
      id: event.id,
      source: event.source,
      type: event.type,
      repo,
      number,
      entityKey: event.entityKey ?? null,
      threadKey: event.threadKey,
      actor: event.actor?.login || event.actor?.displayName || event.actor?.id || 'unknown',
      summary: event.summary,
      url: event.rawRef?.url ?? null,
      occurredAt: event.occurredAt,
      ingestedAt: new Date().toISOString(),
      payload: event.payload ?? {},
    };
    this.recentEvents.unshift(entry);
    if (this.recentEvents.length > MAX_RECENT_EVENTS) {
      this.recentEvents.length = MAX_RECENT_EVENTS;
    }
  }

  private async _emitEvent(event: NormalizedEvent): Promise<void> {
    this._recordRecentEvent(event);
    await this.onEvent(event);
  }

  recordSelfPublished(meta: { externalId?: string } = {}): void {
    if (!meta.externalId) return;
    this.selfPublishedIds.add(String(meta.externalId));
    if (this.selfPublishedIds.size > MAX_LEDGER_SIZE) {
      const oldest = this.selfPublishedIds.values().next().value;
      if (oldest !== undefined) this.selfPublishedIds.delete(oldest);
    }
    this._saveSelfPublishedIds();
  }

  asWatchSource(): Omit<WatchSource, 'health'> & { health: () => GitHubPollerHealth } {
    return {
      id: SOURCE_ID,
      label: 'GitHub',
      pollNow: (watchId, signal) => this.pollOnce({ watchId, signal }),
      health: () => ({
        ok: this.consecutiveErrors < 3,
        consecutiveErrors: this.consecutiveErrors,
        lastError: this.lastError,
        nextPollAt: this.nextPollAt,
        notificationsScopeMissing: this.notificationsScopeMissing,
        notificationsPollIntervalMs: this.notificationsPollIntervalMs,
      }),
      dispose: () => this.stop(),
    };
  }

  updateConfig(next: GitHubPollerConfig): void {
    const wasRunning = this.timer !== null;
    this.config = next;
    if (wasRunning && !this.activeSignal?.aborted) {
      this.start(this.activeSignal);
    }
  }

  resetNotificationsScopeState(): void {
    this.notificationsScopeMissing = false;
    this.notificationsScopeWarned = false;
  }

  start(signal?: AbortSignal): void {
    this.stop();
    this.activeSignal = signal;
    const scheduleNext = (): void => {
      if (signal?.aborted) return;
      const baseInterval = Math.min(this.config.pollIntervalMs, this.config.pinnedPollIntervalMs);
      const interval = Math.max(15_000, baseInterval);
      this.nextPollAt = new Date(Date.now() + interval).toISOString();
      this.timer = setTimeout(async () => {
        if (signal?.aborted) return;
        this.lastTickAt = Date.now();
        await this.pollOnce({ signal }).catch(() => {});
        scheduleNext();
      }, interval);
      this.timer.unref?.();
    };
    scheduleNext();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async pollOnce(opts: { watchId?: string; signal?: AbortSignal } = {}): Promise<{ polled: number; events: number }> {
    const { watchId, signal } = opts;
    if (this.inFlight) return { polled: 0, events: 0 };
    this.inFlight = true;
    let polled = 0;
    let events = 0;

    try {
      const auth = await this.credentials.readSlot('read');
      if (!auth?.token) {
        this.lastError = 'Missing GitHub read credential (ctx.credentials and `gh auth token` unavailable)';
        return { polled: 0, events: 0 };
      }

      const notificationsOn =
        this.config.enableNotifications !== false && this.config.notificationsEnabled !== false;
      if (!watchId && notificationsOn && !this.notificationsScopeMissing) {
        events += await this.pollNotifications(auth.token, signal);
        polled += 1;
      }

      for (const [repo, entry] of Object.entries(this.config.repoMap || {})) {
        if (signal?.aborted) break;
        if (entry?.enabled === false) continue;
        if (watchId && !watchId.includes(repo)) continue;
        events += await this.pollRepoIssues(repo, auth.token, signal);
        polled += 1;
      }

      for (const pinned of this.config.pinnedItems || []) {
        if (signal?.aborted) break;
        const targetKey = `${pinned.repo}#${pinned.number}`;
        if (watchId && watchId !== targetKey) continue;
        events += await this.pollPinnedItem(pinned, auth.token, signal);
        polled += 1;
      }

      this.consecutiveErrors = 0;
      this.lastError = undefined;
      return { polled, events };
    } catch (err) {
      this.consecutiveErrors += 1;
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.inFlight = false;
    }
  }

  async conditionalGet(
    cursorKey: string,
    path: string,
    token: string,
    signal?: AbortSignal,
    opts: { useLastModified?: boolean; allow403?: boolean; allow404?: boolean } = {},
  ): Promise<ConditionalGetResult> {
    const { useLastModified = false, allow403 = false, allow404 = false } = opts;
    const cached = this._readCursor(cursorKey) ?? { value: {} };
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'dsh-connector-github/0.1.0',
    };
    if (useLastModified && cached.lastModified) {
      headers['If-Modified-Since'] = cached.lastModified;
    } else if (cached.etag) {
      headers['If-None-Match'] = cached.etag;
    }

    const resp = await this.fetchImpl(`${GITHUB_API}${path}`, { headers, signal });
    const pollSec = Number(resp.headers?.get?.('x-poll-interval') || 0);
    const nextEtag = resp.headers?.get?.('etag') || cached.etag || null;
    const nextLastMod = resp.headers?.get?.('last-modified') || cached.lastModified || null;
    const prevPoll = typeof cached.value?.pollIntervalMs === 'number' ? cached.value.pollIntervalMs : null;
    const nextPollIntervalMs = pollSec > 0 ? pollSec * 1000 : prevPoll;

    if (resp.status === 304) {
      this._writeCursor(cursorKey, {
        value: { ...cached.value, pollIntervalMs: nextPollIntervalMs },
        etag: nextEtag,
        lastModified: nextLastMod,
      });
      return {
        status: 304,
        notModified: true,
        data: null,
        headers: resp.headers,
        pollIntervalMs: nextPollIntervalMs,
      };
    }

    if (resp.status === 403 && allow403) {
      const bodyText = typeof resp.text === 'function' ? await resp.text().catch(() => '') : '';
      return {
        status: 403,
        notModified: false,
        data: null,
        headers: resp.headers,
        bodyText,
        pollIntervalMs: nextPollIntervalMs,
      };
    }

    if (resp.status === 404 && allow404) {
      return {
        status: 404,
        notModified: false,
        data: null,
        headers: resp.headers,
        pollIntervalMs: nextPollIntervalMs,
      };
    }

    if (!resp.ok) {
      throw new Error(`GitHub GET ${path} failed: HTTP ${resp.status}`);
    }

    const data = await resp.json();
    this._writeCursor(cursorKey, {
      value: { ...cached.value, pollIntervalMs: nextPollIntervalMs },
      etag: nextEtag,
      lastModified: nextLastMod,
    });
    return {
      status: resp.status,
      notModified: false,
      data,
      headers: resp.headers,
      pollIntervalMs: nextPollIntervalMs,
    };
  }

  async pollNotifications(token: string, signal?: AbortSignal): Promise<number> {
    const res = await this.conditionalGet(
      'account:notifications',
      '/notifications?all=false&per_page=50',
      token,
      signal,
      { useLastModified: true, allow403: true },
    );

    if (res.pollIntervalMs) {
      this.notificationsPollIntervalMs = res.pollIntervalMs;
    }

    if (res.status === 403) {
      if (isMissingNotificationsScope(403, res.headers, res.bodyText)) {
        this.notificationsScopeMissing = true;
        if (!this.notificationsScopeWarned) {
          this.notificationsScopeWarned = true;
          this.logger?.warn?.(`[connector-github] ${MISSING_NOTIFICATIONS_SCOPE_HINT}`);
        }
        return 0;
      }
      throw new Error('GitHub GET /notifications failed: HTTP 403');
    }

    if (res.notModified || !Array.isArray(res.data)) return 0;

    let emitted = 0;
    for (const thread of res.data as GitHubNotificationLike[]) {
      const repo = thread.repository?.full_name || 'unknown/unknown';
      const numMatch = String(thread.subject?.url || '').match(/\/(\d+)$/);
      const number = numMatch ? Number(numMatch[1]) : undefined;
      const entityKey = number ? `github:${repo}#${number}` : `github:${repo}:notif:${thread.id}`;
      const type =
        thread.reason === 'review_requested'
          ? 'github.pr.review_requested'
          : thread.reason === 'mention'
            ? 'github.notification.mention'
            : 'github.notification';

      await this._emitEvent({
        id: randomUUID(),
        source: SOURCE_ID,
        type,
        dedupeKey: `github:notif:${thread.id}:${thread.updated_at}`,
        threadKey: entityKey,
        entityKey,
        actor: {
          id: 'github-notification',
          displayName: thread.reason || 'notification',
          isBot: false,
        },
        trustLevel: 'untrusted',
        occurredAt: thread.updated_at || new Date().toISOString(),
        summary: `[${repo}${number ? `#${number}` : ''}] (${thread.reason}) ${thread.subject?.title || ''}`.trim(),
        payload: {
          reason: thread.reason,
          subjectType: thread.subject?.type,
          title: thread.subject?.title,
          repo,
          number,
        },
        rawRef: { url: thread.subject?.url, externalId: String(thread.id), repo, number },
      });
      emitted += 1;
    }
    return emitted;
  }

  async pollRepoIssues(repo: string, token: string, signal?: AbortSignal): Promise<number> {
    const path = `/repos/${repo}/issues?state=all&sort=updated&direction=desc&per_page=30`;
    const { notModified, data } = await this.conditionalGet(`repo:issues:${repo}`, path, token, signal);
    if (notModified || !Array.isArray(data)) return 0;

    const store = this._loadRepoIssueSnapshots(repo);
    const hadBaseline = Boolean(store.lastMaxUpdatedAt || Object.keys(store.items).length > 0);
    const prevRepoMaxUpdatedAt = store.lastMaxUpdatedAt;
    let nextRepoMaxUpdatedAt = store.lastMaxUpdatedAt;
    let storeDirty = false;
    let emitted = 0;

    for (const item of data as GitHubIssueLike[]) {
      const entityKey = `github:${repo}#${item.number}`;
      const isPr = Boolean(item.pull_request);
      const merged = isPullRequestMerged(item, isPr);
      const reactions = extractReactions(item);
      nextRepoMaxUpdatedAt = maxIsoTimestamp(nextRepoMaxUpdatedAt, item.updated_at);
      if (typeof item.repository?.private === 'boolean' && store.isPrivate !== item.repository.private) {
        store.isPrivate = item.repository.private;
        storeDirty = true;
      } else if (typeof item.repository?.visibility === 'string') {
        const vis = item.repository.visibility.trim().toLowerCase();
        if (vis === 'public' && store.isPrivate !== false) {
          store.isPrivate = false;
          storeDirty = true;
        } else if ((vis === 'private' || vis === 'internal') && store.isPrivate !== true) {
          store.isPrivate = true;
          storeDirty = true;
        }
      }

      if (reactions) {
        const state = this._loadReactionState(entityKey);
        const prev = state.issue;
        if (prev && (reactions.plusOne > prev.plusOne || reactions.total > prev.total)) {
          await this._emitReactionDelta({
            repo,
            number: item.number,
            primaryIssue: item.number,
            isLinkedPr: isPr,
            targetType: 'issue',
            prev,
            curr: reactions,
            url: item.html_url,
            externalId: String(item.id ?? item.number),
          });
          emitted += 1;
        }
        state.issue = { plusOne: reactions.plusOne, total: reactions.total };
        this._saveReactionState(entityKey, state);
      }

      const skipHeadEvent = this.shouldDropSelfOrBot(item.user, item.body, item.id);
      const linkedIssues = isPr ? extractLinkedIssues(item.body, repo) : [];

      const labels = normalizeLabels(item.labels);
      const itemKey = String(item.number);
      const prev = store.items[itemKey];
      const nextSnapshot = buildIssueSnapshot(item, labels, isPr, merged);
      const isPinned = this._isPinnedTarget(repo, item.number);

      if (!prev) {
        if (!skipHeadEvent) {
          const trustLevel = this.classifyTrust(item.user);
          await this._emitEvent({
            id: randomUUID(),
            source: SOURCE_ID,
            type: isPr ? 'github.pr.updated' : 'github.issue.updated',
            dedupeKey: `github:${repo}#${item.number}:updated:${item.updated_at}`,
            threadKey: entityKey,
            entityKey,
            actor: this.toActor(item.user),
            trustLevel,
            occurredAt: item.updated_at || new Date().toISOString(),
            summary: `${isPr ? 'PR' : 'Issue'} ${repo}#${item.number}: ${item.title || ''}`.trim(),
            payload: {
              repo,
              number: item.number,
              isPr,
              state: item.state,
              draft: Boolean(item.draft),
              title: item.title || '',
              body: item.body || '',
              labels,
              reactions: reactions?.raw,
              ...(isPr && linkedIssues.length > 0 ? { linkedIssues } : {}),
            },
            rawRef: {
              url: item.html_url,
              externalId: String(item.id ?? item.number),
              repo,
              number: item.number,
            },
          });
          emitted += 1;
        }

        let initialCommentFetchFailed = false;
        let initialReviewFetchFailed = false;
        const isInitialOpenBotPr = skipHeadEvent && isPr && item.state === 'open';

        if (!isPinned) {
          if (isInitialOpenBotPr) {
            if (nextSnapshot.commentsCount > 0) {
              const commentRes = await this._pollRepoIssueComments({
                repo,
                item,
                isPr,
                entityKey,
                linkedIssues,
                token,
                signal,
              });
              emitted += commentRes.emitted;
              if (commentRes.ok) {
                nextSnapshot.lastCommentSyncAt = maxIsoTimestamp(
                  commentRes.latestCommentAt,
                  item.updated_at,
                );
              } else {
                initialCommentFetchFailed = true;
              }
            }
            const reviewRes = await this._pollRepoPrReviews({
              repo,
              item,
              entityKey,
              linkedIssues,
              token,
              signal,
            });
            emitted += reviewRes.emitted;
            if (reviewRes.ok) {
              nextSnapshot.lastReviewSyncAt = maxIsoTimestamp(
                reviewRes.latestReviewAt,
                item.updated_at,
              );
            } else {
              initialReviewFetchFailed = true;
            }
          } else if (hadBaseline && prevRepoMaxUpdatedAt) {
            const itemMs = item.updated_at ? Date.parse(item.updated_at) : Number.NaN;
            const prevMaxMs = Date.parse(prevRepoMaxUpdatedAt);
            if (!Number.isFinite(itemMs) || !Number.isFinite(prevMaxMs) || itemMs > prevMaxMs) {
              if (nextSnapshot.commentsCount > 0) {
                const commentRes = await this._pollRepoIssueComments({
                  repo,
                  item,
                  isPr,
                  entityKey,
                  since: prevRepoMaxUpdatedAt,
                  baselineMs: prevMaxMs,
                  linkedIssues,
                  token,
                  signal,
                });
                emitted += commentRes.emitted;
                if (commentRes.ok) {
                  nextSnapshot.lastCommentSyncAt = maxIsoTimestamp(
                    commentRes.latestCommentAt,
                    item.updated_at,
                  );
                } else {
                  initialCommentFetchFailed = true;
                }
              }
              if (isPr) {
                const reviewRes = await this._pollRepoPrReviews({
                  repo,
                  item,
                  entityKey,
                  baselineMs: prevMaxMs,
                  linkedIssues,
                  token,
                  signal,
                });
                emitted += reviewRes.emitted;
                if (reviewRes.ok) {
                  nextSnapshot.lastReviewSyncAt = maxIsoTimestamp(
                    reviewRes.latestReviewAt,
                    item.updated_at,
                  );
                } else {
                  initialReviewFetchFailed = true;
                }
              }
            }
          }
        }

        if (isInitialOpenBotPr && (initialCommentFetchFailed || initialReviewFetchFailed)) {
          continue;
        }
        if (initialCommentFetchFailed) {
          nextSnapshot.updatedAt = prevRepoMaxUpdatedAt || null;
          nextSnapshot.commentsCount = 0;
        } else if (initialReviewFetchFailed) {
          nextSnapshot.updatedAt = prevRepoMaxUpdatedAt || null;
        }

        store.items[itemKey] = nextSnapshot;
        storeDirty = true;
        continue;
      }

      const updatedAtChanged = Boolean(nextSnapshot.updatedAt && nextSnapshot.updatedAt !== prev.updatedAt);
      const diff = diffIssueSnapshots(prev, nextSnapshot, isPr);
      const commentsIncreased = nextSnapshot.commentsCount > prev.commentsCount;
      if (!updatedAtChanged && diff.changes.length === 0 && !commentsIncreased) {
        continue;
      }

      nextSnapshot.lastCommentSyncAt = prev.lastCommentSyncAt;
      nextSnapshot.lastReviewSyncAt = prev.lastReviewSyncAt;
      let commentFetchFailed = false;
      let reviewFetchFailed = false;
      if (!isPinned && (commentsIncreased || updatedAtChanged)) {
        if (nextSnapshot.commentsCount > 0) {
          const since = prev.lastCommentSyncAt || prev.updatedAt || undefined;
          const baselineMs =
            !prev.lastCommentSyncAt && updatedAtChanged && prev.updatedAt
              ? Date.parse(prev.updatedAt)
              : undefined;
          const commentRes = await this._pollRepoIssueComments({
            repo,
            item,
            isPr,
            entityKey,
            since,
            baselineMs,
            linkedIssues,
            token,
            signal,
          });
          emitted += commentRes.emitted;
          if (commentRes.ok) {
            nextSnapshot.lastCommentSyncAt = maxIsoTimestamp(
              maxIsoTimestamp(prev.lastCommentSyncAt, commentRes.latestCommentAt),
              item.updated_at,
            );
          } else {
            commentFetchFailed = true;
          }
        }

        if (isPr) {
          const reviewBaselineMs =
            !prev.lastReviewSyncAt && updatedAtChanged && prev.updatedAt
              ? Date.parse(prev.updatedAt)
              : undefined;
          const reviewRes = await this._pollRepoPrReviews({
            repo,
            item,
            entityKey,
            baselineMs: reviewBaselineMs,
            linkedIssues,
            token,
            signal,
          });
          emitted += reviewRes.emitted;
          if (reviewRes.ok) {
            nextSnapshot.lastReviewSyncAt = maxIsoTimestamp(
              maxIsoTimestamp(prev.lastReviewSyncAt, reviewRes.latestReviewAt),
              item.updated_at,
            );
          } else {
            reviewFetchFailed = true;
          }
        }
      }

      if (!skipHeadEvent && diff.changes.length > 0) {
        const trustLevel = this.classifyTrust(item.user);
        const eventType = diff.onlyLabelsChanged
          ? (isPr ? 'github.pr.labeled' : 'github.issue.labeled')
          : (isPr ? 'github.pr.updated' : 'github.issue.updated');
        await this._emitEvent({
          id: randomUUID(),
          source: SOURCE_ID,
          type: eventType,
          dedupeKey: `github:${repo}#${item.number}:${diff.onlyLabelsChanged ? 'labeled' : 'updated'}:${item.updated_at || nextSnapshot.bodyHash}`,
          threadKey: entityKey,
          entityKey,
          actor: this.toActor(item.user),
          trustLevel,
          occurredAt: item.updated_at || new Date().toISOString(),
          summary: `${isPr ? 'PR' : 'Issue'} ${repo}#${item.number} (${diff.changes.join('；')}): ${item.title || ''}`.trim(),
          payload: {
            repo,
            number: item.number,
            isPr,
            state: item.state,
            prevState: prev.state,
            ...(isPr && merged ? { merged: true } : {}),
            draft: Boolean(item.draft),
            title: item.title || '',
            body: item.body || '',
            labels,
            addedLabels: diff.addedLabels,
            removedLabels: diff.removedLabels,
            changes: diff.changes,
            reactions: reactions?.raw,
            ...(isPr && linkedIssues.length > 0 ? { linkedIssues } : {}),
          },
          rawRef: {
            url: item.html_url,
            externalId: String(item.id ?? item.number),
            repo,
            number: item.number,
          },
        });
        emitted += 1;
      } else if (
        prev.state.toLowerCase() === 'open' &&
        String(item.state || '').toLowerCase() === 'closed'
      ) {
        const trustLevel = this.classifyTrust(item.user);
        const eventType = isPr
          ? (merged ? 'github.pr.merged' : 'github.pr.closed')
          : 'github.issue.closed';
        const terminalTag = merged ? 'merged' : 'closed';
        await this._emitEvent({
          id: randomUUID(),
          source: SOURCE_ID,
          type: eventType,
          dedupeKey: `github:${repo}#${item.number}:lifecycle:${terminalTag}:${item.updated_at || nextSnapshot.bodyHash}`,
          threadKey: entityKey,
          entityKey,
          actor: this.toActor(item.user),
          trustLevel,
          occurredAt: item.updated_at || new Date().toISOString(),
          summary: `${isPr ? 'PR' : 'Issue'} ${repo}#${item.number} (${terminalTag}): ${item.title || ''}`.trim(),
          payload: {
            repo,
            number: item.number,
            isPr,
            state: 'closed',
            prevState: prev.state,
            ...(isPr && merged ? { merged: true } : {}),
            lifecycleOnly: true,
            draft: Boolean(item.draft),
            title: item.title || '',
            labels,
            changes: diff.changes,
            ...(isPr && linkedIssues.length > 0 ? { linkedIssues } : {}),
          },
          rawRef: {
            url: item.html_url,
            externalId: String(item.id ?? item.number),
            repo,
            number: item.number,
          },
        });
        emitted += 1;
      }

      if (commentFetchFailed) {
        nextSnapshot.updatedAt = prev.updatedAt;
        nextSnapshot.commentsCount = prev.commentsCount;
      } else if (reviewFetchFailed) {
        nextSnapshot.updatedAt = prev.updatedAt;
      }
      store.items[itemKey] = nextSnapshot;
      storeDirty = true;
    }

    if (nextRepoMaxUpdatedAt && nextRepoMaxUpdatedAt !== store.lastMaxUpdatedAt) {
      store.lastMaxUpdatedAt = nextRepoMaxUpdatedAt;
      storeDirty = true;
    }
    if (storeDirty) {
      this._saveRepoIssueSnapshots(repo, store);
    }
    return emitted;
  }

  async pollPinnedItem(pinned: GitHubPinnedItem, token: string, signal?: AbortSignal): Promise<number> {
    let emitted = 0;
    const watchReactions = pinned.watchReactions !== false;
    const linkedPrs = Array.isArray(pinned.linkedPrs) ? pinned.linkedPrs : [];
    const targets = [
      { repo: pinned.repo, number: pinned.number, isLinkedPr: false, primaryIssue: pinned.number },
      ...linkedPrs.map((prNum) => ({
        repo: pinned.repo,
        number: prNum,
        isLinkedPr: true,
        primaryIssue: pinned.number,
      })),
    ];

    for (const target of targets) {
      if (signal?.aborted) break;
      const entityKey = `github:${target.repo}#${target.number}`;
      const reactionState = this._loadReactionState(entityKey);
      let reactionDirty = false;

      const issueRes = await this.conditionalGet(
        `pinned:issue:${target.repo}#${target.number}`,
        `/repos/${target.repo}/issues/${target.number}`,
        token,
        signal,
        { allow404: true },
      );
      if (watchReactions && !issueRes.notModified && issueRes.data && typeof issueRes.data === 'object') {
        const issueData = issueRes.data as GitHubIssueLike;
        const issueReactions = extractReactions(issueData);
        if (issueReactions) {
          const prev = reactionState.issue;
          if (prev && (issueReactions.plusOne > prev.plusOne || issueReactions.total > prev.total)) {
            await this._emitReactionDelta({
              repo: target.repo,
              number: target.number,
              primaryIssue: target.primaryIssue,
              isLinkedPr: target.isLinkedPr,
              targetType: 'issue',
              prev,
              curr: issueReactions,
              url: issueData.html_url,
              externalId: String(issueData.id ?? target.number),
              linkedPrs,
            });
            emitted += 1;
          }
          reactionState.issue = { plusOne: issueReactions.plusOne, total: issueReactions.total };
          reactionDirty = true;
        }
      }

      const commentPath = `/repos/${target.repo}/issues/${target.number}/comments?per_page=100`;
      const commentRes = await this.conditionalGet(
        `pinned:comments:${target.repo}#${target.number}`,
        commentPath,
        token,
        signal,
      );
      if (!commentRes.notModified && Array.isArray(commentRes.data)) {
        const seen = this._loadSeenComments(entityKey);
        let seenDirty = false;

        for (const comment of commentRes.data as GitHubCommentLike[]) {
          const cid = String(comment.id);
          const reactions = extractReactions(comment);

          if (!seen.has(cid)) {
            seen.add(cid);
            seenDirty = true;

            if (!this.shouldDropSelfOrBot(comment.user, comment.body, cid)) {
              await this._emitEvent({
                id: randomUUID(),
                source: SOURCE_ID,
                type: target.isLinkedPr ? 'github.pr.comment' : 'github.pinned.activity',
                dedupeKey: `github:${target.repo}#${target.number}:comment:${cid}`,
                threadKey: `github:${target.repo}#${target.primaryIssue}`,
                entityKey,
                actor: this.toActor(comment.user),
                trustLevel: this.classifyTrust(comment.user),
                occurredAt: comment.created_at || comment.updated_at || new Date().toISOString(),
                summary: buildCommentSummary(comment.body, comment.user?.login || 'someone', target.repo, target.number),
                payload: {
                  repo: target.repo,
                  number: target.number,
                  isPr: target.isLinkedPr,
                  isLinkedPr: target.isLinkedPr,
                  linkedFromIssue: target.isLinkedPr ? target.primaryIssue : undefined,
                  commentId: cid,
                  body: comment.body || '',
                  reactions: reactions?.raw,
                  linkedPrs,
                },
                rawRef: {
                  url: comment.html_url,
                  externalId: cid,
                  repo: target.repo,
                  number: target.number,
                },
              });
              emitted += 1;
            }
          }

          if (watchReactions && reactions) {
            const prev = reactionState.comments[cid];
            if (prev && (reactions.plusOne > prev.plusOne || reactions.total > prev.total)) {
              await this._emitReactionDelta({
                repo: target.repo,
                number: target.number,
                primaryIssue: target.primaryIssue,
                isLinkedPr: target.isLinkedPr,
                targetType: 'comment',
                commentId: cid,
                commentAuthor: comment.user?.login,
                prev,
                curr: reactions,
                url: comment.html_url,
                externalId: cid,
                linkedPrs,
              });
              emitted += 1;
            }
            if (!prev || prev.plusOne !== reactions.plusOne || prev.total !== reactions.total) {
              reactionState.comments[cid] = { plusOne: reactions.plusOne, total: reactions.total };
              reactionDirty = true;
            }
          }
        }

        if (seenDirty) {
          this._saveSeenComments(entityKey, seen);
        }
      }

      if (reactionDirty) {
        this._saveReactionState(entityKey, reactionState);
      }
    }

    return emitted;
  }

  private async _emitReactionDelta(params: {
    repo: string;
    number: number;
    primaryIssue: number;
    isLinkedPr: boolean;
    targetType: 'issue' | 'comment';
    commentId?: string;
    commentAuthor?: string;
    prev: ReactionCounts;
    curr: ExtractedReactions;
    url?: string;
    externalId?: string;
    linkedPrs?: number[];
  }): Promise<void> {
    const {
      repo,
      number,
      primaryIssue,
      isLinkedPr,
      targetType,
      commentId,
      commentAuthor,
      prev,
      curr,
      url,
      externalId,
      linkedPrs = [],
    } = params;

    const plusOneDelta = curr.plusOne - prev.plusOne;
    const totalDelta = curr.total - prev.total;
    const entityKey = `github:${repo}#${number}`;
    const targetDesc =
      targetType === 'comment' ? `${repo}#${number} comment #${commentId}` : `${repo}#${number}`;
    const deltaLabel =
      plusOneDelta > 0
        ? `👍 +${plusOneDelta} (total +1=${curr.plusOne}, all=${curr.total})`
        : `reactions +${totalDelta} (total=${curr.total}, +1=${curr.plusOne})`;

    await this._emitEvent({
      id: randomUUID(),
      source: SOURCE_ID,
      type: 'github.reaction.delta',
      dedupeKey: `github:${repo}#${number}:reaction:${targetType}:${commentId || 'issue'}:${curr.plusOne}:${curr.total}`,
      threadKey: `github:${repo}#${primaryIssue}`,
      entityKey,
      actor: { id: 'github-reactions', displayName: 'GitHub Reactions', isBot: false },
      trustLevel: 'untrusted',
      occurredAt: new Date().toISOString(),
      summary: `${deltaLabel} on ${targetDesc}`,
      payload: {
        repo,
        number,
        isPr: Boolean(isLinkedPr),
        isLinkedPr: Boolean(isLinkedPr),
        linkedFromIssue: isLinkedPr ? primaryIssue : undefined,
        targetType,
        commentId,
        commentAuthor,
        plusOne: curr.plusOne,
        prevPlusOne: prev.plusOne,
        plusOneDelta,
        total: curr.total,
        prevTotal: prev.total,
        totalDelta,
        reactions: curr.raw,
        linkedPrs,
      },
      rawRef: {
        url,
        externalId: String(externalId || commentId || number),
        repo,
        number,
      },
    });
  }

  shouldDropSelfOrBot(
    user: GitHubUserLike | undefined,
    body: string | null | undefined,
    externalId?: string | number,
  ): boolean {
    if (externalId !== undefined && this.selfPublishedIds.has(String(externalId))) return true;
    if (hasSelfTriggerMarker(body)) return true;
    const login = String(user?.login || '').toLowerCase();
    if (user?.type === 'Bot' || login.endsWith('[bot]')) return true;
    if (this.config.botLogin && login === this.config.botLogin.toLowerCase()) return true;
    return false;
  }

  classifyTrust(user: GitHubUserLike | undefined): TrustLevel {
    const login = String(user?.login || '').toLowerCase();
    const owners = new Set((this.config.ownerLogins || []).map((o) => String(o).toLowerCase()));
    return login && owners.has(login) ? 'owner' : 'untrusted';
  }

  toActor(user: GitHubUserLike | undefined): NormalizedEvent['actor'] {
    const login = user?.login;
    return {
      id: String(user?.id ?? login ?? 'unknown'),
      login,
      displayName: user?.name || login,
      isBot: user?.type === 'Bot' || String(login || '').toLowerCase().endsWith('[bot]'),
    };
  }
}
