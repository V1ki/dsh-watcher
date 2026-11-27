import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  GitHubAdminAdapter,
  GitHubAdminConfigUpdate,
  GitHubAdminConfigView,
  GitHubAppSaveInput,
  GitHubAppSaveResult,
  GitHubAppVerifyResult,
  GitHubAuthStatusView,
  GitHubPinnedConfigItem,
  GitHubRepoConfigItem,
  GitHubSaveTokenInput,
  GitHubSaveTokenResult,
  GitHubVerifyTokenResult,
  HubService,
  PersonaWardrobe,
  RoutingRule,
} from '@local/dsh-hub/contracts';
import {
  buildDshRecordKeys,
  createGitHubAppJwt,
  createGitHubAuth,
  isMissingNotificationsScope,
  MISSING_NOTIFICATIONS_SCOPE_HINT,
  resolveDefaultCredentialsPath,
  withFileLock,
  writeFileAtomic,
  type AuthFetchLike,
  type GitHubAuthConfig,
  type GitHubCredentialStore,
  type GitHubLogger,
} from './auth.js';
import {
  extractLinkedIssues,
  GitHubPoller,
  MAX_RECENT_EVENTS,
  type GitHubPinnedItem,
  type GitHubRecentEvent,
} from './poller.js';
import { GitHubGraphResolver, MAX_CONTEXT_CARD_CHARS } from './graph-resolver.js';
import {
  createGitHubSink,
  registerGitHubStageTools,
  shouldAutoSend,
  appendSelfTriggerMarker,
  hasSelfTriggerMarker,
  type DbHandle,
  type FetchLike,
  type GitHubRepoEntry,
  type ToolsRegistryLike,
} from './sink.js';
import {
  checkLocalOwnerRequest,
  createGitHubConnectorHttpHandler,
  mountGitHubConnectorHttpRoutes,
  type GitHubConnectorHttpContext,
} from './http-routes.js';
import {
  createGitHubVaultProvider,
  resolveGitHubOutboundTargetCircle,
  resolveGitHubRepoVaultVisibility,
  type GitHubVaultProviderOptions,
  type GitHubVisibilityOptions,
} from './vault-provider.js';

export const name = 'connector-github';

export const inject = ['hub'] as const;

export const BUNDLED_SKILL_RANK = 600;

export const GITHUB_CONFIG_META_KEY = 'github_config';

const VERIFY_CACHE_TTL_MS = 5 * 60_000;

export interface GitHubAdapterConfig {
  ownerLogins: string[];
  autoSendOwners: string[];
  botLogin: string;
  enableNotifications: boolean;
  notificationsEnabled: boolean;
  pollIntervalMs: number;
  pinnedPollIntervalMs: number;
  gitFetchEnabled: boolean;
  defaultPersonaId: string | null;
  auth: Required<Pick<GitHubAuthConfig, 'readCredentialProfile' | 'actCredentialProfile' | 'fallbackGhCli'>> & {
    appCredentialProfile?: string;
    credentialsFilePath?: string;
    ghCliCacheTtlMs?: number;
  };
  repoMap: Record<string, GitHubRepoEntry>;
  pinnedItems: GitHubPinnedItem[];
}

export interface RawGitHubAdapterConfig {
  ownerLogins?: string[];
  autoSendOwners?: string[];
  botLogin?: string;
  enableNotifications?: boolean;
  notificationsEnabled?: boolean;
  pollIntervalMs?: number;
  pinnedPollIntervalMs?: number;
  gitFetchEnabled?: boolean;
  defaultPersonaId?: string | null;
  auth?: GitHubAuthConfig;
  repoMap?: Record<string, GitHubRepoEntry>;
  pinnedItems?: GitHubPinnedItem[];
  fetchImpl?: FetchLike & AuthFetchLike;
}

export interface BundledSkillDefinition {
  name: string;
  rank: number;
  description: string;
  prompt: string;
}

export interface SkillsRegistryLike {
  register?: (def: BundledSkillDefinition) => (() => void) | void;
}

export interface GitHubPluginContext extends GitHubConnectorHttpContext {
  hub?: HubService;
  watcher?: HubService;
  credentials?: GitHubCredentialStore;
  tools?: ToolsRegistryLike;
  skills?: SkillsRegistryLike;
  logger?: ((scope: string) => GitHubLogger) | GitHubLogger;
  get?: (serviceName: string) => unknown;
  on?: (event: string, listener: () => void) => void;
  inject?: (deps: readonly string[], callback: (subCtx: GitHubPluginContext) => void) => unknown;
  effect?: (callback: () => (() => void) | void) => unknown;
}

interface PersistedGitHubConfig {
  enableNotifications?: boolean;
  pollIntervalMs?: number;
  pinnedPollIntervalMs?: number;
  autoSendOwners?: string[];
  ownerLogins?: string[];
  botLogin?: string;
  defaultPersonaId?: string | null;
  repos?: GitHubRepoConfigItem[];
  repoMap?: Record<string, GitHubRepoEntry>;
  pinnedItems?: GitHubPinnedConfigItem[];
}

function resolveSqlite(db: DbHandle): DatabaseSync | null {
  if (!db) return null;
  if ('prepare' in db && typeof db.prepare === 'function') return db;
  if ('db' in db && db.db && typeof db.db.prepare === 'function') return db.db;
  return null;
}

function readRuntimeMeta(db: DbHandle, key: string): string | undefined {
  if (!db) return undefined;
  if ('getMeta' in db && typeof db.getMeta === 'function') {
    return db.getMeta(key);
  }
  const sqlite = resolveSqlite(db);
  if (!sqlite) return undefined;
  try {
    const row = sqlite.prepare('SELECT value FROM runtime_meta WHERE key = ?').get(key) as
      | { value?: string }
      | undefined;
    return row?.value;
  } catch {
    return undefined;
  }
}

function writeRuntimeMeta(db: DbHandle, key: string, value: string): void {
  if (!db) return;
  if ('setMeta' in db && typeof db.setMeta === 'function') {
    db.setMeta(key, value);
    return;
  }
  const sqlite = resolveSqlite(db);
  if (!sqlite) return;
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO runtime_meta (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, now);
}

function normalizeStringList(values: unknown, fallback: string[]): string[] {
  if (!Array.isArray(values)) return [...fallback];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of values) {
    const trimmed = String(item ?? '').trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function normalizeRepoName(raw: unknown): string {
  const trimmed = String(raw ?? '').trim();
  const parts = trimmed.split('/');
  if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
    throw new Error(`invalid_repo_format:${trimmed}`);
  }
  return `${parts[0].trim()}/${parts[1].trim()}`;
}

function normalizeOptionalPersonaId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

function normalizeRepoMapFromArray(items: GitHubRepoConfigItem[]): Record<string, GitHubRepoEntry> {
  const map: Record<string, GitHubRepoEntry> = {};
  for (const item of items) {
    const repo = normalizeRepoName(item.repo);
    const localPath = typeof item.localPath === 'string' && item.localPath.trim() ? item.localPath.trim() : undefined;
    const defaultBranch =
      typeof item.defaultBranch === 'string' && item.defaultBranch.trim() ? item.defaultBranch.trim() : undefined;
    const personaId = normalizeOptionalPersonaId(item.personaId);
    const entry: GitHubRepoEntry = {
      ...(localPath ? { localPath } : {}),
      ...(defaultBranch ? { defaultBranch } : {}),
      ...(typeof item.sensitive === 'boolean' ? { sensitive: item.sensitive } : {}),
      ...(typeof item.autoSend === 'boolean' ? { autoSend: item.autoSend } : {}),
      ...(personaId ? { personaId } : {}),
      enabled: item.enabled !== false,
    };
    map[repo] = entry;
  }
  return map;
}

function normalizePinnedItems(
  items: Array<{ repo: string; number: number; linkedPrs?: number[]; watchReactions?: boolean }>,
): GitHubPinnedConfigItem[] {
  const seen = new Set<string>();
  const out: GitHubPinnedConfigItem[] = [];
  for (const item of items) {
    const repo = normalizeRepoName(item.repo);
    const num = Number(item.number);
    if (!Number.isInteger(num) || num <= 0) {
      throw new Error(`invalid_pinned_number:${String(item.number)}`);
    }
    const key = `${repo}#${num}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const linkedPrs = Array.isArray(item.linkedPrs)
      ? Array.from(
          new Set(
            item.linkedPrs
              .map((n) => Number(n))
              .filter((n) => Number.isInteger(n) && n > 0),
          ),
        )
      : [];
    out.push({
      repo,
      number: num,
      linkedPrs,
      watchReactions: item.watchReactions !== false,
    });
  }
  return out;
}

function repoMapToArray(repoMap: Record<string, GitHubRepoEntry>): GitHubRepoConfigItem[] {
  return Object.entries(repoMap || {}).map(([repo, entry]) => ({
    repo,
    ...(entry?.localPath ? { localPath: entry.localPath } : {}),
    ...(entry?.defaultBranch ? { defaultBranch: entry.defaultBranch } : {}),
    ...(typeof entry?.sensitive === 'boolean' ? { sensitive: entry.sensitive } : {}),
    ...(typeof entry?.autoSend === 'boolean' ? { autoSend: entry.autoSend } : {}),
    ...(entry?.personaId ? { personaId: entry.personaId } : {}),
    enabled: entry?.enabled !== false,
  }));
}

function pinnedItemsToView(items: GitHubPinnedItem[]): GitHubPinnedConfigItem[] {
  return (items || []).map((item) => ({
    repo: item.repo,
    number: item.number,
    linkedPrs: Array.isArray(item.linkedPrs) ? [...item.linkedPrs] : [],
    watchReactions: item.watchReactions !== false,
  }));
}

export function normalizeConfig(raw: RawGitHubAdapterConfig = {}): GitHubAdapterConfig {
  const enableNotifications =
    raw.enableNotifications !== undefined
      ? raw.enableNotifications !== false
      : raw.notificationsEnabled !== false;

  const repoMap: Record<string, GitHubRepoEntry> = {};
  if (raw.repoMap && typeof raw.repoMap === 'object') {
    for (const [repo, entry] of Object.entries(raw.repoMap)) {
      const personaId = normalizeOptionalPersonaId(entry?.personaId);
      repoMap[repo] = {
        ...entry,
        ...(personaId ? { personaId } : { personaId: undefined }),
        enabled: entry?.enabled !== false,
      };
    }
  }

  return {
    ownerLogins: Array.isArray(raw.ownerLogins) ? [...raw.ownerLogins] : [],
    autoSendOwners: Array.isArray(raw.autoSendOwners) ? [...raw.autoSendOwners] : [],
    botLogin: typeof raw.botLogin === 'string' ? raw.botLogin : '',
    enableNotifications,
    notificationsEnabled: enableNotifications,
    pollIntervalMs: Math.max(15_000, Number(raw.pollIntervalMs) || 60_000),
    pinnedPollIntervalMs: Math.max(15_000, Number(raw.pinnedPollIntervalMs) || 30_000),
    gitFetchEnabled: raw.gitFetchEnabled !== false,
    defaultPersonaId: normalizeOptionalPersonaId(raw.defaultPersonaId),
    auth: {
      readCredentialProfile: raw.auth?.readCredentialProfile || 'github-read',
      actCredentialProfile: raw.auth?.actCredentialProfile || 'github-act',
      appCredentialProfile: raw.auth?.appCredentialProfile,
      fallbackGhCli: raw.auth?.fallbackGhCli !== false,
      credentialsFilePath: raw.auth?.credentialsFilePath,
      ghCliCacheTtlMs: raw.auth?.ghCliCacheTtlMs,
    },
    repoMap,
    pinnedItems: Array.isArray(raw.pinnedItems)
      ? raw.pinnedItems.map((p) => ({
          repo: p.repo,
          number: p.number,
          linkedPrs: Array.isArray(p.linkedPrs) ? [...p.linkedPrs] : [],
          watchReactions: p.watchReactions !== false,
        }))
      : [],
  };
}

function mergePersistedConfig(base: GitHubAdapterConfig, db: DbHandle): GitHubAdapterConfig {
  const raw = readRuntimeMeta(db, GITHUB_CONFIG_META_KEY);
  if (!raw) return base;
  try {
    const saved = JSON.parse(raw) as PersistedGitHubConfig;
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return base;

    const enableNotifications =
      typeof saved.enableNotifications === 'boolean' ? saved.enableNotifications : base.enableNotifications;
    const pollIntervalMs =
      typeof saved.pollIntervalMs === 'number' && Number.isFinite(saved.pollIntervalMs)
        ? Math.max(15_000, Math.round(saved.pollIntervalMs))
        : base.pollIntervalMs;
    const pinnedPollIntervalMs =
      typeof saved.pinnedPollIntervalMs === 'number' && Number.isFinite(saved.pinnedPollIntervalMs)
        ? Math.max(15_000, Math.round(saved.pinnedPollIntervalMs))
        : base.pinnedPollIntervalMs;
    const autoSendOwners = Array.isArray(saved.autoSendOwners)
      ? normalizeStringList(saved.autoSendOwners, base.autoSendOwners)
      : base.autoSendOwners;
    const ownerLogins = Array.isArray(saved.ownerLogins)
      ? normalizeStringList(saved.ownerLogins, base.ownerLogins)
      : base.ownerLogins;
    const botLogin = typeof saved.botLogin === 'string' ? saved.botLogin : base.botLogin;
    const defaultPersonaId =
      saved.defaultPersonaId !== undefined
        ? normalizeOptionalPersonaId(saved.defaultPersonaId)
        : base.defaultPersonaId;

    let repoMap = base.repoMap;
    if (Array.isArray(saved.repos)) {
      repoMap = normalizeRepoMapFromArray(saved.repos);
    } else if (saved.repoMap && typeof saved.repoMap === 'object' && !Array.isArray(saved.repoMap)) {
      repoMap = {};
      for (const [repo, entry] of Object.entries(saved.repoMap)) {
        const personaId = normalizeOptionalPersonaId(entry?.personaId);
        repoMap[repo] = {
          ...entry,
          ...(personaId ? { personaId } : { personaId: undefined }),
          enabled: entry?.enabled !== false,
        };
      }
    }

    const pinnedItems = Array.isArray(saved.pinnedItems)
      ? normalizePinnedItems(saved.pinnedItems)
      : base.pinnedItems;

    return {
      ...base,
      enableNotifications,
      notificationsEnabled: enableNotifications,
      pollIntervalMs,
      pinnedPollIntervalMs,
      autoSendOwners,
      ownerLogins,
      botLogin,
      defaultPersonaId,
      repoMap,
      pinnedItems,
    };
  } catch {
    return base;
  }
}

function persistConfigToDb(db: DbHandle, config: GitHubAdapterConfig): void {
  const payload: PersistedGitHubConfig = {
    enableNotifications: config.enableNotifications,
    pollIntervalMs: config.pollIntervalMs,
    pinnedPollIntervalMs: config.pinnedPollIntervalMs,
    autoSendOwners: [...config.autoSendOwners],
    ownerLogins: [...config.ownerLogins],
    botLogin: config.botLogin,
    defaultPersonaId: config.defaultPersonaId,
    repos: repoMapToArray(config.repoMap),
    pinnedItems: pinnedItemsToView(config.pinnedItems),
  };
  writeRuntimeMeta(db, GITHUB_CONFIG_META_KEY, JSON.stringify(payload));
  const currentRev = Number(readRuntimeMeta(db, 'config_revision') ?? '1') || 1;
  writeRuntimeMeta(db, 'config_revision', String(currentRev + 1));
}

export function registerDefaultRules(
  hub: Pick<HubService, 'registerRule'>,
  config: GitHubAdapterConfig,
): Array<() => void> {
  const enabledEntries = Object.entries(config.repoMap || {}).filter(([, entry]) => entry?.enabled !== false);
  const mappedRepos = enabledEntries.map(([repo]) => repo);
  const defaultPersona = normalizeOptionalPersonaId(config.defaultPersonaId) ?? undefined;

  const rules: RoutingRule[] = [
    {
      id: 'github.default.notifications-inbox',
      name: 'Account notifications default to zero-token Inbox',
      enabled: true,
      priority: 900,
      match: { source: 'github', excludeBots: true },
      handler: {
        tier: 'inbox-only',
        resolver: 'github-graph',
        sessionPolicy: 'none',
      },
    },
    {
      id: 'github.mapped.mention-or-pinned-triage',
      name: 'Mapped repo @mention, pinned activity, or 👍 reaction delta -> read-only triage',
      enabled: mappedRepos.length > 0,
      priority: 200,
      match: {
        source: 'github',
        type: [
          'github.issue.comment',
          'github.pr.comment',
          'github.pinned.activity',
          'github.reaction.delta',
          'github.notification.mention',
        ],
        repo: mappedRepos,
        excludeBots: true,
      },
      handler: {
        tier: 'triage',
        resolver: 'github-graph',
        sessionPolicy: 'reuse-or-spawn',
        deliveryMode: 'followup',
        skill: 'gh-issue-triage',
        ...(defaultPersona ? { persona: defaultPersona } : {}),
        allowedTools: [
          'session_search',
          'session_event_search',
          'session_event_read',
          'session_trace',
          'gh_stage_reply',
        ],
        allowedSinks: ['github.draft'],
        cooldownSeconds: 900,
        maxWakeups: 3,
      },
    },
    {
      id: 'github.mapped.pr-review-requested',
      name: 'Mapped repo PR review requested -> read-only review + draft/auto-send',
      enabled: mappedRepos.length > 0,
      priority: 150,
      match: {
        source: 'github',
        type: ['github.pr.review_requested', 'github.pr.ready_for_review'],
        repo: mappedRepos,
        excludeBots: true,
      },
      handler: {
        tier: 'review',
        resolver: 'github-graph',
        sessionPolicy: 'ephemeral-review',
        deliveryMode: 'followup',
        skill: 'gh-pr-review',
        ...(defaultPersona ? { persona: defaultPersona } : {}),
        allowedTools: ['session_search', 'session_event_read', 'gh_stage_review', 'gh_stage_reply'],
        allowedSinks: ['github.draft'],
        cooldownSeconds: 900,
        maxWakeups: 5,
      },
    },
    {
      id: 'github.mapped.owner-implement-optin',
      name: 'Verified owner dsh:implement label -> autonomous workstream',
      enabled: mappedRepos.length > 0 && config.ownerLogins.length > 0,
      priority: 100,
      match: {
        source: 'github',
        type: ['github.issue.labeled', 'github.pr.labeled'],
        repo: mappedRepos,
        trustLevel: 'owner',
        excludeBots: true,
      },
      handler: {
        tier: 'autonomous',
        resolver: 'github-graph',
        sessionPolicy: 'reuse-or-spawn',
        deliveryMode: 'followup',
        agentPreset: 'standard',
        ...(defaultPersona ? { persona: defaultPersona } : {}),
        allowedSinks: ['github.draft'],
        ownerLogins: config.ownerLogins,
        requiredLabel: 'dsh:implement',
        cooldownSeconds: 300,
        maxWakeups: 10,
      },
    },
  ];

  for (const [repo, entry] of enabledEntries) {
    const repoPersona = normalizeOptionalPersonaId(entry?.personaId);
    if (!repoPersona) continue;
    rules.push(
      {
        id: `github.repo.${repo}.mention-or-pinned-triage`,
        name: `Repo ${repo} persona override -> triage`,
        enabled: true,
        priority: 190,
        match: {
          source: 'github',
          type: [
            'github.issue.comment',
            'github.pr.comment',
            'github.pinned.activity',
            'github.reaction.delta',
            'github.notification.mention',
          ],
          repo: [repo],
          excludeBots: true,
        },
        handler: {
          tier: 'triage',
          resolver: 'github-graph',
          sessionPolicy: 'reuse-or-spawn',
          deliveryMode: 'followup',
          skill: 'gh-issue-triage',
          persona: repoPersona,
          allowedTools: [
            'session_search',
            'session_event_search',
            'session_event_read',
            'session_trace',
            'gh_stage_reply',
          ],
          allowedSinks: ['github.draft'],
          cooldownSeconds: 900,
          maxWakeups: 3,
        },
      },
      {
        id: `github.repo.${repo}.pr-review-requested`,
        name: `Repo ${repo} persona override -> review`,
        enabled: true,
        priority: 140,
        match: {
          source: 'github',
          type: ['github.pr.review_requested', 'github.pr.ready_for_review'],
          repo: [repo],
          excludeBots: true,
        },
        handler: {
          tier: 'review',
          resolver: 'github-graph',
          sessionPolicy: 'ephemeral-review',
          deliveryMode: 'followup',
          skill: 'gh-pr-review',
          persona: repoPersona,
          allowedTools: ['session_search', 'session_event_read', 'gh_stage_review', 'gh_stage_reply'],
          allowedSinks: ['github.draft'],
          cooldownSeconds: 900,
          maxWakeups: 5,
        },
      },
      {
        id: `github.repo.${repo}.owner-implement-optin`,
        name: `Repo ${repo} persona override -> autonomous`,
        enabled: config.ownerLogins.length > 0,
        priority: 90,
        match: {
          source: 'github',
          type: ['github.issue.labeled', 'github.pr.labeled'],
          repo: [repo],
          trustLevel: 'owner',
          excludeBots: true,
        },
        handler: {
          tier: 'autonomous',
          resolver: 'github-graph',
          sessionPolicy: 'reuse-or-spawn',
          deliveryMode: 'followup',
          agentPreset: 'standard',
          persona: repoPersona,
          allowedSinks: ['github.draft'],
          ownerLogins: config.ownerLogins,
          requiredLabel: 'dsh:implement',
          cooldownSeconds: 300,
          maxWakeups: 10,
        },
      },
    );
  }

  return rules.map((rule) => hub.registerRule(rule));
}

export const GITHUB_BUNDLED_SKILLS: BundledSkillDefinition[] = [
  {
    name: 'gh-issue-triage',
    rank: BUNDLED_SKILL_RANK,
    description: '对 GitHub Issue 变更进行只读分诊，输出结构化四态结论与单一步骤建议。',
    prompt: [
      '你是只读 GitHub Issue 分诊助手。',
      '必须输出结构化结论（4 选 1）：ACTION_REQUIRED | CONFLICT_OR_STALE | OBSOLETE_OR_DUPLICATE | INFO_ONLY。',
      '正文不超过 5 行，并以“下一步：<一个两分钟内可完成的动作>”结尾。',
      '如需回复，请调用 gh_stage_reply（已配置 autoSend 的仓库自动直发并附加自触发标记；其他仓库自动进入草稿箱等待人工确认）。',
    ].join('\n'),
  },
  {
    name: 'gh-pr-review',
    rank: BUNDLED_SKILL_RANK,
    description: '对 GitHub PR 进行只读代码审查并通过 gh_stage_review 输出评审意见。',
    prompt: [
      '你是只读 PR 审查助手。优先检查 Related Context Card 中的 git merge-tree 冲突探针结果；',
      '若已存在与目标分支的冲突，直接输出 CONFLICT_OR_STALE 并调用 gh_stage_reply 提示作者 rebase，跳过耗时的逐行细审。',
      '若无冲突，聚焦正确性、安全边界与测试缺口，调用 gh_stage_review 提交审查（本人 PR 在用户 Token 下自动降级为 COMMENT）。',
    ].join('\n'),
  },
  {
    name: 'gh-conflict-audit',
    rank: BUNDLED_SKILL_RANK,
    description: '核查 PR 与目标分支冲突及历史关联会话决策，按需调用 session_search 拉取过往记录。',
    prompt: [
      '根据 Related Context Card 中的冲突路径、落后提交数与历史 sessionId，仅在需要时调用 session_search / session_event_read 拉取设计上下文。',
      '明确指出冲突根因与受影响文件，给出最小 rebase / 合并修复步骤；如需通知作者，调用 gh_stage_reply。',
    ].join('\n'),
  },
  {
    name: 'gh-demand-eval',
    rank: BUNDLED_SKILL_RANK,
    description: '汇总 Issue 评论、点赞（👍）增量与关联草稿 PR 进展，评估是否达到实现阈值。',
    prompt: [
      '统计本次增量反馈中的真实需求信号、阻塞点、👍 变化与关联 PR 状态，并按需检索历史关联会话。',
      '判断是否达到开始实现的门槛，输出不超过 5 行的明确建议（继续观察 / 补充追问 / 开始实现）以及 1 个具体下一步动作。',
    ].join('\n'),
  },
];

export function registerBundledSkills(ctx: GitHubPluginContext): Array<() => void> {
  const skills =
    typeof ctx.get === 'function'
      ? (ctx.get('skills') as SkillsRegistryLike | undefined)
      : ctx.skills;
  if (!skills?.register) return [];
  return GITHUB_BUNDLED_SKILLS.map((def) => skills.register?.(def)).filter(
    (d): d is () => void => typeof d === 'function',
  );
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function apply(ctx: GitHubPluginContext, rawConfig: RawGitHubAdapterConfig = {}) {
  const hub =
    ctx.hub ??
    ctx.watcher ??
    (typeof ctx.get === 'function' ? ((ctx.get('hub') ?? ctx.get('watcher')) as HubService | undefined) : undefined);
  if (!hub) {
    throw new Error('connector-github requires hub or watcher service on context');
  }

  const db = hub.db ?? null;
  const config = mergePersistedConfig(normalizeConfig(rawConfig), db);
  const controller = new AbortController();
  const logger = (typeof ctx.logger === 'function' ? ctx.logger('connector-github') : ctx.logger) ?? console;
  const fetchImpl = rawConfig.fetchImpl;

  const credentials = createGitHubAuth({
    ctx,
    authConfig: config.auth,
    fetchImpl,
    logger,
  });

  const poller = new GitHubPoller({
    config,
    credentials,
    db,
    fetchImpl,
    logger,
    getConfigRevision: () => hub.configRevision ?? 1,
    onEvent: (event) => hub.ingest(event),
  });

  const resolver = new GitHubGraphResolver({
    ctx: { ...ctx, hub, watcher: hub },
    config,
    credentials,
    db,
  });

  const resolveWardrobe = (): PersonaWardrobe | null => {
    const fromCtx =
      typeof ctx.get === 'function'
        ? (ctx.get('personaWardrobe') as PersonaWardrobe | undefined)
        : ctx.personaWardrobe;
    return fromCtx ?? hub.getWardrobe?.() ?? hub.wardrobe ?? null;
  };

  const sink = createGitHubSink({
    config,
    credentials,
    db,
    getWardrobe: resolveWardrobe,
    fetchImpl,
    onPublished: (meta) => poller.recordSelfPublished(meta),
  });

  let verifyCache: {
    tokenHash: string;
    verifiedAt: number;
    result: GitHubVerifyTokenResult;
  } | null = null;

  async function resolveAuthStatus(forceVerify = false): Promise<GitHubAuthStatusView> {
    const readAuth = await credentials.readSlot('read');
    const actStatus = credentials.hasDedicatedActToken
      ? await credentials.hasDedicatedActToken()
      : { configured: false, login: null };
    const appInfo = credentials.getAppInfo ? await credentials.getAppInfo() : null;

    if (appInfo?.configured && appInfo.botLogin && !config.botLogin) {
      config.botLogin = appInfo.botLogin;
      poller.updateConfig(config);
    }

    const actMode: GitHubAuthStatusView['actMode'] = appInfo?.configured
      ? 'app'
      : actStatus.configured
        ? 'token'
        : readAuth?.token
          ? 'read-fallback'
          : 'none';
    const hasBotToken = Boolean(appInfo?.configured || actStatus.configured);
    const botLogin = appInfo?.configured ? (appInfo.botLogin ?? null) : actStatus.login;

    if (!readAuth?.token) {
      return {
        configured: false,
        source: 'none',
        login: null,
        scopes: [],
        notificationsScopeMissing: true,
        hasBotToken,
        botLogin,
        actMode,
        githubApp: appInfo,
        lastVerifiedAt: null,
        lastError: poller.lastError ?? null,
      };
    }

    const tokenDigest = hashToken(readAuth.token);
    const now = Date.now();
    const cacheValid =
      !forceVerify &&
      verifyCache !== null &&
      verifyCache.tokenHash === tokenDigest &&
      now - verifyCache.verifiedAt < VERIFY_CACHE_TTL_MS;

    let verified: GitHubVerifyTokenResult | null = cacheValid ? verifyCache!.result : null;
    if (!verified && credentials.verifyToken) {
      verified = await credentials.verifyToken(readAuth.token, { signal: controller.signal });
      verifyCache = { tokenHash: tokenDigest, verifiedAt: now, result: verified };
    }

    const readSource: GitHubAuthStatusView['source'] =
      readAuth.source === 'gh-cli' ? 'gh-cli' : 'credentials';

    return {
      configured: true,
      source: readSource,
      login: verified?.login ?? readAuth.login ?? null,
      scopes: verified?.scopes ?? [],
      notificationsScopeMissing: Boolean(
        poller.notificationsScopeMissing || verified?.notificationsScopeMissing,
      ),
      hasBotToken,
      botLogin,
      actMode,
      githubApp: appInfo,
      lastVerifiedAt: verifyCache ? new Date(verifyCache.verifiedAt).toISOString() : null,
      lastError: verified?.ok === false ? (verified.error ?? null) : (poller.lastError ?? null),
    };
  }

  let ruleDisposers = registerDefaultRules(hub, config);

  function refreshRules(): void {
    for (const off of ruleDisposers) {
      try {
        off();
      } catch {
      }
    }
    if (!hub) {
      ruleDisposers = [];
      return;
    }
    ruleDisposers = registerDefaultRules(hub, config);
  }

  const admin: GitHubAdminAdapter = {
    async getConfig(): Promise<GitHubAdminConfigView> {
      const authStatus = await resolveAuthStatus(false);
      return {
        authStatus,
        enableNotifications: config.enableNotifications,
        pollIntervalMs: config.pollIntervalMs,
        pinnedPollIntervalMs: config.pinnedPollIntervalMs,
        autoSendOwners: [...config.autoSendOwners],
        ownerLogins: [...config.ownerLogins],
        botLogin: config.botLogin,
        defaultPersonaId: config.defaultPersonaId,
        repos: repoMapToArray(config.repoMap),
        pinnedItems: pinnedItemsToView(config.pinnedItems),
      };
    },

    async updateConfig(next: GitHubAdminConfigUpdate): Promise<GitHubAdminConfigView> {
      if (typeof next.enableNotifications === 'boolean') {
        config.enableNotifications = next.enableNotifications;
        config.notificationsEnabled = next.enableNotifications;
      }
      if (typeof next.pollIntervalMs === 'number' && Number.isFinite(next.pollIntervalMs)) {
        config.pollIntervalMs = Math.max(15_000, Math.round(next.pollIntervalMs));
      }
      if (typeof next.pinnedPollIntervalMs === 'number' && Number.isFinite(next.pinnedPollIntervalMs)) {
        config.pinnedPollIntervalMs = Math.max(15_000, Math.round(next.pinnedPollIntervalMs));
      }
      if (Array.isArray(next.autoSendOwners)) {
        config.autoSendOwners = normalizeStringList(next.autoSendOwners, []);
      }
      if (Array.isArray(next.ownerLogins)) {
        config.ownerLogins = normalizeStringList(next.ownerLogins, config.ownerLogins);
      }
      if (typeof next.botLogin === 'string') {
        config.botLogin = next.botLogin.trim();
      }
      if (next.defaultPersonaId !== undefined) {
        config.defaultPersonaId = normalizeOptionalPersonaId(next.defaultPersonaId);
      }
      if (Array.isArray(next.repos)) {
        config.repoMap = normalizeRepoMapFromArray(next.repos);
      }
      if (Array.isArray(next.pinnedItems)) {
        config.pinnedItems = normalizePinnedItems(next.pinnedItems);
      }

      persistConfigToDb(db, config);
      poller.updateConfig(config);
      resolver.updateConfig(config);
      sink.updateConfig(config);
      refreshRules();

      return this.getConfig();
    },

    async saveToken(input: GitHubSaveTokenInput): Promise<GitHubSaveTokenResult> {
      if (!credentials.saveToken || !credentials.verifyToken) {
        throw new Error('token_management_unavailable');
      }
      const slot = input.slot === 'act' ? 'act' : 'read';
      const verified = await credentials.verifyToken(input.token, { signal: controller.signal });
      const effectiveLogin = input.login?.trim() || verified.login || undefined;
      const saved = await credentials.saveToken({
        slot,
        token: input.token,
        login: effectiveLogin,
        isBot: slot === 'act' ? input.isBot !== false : Boolean(input.isBot),
      });

      if (slot === 'read') {
        verifyCache = {
          tokenHash: hashToken(input.token.trim()),
          verifiedAt: Date.now(),
          result: verified,
        };
        if (verified.ok && !verified.notificationsScopeMissing) {
          poller.resetNotificationsScopeState();
        }
      } else {
        verifyCache = null;
      }

      const authStatus = await resolveAuthStatus(false);
      return {
        ok: true,
        slot,
        savedTo: saved.savedTo,
        verified,
        authStatus,
      };
    },

    async verifyToken(token?: string): Promise<GitHubVerifyTokenResult> {
      if (!credentials.verifyToken) {
        return {
          ok: false,
          login: null,
          scopes: [],
          notificationsScopeMissing: true,
          error: 'verify_unavailable',
        };
      }
      const result = await credentials.verifyToken(token, { signal: controller.signal });
      if (!token) {
        const current = await credentials.readSlot('read');
        if (current?.token) {
          verifyCache = {
            tokenHash: hashToken(current.token),
            verifiedAt: Date.now(),
            result,
          };
          if (result.ok && !result.notificationsScopeMissing) {
            poller.resetNotificationsScopeState();
          }
        }
      }
      return result;
    },

    async saveApp(input: GitHubAppSaveInput): Promise<GitHubAppSaveResult> {
      if (!credentials.saveApp || !credentials.verifyApp) {
        throw new Error('github_app_management_unavailable');
      }
      const saved = await credentials.saveApp(input);
      const verified = await credentials.verifyApp({
        repo: input.repo,
        signal: controller.signal,
      });
      if (verified.botLogin) {
        config.botLogin = verified.botLogin;
        poller.updateConfig(config);
      }
      const authStatus = await resolveAuthStatus(false);
      return {
        ok: true,
        savedTo: saved.savedTo,
        verified,
        authStatus,
      };
    },

    async verifyApp(opts?: { repo?: string }): Promise<GitHubAppVerifyResult> {
      if (!credentials.verifyApp) {
        return { ok: false, error: 'github_app_management_unavailable' };
      }
      const verified = await credentials.verifyApp({
        repo: opts?.repo,
        signal: controller.signal,
      });
      if (verified.botLogin) {
        config.botLogin = verified.botLogin;
        poller.updateConfig(config);
      }
      return verified;
    },

    async deleteApp(): Promise<{ ok: boolean; authStatus: GitHubAuthStatusView }> {
      if (!credentials.deleteApp) {
        throw new Error('github_app_management_unavailable');
      }
      const prevInfo = credentials.getAppInfo ? await credentials.getAppInfo() : null;
      await credentials.deleteApp();
      if (prevInfo?.botLogin && config.botLogin === prevInfo.botLogin) {
        config.botLogin = '';
        poller.updateConfig(config);
      }
      const authStatus = await resolveAuthStatus(false);
      return { ok: true, authStatus };
    },

    async pollNow(): Promise<{ polled: number; events: number; authStatus?: GitHubAuthStatusView }> {
      const res = await poller.pollOnce({ signal: controller.signal });
      const authStatus = await resolveAuthStatus(false);
      return { ...res, authStatus };
    },

    listRecentEvents(): GitHubRecentEvent[] {
      const memEvents = poller.listRecentEvents();
      const byId = new Map<string, GitHubRecentEvent>();
      for (const ev of memEvents) {
        byId.set(ev.id, ev);
      }
      try {
        const inboxItems = hub.listInbox?.({ source: 'github', limit: 100 }) ?? [];
        for (const item of inboxItems) {
          const eventId = item.eventId || item.id;
          if (byId.has(eventId) || byId.has(item.id)) continue;
          const entityKey = item.entityKey || null;
          const stripped = (entityKey ?? '').replace(/^github:/i, '');
          const match = /^([^/\s]+\/[^#\s]+)#(\d+)$/.exec(stripped);
          const repo = match ? match[1] : null;
          const num = match ? Number(match[2]) : null;
          byId.set(eventId, {
            id: eventId,
            source: item.source || 'github',
            type: item.type || 'github.event',
            repo,
            number: Number.isInteger(num) ? num : null,
            entityKey,
            threadKey: entityKey || (repo && num ? `github:${repo}#${num}` : item.id),
            actor: item.actor || 'github',
            summary: item.summary || '',
            url: item.rawUrl ?? null,
            occurredAt: item.occurredAt || item.createdAt,
            ingestedAt: item.createdAt,
            payload: {},
          });
        }
      } catch {
      }
      return [...byId.values()]
        .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
        .slice(0, 100);
    },
  };

  let stageToolDisposers: Array<() => void> = [];
  try {
    stageToolDisposers = registerGitHubStageTools(
      { ...ctx, hub, watcher: hub },
      { config, sinkId: sink.id, getWardrobe: resolveWardrobe },
    );
  } catch {
    stageToolDisposers = [];
  }
  let skillDisposers: Array<() => void> = [];
  try {
    skillDisposers = registerBundledSkills(ctx);
  } catch {
    skillDisposers = [];
  }

  let unmountHttp: () => void = () => {};
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      const disposeRoute = mountGitHubConnectorHttpRoutes(webCtx, admin, { getWardrobe: resolveWardrobe });
      webCtx.effect?.(() => disposeRoute);
    });
  } else {
    unmountHttp = mountGitHubConnectorHttpRoutes(ctx, admin, { getWardrobe: resolveWardrobe });
  }

  const vaultProvider = createGitHubVaultProvider({
    db,
    hub,
    getConfig: () => config,
    getWardrobe: resolveWardrobe,
    listSnapshots: () => poller.listIssueSnapshots(),
    listRecentEvents: () => poller.listRecentEvents(),
  });
  const vaultDisposer = hub.registerVaultProvider?.(vaultProvider);

  const connectorDisposer = hub.registerConnector?.({
    id: 'github',
    label: 'GitHub',
    kind: 'connector',
    panelId: 'dsh-connector-github-panel',
    panelLabel: 'GitHub',
    health: () => {
      const h = poller.asWatchSource().health();
      return {
        ok: h.ok,
        detail: h.lastError ?? (h.notificationsScopeMissing ? '缺少 notifications 权限' : '运行正常'),
      };
    },
  });

  const adminDisposer = hub.registerGitHubAdmin?.(admin);

  const disposers = [
    hub.registerSource(poller.asWatchSource()),
    hub.registerResolver(resolver.asEntityResolver()),
    hub.registerSink(sink),
    vaultDisposer,
    connectorDisposer,
    adminDisposer,
    ...stageToolDisposers,
    ...skillDisposers,
  ].filter((d): d is () => void => typeof d === 'function');

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    controller.abort();
    poller.stop();
    unmountHttp();
    for (const off of [...ruleDisposers, ...disposers]) {
      try {
        off();
      } catch {
        void 0;
      }
    }
  };

  poller.start(controller.signal);
  ctx.on?.('dispose', dispose);
  ctx.effect?.(() => dispose);

  return { config, credentials, poller, resolver, sink, admin, vaultProvider, dispose };
}

export {
  buildDshRecordKeys,
  createGitHubAppJwt,
  createGitHubAuth,
  isMissingNotificationsScope,
  MISSING_NOTIFICATIONS_SCOPE_HINT,
  resolveDefaultCredentialsPath,
  withFileLock,
  writeFileAtomic,
  extractLinkedIssues,
  GitHubPoller,
  MAX_RECENT_EVENTS,
  GitHubGraphResolver,
  MAX_CONTEXT_CARD_CHARS,
  createGitHubSink,
  registerGitHubStageTools,
  shouldAutoSend,
  appendSelfTriggerMarker,
  hasSelfTriggerMarker,
  checkLocalOwnerRequest,
  createGitHubConnectorHttpHandler,
  mountGitHubConnectorHttpRoutes,
  createGitHubVaultProvider,
  resolveGitHubOutboundTargetCircle,
  resolveGitHubRepoVaultVisibility,
};
export type { GitHubRecentEvent, GitHubVaultProviderOptions, GitHubVisibilityOptions };
