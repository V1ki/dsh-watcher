import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  DynamicPersonaCard,
  HubService,
  NormalizedEvent,
  ThreadSubscription,
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
  session?: unknown;
  followup?: (message: unknown) => void;
}

export interface SessionControllerLike {
  create?: (
    input: { sessionId?: string; cwd?: string; workspaceId?: string; agentPreset?: string },
  ) => Promise<{ sessionId: string }>;
  rename?: (input: { sessionId: string; title: string }) => Promise<unknown>;
  resolveAgent?: (
    sessionId: string,
  ) => Promise<{ agent?: SessionAgentLike; error?: { code?: string; message?: string } } | SessionAgentLike>;
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
  execute: (args: Record<string, unknown>) => Promise<unknown>;
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
}

export interface RouterToolCallbacks {
  submitWorkerReport: (input: WorkerReportInput) => Promise<RouterDecisionRecord> | RouterDecisionRecord;
}

function readOptionalService<T>(
  ctx: WorkerDispatcherContext | undefined,
  key: 'workspaceController' | 'workspaceRegistry' | 'sessionController' | 'tools',
): T | undefined {
  if (!ctx) return undefined;
  if (typeof ctx.get === 'function') {
    return ctx.get(key) as T | undefined;
  }
  return ctx[key] as T | undefined;
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

  const wsController = readOptionalService<WorkspaceControllerLike>(ctx, 'workspaceController');
  const registry = readOptionalService<WorkspaceRegistryLike>(ctx, 'workspaceRegistry');
  const controller = readOptionalService<SessionControllerLike>(ctx, 'sessionController');

  const sessionTitle = `Router · ${event.source} · ${event.threadKey}`.slice(0, 80);
  let sessionId = `worker_${randomUUID().slice(0, 8)}`;

  if (wsController?.create && controller?.create) {
    try {
      fs.mkdirSync(workspacePath, { recursive: true, mode: 0o700 });
      const wsRes = await wsController.create({ path: workspacePath });
      const workspaceId = wsRes?.workspace?.workspaceId ?? wsRes?.workspace?.id ?? wsRes?.id;
      if (wsRes?.created && workspaceId && wsController.rename) {
        await wsController.rename({ workspaceId, title: sessionTitle }).catch(() => {});
      }
      const desiredSessionId = randomUUID();
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
    }
  } else if (registry?.resolveByPath && registry?.create && controller?.create) {
    try {
      const ws = (await registry.resolveByPath(workspacePath)) ?? (await registry.create(workspacePath));
      const created = await controller.create({
        workspaceId: ws.id,
        agentPreset: 'standard',
      });
      if (created?.sessionId) {
        sessionId = created.sessionId;
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
  };
}

function registerOnToolsRegistry(
  tools: ToolsRegistryLike | undefined,
  callbacks: RouterToolCallbacks,
): () => void {
  if (!tools?.register) return () => {};
  const schema = {
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
  const dispose = tools.register({
    name: 'router_report_result',
    description:
      'Submit a concise Worker report back to DSH Router for owner review in WeChat. conclusion MUST be plain Simplified Chinese strictly <= 200 chars (conclusion, risk, decision point only — no function-name laundry list). draftText is ONLY shown to the owner in WeChat for approval and is NEVER posted to GitHub automatically (publish only after owner confirmation via explicit GitHub write tools); keep draftText human and concise (3-6 sentences, <= 500-600 chars, no line-by-line code recap or titled AI essays).',
    parameters: schema,
    inputSchema: schema,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args) => {
      const decisionId = typeof args.decisionId === 'string' ? args.decisionId.trim() : '';
      const conclusion = typeof args.conclusion === 'string' ? args.conclusion.trim() : '';
      if (!decisionId || !conclusion) {
        throw new Error('router_report_result requires non-empty decisionId and conclusion');
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
  return typeof dispose === 'function' ? dispose : () => {};
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
