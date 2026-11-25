import { randomUUID } from 'node:crypto';
import type {
  ActionTier,
  DeliveryMode,
  DeliveryState,
  PersonaWardrobe,
  TrustLevel,
  WatcherDb,
} from './contracts.js';

export const WATCHER_MESSAGE_SOURCE_PREFIX = 'dsh-watcher';
export const HUB_MESSAGE_SOURCE_PREFIX = 'dsh-hub';

export interface DshAgentState {
  running?: boolean;
  pendingInput?: unknown[];
  queue?: Array<{ placement?: string }>;
}

export interface DshSessionHandle {
  id?: string;
  metadata?: Record<string, unknown>;
}

export interface DshAgent {
  id?: string;
  session?: DshSessionHandle;
  state?: DshAgentState;
  getState?: () => DshAgentState | undefined;
  inbox?: {
    nextTurn?: Array<{ id?: string; [key: string]: unknown }>;
    remove?: (messageId: string) => void;
  };
  followup?: (message: unknown) => void;
  steer?: (message: unknown) => void;
  inject?: (message: unknown) => void;
  whenIdle?: () => Promise<void> | void;
}

export interface SessionBridgeContext {
  get?: (name: string) => unknown;
  on?: (event: string, listener: (...args: unknown[]) => void) => (() => void) | void;
  logger?:
    | ((name: string) => { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void })
    | { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void };
  agents?: { withoutInitiator?: <T>(fn: () => Promise<T> | T) => Promise<T> | T };
  workspaceRegistry?: {
    archivedSessionIds?: Set<string> | string[];
    resolveByPath?: (workspacePath: string) => Promise<{ id: string } | null | undefined>;
    create?: (workspacePath: string) => Promise<{ id: string }>;
  };
  sessionController?: {
    create?: (input: { workspaceId: string; agentPreset?: string }) => Promise<{ sessionId: string }>;
    resolveAgent?: (sessionId: string) => Promise<{ agent?: DshAgent; error?: { code?: string; message?: string } } | DshAgent>;
  };
  sessions?: {
    flush?: (session: unknown) => Promise<boolean>;
  };
  systemPrompt?: {
    context?: (provider: (agent?: DshAgent | null) => string) => (() => void) | void;
  };
  sandboxPolicy?: { setMode?: (session: unknown, mode: string) => Promise<void> | void };
  approval?: { setPolicy?: (session: unknown, policy: string) => Promise<void> | void };
  forgeSession?: { track?: (session: unknown, prUrl: string) => Promise<void> | void };
  sessionTitle?: { rename?: (session: unknown, title: string) => Promise<void> | void };
  worktrees?: { create?: (agent: DshAgent, spec: unknown) => Promise<void> | void };
  personaWardrobe?: PersonaWardrobe;
}

export interface SessionBridgeDeps {
  db?: WatcherDb | null;
  wardrobe?: PersonaWardrobe | null;
  logger?: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void };
  onTakeover?: (info: { sessionId: string; receiptId: string; messageId: string; workstreamId?: string; incomingId: string }) => void;
  onWorkstreamEnded?: (workstreamId: string, reason: string) => void;
  onTurnSettled?: (info: { sessionId: string; receiptId: string; messageId: string; workstreamId?: string; takenOver: boolean }) => void;
}

export interface CreateRootSessionMetadata {
  agentPreset?: string;
  unattendedReadOnly?: boolean;
  worktree?: unknown;
  forgePrUrl?: string | null;
  personaId?: string | null;
  scope?: string | null;
  learningEnabled?: boolean;
  preview?: boolean;
}

export interface WakeupPayload {
  text: string;
  workstreamId?: string;
  workstreamKey?: string;
  source?: string;
  eventIds?: string[];
  tier?: ActionTier;
  trust?: TrustLevel;
  allowedTools?: string[];
  deliveryMode?: DeliveryMode;
  personaId?: string | null;
  scope?: string | null;
  preview?: boolean;
  learningEnabled?: boolean;
  sender?: string;
  memories?: Array<{ note: string; quote: string; category?: string }>;
  preferenceExtractor?: (ctx: {
    agent: DshAgent;
    sessionId: string;
    receiptId: string;
    text: string;
  }) => Promise<{ memories: Array<{ note: string; quote: string; category?: string }>; sender?: string; eventSeq?: number } | false | null>;
}

export interface SessionDeliveryResult {
  ok: boolean;
  reason?: string;
  retryable?: boolean;
  receiptId?: string;
  messageId?: string;
  wasBusy?: boolean;
  settlement?: Promise<void>;
}

interface ActiveDelivery {
  receiptId: string;
  messageId: string;
  workstreamId?: string;
  takenOver: boolean;
}

interface PersonaBinding {
  personaId: string;
  scope: string;
  learningEnabled: boolean;
  preview: boolean;
}

interface WorkstreamRow {
  id: string;
  primary_entity_key: string;
  mode: string;
  trust_mode: string;
  delivery_count: number;
  max_wakeups: number;
  ttl_expires_at: string;
}

interface OpenReceiptRow {
  id: string;
  session_id: string;
  message_id: string;
}

export function isAdmissionBusy(agent?: DshAgent | null): boolean {
  const state = agent?.state ?? agent?.getState?.();
  if (!state) return false;
  if (state.running) return true;
  if (Array.isArray(state.pendingInput) && state.pendingInput.length > 0) return true;
  if (Array.isArray(state.queue) && state.queue.some((item) => item?.placement !== 'context')) {
    return true;
  }
  return false;
}

function createWatcherMessage(text: string, payload: WakeupPayload): { id: string; role: 'user'; content: Array<{ type: 'text'; text: string }>; source: Record<string, unknown> } {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: `${WATCHER_MESSAGE_SOURCE_PREFIX}:${payload.source ?? 'core'}`,
      workstreamId: payload.workstreamId ?? null,
      tier: payload.tier ?? 'triage',
      trust: payload.trust ?? 'triage',
      allowedTools: [...(payload.allowedTools ?? [])],
      personaId: payload.personaId ?? null,
      scope: payload.scope ?? null,
    },
  };
}

function readService<T>(ctx: SessionBridgeContext, key: keyof SessionBridgeContext): T | undefined {
  if (typeof ctx.get === 'function') {
    return ctx.get(String(key)) as T | undefined;
  }
  return ctx[key] as T | undefined;
}

export class SessionBridge {
  private readonly ctx: SessionBridgeContext;
  private readonly db: WatcherDb | null;
  private wardrobeOverride: PersonaWardrobe | null;
  private readonly logger: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void };
  private readonly onTakeover: NonNullable<SessionBridgeDeps['onTakeover']>;
  private readonly onWorkstreamEnded: NonNullable<SessionBridgeDeps['onWorkstreamEnded']>;
  private readonly onTurnSettled: NonNullable<SessionBridgeDeps['onTurnSettled']>;
  private readonly activeDeliveries = new Map<string, ActiveDelivery>();
  private readonly takenOverSessions = new Set<string>();
  private readonly sessionPersonas = new Map<string, PersonaBinding>();
  private readonly disposers: Array<() => void> = [];

  constructor(ctx: SessionBridgeContext, deps: SessionBridgeDeps = {}) {
    this.ctx = ctx ?? {};
    this.db = deps.db ?? null;
    this.wardrobeOverride = deps.wardrobe ?? null;
    this.logger =
      deps.logger ??
      (typeof this.ctx.logger === 'function' ? this.ctx.logger('hub:session-bridge') : this.ctx.logger) ??
      console;
    this.onTakeover = deps.onTakeover ?? (() => {});
    this.onWorkstreamEnded = deps.onWorkstreamEnded ?? (() => {});
    this.onTurnSettled = deps.onTurnSettled ?? (() => {});
  }

  getWardrobe(): PersonaWardrobe | null {
    return this.wardrobeOverride ?? readService<PersonaWardrobe>(this.ctx, 'personaWardrobe') ?? null;
  }

  setWardrobe(wardrobe: PersonaWardrobe | null): void {
    this.wardrobeOverride = wardrobe;
  }

  bindSessionPersona(sessionId: string, binding: { personaId: string; scope?: string; learningEnabled?: boolean; preview?: boolean }): void {
    if (!sessionId || !binding.personaId) return;
    this.sessionPersonas.set(sessionId, {
      personaId: binding.personaId,
      scope: binding.scope || 'global',
      learningEnabled: binding.learningEnabled !== false,
      preview: Boolean(binding.preview),
    });
  }

  unbindSessionPersona(sessionId: string): void {
    this.sessionPersonas.delete(sessionId);
  }

  isTakenOver(sessionId: string): boolean {
    return this.takenOverSessions.has(sessionId) || Boolean(this.activeDeliveries.get(sessionId)?.takenOver);
  }

  clearTakeover(sessionId: string): void {
    this.takenOverSessions.delete(sessionId);
  }

  mount(): void {
    if (typeof this.ctx.on === 'function') {
      const offActivity = this.ctx.on('workspace/session-activity', (sessionIdArg, activitiesArg) => {
        const sessionId = typeof sessionIdArg === 'string' ? sessionIdArg : '';
        const activities = Array.isArray(activitiesArg) ? activitiesArg : null;
        if (!sessionId || !activities) return;
        for (const ws of this.listActiveWorkstreams(sessionId)) {
          activities.push({
            kind: WATCHER_MESSAGE_SOURCE_PREFIX,
            id: ws.id,
            label: `Watching ${ws.primary_entity_key} (${ws.delivery_count}/${ws.max_wakeups})`,
          });
        }
      });
      if (typeof offActivity === 'function') this.disposers.push(offActivity);

      const offStop = this.ctx.on('workspace/session-stop', (sessionIdArg) => {
        const sessionId = typeof sessionIdArg === 'string' ? sessionIdArg : '';
        if (!sessionId) return;
        this.sessionPersonas.delete(sessionId);
        this.takenOverSessions.delete(sessionId);
        for (const wsId of this.endWorkstreamsBySession(sessionId, 'session_archived')) {
          this.onWorkstreamEnded(wsId, 'session_archived');
        }
      });
      if (typeof offStop === 'function') this.disposers.push(offStop);

      const offInbox = this.ctx.on('agent/inbox/inserted', (payloadArg) => {
        const payload = (payloadArg ?? {}) as Record<string, unknown>;
        const agentObj = payload.agent as { id?: string } | undefined;
        const sessionId = agentObj?.id ?? (typeof payload.sessionId === 'string' ? payload.sessionId : '');
        if (!sessionId) return;

        const item = (payload.message ?? payload.item) as Record<string, unknown> | undefined;
        const isUserInput = item?.role === 'user' || payload.type === 'user/message';
        if (!isUserInput) return;

        const incomingId = typeof item?.id === 'string'
          ? item.id
          : (typeof payload.rpcId === 'string' ? payload.rpcId : '');
        const source = item?.source as { kind?: string } | undefined;
        const isWatcherSource =
          typeof source?.kind === 'string' &&
          (source.kind.startsWith(WATCHER_MESSAGE_SOURCE_PREFIX) || source.kind.startsWith(HUB_MESSAGE_SOURCE_PREFIX));
        const delivery = this.activeDeliveries.get(sessionId);

        if (delivery) {
          if (incomingId && incomingId !== delivery.messageId && !isWatcherSource) {
            delivery.takenOver = true;
            this.takenOverSessions.add(sessionId);
            this.markReceiptTakeover(delivery.receiptId);
            this.onTakeover({ sessionId, receiptId: delivery.receiptId, messageId: delivery.messageId, workstreamId: delivery.workstreamId, incomingId });
          }
        } else if (!isWatcherSource) {
          this.takenOverSessions.add(sessionId);
        }
      });
      if (typeof offInbox === 'function') this.disposers.push(offInbox);
    }

    const systemPrompt = readService<SessionBridgeContext['systemPrompt']>(this.ctx, 'systemPrompt');
    if (typeof systemPrompt?.context === 'function') {
      try {
        const disposePrompt = systemPrompt.context((agent) => this.buildDynamicContext(agent));
        if (typeof disposePrompt === 'function') this.disposers.push(disposePrompt);
      } catch {
        void 0;
      }
    }
  }

  dispose(): void {
    while (this.disposers.length > 0) {
      try {
        this.disposers.pop()?.();
      } catch (err) {
        this.logger.warn?.('[bridge] dispose hook error', err);
      }
    }
    this.activeDeliveries.clear();
    this.takenOverSessions.clear();
    this.sessionPersonas.clear();
  }

  buildDynamicContext(agent?: DshAgent | null): string {
    const sessionId = agent?.session?.id ?? agent?.id;
    if (!sessionId) return '';

    const blocks: string[] = [];
    const active = this.listActiveWorkstreams(sessionId);
    if (active.length > 0) {
      const lines = active.map(
        (w) => `- [watch=${w.id}] ${w.primary_entity_key} | mode=${w.mode} | trust=${w.trust_mode} | wakes=${w.delivery_count}/${w.max_wakeups} | expires=${w.ttl_expires_at}`,
      );
      blocks.push(`Active dsh-watcher bindings owned by THIS session (${sessionId}):\n${lines.join('\n')}`);
    }

    const meta = agent?.session?.metadata;
    const metaPersona = typeof meta?.personaId === 'string' ? meta.personaId : null;
    const metaScope = typeof meta?.personaScope === 'string' ? meta.personaScope : `session:${sessionId}`;
    const binding = this.sessionPersonas.get(sessionId) ?? (metaPersona ? { personaId: metaPersona, scope: metaScope, learningEnabled: true, preview: false } : null);

    const wardrobe = this.getWardrobe();
    if (binding && wardrobe) {
      const card = wardrobe.getDynamicCard({ personaId: binding.personaId, scope: binding.scope });
      const text = card?.promptBlock?.trim() || card?.cardMarkdown?.trim() || '';
      if (text) blocks.push(text);
    }

    return blocks.join('\n\n');
  }

  async runIsolated<T>(fn: () => Promise<T> | T): Promise<T> {
    const agents = readService<SessionBridgeContext['agents']>(this.ctx, 'agents');
    if (typeof agents?.withoutInitiator === 'function') {
      return await agents.withoutInitiator(fn);
    }
    return await fn();
  }

  isArchived(sessionId: string): boolean {
    const registry = readService<SessionBridgeContext['workspaceRegistry']>(this.ctx, 'workspaceRegistry');
    const archived = registry?.archivedSessionIds;
    if (!archived) return false;
    return archived instanceof Set ? archived.has(sessionId) : archived.includes(sessionId);
  }

  async resolveAgent(sessionId: string): Promise<{ agent?: DshAgent; error?: { code?: string; message?: string } }> {
    const controller = readService<SessionBridgeContext['sessionController']>(this.ctx, 'sessionController');
    if (!controller?.resolveAgent) {
      return { error: { code: 'session/controller-unavailable', message: 'sessionController.resolveAgent unavailable' } };
    }
    const raw = await controller.resolveAgent(sessionId);
    if (raw && typeof raw === 'object' && ('error' in raw || 'agent' in raw)) {
      return raw as { agent?: DshAgent; error?: { code?: string; message?: string } };
    }
    return { agent: raw as DshAgent };
  }

  async createRootSession(
    workspacePath: string,
    title?: string,
    metadata: CreateRootSessionMetadata = {},
  ): Promise<{ sessionId: string; agent: DshAgent }> {
    return this.runIsolated(async () => {
      const registry = readService<SessionBridgeContext['workspaceRegistry']>(this.ctx, 'workspaceRegistry');
      const controller = readService<SessionBridgeContext['sessionController']>(this.ctx, 'sessionController');
      if (!registry?.resolveByPath || !registry?.create || !controller?.create) {
        throw new Error('DSH workspaceRegistry/sessionController unavailable');
      }

      const ws = (await registry.resolveByPath(workspacePath)) ?? (await registry.create(workspacePath));
      const { sessionId } = await controller.create({
        workspaceId: ws.id,
        agentPreset: metadata.agentPreset ?? 'standard',
      });

      const resolved = await this.resolveAgent(sessionId);
      if (resolved.error || !resolved.agent) {
        throw new Error(`resolveAgent failed after create: ${resolved.error?.code ?? resolved.error?.message ?? 'unknown'}`);
      }
      const agent = resolved.agent;

      const worktrees = readService<SessionBridgeContext['worktrees']>(this.ctx, 'worktrees');
      if (metadata.worktree && worktrees?.create) {
        await worktrees.create(agent, metadata.worktree);
      }

      const sessionTitle = readService<SessionBridgeContext['sessionTitle']>(this.ctx, 'sessionTitle');
      if (title && sessionTitle?.rename) {
        await sessionTitle.rename(agent.session, title.slice(0, 80));
      }

      if (metadata.unattendedReadOnly !== false) {
        const sandboxPolicy = readService<SessionBridgeContext['sandboxPolicy']>(this.ctx, 'sandboxPolicy');
        const approval = readService<SessionBridgeContext['approval']>(this.ctx, 'approval');
        await sandboxPolicy?.setMode?.(agent.session, 'read-only');
        await approval?.setPolicy?.(agent.session, 'never');
      }

      const forgeSession = readService<SessionBridgeContext['forgeSession']>(this.ctx, 'forgeSession');
      if (metadata.forgePrUrl && forgeSession?.track) {
        await forgeSession.track(agent.session, metadata.forgePrUrl);
      }

      if (metadata.personaId) {
        this.bindSessionPersona(sessionId, {
          personaId: metadata.personaId,
          scope: metadata.scope ?? `session:${sessionId}`,
          learningEnabled: metadata.learningEnabled !== false,
          preview: Boolean(metadata.preview),
        });
      }

      return { sessionId, agent };
    });
  }

  async deliverToSession(sessionId: string, payload: WakeupPayload): Promise<SessionDeliveryResult> {
    return this.runIsolated(async () => {
      if (this.isArchived(sessionId)) {
        if (payload.workstreamId) this.endWorkstream(payload.workstreamId, 'session_archived');
        return { ok: false, reason: 'session_archived' };
      }

      const resolved = await this.resolveAgent(sessionId);
      if (resolved.error || !resolved.agent) {
        const code = resolved.error?.code ?? 'unknown';
        if (payload.workstreamId && (code === 'session/not-found' || code === 'session/agent-busy')) {
          this.endWorkstream(payload.workstreamId, 'session_missing');
        }
        return { ok: false, reason: code, retryable: code === 'session/writer-held' };
      }

      const agent = resolved.agent;
      const wasBusy = isAdmissionBusy(agent);
      const existingPersona = this.sessionPersonas.get(sessionId);
      const personaId = payload.personaId ?? existingPersona?.personaId ?? null;
      const scope = payload.scope ?? existingPersona?.scope ?? payload.workstreamKey ?? `session:${sessionId}`;
      const preview = Boolean(payload.preview || existingPersona?.preview);
      const learningEnabled = payload.learningEnabled !== false && existingPersona?.learningEnabled !== false;

      if (personaId) {
        this.bindSessionPersona(sessionId, { personaId, scope, learningEnabled, preview });
      }

      const message = createWatcherMessage(payload.text, { ...payload, personaId, scope });
      const receiptId = this.insertReceipt(payload, sessionId, message.id);
      const activeEntry: ActiveDelivery = {
        receiptId,
        messageId: message.id,
        workstreamId: payload.workstreamId,
        takenOver: false,
      };
      this.activeDeliveries.set(sessionId, activeEntry);

      const mode: DeliveryMode = payload.trust === 'owner'
        ? (payload.deliveryMode ?? 'followup')
        : (payload.deliveryMode === 'inject' ? 'inject' : 'followup');

      if (mode === 'inject' && typeof agent.inject === 'function') {
        agent.inject(message);
      } else if (mode === 'steer' && typeof agent.steer === 'function') {
        agent.steer(message);
      } else {
        agent.followup?.(message);
      }

      const idlePromise = typeof agent.whenIdle === 'function' ? Promise.resolve(agent.whenIdle()) : Promise.resolve();
      const sessions = readService<SessionBridgeContext['sessions']>(this.ctx, 'sessions');
      const flushed = sessions?.flush ? await sessions.flush(agent.session) : true;
      if (!flushed) {
        this.activeDeliveries.delete(sessionId);
        this.updateReceiptState(receiptId, 'uncertain', 'sessions.flush returned false');
        return { ok: false, reason: 'flush_failed', receiptId };
      }

      this.updateReceiptState(receiptId, 'in_flight');

      const settlement = idlePromise
        .then(async () => {
          this.activeDeliveries.delete(sessionId);
          if (!activeEntry.takenOver) {
            this.updateReceiptState(receiptId, 'delivered');
            if (payload.workstreamId) this.markWorkstreamTurnSettled(payload.workstreamId);
            await this.recordPostTurnPreference(agent, sessionId, receiptId, payload, personaId, scope, preview, learningEnabled);
          }
          this.onTurnSettled({
            sessionId,
            receiptId,
            messageId: message.id,
            workstreamId: payload.workstreamId,
            takenOver: activeEntry.takenOver,
          });
        })
        .catch((err: unknown) => {
          this.activeDeliveries.delete(sessionId);
          const msg = err instanceof Error ? err.message : String(err);
          this.updateReceiptState(receiptId, 'failed', msg);
        });

      return { ok: true, receiptId, messageId: message.id, wasBusy, settlement };
    });
  }

  async recoverOutstandingDeliveries(): Promise<{ recovered: number; markedUncertain: number }> {
    const open = this.listOpenReceipts();
    if (open.length === 0) return { recovered: 0, markedUncertain: 0 };

    let recovered = 0;
    let markedUncertain = 0;

    await this.runIsolated(async () => {
      const sessions = readService<SessionBridgeContext['sessions']>(this.ctx, 'sessions');
      for (const receipt of open) {
        if (this.isArchived(receipt.session_id)) {
          this.updateReceiptState(receipt.id, 'failed', 'session_archived_during_restart');
          continue;
        }
        const resolved = await this.resolveAgent(receipt.session_id);
        if (resolved.error || !resolved.agent) {
          this.updateReceiptState(receipt.id, 'uncertain', resolved.error?.code ?? 'resolve_failed');
          markedUncertain += 1;
          continue;
        }
        const agent = resolved.agent;
        const orphan = agent.inbox?.nextTurn?.find((item) => item?.id === receipt.message_id);
        if (orphan && !isAdmissionBusy(agent)) {
          agent.inbox?.remove?.(receipt.message_id);
          agent.followup?.(orphan);
          if (sessions?.flush) await sessions.flush(agent.session);
          recovered += 1;
        } else {
          this.updateReceiptState(receipt.id, 'uncertain', 'process_restarted_mid_flight');
          markedUncertain += 1;
        }
      }
    });

    return { recovered, markedUncertain };
  }

  private async recordPostTurnPreference(
    agent: DshAgent,
    sessionId: string,
    receiptId: string,
    payload: WakeupPayload,
    personaId: string | null,
    scope: string,
    preview: boolean,
    learningEnabled: boolean,
  ): Promise<void> {
    const wardrobe = this.getWardrobe();
    if (preview || !learningEnabled || !personaId || !wardrobe) return;
    try {
      const persona = wardrobe.get(personaId);
      if (persona && !persona.learning) return;
    } catch {
      return;
    }

    try {
      const extracted = payload.preferenceExtractor
        ? await payload.preferenceExtractor({ agent, sessionId, receiptId, text: payload.text })
        : null;
      if (extracted === false) return;
      const memories = extracted?.memories ?? payload.memories ?? [];
      if (memories.length === 0) return;

      wardrobe.recordTurnPreference({
        personaId,
        scope,
        eventSeq: extracted?.eventSeq ?? Date.now(),
        sender: extracted?.sender ?? payload.sender ?? payload.source ?? 'hub',
        sourceText: payload.text,
        memories,
      });
    } catch (err) {
      this.logger.warn?.('[bridge] post-turn wardrobe learning failed', err);
    }
  }

  private listActiveWorkstreams(sessionId: string): WorkstreamRow[] {
    if (!this.db) return [];
    return this.db.db
      .prepare(
        `SELECT id, primary_entity_key, mode, trust_mode, delivery_count, max_wakeups, ttl_expires_at
         FROM workstreams WHERE session_id = ? AND status IN ('active', 'awaiting_agent')`,
      )
      .all(sessionId) as unknown as WorkstreamRow[];
  }

  private endWorkstream(workstreamId: string, reason: string): void {
    if (!this.db) return;
    const now = new Date().toISOString();
    this.db.db
      .prepare("UPDATE workstreams SET status = 'ended', end_reason = ?, updated_at = ? WHERE id = ?")
      .run(reason, now, workstreamId);
  }

  private endWorkstreamsBySession(sessionId: string, reason: string): string[] {
    if (!this.db) return [];
    const rows = this.db.db
      .prepare("SELECT id FROM workstreams WHERE session_id = ? AND status != 'ended'")
      .all(sessionId) as unknown as Array<{ id: string }>;
    if (rows.length === 0) return [];
    const now = new Date().toISOString();
    this.db.db
      .prepare("UPDATE workstreams SET status = 'ended', end_reason = ?, updated_at = ? WHERE session_id = ? AND status != 'ended'")
      .run(reason, now, sessionId);
    return rows.map((r) => r.id);
  }

  private insertReceipt(payload: WakeupPayload, sessionId: string, messageId: string): string {
    const id = randomUUID();
    if (!this.db || !payload.workstreamId) return id;
    const now = new Date().toISOString();
    const trustMode = payload.trust === 'owner' ? 'autonomous' : 'triage';
    this.db.db
      .prepare(
        `INSERT INTO delivery_receipts
         (id, workstream_id, session_id, message_id, event_ids_json, trust_mode, state, delivered_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
      )
      .run(id, payload.workstreamId, sessionId, messageId, JSON.stringify(payload.eventIds ?? []), trustMode, now);
    return id;
  }

  private updateReceiptState(receiptId: string, state: DeliveryState, error?: string): void {
    if (!this.db) return;
    const settledAt = state === 'delivered' || state === 'failed' || state === 'uncertain' || state === 'suppressed_takeover'
      ? new Date().toISOString()
      : null;
    this.db.db
      .prepare('UPDATE delivery_receipts SET state = ?, error = COALESCE(?, error), settled_at = COALESCE(?, settled_at) WHERE id = ?')
      .run(state, error ?? null, settledAt, receiptId);
  }

  private markReceiptTakeover(receiptId: string): void {
    if (!this.db) return;
    const now = new Date().toISOString();
    this.db.db
      .prepare("UPDATE delivery_receipts SET manual_takeover = 1, state = 'suppressed_takeover', settled_at = ? WHERE id = ?")
      .run(now, receiptId);
  }

  private markWorkstreamTurnSettled(workstreamId: string): void {
    if (!this.db) return;
    const now = new Date().toISOString();
    this.db.db
      .prepare(
        `UPDATE workstreams
         SET delivery_count = delivery_count + 1,
             last_wakeup_at = ?,
             status = CASE WHEN mode = 'once' OR delivery_count + 1 >= max_wakeups THEN 'ended' ELSE 'active' END,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(now, now, workstreamId);
  }

  private listOpenReceipts(): OpenReceiptRow[] {
    if (!this.db) return [];
    return this.db.db
      .prepare("SELECT id, session_id, message_id FROM delivery_receipts WHERE state IN ('queued', 'in_flight')")
      .all() as unknown as OpenReceiptRow[];
  }
}

export function createSessionBridge(
  ctx: SessionBridgeContext,
  db?: WatcherDb | null,
  wardrobe?: PersonaWardrobe | null,
  deps?: Omit<SessionBridgeDeps, 'db' | 'wardrobe'>,
): SessionBridge {
  return new SessionBridge(ctx, { ...deps, db, wardrobe });
}
