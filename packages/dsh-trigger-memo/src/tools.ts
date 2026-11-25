import type { MemoKind, MemoRecord, MemoStatus } from '@local/dsh-hub/contracts';
import type { MemoEngine } from './scheduler.js';

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

export interface MemoToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  parameters?: Record<string, unknown>;
  output?: {
    schema: Record<string, unknown>;
    render: (args: unknown, value: unknown) => Array<{ type: string; text: string }>;
  };
  execute: (args: Record<string, unknown>, exec?: ToolExecutionContext) => Promise<unknown>;
}

export interface ToolsRegistryLike {
  register?: (def: MemoToolDefinition) => (() => void) | void;
}

export interface MemoToolsContext {
  get?: (name: string) => unknown;
  inject?: (deps: readonly string[], callback: (subCtx: MemoToolsContext) => void) => unknown;
  effect?: (callback: () => (() => void) | void) => unknown;
  tools?: ToolsRegistryLike;
}

const VALID_KINDS = new Set<MemoKind>(['time_nudge', 'news_followup', 'long_watch']);
const VALID_STATUSES = new Set<MemoStatus>(['active', 'fired', 'torn', 'completed', 'expired']);

function assertRootSessionCaller(exec?: ToolExecutionContext): { sessionId: string } {
  const sessionId = exec?.agent?.id;
  const header = exec?.agent?.session?.header;
  if (!sessionId) {
    throw new Error('watcher_memo_* tools require an active DSH root session context (exec.agent.id).');
  }
  if (header && ((header.delegationDepth ?? 0) > 0 || header.origin === 'subagent')) {
    throw new Error('Subagents are not permitted to invoke watcher_memo_* tools.');
  }
  return { sessionId };
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? '').trim()).filter(Boolean);
}

function asOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asOptionalNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function resolveBoundWechatChat(ctx: MemoToolsContext, sessionId: string): string | null {
  try {
    const resolver =
      typeof ctx.get === 'function'
        ? (ctx.get('wxarcSessionChat') as ((sid: string) => string | null) | undefined)
        : undefined;
    if (typeof resolver === 'function') {
      const chatId = resolver(sessionId);
      if (typeof chatId === 'string' && chatId.trim()) return chatId.trim();
    }
  } catch {
  }
  return null;
}

export function registerMemoTools(
  ctx: MemoToolsContext,
  engine: MemoEngine,
): Array<() => void> {
  const tools =
    typeof ctx.get === 'function'
      ? (ctx.get('tools') as ToolsRegistryLike | undefined)
      : ctx.tools;
  if (!tools?.register) return [];

  const addSchema = {
    type: 'object',
    required: ['kind', 'basis'],
    properties: {
      kind: {
        type: 'string',
        enum: ['time_nudge', 'news_followup', 'long_watch'],
        description: 'Memo mode: time_nudge (scheduled reminder), news_followup, or long_watch',
      },
      roomKey: {
        type: 'string',
        description: 'Room identifier (defaults to session:<sessionId> if omitted)',
      },
      targetChatId: {
        type: 'string',
        description: 'Optional WeChat chatId for atmosphere check and proactive opening',
      },
      title: {
        type: 'string',
        description: 'Short label for the memo',
      },
      basis: {
        type: 'string',
        description: 'Context and reason why this memo was created',
      },
      windowStart: {
        type: 'string',
        description: 'ISO timestamp for start of firing window (time_nudge)',
      },
      windowEnd: {
        type: 'string',
        description: 'ISO timestamp for end of firing window (time_nudge)',
      },
      intervalHours: {
        type: 'number',
        description: 'Polling interval in hours (6-12 for news_followup, 72-168 for long_watch)',
      },
      expiresAt: {
        type: 'string',
        description: 'Optional ISO expiry timestamp (capped at 3 days for news_followup)',
      },
      keywords: {
        type: 'array',
        items: { type: 'string' },
        description: 'Search and topic-matching keywords',
      },
      knownFacts: {
        type: 'array',
        items: { type: 'string' },
        description: 'Already known facts to filter out rehashed updates',
      },
      knownFactsUpdatedAt: {
        type: 'string',
        description: 'ISO timestamp of when knownFacts were last updated',
      },
      acceptCriteria: {
        type: 'string',
        description: 'Strict acceptance rule for long_watch official release matching',
      },
      officialDomains: {
        type: 'array',
        items: { type: 'string' },
        description: 'Allowed official domains or domain/path prefixes for long_watch',
      },
      notifyWechatChatId: {
        type: 'string',
        description: 'WeChat chatId to send a direct reminder message to when due or matched',
      },
    },
  };

  const jsonOutput = {
    schema: { type: 'object', additionalProperties: true },
    render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
  };

  const addTool = tools.register({
    name: 'watcher_memo_add',
    description:
      'Create a proactive reminder/memo (time_nudge, news_followup, or long_watch) in Hub Memo Book. For WeChat reminders, set kind="time_nudge" with windowStart/windowEnd and notifyWechatChatId so it delivers directly to WeChat when due.',
    inputSchema: addSchema,
    parameters: addSchema,
    output: jsonOutput,
    execute: async (args, exec): Promise<{ ok: true; memo: MemoRecord; activeInRoom: number }> => {
      const { sessionId } = assertRootSessionCaller(exec);
      const rawKind = String(args.kind || '') as MemoKind;
      if (!VALID_KINDS.has(rawKind)) {
        throw new TypeError(`Unsupported memo kind: ${String(args.kind)}`);
      }
      const basis = asOptionalString(args.basis);
      if (!basis) {
        throw new TypeError('watcher_memo_add requires a non-empty basis');
      }
      const boundChat = resolveBoundWechatChat(ctx, sessionId);
      const targetChatId = asOptionalString(args.targetChatId) ?? boundChat;
      const notifyWechatChatId =
        asOptionalString(args.notifyWechatChatId) ?? (rawKind === 'time_nudge' ? boundChat : null);
      const roomKey =
        asOptionalString(args.roomKey) ??
        (targetChatId ? `wechat:${targetChatId}` : `session:${sessionId}`);

      const memo = engine.createMemo({
        kind: rawKind,
        roomKey,
        targetSessionId: sessionId,
        targetChatId,
        source: 'tool',
        title: asOptionalString(args.title) ?? '',
        basis,
        windowStart: asOptionalString(args.windowStart),
        windowEnd: asOptionalString(args.windowEnd),
        intervalHours: asOptionalNumber(args.intervalHours),
        expiresAt: asOptionalString(args.expiresAt),
        keywords: asStringArray(args.keywords),
        knownFacts: asStringArray(args.knownFacts),
        knownFactsUpdatedAt: asOptionalString(args.knownFactsUpdatedAt),
        acceptCriteria: asOptionalString(args.acceptCriteria),
        officialDomains: asStringArray(args.officialDomains),
        notifyWechatChatId,
      });

      return {
        ok: true,
        memo,
        activeInRoom: engine.store.countActiveMemos(roomKey),
      };
    },
  });

  const listSchema = {
    type: 'object',
    properties: {
      roomKey: { type: 'string', description: 'Optional roomKey filter' },
      status: {
        type: 'string',
        enum: ['active', 'fired', 'torn', 'completed', 'expired'],
        description: 'Optional memo status filter',
      },
      kind: {
        type: 'string',
        enum: ['time_nudge', 'news_followup', 'long_watch'],
        description: 'Optional memo kind filter',
      },
      limit: { type: 'integer', description: 'Max number of memos to return (default 50)' },
    },
  };

  const listTool = tools.register({
    name: 'watcher_memo_list',
    description: 'List proactive memos filtered by room, status, or kind.',
    inputSchema: listSchema,
    parameters: listSchema,
    output: jsonOutput,
    execute: async (args, exec): Promise<{ ok: true; memos: MemoRecord[]; count: number }> => {
      const { sessionId } = assertRootSessionCaller(exec);
      const boundChat = resolveBoundWechatChat(ctx, sessionId);
      const rawStatus = asOptionalString(args.status) as MemoStatus | null;
      const status = rawStatus && VALID_STATUSES.has(rawStatus) ? rawStatus : undefined;
      const rawKind = asOptionalString(args.kind) as MemoKind | null;
      const kind = rawKind && VALID_KINDS.has(rawKind) ? rawKind : undefined;
      const limit = asOptionalNumber(args.limit) ?? 50;

      const memos = engine.store.listMemos({
        roomKey: asOptionalString(args.roomKey) ?? (boundChat ? `wechat:${boundChat}` : undefined),
        status,
        kind,
        limit,
      });
      return { ok: true, memos, count: memos.length };
    },
  });

  const cancelSchema = {
    type: 'object',
    required: ['memoId'],
    properties: {
      memoId: { type: 'string', description: 'ID of the memo to cancel' },
      reason: { type: 'string', description: 'Optional cancellation reason' },
    },
  };

  const cancelTool = tools.register({
    name: 'watcher_memo_cancel',
    description: 'Cancel (tear up) an active proactive memo by ID so it will not fire.',
    inputSchema: cancelSchema,
    parameters: cancelSchema,
    output: jsonOutput,
    execute: async (
      args,
      exec,
    ): Promise<{ ok: boolean; memo: MemoRecord | null; detail: string }> => {
      assertRootSessionCaller(exec);
      const memoId = asOptionalString(args.memoId);
      if (!memoId) {
        throw new TypeError('watcher_memo_cancel requires memoId');
      }
      const reason = asOptionalString(args.reason) ?? 'cancelled_by_tool';
      const updated = engine.store.cancelMemo(memoId, reason);
      if (!updated) {
        return { ok: false, memo: null, detail: `Memo not found: ${memoId}` };
      }
      return { ok: true, memo: updated, detail: `Cancelled memo ${memoId}` };
    },
  });

  return [addTool, listTool, cancelTool].filter(
    (dispose): dispose is () => void => typeof dispose === 'function',
  );
}
