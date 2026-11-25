import { randomUUID } from 'node:crypto';
import type {
  ActionSink,
  ActionTier,
  AdminWechatHandleResult,
  AdminWechatHandler,
  AdminWechatMessage,
  ConnectorDescriptor,
  ConnectorSummary,
  DoorGuard,
  EntityResolver,
  GitHubAdminAdapter,
  HubService,
  InboxItem,
  IngestResult,
  NormalizedEvent,
  PersonaWardrobe,
  RegisterSubscriptionInput,
  RoutingRule,
  SinkInvokeInput,
  SinkInvokeResult,
  StagedDraft,
  ThreadSubscription,
  UnclaimedEventHandler,
  WatchSource,
  WatchStatus,
  WatcherDb,
  WechatTransport,
  WechatTransportStatus,
  WorkstreamRecord,
} from './contracts.js';
import type { MemoEngineLike } from './http-routes.js';
import { buildFastPathPrompt, buildWakeupPrompt, matchRoutingRule, resolveEffectiveTier } from './posterior.js';
import type { SessionBridge } from './session-bridge.js';

export interface HubContextLike {
  effect?: (callback: () => (() => void) | void) => void;
  get?: (name: string) => unknown;
  personaWardrobe?: PersonaWardrobe;
}

export type WatcherContextLike = HubContextLike;

export interface HubServiceDeps {
  db: WatcherDb;
  guard: DoorGuard;
  wardrobe?: PersonaWardrobe | null;
  getWardrobe?: () => PersonaWardrobe | null;
  sessionBridge?: SessionBridge | null;
  defaultTtlHours?: number;
  maxAutoSessionsPerHour?: number;
}

export type WatcherServiceDeps = HubServiceDeps;

type SqlRow = Record<string, unknown>;

const nowIso = (): string => new Date().toISOString();

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function previewOf(action: string, payload: Record<string, unknown>): string {
  const candidate = payload.text ?? payload.body ?? payload.summary ?? payload.message;
  if (typeof candidate === 'string' && candidate.trim()) return candidate.slice(0, 400);
  if (Array.isArray(candidate)) return candidate.map(String).join('\n').slice(0, 400);
  return `${action}: ${JSON.stringify(payload).slice(0, 320)}`;
}

const VALID_ACTION_TIERS = new Set<ActionTier>(['inbox-only', 'triage', 'review', 'autonomous']);

function parsePositiveInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value.trim())) return Number(value.trim());
  return null;
}

function extractGitHubRepo(event: NormalizedEvent): string | null {
  if (typeof event.rawRef?.repo === 'string' && event.rawRef.repo.trim()) {
    return event.rawRef.repo.trim();
  }
  const payloadRepo = event.payload?.repo;
  if (typeof payloadRepo === 'string' && payloadRepo.trim()) {
    return payloadRepo.trim();
  }
  const match = /^github:([^#\s]+)#\d+$/.exec(event.threadKey);
  return match?.[1]?.trim() || null;
}

function extractLinkedIssueNumbers(payload: Record<string, unknown> | undefined): number[] {
  if (!payload) return [];
  const nums: number[] = [];
  const seen = new Set<number>();
  const add = (value: unknown): void => {
    const parsed = parsePositiveInt(value);
    if (parsed !== null && !seen.has(parsed)) {
      seen.add(parsed);
      nums.push(parsed);
    }
  };
  if (Array.isArray(payload.linkedIssues)) {
    for (const item of payload.linkedIssues) add(item);
  }
  add(payload.linkedFromIssue);
  return nums;
}

export class HubRuntime implements HubService {
  readonly db: WatcherDb;
  readonly guard: DoorGuard;
  private readonly ctx?: HubContextLike;
  private readonly wardrobeOverride: PersonaWardrobe | null;
  private readonly getWardrobeFn?: () => PersonaWardrobe | null;
  private readonly sessionBridge: SessionBridge | null;
  private readonly defaultTtlHours: number;
  private readonly maxAutoSessionsPerHour: number;
  private readonly connectors = new Map<string, ConnectorDescriptor>();
  private readonly unclaimedHandlers = new Set<UnclaimedEventHandler>();
  private readonly adminWechatHandlers = new Set<AdminWechatHandler>();
  private readonly sources = new Map<string, WatchSource>();
  private readonly resolvers = new Map<string, EntityResolver>();
  private readonly sinks = new Map<string, ActionSink>();
  private readonly rules = new Map<string, RoutingRule>();
  private wechatTransport: WechatTransport | null = null;
  private memoEngineRef: MemoEngineLike | null = null;
  private githubAdminRef: GitHubAdminAdapter | null = null;
  private transportMode: WechatTransportStatus['mode'] = 'unavailable';

  constructor(ctx: HubContextLike | undefined, deps: HubServiceDeps) {
    this.ctx = ctx;
    this.db = deps.db;
    this.guard = deps.guard;
    this.wardrobeOverride = deps.wardrobe ?? null;
    this.getWardrobeFn = deps.getWardrobe;
    this.sessionBridge = deps.sessionBridge ?? null;
    this.defaultTtlHours = deps.defaultTtlHours ?? 72;
    this.maxAutoSessionsPerHour = deps.maxAutoSessionsPerHour ?? 12;
    this.recoverOrphanedSinks();
  }

  get wardrobe(): PersonaWardrobe | null {
    return this.getWardrobe();
  }

  getWardrobe(): PersonaWardrobe | null {
    if (this.getWardrobeFn) {
      const fromFn = this.getWardrobeFn();
      if (fromFn) return fromFn;
    }
    if (typeof this.ctx?.get === 'function') {
      const fromCtx = this.ctx.get('personaWardrobe') as PersonaWardrobe | undefined;
      if (fromCtx) return fromCtx;
    } else if (this.ctx?.personaWardrobe) {
      return this.ctx.personaWardrobe;
    }
    return this.wardrobeOverride;
  }

  get configRevision(): number {
    return Number(this.db.getMeta('config_revision', '1') ?? '1') || 1;
  }

  get memoEngine(): MemoEngineLike | undefined {
    return this.memoEngineRef ?? undefined;
  }

  private bindCleanup(cleanup: () => void): () => void {
    let done = false;
    const dispose = (): void => {
      if (done) return;
      done = true;
      cleanup();
    };
    this.ctx?.effect?.(() => dispose);
    return dispose;
  }

  registerConnector(desc: ConnectorDescriptor): () => void {
    this.connectors.set(desc.id, desc);
    return this.bindCleanup(() => {
      if (this.connectors.get(desc.id) === desc) this.connectors.delete(desc.id);
    });
  }

  listConnectors(): ConnectorSummary[] {
    return [...this.connectors.values()].map((c) => ({
      id: c.id,
      label: c.label,
      kind: c.kind,
      panelId: c.panelId,
      panelLabel: c.panelLabel,
      health: c.health?.(),
    }));
  }

  registerSubscription(input: RegisterSubscriptionInput): ThreadSubscription {
    const now = nowIso();
    const id = randomUUID();
    const owner = input.owner?.trim() || 'manual';
    const status = input.status?.trim() || 'active';
    const metadataJson = JSON.stringify(input.metadata ?? {});
    this.db.db
      .prepare(
        `INSERT INTO thread_subscriptions (
           id, source, thread_key, workstream_id, session_id, persona_id,
           owner, status, metadata_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source, thread_key) DO UPDATE SET
           workstream_id = excluded.workstream_id,
           session_id = excluded.session_id,
           persona_id = excluded.persona_id,
           owner = excluded.owner,
           status = excluded.status,
           metadata_json = excluded.metadata_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        input.source,
        input.threadKey,
        input.workstreamId ?? null,
        input.sessionId,
        input.personaId ?? null,
        owner,
        status,
        metadataJson,
        now,
        now,
      );
    const row = this.db.db
      .prepare('SELECT * FROM thread_subscriptions WHERE source = ? AND thread_key = ?')
      .get(input.source, input.threadKey) as SqlRow;
    return this.mapSubscription(row);
  }

  resolveSubscription(source: string, threadKey: string): ThreadSubscription | null {
    const row = this.db.db
      .prepare("SELECT * FROM thread_subscriptions WHERE source = ? AND thread_key = ? AND status = 'active'")
      .get(source, threadKey) as SqlRow | undefined;
    return row ? this.mapSubscription(row) : null;
  }

  removeSubscription(source: string, threadKey: string): boolean {
    const res = this.db.db
      .prepare('DELETE FROM thread_subscriptions WHERE source = ? AND thread_key = ?')
      .run(source, threadKey);
    return Number(res.changes ?? 0) > 0;
  }

  listSubscriptions(filter?: { source?: string; status?: string }): ThreadSubscription[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter?.source) {
      clauses.push('source = ?');
      params.push(filter.source);
    }
    if (filter?.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.db
      .prepare(`SELECT * FROM thread_subscriptions ${where} ORDER BY updated_at DESC`)
      .all(...params) as SqlRow[];
    return rows.map((r) => this.mapSubscription(r));
  }

  onUnclaimedEvent(handler: UnclaimedEventHandler): () => void {
    this.unclaimedHandlers.add(handler);
    return this.bindCleanup(() => {
      this.unclaimedHandlers.delete(handler);
    });
  }

  registerSource(source: WatchSource): () => void {
    this.sources.set(source.id, source);
    return this.bindCleanup(() => {
      if (this.sources.get(source.id) === source) this.sources.delete(source.id);
      void source.dispose?.();
    });
  }

  registerResolver(resolver: EntityResolver): () => void {
    this.resolvers.set(resolver.id, resolver);
    return this.bindCleanup(() => {
      if (this.resolvers.get(resolver.id) === resolver) this.resolvers.delete(resolver.id);
    });
  }

  registerSink(sink: ActionSink): () => void {
    this.sinks.set(sink.id, sink);
    return this.bindCleanup(() => {
      if (this.sinks.get(sink.id) === sink) this.sinks.delete(sink.id);
    });
  }

  registerRule(rule: RoutingRule): () => void {
    this.rules.set(rule.id, rule);
    return this.bindCleanup(() => {
      if (this.rules.get(rule.id) === rule) this.rules.delete(rule.id);
    });
  }

  registerWechatTransport(transport: WechatTransport): () => void {
    this.wechatTransport = transport;
    this.transportMode = 'cordis';
    void transport.status().then((st) => {
      if (this.wechatTransport === transport) this.transportMode = st.mode;
    }).catch(() => {});
    return this.bindCleanup(() => {
      if (this.wechatTransport === transport) {
        this.wechatTransport = null;
        this.transportMode = 'unavailable';
      }
    });
  }

  getWechatTransport(): WechatTransport | null {
    return this.wechatTransport;
  }

  registerAdminWechatHandler(handler: AdminWechatHandler): () => void {
    this.adminWechatHandlers.add(handler);
    return this.bindCleanup(() => {
      this.adminWechatHandlers.delete(handler);
    });
  }

  async dispatchAdminWechatMessage(message: AdminWechatMessage): Promise<AdminWechatHandleResult> {
    for (const handler of [...this.adminWechatHandlers]) {
      try {
        const res = await handler(message);
        if (res?.handled === true) {
          return res;
        }
      } catch {}
    }
    return { handled: false };
  }

  registerMemoEngine(engine: MemoEngineLike): () => void {
    this.memoEngineRef = engine;
    return this.bindCleanup(() => {
      if (this.memoEngineRef === engine) this.memoEngineRef = null;
    });
  }

  getMemoEngine(): MemoEngineLike | null {
    return this.memoEngineRef;
  }

  registerGitHubAdmin(admin: GitHubAdminAdapter): () => void {
    this.githubAdminRef = admin;
    return this.bindCleanup(() => {
      if (this.githubAdminRef === admin) this.githubAdminRef = null;
    });
  }

  getGitHubAdmin(): GitHubAdminAdapter | null {
    return this.githubAdminRef;
  }

  recoverOrphanedSinks(): number {
    const res = this.db.db
      .prepare(`UPDATE staged_drafts SET status = 'uncertain', updated_at = ? WHERE status = 'executing'`)
      .run(nowIso());
    return Number(res.changes ?? 0);
  }

  tick = async (): Promise<{ expiredWorkstreams: number }> => {
    this.db.touchLeaseHeartbeat();
    const now = nowIso();
    const res = this.db.db
      .prepare(
        `UPDATE workstreams SET status = 'ended', end_reason = 'ttl_expired', updated_at = ?
         WHERE status IN ('active', 'awaiting_agent') AND ttl_expires_at <= ?`,
      )
      .run(now, now);
    return { expiredWorkstreams: Number(res.changes ?? 0) };
  };

  async pollSourceNow(sourceId: string): Promise<{ polled: number; events: number }> {
    const source = this.sources.get(sourceId);
    if (!source?.pollNow) return { polled: 0, events: 0 };
    return source.pollNow();
  }

  cancelWorkstream(id: string, reason = 'cancelled'): boolean {
    const res = this.db.db
      .prepare(`UPDATE workstreams SET status = 'ended', end_reason = ?, updated_at = ? WHERE id = ? AND status != 'ended'`)
      .run(reason, nowIso(), id);
    return Number(res.changes ?? 0) > 0;
  }

  async ingest(event: NormalizedEvent): Promise<IngestResult> {
    const existing = this.db.db
      .prepare('SELECT id FROM inbox_items WHERE dedupe_key = ? OR event_id = ?')
      .get(event.dedupeKey, event.id) as { id?: string } | undefined;
    if (existing?.id) return { accepted: false, deduped: true, inboxId: existing.id };

    const gate = await this.guard.beforeEnterRoom({
      hook: 'beforeEnterRoom',
      source: event.source,
      roomKey: event.threadKey,
      event,
    });
    if (!gate.allow) return { accepted: false };

    const now = nowIso();
    const inboxId = randomUUID();
    const actorLabel = event.actor.login ?? event.actor.displayName ?? event.actor.id;

    if (event.payload?.handledByWechatSession === true) {
      const handledSessionId =
        typeof event.payload.handledSessionId === 'string' && event.payload.handledSessionId.trim()
          ? event.payload.handledSessionId.trim()
          : typeof event.payload.targetSessionId === 'string' && event.payload.targetSessionId.trim()
            ? event.payload.targetSessionId.trim()
            : null;
      this.db.db
        .prepare(
          `INSERT INTO inbox_items (
             id, event_id, dedupe_key, thread_key, source, type, entity_key,
             workstream_id, session_id, actor, actor_is_bot, trust_level, summary,
             payload_json, tier, pre_gate_tags, status, raw_url, occurred_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'inbox-only', '[]', 'resolved', ?, ?, ?, ?)`,
        )
        .run(
          inboxId,
          event.id,
          event.dedupeKey,
          event.threadKey,
          event.source,
          event.type,
          event.entityKey ?? null,
          handledSessionId,
          actorLabel,
          event.actor.isBot ? 1 : 0,
          event.trustLevel,
          event.summary,
          JSON.stringify(event.payload ?? {}),
          event.rawRef?.url ?? null,
          event.occurredAt,
          now,
          now,
        );
      return { accepted: true, inboxId, routedVia: 'inbox' };
    }

    let subscription = this.resolveSubscription(event.source, event.threadKey);
    if (!subscription && event.source === 'github') {
      subscription = this.inheritGitHubLinkedSubscription(event);
    }
    if (subscription) {
      const metaTier = subscription.metadata?.tier;
      const tier: ActionTier =
        typeof metaTier === 'string' && VALID_ACTION_TIERS.has(metaTier as ActionTier)
          ? (metaTier as ActionTier)
          : 'triage';
      this.db.db
        .prepare(
          `INSERT INTO inbox_items (
             id, event_id, dedupe_key, thread_key, source, type, entity_key,
             workstream_id, session_id, actor, actor_is_bot, trust_level, summary,
             payload_json, tier, pre_gate_tags, status, raw_url, occurred_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 'unread', ?, ?, ?, ?)`,
        )
        .run(
          inboxId,
          event.id,
          event.dedupeKey,
          event.threadKey,
          event.source,
          event.type,
          event.entityKey ?? null,
          subscription.workstreamId,
          subscription.sessionId,
          actorLabel,
          event.actor.isBot ? 1 : 0,
          event.trustLevel,
          event.summary,
          JSON.stringify(event.payload ?? {}),
          tier,
          event.rawRef?.url ?? null,
          event.occurredAt,
          now,
          now,
        );

      if (subscription.sessionId && this.sessionBridge) {
        const scopeKey = subscription.workstreamId ?? `${subscription.source}:${subscription.threadKey}`;
        const personaCard = subscription.personaId
          ? (this.getWardrobe()?.getDynamicCard({
              personaId: subscription.personaId,
              scope: scopeKey,
              channel: event.source,
            }) ?? null)
          : null;
        const prompt = buildFastPathPrompt({ subscription, event, tier, personaCard });
        const delivered = await this.sessionBridge.deliverToSession(subscription.sessionId, {
          text: prompt,
          workstreamId: subscription.workstreamId ?? undefined,
          workstreamKey: `${subscription.source}:${subscription.threadKey}`,
          source: event.source,
          eventIds: [event.id],
          tier,
          trust: event.trustLevel,
          personaId: subscription.personaId ?? null,
          scope: scopeKey,
        });
        if (delivered.ok && subscription.workstreamId) {
          this.db.db
            .prepare('UPDATE workstreams SET last_wakeup_at = ?, updated_at = ? WHERE id = ?')
            .run(nowIso(), nowIso(), subscription.workstreamId);
        }
      }

      return { accepted: true, inboxId, routedVia: 'subscription' };
    }

    let inboxInserted = false;
    if (this.unclaimedHandlers.size > 0) {
      this.db.db
        .prepare(
          `INSERT INTO inbox_items (
             id, event_id, dedupe_key, thread_key, source, type, entity_key,
             actor, actor_is_bot, trust_level, summary, payload_json, tier,
             pre_gate_tags, status, raw_url, occurred_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'inbox-only', '[]', 'unread', ?, ?, ?, ?)`,
        )
        .run(
          inboxId,
          event.id,
          event.dedupeKey,
          event.threadKey,
          event.source,
          event.type,
          event.entityKey ?? null,
          actorLabel,
          event.actor.isBot ? 1 : 0,
          event.trustLevel,
          event.summary,
          JSON.stringify(event.payload ?? {}),
          event.rawRef?.url ?? null,
          event.occurredAt,
          now,
          now,
        );
      inboxInserted = true;

      for (const handler of [...this.unclaimedHandlers]) {
        const res = await handler(event, { inboxId });
        if (res?.handled) {
          const claimed = res.subscription ?? this.resolveSubscription(event.source, event.threadKey);
          if (claimed) {
            this.db.db
              .prepare(
                `UPDATE inbox_items SET workstream_id = ?, session_id = ?, tier = 'triage', updated_at = ? WHERE id = ?`,
              )
              .run(claimed.workstreamId, claimed.sessionId, nowIso(), inboxId);
          }
          return { accepted: true, inboxId, routedVia: 'router' };
        }
      }
    }

    const rule = matchRoutingRule(event, [...this.rules.values()]);
    const resolver = rule.handler.resolver
      ? this.resolvers.get(rule.handler.resolver)
      : [...this.resolvers.values()].find((r) => r.sources.includes(event.source) || r.sources.includes('*'));
    const resolved = resolver ? await resolver.resolve(event) : null;
    const { tier } = resolveEffectiveTier(rule.handler, event, resolved);

    const entityKey = event.entityKey ?? resolved?.workstreamKey ?? null;
    if (inboxInserted) {
      this.db.db
        .prepare('UPDATE inbox_items SET entity_key = ?, tier = ?, pre_gate_tags = ?, updated_at = ? WHERE id = ?')
        .run(entityKey, tier, JSON.stringify(resolved?.preGateTags ?? []), nowIso(), inboxId);
    } else {
      this.db.db
        .prepare(
          `INSERT INTO inbox_items (
             id, event_id, dedupe_key, thread_key, source, type, entity_key,
             actor, actor_is_bot, trust_level, summary, payload_json, tier,
             pre_gate_tags, status, raw_url, occurred_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unread', ?, ?, ?, ?)`,
        )
        .run(
          inboxId,
          event.id,
          event.dedupeKey,
          event.threadKey,
          event.source,
          event.type,
          entityKey,
          actorLabel,
          event.actor.isBot ? 1 : 0,
          event.trustLevel,
          event.summary,
          JSON.stringify(event.payload ?? {}),
          tier,
          JSON.stringify(resolved?.preGateTags ?? []),
          event.rawRef?.url ?? null,
          event.occurredAt,
          now,
          now,
        );
    }

    if (tier === 'inbox-only' || rule.handler.sessionPolicy === 'none' || !resolved?.workspacePath) {
      return { accepted: true, inboxId, routedVia: 'inbox' };
    }

    const workstream = this.upsertWorkstream(event, resolved, tier, rule.handler.maxWakeups ?? 3);
    const sessionId = await this.resolveOrSpawnSession(workstream, resolved, rule.handler);
    this.db.db
      .prepare('UPDATE inbox_items SET workstream_id = ?, session_id = ?, updated_at = ? WHERE id = ?')
      .run(workstream.id, sessionId, nowIso(), inboxId);

    if (sessionId && this.sessionBridge) {
      const personaCard = rule.handler.persona
        ? (this.getWardrobe()?.getDynamicCard({
            personaId: rule.handler.persona,
            scope: workstream.workstreamKey,
            channel: event.source,
          }) ?? null)
        : null;
      const prompt = buildWakeupPrompt({ workstream, events: [event], resolvedEntity: resolved, handler: rule.handler, tier, personaCard });
      const delivered = await this.sessionBridge.deliverToSession(sessionId, {
        text: prompt,
        workstreamId: workstream.id,
        workstreamKey: workstream.workstreamKey,
        source: event.source,
        eventIds: [event.id],
        tier,
        trust: event.trustLevel,
        allowedTools: rule.handler.allowedTools,
        deliveryMode: rule.handler.deliveryMode,
        personaId: rule.handler.persona ?? null,
        scope: workstream.workstreamKey,
      });
      if (delivered.ok) {
        this.db.db
          .prepare('UPDATE workstreams SET last_wakeup_at = ?, updated_at = ? WHERE id = ?')
          .run(nowIso(), nowIso(), workstream.id);
      }
    }

    return { accepted: true, inboxId, routedVia: 'rule' };
  }

  private inheritGitHubLinkedSubscription(event: NormalizedEvent): ThreadSubscription | null {
    const linkedIssues = extractLinkedIssueNumbers(event.payload);
    if (linkedIssues.length === 0) return null;
    const repo = extractGitHubRepo(event);
    if (!repo) return null;
    for (const issueNum of linkedIssues) {
      const parentThreadKey = `github:${repo}#${issueNum}`;
      if (parentThreadKey === event.threadKey) continue;
      const parentSub = this.resolveSubscription('github', parentThreadKey);
      if (parentSub) {
        return this.registerSubscription({
          source: event.source,
          threadKey: event.threadKey,
          workstreamId: parentSub.workstreamId,
          sessionId: parentSub.sessionId,
          personaId: parentSub.personaId,
          owner: parentSub.owner,
          metadata: {
            ...parentSub.metadata,
            linkedFromThreadKey: parentSub.threadKey,
          },
        });
      }
    }
    return null;
  }

  private upsertWorkstream(
    event: NormalizedEvent,
    resolved: NonNullable<Awaited<ReturnType<EntityResolver['resolve']>>>,
    tier: InboxItem['tier'],
    maxWakeups: number,
  ): WorkstreamRecord {
    const now = nowIso();
    const existing = this.db.db
      .prepare('SELECT * FROM workstreams WHERE workstream_key = ?')
      .get(resolved.workstreamKey) as SqlRow | undefined;
    const entityKey = event.entityKey ?? resolved.workstreamKey;
    if (existing) {
      const keys = Array.from(new Set([...parseJson<string[]>(existing.entity_keys_json, []), entityKey]));
      const sessionId = (existing.session_id as string | null) ?? resolved.targetSessionId ?? null;
      this.db.db
        .prepare('UPDATE workstreams SET entity_keys_json = ?, session_id = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(keys), sessionId, now, String(existing.id));
      return this.mapWorkstream({ ...existing, entity_keys_json: JSON.stringify(keys), session_id: sessionId, updated_at: now });
    }

    const id = randomUUID();
    const ttl = new Date(Date.now() + this.defaultTtlHours * 3600_000).toISOString();
    const trustMode = tier === 'autonomous' ? 'autonomous' : 'triage';
    this.db.db
      .prepare(
        `INSERT INTO workstreams (
           id, source, workstream_key, primary_entity_key, entity_keys_json,
           workspace_path, session_id, status, mode, trust_mode,
           delivery_count, max_wakeups, ttl_expires_at, config_revision, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'repeat', ?, 0, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        event.source,
        resolved.workstreamKey,
        entityKey,
        JSON.stringify([entityKey]),
        resolved.workspacePath ?? '',
        resolved.targetSessionId ?? null,
        trustMode,
        maxWakeups,
        ttl,
        this.configRevision,
        now,
        now,
      );
    const row = this.db.db.prepare('SELECT * FROM workstreams WHERE id = ?').get(id) as SqlRow;
    return this.mapWorkstream(row);
  }

  private async resolveOrSpawnSession(
    workstream: WorkstreamRecord,
    resolved: NonNullable<Awaited<ReturnType<EntityResolver['resolve']>>>,
    handler: RoutingRule['handler'],
  ): Promise<string | null> {
    if (handler.sessionPolicy !== 'ephemeral-review' && workstream.sessionId) return workstream.sessionId;
    if (handler.sessionPolicy === 'reuse-only' || !this.sessionBridge || !resolved.workspacePath) return workstream.sessionId;
    if (this.countAutoSessionsThisHour() >= this.maxAutoSessionsPerHour) return workstream.sessionId;

    const created = await this.sessionBridge.createRootSession(
      resolved.workspacePath,
      resolved.suggestedTitle ?? workstream.primaryEntityKey,
      {
        agentPreset: handler.agentPreset,
        unattendedReadOnly: handler.tier !== 'autonomous',
        personaId: handler.persona ?? null,
        scope: workstream.workstreamKey,
      },
    );
    this.db.db
      .prepare(`INSERT INTO circuit_breaker_log (bucket, ref_key, created_at) VALUES ('auto_session', ?, ?)`)
      .run(created.sessionId, nowIso());
    if (handler.sessionPolicy !== 'ephemeral-review') {
      this.db.db
        .prepare('UPDATE workstreams SET session_id = ?, updated_at = ? WHERE id = ?')
        .run(created.sessionId, nowIso(), workstream.id);
    }
    return created.sessionId;
  }

  async invokeSink(sinkId: string, input: SinkInvokeInput, signal?: AbortSignal): Promise<SinkInvokeResult> {
    const sink = this.sinks.get(sinkId);
    if (!sink) return { status: 'failed', detail: `sink_not_found:${sinkId}` };

    const gate = await this.guard.beforeSendOut({
      hook: 'beforeSendOut',
      sinkId,
      action: input.action,
      sessionId: input.sessionId ?? null,
      target: input.target,
      payload: input.payload,
    });
    if (!gate.allow) return { status: 'skipped', detail: gate.reason ?? 'blocked_by_guard' };

    if (input.sessionId && this.sessionBridge?.isTakenOver(input.sessionId)) {
      return { status: 'skipped', detail: 'suppressed_takeover' };
    }

    const existing = this.db.db
      .prepare('SELECT id, status FROM staged_drafts WHERE idempotency_key = ?')
      .get(input.idempotencyKey) as { id?: string; status?: StagedDraft['status'] } | undefined;
    if (existing?.id) {
      if (existing.status === 'pending_approval') return { status: 'staged', draftId: existing.id };
      if (existing.status === 'executed') return { status: 'skipped', draftId: existing.id, detail: 'duplicate_idempotency_key' };
      return { status: 'uncertain', draftId: existing.id, detail: `existing_status:${existing.status}` };
    }

    const now = nowIso();
    const draftId = randomUUID();
    const shouldStage = sink.kind === 'staged-draft' || Boolean(sink.requiresApproval) || Boolean(input.stageOnly);
    const initialStatus: StagedDraft['status'] = shouldStage ? 'pending_approval' : 'executing';
    this.db.db
      .prepare(
        `INSERT INTO staged_drafts (
           id, sink_id, sink_kind, action, session_id, target_json, payload_json,
           preview_text, idempotency_key, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        draftId,
        sinkId,
        sink.kind,
        input.action,
        input.sessionId ?? null,
        JSON.stringify(input.target ?? {}),
        JSON.stringify(input.payload ?? {}),
        previewOf(input.action, input.payload),
        input.idempotencyKey,
        initialStatus,
        now,
        now,
      );

    if (shouldStage) return { status: 'staged', draftId };
    return this.executeDraftRecord(draftId, sink, input, signal);
  }

  private async executeDraftRecord(
    draftId: string,
    sink: ActionSink,
    input: SinkInvokeInput,
    signal?: AbortSignal,
  ): Promise<SinkInvokeResult> {
    try {
      const result = await sink.invoke(input, signal);
      const nextStatus: StagedDraft['status'] =
        result.status === 'executed'
          ? 'executed'
          : result.status === 'staged'
            ? 'pending_approval'
            : result.status === 'uncertain'
              ? 'uncertain'
              : 'rejected';
      this.db.db
        .prepare('UPDATE staged_drafts SET status = ?, receipt_json = ?, updated_at = ? WHERE id = ?')
        .run(nextStatus, JSON.stringify(result), nowIso(), draftId);
      return { ...result, draftId };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.db.db
        .prepare(`UPDATE staged_drafts SET status = 'rejected', receipt_json = ?, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify({ status: 'failed', detail }), nowIso(), draftId);
      return { status: 'failed', draftId, detail };
    }
  }

  async approveDraft(draftId: string): Promise<SinkInvokeResult> {
    const row = this.db.db.prepare('SELECT * FROM staged_drafts WHERE id = ?').get(draftId) as SqlRow | undefined;
    if (!row) return { status: 'failed', detail: 'draft_not_found' };
    if (row.status !== 'pending_approval' && row.status !== 'approved') {
      return { status: 'skipped', draftId, detail: `invalid_status:${String(row.status)}` };
    }
    const sink = this.sinks.get(String(row.sink_id));
    if (!sink) return { status: 'failed', draftId, detail: `sink_not_found:${String(row.sink_id)}` };

    const input: SinkInvokeInput = {
      action: String(row.action),
      target: parseJson<Record<string, unknown>>(row.target_json, {}),
      payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
      idempotencyKey: String(row.idempotency_key),
      sessionId: typeof row.session_id === 'string' ? row.session_id : undefined,
      approved: true,
    };
    const gate = await this.guard.beforeSendOut({
      hook: 'beforeSendOut',
      sinkId: sink.id,
      action: input.action,
      sessionId: input.sessionId ?? null,
      target: input.target,
      payload: input.payload,
    });
    if (!gate.allow) return { status: 'skipped', draftId, detail: gate.reason ?? 'blocked_by_guard' };

    this.db.db
      .prepare(`UPDATE staged_drafts SET status = 'executing', updated_at = ? WHERE id = ?`)
      .run(nowIso(), draftId);
    return this.executeDraftRecord(draftId, sink, input);
  }

  async discardDraft(draftId: string, reason?: string): Promise<void> {
    this.db.db
      .prepare(`UPDATE staged_drafts SET status = 'rejected', receipt_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify({ discarded: true, reason: reason ?? 'discarded' }), nowIso(), draftId);
  }

  listInbox(filter?: { source?: string; status?: InboxItem['status']; limit?: number }): InboxItem[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter?.source) {
      clauses.push('source = ?');
      params.push(filter.source);
    }
    if (filter?.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.max(1, Math.min(500, filter?.limit ?? 100));
    const rows = this.db.db
      .prepare(`SELECT * FROM inbox_items ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, limit) as SqlRow[];
    return rows.map((r) => ({
      id: String(r.id),
      eventId: String(r.event_id),
      source: String(r.source),
      type: String(r.type),
      entityKey: typeof r.entity_key === 'string' ? r.entity_key : null,
      workstreamId: typeof r.workstream_id === 'string' ? r.workstream_id : null,
      sessionId: typeof r.session_id === 'string' ? r.session_id : null,
      actor: String(r.actor),
      summary: String(r.summary),
      tier: r.tier as InboxItem['tier'],
      verdict: typeof r.verdict === 'string' ? (r.verdict as InboxItem['verdict']) : undefined,
      preGateTags: parseJson<string[]>(r.pre_gate_tags, []),
      status: r.status as InboxItem['status'],
      rawUrl: typeof r.raw_url === 'string' ? r.raw_url : undefined,
      occurredAt: typeof r.occurred_at === 'string' ? r.occurred_at : String(r.created_at),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    }));
  }

  listWorkstreams(filter?: { sessionId?: string; status?: WatchStatus }): WorkstreamRecord[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter?.sessionId) {
      clauses.push('session_id = ?');
      params.push(filter.sessionId);
    }
    if (filter?.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.db
      .prepare(`SELECT * FROM workstreams ${where} ORDER BY updated_at DESC`)
      .all(...params) as SqlRow[];
    return rows.map((r) => this.mapWorkstream(r));
  }

  listDrafts(filter?: { status?: StagedDraft['status'] }): StagedDraft[] {
    const where = filter?.status ? 'WHERE status = ?' : '';
    const rows = (
      filter?.status
        ? this.db.db.prepare(`SELECT * FROM staged_drafts ${where} ORDER BY created_at DESC`).all(filter.status)
        : this.db.db.prepare('SELECT * FROM staged_drafts ORDER BY created_at DESC').all()
    ) as SqlRow[];
    return rows.map((r) => ({
      id: String(r.id),
      sinkId: String(r.sink_id),
      action: String(r.action),
      workstreamId: typeof r.workstream_id === 'string' ? r.workstream_id : null,
      sessionId: typeof r.session_id === 'string' ? r.session_id : null,
      target: parseJson<Record<string, unknown>>(r.target_json, {}),
      payload: parseJson<Record<string, unknown>>(r.payload_json, {}),
      previewText: String(r.preview_text),
      idempotencyKey: String(r.idempotency_key),
      status: r.status as StagedDraft['status'],
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    }));
  }

  getStatus(): ReturnType<HubService['getStatus']> {
    const activeRow = this.db.db
      .prepare(`SELECT COUNT(*) AS cnt FROM workstreams WHERE status IN ('active', 'awaiting_agent')`)
      .get() as { cnt?: number };
    const subRow = this.db.db
      .prepare(`SELECT COUNT(*) AS cnt FROM thread_subscriptions WHERE status = 'active'`)
      .get() as { cnt?: number };
    const unreadRow = this.db.db
      .prepare(`SELECT COUNT(*) AS cnt FROM inbox_items WHERE status = 'unread'`)
      .get() as { cnt?: number };
    const draftRow = this.db.db
      .prepare(`SELECT COUNT(*) AS cnt FROM staged_drafts WHERE status = 'pending_approval'`)
      .get() as { cnt?: number };
    const transportWithMode = this.wechatTransport as
      | (WechatTransport & { getActiveMode?: () => 'cordis' | 'http' | 'unavailable' })
      | null;
    const liveTransportMode = transportWithMode?.getActiveMode?.() ?? this.transportMode;
    this.transportMode = liveTransportMode;
    return {
      sources: [...this.sources.values()].map((s) => ({ id: s.id, label: s.label, health: s.health?.() })),
      connectors: this.listConnectors(),
      sinks: [...this.sinks.values()].map((s) => ({ id: s.id, label: s.label, kind: s.kind })),
      wechatTransportMode: liveTransportMode,
      activeWorkstreams: Number(activeRow?.cnt ?? 0),
      activeSubscriptions: Number(subRow?.cnt ?? 0),
      unreadInbox: Number(unreadRow?.cnt ?? 0),
      pendingDrafts: Number(draftRow?.cnt ?? 0),
      autoSessionsThisHour: this.countAutoSessionsThisHour(),
      configRevision: this.configRevision,
    };
  }

  private countAutoSessionsThisHour(): number {
    const cutoff = new Date(Date.now() - 3600_000).toISOString();
    const row = this.db.db
      .prepare(`SELECT COUNT(*) AS cnt FROM circuit_breaker_log WHERE bucket = 'auto_session' AND created_at >= ?`)
      .get(cutoff) as { cnt?: number };
    return Number(row?.cnt ?? 0);
  }

  private mapSubscription(r: SqlRow): ThreadSubscription {
    return {
      id: String(r.id),
      source: String(r.source),
      threadKey: String(r.thread_key),
      workstreamId: typeof r.workstream_id === 'string' ? r.workstream_id : null,
      sessionId: String(r.session_id),
      personaId: typeof r.persona_id === 'string' ? r.persona_id : null,
      owner: String(r.owner),
      status: String(r.status),
      metadata: parseJson<Record<string, unknown>>(r.metadata_json, {}),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  private mapWorkstream(r: SqlRow): WorkstreamRecord {
    return {
      id: String(r.id),
      source: String(r.source),
      workstreamKey: String(r.workstream_key),
      primaryEntityKey: String(r.primary_entity_key),
      entityKeys: parseJson<string[]>(r.entity_keys_json, []),
      workspacePath: String(r.workspace_path),
      sessionId: typeof r.session_id === 'string' ? r.session_id : null,
      supersededBy: typeof r.superseded_by === 'string' ? r.superseded_by : null,
      status: r.status as WatchStatus,
      mode: r.mode as WorkstreamRecord['mode'],
      trustMode: r.trust_mode as WorkstreamRecord['trustMode'],
      deliveryCount: Number(r.delivery_count ?? 0),
      maxWakeups: Number(r.max_wakeups ?? 1),
      ttlExpiresAt: String(r.ttl_expires_at),
      lastWakeupAt: typeof r.last_wakeup_at === 'string' ? r.last_wakeup_at : null,
      configRevision: Number(r.config_revision ?? 1),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }
}

export const WatcherRuntime = HubRuntime;

export function createHubService(
  ctx: HubContextLike | undefined,
  deps: HubServiceDeps,
): HubRuntime {
  return new HubRuntime(ctx, deps);
}

export const createWatcherService = createHubService;
