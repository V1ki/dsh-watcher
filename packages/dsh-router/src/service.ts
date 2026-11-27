import { randomUUID } from 'node:crypto';
import { PUBLIC_TAINT_WARNING_TEXT } from '@local/dsh-hub';
import type {
  AdminWechatHandleResult,
  AdminWechatMessage,
  HubService,
  IngestResult,
  NormalizedEvent,
  SessionVaultTier,
  ThreadLifecycleEvent,
  ThreadSubscription,
  ToolExecutionContext,
  TrustLevel,
  VaultVisibility,
} from '@local/dsh-hub/contracts';
import {
  RouterApprovals,
  type RouterApprovalExecutionLike,
  type RouterApprovalRequestLike,
} from './approvals.js';
import type {
  AttentionDecision,
  AttentionPolicy,
  AttentionPreviewInput,
  NotifyChannel,
  RouterDecisionRecord,
  RouterNotificationRecord,
  RouterStatsView,
  RouterStatusView,
  WorkerReportInput,
} from './contracts.js';
import type { ListDecisionsFilter, ListNotificationsFilter, RouterDb } from './db.js';
import { OwnerSessionBridge, type OwnerSessionContextLike } from './owner-session.js';
import {
  DEFAULT_ATTENTION_POLICY,
  computeNextWorkStartIso,
  isWebActive,
  normalizeAttentionPolicy,
  resolveAttentionDestination,
} from './policy.js';
import {
  isReadOnlyBash,
  needsOperationConfirmation,
  taskReusable,
  withinWorkspace,
} from './task-permissions.js';
import { triageEvent, type TriageLlmLike, type TriageLoggerLike } from './triage.js';
import {
  dispatchWorker,
  registerRouterTools,
  resolveWorkerPrincipalSpec,
  sendWorkerFollowup,
  type RouterSendToTaskToolInput,
  type RouterTasksToolInput,
} from './worker-dispatcher.js';

const POLICY_META_KEY = 'attention_policy';
const OWNER_TURN_OVERRIDE_TTL_MS = 15 * 60_000;
const BATCH_SUMMARY_THRESHOLD = 3;

const LIST_COMMANDS = new Set(['列表', '还有啥', '在忙啥', '任务', 'list']);

const OWNER_SAFE_READ_TOOLS = new Set([
  'read',
  'read_file',
  'read_image',
  'grep',
  'glob',
  'find',
  'ls',
  'list_dir',
  'vault_search',
  'vault_context',
  'router_tasks',
  'router_send_to_task',
  'watch_list',
  'watch_update',
  'watch_cancel',
  'watch_stage_draft',
  'github_stage_reply',
  'github_stage_review',
  'wxarc_status',
  'wxarc_messages',
  'wxarc_targets',
  'wxarc_nas_search',
  'wxarc_sticker_search',
  'watcher_memo_add',
  'watcher_memo_list',
  'watcher_memo_cancel',
  'web_search',
  'ask_user_question',
  'job_output',
  'todoread',
  'todowrite',
  'skill',
]);

function extractShortId(decision: Pick<RouterDecisionRecord, 'id' | 'threadKey'>): string {
  const match = /#(\d+)\b/.exec(decision.threadKey);
  if (match) return match[1];
  return decision.id.slice(0, 6);
}

function shortLine(text: string, maxLen = 68): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLen) return compact;
  return `${compact.slice(0, Math.max(1, maxLen - 1))}…`;
}

function normalizeAdminCommand(text: string): string {
  return text.trim().toLowerCase().replace(/[?？!！。.\s]+$/g, '');
}

function parsePrefixTaskRef(rawText: string): { ref: string; rest: string } | null {
  const bracketMatch = /^\[#([a-zA-Z0-9_-]{1,36})\](?:[\s:：,，]*([\s\S]*))?$/.exec(rawText);
  if (bracketMatch) {
    return { ref: bracketMatch[1], rest: (bracketMatch[2] ?? '').trim() };
  }
  const hashNumMatch = /^#(\d+)(?:[\s:：,，]+([\s\S]*))?$/.exec(rawText);
  if (hashNumMatch) {
    return { ref: hashNumMatch[1], rest: (hashNumMatch[2] ?? '').trim() };
  }
  const hashIdMatch = /^#([a-zA-Z0-9_-]{4,36})(?:[\s:：,，]+([\s\S]*))?$/.exec(rawText);
  if (hashIdMatch) {
    return { ref: hashIdMatch[1], rest: (hashIdMatch[2] ?? '').trim() };
  }
  return null;
}

function parseQuotedTaskRef(quotedText?: string): string | null {
  if (!quotedText?.trim()) return null;
  const match = /\[#([a-zA-Z0-9_-]{1,36})\]/.exec(quotedText);
  return match ? match[1] : null;
}

export interface RouterServiceContext extends OwnerSessionContextLike {
  llm?: TriageLlmLike;
  logger?: TriageLoggerLike;
}

export interface RouterRuntimeOptions {
  hub: HubService;
  db: RouterDb;
  ctx?: RouterServiceContext;
  llm?: TriageLlmLike | null;
  now?: () => Date;
  homeDir?: string;
  ownerDebounceMs?: number;
  approvalTtlMs?: number;
  initialPolicy?: Partial<AttentionPolicy>;
}

export interface SimulateEventInput {
  source?: string;
  type?: string;
  threadKey?: string;
  actor?: string;
  isBot?: boolean;
  trustLevel?: TrustLevel;
  summary?: string;
  urgent?: boolean;
  rawUrl?: string;
  payload?: Record<string, unknown>;
}

export interface SimulateEventResult {
  result: IngestResult;
  decision: RouterDecisionRecord | null;
}

interface RouteDeliveryOutcome {
  attention: AttentionDecision;
  notification: RouterNotificationRecord | null;
  deferred: boolean;
}

export class RouterRuntime {
  readonly hub: HubService;
  readonly db: RouterDb;
  readonly approvals: RouterApprovals;
  readonly ownerSession: OwnerSessionBridge;
  private readonly ctx?: RouterServiceContext;
  private readonly llmOverride?: TriageLlmLike | null;
  private readonly nowFn: () => Date;
  private readonly homeDir?: string;
  private readonly disposers: Array<() => void> = [];
  private policy: AttentionPolicy;
  private disposed = false;

  constructor(options: RouterRuntimeOptions) {
    this.hub = options.hub;
    this.db = options.db;
    this.ctx = options.ctx;
    this.llmOverride = options.llm;
    this.nowFn = options.now ?? (() => new Date());
    this.homeDir = options.homeDir;
    this.policy = this.loadInitialPolicy(options.initialPolicy);

    this.approvals = new RouterApprovals({
      db: this.db,
      hub: this.hub,
      resolveOwnerId: () => this.resolveWechatTarget(),
      now: () => this.nowFn().getTime(),
      ttlMs: options.approvalTtlMs,
    });

    this.ownerSession = new OwnerSessionBridge({
      hub: this.hub,
      db: this.db,
      ctx: this.ctx,
      homeDir: this.homeDir,
      debounceMs: options.ownerDebounceMs,
      resolveOwnerTarget: () => this.resolveWechatTarget(),
      onTurnEnded: ({ runId }) => {
        this.approvals.revoke(runId);
      },
    });

    this.warmupWorkerPrincipalsSync();
    void this.warmupWorkerPrincipalsAsync();

    const offUnclaimed = this.hub.onUnclaimedEvent((event, meta) =>
      this.handleUnclaimedEvent(event, meta),
    );
    this.disposers.push(offUnclaimed);

    if (typeof this.hub.onThreadLifecycle === 'function') {
      const offLifecycle = this.hub.onThreadLifecycle((lifecycle) =>
        this.handleThreadLifecycle(lifecycle),
      );
      this.disposers.push(offLifecycle);
    }

    if (typeof this.hub.guard?.registerGuard === 'function') {
      const offTurnResetGuard = this.hub.guard.registerGuard({
        name: 'router-turn-override-reset',
        beforeEnterRoom: (guardCtx) => {
          const incoming = guardCtx.event;
          if (incoming && incoming.trustLevel !== 'owner') {
            const sub = this.hub.resolveSubscription(incoming.source, incoming.threadKey);
            if (sub?.sessionId) {
              this.hub.clearSessionTurnOverride?.(sub.sessionId);
            }
          }
          return { allow: true };
        },
      });
      this.disposers.push(offTurnResetGuard);
    }

    if (typeof this.hub.registerConnector === 'function') {
      const offConnector = this.hub.registerConnector({
        id: 'router',
        label: 'Router 大脑',
        kind: 'trigger',
        panelId: 'dsh-router-panel',
        panelLabel: 'Router',
        health: () => {
          const st = this.getStatus();
          return {
            ok: true,
            detail: st.enabled
              ? `${st.currentSlot} -> ${st.currentDestination} (subs=${st.activeSubscriptions})`
              : 'disabled',
          };
        },
      });
      this.disposers.push(offConnector);
    }

    const offTools = registerRouterTools(this.ctx, {
      hub: this.hub,
      submitWorkerReport: (report) => this.submitWorkerReport(report),
      listTasks: (input) => this.handleListTasksTool(input),
      sendToTask: (input) => this.handleSendToTaskTool(input),
    });
    this.disposers.push(offTools);

    this.mountExecutionGuards();

    if (typeof this.hub.registerAdminWechatHandler === 'function') {
      const offAdminWechat = this.hub.registerAdminWechatHandler((msg) =>
        this.handleAdminWechatMessage(msg),
      );
      this.disposers.push(offAdminWechat);
    }
  }

  private loadInitialPolicy(override?: Partial<AttentionPolicy>): AttentionPolicy {
    const raw = this.db.getMeta(POLICY_META_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<AttentionPolicy>;
        return normalizeAttentionPolicy({ ...DEFAULT_ATTENTION_POLICY, ...parsed, ...(override ?? {}) });
      } catch {
      }
    }
    const normalized = normalizeAttentionPolicy({ ...DEFAULT_ATTENTION_POLICY, ...(override ?? {}) });
    this.db.setMeta(POLICY_META_KEY, JSON.stringify(normalized));
    return normalized;
  }

  private savePolicy(next: AttentionPolicy): AttentionPolicy {
    this.policy = normalizeAttentionPolicy(next);
    this.db.setMeta(POLICY_META_KEY, JSON.stringify(this.policy));
    return this.getPolicy();
  }

  private resolveLlm(): TriageLlmLike | null {
    if (this.llmOverride !== undefined) return this.llmOverride;
    if (!this.ctx) return null;
    if (typeof this.ctx.get === 'function') {
      return (this.ctx.get('llm') as TriageLlmLike | undefined) ?? null;
    }
    return this.ctx.llm ?? null;
  }

  private resolveLogger(): TriageLoggerLike | null {
    if (!this.ctx) return null;
    if (typeof this.ctx.get === 'function') {
      const fromGet = this.ctx.get('logger') as TriageLoggerLike | undefined;
      if (fromGet) return fromGet;
    }
    return this.ctx.logger ?? null;
  }

  private async resolveWechatTarget(): Promise<string> {
    const configured = this.policy.wechatTarget?.trim() ?? '';
    if (configured && configured !== 'filehelper') {
      return configured;
    }
    try {
      const status = await this.hub.getWechatTransport?.()?.status();
      const controllerId = status?.controllerId?.trim();
      if (controllerId) {
        return controllerId;
      }
    } catch {
    }
    return configured || 'filehelper';
  }

  private inferHistoricalPrincipal(decision: RouterDecisionRecord): {
    tier: SessionVaultTier;
    trustLevel: TrustLevel;
    targetCircle: VaultVisibility;
    repoName: string | null;
  } {
    const sourceLower = decision.source.trim().toLowerCase();
    const normalizedThreadKey =
      sourceLower === 'github'
        ? decision.threadKey.trim().replace(/^github:/i, '')
        : decision.threadKey.trim();
    const hashIdx = normalizedThreadKey.indexOf('#');
    const repoCandidate =
      hashIdx > 0 ? normalizedThreadKey.slice(0, hashIdx) : normalizedThreadKey;
    const repoName =
      sourceLower === 'github' && /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repoCandidate)
        ? repoCandidate
        : null;
    const isWorkSource =
      sourceLower === 'dingtalk' ||
      sourceLower.startsWith('dingtalk') ||
      sourceLower === 'feishu' ||
      sourceLower === 'lark' ||
      sourceLower === 'jira' ||
      sourceLower === 'linear' ||
      sourceLower === 'slack' ||
      sourceLower === 'work';
    const targetCircle: VaultVisibility =
      decision.targetCircle ?? (sourceLower === 'github' ? 'external' : isWorkSource ? 'work' : 'external');
    const trustLevel: TrustLevel = decision.trustLevel ?? 'triage';
    const tier: SessionVaultTier =
      trustLevel === 'owner' ? 3 : targetCircle === 'work' || isWorkSource ? 2 : 1;
    return { tier, trustLevel, targetCircle, repoName };
  }

  private warmupWorkerPrincipalsSync(): void {
    if (typeof this.hub.registerSessionPrincipal !== 'function') return;
    const rows = this.db.listDecisionsWithWorkerSession();
    const seen = new Set<string>();
    for (const decision of rows) {
      const sid = decision.workerSessionId?.trim();
      if (!sid || seen.has(sid)) continue;
      seen.add(sid);
      const spec = this.inferHistoricalPrincipal(decision);
      this.hub.registerSessionPrincipal({
        sessionId: sid,
        role: 'worker',
        tier: spec.tier,
        trustLevel: spec.trustLevel,
        boundSource: decision.source,
        boundThreadKey: decision.threadKey,
        boundDecisionId: decision.id,
        boundRepo: spec.repoName,
        targetCircle: spec.targetCircle,
      });
    }
  }

  private async warmupWorkerPrincipalsAsync(): Promise<void> {
    if (this.disposed || typeof this.hub.registerSessionPrincipal !== 'function') return;
    const rows = this.db.listDecisionsWithWorkerSession();
    const seen = new Set<string>();
    for (const decision of rows) {
      if (this.disposed) return;
      const sid = decision.workerSessionId?.trim();
      if (!sid || seen.has(sid)) continue;
      seen.add(sid);
      try {
        const spec = await resolveWorkerPrincipalSpec(this.hub, {
          source: decision.source,
          threadKey: decision.threadKey,
          actor: decision.actor,
          trustLevel: decision.trustLevel ?? undefined,
          targetCircleHint: decision.targetCircle ?? undefined,
        });
        this.hub.registerSessionPrincipal({
          sessionId: sid,
          role: 'worker',
          tier: spec.tier,
          trustLevel: spec.trustLevel,
          boundSource: decision.source,
          boundThreadKey: decision.threadKey,
          boundDecisionId: decision.id,
          boundRepo: spec.repoName,
          targetCircle: spec.targetCircle,
        });
      } catch {
      }
    }
  }

  private handleThreadLifecycle(lifecycle: ThreadLifecycleEvent): void {
    if (this.disposed) return;
    if (
      lifecycle.state !== 'closed' &&
      lifecycle.state !== 'merged' &&
      lifecycle.state !== 'ended'
    ) {
      return;
    }
    const nowIso = this.nowFn().toISOString();
    const result = this.db.resolveDecisionsByThread(
      lifecycle.source,
      lifecycle.threadKey,
      nowIso,
    );
    for (const workerSid of result.workerSessionIds) {
      this.hub.clearSessionTurnOverride?.(workerSid);
    }
    if (lifecycle.subscription?.sessionId) {
      this.hub.clearSessionTurnOverride?.(lifecycle.subscription.sessionId);
    }
  }

  private mountExecutionGuards(): void {
    if (typeof this.ctx?.on !== 'function') return;

    const offPre = this.ctx.on(
      'tools/pre-execute',
      async (
        exec: RouterApprovalExecutionLike & ToolExecutionContext,
        next: () => Promise<{ kind: string; reason?: string }>,
      ) => this.handlePreExecuteTool(exec, next),
    );
    if (typeof offPre === 'function') this.disposers.push(offPre as () => void);

    const offResult = this.ctx.on(
      'tools/result',
      (exec: RouterApprovalExecutionLike) => {
        this.approvals.release(exec);
      },
    );
    if (typeof offResult === 'function') this.disposers.push(offResult as () => void);

    const offApproval = this.ctx.on(
      'approval/request',
      (req: RouterApprovalRequestLike, next: () => Promise<string>) => {
        if (!req?.agent?.id) return next();
        const principal = this.hub.resolveSessionPrincipal?.({ agent: req.agent });
        if (!principal || principal.role !== 'owner_session') {
          return next();
        }
        const rootId = principal.rootSessionId ?? principal.sessionId ?? req.agent.id;
        const runId = this.ownerSession.getActiveRunId() ?? `owner:${rootId}`;
        return this.approvals.request(req, next, { id: runId });
      },
      { prepend: true },
    );
    if (typeof offApproval === 'function') this.disposers.push(offApproval as () => void);

    const offInbox = this.ctx.on(
      'agent/inbox/inserted',
      (payloadArg: Record<string, unknown> | undefined) => {
        const payload = payloadArg ?? {};
        const agentObj = payload.agent as { id?: string } | undefined;
        const sessionId =
          agentObj?.id ?? (typeof payload.sessionId === 'string' ? payload.sessionId : '');
        if (!sessionId) return;
        const principal = this.hub.getSessionPrincipal?.(sessionId);
        if (!principal || principal.role !== 'worker') return;
        const message = (payload.message ?? payload.item) as Record<string, unknown> | undefined;
        const source = message?.source as { kind?: string; source?: string; trust?: string } | undefined;
        const isOwnerInitiated =
          (source?.kind === 'dsh-router:worker' &&
            (source.source === 'wechat-admin' || source.source === 'owner-bridge')) ||
          source?.trust === 'owner';
        if (!isOwnerInitiated) {
          this.hub.clearSessionTurnOverride?.(sessionId);
        }
      },
    );
    if (typeof offInbox === 'function') this.disposers.push(offInbox as () => void);
  }

  private async handlePreExecuteTool(
    exec: RouterApprovalExecutionLike & ToolExecutionContext,
    next: () => Promise<{ kind: string; reason?: string }>,
  ): Promise<{ kind: string; reason?: string }> {
    const principal = this.hub.resolveSessionPrincipal?.(exec);
    if (!principal || (principal.role !== 'owner_session' && principal.role !== 'worker')) {
      return next();
    }
    const rootId = principal.rootSessionId ?? principal.sessionId ?? '';

    if (principal.role === 'worker') {
      const isTainted =
        principal.tainted || (rootId ? this.hub.isSessionTainted?.(rootId) === true : false);
      if (isTainted) {
        if (exec.name === 'web_fetch' || exec.name === 'web_search') {
          return {
            kind: 'deny',
            reason: '后台任务会话已读取内部/私人记录（tainted），禁止调用外部联网工具（web_fetch / web_search）。',
          };
        }
        if (exec.arguments?.sandbox_permissions === 'require_escalated') {
          return {
            kind: 'deny',
            reason: '后台任务会话已读取内部/私人记录（tainted），禁止申请沙箱提权（require_escalated）。',
          };
        }
      }
      return next();
    }

    this.approvals.capture(exec);
    const runId = this.ownerSession.getActiveRunId() ?? `owner:${rootId}`;
    const run = { id: runId };

    if (exec.name === 'wxarc_proactive_send') {
      this.approvals.eligible(exec, false);
      return {
        kind: 'ask',
        reason: '跨群或主动发送微信消息需要主人微信确认码。',
      };
    }

    if (exec.name === 'web_fetch') {
      const turnPrivateRead =
        principal.turnPrivateRead || (rootId ? this.hub.isTurnPrivateRead?.(rootId) === true : false);
      if (turnPrivateRead) {
        this.approvals.eligible(exec, false);
        return {
          kind: 'ask',
          reason: '本轮已读取内部/私人记录，调用 web_fetch 访问外部链接需要主人微信确认码。',
        };
      }
      return next();
    }

    if (exec.name === 'bash') {
      const command = exec.arguments?.command;
      if (
        needsOperationConfirmation(exec) ||
        exec.arguments?.sandbox_permissions === 'require_escalated'
      ) {
        this.approvals.eligible(exec, false);
        return {
          kind: 'ask',
          reason: '涉及删除、安装、提权或系统变更的终端命令需要主人微信确认码。',
        };
      }
      if (isReadOnlyBash(command, exec.arguments)) {
        return { kind: 'allow' };
      }
      const base = await next();
      if (base.kind === 'allow') {
        return base;
      }
      if (base.kind === 'ask') {
        this.approvals.eligible(exec, true);
        if (this.approvals.allows(exec, run)) {
          return { kind: 'allow' };
        }
      }
      return base;
    }

    if (exec.name === 'write' || exec.name === 'edit') {
      const targetPath =
        exec.arguments?.file_path ?? exec.arguments?.path ?? exec.arguments?.target_file;
      if (withinWorkspace(this.ownerSession.workspacePath, targetPath)) {
        return { kind: 'allow' };
      }
      this.approvals.eligible(exec, false);
      return {
        kind: 'ask',
        reason: '写入或编辑个人工作区外的文件需要主人微信确认码。',
      };
    }

    if (OWNER_SAFE_READ_TOOLS.has(exec.name)) {
      return { kind: 'allow' };
    }

    const baseDecision = await next();
    if (baseDecision.kind === 'allow') {
      return baseDecision;
    }
    if (baseDecision.kind === 'ask') {
      this.approvals.eligible(exec, taskReusable(exec));
      if (this.approvals.allows(exec, run)) {
        return { kind: 'allow' };
      }
    }
    return baseDecision;
  }

  private listActiveDecisions(limit = 20): RouterDecisionRecord[] {
    const all = this.db.listDecisions({ limit: Math.max(limit * 3, 60) });
    return all
      .filter((d) => d.status !== 'resolved' && d.status !== 'filtered')
      .slice(0, limit);
  }

  private listQueuedDecisions(excludeId?: string, limit = 5): RouterDecisionRecord[] {
    const seen = new Set<string>();
    if (excludeId) seen.add(excludeId);
    const queued: RouterDecisionRecord[] = [];

    const deferredNotifs = this.db.listNotifications({ status: 'deferred', limit: 200, order: 'asc' });
    for (const notif of deferredNotifs) {
      if (seen.has(notif.decisionId)) continue;
      const decision = this.db.getDecision(notif.decisionId);
      if (!decision || decision.status === 'resolved' || decision.status === 'filtered') continue;
      seen.add(decision.id);
      queued.push(decision);
      if (queued.length >= limit) return queued;
    }

    const deferredDecisions = this.db.listDecisions({ status: 'deferred', limit: 50, order: 'asc' });
    for (const decision of deferredDecisions) {
      if (seen.has(decision.id)) continue;
      seen.add(decision.id);
      queued.push(decision);
      if (queued.length >= limit) return queued;
    }

    return queued;
  }

  private handleListTasksTool(input: RouterTasksToolInput): Record<string, unknown> {
    const limit = input.limit ?? 20;
    const decisions =
      input.status === 'all'
        ? this.db.listDecisions({ limit })
        : this.listActiveDecisions(limit);
    const deferredNotifs = this.db.listNotifications({ status: 'deferred', limit: 100, order: 'asc' });
    const pendingDrafts = this.hub.listDrafts({ status: 'pending_approval' });
    const pendingApprovals = this.approvals.listPending();

    return {
      ok: true,
      tasks: decisions.map((d) => ({
        shortId: extractShortId(d),
        id: d.id,
        source: d.source,
        threadKey: d.threadKey,
        status: d.status,
        level: d.level,
        summary: d.summary,
        question: d.question,
        options: d.options,
        draftText: d.draftText ?? null,
        hasWorker: Boolean(d.workerSessionId),
        workerSessionId: d.workerSessionId,
        tainted: Boolean(d.workerSessionId && this.hub.isSessionTainted?.(d.workerSessionId)),
        rawUrl: d.rawUrl,
        updatedAt: d.updatedAt,
      })),
      deferredCount: deferredNotifs.length,
      pendingDrafts: pendingDrafts.map((dr) => ({
        id: dr.id,
        sinkId: dr.sinkId,
        action: dr.action,
        previewText: dr.previewText,
        createdAt: dr.createdAt,
      })),
      pendingApprovals: pendingApprovals.map((ap) => ({
        code: ap.code,
        tool: ap.tool,
        expiresAt: new Date(ap.expires_at).toISOString(),
      })),
    };
  }

  private async handleSendToTaskTool(
    input: RouterSendToTaskToolInput,
  ): Promise<Record<string, unknown>> {
    const action = input.action ?? 'message';
    if (action === 'approve_draft') {
      if (!input.draftId) {
        throw new Error('router_send_to_task requires draftId for approve_draft');
      }
      const res = await this.hub.approveDraft(input.draftId);
      return { ok: true, action, draftId: input.draftId, result: res };
    }
    if (action === 'discard_draft') {
      if (!input.draftId) {
        throw new Error('router_send_to_task requires draftId for discard_draft');
      }
      await this.hub.discardDraft(input.draftId, input.reason);
      return { ok: true, action, draftId: input.draftId, discarded: true };
    }

    const cleanRef = (input.taskRef ?? '').replace(/^\[?#?/, '').replace(/\]$/, '').trim();
    if (!cleanRef) {
      throw new Error('router_send_to_task requires taskRef');
    }
    const target = this.findDecisionByRef(cleanRef);
    if (!target) {
      throw new Error(`decision_not_found:${cleanRef}`);
    }

    if (action === 'resolve') {
      const nowIso = this.nowFn().toISOString();
      this.db.upsertDecision({ ...target, status: 'resolved', updatedAt: nowIso });
      this.markDecisionDeferredNotifications(target.id, 'read', nowIso);
      if (target.workerSessionId) {
        this.hub.clearSessionTurnOverride?.(target.workerSessionId);
      }
      return { ok: true, action, decisionId: target.id, shortId: extractShortId(target) };
    }

    if (!input.message?.trim()) {
      throw new Error('router_send_to_task requires non-empty message');
    }
    if (!target.workerSessionId) {
      return {
        ok: false,
        decisionId: target.id,
        shortId: extractShortId(target),
        error: 'no_worker_session',
      };
    }

    this.hub.setSessionTurnOverride?.(target.workerSessionId, 3, OWNER_TURN_OVERRIDE_TTL_MS);
    const shortId = extractShortId(target);
    const text = [
      `[主人个人会话转达][#${shortId}]`,
      `decisionId: ${target.id}`,
      `threadKey: ${target.threadKey}`,
      `主人指示: ${input.message.trim()}`,
      '',
      '请按主人指示处理，完成后调用 `router_report_result` 回报精炼结论。',
    ].join('\n');
    const delivered = await sendWorkerFollowup(this.ctx, target.workerSessionId, text, {
      decisionId: target.id,
      source: 'owner-bridge',
      trust: 'owner',
    });
    return {
      ok: delivered,
      action,
      decisionId: target.id,
      shortId,
      workerSessionId: target.workerSessionId,
      delivered,
    };
  }

  private shouldShowPublicTaintWarning(decision: RouterDecisionRecord): boolean {
    if (!decision.draftText?.trim()) return false;
    const workerSessionId = decision.workerSessionId?.trim();
    if (!workerSessionId) return false;
    if (this.hub.isSessionTainted?.(workerSessionId) !== true) return false;
    const principalCircle = this.hub.getSessionPrincipal?.(workerSessionId)?.targetCircle ?? null;
    const effectiveCircle =
      principalCircle ??
      decision.targetCircle ??
      (decision.source.trim().toLowerCase() === 'github' ? 'external' : null);
    return effectiveCircle === 'external';
  }

  private findDecisionByRef(ref: string): RouterDecisionRecord | null {
    const lowerRef = ref.trim().toLowerCase();
    if (!lowerRef) return null;
    const decisions = this.db.listDecisions({ limit: 200 });
    let exactFallback: RouterDecisionRecord | null = null;
    let prefixActive: RouterDecisionRecord | null = null;
    let prefixFallback: RouterDecisionRecord | null = null;
    for (const decision of decisions) {
      const shortId = extractShortId(decision).toLowerCase();
      const isActive = decision.status !== 'resolved' && decision.status !== 'filtered';
      if (shortId === lowerRef) {
        if (isActive) return decision;
        if (!exactFallback) exactFallback = decision;
        continue;
      }
      if (decision.id.toLowerCase().startsWith(lowerRef)) {
        if (isActive && !prefixActive) {
          prefixActive = decision;
        } else if (!isActive && !prefixFallback) {
          prefixFallback = decision;
        }
      }
    }
    return exactFallback ?? prefixActive ?? prefixFallback;
  }

  private markDecisionDeferredNotifications(
    decisionId: string,
    status: RouterNotificationRecord['status'],
    nowIso: string,
    channel?: NotifyChannel,
    target?: string,
  ): void {
    const notifs = this.db.listNotifications({ decisionId, status: 'deferred', limit: 50 });
    for (const notif of notifs) {
      this.db.upsertNotification({
        ...notif,
        channel: channel ?? notif.channel,
        target: target ?? notif.target,
        status,
        dueAt: status === 'deferred' ? notif.dueAt : null,
        updatedAt: nowIso,
      });
    }
  }

  private async forwardAdminReplyToWorker(
    target: RouterDecisionRecord,
    userText: string,
    msg: AdminWechatMessage,
  ): Promise<AdminWechatHandleResult> {
    const tag = `[#${extractShortId(target)}]`;
    if (!target.workerSessionId) {
      return {
        handled: true,
        replyText: `${tag} 这条目前没有后台处理会话，可以去网页端点一下派发再继续。`,
      };
    }

    const lines: string[] = [
      `[微信回复]${tag}`,
      `decisionId: ${target.id}`,
      `threadKey: ${target.threadKey}`,
    ];
    if (msg.quotedText?.trim()) {
      lines.push(`引用上下文: ${msg.quotedText.trim()}`);
    }
    lines.push(
      `管理员原话: ${userText}`,
      '',
      '管理员在微信里回复了你，请用大白话接着聊/改：',
      '- `conclusion` 严格控制在 200 字以内，只说结论、风险和需要管理员拍板的点，不要背函数名和代码流水账；',
      '- 若需拟发 GitHub 评论填 `draftText`，像真人维护者一样 3–6 句话说完（一般不超过 500–600 字符），只给判断和需要改的点，不要逐行复述作者代码，不要写带小标题的评审长文；',
      '- 注意：`router_report_result(draftText)` 仅用于给管理员在微信审阅确认，不会自动发到 GitHub；若管理员已明确同意对外发送，请直接调用 GitHub 写入工具发送后再汇报结果；',
      '- 改界面请截一张实际运行图填 `imagePath`；处理完调用 `router_report_result` 回他微信。',
    );

    this.hub.setSessionTurnOverride?.(target.workerSessionId, 3, OWNER_TURN_OVERRIDE_TTL_MS);
    const ok = await sendWorkerFollowup(this.ctx, target.workerSessionId, lines.join('\n'), {
      decisionId: target.id,
      source: 'wechat-admin',
      trust: 'owner',
      senderId: msg.senderId,
      session: msg.session,
    });
    if (!ok) {
      return {
        handled: true,
        replyText: `${tag} 刚才没连上这条任务的处理会话，稍后再试一下或者去网页端看看。`,
      };
    }
    return { handled: true };
  }

  async handleAdminWechatMessage(msg: AdminWechatMessage): Promise<AdminWechatHandleResult> {
    const rawText = (msg.text ?? '').trim();
    const hasMultimodal = Boolean(
      msg.imagePath?.trim() ||
        msg.voiceTranscript?.trim() ||
        msg.articleSummary?.trim() ||
        (Array.isArray(msg.mediaPaths) && msg.mediaPaths.some((p) => p.trim())),
    );
    if (!rawText && !hasMultimodal) {
      return { handled: false };
    }

    if (rawText) {
      const approvalRes = this.approvals.consume(msg);
      if (approvalRes.matched) {
        return {
          handled: true,
          ...(approvalRes.replyText ? { replyText: approvalRes.replyText } : {}),
        };
      }

      const cmd = normalizeAdminCommand(rawText);
      if (LIST_COMMANDS.has(cmd)) {
        const active = this.listActiveDecisions(8);
        const queued = this.listQueuedDecisions(undefined, 8);
        const pendingDrafts = this.hub.listDrafts({ status: 'pending_approval' });
        const pendingApprovals = this.approvals.listPending();

        const seenIds = new Set<string>();
        const ordered: RouterDecisionRecord[] = [];
        for (const item of [...queued, ...active]) {
          if (seenIds.has(item.id)) continue;
          seenIds.add(item.id);
          ordered.push(item);
        }

        if (ordered.length === 0 && pendingDrafts.length === 0 && pendingApprovals.length === 0) {
          return {
            handled: true,
            replyText: '现在没有待处理任务或草稿，队列是空的。',
          };
        }
        const lines: string[] = [];
        if (ordered.length > 0) {
          lines.push('待处理任务：');
          for (const item of ordered.slice(0, 8)) {
            lines.push(`[#${extractShortId(item)}] ${shortLine(item.summary)}`);
          }
        }
        if (pendingDrafts.length > 0) {
          lines.push(`待审草稿：${pendingDrafts.length} 条`);
        }
        if (pendingApprovals.length > 0) {
          lines.push(
            `待确认操作：${pendingApprovals.map((a) => `${a.code}(${a.tool})`).join('、')}`,
          );
        }
        lines.push('引用对应卡片或回 #编号 可直接继续处理。');
        return {
          handled: true,
          replyText: lines.join('\n'),
        };
      }

      const prefixRef = parsePrefixTaskRef(rawText);
      if (prefixRef) {
        const target = this.findDecisionByRef(prefixRef.ref);
        if (target) {
          const nowIso = this.nowFn().toISOString();
          const wechatTarget = await this.resolveWechatTarget();
          let current = target;
          if (target.status === 'deferred' || target.status === 'resolved' || target.status === 'filtered') {
            current = this.db.upsertDecision({
              ...target,
              destination: 'wechat',
              status: 'notified',
              updatedAt: nowIso,
            });
          }
          this.markDecisionDeferredNotifications(current.id, 'delivered', nowIso, 'wechat', wechatTarget);
          if (!prefixRef.rest) {
            return {
              handled: true,
              replyText: this.formatNotificationText(current),
              ...(current.imagePath?.trim() ? { imagePath: current.imagePath.trim() } : {}),
            };
          }
          return this.forwardAdminReplyToWorker(current, prefixRef.rest, msg);
        }
      }

      const quotedRef = parseQuotedTaskRef(msg.quotedText);
      if (quotedRef) {
        const target = this.findDecisionByRef(quotedRef);
        if (target) {
          const nowIso = this.nowFn().toISOString();
          const wechatTarget = await this.resolveWechatTarget();
          let current = target;
          if (target.status === 'deferred' || target.status === 'resolved' || target.status === 'filtered') {
            current = this.db.upsertDecision({
              ...target,
              destination: 'wechat',
              status: 'notified',
              updatedAt: nowIso,
            });
          }
          this.markDecisionDeferredNotifications(current.id, 'delivered', nowIso, 'wechat', wechatTarget);
          return this.forwardAdminReplyToWorker(current, rawText, msg);
        }
      }
    }

    this.ownerSession.enqueueMessage(msg);
    return { handled: true };
  }

  private formatNotificationText(decision: RouterDecisionRecord): string {
    const tag = `[#${extractShortId(decision)}]`;
    const lines: string[] = [];
    if (this.shouldShowPublicTaintWarning(decision)) {
      lines.push(PUBLIC_TAINT_WARNING_TEXT);
    }
    lines.push(`${tag} ${decision.summary}`);
    if (decision.draftText?.trim()) {
      lines.push(`拟发草稿：\n${decision.draftText.trim()}`);
    }
    if (decision.blindspot?.trim()) {
      lines.push(`还没验证：${decision.blindspot.trim()}`);
    }
    if (decision.question?.trim()) {
      lines.push(`想确认下：${decision.question.trim()}`);
    }
    if (decision.options.length > 0) {
      const formatted = decision.options.map((opt, idx) => {
        const hasRecTag = /[（(]\s*推荐\s*[）)]/.test(opt);
        if (idx === decision.recommendedIndex && !hasRecTag) {
          return `${idx + 1}. ${opt}（推荐）`;
        }
        return `${idx + 1}. ${opt}`;
      });
      lines.push(`可选：${formatted.join(' / ')}`);
    }
    if (decision.rawUrl) {
      lines.push(decision.rawUrl);
    }
    lines.push(`引用本条或回 #${extractShortId(decision)} 接着聊`);
    return lines.join('\n');
  }

  private upsertDeferredNotification(input: {
    decision: RouterDecisionRecord;
    channel: NotifyChannel;
    target: string;
    title: string;
    summary: string;
    reason: string;
    dueAt: string | null;
    nowIso: string;
  }): RouterNotificationRecord {
    const existing = this.db.listNotifications({
      decisionId: input.decision.id,
      status: 'deferred',
      limit: 50,
      order: 'asc',
    });
    if (existing.length > 0) {
      const [primary, ...duplicates] = existing;
      for (const dup of duplicates) {
        this.db.upsertNotification({
          ...dup,
          status: 'read',
          dueAt: null,
          updatedAt: input.nowIso,
        });
      }
      return this.db.upsertNotification({
        ...primary,
        channel: input.channel,
        target: input.target,
        title: input.title,
        summary: input.summary,
        reason: input.reason,
        rawUrl: input.decision.rawUrl,
        status: 'deferred',
        dueAt: input.dueAt,
        updatedAt: input.nowIso,
      });
    }
    return this.db.upsertNotification({
      id: randomUUID(),
      decisionId: input.decision.id,
      channel: input.channel,
      target: input.target,
      title: input.title,
      summary: input.summary,
      reason: input.reason,
      rawUrl: input.decision.rawUrl,
      status: 'deferred',
      dueAt: input.dueAt,
      createdAt: input.nowIso,
      updatedAt: input.nowIso,
    });
  }

  private async deliverToWechat(
    decision: RouterDecisionRecord,
    target: string,
    text: string,
    reason: string,
    idempotencySuffix?: string,
    imagePath?: string,
  ): Promise<boolean> {
    const transport = this.hub.getWechatTransport?.();
    if (!transport) return false;
    try {
      const key = idempotencySuffix
        ? `router-notify:${decision.id}:${idempotencySuffix}`
        : `router-notify:${decision.id}`;
      const trimmedImage = imagePath?.trim();
      const res = await transport.send({
        chatId: target,
        text,
        idempotencyKey: key,
        mode: 'send',
        reason,
        ...(trimmedImage ? { imagePath: trimmedImage } : {}),
      });
      return res.status === 'sent' || res.status === 'staged';
    } catch {
      return false;
    }
  }

  private async deliverBatchSummaryToWechat(
    target: string,
    decisions: RouterDecisionRecord[],
    idempotencyKey: string,
  ): Promise<boolean> {
    const transport = this.hub.getWechatTransport?.();
    if (!transport) return false;
    const lines: string[] = [`你有 ${decisions.length} 条待处理更新：`];
    for (const decision of decisions) {
      const prefix = this.shouldShowPublicTaintWarning(decision) ? '⚠️ ' : '';
      lines.push(`${prefix}[#${extractShortId(decision)}] ${shortLine(decision.summary, 80)}`);
    }
    lines.push('引用或回 #编号 可直接处理对应任务');
    try {
      const res = await transport.send({
        chatId: target,
        text: lines.join('\n'),
        idempotencyKey,
        mode: 'send',
        reason: 'deferred_batch_summary',
      });
      return res.status === 'sent' || res.status === 'staged';
    } catch {
      return false;
    }
  }

  private async routeNotification(
    decision: RouterDecisionRecord,
    options: {
      urgent?: boolean;
      title?: string;
      summary?: string;
      reason?: string;
      idempotencySuffix?: string;
      suppressWechat?: boolean;
      suppressReason?: string;
      imagePath?: string;
    } = {},
  ): Promise<RouteDeliveryOutcome> {
    const now = this.nowFn();
    const nowIso = now.toISOString();
    const rawAttention = resolveAttentionDestination(this.policy, {
      now,
      urgent: options.urgent,
    });
    const downgradedToWeb = rawAttention.destination === 'wechat' && Boolean(options.suppressWechat);
    const attention: AttentionDecision = downgradedToWeb
      ? {
          ...rawAttention,
          destination: 'web',
          reason: options.suppressReason
            ? `${rawAttention.reason};${options.suppressReason}`
            : rawAttention.reason,
        }
      : rawAttention;

    const title = options.title ?? `[${decision.source}] ${decision.threadKey}`;
    const summary = options.summary ?? decision.summary;
    const reason = options.reason ?? `${decision.reason} (${attention.reason})`;

    if (attention.destination === 'none') {
      return { attention, notification: null, deferred: false };
    }

    if (attention.destination === 'web') {
      const notif = this.db.upsertNotification({
        id: randomUUID(),
        decisionId: decision.id,
        channel: 'web',
        target: 'web',
        title,
        summary,
        reason,
        rawUrl: decision.rawUrl,
        status: 'delivered',
        dueAt: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      return { attention, notification: notif, deferred: false };
    }

    if (attention.destination === 'wechat') {
      const target = await this.resolveWechatTarget();
      const text = this.formatNotificationText(decision);
      const imagePath = options.imagePath ?? decision.imagePath ?? undefined;
      const sent = await this.deliverToWechat(
        decision,
        target,
        text,
        reason,
        options.idempotencySuffix,
        imagePath,
      );
      if (sent) {
        this.markDecisionDeferredNotifications(decision.id, 'read', nowIso);
        const notif = this.db.upsertNotification({
          id: randomUUID(),
          decisionId: decision.id,
          channel: 'wechat',
          target,
          title,
          summary,
          reason,
          rawUrl: decision.rawUrl,
          status: 'delivered',
          dueAt: null,
          createdAt: nowIso,
          updatedAt: nowIso,
        });
        await this.ownerSession.injectPushReceipt(decision);
        return { attention, notification: notif, deferred: false };
      }
      const fallbackDue = computeNextWorkStartIso(now, this.policy);
      const notif = this.upsertDeferredNotification({
        decision,
        channel: 'wechat',
        target,
        title,
        summary,
        reason: `${reason};wechat_unavailable_deferred`,
        dueAt: fallbackDue,
        nowIso,
      });
      return { attention, notification: notif, deferred: true };
    }

    const notif = this.upsertDeferredNotification({
      decision,
      channel: 'defer',
      target: 'web',
      title,
      summary,
      reason,
      dueAt: attention.dueAt,
      nowIso,
    });
    return { attention, notification: notif, deferred: true };
  }

  async handleUnclaimedEvent(
    event: NormalizedEvent,
    meta: { inboxId: string },
  ): Promise<{ handled: boolean; subscription?: ThreadSubscription }> {
    if (!this.policy.enabled) {
      return { handled: false };
    }

    const now = this.nowFn();
    const nowIso = now.toISOString();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
    const recentDecisions = this.db.listRecentDecisionsForSource(event.source, sevenDaysAgo, 6);

    const triage = await triageEvent({
      event,
      policy: this.policy,
      recentDecisions,
      llm: this.resolveLlm(),
      logger: this.resolveLogger(),
    });

    const actor = event.actor.login ?? event.actor.displayName ?? event.actor.id;
    const baseDecision: RouterDecisionRecord = {
      id: randomUUID(),
      inboxId: meta.inboxId,
      eventId: event.id,
      source: event.source,
      threadKey: event.threadKey,
      actor,
      eventType: event.type,
      eventOccurredAt: event.occurredAt,
      level: triage.level,
      summary: triage.summary,
      reason: triage.reason,
      question: triage.question,
      options: triage.options,
      recommendedIndex: triage.recommendedIndex,
      answeredOption: null,
      status: 'notified',
      destination: 'none',
      workerSessionId: null,
      subscriptionId: null,
      triageRestored: false,
      rawUrl: event.rawRef?.url ?? null,
      trustLevel: event.trustLevel,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    if (triage.level === 'ignore') {
      this.db.upsertDecision({
        ...baseDecision,
        status: 'filtered',
        destination: 'none',
      });
      return { handled: true };
    }

    if ((triage.level === 'prepare' || triage.level === 'act') && triage.shouldDispatchWorker) {
      const saved = this.db.upsertDecision({
        ...baseDecision,
        status: 'dispatched',
      });
      const dispatched = await dispatchWorker({
        hub: this.hub,
        ctx: this.ctx,
        event,
        decision: saved,
        personaId: triage.personaId,
        homeDir: this.homeDir,
      });
      const linked: RouterDecisionRecord = {
        ...saved,
        workerSessionId: dispatched.sessionId,
        subscriptionId: dispatched.subscription.id,
        targetCircle: dispatched.targetCircle,
        updatedAt: this.nowFn().toISOString(),
      };
      const routed = await this.routeNotification(linked, {
        urgent: triage.urgent,
        suppressWechat: true,
        suppressReason: 'worker_pending_report',
      });
      this.db.upsertDecision({
        ...linked,
        destination: routed.attention.destination,
        updatedAt: this.nowFn().toISOString(),
      });
      return { handled: true, subscription: dispatched.subscription };
    }

    const saved = this.db.upsertDecision(baseDecision);
    const isOrdinaryInform = saved.level === 'inform' && !triage.urgent;
    const routed = await this.routeNotification(saved, {
      urgent: triage.urgent,
      suppressWechat: isOrdinaryInform,
      suppressReason: isOrdinaryInform ? 'inform_web_only' : undefined,
    });
    this.db.upsertDecision({
      ...saved,
      destination: routed.attention.destination,
      status: routed.deferred ? 'deferred' : 'notified',
      updatedAt: this.nowFn().toISOString(),
    });
    return { handled: true };
  }

  getPolicy(): AttentionPolicy {
    return {
      ...this.policy,
      workdays: [...this.policy.workdays],
    };
  }

  updatePolicy(patch: Partial<AttentionPolicy>): AttentionPolicy {
    return this.savePolicy({
      ...this.policy,
      ...patch,
    });
  }

  touchWebPresence(at?: Date): AttentionPolicy {
    const timestamp = (at ?? this.nowFn()).toISOString();
    return this.savePolicy({
      ...this.policy,
      lastWebActiveAt: timestamp,
    });
  }

  getStatus(): RouterStatusView {
    const now = this.nowFn();
    const webActive = isWebActive(this.policy.lastWebActiveAt, now);
    const current = resolveAttentionDestination(this.policy, { now, webActive });
    const activeSubscriptions = this.hub.listSubscriptions({ status: 'active' }).length;
    return {
      ok: true,
      enabled: this.policy.enabled,
      presenceMode: this.policy.presenceMode,
      webActive,
      currentSlot: current.slot,
      currentDestination: current.destination,
      unreadNotifications: this.db.countUnreadNotifications(),
      pendingDecisions: this.db.countPendingDecisions(),
      activeSubscriptions,
      policy: this.getPolicy(),
    };
  }

  previewRoute(input: AttentionPreviewInput = {}): AttentionDecision {
    const merged = normalizeAttentionPolicy({
      ...this.policy,
      ...(input.policyOverride ?? {}),
      ...(input.presenceMode ? { presenceMode: input.presenceMode } : {}),
    });
    const parsedTime = input.isoTime ? Date.parse(input.isoTime) : NaN;
    const now = Number.isNaN(parsedTime) ? this.nowFn() : new Date(parsedTime);
    return resolveAttentionDestination(merged, {
      now,
      urgent: Boolean(input.urgent),
    });
  }

  listDecisions(filter?: ListDecisionsFilter): RouterDecisionRecord[] {
    return this.db.listDecisions(filter);
  }

  async restoreDecision(id: string): Promise<RouterDecisionRecord> {
    const existing = this.db.getDecision(id);
    if (!existing) {
      throw new Error(`decision_not_found:${id}`);
    }
    const nowIso = this.nowFn().toISOString();
    const upgraded: RouterDecisionRecord = {
      ...existing,
      level: existing.level === 'ignore' ? 'inform' : existing.level,
      triageRestored: true,
      status: 'restored',
      updatedAt: nowIso,
    };
    this.db.upsertDecision(upgraded);
    const routed = await this.routeNotification(upgraded, {
      urgent: true,
      idempotencySuffix: 'restore',
    });
    return this.db.upsertDecision({
      ...upgraded,
      destination: routed.attention.destination,
      status: 'restored',
      updatedAt: this.nowFn().toISOString(),
    });
  }

  async dispatchManual(id: string): Promise<RouterDecisionRecord> {
    const existing = this.db.getDecision(id);
    if (!existing) {
      throw new Error(`decision_not_found:${id}`);
    }
    const nowIso = this.nowFn().toISOString();
    const syntheticEvent: NormalizedEvent = {
      id: existing.eventId,
      source: existing.source,
      type: `${existing.source}.manual_dispatch`,
      dedupeKey: `manual:${existing.id}`,
      threadKey: existing.threadKey,
      actor: { id: existing.actor, login: existing.actor },
      trustLevel: 'owner',
      occurredAt: existing.createdAt,
      summary: existing.summary,
      payload: { manualDispatch: true },
      rawRef: existing.rawUrl ? { url: existing.rawUrl } : undefined,
    };
    const prepared: RouterDecisionRecord = {
      ...existing,
      level: existing.level === 'ignore' || existing.level === 'inform' ? 'prepare' : existing.level,
      status: 'dispatched',
      updatedAt: nowIso,
    };
    const dispatched = await dispatchWorker({
      hub: this.hub,
      ctx: this.ctx,
      event: syntheticEvent,
      decision: prepared,
      homeDir: this.homeDir,
    });
    return this.db.upsertDecision({
      ...prepared,
      workerSessionId: dispatched.sessionId,
      subscriptionId: dispatched.subscription.id,
      trustLevel: 'owner',
      targetCircle: dispatched.targetCircle,
      updatedAt: this.nowFn().toISOString(),
    });
  }

  async answerDecision(id: string, optionIndex: number): Promise<RouterDecisionRecord> {
    const existing = this.db.getDecision(id);
    if (!existing) {
      throw new Error(`decision_not_found:${id}`);
    }
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= existing.options.length) {
      throw new Error(`invalid_option_index:${optionIndex}`);
    }
    const chosen = existing.options[optionIndex];
    const updated = this.db.upsertDecision({
      ...existing,
      answeredOption: chosen,
      status: 'resolved',
      updatedAt: this.nowFn().toISOString(),
    });

    if (updated.workerSessionId) {
      this.hub.setSessionTurnOverride?.(updated.workerSessionId, 3, OWNER_TURN_OVERRIDE_TTL_MS);
      const followupText = [
        '[DSH Router Owner Decision]',
        `decisionId: ${updated.id}`,
        `selectedIndex: ${optionIndex}`,
        `selectedOption: ${chosen}`,
        '请按该选项继续执行，并用简洁清晰的简体中文汇报结果（对外发布的英文回复草稿可保留英文）。',
      ].join('\n');
      await sendWorkerFollowup(this.ctx, updated.workerSessionId, followupText, {
        decisionId: updated.id,
        selectedOption: chosen,
        source: 'wechat-admin',
        trust: 'owner',
      });
    }

    return updated;
  }

  async submitWorkerReport(input: WorkerReportInput): Promise<RouterDecisionRecord> {
    const existing = this.db.getDecision(input.decisionId);
    if (!existing) {
      throw new Error(`decision_not_found:${input.decisionId}`);
    }
    const options = Array.isArray(input.options)
      ? input.options.map((item) => String(item).trim()).filter(Boolean)
      : [];
    const recIdx =
      options.length > 0 &&
      typeof input.recommendedIndex === 'number' &&
      Number.isInteger(input.recommendedIndex) &&
      input.recommendedIndex >= 0 &&
      input.recommendedIndex < options.length
        ? input.recommendedIndex
        : null;
    const summaryText = input.conclusion.trim();

    const imagePath = input.imagePath?.trim() || null;
    const draftText = input.draftText?.trim() || null;
    const blindspot = input.blindspot?.trim() || null;
    const reportMode = input.mode ?? null;
    const question = input.question?.trim() || null;

    const updatedBase: RouterDecisionRecord = {
      ...existing,
      summary: summaryText,
      question,
      options,
      recommendedIndex: recIdx,
      imagePath,
      draftText,
      blindspot,
      reportMode,
      status: 'notified',
      updatedAt: this.nowFn().toISOString(),
    };

    const idempotencySuffix = `report:${this.nowFn().getTime()}:${randomUUID().slice(0, 6)}`;
    const routed = await this.routeNotification(updatedBase, {
      urgent: Boolean(input.urgent),
      summary: summaryText,
      idempotencySuffix,
      imagePath: imagePath ?? undefined,
    });

    if (existing.workerSessionId) {
      this.hub.clearSessionTurnOverride?.(existing.workerSessionId);
    }

    return this.db.upsertDecision({
      ...updatedBase,
      destination: routed.attention.destination,
      status: routed.deferred ? 'deferred' : 'notified',
      updatedAt: this.nowFn().toISOString(),
    });
  }

  listNotifications(filter?: ListNotificationsFilter): RouterNotificationRecord[] {
    return this.db.listNotifications(filter);
  }

  markNotificationRead(id: string): RouterNotificationRecord {
    const existing = this.db.getNotification(id);
    if (!existing) {
      throw new Error(`notification_not_found:${id}`);
    }
    return this.db.upsertNotification({
      ...existing,
      status: 'read',
      updatedAt: this.nowFn().toISOString(),
    });
  }

  async tickDeferred(): Promise<{ processed: number; delivered: number }> {
    const now = this.nowFn();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();
    const deferredList = this.db.listNotifications({ status: 'deferred', limit: 200, order: 'asc' });
    if (deferredList.length === 0) {
      return { processed: 0, delivered: 0 };
    }

    const attention = resolveAttentionDestination(this.policy, { now });
    let processed = 0;
    let delivered = 0;

    const webItems: Array<{ notif: RouterNotificationRecord; decision: RouterDecisionRecord }> = [];
    const wechatGroupMap = new Map<
      string,
      { decision: RouterDecisionRecord; notifs: RouterNotificationRecord[] }
    >();

    for (const notif of deferredList) {
      const dueReached = notif.dueAt === null || Date.parse(notif.dueAt) <= nowMs;
      const webPresentDelivery = attention.destination === 'web';
      const activeChannelDelivery =
        dueReached && (attention.destination === 'web' || attention.destination === 'wechat');
      if (!webPresentDelivery && !activeChannelDelivery) {
        continue;
      }

      const decision = this.db.getDecision(notif.decisionId);
      if (!decision || decision.status === 'resolved' || decision.status === 'filtered') {
        this.db.upsertNotification({
          ...notif,
          status: 'read',
          dueAt: null,
          updatedAt: nowIso,
        });
        continue;
      }

      let nextChannel: NotifyChannel = attention.destination;
      const isOrdinaryInform =
        nextChannel === 'wechat' &&
        decision.level === 'inform' &&
        !decision.triageRestored &&
        !notif.reason.includes('urgent');
      if (isOrdinaryInform) {
        nextChannel = 'web';
      }

      if (nextChannel === 'web') {
        webItems.push({ notif, decision });
      } else if (nextChannel === 'wechat') {
        const existingGroup = wechatGroupMap.get(decision.id);
        if (existingGroup) {
          existingGroup.notifs.push(notif);
        } else {
          wechatGroupMap.set(decision.id, { decision, notifs: [notif] });
        }
      }
    }

    for (const { notif, decision } of webItems) {
      processed += 1;
      delivered += 1;
      this.db.upsertNotification({
        ...notif,
        channel: 'web',
        target: 'web',
        status: 'delivered',
        dueAt: null,
        updatedAt: nowIso,
      });
      if (decision.status === 'deferred') {
        this.db.upsertDecision({
          ...decision,
          destination: 'web',
          status: 'notified',
          updatedAt: nowIso,
        });
      }
    }

    const wechatGroups = [...wechatGroupMap.values()];
    if (wechatGroups.length > 0) {
      const target = await this.resolveWechatTarget();

      if (wechatGroups.length >= BATCH_SUMMARY_THRESHOLD) {
        const batchDecisions = wechatGroups.map((g) => g.decision);
        const allNotifs = wechatGroups.flatMap((g) => g.notifs);
        processed += allNotifs.length;
        const batchKey = `router-batch:${allNotifs.map((n) => n.id.slice(0, 6)).join(',')}:${nowMs}`;
        const ok = await this.deliverBatchSummaryToWechat(target, batchDecisions, batchKey);
        if (ok) {
          delivered += batchDecisions.length;
          for (const group of wechatGroups) {
            for (const notif of group.notifs) {
              this.db.upsertNotification({
                ...notif,
                channel: 'wechat',
                target,
                status: 'delivered',
                dueAt: null,
                updatedAt: nowIso,
              });
            }
            if (group.decision.status === 'deferred') {
              this.db.upsertDecision({
                ...group.decision,
                destination: 'wechat',
                status: 'notified',
                updatedAt: nowIso,
              });
            }
          }
          await this.ownerSession.injectReceiptLines(
            batchDecisions.map(
              (d) => `[已推送给主人] [#${extractShortId(d)}] ${shortLine(d.summary, 120)}`,
            ),
          );
        } else {
          for (const notif of allNotifs) {
            const failReason = notif.reason.includes('wechat_delivery_failed')
              ? notif.reason
              : `${notif.reason};wechat_delivery_failed`;
            this.db.upsertNotification({
              ...notif,
              channel: 'wechat',
              target,
              reason: failReason,
              status: 'deferred',
              updatedAt: nowIso,
            });
          }
        }
      } else {
        for (const group of wechatGroups) {
          const primary = group.notifs[0]!;
          processed += group.notifs.length;
          const text = this.formatNotificationText(group.decision);
          const ok = await this.deliverToWechat(
            group.decision,
            target,
            text,
            primary.reason,
            `deferred:${primary.id}`,
            group.decision.imagePath ?? undefined,
          );
          if (ok) {
            delivered += 1;
            for (const notif of group.notifs) {
              this.db.upsertNotification({
                ...notif,
                channel: 'wechat',
                target,
                status: 'delivered',
                dueAt: null,
                updatedAt: nowIso,
              });
            }
            if (group.decision.status === 'deferred') {
              this.db.upsertDecision({
                ...group.decision,
                destination: 'wechat',
                status: 'notified',
                updatedAt: nowIso,
              });
            }
            await this.ownerSession.injectPushReceipt(group.decision);
          } else {
            for (const notif of group.notifs) {
              const failReason = notif.reason.includes('wechat_delivery_failed')
                ? notif.reason
                : `${notif.reason};wechat_delivery_failed`;
              this.db.upsertNotification({
                ...notif,
                channel: 'wechat',
                target,
                reason: failReason,
                status: 'deferred',
                updatedAt: nowIso,
              });
            }
          }
        }
      }
    }

    return { processed, delivered };
  }

  getStats(days = 7): RouterStatsView {
    const activeSubscriptions = this.hub.listSubscriptions({ status: 'active' }).length;
    return this.db.getStats(days, activeSubscriptions, this.nowFn());
  }

  async simulateEvent(input: SimulateEventInput = {}): Promise<SimulateEventResult> {
    const nowIso = this.nowFn().toISOString();
    const source = input.source?.trim() || 'github';
    const threadKey = input.threadKey?.trim() || 'demo/repo#1';
    const type = input.type?.trim() || (source === 'github' ? 'github.pr_review_requested' : `${source}.event`);
    const actor = input.actor?.trim() || 'octocat';
    const event: NormalizedEvent = {
      id: randomUUID(),
      source,
      type,
      dedupeKey: `sim:${source}:${threadKey}:${randomUUID()}`,
      threadKey,
      actor: {
        id: actor,
        login: actor,
        isBot: Boolean(input.isBot),
      },
      trustLevel: input.trustLevel ?? 'triage',
      occurredAt: nowIso,
      summary: input.summary?.trim() || `Simulated ${type} on ${threadKey}`,
      payload: {
        ...(input.payload ?? {}),
        urgent: Boolean(input.urgent),
        simulated: true,
      },
      rawRef: input.rawUrl?.trim() ? { url: input.rawUrl.trim() } : undefined,
    };

    const result = await this.hub.ingest(event);
    const decision = this.db.findDecisionByEventId(event.id);
    return { result, decision };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ownerSession.dispose();
    this.approvals.close();
    while (this.disposers.length > 0) {
      try {
        this.disposers.pop()?.();
      } catch {
      }
    }
  }
}

export function createRouterRuntime(options: RouterRuntimeOptions): RouterRuntime {
  return new RouterRuntime(options);
}
