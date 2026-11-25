import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import type {
  EdgeRelation,
  EntityGraphEdge,
  EntityResolver,
  NormalizedEvent,
  ResolvedEntityContext,
  WorkstreamRecord,
} from '@local/dsh-hub/contracts';
import type { ExecFileLike, GitHubAuthAccessor } from './auth.js';
import type { GitHubPinnedItem } from './poller.js';
import type { DbHandle, GitHubRepoEntry } from './sink.js';

const execFileAsync = promisify(execFile);

const GITHUB_WEB = 'https://github.com';
const MAX_TIGHT_ISSUES_PER_WORKSTREAM = 2;
const MAX_RELATED_POINTERS = 5;
export const MAX_CONTEXT_CARD_CHARS = 1200;

const TIGHT_RELATIONS = new Set<EdgeRelation>([
  'fixes',
  'closes',
  'implements',
  'linked_pr',
  'manual_link',
]);
const TIGHT_REF_REGEX =
  /\b(fixes|closes|resolves|implements)\s+(?:([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+))?#(\d+)\b/gi;
const LOOSE_REF_REGEX = /(?:^|[\s(])(?:([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+))?#(\d+)\b/g;

export interface GitHubResolverConfig {
  repoMap?: Record<string, GitHubRepoEntry>;
  pinnedItems?: GitHubPinnedItem[];
  gitFetchEnabled?: boolean;
}

export interface GitHubResolverContext {
  hub?: {
    db?: DbHandle;
    listWorkstreams?: () => WorkstreamRecord[];
  };
  watcher?: {
    db?: DbHandle;
    listWorkstreams?: () => WorkstreamRecord[];
  };
  get?: (name: string) => unknown;
}

export interface GitHubGraphResolverOptions {
  ctx?: GitHubResolverContext | null;
  config?: GitHubResolverConfig;
  credentials?: GitHubAuthAccessor | null;
  db?: DbHandle;
  execFileImpl?: ExecFileLike;
}

export interface GitMergeProbeResult {
  checked: boolean;
  conflictedFiles: string[];
  behindCount: number;
  tags: string[];
}

export interface BoundedWorkstream {
  workstreamKey: string;
  primaryPr?: string;
  issues: string[];
}

interface EntityRecord {
  entityKey: string;
  source: string;
  kind: string;
  title: string;
  state: string;
  rawUrl: string | null;
  lastEventId: string | null;
  metadata: Record<string, unknown>;
  updatedAt: string;
}

interface SessionHeaderLike {
  id: string;
}

interface SessionsServiceLike {
  list?: () => Promise<SessionHeaderLike[]> | SessionHeaderLike[];
}

interface ProjectionCacheLike {
  cachedSnapshot?: (
    header: SessionHeaderLike,
    fields: string[],
  ) => { forgeChangeRequests?: Array<{ url?: string }> } | null | undefined;
}

interface ForgeSessionServiceLike {
  track?: (session: unknown, prUrl: string) => Promise<unknown> | unknown;
}

interface WorktreesServiceLike {
  create?: (agent: unknown, opts: { name: string; from: string }) => Promise<unknown> | unknown;
}

interface SessionTitleServiceLike {
  rename?: (session: unknown, title: string) => Promise<unknown> | unknown;
}

function resolveSqlite(db: DbHandle): DatabaseSync | null {
  if (!db) return null;
  if ('prepare' in db && typeof db.prepare === 'function') return db;
  if ('db' in db && db.db && typeof db.db.prepare === 'function') return db.db;
  return null;
}

export class GitHubGraphResolver {
  readonly ctx: GitHubResolverContext | null;
  config: GitHubResolverConfig;
  readonly credentials: GitHubAuthAccessor | null;
  readonly sqlite: DatabaseSync | null;
  readonly execFileImpl: ExecFileLike;

  readonly workstreams = new Map<string, BoundedWorkstream>();
  private readonly memEdges: EntityGraphEdge[] = [];
  private readonly memEntities = new Map<string, EntityRecord>();

  constructor(opts: GitHubGraphResolverOptions = {}) {
    this.ctx = opts.ctx ?? null;
    this.config = opts.config ?? {};
    this.credentials = opts.credentials ?? null;
    this.sqlite = resolveSqlite(opts.db ?? opts.ctx?.hub?.db ?? opts.ctx?.watcher?.db);
    this.execFileImpl = opts.execFileImpl ?? (execFileAsync as unknown as ExecFileLike);
  }

  updateConfig(next: GitHubResolverConfig): void {
    this.config = next;
  }

  asEntityResolver(): EntityResolver {
    return {
      id: 'github-graph',
      sources: ['github'],
      resolve: (event, signal) => this.resolve(event, signal),
    };
  }

  async resolve(event: NormalizedEvent, signal?: AbortSignal): Promise<ResolvedEntityContext | null> {
    const repo = String(event.rawRef?.repo || event.payload?.repo || '').trim();
    const number = Number(event.rawRef?.number || event.payload?.number || 0);
    if (!repo) return null;

    const entityKey = event.entityKey || (number ? `github:${repo}#${number}` : `github:${repo}`);
    const isPr = this._isPullRequestEvent(event);

    this.upsertEntity({
      entityKey,
      source: 'github',
      kind: isPr ? 'pull_request' : number ? 'issue' : 'notification',
      title: String(event.payload?.title || event.summary || ''),
      state: String(event.payload?.state || 'open'),
      rawUrl: event.rawRef?.url ?? null,
      lastEventId: event.id || null,
      metadata: {
        repo,
        number: number || undefined,
        isPr,
        draft: Boolean(event.payload?.draft),
        labels: Array.isArray(event.payload?.labels) ? event.payload.labels : [],
      },
    });
    this.ingestEdgesFromEvent(repo, number, event);

    const repoEntry = this.config.repoMap?.[repo];
    if (!repoEntry?.localPath || repoEntry.enabled === false) {
      return {
        workspacePath: null,
        workstreamKey: entityKey,
        preGateTags: [repoEntry?.enabled === false ? 'REPO_DISABLED' : 'UNMAPPED_REPO'],
      };
    }

    this._hydrateWorkstreamsFromStore();
    const workstream = this.bindHybridWorkstream(repo, number, event);
    const election = await this.electCanonicalSession(repo, workstream);

    const headRef =
      typeof event.payload?.headRef === 'string' && event.payload.headRef
        ? event.payload.headRef
        : workstream.primaryPr
          ? `refs/pull/${workstream.primaryPr.split('#')[1]}/head`
          : null;

    const gitProbe = await this.probeGitMergeConflict({
      repoPath: repoEntry.localPath,
      baseBranch: repoEntry.defaultBranch || 'main',
      headRef,
      signal,
    });

    const preGateTags = [...gitProbe.tags];
    if (repoEntry.sensitive) preGateTags.push('SENSITIVE_WORKSPACE');

    const relatedEdges = this.getRelatedEdges(entityKey);
    const relatedSessions = this._findRelatedSessions(entityKey, relatedEdges, workstream.workstreamKey);
    const contextHeader = this.buildContextCard({
      repo,
      workstream,
      gitProbe,
      relatedEdges,
      relatedSessions,
      supersededSessionId: election.secondarySessionId,
    });

    const prUrl = workstream.primaryPr
      ? `${GITHUB_WEB}/${repo}/pull/${workstream.primaryPr.split('#')[1]}`
      : undefined;

    return {
      workspacePath: repoEntry.localPath,
      sensitiveWorkspace: Boolean(repoEntry.sensitive),
      workstreamKey: workstream.workstreamKey,
      targetSessionId: election.canonicalSessionId,
      supersededBySessionId: election.supersededBySessionId,
      suggestedTitle: `[GH] ${repo}#${number || '?'} ${String(event.payload?.title || event.summary || '').slice(0, 48)}`.trim(),
      contextHeader,
      preGateTags,
      metadata: {
        repo,
        forgePrUrl: prUrl,
        prUrl,
        defaultBranch: repoEntry.defaultBranch || 'main',
        primaryPr: workstream.primaryPr,
        coupledIssues: [...workstream.issues],
        gitProbe,
      },
    };
  }

  private _isPullRequestEvent(event: NormalizedEvent): boolean {
    return Boolean(
      event.payload?.isPr ||
        event.payload?.isLinkedPr ||
        String(event.type || '').startsWith('github.pr.'),
    );
  }

  upsertEntity(params: {
    entityKey: string;
    source?: string;
    kind?: string;
    title?: string;
    state?: string;
    rawUrl?: string | null;
    lastEventId?: string | null;
    metadata?: Record<string, unknown>;
  }): void {
    const {
      entityKey,
      source = 'github',
      kind = 'issue',
      title = '',
      state = 'open',
      rawUrl = null,
      lastEventId = null,
      metadata = {},
    } = params;
    const now = new Date().toISOString();

    if (!this.sqlite) {
      this.memEntities.set(entityKey, {
        entityKey,
        source,
        kind,
        title,
        state,
        rawUrl,
        lastEventId,
        metadata,
        updatedAt: now,
      });
      return;
    }

    this.sqlite
      .prepare(
        `INSERT INTO entities (
           entity_key, source, kind, title, state, raw_url, last_event_id, metadata_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(entity_key) DO UPDATE SET
           kind = excluded.kind,
           title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE entities.title END,
           state = excluded.state,
           raw_url = COALESCE(excluded.raw_url, entities.raw_url),
           last_event_id = COALESCE(excluded.last_event_id, entities.last_event_id),
           metadata_json = excluded.metadata_json,
           updated_at = excluded.updated_at`,
      )
      .run(entityKey, source, kind, title, state, rawUrl, lastEventId, JSON.stringify(metadata), now, now);
  }

  upsertEdge(
    fromEntityKey: string,
    toEntityKey: string,
    relation: EdgeRelation,
    strength: 'tight' | 'loose',
    evidence: string | null = null,
  ): void {
    if (!fromEntityKey || !toEntityKey || fromEntityKey === toEntityKey) return;
    const now = new Date().toISOString();
    const id = `edge_${randomUUID()}`;

    if (this.sqlite) {
      this.sqlite
        .prepare(
          `INSERT OR IGNORE INTO entity_edges (
             id, from_entity_key, to_entity_key, relation, strength, evidence, discovered_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, fromEntityKey, toEntityKey, relation, strength, evidence, now);
    }

    const exists = this.memEdges.some(
      (e) =>
        e.fromEntityKey === fromEntityKey &&
        e.toEntityKey === toEntityKey &&
        e.relation === relation,
    );
    if (!exists) {
      this.memEdges.push({
        id,
        fromEntityKey,
        toEntityKey,
        relation,
        strength,
        evidence: evidence ?? undefined,
        discoveredAt: now,
      });
    }
  }

  getRelatedEdges(entityKey: string): EntityGraphEdge[] {
    if (this.sqlite) {
      const rows = this.sqlite
        .prepare(
          `SELECT id, from_entity_key, to_entity_key, relation, strength, evidence, discovered_at
           FROM entity_edges
           WHERE from_entity_key = ? OR to_entity_key = ?
           ORDER BY CASE WHEN strength = 'tight' THEN 0 ELSE 1 END, discovered_at DESC`,
        )
        .all(entityKey, entityKey) as Array<{
        id: string;
        from_entity_key: string;
        to_entity_key: string;
        relation: EdgeRelation;
        strength: 'tight' | 'loose';
        evidence: string | null;
        discovered_at: string;
      }>;
      return rows.map((r) => ({
        id: r.id,
        fromEntityKey: r.from_entity_key,
        toEntityKey: r.to_entity_key,
        relation: r.relation,
        strength: r.strength,
        evidence: r.evidence ?? undefined,
        discoveredAt: r.discovered_at,
      }));
    }
    return this.memEdges.filter((e) => e.fromEntityKey === entityKey || e.toEntityKey === entityKey);
  }

  ingestEdgesFromEvent(repo: string, number: number, event: NormalizedEvent): void {
    if (!number) return;
    const fromKey = `github:${repo}#${number}`;
    const body = String(event.payload?.body || '');
    const tightTargets = new Set<string>();

    for (const match of body.matchAll(TIGHT_REF_REGEX)) {
      const verb = match[1].toLowerCase();
      const relation: EdgeRelation = verb === 'resolves' ? 'closes' : (verb as EdgeRelation);
      const targetRepo = match[2] || repo;
      const targetKey = `github:${targetRepo}#${match[3]}`;
      tightTargets.add(targetKey);
      this.upsertEdge(fromKey, targetKey, relation, 'tight', match[0]);
    }

    if (Array.isArray(event.payload?.linkedPrs)) {
      for (const prNum of event.payload.linkedPrs) {
        const targetKey = `github:${repo}#${prNum}`;
        tightTargets.add(targetKey);
        this.upsertEdge(fromKey, targetKey, 'linked_pr', 'tight', 'pinned.linkedPrs');
      }
    }
    if (event.payload?.linkedFromIssue) {
      const targetKey = `github:${repo}#${event.payload.linkedFromIssue}`;
      tightTargets.add(targetKey);
      this.upsertEdge(fromKey, targetKey, 'linked_pr', 'tight', 'pinned.linkedFromIssue');
    }
    if (Array.isArray(event.payload?.manualLinks)) {
      for (const ref of event.payload.manualLinks) {
        const refStr = String(ref);
        const targetKey = refStr.startsWith('github:') ? refStr : `github:${repo}#${refStr}`;
        tightTargets.add(targetKey);
        this.upsertEdge(fromKey, targetKey, 'manual_link', 'tight', 'manual_link');
      }
    }

    for (const pinned of this.config.pinnedItems || []) {
      if (pinned.repo !== repo || !Array.isArray(pinned.linkedPrs)) continue;
      if (pinned.number === number) {
        for (const prNum of pinned.linkedPrs) {
          const targetKey = `github:${repo}#${prNum}`;
          tightTargets.add(targetKey);
          this.upsertEdge(fromKey, targetKey, 'linked_pr', 'tight', 'config.pinnedItems');
        }
      } else if (pinned.linkedPrs.includes(number)) {
        const targetKey = `github:${repo}#${pinned.number}`;
        tightTargets.add(targetKey);
        this.upsertEdge(fromKey, targetKey, 'linked_pr', 'tight', 'config.pinnedItems');
      }
    }

    for (const match of body.matchAll(LOOSE_REF_REGEX)) {
      const targetRepo = match[1] || repo;
      const targetKey = `github:${targetRepo}#${match[2]}`;
      if (targetKey === fromKey || tightTargets.has(targetKey)) continue;
      this.upsertEdge(fromKey, targetKey, 'cross_referenced', 'loose', match[0].trim());
    }

    if (Array.isArray(event.payload?.crossReferenced)) {
      for (const ref of event.payload.crossReferenced) {
        const refStr = String(ref);
        const targetKey = refStr.startsWith('github:') ? refStr : `github:${repo}#${refStr}`;
        if (targetKey === fromKey || tightTargets.has(targetKey)) continue;
        this.upsertEdge(fromKey, targetKey, 'cross_referenced', 'loose', 'payload.crossReferenced');
      }
    }
  }

  private _hydrateWorkstreamsFromStore(): void {
    const existing = this._listStoredWorkstreams();
    for (const w of existing) {
      if (w.source !== 'github' || w.supersededBy || w.status === 'ended') continue;
      if (this.workstreams.has(w.workstreamKey)) continue;
      const entityKeys = Array.isArray(w.entityKeys)
        ? w.entityKeys
        : [w.primaryEntityKey].filter(Boolean);
      const primaryPr = entityKeys.find((k) => this._isKnownPrEntity(k));
      const issues = entityKeys.filter((k) => k !== primaryPr);
      this.workstreams.set(w.workstreamKey, {
        workstreamKey: w.workstreamKey,
        primaryPr,
        issues,
      });
    }
  }

  private _isKnownPrEntity(entityKey: string): boolean {
    if (!entityKey) return false;
    if (this.sqlite) {
      const row = this.sqlite
        .prepare('SELECT kind FROM entities WHERE entity_key = ?')
        .get(entityKey) as { kind?: string } | undefined;
      if (row) return row.kind === 'pull_request';
    }
    return this.memEntities.get(entityKey)?.kind === 'pull_request';
  }

  private _listStoredWorkstreams(): WorkstreamRecord[] {
    const bus = this.ctx?.hub ?? this.ctx?.watcher;
    if (typeof bus?.listWorkstreams === 'function') {
      return bus.listWorkstreams() || [];
    }
    if (!this.sqlite) return [];
    const rows = this.sqlite
      .prepare('SELECT * FROM workstreams WHERE source = ?')
      .all('github') as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      source: String(r.source),
      workstreamKey: String(r.workstream_key),
      primaryEntityKey: String(r.primary_entity_key),
      entityKeys: JSON.parse(String(r.entity_keys_json || '[]')) as string[],
      workspacePath: String(r.workspace_path),
      sessionId: r.session_id ? String(r.session_id) : null,
      supersededBy: r.superseded_by ? String(r.superseded_by) : null,
      status: String(r.status) as WorkstreamRecord['status'],
      mode: String(r.mode) as WorkstreamRecord['mode'],
      trustMode: String(r.trust_mode) as WorkstreamRecord['trustMode'],
      deliveryCount: Number(r.delivery_count || 0),
      maxWakeups: Number(r.max_wakeups || 1),
      ttlExpiresAt: String(r.ttl_expires_at),
      lastWakeupAt: r.last_wakeup_at ? String(r.last_wakeup_at) : null,
      configRevision: Number(r.config_revision || 1),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    }));
  }

  bindHybridWorkstream(repo: string, number: number, event: NormalizedEvent): BoundedWorkstream {
    const entityKey = `github:${repo}#${number}`;
    const isPr = this._isPullRequestEvent(event);

    const tightEdges = this.getRelatedEdges(entityKey).filter(
      (e) => e.strength === 'tight' && TIGHT_RELATIONS.has(e.relation),
    );
    const tightNeighbors = tightEdges.map((e) =>
      e.fromEntityKey === entityKey ? e.toEntityKey : e.fromEntityKey,
    );

    for (const ws of this.workstreams.values()) {
      if (ws.primaryPr === entityKey || ws.issues.includes(entityKey)) {
        return ws;
      }
    }

    for (const ws of this.workstreams.values()) {
      const touchesTight = tightNeighbors.some(
        (n) => ws.primaryPr === n || ws.issues.includes(n),
      );
      if (!touchesTight) continue;

      if (isPr && !ws.primaryPr) {
        ws.primaryPr = entityKey;
        return ws;
      }
      if (!isPr && ws.issues.length < MAX_TIGHT_ISSUES_PER_WORKSTREAM) {
        ws.issues.push(entityKey);
        return ws;
      }
    }

    const created: BoundedWorkstream = {
      workstreamKey: `ws:${entityKey}`,
      primaryPr: isPr ? entityKey : undefined,
      issues: isPr ? [] : [entityKey],
    };
    this.workstreams.set(created.workstreamKey, created);
    return created;
  }

  async electCanonicalSession(
    repo: string,
    workstream: BoundedWorkstream,
  ): Promise<{
    canonicalSessionId?: string;
    supersededBySessionId?: string;
    secondarySessionId?: string;
  }> {
    const existing = this._listStoredWorkstreams();
    const wsEntities = new Set(
      [workstream.primaryPr, ...workstream.issues].filter((k): k is string => Boolean(k)),
    );
    const candidates = existing.filter(
      (w) =>
        !w.supersededBy &&
        w.status !== 'ended' &&
        (w.workstreamKey === workstream.workstreamKey ||
          (w.primaryEntityKey && wsEntities.has(w.primaryEntityKey)) ||
          (Array.isArray(w.entityKeys) && w.entityKeys.some((k) => wsEntities.has(k)))),
    );

    const forgeSessionId = await this.findForgeSessionForPr(repo, workstream.primaryPr);
    if (forgeSessionId) {
      const losers = candidates.filter((c) => c.sessionId && c.sessionId !== forgeSessionId);
      if (losers.length > 0) {
        this._markSuperseded(losers, forgeSessionId);
      }
      return {
        canonicalSessionId: forgeSessionId,
        supersededBySessionId: losers.length > 0 ? forgeSessionId : undefined,
        secondarySessionId: losers[0]?.sessionId ?? undefined,
      };
    }

    const withSession = candidates.filter((c): c is WorkstreamRecord & { sessionId: string } =>
      Boolean(c.sessionId),
    );
    if (withSession.length === 0) return { canonicalSessionId: undefined };

    withSession.sort((a, b) => {
      const dDiff = Number(b.deliveryCount || 0) - Number(a.deliveryCount || 0);
      if (dDiff !== 0) return dDiff;
      return Date.parse(b.updatedAt || '0') - Date.parse(a.updatedAt || '0');
    });

    const winner = withSession[0];
    const losers = withSession.slice(1).filter((c) => c.sessionId !== winner.sessionId);
    if (losers.length > 0) {
      this._markSuperseded(losers, winner.sessionId);
    }

    return {
      canonicalSessionId: winner.sessionId,
      supersededBySessionId: losers.length > 0 ? winner.sessionId : undefined,
      secondarySessionId: losers[0]?.sessionId ?? undefined,
    };
  }

  private _markSuperseded(losers: WorkstreamRecord[], winnerSessionId: string): void {
    if (!this.sqlite || !winnerSessionId) return;
    const now = new Date().toISOString();
    const stmt = this.sqlite.prepare(
      `UPDATE workstreams SET superseded_by = ?, updated_at = ? WHERE id = ? AND superseded_by IS NULL`,
    );
    for (const loser of losers) {
      if (loser.id) stmt.run(winnerSessionId, now, loser.id);
    }
  }

  private _findRelatedSessions(
    entityKey: string,
    relatedEdges: EntityGraphEdge[],
    currentWorkstreamKey: string,
  ): Array<{ entityKey: string; sessionId: string }> {
    const neighborKeys = new Set(
      relatedEdges.map((e) => (e.fromEntityKey === entityKey ? e.toEntityKey : e.fromEntityKey)),
    );
    if (neighborKeys.size === 0) return [];

    const existing = this._listStoredWorkstreams();
    const pointers: Array<{ entityKey: string; sessionId: string }> = [];
    for (const w of existing) {
      if (!w.sessionId || w.workstreamKey === currentWorkstreamKey) continue;
      const keys = Array.isArray(w.entityKeys)
        ? w.entityKeys
        : [w.primaryEntityKey].filter(Boolean);
      const matchedKey = keys.find((k) => neighborKeys.has(k));
      if (matchedKey) {
        pointers.push({ entityKey: matchedKey, sessionId: w.sessionId });
      }
    }
    return pointers;
  }

  async findForgeSessionForPr(repo: string, primaryPrKey?: string): Promise<string | undefined> {
    if (!primaryPrKey) return undefined;
    const prNumber = primaryPrKey.split('#')[1];
    const expectedUrl = `${GITHUB_WEB}/${repo}/pull/${prNumber}`;
    const cache = this.ctx?.get?.('sessionProjectionCache') as ProjectionCacheLike | undefined;
    const sessions = this.ctx?.get?.('sessions') as SessionsServiceLike | undefined;
    const headers = (await sessions?.list?.()) || [];

    for (const header of headers) {
      const snap = cache?.cachedSnapshot?.(header, ['forgeChangeRequests']);
      const crs = snap?.forgeChangeRequests || [];
      if (crs.some((cr) => cr?.url === expectedUrl)) return header.id;
    }
    return undefined;
  }

  async probeGitMergeConflict(params: {
    repoPath: string;
    baseBranch?: string;
    headRef: string | null;
    signal?: AbortSignal;
  }): Promise<GitMergeProbeResult> {
    const { repoPath, baseBranch = 'main', headRef, signal } = params;
    if (!repoPath || !headRef) {
      return { checked: false, conflictedFiles: [], behindCount: 0, tags: [] };
    }

    const baseRef = `origin/${baseBranch}`;

    if (this.config.gitFetchEnabled !== false) {
      const fetchArgs = ['-C', repoPath, 'fetch', '--no-tags', 'origin', baseBranch];
      if (headRef.startsWith('refs/pull/')) {
        fetchArgs.push(`${headRef}:${headRef}`);
      }
      try {
        await this.execFileImpl('git', fetchArgs, { signal, timeout: 10_000 });
      } catch {
        void 0;
      }
    }

    try {
      const { stdout: behindOut } = await this.execFileImpl(
        'git',
        ['-C', repoPath, 'rev-list', '--count', `${headRef}..${baseRef}`],
        { signal, timeout: 8_000 },
      );
      const behindCount = Number(String(behindOut || '').trim()) || 0;
      const tags = behindCount > 0 ? [`BEHIND_${baseBranch.toUpperCase()}_${behindCount}`] : [];

      try {
        await this.execFileImpl(
          'git',
          ['-C', repoPath, 'merge-tree', '--write-tree', '--no-messages', baseRef, headRef],
          { signal, timeout: 10_000 },
        );
        return { checked: true, conflictedFiles: [], behindCount, tags };
      } catch (mergeErr) {
        const out = String((mergeErr as { stdout?: unknown } | null)?.stdout || '');
        const conflictedFiles = out
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.startsWith('CONFLICT') || l.includes('\t'))
          .slice(0, 6);
        tags.unshift('CONFLICT_WITH_HEAD');
        return { checked: true, conflictedFiles, behindCount, tags };
      }
    } catch {
      return { checked: false, conflictedFiles: [], behindCount: 0, tags: [] };
    }
  }

  buildContextCard(params: {
    repo: string;
    workstream: BoundedWorkstream;
    gitProbe?: GitMergeProbeResult;
    relatedEdges?: EntityGraphEdge[];
    relatedSessions?: Array<{ entityKey: string; sessionId: string }>;
    supersededSessionId?: string;
  }): string {
    const {
      repo,
      workstream,
      gitProbe,
      relatedEdges = [],
      relatedSessions = [],
      supersededSessionId,
    } = params;

    const lines = [
      `[Related Context Card | ${repo}]`,
      `Workstream: ${workstream.workstreamKey} (PR=${workstream.primaryPr || 'none'}, Issues=${workstream.issues.join(',') || 'none'})`,
    ];

    if (gitProbe?.checked) {
      const conflictSummary =
        gitProbe.conflictedFiles.length > 0
          ? `CONFLICT(${gitProbe.conflictedFiles.length}): ${gitProbe.conflictedFiles.join('; ')}`
          : 'CLEAN';
      lines.push(`GitProbe: behind=${gitProbe.behindCount}, mergeTree=${conflictSummary}`);
    }
    if (supersededSessionId) {
      lines.push(
        `DesignHistory: prior session=${supersededSessionId} (use session_event_read if needed)`,
      );
    }
    for (const ptr of relatedSessions.slice(0, MAX_RELATED_POINTERS)) {
      lines.push(
        `RelatedSession: ${ptr.entityKey} -> session=${ptr.sessionId} (sticky note; use session_search if needed)`,
      );
    }
    for (const edge of relatedEdges.slice(0, MAX_RELATED_POINTERS)) {
      lines.push(
        `Edge[${edge.strength}:${edge.relation}]: ${edge.fromEntityKey} -> ${edge.toEntityKey}`,
      );
    }

    const card = lines.join('\n');
    return card.length <= MAX_CONTEXT_CARD_CHARS
      ? card
      : `${card.slice(0, MAX_CONTEXT_CARD_CHARS - 3)}...`;
  }

  async attachForgeAndWorktree(
    agent: { session?: unknown },
    resolved: ResolvedEntityContext | null | undefined,
    opts: { createWorktree?: boolean } = {},
  ): Promise<void> {
    const { createWorktree = false } = opts;
    const prUrl = typeof resolved?.metadata?.prUrl === 'string' ? resolved.metadata.prUrl : undefined;
    if (prUrl) {
      const forge = this.ctx?.get?.('forgeSession') as ForgeSessionServiceLike | undefined;
      await forge?.track?.(agent.session, prUrl);
    }
    if (createWorktree && typeof resolved?.metadata?.primaryPr === 'string') {
      const prNum = resolved.metadata.primaryPr.split('#')[1];
      const worktrees = this.ctx?.get?.('worktrees') as WorktreesServiceLike | undefined;
      const defaultBranch =
        typeof resolved.metadata.defaultBranch === 'string'
          ? resolved.metadata.defaultBranch
          : 'main';
      await worktrees?.create?.(agent, {
        name: `gh-pr-${prNum}`,
        from: defaultBranch,
      });
    }
    if (resolved?.suggestedTitle) {
      const sessionTitle = this.ctx?.get?.('sessionTitle') as SessionTitleServiceLike | undefined;
      await sessionTitle?.rename?.(agent.session, resolved.suggestedTitle);
    }
  }
}
