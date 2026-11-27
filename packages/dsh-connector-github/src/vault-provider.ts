import type { DatabaseSync } from 'node:sqlite';
import type {
  HubService,
  PersonaWardrobe,
  VaultContextEntry,
  VaultContextOptions,
  VaultContextResult,
  VaultProvider,
  VaultScope,
  VaultSearchHit,
  VaultSearchQuery,
  VaultVisibility,
} from '@local/dsh-hub/contracts';
import {
  truncateVaultSnippet,
  VAULT_CONTEXT_DEFAULT_WINDOW,
  VAULT_CONTEXT_MAX_WINDOW,
  VAULT_DEFAULT_LIMIT,
  VAULT_MAX_LIMIT,
  VAULT_SNIPPET_MAX_LENGTH,
} from '@local/dsh-hub';
import type { GitHubRecentEvent, IssueSnapshotState, RepoIssueSnapshotEntry } from './poller.js';
import type { DbHandle, GitHubRepoEntry } from './sink.js';

const SOURCE_ID = 'github';
const REPO_ISSUES_CURSOR_PREFIX = 'state:repo_issues:';
const MAX_INBOX_SCAN = 500;
const VALID_VISIBILITIES = new Set<VaultVisibility>(['external', 'work', 'family', 'owner_private']);

type WardrobeWithCircle = PersonaWardrobe & {
  resolveChatCircle?: (roomKey: string) => { circle?: string; labeled?: boolean } | null | undefined;
};

export interface GitHubVisibilityOptions {
  config?: { repoMap?: Record<string, GitHubRepoEntry> } | null;
  getWardrobe?: () => PersonaWardrobe | null;
  repoPrivateHint?: boolean;
}

export interface GitHubVaultProviderOptions {
  db?: DbHandle;
  hub?: Pick<HubService, 'listInbox'> | null;
  getConfig: () => { repoMap?: Record<string, GitHubRepoEntry> };
  getWardrobe?: () => PersonaWardrobe | null;
  listSnapshots?: () => RepoIssueSnapshotEntry[];
  listRecentEvents?: () => GitHubRecentEvent[];
}

interface StoredEventRecord {
  id: string;
  inboxId?: string;
  type: string;
  repo: string;
  number: number | null;
  threadKey: string;
  entityKey: string | null;
  actor: string;
  summary: string;
  title: string;
  body: string;
  labels: string[];
  state?: string;
  url: string | null;
  occurredAt: string;
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

function isValidVaultVisibility(value: unknown): value is VaultVisibility {
  return typeof value === 'string' && VALID_VISIBILITIES.has(value as VaultVisibility);
}

function findRepoEntry(
  repoMap: Record<string, GitHubRepoEntry> | undefined,
  repo: string,
): GitHubRepoEntry | undefined {
  if (!repoMap || !repo) return undefined;
  if (repoMap[repo]) return repoMap[repo];
  const lower = repo.trim().toLowerCase();
  for (const [key, entry] of Object.entries(repoMap)) {
    if (key.trim().toLowerCase() === lower) {
      return entry;
    }
  }
  return undefined;
}

function resolveExplicitWardrobeVisibility(
  wardrobe: PersonaWardrobe | null | undefined,
  repo: string,
): VaultVisibility | null {
  if (!wardrobe || !repo) return null;
  const roomKey = `github:${repo.trim()}`;
  const extended = wardrobe as WardrobeWithCircle;
  if (typeof extended.resolveChatCircle === 'function') {
    const rec = extended.resolveChatCircle(roomKey);
    if (!rec || rec.labeled !== true) {
      return null;
    }
    if (typeof wardrobe.resolveVaultVisibility === 'function') {
      const vis = wardrobe.resolveVaultVisibility(roomKey);
      if (isValidVaultVisibility(vis)) return vis;
    }
    if (isValidVaultVisibility(rec.circle)) return rec.circle;
    return null;
  }
  if (typeof wardrobe.resolveVaultVisibility === 'function') {
    const vis = wardrobe.resolveVaultVisibility(roomKey);
    if (isValidVaultVisibility(vis)) return vis;
  }
  return null;
}

export function resolveGitHubRepoVaultVisibility(
  repo: string,
  opts: GitHubVisibilityOptions = {},
): VaultVisibility {
  const trimmed = String(repo ?? '').trim();
  const explicit = resolveExplicitWardrobeVisibility(opts.getWardrobe?.(), trimmed);
  if (explicit) return explicit;

  const entry = findRepoEntry(opts.config?.repoMap, trimmed);
  if (
    entry?.sensitive === true ||
    entry?.private === true ||
    entry?.visibility === 'private' ||
    entry?.visibility === 'internal' ||
    opts.repoPrivateHint === true
  ) {
    return 'work';
  }
  if (
    entry?.private === false ||
    entry?.visibility === 'public' ||
    entry?.sensitive === false ||
    opts.repoPrivateHint === false
  ) {
    return 'external';
  }
  return 'work';
}

export function resolveGitHubOutboundTargetCircle(
  repo: string,
  opts: GitHubVisibilityOptions = {},
): VaultVisibility {
  const trimmed = String(repo ?? '').trim();
  const explicit = resolveExplicitWardrobeVisibility(opts.getWardrobe?.(), trimmed);
  if (explicit) return explicit;

  const entry = findRepoEntry(opts.config?.repoMap, trimmed);
  if (
    entry?.sensitive === true ||
    entry?.private === true ||
    entry?.visibility === 'private' ||
    entry?.visibility === 'internal' ||
    opts.repoPrivateHint === true
  ) {
    return 'work';
  }
  return 'external';
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function parseTimestampFilter(raw: string | undefined): number | null {
  if (!raw || !raw.trim()) return null;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const parsedNum = Number(trimmed);
    return Number.isFinite(parsedNum) ? parsedNum : null;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseIsoMs(raw: string | null | undefined): number {
  if (!raw) return Number.NaN;
  return Date.parse(raw);
}

function matchesTimeWindow(tsMs: number, sinceMs: number | null, untilMs: number | null): boolean {
  if (sinceMs !== null) {
    if (!Number.isFinite(tsMs) || tsMs < sinceMs) return false;
  }
  if (untilMs !== null) {
    if (!Number.isFinite(tsMs) || tsMs > untilMs) return false;
  }
  return true;
}

function tokenizeQuery(queryText: string): string[] {
  const parts = queryText
    .toLowerCase()
    .split(/[\s,;:()[\]{}]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return Array.from(new Set(parts));
}

function computeMatchScore(
  queryText: string,
  tokens: string[],
  primaryText: string,
  secondaryText: string,
): number {
  if (!queryText) return 1;
  const lowerQuery = queryText.toLowerCase();
  const primary = primaryText.toLowerCase();
  const secondary = secondaryText.toLowerCase();
  let score = 0;
  if (primary.includes(lowerQuery)) {
    score += 4;
  } else if (secondary.includes(lowerQuery)) {
    score += 2.5;
  }
  for (const token of tokens) {
    if (primary.includes(token)) {
      score += 2;
    } else if (secondary.includes(token)) {
      score += 1;
    }
  }
  return score;
}

function matchesPersonFilter(personLower: string, fields: Array<string | undefined>): boolean {
  if (!personLower) return true;
  for (const field of fields) {
    if (field && field.toLowerCase().includes(personLower)) {
      return true;
    }
  }
  return false;
}

function parseRepoAndNumberFromKey(key: string | null | undefined): { repo: string | null; number: number | null } {
  if (!key) return { repo: null, number: null };
  const stripped = key.trim().replace(/^github:/i, '');
  const fullMatch = /^([^/\s]+\/[^#\s:]+)#(\d+)$/.exec(stripped);
  if (fullMatch) {
    const num = Number(fullMatch[2]);
    return {
      repo: fullMatch[1].trim(),
      number: Number.isInteger(num) && num > 0 ? num : null,
    };
  }
  const repoOnlyMatch = /^([^/\s]+\/[^#\s:]+)(?::|$)/.exec(stripped);
  if (repoOnlyMatch) {
    return { repo: repoOnlyMatch[1].trim(), number: null };
  }
  return { repo: null, number: null };
}

function formatSnapshotSnippet(entry: RepoIssueSnapshotEntry): string {
  const snap = entry.snapshot;
  const kindTag = snap.isPr ? 'PR' : 'Issue';
  const stateTag = snap.merged ? 'merged' : snap.state || 'open';
  const draftTag = snap.draft ? ', draft' : '';
  const labelsPart = snap.labels.length > 0 ? ` [${snap.labels.join(', ')}]` : '';
  const bodyPart = snap.bodySnippet ? ` — ${snap.bodySnippet}` : '';
  const raw = `[${kindTag} ${entry.repo}#${entry.number} ${stateTag}${draftTag}] ${snap.title || '(untitled)'}${labelsPart}${bodyPart}`;
  return truncateVaultSnippet(raw, VAULT_SNIPPET_MAX_LENGTH);
}

function formatEventSnippet(ev: StoredEventRecord): string {
  const ref = ev.number ? `${ev.repo}#${ev.number}` : ev.repo;
  const actorPart = ev.actor ? `${ev.actor}: ` : '';
  const text = ev.summary || ev.body || ev.title || ev.type;
  return truncateVaultSnippet(`[${ref}] ${actorPart}${text}`, VAULT_SNIPPET_MAX_LENGTH);
}

function readSnapshotsFromSqlite(sqlite: DatabaseSync): RepoIssueSnapshotEntry[] {
  const results: RepoIssueSnapshotEntry[] = [];
  try {
    const rows = sqlite
      .prepare(
        `SELECT cursor_key, cursor_value
         FROM source_cursors
         WHERE source_id = ? AND cursor_key LIKE 'state:repo_issues:%'`,
      )
      .all(SOURCE_ID) as Array<{ cursor_key: string; cursor_value: string }>;
    for (const row of rows) {
      const repo = row.cursor_key.slice(REPO_ISSUES_CURSOR_PREFIX.length).trim();
      if (!repo) continue;
      const parsed = safeJsonParse<Record<string, unknown>>(row.cursor_value, {});
      const isPrivate = typeof parsed.isPrivate === 'boolean' ? parsed.isPrivate : undefined;
      const rawItems =
        parsed.items && typeof parsed.items === 'object' && !Array.isArray(parsed.items)
          ? (parsed.items as Record<string, unknown>)
          : {};
      for (const [key, value] of Object.entries(rawItems)) {
        const number = Number(key);
        if (!Number.isInteger(number) || number <= 0) continue;
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const e = value as Record<string, unknown>;
        const snapshot: IssueSnapshotState = {
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
          ...(typeof e.lastCommentSyncAt === 'string' ? { lastCommentSyncAt: e.lastCommentSyncAt } : {}),
          ...(typeof e.lastReviewSyncAt === 'string' ? { lastReviewSyncAt: e.lastReviewSyncAt } : {}),
          ...(typeof e.isPr === 'boolean' ? { isPr: e.isPr } : {}),
          ...(typeof e.author === 'string' && e.author ? { author: e.author } : {}),
          ...(typeof e.url === 'string' && e.url ? { url: e.url } : {}),
          ...(typeof e.bodySnippet === 'string' && e.bodySnippet ? { bodySnippet: e.bodySnippet } : {}),
          ...(e.merged === true ? { merged: true } : {}),
        };
        results.push({ repo, number, isPrivate, snapshot });
      }
    }
  } catch {
  }
  return results;
}

function readEventsFromSqlite(sqlite: DatabaseSync): StoredEventRecord[] {
  const results: StoredEventRecord[] = [];
  try {
    const rows = sqlite
      .prepare(
        `SELECT id, event_id, thread_key, entity_key, type, actor, summary, payload_json, raw_url, occurred_at, created_at
         FROM inbox_items
         WHERE source = ?
         ORDER BY occurred_at DESC, created_at DESC
         LIMIT ?`,
      )
      .all(SOURCE_ID, MAX_INBOX_SCAN) as Array<{
      id: string;
      event_id: string;
      thread_key: string;
      entity_key: string | null;
      type: string;
      actor: string;
      summary: string;
      payload_json: string;
      raw_url: string | null;
      occurred_at: string;
      created_at: string;
    }>;

    for (const row of rows) {
      const payload = safeJsonParse<Record<string, unknown>>(row.payload_json, {});
      const parsedKey = parseRepoAndNumberFromKey(row.entity_key || row.thread_key);
      const repo =
        (typeof payload.repo === 'string' && payload.repo.trim()) || parsedKey.repo || '';
      if (!repo) continue;
      const rawNum =
        typeof payload.number === 'number' && Number.isInteger(payload.number) && payload.number > 0
          ? payload.number
          : parsedKey.number;
      const labels = Array.isArray(payload.labels) ? payload.labels.map(String) : [];
      results.push({
        id: row.event_id || row.id,
        inboxId: row.id,
        type: row.type || 'github.event',
        repo,
        number: rawNum,
        threadKey: row.thread_key || (rawNum ? `github:${repo}#${rawNum}` : `github:${repo}`),
        entityKey: row.entity_key,
        actor: row.actor || 'github',
        summary: row.summary || '',
        title: typeof payload.title === 'string' ? payload.title : '',
        body: typeof payload.body === 'string' ? payload.body : '',
        labels,
        state: typeof payload.state === 'string' ? payload.state : undefined,
        url: row.raw_url ?? null,
        occurredAt: row.occurred_at || row.created_at || '',
      });
    }
  } catch {
  }
  return results;
}

function normalizeRecentEvent(ev: GitHubRecentEvent): StoredEventRecord | null {
  const payload = ev.payload ?? {};
  const parsedKey = parseRepoAndNumberFromKey(ev.entityKey || ev.threadKey);
  const repo =
    (typeof ev.repo === 'string' && ev.repo.trim()) ||
    (typeof payload.repo === 'string' && payload.repo.trim()) ||
    parsedKey.repo ||
    '';
  if (!repo) return null;
  const rawNum =
    typeof ev.number === 'number' && Number.isInteger(ev.number) && ev.number > 0
      ? ev.number
      : typeof payload.number === 'number' && Number.isInteger(payload.number) && payload.number > 0
        ? payload.number
        : parsedKey.number;
  const labels = Array.isArray(payload.labels) ? payload.labels.map(String) : [];
  return {
    id: ev.id,
    type: ev.type || 'github.event',
    repo,
    number: rawNum,
    threadKey: ev.threadKey || (rawNum ? `github:${repo}#${rawNum}` : `github:${repo}`),
    entityKey: ev.entityKey,
    actor: ev.actor || 'github',
    summary: ev.summary || '',
    title: typeof payload.title === 'string' ? payload.title : '',
    body: typeof payload.body === 'string' ? payload.body : '',
    labels,
    state: typeof payload.state === 'string' ? payload.state : undefined,
    url: ev.url ?? null,
    occurredAt: ev.occurredAt || ev.ingestedAt || '',
  };
}

export function createGitHubVaultProvider(opts: GitHubVaultProviderOptions): VaultProvider {
  const sqlite = resolveSqlite(opts.db);

  const loadAllSnapshots = (): RepoIssueSnapshotEntry[] => {
    const byKey = new Map<string, RepoIssueSnapshotEntry>();
    if (sqlite) {
      for (const entry of readSnapshotsFromSqlite(sqlite)) {
        byKey.set(`${entry.repo.toLowerCase()}#${entry.number}`, entry);
      }
    }
    if (typeof opts.listSnapshots === 'function') {
      for (const entry of opts.listSnapshots()) {
        const k = `${entry.repo.toLowerCase()}#${entry.number}`;
        if (!byKey.has(k)) {
          byKey.set(k, entry);
        }
      }
    }
    return [...byKey.values()];
  };

  const loadAllEvents = (): StoredEventRecord[] => {
    const byId = new Map<string, StoredEventRecord>();
    if (sqlite) {
      for (const ev of readEventsFromSqlite(sqlite)) {
        byId.set(ev.id, ev);
      }
    }
    if (typeof opts.listRecentEvents === 'function') {
      for (const recent of opts.listRecentEvents()) {
        const normalized = normalizeRecentEvent(recent);
        if (!normalized) continue;
        if (!byId.has(normalized.id)) {
          byId.set(normalized.id, normalized);
        }
      }
    }
    if (!sqlite && typeof opts.hub?.listInbox === 'function') {
      for (const item of opts.hub.listInbox({ source: SOURCE_ID, limit: 200 })) {
        const eventId = item.eventId || item.id;
        if (byId.has(eventId)) continue;
        const parsedKey = parseRepoAndNumberFromKey(item.entityKey);
        if (!parsedKey.repo) continue;
        byId.set(eventId, {
          id: eventId,
          inboxId: item.id,
          type: item.type || 'github.event',
          repo: parsedKey.repo,
          number: parsedKey.number,
          threadKey: item.entityKey || `github:${parsedKey.repo}`,
          entityKey: item.entityKey,
          actor: item.actor || 'github',
          summary: item.summary || '',
          title: '',
          body: '',
          labels: [],
          url: item.rawUrl ?? null,
          occurredAt: item.occurredAt || item.createdAt || '',
        });
      }
    }
    return [...byId.values()];
  };

  const buildRepoPrivacyMap = (snapshots: RepoIssueSnapshotEntry[]): Map<string, boolean> => {
    const map = new Map<string, boolean>();
    for (const snap of snapshots) {
      if (typeof snap.isPrivate === 'boolean') {
        map.set(snap.repo.toLowerCase(), snap.isPrivate);
      }
    }
    return map;
  };

  const resolveCircle = (repo: string, privacyMap: Map<string, boolean>): VaultVisibility => {
    const repoPrivateHint = privacyMap.get(repo.toLowerCase());
    return resolveGitHubRepoVaultVisibility(repo, {
      config: opts.getConfig(),
      getWardrobe: opts.getWardrobe,
      repoPrivateHint,
    });
  };

  return {
    id: SOURCE_ID,
    label: 'GitHub Issues & PRs',

    search(query: VaultSearchQuery, scope: VaultScope): VaultSearchHit[] {
      const baseAllowed = Array.isArray(scope.allowedCircles) ? scope.allowedCircles : [];
      const effectiveAllowed = query.circle
        ? baseAllowed.filter((c) => c === query.circle)
        : baseAllowed;
      if (effectiveAllowed.length === 0) return [];

      const allowedSet = new Set<VaultVisibility>(effectiveAllowed);
      const limit = clampInt(query.limit, VAULT_DEFAULT_LIMIT, 1, VAULT_MAX_LIMIT);
      const queryText = String(query.query ?? '').trim();
      const tokens = tokenizeQuery(queryText);
      const personLower = String(query.person ?? '').trim().toLowerCase();
      const sinceMs = parseTimestampFilter(query.since);
      const untilMs = parseTimestampFilter(query.until);

      const snapshots = loadAllSnapshots();
      const privacyMap = buildRepoPrivacyMap(snapshots);
      const events = loadAllEvents();

      const scoredHits: Array<{ hit: VaultSearchHit; occurredAtMs: number }> = [];

      for (const entry of snapshots) {
        const circle = resolveCircle(entry.repo, privacyMap);
        if (!allowedSet.has(circle)) continue;

        const occurredAt = entry.snapshot.updatedAt || '';
        const occurredAtMs = parseIsoMs(occurredAt);
        if (!matchesTimeWindow(occurredAtMs, sinceMs, untilMs)) continue;

        if (
          !matchesPersonFilter(personLower, [
            entry.snapshot.author,
            entry.repo,
            entry.snapshot.title,
            entry.snapshot.bodySnippet,
            ...entry.snapshot.labels,
          ])
        ) {
          continue;
        }

        const primaryText = `${entry.repo} #${entry.number} ${entry.snapshot.title} ${entry.snapshot.labels.join(' ')} ${entry.snapshot.state}`;
        const secondaryText = `${entry.snapshot.bodySnippet ?? ''} ${entry.snapshot.author ?? ''}`;
        const score = computeMatchScore(queryText, tokens, primaryText, secondaryText);
        if (queryText && score <= 0) continue;

        scoredHits.push({
          occurredAtMs: Number.isFinite(occurredAtMs) ? occurredAtMs : 0,
          hit: {
            source: SOURCE_ID,
            itemId: `github:${entry.repo}#${entry.number}`,
            circle,
            roomKey: `github:${entry.repo}`,
            roomName: entry.repo,
            ...(entry.snapshot.author ? { author: entry.snapshot.author } : {}),
            occurredAt,
            snippet: formatSnapshotSnippet(entry),
            score,
            metadata: {
              kind: entry.snapshot.isPr ? 'pull_request' : 'issue',
              repo: entry.repo,
              number: entry.number,
              state: entry.snapshot.state || 'open',
              ...(entry.snapshot.merged ? { merged: true } : {}),
              draft: Boolean(entry.snapshot.draft),
              labels: entry.snapshot.labels,
              commentsCount: entry.snapshot.commentsCount,
              ...(entry.snapshot.url ? { url: entry.snapshot.url } : {}),
            },
          },
        });
      }

      for (const ev of events) {
        const circle = resolveCircle(ev.repo, privacyMap);
        if (!allowedSet.has(circle)) continue;

        const occurredAtMs = parseIsoMs(ev.occurredAt);
        if (!matchesTimeWindow(occurredAtMs, sinceMs, untilMs)) continue;

        if (
          !matchesPersonFilter(personLower, [
            ev.actor,
            ev.summary,
            ev.title,
            ev.body,
            ev.repo,
          ])
        ) {
          continue;
        }

        const numTag = ev.number ? `#${ev.number}` : '';
        const primaryText = `${ev.repo} ${numTag} ${ev.type} ${ev.summary} ${ev.title} ${ev.labels.join(' ')}`;
        const secondaryText = `${ev.body} ${ev.actor}`;
        const score = computeMatchScore(queryText, tokens, primaryText, secondaryText);
        if (queryText && score <= 0) continue;

        scoredHits.push({
          occurredAtMs: Number.isFinite(occurredAtMs) ? occurredAtMs : 0,
          hit: {
            source: SOURCE_ID,
            itemId: `event:${ev.id}`,
            circle,
            roomKey: `github:${ev.repo}`,
            roomName: ev.repo,
            ...(ev.actor ? { author: ev.actor } : {}),
            occurredAt: ev.occurredAt,
            snippet: formatEventSnippet(ev),
            score,
            metadata: {
              kind: 'event',
              eventType: ev.type,
              repo: ev.repo,
              ...(ev.number ? { number: ev.number } : {}),
              threadKey: ev.threadKey,
              ...(ev.entityKey ? { entityKey: ev.entityKey } : {}),
              ...(ev.url ? { url: ev.url } : {}),
            },
          },
        });
      }

      scoredHits.sort((a, b) => {
        const scoreDiff = (b.hit.score ?? 0) - (a.hit.score ?? 0);
        if (scoreDiff !== 0) return scoreDiff;
        return b.occurredAtMs - a.occurredAtMs;
      });

      return scoredHits.slice(0, limit).map((item) => item.hit);
    },

    context(
      rawItemId: string,
      optsWindow: VaultContextOptions,
      scope: VaultScope,
    ): VaultContextResult | null {
      const allowedCircles = Array.isArray(scope.allowedCircles) ? scope.allowedCircles : [];
      if (allowedCircles.length === 0) return null;
      const allowedSet = new Set<VaultVisibility>(allowedCircles);

      const itemId = String(rawItemId ?? '').trim();
      if (!itemId) return null;

      const before = clampInt(
        optsWindow?.before,
        VAULT_CONTEXT_DEFAULT_WINDOW,
        0,
        VAULT_CONTEXT_MAX_WINDOW,
      );
      const after = clampInt(
        optsWindow?.after,
        VAULT_CONTEXT_DEFAULT_WINDOW,
        0,
        VAULT_CONTEXT_MAX_WINDOW,
      );

      const snapshots = loadAllSnapshots();
      const privacyMap = buildRepoPrivacyMap(snapshots);
      const events = loadAllEvents();

      let targetRepo: string | null = null;
      let targetNumber: number | null = null;
      let targetThreadKey: string | null = null;
      let targetEventId: string | null = null;

      if (itemId.startsWith('github:')) {
        const parsed = parseRepoAndNumberFromKey(itemId);
        targetRepo = parsed.repo;
        targetNumber = parsed.number;
        targetThreadKey = targetRepo && targetNumber ? `github:${targetRepo}#${targetNumber}` : itemId;
      } else {
        const normalizedEventId = itemId.startsWith('event:') ? itemId.slice('event:'.length) : itemId;
        const found = events.find(
          (ev) => ev.id === normalizedEventId || ev.inboxId === normalizedEventId,
        );
        if (!found) return null;
        targetRepo = found.repo;
        targetNumber = found.number;
        targetThreadKey = found.threadKey;
        targetEventId = found.id;
      }

      if (!targetRepo) return null;
      const circle = resolveCircle(targetRepo, privacyMap);
      if (!allowedSet.has(circle)) return null;

      const repoLower = targetRepo.toLowerCase();
      const threadKeyLower = (targetThreadKey ?? '').toLowerCase();
      const matchingSnapshot =
        targetNumber !== null
          ? snapshots.find(
              (s) => s.repo.toLowerCase() === repoLower && s.number === targetNumber,
            ) ?? null
          : null;

      const matchingEvents = events
        .filter((ev) => {
          if (ev.repo.toLowerCase() !== repoLower) return false;
          if (targetNumber !== null && ev.number === targetNumber) return true;
          if (threadKeyLower && ev.threadKey.toLowerCase() === threadKeyLower) return true;
          if (threadKeyLower && ev.entityKey?.toLowerCase() === threadKeyLower) return true;
          return false;
        })
        .sort((a, b) => {
          const ta = parseIsoMs(a.occurredAt);
          const tb = parseIsoMs(b.occurredAt);
          return (Number.isFinite(ta) ? ta : 0) - (Number.isFinite(tb) ? tb : 0);
        });

      const timeline: VaultContextEntry[] = [];
      if (matchingSnapshot) {
        const snap = matchingSnapshot.snapshot;
        const text = [
          `[${snap.isPr ? 'PR' : 'Issue'} ${matchingSnapshot.repo}#${matchingSnapshot.number} (${snap.merged ? 'merged' : snap.state || 'open'})] ${snap.title}`,
          snap.labels.length > 0 ? `Labels: ${snap.labels.join(', ')}` : '',
          snap.bodySnippet ?? '',
        ]
          .filter(Boolean)
          .join('\n');
        timeline.push({
          itemId: `github:${matchingSnapshot.repo}#${matchingSnapshot.number}`,
          circle,
          roomKey: `github:${matchingSnapshot.repo}`,
          roomName: matchingSnapshot.repo,
          ...(snap.author ? { author: snap.author } : {}),
          occurredAt: snap.updatedAt || '',
          text,
          isTarget: targetEventId === null,
          metadata: {
            kind: snap.isPr ? 'pull_request' : 'issue',
            repo: matchingSnapshot.repo,
            number: matchingSnapshot.number,
            state: snap.state || 'open',
            ...(snap.merged ? { merged: true } : {}),
            ...(snap.url ? { url: snap.url } : {}),
          },
        });
      }

      for (const ev of matchingEvents) {
        const entryText = [ev.summary, ev.body && ev.body !== ev.summary ? ev.body : '']
          .filter(Boolean)
          .join('\n');
        timeline.push({
          itemId: `event:${ev.id}`,
          circle,
          roomKey: `github:${ev.repo}`,
          roomName: ev.repo,
          ...(ev.actor ? { author: ev.actor } : {}),
          occurredAt: ev.occurredAt,
          text: entryText || ev.type,
          isTarget: targetEventId !== null && ev.id === targetEventId,
          metadata: {
            kind: 'event',
            eventType: ev.type,
            repo: ev.repo,
            ...(ev.number ? { number: ev.number } : {}),
            ...(ev.url ? { url: ev.url } : {}),
          },
        });
      }

      if (timeline.length === 0) return null;

      let targetIndex = timeline.findIndex((entry) => entry.isTarget === true);
      if (targetIndex === -1) {
        targetIndex = 0;
        timeline[0] = { ...timeline[0], isTarget: true };
      }

      const start = Math.max(0, targetIndex - before);
      const end = Math.min(timeline.length, targetIndex + after + 1);
      const items = timeline.slice(start, end);

      return {
        source: SOURCE_ID,
        itemId,
        circle,
        roomKey: `github:${targetRepo}`,
        roomName: targetRepo,
        items,
        truncated: start > 0 || end < timeline.length,
        metadata: {
          repo: targetRepo,
          ...(targetNumber !== null ? { number: targetNumber } : {}),
          ...(targetThreadKey ? { threadKey: targetThreadKey } : {}),
        },
      };
    },
  };
}
