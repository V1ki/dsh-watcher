import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  DynamicPersonaCard,
  HubService,
  NormalizedEvent,
  PersonaWardrobe,
  SessionVaultTier,
  ThreadSubscription,
  ToolExecutionContext,
  TrustLevel,
  VaultVisibility,
} from '@local/dsh-hub/contracts';
import type { RouterDecisionRecord, WorkerReportInput, WorkerReportMode } from './contracts.js';

export interface WorkspaceHandleLike {
  attachSession?: (sessionId: string) => Promise<unknown> | unknown;
}

export interface WorkspaceControllerLike {
  create?: (input: { path: string }) => Promise<{
    created?: boolean;
    id?: string;
    workspace?: { workspaceId?: string; id?: string };
  }>;
  rename?: (input: { workspaceId: string; title: string }) => Promise<unknown>;
}

export interface WorkspaceRegistryLike {
  get?: (workspaceId: string) => WorkspaceHandleLike | undefined;
  resolveByPath?: (workspacePath: string) => Promise<{ id: string } | null | undefined>;
  create?: (workspacePath: string) => Promise<{ id: string }>;
}

export interface SessionAgentLike {
  id?: string;
  session?: {
    id?: string;
    header?: {
      cwd?: string;
      delegationDepth?: number;
      origin?: string;
      parentSession?: string;
      parentSessionId?: string;
      rootSessionId?: string;
    };
  };
  followup?: (message: unknown) => void;
  inject?: (message: unknown) => void;
}

export interface SessionControllerLike {
  create?: (
    input: { sessionId?: string; cwd?: string; workspaceId?: string; agentPreset?: string },
  ) => Promise<{ sessionId: string }>;
  rename?: (input: { sessionId: string; title: string }) => Promise<unknown>;
  resolveAgent?: (
    sessionId: string,
  ) => Promise<{ agent?: SessionAgentLike; error?: { code?: string; message?: string } } | SessionAgentLike>;
  prompt?: (input: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
}

export interface ToolDefinitionLike {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  parameters?: Record<string, unknown>;
  output?: {
    schema: Record<string, unknown>;
    render: (args: unknown, value: unknown) => Array<{ type: string; text: string }>;
  };
  execute: (args: Record<string, unknown>, exec?: ToolExecutionContext) => Promise<unknown>;
}

export interface ToolsRegistryLike {
  register?: (def: ToolDefinitionLike) => (() => void) | void;
}

export interface WorkerDispatcherContext {
  get?: (name: string) => unknown;
  inject?: (deps: readonly string[], callback: (subCtx: WorkerDispatcherContext) => void) => unknown;
  effect?: (callback: () => (() => void) | void) => unknown;
  workspaceController?: WorkspaceControllerLike;
  workspaceRegistry?: WorkspaceRegistryLike;
  sessionController?: SessionControllerLike;
  tools?: ToolsRegistryLike;
  permissionPresets?: {
    set?: (session: unknown, preset: string) => Promise<unknown> | unknown;
  };
  sandboxPolicy?: {
    setMode?: (session: unknown, mode: string) => Promise<unknown> | unknown;
  };
  approval?: {
    setPolicy?: (target: unknown, policy: string) => Promise<unknown> | unknown;
  };
  agents?: {
    get?: (sessionId: string) => SessionAgentLike | undefined;
  };
}

export interface DispatchWorkerInput {
  hub: HubService;
  ctx?: WorkerDispatcherContext;
  event: NormalizedEvent;
  decision: RouterDecisionRecord;
  personaId?: string | null;
  homeDir?: string;
}

export interface DispatchWorkerResult {
  sessionId: string;
  subscription: ThreadSubscription;
  workspacePath: string;
  delivered: boolean;
  personaId: string | null;
  tier: SessionVaultTier;
  targetCircle: VaultVisibility;
  sandboxMode: 'read-only' | 'workspace-write';
}

export interface WorkerPrincipalSpecInput {
  source: string;
  threadKey: string;
  actor?: string | null;
  trustLevel?: TrustLevel | null;
  repo?: string | null;
  payload?: Record<string, unknown>;
  targetCircleHint?: VaultVisibility | null;
}

export interface WorkerPrincipalSpec {
  tier: SessionVaultTier;
  trustLevel: TrustLevel;
  targetCircle: VaultVisibility;
  repoName: string | null;
}

export interface RouterTasksToolInput {
  status?: 'active' | 'all';
  limit?: number;
}

export interface RouterSendToTaskToolInput {
  action?: 'message' | 'approve_draft' | 'discard_draft' | 'resolve';
  taskRef?: string;
  message?: string;
  draftId?: string;
  reason?: string;
}

export interface RouterToolCallbacks {
  hub: HubService;
  submitWorkerReport: (input: WorkerReportInput) => Promise<RouterDecisionRecord> | RouterDecisionRecord;
  listTasks?: (input: RouterTasksToolInput) => Promise<Record<string, unknown>> | Record<string, unknown>;
  sendToTask?: (input: RouterSendToTaskToolInput) => Promise<Record<string, unknown>> | Record<string, unknown>;
}

function readOptionalService<T>(
  ctx: WorkerDispatcherContext | undefined,
  key:
    | 'workspaceController'
    | 'workspaceRegistry'
    | 'sessionController'
    | 'tools'
    | 'permissionPresets'
    | 'sandboxPolicy'
    | 'approval'
    | 'agents',
): T | undefined {
  if (!ctx) return undefined;
  if (typeof ctx.get === 'function') {
    return ctx.get(key) as T | undefined;
  }
  return ctx[key] as T | undefined;
}

const WORK_SOURCES = new Set(['dingtalk', 'feishu', 'lark', 'jira', 'linear', 'slack', 'work']);

function extractRepoFromThreadKey(source: string, threadKey: string): string | null {
  if (source !== 'github') return null;
  const trimmed = threadKey.trim().replace(/^github:/i, '');
  const hashIdx = trimmed.indexOf('#');
  const candidate = hashIdx > 0 ? trimmed.slice(0, hashIdx) : trimmed;
  return /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(candidate) ? candidate : null;
}

function readLabeledCircleFromWardrobe(
  wardrobe: PersonaWardrobe | null,
  roomKey: string,
): VaultVisibility | null {
  if (!wardrobe || !roomKey) return null;
  const ext = wardrobe as PersonaWardrobe & {
    resolveChatCircle?: (key: string) => { circle?: string; labeled?: boolean } | null;
  };
  if (typeof ext.resolveChatCircle === 'function') {
    const rec = ext.resolveChatCircle(roomKey);
    if (rec?.labeled === true) {
      if (
        rec.circle === 'external' ||
        rec.circle === 'work' ||
        rec.circle === 'family' ||
        rec.circle === 'owner_private'
      ) {
        return rec.circle;
      }
    }
    return null;
  }
  if (typeof wardrobe.resolveVaultVisibility === 'function') {
    const vis = wardrobe.resolveVaultVisibility(roomKey);
    if (vis === 'external' || vis === 'work' || vis === 'family') {
      return vis;
    }
  }
  return null;
}

export async function resolveWorkerPrincipalSpec(
  hub: HubService,
  input: WorkerPrincipalSpecInput,
): Promise<WorkerPrincipalSpec> {
  const sourceLower = input.source.trim().toLowerCase();
  const payload = input.payload ?? {};
  const repoName =
    (typeof input.repo === 'string' && input.repo.trim()) ||
    (typeof payload.repo === 'string' && payload.repo.trim()) ||
    extractRepoFromThreadKey(sourceLower, input.threadKey);

  let matchedRepoSensitive = false;
  let isConfiguredOwner = false;
  try {
    const githubAdmin = hub.getGitHubAdmin?.();
    if (githubAdmin) {
      const cfg = await githubAdmin.getConfig();
      if (repoName && Array.isArray(cfg.repos)) {
        const lower = repoName.toLowerCase();
        const matched = cfg.repos.find((r) => r.repo.toLowerCase() === lower);
        if (matched?.sensitive === true) {
          matchedRepoSensitive = true;
        }
      }
      const actorLower = (input.actor ?? '').trim().toLowerCase();
      if (actorLower) {
        const owners = [...(cfg.ownerLogins ?? []), ...(cfg.autoSendOwners ?? [])]
          .map((o) => String(o ?? '').trim().toLowerCase())
          .filter(Boolean);
        if (owners.includes(actorLower)) {
          isConfiguredOwner = true;
        }
      }
    }
  } catch {
  }

  const isPrivatePayload =
    payload.private === true ||
    payload.repoPrivate === true ||
    payload.isPrivate === true ||
    (typeof payload.visibility === 'string' && payload.visibility.trim().toLowerCase() === 'private') ||
    (typeof payload.repoVisibility === 'string' &&
      payload.repoVisibility.trim().toLowerCase() === 'private');

  const isWorkSource =
    WORK_SOURCES.has(sourceLower) ||
    sourceLower.startsWith('dingtalk') ||
    sourceLower.startsWith('feishu');

  const circleKey =
    sourceLower === 'github' && repoName
      ? `github:${repoName}`
      : `${sourceLower}:${input.threadKey}`;
  const labeledCircle = readLabeledCircleFromWardrobe(hub.getWardrobe?.() ?? null, circleKey);

  let targetCircle: VaultVisibility;
  if (input.targetCircleHint) {
    targetCircle = input.targetCircleHint;
  } else if (labeledCircle) {
    targetCircle = labeledCircle;
  } else if (sourceLower === 'github') {
    targetCircle = matchedRepoSensitive || isPrivatePayload ? 'work' : 'external';
  } else if (isWorkSource) {
    targetCircle = 'work';
  } else {
    targetCircle = input.trustLevel === 'owner' ? 'work' : 'external';
  }

  const trustLevel: TrustLevel =
    input.trustLevel ?? (isConfiguredOwner ? 'owner' : 'triage');

  let tier: SessionVaultTier;
  if (trustLevel === 'owner' || isConfiguredOwner) {
    tier = 3;
  } else if (
    targetCircle === 'work' ||
    isWorkSource ||
    matchedRepoSensitive ||
    isPrivatePayload
  ) {
    tier = 2;
  } else {
    tier = 1;
  }

  return {
    tier,
    trustLevel,
    targetCircle,
    repoName,
  };
}

function expandPath(rawPath: string, homeDir?: string): string {
  const baseHome = homeDir ?? os.homedir();
  const trimmed = rawPath.trim();
  if (trimmed === '~') return baseHome;
  return trimmed.startsWith('~/') ? path.join(baseHome, trimmed.slice(2)) : path.resolve(trimmed);
}

function sanitizeWorkspaceKey(input: string): string {
  const clean = input.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return (clean || 'thread').slice(0, 72);
}

async function resolveWorkspaceAndPersona(
  hub: HubService,
  event: NormalizedEvent,
  explicitPersonaId?: string | null,
  homeDir?: string,
): Promise<{ workspacePath: string; personaId: string | null }> {
  const payloadPath =
    typeof event.payload?.workspacePath === 'string' && event.payload.workspacePath.trim()
      ? expandPath(event.payload.workspacePath, homeDir)
      : null;

  const repoName =
    (typeof event.rawRef?.repo === 'string' && event.rawRef.repo.trim()) ||
    (typeof event.payload?.repo === 'string' && event.payload.repo.trim()) ||
    null;

  let repoPath: string | null = null;
  let configPersonaId: string | null = null;

  try {
    const githubAdmin = hub.getGitHubAdmin?.();
    if (githubAdmin) {
      const cfg = await githubAdmin.getConfig();
      if (repoName && Array.isArray(cfg.repos)) {
        const lower = repoName.toLowerCase();
        const matched = cfg.repos.find((r) => r.repo.toLowerCase() === lower);
        if (matched?.localPath?.trim()) {
          repoPath = expandPath(matched.localPath, homeDir);
        }
        if (matched?.personaId?.trim()) {
          configPersonaId = matched.personaId.trim();
        }
      }
      if (!configPersonaId && cfg.defaultPersonaId?.trim()) {
        configPersonaId = cfg.defaultPersonaId.trim();
      }
    }
  } catch {
  }

  const baseHome = homeDir ?? os.homedir();
  const fallbackKey = sanitizeWorkspaceKey(`${event.source}-${event.threadKey}`);
  const workspacePath = repoPath ?? payloadPath ?? path.join(baseHome, 'DSH-Router-Workspaces', fallbackKey);
  const personaId = explicitPersonaId?.trim() || configPersonaId || null;

  return { workspacePath, personaId };
}

function buildWorkerBrief(
  event: NormalizedEvent,
  decision: RouterDecisionRecord,
  personaCard: DynamicPersonaCard | null,
): string {
  const lines: string[] = [
    '[DSH Router Worker Assignment]',
    `decisionId: ${decision.id}`,
    `source: ${event.source}`,
    `threadKey: ${event.threadKey}`,
    `eventType: ${event.type}`,
    `level: ${decision.level}`,
    `actor: ${decision.actor}`,
    `summary: ${decision.summary}`,
    `triageReason: ${decision.reason}`,
  ];
  if (decision.rawUrl) {
    lines.push(`url: ${decision.rawUrl}`);
  }
  if (personaCard?.promptBlock?.trim()) {
    lines.push('', '[Persona]', personaCard.promptBlock.trim());
  }
  lines.push(
    '',
    '处理要求：',
    '1. 直接在当前工作区查清情况或准备好改动；不要往业务仓库里乱写分析报告或临时 .md 文件。',
    '2. conclusion 必须用大白话、严格控制在 200 字以内：只说结论、风险和需要管理员拍板的点，不要背函数名、文件路径和代码流水账，也不要硬凑 4 选 1 战略题。',
    '3. 如果准备对外发 GitHub 评论或回复，把拟发送原文填到 draftText：像真人维护者一样 3–6 句话说完（一般不超过 500–600 字符），只给判断和需要改的点，不要把作者刚写的代码细节逐行复述给作者听，不要写带小标题的 AI 评审长文。',
    '4. 重要：router_report_result(draftText) 仅用于把草稿发给管理员在微信审阅确认，不会自动发到 GitHub；真要发到 GitHub 必须等管理员确认后再明确调用 GitHub 写入工具。',
    '5. 如果改了界面或样式，实际跑起来截一张运行图，把图片绝对路径填到 imagePath；没实测到、或者不确定的地方诚实写进 blindspot。',
    `6. 查完或改完后调用 router_report_result（decisionId="${decision.id}"），填好 conclusion 以及按需填写 draftText、imagePath、blindspot、question、mode。`,
  );
  return lines.join('\n');
}

function createRouterMessage(text: string, metadata: Record<string, unknown>): Record<string, unknown> {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'dsh-router:worker',
      ...metadata,
    },
  };
}

export async function sendWorkerFollowup(
  ctx: WorkerDispatcherContext | undefined,
  sessionId: string,
  text: string,
  metadata: Record<string, unknown> = {},
): Promise<boolean> {
  const controller = readOptionalService<SessionControllerLike>(ctx, 'sessionController');
  if (!controller?.resolveAgent) return false;
  try {
    const resolved = await controller.resolveAgent(sessionId);
    const agent =
      resolved && typeof resolved === 'object' && 'agent' in resolved
        ? resolved.agent
        : (resolved as SessionAgentLike | undefined);
    if (!agent || typeof agent.followup !== 'function') return false;
    agent.followup(createRouterMessage(text, metadata));
    return true;
  } catch {
    return false;
  }
}

export async function dispatchWorker(input: DispatchWorkerInput): Promise<DispatchWorkerResult> {
  const { hub, ctx, event, decision } = input;
  const { workspacePath, personaId } = await resolveWorkspaceAndPersona(
    hub,
    event,
    input.personaId,
    input.homeDir,
  );
  const principalSpec = await resolveWorkerPrincipalSpec(hub, {
    source: event.source,
    threadKey: event.threadKey,
    actor: event.actor.login ?? event.actor.displayName ?? event.actor.id,
    trustLevel: event.trustLevel,
    repo:
      (typeof event.rawRef?.repo === 'string' && event.rawRef.repo.trim()) ||
      (typeof event.payload?.repo === 'string' && event.payload.repo.trim()) ||
      null,
    payload: event.payload,
  });

  const wsController = readOptionalService<WorkspaceControllerLike>(ctx, 'workspaceController');
  const registry = readOptionalService<WorkspaceRegistryLike>(ctx, 'workspaceRegistry');
  const controller = readOptionalService<SessionControllerLike>(ctx, 'sessionController');
  const permissionPresets = readOptionalService<WorkerDispatcherContext['permissionPresets']>(
    ctx,
    'permissionPresets',
  );
  const sandboxPolicy = readOptionalService<WorkerDispatcherContext['sandboxPolicy']>(
    ctx,
    'sandboxPolicy',
  );

  const sessionTitle = `Router · ${event.source} · ${event.threadKey}`.slice(0, 80);
  const desiredSessionId: string = randomUUID();
  let sessionId: string = desiredSessionId;

  const registerWorkerPrincipal = (sid: string): (() => void) | undefined =>
    hub.registerSessionPrincipal?.({
      sessionId: sid,
      role: 'worker',
      tier: principalSpec.tier,
      trustLevel: principalSpec.trustLevel,
      boundSource: event.source,
      boundThreadKey: event.threadKey,
      boundDecisionId: decision.id,
      boundRepo: principalSpec.repoName,
      targetCircle: principalSpec.targetCircle,
    });

  let offPrePrincipal = registerWorkerPrincipal(desiredSessionId);

  if (wsController?.create && controller?.create) {
    try {
      fs.mkdirSync(workspacePath, { recursive: true, mode: 0o700 });
      const wsRes = await wsController.create({ path: workspacePath });
      const workspaceId = wsRes?.workspace?.workspaceId ?? wsRes?.workspace?.id ?? wsRes?.id;
      if (wsRes?.created && workspaceId && wsController.rename) {
        await wsController.rename({ workspaceId, title: sessionTitle }).catch(() => {});
      }
      const created = await controller.create({
        sessionId: desiredSessionId,
        cwd: workspacePath,
      });
      sessionId = created?.sessionId || desiredSessionId;
      if (workspaceId && registry?.get) {
        const wsHandle = registry.get(workspaceId);
        await wsHandle?.attachSession?.(sessionId);
      }
      if (controller.rename) {
        await controller.rename({ sessionId, title: sessionTitle }).catch(() => {});
      }
    } catch {
      sessionId = `worker_${desiredSessionId.slice(0, 8)}`;
    }
  } else if (registry?.resolveByPath && registry?.create && controller?.create) {
    try {
      const ws = (await registry.resolveByPath(workspacePath)) ?? (await registry.create(workspacePath));
      const created = await controller.create({
        sessionId: desiredSessionId,
        workspaceId: ws.id,
        agentPreset: 'standard',
      });
      if (created?.sessionId) {
        sessionId = created.sessionId;
      }
    } catch {
      sessionId = `worker_${desiredSessionId.slice(0, 8)}`;
    }
  } else {
    sessionId = `worker_${desiredSessionId.slice(0, 8)}`;
  }

  if (sessionId !== desiredSessionId) {
    offPrePrincipal?.();
    offPrePrincipal = registerWorkerPrincipal(sessionId);
  }

  const sandboxMode: 'read-only' | 'workspace-write' =
    decision.level === 'act' ? 'workspace-write' : 'read-only';

  if (controller?.resolveAgent && (permissionPresets?.set || sandboxPolicy?.setMode)) {
    try {
      const resolved = await controller.resolveAgent(sessionId);
      const agent =
        resolved && typeof resolved === 'object' && 'agent' in resolved
          ? resolved.agent
          : (resolved as SessionAgentLike | undefined);
      const targetSession = agent?.session ?? agent;
      if (targetSession) {
        if (permissionPresets?.set) {
          await permissionPresets.set(targetSession, sandboxMode);
        }
        if (sandboxPolicy?.setMode) {
          await sandboxPolicy.setMode(targetSession, sandboxMode);
        }
      }
    } catch {
    }
  }

  const subscription = hub.registerSubscription({
    source: event.source,
    threadKey: event.threadKey,
    sessionId,
    personaId,
    owner: 'router',
    metadata: {
      decisionId: decision.id,
      level: decision.level,
      tier: principalSpec.tier,
      targetCircle: principalSpec.targetCircle,
      sandboxMode,
    },
  });

  const personaCard = personaId
    ? (hub.getWardrobe()?.getDynamicCard({
        personaId,
        scope: `${event.source}:${event.threadKey}`,
        channel: event.source,
      }) ?? null)
    : null;

  const brief = buildWorkerBrief(event, decision, personaCard);
  const delivered = await sendWorkerFollowup(ctx, sessionId, brief, {
    decisionId: decision.id,
    source: event.source,
    threadKey: event.threadKey,
    level: decision.level,
  });

  return {
    sessionId,
    subscription,
    workspacePath,
    delivered,
    personaId,
    tier: principalSpec.tier,
    targetCircle: principalSpec.targetCircle,
    sandboxMode,
  };
}

function assertOwnerBridgeCaller(hub: HubService, exec: ToolExecutionContext | undefined, toolName: string): void {
  if (!exec) {
    throw new Error(`${toolName}_forbidden: missing execution context`);
  }
  const principal = hub.resolveSessionPrincipal?.(exec);
  if (
    !principal ||
    (principal.role !== 'owner_session' && principal.role !== 'interactive') ||
    principal.delegationDepth !== 0 ||
    principal.isSubagent
  ) {
    throw new Error(
      `${toolName}_forbidden: requires top-level owner_session or interactive caller`,
    );
  }
}

function registerOnToolsRegistry(
  tools: ToolsRegistryLike | undefined,
  callbacks: RouterToolCallbacks,
): () => void {
  if (!tools?.register) return () => {};
  const disposers: Array<() => void> = [];
  const reportSchema = {
    type: 'object',
    required: ['decisionId', 'conclusion'],
    additionalProperties: false,
    properties: {
      decisionId: { type: 'string', description: 'Router decision ID assigned to this Worker' },
      conclusion: {
        type: 'string',
        description:
          'Plain Simplified Chinese (简体中文) summary strictly <= 200 chars: state ONLY the conclusion, risk, and what needs owner sign-off; do NOT list function names or code play-by-play',
      },
      changes: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional short metadata list of touched items in Simplified Chinese (简体中文); NOT appended to the WeChat summary',
      },
      question: {
        type: 'string',
        description: 'Optional decision question for the user, MUST be written in Simplified Chinese (简体中文)',
      },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional clickable choice options for the user, MUST be written in Simplified Chinese (简体中文)',
      },
      recommendedIndex: {
        type: 'number',
        description: 'Optional zero-based index of the recommended option',
      },
      urgent: { type: 'boolean', description: 'Whether the report requires immediate attention' },
      imagePath: {
        type: 'string',
        description: 'Optional absolute local path to a screenshot or image to attach to the WeChat report',
      },
      draftText: {
        type: 'string',
        description:
          'Optional outbound GitHub comment/reply draft for owner review in WeChat ONLY — calling router_report_result NEVER posts to GitHub automatically (you must wait for owner confirmation and explicitly invoke a GitHub write tool to publish). Write like a real human maintainer in 3-6 concise sentences (typically <= 500-600 chars) stating judgment and required edits; do NOT recap the author\'s code line by line or write titled AI review essays.',
      },
      blindspot: {
        type: 'string',
        description: 'Optional honest note about what was not verified or could not be tested',
      },
      mode: {
        type: 'string',
        enum: ['discuss', 'review_draft', 'done'],
        description: 'Optional interaction mode: discuss, review_draft, or done',
      },
    },
  };
  const offReport = tools.register({
    name: 'router_report_result',
    description:
      'Submit a concise Worker report back to DSH Router for owner review in WeChat. conclusion MUST be plain Simplified Chinese strictly <= 200 chars (conclusion, risk, decision point only — no function-name laundry list). draftText is ONLY shown to the owner in WeChat for approval and is NEVER posted to GitHub automatically (publish only after owner confirmation via explicit GitHub write tools); keep draftText human and concise (3-6 sentences, <= 500-600 chars, no line-by-line code recap or titled AI essays).',
    parameters: reportSchema,
    inputSchema: reportSchema,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args, exec) => {
      const decisionId = typeof args.decisionId === 'string' ? args.decisionId.trim() : '';
      const conclusion = typeof args.conclusion === 'string' ? args.conclusion.trim() : '';
      if (!decisionId || !conclusion) {
        throw new Error('router_report_result requires non-empty decisionId and conclusion');
      }
      if (exec !== undefined && typeof callbacks.hub.resolveSessionPrincipal === 'function') {
        const principal = callbacks.hub.resolveSessionPrincipal(exec);
        if (
          principal.role !== 'worker' ||
          principal.isSubagent ||
          principal.boundDecisionId !== decisionId
        ) {
          throw new Error(
            'router_report_result_forbidden: caller must be the bound worker for this decisionId',
          );
        }
      }
      const rawMode = typeof args.mode === 'string' ? args.mode.trim() : '';
      const mode: WorkerReportMode | undefined =
        rawMode === 'discuss' || rawMode === 'review_draft' || rawMode === 'done'
          ? rawMode
          : undefined;
      const report: WorkerReportInput = {
        decisionId,
        conclusion,
        changes: Array.isArray(args.changes)
          ? args.changes.map((c) => String(c ?? '').trim()).filter(Boolean)
          : undefined,
        question: typeof args.question === 'string' && args.question.trim() ? args.question.trim() : undefined,
        options: Array.isArray(args.options)
          ? args.options.map((o) => String(o ?? '').trim()).filter(Boolean)
          : undefined,
        recommendedIndex:
          typeof args.recommendedIndex === 'number' && Number.isInteger(args.recommendedIndex)
            ? args.recommendedIndex
            : undefined,
        urgent: typeof args.urgent === 'boolean' ? args.urgent : undefined,
        imagePath: typeof args.imagePath === 'string' && args.imagePath.trim() ? args.imagePath.trim() : undefined,
        draftText: typeof args.draftText === 'string' && args.draftText.trim() ? args.draftText.trim() : undefined,
        blindspot: typeof args.blindspot === 'string' && args.blindspot.trim() ? args.blindspot.trim() : undefined,
        mode,
      };
      const decision = await callbacks.submitWorkerReport(report);
      return { ok: true, decision };
    },
  });
  if (typeof offReport === 'function') disposers.push(offReport);

  if (callbacks.listTasks) {
    const tasksSchema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: {
          type: 'string',
          enum: ['active', 'all'],
          description: 'Filter tasks: active (default) or all',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of tasks to return (default 20, max 50)',
        },
      },
    };
    const offTasks = tools.register({
      name: 'router_tasks',
      description:
        'List active Router background tasks, deferred notifications, pending Hub outbound drafts, and pending approval requests for the owner.',
      parameters: tasksSchema,
      inputSchema: tasksSchema,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args, exec) => {
        assertOwnerBridgeCaller(callbacks.hub, exec, 'router_tasks');
        const status = args.status === 'all' ? 'all' : 'active';
        const limit =
          typeof args.limit === 'number' && Number.isFinite(args.limit)
            ? Math.max(1, Math.min(50, Math.floor(args.limit)))
            : 20;
        return callbacks.listTasks!({ status, limit });
      },
    });
    if (typeof offTasks === 'function') disposers.push(offTasks);
  }

  if (callbacks.sendToTask) {
    const sendSchema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['message', 'approve_draft', 'discard_draft', 'resolve'],
          description:
            'Action to perform: message (default, forward instruction to task Worker), approve_draft, discard_draft, or resolve',
        },
        taskRef: {
          type: 'string',
          description: 'Task short ID (e.g. 247 or #247) or full decisionId',
        },
        message: {
          type: 'string',
          description: 'Owner instruction to forward asynchronously to the task Worker',
        },
        draftId: {
          type: 'string',
          description: 'Hub staged draft ID for approve_draft or discard_draft',
        },
        reason: {
          type: 'string',
          description: 'Optional reason when discarding a draft',
        },
      },
    };
    const offSend = tools.register({
      name: 'router_send_to_task',
      description:
        'Forward an owner instruction asynchronously to a specific Router task Worker (with single-turn tier-3 elevation), mark a task resolved, or approve/discard a pending Hub outbound draft.',
      parameters: sendSchema,
      inputSchema: sendSchema,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args, exec) => {
        assertOwnerBridgeCaller(callbacks.hub, exec, 'router_send_to_task');
        const rawAction = typeof args.action === 'string' ? args.action.trim() : 'message';
        const action =
          rawAction === 'approve_draft' ||
          rawAction === 'discard_draft' ||
          rawAction === 'resolve'
            ? rawAction
            : 'message';
        return callbacks.sendToTask!({
          action,
          taskRef: typeof args.taskRef === 'string' ? args.taskRef.trim() : undefined,
          message: typeof args.message === 'string' ? args.message.trim() : undefined,
          draftId: typeof args.draftId === 'string' ? args.draftId.trim() : undefined,
          reason: typeof args.reason === 'string' ? args.reason.trim() : undefined,
        });
      },
    });
    if (typeof offSend === 'function') disposers.push(offSend);
  }

  return () => {
    while (disposers.length > 0) {
      try {
        disposers.pop()?.();
      } catch {
      }
    }
  };
}

export function registerRouterTools(
  ctx: WorkerDispatcherContext | undefined,
  callbacks: RouterToolCallbacks,
): () => void {
  if (!ctx) return () => {};
  if (typeof ctx.inject === 'function') {
    let activeDispose: () => void = () => {};
    ctx.inject(['tools'], (toolCtx) => {
      const tools = readOptionalService<ToolsRegistryLike>(toolCtx, 'tools');
      const dispose = registerOnToolsRegistry(tools, callbacks);
      activeDispose = dispose;
      toolCtx.effect?.(() => dispose);
    });
    return () => activeDispose();
  }
  const tools = readOptionalService<ToolsRegistryLike>(ctx, 'tools');
  return registerOnToolsRegistry(tools, callbacks);
}
