import type {
  ActionTier,
  DynamicPersonaCard,
  HubService,
  NormalizedEvent,
  PosteriorHandlerConfig,
  ResolvedEntityContext,
  RoutingRule,
  SinkInvokeInput,
  SinkInvokeResult,
  ThreadSubscription,
  WorkstreamRecord,
} from './contracts.js';

export const BUNDLED_SKILL_RANK = 600;

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

export interface PosteriorToolDefinition {
  name: string;
  description: string;
  isConcurrencySafe?: () => boolean;
  inputSchema: Record<string, unknown>;
  execute: (args: Record<string, unknown>, exec?: ToolExecutionContext) => Promise<unknown>;
}

export interface PosteriorCommandDefinition {
  name: string;
  description: string;
  execute: (argsText?: string, cmdCtx?: { sessionId?: string }) => Promise<string>;
}

export interface PosteriorContext {
  get?: (name: string) => unknown;
  tools?: { register?: (def: PosteriorToolDefinition) => (() => void) | void };
  commands?: { register?: (def: PosteriorCommandDefinition) => (() => void) | void };
}

export interface WorkstreamUpdatePatch {
  mode?: 'once' | 'repeat';
  maxWakeups?: number;
  ttlHours?: number;
  paused?: boolean;
}

export interface PosteriorWatcherHandle extends Pick<HubService, 'listWorkstreams' | 'listDrafts' | 'getStatus' | 'invokeSink'> {
  db?: HubService['db'];
  updateWorkstream?: (id: string, patch: WorkstreamUpdatePatch) => WorkstreamRecord | null;
  cancelWorkstream?: (id: string, reason?: string) => boolean;
}

export interface EffectiveTierResult {
  tier: ActionTier;
  downgradeReason: string | null;
}

export interface WakeupPromptInput {
  workstream: WorkstreamRecord;
  events: NormalizedEvent[];
  resolvedEntity?: ResolvedEntityContext | null;
  handler?: PosteriorHandlerConfig | null;
  tier: ActionTier;
  personaCard?: DynamicPersonaCard | string | null;
}

export interface FastPathPromptInput {
  subscription: ThreadSubscription;
  event: NormalizedEvent;
  tier: ActionTier;
  personaCard?: DynamicPersonaCard | string | null;
}

const DEFAULT_INBOX_RULE: RoutingRule = {
  id: 'builtin:default-inbox-only',
  name: 'Default Zero-Token Inbox',
  enabled: true,
  priority: 9999,
  match: { source: '*' },
  handler: {
    tier: 'inbox-only',
    sessionPolicy: 'none',
  },
};

export function matchRule(event: NormalizedEvent, rules: readonly RoutingRule[] = []): RoutingRule {
  const sorted = [...rules]
    .filter((r) => r && r.enabled !== false)
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));

  for (const rule of sorted) {
    const m = rule.match;
    if (m.excludeBots !== false && event.actor?.isBot) continue;
    if (m.source && m.source !== '*' && m.source !== event.source) continue;

    if (m.type) {
      const types = Array.isArray(m.type) ? m.type : [m.type];
      if (!types.includes(event.type)) continue;
    }

    if (m.repo) {
      const repos = Array.isArray(m.repo) ? m.repo : [m.repo];
      const eventRepo = event.rawRef?.repo;
      if (!eventRepo || !repos.includes(eventRepo)) continue;
    }

    if (m.trustLevel) {
      const levels = Array.isArray(m.trustLevel) ? m.trustLevel : [m.trustLevel];
      if (!levels.includes(event.trustLevel)) continue;
    }

    if (typeof m.predicate === 'function' && !m.predicate(event)) continue;

    return rule;
  }

  return DEFAULT_INBOX_RULE;
}

export const matchRoutingRule = matchRule;

export function resolveEffectiveTier(
  handler: PosteriorHandlerConfig | undefined,
  event: NormalizedEvent,
  resolvedEntity?: ResolvedEntityContext | null,
): EffectiveTierResult {
  const tier = handler?.tier ?? 'inbox-only';
  if (!resolvedEntity?.workspacePath) {
    return { tier: 'inbox-only', downgradeReason: 'unmapped_workspace' };
  }

  if (tier === 'autonomous') {
    const owners = handler?.ownerLogins ?? [];
    const actorLogin = event.actor?.login ?? event.actor?.id ?? '';
    const isVerifiedOwner = event.trustLevel === 'owner'
      && (owners.length === 0 || owners.includes(actorLogin));
    const labels = Array.isArray(event.payload?.labels) ? event.payload.labels : [];
    const labelOk = !handler?.requiredLabel || labels.includes(handler.requiredLabel);

    if (!isVerifiedOwner || !labelOk || resolvedEntity.sensitiveWorkspace) {
      return {
        tier: 'triage',
        downgradeReason: resolvedEntity.sensitiveWorkspace
          ? 'sensitive_workspace_cap'
          : 'autonomous_gate_not_met',
      };
    }
  }

  return { tier, downgradeReason: null };
}

export function buildWakeupPrompt(input: WakeupPromptInput): string {
  const { workstream, events, resolvedEntity, handler, tier, personaCard } = input;
  const remaining = Math.max(0, workstream.maxWakeups - workstream.deliveryCount);
  const banner =
    `[Watch ${workstream.primaryEntityKey} · ${tier} · remaining ${remaining}/${workstream.maxWakeups} · ` +
    `expires ${workstream.ttlExpiresAt} · cancel: /watch cancel ${workstream.id}]`;

  const sections: string[] = [banner];

  if (resolvedEntity?.contextHeader) {
    sections.push(`## Related Context Card\n${resolvedEntity.contextHeader}`);
  }

  if (handler?.skill) {
    sections.push(`## Bound Skill\nFollow skill \`${handler.skill}\` (overrideable via .dsh/skills/${handler.skill}).`);
  }

  if (personaCard) {
    const cardText = typeof personaCard === 'string'
      ? personaCard
      : (personaCard.promptBlock || personaCard.cardMarkdown || '');
    if (cardText) sections.push(`## Persona\n${cardText}`);
  }

  const eventItems = events.map((e) => ({
    id: e.id,
    type: e.type,
    actor: e.actor?.login ?? e.actor?.id ?? 'unknown',
    occurredAt: e.occurredAt,
    url: e.rawRef?.url,
    body: typeof e.payload?.body === 'string' ? e.payload.body : e.summary,
  }));
  sections.push(`## External Event Data (${workstream.source}:${workstream.primaryEntityKey})\n\`\`\`json\n${JSON.stringify(eventItems, null, 2)}\n\`\`\``);

  const directive = tier === 'autonomous'
    ? `Complete the requested action, call \`watch_cancel\`(${workstream.id}) when finished, or use \`watch_stage_draft\` to stage external replies.`
    : `Summarize the delta and propose 1 concrete next action. Use \`watch_stage_draft\` for outbound drafts or \`/watch cancel ${workstream.id}\` to stop watching.`;

  sections.push(`## Directive\n${directive}`);
  return sections.join('\n\n');
}

export function buildFastPathPrompt(input: FastPathPromptInput): string {
  const { subscription, event, tier, personaCard } = input;
  const banner = `[Hub Subscription ${subscription.source}:${subscription.threadKey} · ${tier} · owner ${subscription.owner}]`;
  const sections: string[] = [banner];

  if (personaCard) {
    const cardText = typeof personaCard === 'string'
      ? personaCard
      : (personaCard.promptBlock || personaCard.cardMarkdown || '');
    if (cardText) sections.push(`## Persona\n${cardText}`);
  }

  const eventItem = {
    id: event.id,
    type: event.type,
    actor: event.actor?.login ?? event.actor?.id ?? 'unknown',
    occurredAt: event.occurredAt,
    url: event.rawRef?.url,
    body: typeof event.payload?.body === 'string' ? event.payload.body : event.summary,
  };
  sections.push(`## External Event Data (${event.source}:${event.threadKey})\n\`\`\`json\n${JSON.stringify([eventItem], null, 2)}\n\`\`\``);

  const directive = tier === 'autonomous'
    ? 'Complete the requested action or use `watch_stage_draft` to stage external replies.'
    : 'Summarize the delta and propose 1 concrete next action. Use `watch_stage_draft` for outbound drafts.';
  sections.push(`## Directive\n${directive}`);
  return sections.join('\n\n');
}

export function assertRootSessionCaller(exec?: ToolExecutionContext): { sessionId: string; cwd?: string } {
  const header = exec?.agent?.session?.header;
  if (!exec?.agent?.id || !header) {
    throw new Error('watch_* tools require an active DSH session context.');
  }
  if ((header.delegationDepth ?? 0) > 0 || header.origin === 'subagent') {
    throw new Error('Subagents are not permitted to mutate or inspect hub bindings.');
  }
  return { sessionId: exec.agent.id, cwd: header.cwd };
}

function applyWorkstreamUpdate(watcher: PosteriorWatcherHandle, id: string, patch: WorkstreamUpdatePatch): boolean {
  if (typeof watcher.updateWorkstream === 'function') {
    return Boolean(watcher.updateWorkstream(id, patch));
  }
  if (!watcher.db) return false;
  const now = new Date().toISOString();
  const sets: string[] = ['updated_at = ?'];
  const params: Array<string | number> = [now];
  if (patch.mode) {
    sets.push('mode = ?');
    params.push(patch.mode);
  }
  if (typeof patch.maxWakeups === 'number') {
    sets.push('max_wakeups = ?');
    params.push(patch.maxWakeups);
  }
  if (typeof patch.ttlHours === 'number') {
    sets.push('ttl_expires_at = ?');
    params.push(new Date(Date.now() + patch.ttlHours * 3600_000).toISOString());
  }
  if (typeof patch.paused === 'boolean') {
    sets.push('status = ?');
    params.push(patch.paused ? 'paused' : 'active');
  }
  params.push(id);
  const res = watcher.db.db.prepare(`UPDATE workstreams SET ${sets.join(', ')} WHERE id = ? AND status != 'ended'`).run(...params);
  return Number(res.changes) > 0;
}

function applyWorkstreamCancel(watcher: PosteriorWatcherHandle, id: string, reason: string): boolean {
  if (typeof watcher.cancelWorkstream === 'function') {
    return Boolean(watcher.cancelWorkstream(id, reason));
  }
  if (!watcher.db) return false;
  const now = new Date().toISOString();
  const res = watcher.db.db
    .prepare("UPDATE workstreams SET status = 'ended', end_reason = ?, updated_at = ? WHERE id = ? AND status != 'ended'")
    .run(reason, now, id);
  return Number(res.changes) > 0;
}

export class PosteriorLayer {
  private readonly ctx: PosteriorContext;
  private readonly watcher: PosteriorWatcherHandle;
  private disposers: Array<() => void> = [];

  constructor(ctx: PosteriorContext, watcher: PosteriorWatcherHandle) {
    this.ctx = ctx ?? {};
    this.watcher = watcher;
  }

  matchRule(event: NormalizedEvent, rules: readonly RoutingRule[] = []): RoutingRule {
    return matchRule(event, rules);
  }

  resolveEffectiveTier(
    handler: PosteriorHandlerConfig | undefined,
    event: NormalizedEvent,
    resolvedEntity?: ResolvedEntityContext | null,
  ): EffectiveTierResult {
    return resolveEffectiveTier(handler, event, resolvedEntity);
  }

  buildWakeupPrompt(input: WakeupPromptInput): string {
    return buildWakeupPrompt(input);
  }

  mount(): () => void {
    if (this.disposers.length > 0) return () => this.dispose();

    const toolsSvc =
      typeof this.ctx.get === 'function'
        ? (this.ctx.get('tools') as PosteriorContext['tools'] | undefined)
        : this.ctx.tools;
    if (typeof toolsSvc?.register === 'function') {
      const tools: PosteriorToolDefinition[] = [
        {
          name: 'watch_list',
          description: 'List active dsh-hub workstreams and current service status (read-only).',
          isConcurrencySafe: () => true,
          inputSchema: {
            type: 'object',
            properties: {
              scope: { type: 'string', enum: ['this_session', 'all'], default: 'this_session' },
              activeOnly: { type: 'boolean', default: true },
            },
          },
          execute: async (args, exec) => {
            const { sessionId } = assertRootSessionCaller(exec);
            const workstreams = this.watcher.listWorkstreams({
              sessionId: args.scope === 'all' ? undefined : sessionId,
              status: args.activeOnly === false ? undefined : 'active',
            });
            return { workstreams, status: this.watcher.getStatus() };
          },
        },
        {
          name: 'watch_update',
          description: 'Update an existing watch binding mode, wakeup budget, TTL, or paused state.',
          inputSchema: {
            type: 'object',
            required: ['id'],
            properties: {
              id: { type: 'string' },
              mode: { type: 'string', enum: ['once', 'repeat'] },
              maxWakeups: { type: 'integer', minimum: 1, maximum: 20 },
              ttlHours: { type: 'integer', minimum: 1, maximum: 720 },
              paused: { type: 'boolean' },
            },
          },
          execute: async (args, exec) => {
            assertRootSessionCaller(exec);
            const id = String(args.id);
            const ok = applyWorkstreamUpdate(this.watcher, id, {
              mode: args.mode === 'once' || args.mode === 'repeat' ? args.mode : undefined,
              maxWakeups: typeof args.maxWakeups === 'number' ? args.maxWakeups : undefined,
              ttlHours: typeof args.ttlHours === 'number' ? args.ttlHours : undefined,
              paused: typeof args.paused === 'boolean' ? args.paused : undefined,
            });
            return { ok, id };
          },
        },
        {
          name: 'watch_cancel',
          description: 'Immediately cancel and end a watch binding by id.',
          inputSchema: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string' } },
          },
          execute: async (args, exec) => {
            assertRootSessionCaller(exec);
            const id = String(args.id);
            const ok = applyWorkstreamCancel(this.watcher, id, 'cancelled_by_agent');
            return { ok, id };
          },
        },
        {
          name: 'watch_stage_draft',
          description: 'Stage an outbound reply, review, or notification into the Draft-and-Approve queue.',
          inputSchema: {
            type: 'object',
            required: ['sinkId', 'action', 'target', 'payload', 'previewText'],
            properties: {
              sinkId: { type: 'string' },
              action: { type: 'string' },
              target: { type: 'object' },
              payload: { type: 'object' },
              previewText: { type: 'string' },
              idempotencyKey: { type: 'string' },
              workstreamId: { type: 'string' },
            },
          },
          execute: async (args, exec): Promise<SinkInvokeResult> => {
            const { sessionId } = assertRootSessionCaller(exec);
            const input: SinkInvokeInput = {
              action: String(args.action),
              target: (args.target as Record<string, unknown>) ?? {},
              payload: {
                ...((args.payload as Record<string, unknown>) ?? {}),
                previewText: String(args.previewText ?? ''),
                workstreamId: typeof args.workstreamId === 'string' ? args.workstreamId : undefined,
              },
              idempotencyKey: typeof args.idempotencyKey === 'string'
                ? args.idempotencyKey
                : `draft:${sessionId}:${Date.now()}`,
              sessionId,
              stageOnly: true,
            };
            return this.watcher.invokeSink(String(args.sinkId), input);
          },
        },
      ];

      for (const def of tools) {
        try {
          const off = toolsSvc.register(def);
          if (typeof off === 'function') this.disposers.push(off);
        } catch {
          void 0;
        }
      }
    }

    const commandsSvc =
      typeof this.ctx.get === 'function'
        ? (this.ctx.get('commands') as PosteriorContext['commands'] | undefined)
        : this.ctx.commands;
    if (typeof commandsSvc?.register === 'function') {
      try {
        const offCmd = commandsSvc.register({
          name: 'watch',
          description: 'Zero-token hub control: /watch [list | status | cancel <id> | pause <id> | resume <id> | drafts]',
          execute: async (argsText, cmdCtx) => this.handleSlashCommand(argsText ?? '', cmdCtx),
        });
        if (typeof offCmd === 'function') this.disposers.push(offCmd);
      } catch {
        void 0;
      }
    }

    return () => this.dispose();
  }

  async handleSlashCommand(argsText: string, cmdCtx?: { sessionId?: string }): Promise<string> {
    const parts = argsText.trim().split(/\s+/).filter(Boolean);
    const sub = parts[0] ?? 'list';
    const targetId = parts[1];

    if (sub === 'cancel' && targetId) {
      const ok = applyWorkstreamCancel(this.watcher, targetId, 'cancelled_by_slash_command');
      return ok ? `Stopped watch: ${targetId}` : `Watch not found: ${targetId}`;
    }
    if (sub === 'pause' && targetId) {
      const ok = applyWorkstreamUpdate(this.watcher, targetId, { paused: true });
      return ok ? `Paused watch: ${targetId}` : `Watch not found: ${targetId}`;
    }
    if (sub === 'resume' && targetId) {
      const ok = applyWorkstreamUpdate(this.watcher, targetId, { paused: false });
      return ok ? `Resumed watch: ${targetId}` : `Watch not found: ${targetId}`;
    }
    if (sub === 'status') {
      const st = this.watcher.getStatus();
      return `Hub status: connectors=${st.connectors.length}, sources=${st.sources.length}, sinks=${st.sinks.length}, activeSubscriptions=${st.activeSubscriptions}, activeWorkstreams=${st.activeWorkstreams}, unreadInbox=${st.unreadInbox}, pendingDrafts=${st.pendingDrafts}, wechat=${st.wechatTransportMode}, rev=${st.configRevision}.`;
    }
    if (sub === 'drafts') {
      const drafts = this.watcher.listDrafts({ status: 'pending_approval' });
      if (drafts.length === 0) return 'No pending outbound drafts.';
      return drafts
        .map((d) => `- [${d.id}] ${d.sinkId}/${d.action}: ${d.previewText.slice(0, 80)}`)
        .join('\n');
    }

    const list = this.watcher.listWorkstreams({ sessionId: cmdCtx?.sessionId, status: 'active' });
    if (list.length === 0) {
      const st = this.watcher.getStatus();
      return `No active watches in this session (active=${st.activeWorkstreams}, subscriptions=${st.activeSubscriptions}, unreadInbox=${st.unreadInbox}, pendingDrafts=${st.pendingDrafts}).`;
    }
    return list
      .map((w) => `- [${w.id}] ${w.primaryEntityKey} · ${w.trustMode} · ${w.deliveryCount}/${w.maxWakeups} · expires ${w.ttlExpiresAt}`)
      .join('\n');
  }

  dispose(): void {
    while (this.disposers.length > 0) {
      try {
        this.disposers.pop()?.();
      } catch {
      }
    }
  }
}

export function createPosteriorLayer(ctx: PosteriorContext, watcher: PosteriorWatcherHandle): PosteriorLayer {
  return new PosteriorLayer(ctx, watcher);
}
