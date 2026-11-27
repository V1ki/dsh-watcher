import { randomUUID } from 'node:crypto';
import type {
  AdminWechatHandleResult,
  AdminWechatMessage,
  HubService,
  IngestResult,
  NormalizedEvent,
  ThreadSubscription,
  TrustLevel,
} from '@local/dsh-hub/contracts';
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
import {
  DEFAULT_ATTENTION_POLICY,
  computeNextWorkStartIso,
  isWebActive,
  normalizeAttentionPolicy,
  resolveAttentionDestination,
} from './policy.js';
import { triageEvent, type TriageLlmLike, type TriageLoggerLike } from './triage.js';
import {
  dispatchWorker,
  registerRouterTools,
  sendWorkerFollowup,
  type WorkerDispatcherContext,
} from './worker-dispatcher.js';

const POLICY_META_KEY = 'attention_policy';
const FOCUS_META_KEY = 'focused_decision_id';
const FOCUS_AT_META_KEY = 'focused_decision_at';
const FOCUS_TTL_MS = 24 * 60 * 60 * 1000;

const LIST_COMMANDS = new Set(['列表', '还有啥', '在忙啥', '任务', 'list']);
const DEFER_COMMANDS = new Set(['先放着', '先跳过', '延后', '待会看']);
const CLOSE_COMMANDS = new Set([
  '下一个',
  '下一条',
  '跳过',
  '完成',
  '已处理',
  '关闭',
  '关掉这条',
  '结束',
  '结束了',
  '不用管了',
  'next',
  'skip',
  'done',
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

export interface RouterServiceContext extends WorkerDispatcherContext {
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

    const offUnclaimed = this.hub.onUnclaimedEvent((event, meta) =>
      this.handleUnclaimedEvent(event, meta),
    );
    this.disposers.push(offUnclaimed);

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
      submitWorkerReport: (report) => this.submitWorkerReport(report),
    });
    this.disposers.push(offTools);

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

  private getActiveFocus(): RouterDecisionRecord | null {
    const id = this.db.getMeta(FOCUS_META_KEY)?.trim();
    if (!id) return null;
    const atRaw = this.db.getMeta(FOCUS_AT_META_KEY)?.trim();
    if (atRaw) {
      const atMs = Date.parse(atRaw);
      if (!Number.isNaN(atMs) && this.nowFn().getTime() - atMs >= FOCUS_TTL_MS) {
        this.clearFocus();
        return null;
      }
    }
    const decision = this.db.getDecision(id);
    if (!decision || decision.status === 'resolved' || decision.status === 'filtered') {
      this.clearFocus();
      return null;
    }
    return decision;
  }

  private setFocus(decisionId: string): void {
    this.db.setMeta(FOCUS_META_KEY, decisionId);
    this.db.setMeta(FOCUS_AT_META_KEY, this.nowFn().toISOString());
  }

  private clearFocus(): void {
    this.db.setMeta(FOCUS_META_KEY, '');
    this.db.setMeta(FOCUS_AT_META_KEY, '');
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

  private popNextQueuedDecision(excludeId?: string): RouterDecisionRecord | null {
    return this.listQueuedDecisions(excludeId, 1)[0] ?? null;
  }

  private findDecisionByRef(ref: string): RouterDecisionRecord | null {
    const lowerRef = ref.trim().toLowerCase();
    if (!lowerRef) return null;
    const decisions = this.db.listDecisions({ limit: 200 });
    let fallbackMatch: RouterDecisionRecord | null = null;
    for (const decision of decisions) {
      const shortId = extractShortId(decision).toLowerCase();
      const matched = shortId === lowerRef || decision.id.toLowerCase().startsWith(lowerRef);
      if (!matched) continue;
      if (decision.status !== 'resolved' && decision.status !== 'filtered') {
        return decision;
      }
      if (!fallbackMatch) {
        fallbackMatch = decision;
      }
    }
    return fallbackMatch;
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

    const ok = await sendWorkerFollowup(this.ctx, target.workerSessionId, lines.join('\n'), {
      decisionId: target.id,
      source: 'wechat-admin',
      senderId: msg.senderId,
      session: msg.session,
    });
    this.setFocus(target.id);
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
    if (!rawText) {
      return { handled: false };
    }
    const cmd = normalizeAdminCommand(rawText);

    if (LIST_COMMANDS.has(cmd)) {
      const activeFocus = this.getActiveFocus();
      const queued = this.listQueuedDecisions(activeFocus?.id, 5);
      if (!activeFocus && queued.length === 0) {
        return {
          handled: true,
          replyText: '现在没有正在聊的事，队列里也是空的。',
        };
      }
      const lines: string[] = [];
      if (activeFocus) {
        lines.push('正在聊：');
        lines.push(`[#${extractShortId(activeFocus)}] ${shortLine(activeFocus.summary)}`);
      }
      if (queued.length > 0) {
        lines.push(activeFocus ? '排在后面：' : '待处理：');
        for (const item of queued) {
          lines.push(`[#${extractShortId(item)}] ${shortLine(item.summary)}`);
        }
      }
      lines.push('回 #编号 可以切过去聊；回“下一个”切下一条。');
      return {
        handled: true,
        replyText: lines.join('\n'),
      };
    }

    const activeFocus = this.getActiveFocus();

    if (DEFER_COMMANDS.has(cmd) || CLOSE_COMMANDS.has(cmd)) {
      if (!activeFocus) {
        return { handled: false };
      }
      const nowIso = this.nowFn().toISOString();
      const isDefer = DEFER_COMMANDS.has(cmd);
      this.db.upsertDecision({
        ...activeFocus,
        status: isDefer ? 'deferred' : 'resolved',
        updatedAt: nowIso,
      });
      if (!isDefer) {
        this.markDecisionDeferredNotifications(activeFocus.id, 'read', nowIso);
      }
      this.clearFocus();

      const next = this.popNextQueuedDecision(activeFocus.id);
      if (!next) {
        return {
          handled: true,
          replyText: '这条先收起了，后面暂时没有别的事。',
        };
      }
      const target = await this.resolveWechatTarget();
      this.setFocus(next.id);
      const activated = this.db.upsertDecision({
        ...next,
        destination: 'wechat',
        status: 'notified',
        updatedAt: nowIso,
      });
      this.markDecisionDeferredNotifications(activated.id, 'delivered', nowIso, 'wechat', target);
      return {
        handled: true,
        replyText: this.formatNotificationText(activated),
        ...(activated.imagePath?.trim() ? { imagePath: activated.imagePath.trim() } : {}),
      };
    }

    const prefixRef = parsePrefixTaskRef(rawText);
    if (prefixRef) {
      const target = this.findDecisionByRef(prefixRef.ref);
      if (target) {
        const nowIso = this.nowFn().toISOString();
        const wechatTarget = await this.resolveWechatTarget();
        this.setFocus(target.id);
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
      if (/^\d+$/.test(prefixRef.ref) && activeFocus) {
        return {
          handled: true,
          replyText: `没找到 #${prefixRef.ref} 对应的任务，回“列表”可以看当前排队。`,
        };
      }
    }

    const quotedRef = parseQuotedTaskRef(msg.quotedText);
    if (quotedRef) {
      const target = this.findDecisionByRef(quotedRef);
      if (target) {
        const nowIso = this.nowFn().toISOString();
        const wechatTarget = await this.resolveWechatTarget();
        this.setFocus(target.id);
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

    return { handled: false };
  }

  private formatNotificationText(
    decision: RouterDecisionRecord,
    opts?: { compact?: boolean },
  ): string {
    const tag = `[#${extractShortId(decision)}]`;
    const lines: string[] = [`${tag} ${decision.summary}`];
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
    if (opts?.compact !== true) {
      if (decision.rawUrl) {
        lines.push(decision.rawUrl);
      }
      lines.push(`引用本条或回 #${extractShortId(decision)} 接着聊；回“下一个”切下一条`);
    }
    return lines.join('\n');
  }

  private upsertDeferredWechatNotification(input: {
    decision: RouterDecisionRecord;
    target: string;
    title: string;
    summary: string;
    reason: string;
    dueAt: string | null;
    nowIso: string;
  }): RouterNotificationRecord {
    const existing = this.db.listNotifications({
      decisionId: input.decision.id,
      channel: 'wechat',
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
        channel: 'wechat',
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
      channel: 'wechat',
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
      const activeFocus = this.getActiveFocus();
      if (activeFocus && activeFocus.id !== decision.id && !options.urgent) {
        const notif = this.upsertDeferredWechatNotification({
          decision,
          target,
          title,
          summary,
          reason: `${reason};queued_behind_focus`,
          dueAt: nowIso,
          nowIso,
        });
        return { attention, notification: notif, deferred: true };
      }

      const isSameFocusFollowup = activeFocus !== null && activeFocus.id === decision.id;
      const text = this.formatNotificationText(decision, { compact: isSameFocusFollowup });
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
        this.setFocus(decision.id);
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
        return { attention, notification: notif, deferred: false };
      }
      const fallbackDue = computeNextWorkStartIso(now, this.policy);
      const notif = this.upsertDeferredWechatNotification({
        decision,
        target,
        title,
        summary,
        reason: `${reason};wechat_unavailable_deferred`,
        dueAt: fallbackDue,
        nowIso,
      });
      return { attention, notification: notif, deferred: true };
    }

    const notif = this.db.upsertNotification({
      id: randomUUID(),
      decisionId: decision.id,
      channel: 'defer',
      target: 'web',
      title,
      summary,
      reason,
      rawUrl: decision.rawUrl,
      status: 'deferred',
      dueAt: attention.dueAt,
      createdAt: nowIso,
      updatedAt: nowIso,
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
    if (this.db.getMeta(FOCUS_META_KEY)?.trim() === updated.id) {
      this.clearFocus();
    }

    if (updated.workerSessionId) {
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

    if (attention.destination === 'wechat' && this.getActiveFocus()) {
      return { processed: 0, delivered: 0 };
    }

    let resolvedWechatTarget: string | null = null;

    for (const notif of deferredList) {
      const dueReached = notif.dueAt !== null && Date.parse(notif.dueAt) <= nowMs;
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

      processed += 1;
      let nextChannel: NotifyChannel = attention.destination;
      const isOrdinaryInform =
        nextChannel === 'wechat' &&
        decision.level === 'inform' &&
        !decision.triageRestored &&
        !notif.reason.includes('urgent');
      if (isOrdinaryInform) {
        nextChannel = 'web';
      }

      let target = 'web';
      let ok = false;

      if (nextChannel === 'web') {
        ok = true;
      } else if (nextChannel === 'wechat') {
        if (resolvedWechatTarget === null) {
          resolvedWechatTarget = await this.resolveWechatTarget();
        }
        target = resolvedWechatTarget;
        const text = this.formatNotificationText(decision);
        ok = await this.deliverToWechat(
          decision,
          target,
          text,
          notif.reason,
          `deferred:${notif.id}`,
          decision.imagePath ?? undefined,
        );
      }

      if (ok) {
        delivered += 1;
        this.db.upsertNotification({
          ...notif,
          channel: nextChannel,
          target,
          status: 'delivered',
          dueAt: null,
          updatedAt: nowIso,
        });
        if (decision.status === 'deferred') {
          this.db.upsertDecision({
            ...decision,
            destination: nextChannel,
            status: 'notified',
            updatedAt: nowIso,
          });
        }
        if (nextChannel === 'wechat') {
          this.setFocus(decision.id);
          this.markDecisionDeferredNotifications(decision.id, 'delivered', nowIso, 'wechat', target);
          break;
        }
      } else if (nextChannel === 'wechat') {
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
