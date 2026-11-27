import { randomUUID } from 'node:crypto';
import type {
  HubService,
  MemoKind,
  MemoRecord,
  MemoStatus,
  NormalizedEvent,
  WatchSource,
  WechatAtmosphere,
} from '@local/dsh-hub/contracts';
import {
  MemoStore,
  type CreateMemoInput,
  type CreateMemoResult,
  type ProactiveBudgetMode,
} from './store.js';
import {
  WebScout,
  type ScoutOutcome,
  type WebSearchClient,
} from './web-scout.js';

export interface MemoEngineConfig {
  tickIntervalMs: number;
  maxActivePerRoom: number;
  proactiveBudgetMode: ProactiveBudgetMode;
  proactiveBudgetHours: number;
  proactiveBudgetMaxPerRoom: number;
  defaultNotifyWechatChatId: string;
  newsDefaultIntervalHours: number;
  newsMaxDays: number;
  longWatchDefaultIntervalHours: number;
  atmosphereWindowMinutes: number;
  activeChatQuietSeconds: number;
}

export interface RawMemoEngineConfig {
  tickIntervalMs?: number;
  maxActivePerRoom?: number;
  proactiveBudgetMode?: ProactiveBudgetMode;
  proactiveBudgetHours?: number;
  proactiveBudgetMaxPerRoom?: number;
  defaultNotifyWechatChatId?: string;
  newsDefaultIntervalHours?: number;
  newsMaxDays?: number;
  longWatchDefaultIntervalHours?: number;
  atmosphereWindowMinutes?: number;
  activeChatQuietSeconds?: number;
}

export interface MemoCheckResult {
  memoId: string;
  kind: MemoKind;
  action: 'fired' | 'completed' | 'torn' | 'expired' | 'deferred' | 'skipped';
  status: MemoStatus;
  reason: string;
  eventIngested?: boolean;
  wechatPingSent?: boolean;
  scoutOutcome?: ScoutOutcome;
}

export interface MemoLogger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

export interface MemoEngineOptions {
  hub?: HubService;
  watcher?: HubService;
  store?: MemoStore;
  web?: WebSearchClient;
  scout?: WebScout;
  config?: RawMemoEngineConfig;
  logger?: MemoLogger;
  now?: () => Date;
  rng?: () => number;
}

interface AtmosphereDecision {
  allow: boolean;
  tear: boolean;
  reason: string;
}

export function normalizeMemoConfig(raw: RawMemoEngineConfig = {}): MemoEngineConfig {
  return {
    tickIntervalMs: Math.max(5_000, Number(raw.tickIntervalMs) || 60_000),
    maxActivePerRoom: Math.max(1, Number(raw.maxActivePerRoom) || 5),
    proactiveBudgetMode: raw.proactiveBudgetMode === 'rolling' ? 'rolling' : 'calendar_day',
    proactiveBudgetHours: Math.max(1, Number(raw.proactiveBudgetHours) || 18),
    proactiveBudgetMaxPerRoom: Math.max(1, Number(raw.proactiveBudgetMaxPerRoom) || 1),
    defaultNotifyWechatChatId: typeof raw.defaultNotifyWechatChatId === 'string'
      ? raw.defaultNotifyWechatChatId.trim()
      : '',
    newsDefaultIntervalHours: clampNumber(Number(raw.newsDefaultIntervalHours) || 8, 6, 12),
    newsMaxDays: Math.max(1, Math.min(7, Number(raw.newsMaxDays) || 3)),
    longWatchDefaultIntervalHours: clampNumber(
      Number(raw.longWatchDefaultIntervalHours) || 96,
      72,
      168,
    ),
    atmosphereWindowMinutes: Math.max(15, Number(raw.atmosphereWindowMinutes) || 180),
    activeChatQuietSeconds: Math.max(30, Number(raw.activeChatQuietSeconds) || 300),
  };
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function addHoursIso(base: Date, hours: number): string {
  return new Date(base.getTime() + hours * 3_600_000).toISOString();
}

export function pickRandomFireAt(
  windowStart: string | Date,
  windowEnd: string | Date,
  rng: () => number = Math.random,
): string {
  const startMs = typeof windowStart === 'string' ? Date.parse(windowStart) : windowStart.getTime();
  const endMs = typeof windowEnd === 'string' ? Date.parse(windowEnd) : windowEnd.getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    throw new TypeError('Invalid windowStart or windowEnd timestamp');
  }
  if (endMs <= startMs) {
    throw new RangeError('windowEnd must be strictly after windowStart');
  }

  const startMinute = Math.ceil(startMs / 60_000);
  const endMinute = Math.floor(endMs / 60_000);
  const oddMinutes: number[] = [];

  for (let m = startMinute; m <= endMinute; m += 1) {
    const minuteOfHour = ((m % 60) + 60) % 60;
    if (minuteOfHour % 2 === 1) {
      oddMinutes.push(m);
    }
  }

  const r = clampNumber(rng(), 0, 0.9999999);

  if (oddMinutes.length > 0) {
    const chosenMinute = oddMinutes[Math.floor(r * oddMinutes.length)];
    const secOffset = Math.floor(clampNumber(rng(), 0, 0.9999999) * 50) + 5;
    const candidateMs = Math.min(endMs, Math.max(startMs, chosenMinute * 60_000 + secOffset * 1000));
    const checkDate = new Date(candidateMs);
    if (checkDate.getUTCMinutes() % 2 === 1) {
      return checkDate.toISOString();
    }
    return new Date(chosenMinute * 60_000).toISOString();
  }

  const midMs = Math.floor(startMs + r * (endMs - startMs));
  const fallback = new Date(midMs);
  if (fallback.getUTCMinutes() === 0 && midMs + 60_000 <= endMs) {
    return new Date(midMs + 60_000).toISOString();
  }
  return fallback.toISOString();
}

function extractTopicHints(memo: MemoRecord): string[] {
  const hints = new Set<string>();
  for (const kw of memo.keywords) {
    const trimmed = kw.trim().toLowerCase();
    if (trimmed.length >= 2) hints.add(trimmed);
  }
  const titleTerms = memo.title
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9._-]{2,}|[\u4e00-\u9fff]{2,4}/g);
  if (titleTerms) {
    for (const term of titleTerms) {
      hints.add(term);
    }
  }
  return [...hints];
}

function isTopicAlreadyDiscussed(
  memo: MemoRecord,
  atmosphere: WechatAtmosphere,
  candidateUrl?: string,
): boolean {
  const messages = Array.isArray(atmosphere.recentMessages) ? atmosphere.recentMessages : [];
  if (messages.length === 0) return false;

  const hints = extractTopicHints(memo);
  const normalizedUrl = candidateUrl ? candidateUrl.toLowerCase() : '';

  for (const msg of messages) {
    const text = String(msg.text || '').toLowerCase();
    if (!text) continue;
    if (normalizedUrl && text.includes(normalizedUrl)) {
      return true;
    }
    for (const hint of hints) {
      if (text.includes(hint)) {
        return true;
      }
    }
  }
  return false;
}

function evaluateWechatAtmosphere(
  memo: MemoRecord,
  atmosphere: WechatAtmosphere,
  quietThresholdSeconds: number,
  candidateUrl?: string,
): AtmosphereDecision {
  if (!atmosphere.healthy) {
    return { allow: false, tear: false, reason: 'wechat_transport_unhealthy' };
  }
  if (atmosphere.paused) {
    return { allow: false, tear: true, reason: 'chat_paused' };
  }
  if (atmosphere.ownSpokeSince) {
    return { allow: false, tear: true, reason: 'owner_already_spoke' };
  }
  if (isTopicAlreadyDiscussed(memo, atmosphere, candidateUrl)) {
    return { allow: false, tear: true, reason: 'topic_already_discussed' };
  }
  const tooRecent =
    atmosphere.secondsSinceLastMessage !== null &&
    atmosphere.secondsSinceLastMessage < quietThresholdSeconds;
  if (!atmosphere.quiet || tooRecent) {
    return {
      allow: false,
      tear: memo.kind === 'time_nudge',
      reason: 'active_conversation',
    };
  }
  return { allow: true, tear: false, reason: 'quiet_and_clear' };
}

function resolveWechatChatId(memo: MemoRecord): string | null {
  if (memo.targetChatId) return memo.targetChatId;
  if (memo.roomKey.startsWith('wechat:')) {
    return memo.roomKey.slice('wechat:'.length).trim() || null;
  }
  return null;
}

export class MemoEngine {
  readonly config: MemoEngineConfig;
  readonly store: MemoStore;
  private readonly watcher: HubService;
  private readonly scout: WebScout | null;
  private readonly logger: MemoLogger;
  private readonly now: () => Date;
  private readonly rng: () => number;
  private timer: ReturnType<typeof setInterval> | null;
  private inFlight: boolean;
  private consecutiveErrors: number;
  private lastError: string | undefined;
  private nextTickAt: string | undefined;

  constructor(options: MemoEngineOptions) {
    const hub = options.hub ?? options.watcher;
    if (!hub) {
      throw new TypeError('MemoEngine requires a hub or watcher service');
    }
    this.config = normalizeMemoConfig(options.config);
    this.watcher = hub;
    this.store =
      options.store ??
      new MemoStore(hub.db, {
        maxActivePerRoom: this.config.maxActivePerRoom,
        proactiveBudgetMode: this.config.proactiveBudgetMode,
        proactiveBudgetHours: this.config.proactiveBudgetHours,
        proactiveBudgetMaxPerRoom: this.config.proactiveBudgetMaxPerRoom,
      });
    this.now = options.now ?? (() => new Date());
    this.rng = options.rng ?? Math.random;
    this.logger = options.logger ?? console;
    this.scout =
      options.scout ??
      (options.web
        ? new WebScout({
            web: options.web,
            store: this.store,
            maxResults: 8,
            now: this.now,
          })
        : null);
    this.timer = null;
    this.inFlight = false;
    this.consecutiveErrors = 0;
    this.lastError = undefined;
    this.nextTickAt = undefined;
  }

  createMemo(input: CreateMemoInput): MemoRecord {
    return this.createMemoWithIdempotency(input).memo;
  }

  createMemoWithIdempotency(input: CreateMemoInput): CreateMemoResult {
    const current = this.now();
    const prepared: CreateMemoInput = { ...input };

    if (input.kind === 'time_nudge') {
      const explicitDirect = Boolean(prepared.notifyWechatChatId?.trim());
      if (!prepared.randomFireAt) {
        if (!prepared.windowStart) {
          throw new TypeError('time_nudge memo requires windowStart and windowEnd');
        }
        const startMs = Date.parse(prepared.windowStart);
        let endMs = prepared.windowEnd ? Date.parse(prepared.windowEnd) : NaN;
        if (explicitDirect && Number.isFinite(startMs) && (!Number.isFinite(endMs) || endMs <= startMs)) {
          endMs = startMs + 30 * 60_000;
          prepared.windowEnd = new Date(endMs).toISOString();
        }
        if (!prepared.windowEnd) {
          throw new TypeError('time_nudge memo requires windowStart and windowEnd');
        }
        if (explicitDirect && Number.isFinite(startMs) && Number.isFinite(endMs) && endMs - startMs <= 10 * 60_000) {
          prepared.randomFireAt = new Date(startMs).toISOString();
          if (!prepared.expiresAt) {
            prepared.expiresAt = new Date(endMs + 15 * 60_000).toISOString();
          }
        } else {
          prepared.randomFireAt = pickRandomFireAt(
            prepared.windowStart,
            prepared.windowEnd,
            this.rng,
          );
        }
      }
      if (!prepared.expiresAt && prepared.windowEnd) {
        prepared.expiresAt = prepared.windowEnd;
      }
      prepared.nextCheckAt = prepared.randomFireAt;
    } else if (input.kind === 'news_followup') {
      const interval = clampNumber(
        Number(input.intervalHours) || this.config.newsDefaultIntervalHours,
        6,
        12,
      );
      prepared.intervalHours = interval;
      const maxExpiryIso = addHoursIso(current, this.config.newsMaxDays * 24);
      if (!prepared.expiresAt || Date.parse(prepared.expiresAt) > Date.parse(maxExpiryIso)) {
        prepared.expiresAt = maxExpiryIso;
      }
      if (!prepared.nextCheckAt) {
        prepared.nextCheckAt = addHoursIso(current, interval);
      }
    } else if (input.kind === 'long_watch') {
      const interval = clampNumber(
        Number(input.intervalHours) || this.config.longWatchDefaultIntervalHours,
        72,
        168,
      );
      prepared.intervalHours = interval;
      if (!prepared.nextCheckAt) {
        prepared.nextCheckAt = addHoursIso(current, interval);
      }
    }

    return this.store.createMemoWithIdempotency(prepared, {
      maxActivePerRoom: this.config.maxActivePerRoom,
      now: current,
    });
  }

  private readonly runTick = (): void => {
    void this.tick().catch((err) => {
      this.logger.warn?.('MemoEngine tick failed:', err);
    });
  };

  start(signal?: AbortSignal): void {
    if (this.timer) return;
    this.nextTickAt = new Date(this.now().getTime() + this.config.tickIntervalMs).toISOString();
    this.timer = setInterval(this.runTick, this.config.tickIntervalMs);
    this.timer.unref?.();
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          this.stop();
        },
        { once: true },
      );
    }
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.nextTickAt = undefined;
  }

  async tick(signal?: AbortSignal): Promise<{ polled: number; events: number; results: MemoCheckResult[] }> {
    if (this.inFlight) {
      return { polled: 0, events: 0, results: [] };
    }
    this.inFlight = true;
    const results: MemoCheckResult[] = [];
    let events = 0;

    try {
      const current = this.now();
      const due = this.store.listDueMemos(current, 50);
      for (const memo of due) {
        if (signal?.aborted) break;
        const result = await this.evaluateMemo(memo, { force: false, signal });
        results.push(result);
        if (result.eventIngested) events += 1;
      }
      this.consecutiveErrors = 0;
      this.lastError = undefined;
      this.nextTickAt = new Date(this.now().getTime() + this.config.tickIntervalMs).toISOString();
      return { polled: due.length, events, results };
    } catch (err) {
      this.consecutiveErrors += 1;
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.inFlight = false;
    }
  }

  async checkNow(memoId: string, signal?: AbortSignal): Promise<MemoCheckResult> {
    const memo = this.store.getMemo(memoId);
    if (!memo) {
      throw new Error(`Memo not found: ${memoId}`);
    }
    if (memo.status !== 'active') {
      return {
        memoId: memo.id,
        kind: memo.kind,
        action: 'skipped',
        status: memo.status,
        reason: `memo_not_active:${memo.status}`,
      };
    }
    return this.evaluateMemo(memo, { force: true, signal });
  }

  private async evaluateMemo(
    memo: MemoRecord,
    opts: { force: boolean; signal?: AbortSignal },
  ): Promise<MemoCheckResult> {
    const current = this.now();
    const nowMs = current.getTime();
    const nowIso = current.toISOString();

    const expiryIso =
      memo.expiresAt ?? (memo.kind === 'time_nudge' ? memo.windowEnd : null);
    if (expiryIso) {
      const expiryMs = Date.parse(expiryIso);
      if (Number.isFinite(expiryMs) && nowMs >= expiryMs) {
        const reason =
          memo.kind === 'time_nudge'
            ? 'missed_time_window_no_backfill'
            : 'memo_expired';
        this.store.updateMemoStatus(memo.id, 'expired', {
          resultSummary: reason,
          lastCheckedAt: nowIso,
          nextCheckAt: null,
          now: current,
        });
        return {
          memoId: memo.id,
          kind: memo.kind,
          action: 'expired',
          status: 'expired',
          reason,
        };
      }
    }

    if (memo.kind === 'time_nudge') {
      return this.evaluateTimeNudge(memo, current, opts);
    }
    return this.evaluateWebMemo(memo, current, opts);
  }

  private async evaluateTimeNudge(
    memo: MemoRecord,
    current: Date,
    opts: { force: boolean; signal?: AbortSignal },
  ): Promise<MemoCheckResult> {
    const nowMs = current.getTime();
    const nowIso = current.toISOString();

    if (!opts.force && memo.randomFireAt) {
      const fireMs = Date.parse(memo.randomFireAt);
      if (Number.isFinite(fireMs) && nowMs < fireMs) {
        return {
          memoId: memo.id,
          kind: memo.kind,
          action: 'deferred',
          status: 'active',
          reason: 'before_random_fire_at',
        };
      }
    }

    const budgetOpts = {
      mode: this.config.proactiveBudgetMode,
      windowHours: this.config.proactiveBudgetHours,
      maxPerRoom: this.config.proactiveBudgetMaxPerRoom,
      now: current,
    };
    const hasBudget = this.store.hasProactiveBudget(memo.roomKey, budgetOpts);
    if (!hasBudget) {
      const reason = 'proactive_budget_exhausted';
      const nextBudgetAt = this.store.getNextProactiveBudgetAt(memo.roomKey, budgetOpts);
      const expiryIso = memo.expiresAt ?? memo.windowEnd;
      const expiryMs = expiryIso ? Date.parse(expiryIso) : NaN;
      if (nextBudgetAt) {
        const retryMs = Math.max(nowMs + 1_000, nextBudgetAt.getTime());
        if (!Number.isFinite(expiryMs) || retryMs < expiryMs) {
          const retryIso = new Date(retryMs).toISOString();
          this.store.updateMemoSchedule(memo.id, {
            lastCheckedAt: nowIso,
            nextCheckAt: retryIso,
            randomFireAt: retryIso,
            resultSummary: `deferred:${reason}`,
            now: current,
          });
          return {
            memoId: memo.id,
            kind: memo.kind,
            action: 'deferred',
            status: 'active',
            reason,
          };
        }
      }
      this.store.updateMemoStatus(memo.id, 'torn', {
        resultSummary: reason,
        lastCheckedAt: nowIso,
        nextCheckAt: null,
        now: current,
      });
      return {
        memoId: memo.id,
        kind: memo.kind,
        action: 'torn',
        status: 'torn',
        reason,
      };
    }

    const chatId = resolveWechatChatId(memo);
    const directWechatId = memo.notifyWechatChatId?.trim() || null;
    const transport = this.watcher.getWechatTransport();

    if (directWechatId && transport) {
      try {
        const st = await transport.status();
        if (!st.healthy) {
          return {
            memoId: memo.id,
            kind: memo.kind,
            action: 'deferred',
            status: 'active',
            reason: 'wechat_transport_unhealthy',
          };
        }
      } catch {
        return {
          memoId: memo.id,
          kind: memo.kind,
          action: 'deferred',
          status: 'active',
          reason: 'wechat_transport_unhealthy',
        };
      }
    } else if (chatId && transport) {
      const atmosphere = await transport.getAtmosphere(
        {
          chatId,
          sinceMinutes: this.config.atmosphereWindowMinutes,
          limit: 30,
          quietThresholdSeconds: this.config.activeChatQuietSeconds,
        },
        opts.signal,
      );
      const decision = evaluateWechatAtmosphere(
        memo,
        atmosphere,
        this.config.activeChatQuietSeconds,
      );
      if (!decision.allow) {
        if (decision.tear) {
          this.store.updateMemoStatus(memo.id, 'torn', {
            resultSummary: `torn:${decision.reason}`,
            lastCheckedAt: nowIso,
            nextCheckAt: null,
            now: current,
          });
          return {
            memoId: memo.id,
            kind: memo.kind,
            action: 'torn',
            status: 'torn',
            reason: decision.reason,
          };
        }
        return {
          memoId: memo.id,
          kind: memo.kind,
          action: 'deferred',
          status: 'active',
          reason: decision.reason,
        };
      }
    }

    let wechatPingSent = false;
    let wechatSessionQueued = false;
    let handledSessionId: string | null = memo.targetSessionId ?? null;
    const wechatTargetId = directWechatId || chatId;

    if (wechatTargetId && transport && typeof transport.triggerMemoNudge === 'function') {
      try {
        const res = await transport.triggerMemoNudge(
          {
            memoId: memo.id,
            chatId: wechatTargetId,
            targetSessionId: memo.targetSessionId,
            title: memo.title,
            basis: memo.basis,
            windowStart: memo.windowStart,
            windowEnd: memo.windowEnd,
          },
          opts.signal,
        );
        if (res.status === 'queued') {
          wechatSessionQueued = true;
          wechatPingSent = true;
          if (typeof res.sessionId === 'string' && res.sessionId.trim()) {
            handledSessionId = res.sessionId.trim();
          }
        }
      } catch {
        wechatSessionQueued = false;
      }
    }

    if (!wechatSessionQueued && directWechatId && transport) {
      const text = memo.title
        ? `⏰ 提醒：${memo.title}\n${memo.basis}`
        : `⏰ 提醒：${memo.basis}`;
      try {
        const res = await transport.send(
          {
            chatId: directWechatId,
            text,
            idempotencyKey: `memo-nudge:${memo.id}`,
            mode: 'send',
            reason: `memo_time_nudge:${memo.id}`,
          },
          opts.signal,
        );
        wechatPingSent = res.status === 'sent' || res.status === 'staged';
      } catch {
        wechatPingSent = false;
      }
    }

    const event = this.buildMemoEvent(memo, {
      eventType: 'memo.time_nudge.due',
      summary: memo.title
        ? `[待惦记] ${memo.title} — ${memo.basis}`
        : `[待惦记] ${memo.basis}`,
      nowIso,
      extraPayload: {
        randomFireAt: memo.randomFireAt,
        windowStart: memo.windowStart,
        windowEnd: memo.windowEnd,
        wechatPingSent,
        wechatSessionQueued,
        ...(wechatSessionQueued
          ? {
              handledByWechatSession: true,
              handledSessionId,
            }
          : {}),
      },
    });

    await this.watcher.ingest(event);
    this.store.recordProactiveSend({
      roomKey: memo.roomKey,
      channel: directWechatId || chatId ? 'wechat' : 'room',
      memoId: memo.id,
      summary: event.summary,
      sentAt: nowIso,
    });
    this.store.updateMemoStatus(memo.id, 'fired', {
      resultSummary: wechatSessionQueued
        ? `fired_wechat_session:${nowIso}`
        : wechatPingSent
          ? `fired_wechat:${nowIso}`
          : `fired:${nowIso}`,
      lastCheckedAt: nowIso,
      nextCheckAt: null,
      now: current,
    });

    return {
      memoId: memo.id,
      kind: memo.kind,
      action: 'fired',
      status: 'fired',
      reason: wechatSessionQueued
        ? 'queued_to_wechat_session'
        : wechatPingSent
          ? 'delivered_to_wechat_and_room'
          : 'delivered_to_room',
      eventIngested: true,
      wechatPingSent,
    };
  }

  private async evaluateWebMemo(
    memo: MemoRecord,
    current: Date,
    opts: { force: boolean; signal?: AbortSignal },
  ): Promise<MemoCheckResult> {
    const nowIso = current.toISOString();
    if (!this.scout) {
      return {
        memoId: memo.id,
        kind: memo.kind,
        action: 'skipped',
        status: 'active',
        reason: 'web_search_unavailable',
      };
    }

    const intervalHours =
      memo.intervalHours ??
      (memo.kind === 'news_followup'
        ? this.config.newsDefaultIntervalHours
        : this.config.longWatchDefaultIntervalHours);
    const nextCheckAt = addHoursIso(current, intervalHours);

    const outcome = await this.scout.scout(memo, opts.signal);
    if (!outcome.matched || !outcome.topCandidate) {
      this.store.updateMemoSchedule(memo.id, {
        lastCheckedAt: nowIso,
        nextCheckAt,
        resultSummary: outcome.summary,
        now: current,
      });
      return {
        memoId: memo.id,
        kind: memo.kind,
        action: 'deferred',
        status: 'active',
        reason: 'no_qualifying_update',
        scoutOutcome: outcome,
      };
    }

    const top = outcome.topCandidate;
    const chatId = resolveWechatChatId(memo);
    const transport = this.watcher.getWechatTransport();

    if (chatId && transport) {
      const atmosphere = await transport.getAtmosphere(
        {
          chatId,
          sinceMinutes: this.config.atmosphereWindowMinutes,
          limit: 30,
          quietThresholdSeconds: this.config.activeChatQuietSeconds,
        },
        opts.signal,
      );
      const decision = evaluateWechatAtmosphere(
        memo,
        atmosphere,
        this.config.activeChatQuietSeconds,
        top.url,
      );
      if (!decision.allow) {
        if (decision.tear) {
          this.store.updateMemoStatus(memo.id, 'torn', {
            resultSummary: `torn:${decision.reason}`,
            lastCheckedAt: nowIso,
            nextCheckAt: null,
            now: current,
          });
          return {
            memoId: memo.id,
            kind: memo.kind,
            action: 'torn',
            status: 'torn',
            reason: decision.reason,
            scoutOutcome: outcome,
          };
        }
        this.store.updateMemoSchedule(memo.id, {
          lastCheckedAt: nowIso,
          nextCheckAt: addHoursIso(current, 1),
          resultSummary: `deferred:${decision.reason}`,
          now: current,
        });
        return {
          memoId: memo.id,
          kind: memo.kind,
          action: 'deferred',
          status: 'active',
          reason: decision.reason,
          scoutOutcome: outcome,
        };
      }

      const budgetOpts = {
        mode: this.config.proactiveBudgetMode,
        windowHours: this.config.proactiveBudgetHours,
        maxPerRoom: this.config.proactiveBudgetMaxPerRoom,
        now: current,
      };
      const hasBudget = this.store.hasProactiveBudget(memo.roomKey, budgetOpts);
      if (!hasBudget) {
        const nextBudgetAt = this.store.getNextProactiveBudgetAt(memo.roomKey, budgetOpts);
        const fallbackIso = addHoursIso(current, 4);
        const retryIso =
          nextBudgetAt && nextBudgetAt.getTime() > current.getTime()
            ? new Date(Math.min(nextBudgetAt.getTime(), Date.parse(fallbackIso))).toISOString()
            : fallbackIso;
        this.store.updateMemoSchedule(memo.id, {
          lastCheckedAt: nowIso,
          nextCheckAt: retryIso,
          resultSummary: 'deferred:proactive_budget_exhausted',
          now: current,
        });
        return {
          memoId: memo.id,
          kind: memo.kind,
          action: 'deferred',
          status: 'active',
          reason: 'proactive_budget_exhausted',
          scoutOutcome: outcome,
        };
      }
    }

    const eventType =
      memo.kind === 'long_watch' ? 'memo.long_watch.matched' : 'memo.news_followup.matched';
    const summary =
      memo.kind === 'long_watch'
        ? `[官宣命中] ${memo.title || memo.basis}: ${top.title} (${top.url})`
        : `[新闻后续] ${memo.title || memo.basis}: ${top.title} (${top.url})`;

    const event = this.buildMemoEvent(memo, {
      eventType,
      summary,
      nowIso,
      rawUrl: top.url,
      extraPayload: {
        query: outcome.query,
        matchedTitle: top.title,
        matchedUrl: top.url,
        matchedSnippet: top.snippet,
        matchedDomain: top.domain,
        publishedAt: top.publishedAt,
        reasons: top.reasons,
        acceptCriteria: memo.acceptCriteria,
      },
    });

    await this.watcher.ingest(event);

    if (chatId) {
      this.store.recordProactiveSend({
        roomKey: memo.roomKey,
        channel: 'wechat',
        memoId: memo.id,
        summary,
        sentAt: nowIso,
      });
    }

    let wechatPingSent = false;
    const notifyChatId =
      memo.notifyWechatChatId ||
      (memo.kind === 'long_watch' ? this.config.defaultNotifyWechatChatId : '');
    if (notifyChatId && notifyChatId !== chatId) {
      wechatPingSent = await this.sendCrossChannelWechatPing(
        memo,
        notifyChatId,
        top.title,
        top.url,
        nowIso,
        opts.signal,
      );
    }

    this.store.updateMemoStatus(memo.id, 'completed', {
      resultSummary: `${top.title} | ${top.url}`,
      lastCheckedAt: nowIso,
      nextCheckAt: null,
      now: current,
      metadata: {
        matchedUrl: top.url,
        matchedTitle: top.title,
        wechatPingSent,
      },
    });

    return {
      memoId: memo.id,
      kind: memo.kind,
      action: 'completed',
      status: 'completed',
      reason: 'matched_and_delivered',
      eventIngested: true,
      wechatPingSent,
      scoutOutcome: outcome,
    };
  }

  private async sendCrossChannelWechatPing(
    memo: MemoRecord,
    notifyChatId: string,
    matchedTitle: string,
    matchedUrl: string,
    nowIso: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const label = memo.title || memo.roomKey;
    const text = `你挂着的「${label}」有官方动静了：${matchedTitle}\n链接：${matchedUrl}`;
    const idempotencyKey = `memo-ping:${memo.id}:${notifyChatId}`;

    let delivered = false;
    try {
      const sinkRes = await this.watcher.invokeSink(
        'wxarc.send',
        {
          action: 'send',
          target: { chatId: notifyChatId },
          payload: {
            text,
            memoId: memo.id,
            roomKey: memo.roomKey,
            url: matchedUrl,
          },
          idempotencyKey,
          sessionId: memo.targetSessionId ?? undefined,
        },
        signal,
      );
      if (sinkRes.status === 'executed' || sinkRes.status === 'staged') {
        delivered = true;
      }
    } catch {
      delivered = false;
    }

    if (!delivered) {
      const transport = this.watcher.getWechatTransport();
      if (transport) {
        const res = await transport.send(
          {
            chatId: notifyChatId,
            text,
            idempotencyKey,
            reason: `memo.${memo.kind}.notify`,
          },
          signal,
        );
        delivered = res.status === 'sent' || res.status === 'staged';
      }
    }

    if (delivered) {
      this.store.recordProactiveSend({
        roomKey: `wechat:${notifyChatId}`,
        channel: 'wechat',
        memoId: memo.id,
        summary: text,
        sentAt: nowIso,
      });
    }
    return delivered;
  }

  private buildMemoEvent(
    memo: MemoRecord,
    params: {
      eventType: string;
      summary: string;
      nowIso: string;
      rawUrl?: string;
      extraPayload?: Record<string, unknown>;
    },
  ): NormalizedEvent {
    const dedupeSuffix = params.rawUrl ? params.rawUrl : params.nowIso;
    return {
      id: `evt_memo_${randomUUID()}`,
      source: 'memo',
      type: params.eventType,
      dedupeKey: `memo:${memo.id}:${params.eventType}:${dedupeSuffix}`,
      threadKey: memo.roomKey,
      entityKey: memo.roomKey,
      actor: {
        id: 'system:memo',
        login: 'memo',
        displayName: '待惦记便签',
        isBot: false,
      },
      trustLevel: 'system',
      occurredAt: params.nowIso,
      summary: params.summary,
      payload: {
        memoId: memo.id,
        kind: memo.kind,
        roomKey: memo.roomKey,
        targetSessionId: memo.targetSessionId,
        targetChatId: memo.targetChatId,
        title: memo.title,
        basis: memo.basis,
        keywords: memo.keywords,
        knownFacts: memo.knownFacts,
        notifyWechatChatId: memo.notifyWechatChatId,
        ...(params.extraPayload ?? {}),
      },
      rawRef: params.rawUrl ? { url: params.rawUrl, externalId: memo.id } : { externalId: memo.id },
    };
  }

  asWatchSource(): WatchSource {
    return {
      id: 'memo',
      label: 'Proactive Memo Engine',
      pollNow: async (watchId?: string, signal?: AbortSignal) => {
        if (watchId) {
          const res = await this.checkNow(watchId, signal);
          return { polled: 1, events: res.eventIngested ? 1 : 0 };
        }
        const res = await this.tick(signal);
        return { polled: res.polled, events: res.events };
      },
      health: () => ({
        ok: this.consecutiveErrors === 0,
        consecutiveErrors: this.consecutiveErrors,
        lastError: this.lastError,
        nextPollAt: this.nextTickAt,
      }),
      dispose: () => {
        this.stop();
      },
    };
  }
}

export function createMemoEngine(options: MemoEngineOptions): MemoEngine {
  return new MemoEngine(options);
}
