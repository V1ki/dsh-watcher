import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  ActionSink,
  HubService,
  SinkInvokeInput,
  SinkInvokeResult,
  WatcherDb,
} from '@local/dsh-hub/contracts';
import type { GitHubAuthAccessor, GitHubAuthToken } from './auth.js';

const GITHUB_API = 'https://api.github.com';
const SELF_MARKER_REGEX = /<!--\s*dsh-watch-self:([a-zA-Z0-9._:-]+)\s*-->/;
const DEFAULT_AUTO_SEND_OWNERS: string[] = [];

export interface GitHubRepoEntry {
  localPath?: string;
  defaultBranch?: string;
  sensitive?: boolean;
  autoSend?: boolean;
  enabled?: boolean;
  personaId?: string | null;
}

export interface GitHubActionSink extends ActionSink {
  updateConfig(next: GitHubSinkConfig): void;
}

export interface GitHubSinkConfig {
  ownerLogins?: string[];
  autoSendOwners?: string[];
  repoMap?: Record<string, GitHubRepoEntry>;
}

export interface GitHubPublishedMeta {
  externalId: string;
  url?: string;
  repo: string;
  number: number;
}

export type FetchResponseLike = {
  status: number;
  ok: boolean;
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
  text?: () => Promise<string>;
};

export type FetchLike = (url: string, init?: RequestInit) => Promise<FetchResponseLike>;

export type DbHandle = WatcherDb | DatabaseSync | null | undefined;

export interface CreateGitHubSinkOptions {
  config?: GitHubSinkConfig;
  credentials: GitHubAuthAccessor;
  db?: DbHandle;
  onPublished?: (meta: GitHubPublishedMeta) => void;
  fetchImpl?: FetchLike;
}

export interface ExtendedSinkInvokeInput extends SinkInvokeInput {
  workstreamId?: string;
  previewText?: string;
  approved?: boolean;
}

export interface ToolExecutionContext {
  agent?: {
    id?: string;
    session?: {
      header?: {
        cwd?: string;
        delegationDepth?: number;
        origin?: string;
      };
    };
  };
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (args: Record<string, unknown>, exec?: ToolExecutionContext) => Promise<SinkInvokeResult>;
}

export interface ToolsRegistryLike {
  register?: (def: ToolDefinition) => (() => void) | void;
}

export interface StageToolsContext {
  hub?: Pick<HubService, 'invokeSink'>;
  watcher?: Pick<HubService, 'invokeSink'>;
  get?: (name: string) => unknown;
  tools?: ToolsRegistryLike;
}

function resolveSqlite(db: DbHandle): DatabaseSync | null {
  if (!db) return null;
  if ('prepare' in db && typeof db.prepare === 'function') return db;
  if ('db' in db && db.db && typeof db.db.prepare === 'function') return db.db;
  return null;
}

export function shouldAutoSend(repo: string, config: GitHubSinkConfig = {}): boolean {
  if (!repo || typeof repo !== 'string') return false;
  const trimmed = repo.trim();
  if (!trimmed.includes('/')) return false;

  const repoEntry = config.repoMap?.[trimmed];
  if (repoEntry && typeof repoEntry.autoSend === 'boolean') {
    return repoEntry.autoSend;
  }

  const owner = trimmed.split('/')[0].toLowerCase();
  const autoSendOwners = Array.isArray(config.autoSendOwners)
    ? config.autoSendOwners
    : DEFAULT_AUTO_SEND_OWNERS;

  return autoSendOwners.some((o) => String(o || '').trim().toLowerCase() === owner);
}

export function appendSelfTriggerMarker(body: string, idempotencyKey?: string): string {
  const text = String(body || '').trimEnd();
  if (SELF_MARKER_REGEX.test(text)) return text;
  const safeKey = String(idempotencyKey || randomUUID()).replace(/[^a-zA-Z0-9._:-]/g, '_');
  return `${text}\n\n<!-- dsh-watch-self:${safeKey} -->`;
}

export function hasSelfTriggerMarker(body: unknown): boolean {
  return typeof body === 'string' && SELF_MARKER_REGEX.test(body);
}

function isDraftApprovedInDb(sqlite: DatabaseSync | null, idempotencyKey: string): boolean {
  if (!sqlite || !idempotencyKey) return false;
  try {
    const row = sqlite
      .prepare('SELECT status FROM staged_drafts WHERE idempotency_key = ?')
      .get(String(idempotencyKey)) as { status?: string } | undefined;
    return row?.status === 'approved' || row?.status === 'executing';
  } catch {
    return false;
  }
}

function persistStagedDraft(
  sqlite: DatabaseSync | null,
  params: { sinkId: string; input: ExtendedSinkInvokeInput; repo: string; number: number },
): { draftId: string; previewText: string } {
  const { sinkId, input, repo, number } = params;
  const draftId = `drf_${randomUUID()}`;
  const idempotencyKey = String(input.idempotencyKey || `gh-draft:${repo}#${number}:${draftId}`);
  const previewText =
    input.previewText ||
    `[GH ${input.action} ${repo}#${number}] ${String(input.payload?.body || '').slice(0, 140)}`;

  if (!sqlite) {
    return { draftId: idempotencyKey, previewText };
  }

  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO staged_drafts (
         id, sink_id, sink_kind, action, workstream_id, session_id,
         target_json, payload_json, preview_text, idempotency_key, status, created_at, updated_at
       ) VALUES (?, ?, 'staged-draft', ?, ?, ?, ?, ?, ?, ?, 'pending_approval', ?, ?)`,
    )
    .run(
      draftId,
      sinkId,
      String(input.action || 'issue_comment'),
      input.workstreamId ?? null,
      input.sessionId ?? null,
      JSON.stringify(input.target ?? {}),
      JSON.stringify(input.payload ?? {}),
      previewText,
      idempotencyKey,
      now,
      now,
    );

  const row = sqlite
    .prepare('SELECT id FROM staged_drafts WHERE idempotency_key = ?')
    .get(idempotencyKey) as { id?: string } | undefined;
  return { draftId: row?.id || draftId, previewText };
}

function isUsingUserToken(auth: GitHubAuthToken | null): boolean {
  if (!auth) return true;
  if (auth.isBot) return false;
  if (auth.slot === 'act') return false;
  return true;
}

function isOwnPullRequest(
  input: ExtendedSinkInvokeInput,
  auth: GitHubAuthToken,
  config: GitHubSinkConfig,
): boolean {
  if (input.target?.isSelfPr === true || input.payload?.isSelfPr === true) return true;
  const prAuthor = String(input.target?.prAuthor || input.payload?.prAuthor || '')
    .trim()
    .toLowerCase();
  if (!prAuthor) return false;

  const knownSelfLogins = new Set(
    [
      auth.login,
      ...(Array.isArray(config.ownerLogins) ? config.ownerLogins : []),
      ...(Array.isArray(config.autoSendOwners) ? config.autoSendOwners : []),
    ]
      .filter((s): s is string => Boolean(s))
      .map((s) => s.trim().toLowerCase()),
  );
  return knownSelfLogins.has(prAuthor);
}

export function createGitHubSink(opts: CreateGitHubSinkOptions): GitHubActionSink {
  const {
    config = {},
    credentials,
    db = null,
    onPublished,
    fetchImpl = globalThis.fetch as unknown as FetchLike,
  } = opts;

  let activeConfig: GitHubSinkConfig = config;
  const sinkId = 'github.draft';
  const sqlite = resolveSqlite(db);

  return {
    id: sinkId,
    label: 'GitHub Reply & Review Sink',
    kind: 'idempotent',
    requiresApproval: false,

    updateConfig(next: GitHubSinkConfig): void {
      activeConfig = next;
    },

    async invoke(rawInput: SinkInvokeInput, signal?: AbortSignal): Promise<SinkInvokeResult> {
      const input = rawInput as ExtendedSinkInvokeInput;
      const repo = String(input?.target?.repo || '').trim();
      const number = Number(input?.target?.number || 0);
      if (!repo || !number) {
        return { status: 'failed', detail: 'Missing target.repo or target.number' };
      }

      const autoSend = shouldAutoSend(repo, activeConfig);
      const approvedInDb = isDraftApprovedInDb(sqlite, input.idempotencyKey);
      const mustStage =
        input.stageOnly === true || (!autoSend && input.approved !== true && !approvedInDb);

      if (mustStage) {
        const { draftId } = persistStagedDraft(sqlite, { sinkId, input, repo, number });
        return {
          status: 'staged',
          draftId,
          detail: `Staged ${input.action} draft for ${repo}#${number} (awaiting approval)`,
        };
      }

      let auth: GitHubAuthToken | null;
      try {
        auth = await credentials.readSlot('act', { repo, signal });
      } catch (err) {
        return {
          status: 'failed',
          detail: err instanceof Error ? err.message : String(err),
        };
      }
      if (!auth?.token) {
        return {
          status: 'failed',
          detail: 'Missing GitHub act/read credential (and gh CLI fallback unavailable)',
        };
      }

      const markedBody = appendSelfTriggerMarker(
        String(input.payload?.body || ''),
        input.idempotencyKey,
      );
      const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'dsh-connector-github/0.1.0',
      };

      if (input.action === 'issue_comment') {
        const resp = await fetchImpl(`${GITHUB_API}/repos/${repo}/issues/${number}/comments`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ body: markedBody }),
          signal,
        });
        if (!resp.ok) {
          return { status: 'failed', detail: `GitHub comment API failed: HTTP ${resp.status}` };
        }
        const created = (await resp.json()) as { id: string | number; html_url?: string };
        const externalId = String(created.id);
        onPublished?.({ externalId, url: created.html_url, repo, number });
        return {
          status: 'executed',
          receiptId: externalId,
          externalUrl: created.html_url,
          detail: `Published comment #${externalId} on ${repo}#${number}`,
        };
      }

      if (input.action === 'pr_review') {
        const requestedEvent = String(input.payload?.event || 'COMMENT').toUpperCase();
        let reviewEvent = requestedEvent;
        let downgraded = false;

        if (
          isUsingUserToken(auth) &&
          isOwnPullRequest(input, auth, activeConfig) &&
          (reviewEvent === 'APPROVE' || reviewEvent === 'REQUEST_CHANGES')
        ) {
          reviewEvent = 'COMMENT';
          downgraded = true;
        }

        const reviewPayload: Record<string, unknown> = {
          body: markedBody,
          event: reviewEvent,
        };
        if (Array.isArray(input.payload?.comments) && input.payload.comments.length > 0) {
          reviewPayload.comments = input.payload.comments;
        }

        const resp = await fetchImpl(`${GITHUB_API}/repos/${repo}/pulls/${number}/reviews`, {
          method: 'POST',
          headers,
          body: JSON.stringify(reviewPayload),
          signal,
        });
        if (!resp.ok) {
          return { status: 'failed', detail: `GitHub PR review API failed: HTTP ${resp.status}` };
        }
        const created = (await resp.json()) as { id: string | number; html_url?: string };
        const externalId = String(created.id);
        onPublished?.({ externalId, url: created.html_url, repo, number });
        const downgradeNote = downgraded ? ` (downgraded from ${requestedEvent} on self PR)` : '';
        return {
          status: 'executed',
          receiptId: externalId,
          externalUrl: created.html_url,
          detail: `Published PR review (${reviewEvent}) #${externalId} on ${repo}#${number}${downgradeNote}`,
        };
      }

      return { status: 'skipped', detail: `Unsupported GitHub sink action: ${input.action}` };
    },
  };
}

function assertRootSessionCaller(exec?: ToolExecutionContext): { sessionId: string; cwd?: string } {
  const sessionId = exec?.agent?.id;
  const header = exec?.agent?.session?.header;
  if (!sessionId) {
    throw new Error('gh_stage_* tools require an active DSH root session context (exec.agent.id).');
  }
  if (header && ((header.delegationDepth ?? 0) > 0 || header.origin === 'subagent')) {
    throw new Error('Subagents are not permitted to invoke GitHub outbound tools.');
  }
  return { sessionId, cwd: header?.cwd };
}

export function registerGitHubStageTools(
  ctx: StageToolsContext,
  opts: { config?: GitHubSinkConfig; sinkId?: string } = {},
): Array<() => void> {
  const { config = {}, sinkId = 'github.draft' } = opts;
  const hub = ctx.hub ?? ctx.watcher;
  const tools =
    typeof ctx.get === 'function'
      ? (ctx.get('tools') as ToolsRegistryLike | undefined)
      : ctx.tools;
  if (!tools?.register || !hub) return [];

  const stageReply = tools.register({
    name: 'gh_stage_reply',
    description:
      'Post immediately on autoSend repos (configured via autoSendOwners or per-repo autoSend) or stage a GitHub Issue/PR reply draft for 1-click user approval on other repos.',
    inputSchema: {
      type: 'object',
      required: ['repo', 'number', 'body'],
      properties: {
        repo: { type: 'string', description: 'Repository in owner/name format' },
        number: { type: 'integer', description: 'Issue or Pull Request number' },
        body: { type: 'string', description: 'Markdown comment body' },
        stageOnly: {
          type: 'boolean',
          description: 'Optional override to force staging as draft even on autoSend repos',
        },
      },
    },
    execute: async (args, exec) => {
      const { sessionId } = assertRootSessionCaller(exec);
      const repo = String(args.repo || '');
      const number = Number(args.number || 0);
      const body = String(args.body || '');
      const autoSend = args.stageOnly === true ? false : shouldAutoSend(repo, config);
      const invokeInput: ExtendedSinkInvokeInput = {
        action: 'issue_comment',
        target: { repo, number },
        payload: { body },
        previewText: `[GH Comment ${repo}#${number}] ${body.slice(0, 120)}`,
        idempotencyKey: `gh-reply:${repo}#${number}:${randomUUID()}`,
        sessionId,
        stageOnly: !autoSend,
      };
      return hub.invokeSink(sinkId, invokeInput);
    },
  });

  const stageReview = tools.register({
    name: 'gh_stage_review',
    description:
      'Post immediately on autoSend repos (configured via autoSendOwners or per-repo autoSend) or stage a GitHub PR review draft for 1-click user approval. Self-PR APPROVE/REQUEST_CHANGES auto-downgrades to COMMENT under user tokens.',
    inputSchema: {
      type: 'object',
      required: ['repo', 'number', 'body'],
      properties: {
        repo: { type: 'string', description: 'Repository in owner/name format' },
        number: { type: 'integer', description: 'Pull Request number' },
        body: { type: 'string', description: 'Overall review summary markdown' },
        event: { type: 'string', enum: ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'] },
        prAuthor: {
          type: 'string',
          description: 'Optional PR author login for self-PR downgrade detection',
        },
        comments: {
          type: 'array',
          description: 'Optional inline diff review comments ({ path, line, body })',
        },
        stageOnly: {
          type: 'boolean',
          description: 'Optional override to force staging as draft even on autoSend repos',
        },
      },
    },
    execute: async (args, exec) => {
      const { sessionId } = assertRootSessionCaller(exec);
      const repo = String(args.repo || '');
      const number = Number(args.number || 0);
      const body = String(args.body || '');
      const event = String(args.event || 'COMMENT');
      const autoSend = args.stageOnly === true ? false : shouldAutoSend(repo, config);
      const invokeInput: ExtendedSinkInvokeInput = {
        action: 'pr_review',
        target: { repo, number, prAuthor: args.prAuthor },
        payload: { body, event, comments: Array.isArray(args.comments) ? args.comments : [] },
        previewText: `[GH Review (${event}) ${repo}#${number}] ${body.slice(0, 120)}`,
        idempotencyKey: `gh-review:${repo}#${number}:${randomUUID()}`,
        sessionId,
        stageOnly: !autoSend,
      };
      return hub.invokeSink(sinkId, invokeInput);
    },
  });

  return [stageReply, stageReview].filter((d): d is () => void => typeof d === 'function');
}
