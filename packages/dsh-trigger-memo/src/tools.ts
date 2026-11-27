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

export interface MemoCallerPrincipal {
  sessionId: string;
  boundChatId: string | null;
  roomKey: string | null;
  isAdminDm: boolean;
  adminId?: string | null;
  delegationDepth: number;
  allowCrossRoom: boolean;
}

export type MemoPrincipalResolver = (
  sessionId: string,
  exec?: ToolExecutionContext,
) => MemoCallerPrincipal | null;

export interface MemoTargetBinding {
  chatId: string;
  roomKey: string;
  notifyWechatChatId: string;
  targetSessionId: string | null;
  title?: string | null;
}

export interface MemoTargetResolution {
  status: 'matched' | 'not_found' | 'ambiguous';
  target?: MemoTargetBinding;
  candidates?: Array<{ chatId: string; roomKey: string; title?: string | null }>;
  detail?: string;
}

export type MemoTargetResolver = (query: {
  roomKey?: string | null;
  targetChatId?: string | null;
  notifyWechatChatId?: string | null;
  targetSessionId?: string | null;
  targetName?: string | null;
}) => MemoTargetResolution;

export class MemoAuthorizationError extends Error {
  readonly code = 'MEMO_FORBIDDEN';

  constructor(message: string) {
    super(message);
    this.name = 'MemoAuthorizationError';
  }
}

export type MemoTargetErrorCode =
  | 'MEMO_TARGET_INVALID'
  | 'MEMO_TARGET_NOT_FOUND'
  | 'MEMO_TARGET_AMBIGUOUS'
  | 'MEMO_TARGET_MISMATCH';

export class MemoTargetError extends Error {
  readonly code: MemoTargetErrorCode;
  readonly candidates?: Array<{ chatId: string; roomKey: string; title?: string | null }>;

  constructor(
    code: MemoTargetErrorCode,
    message: string,
    candidates?: Array<{ chatId: string; roomKey: string; title?: string | null }>,
  ) {
    super(message);
    this.name = 'MemoTargetError';
    this.code = code;
    this.candidates = candidates;
  }
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
  wxarcSessionChat?: (sessionId: string) => string | null;
  wxarcMemoPrincipal?: MemoPrincipalResolver;
  wxarcTargetDirectory?: MemoTargetResolver;
}

interface ResolvedCallerAccess {
  sessionId: string;
  delegationDepth: number;
  boundChatId: string | null;
  currentRoomKey: string | null;
  canCrossRoom: boolean;
  adminId: string | null;
}

interface ResolvedAddTarget {
  roomKey: string;
  targetChatId: string | null;
  notifyWechatChatId: string | null;
  targetSessionId: string | null;
}

const VALID_KINDS = new Set<MemoKind>(['time_nudge', 'news_followup', 'long_watch']);
const VALID_STATUSES = new Set<MemoStatus>(['active', 'fired', 'torn', 'completed', 'expired']);
const CANCEL_DENIED_DETAIL = 'Memo not found or not cancellable in current room';

function assertRootSessionCaller(exec?: ToolExecutionContext): {
  sessionId: string;
  delegationDepth: number;
  origin: string | undefined;
} {
  const sessionId = exec?.agent?.id;
  const header = exec?.agent?.session?.header;
  if (!sessionId) {
    throw new Error('watcher_memo_* tools require an active DSH root session context (exec.agent.id).');
  }
  const delegationDepth = Number(header?.delegationDepth ?? 0);
  const origin = header?.origin;
  if (delegationDepth > 0 || origin === 'subagent') {
    throw new Error('Subagents are not permitted to invoke watcher_memo_* tools.');
  }
  return { sessionId, delegationDepth, origin };
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

function extractChatIdFromRoomKey(roomKey: string | null): string | null {
  if (!roomKey) return null;
  if (roomKey.startsWith('wechat:')) {
    const rest = roomKey.slice('wechat:'.length).trim();
    return rest || null;
  }
  return null;
}

function resolveBoundWechatChat(ctx: MemoToolsContext, sessionId: string): string | null {
  try {
    const resolver =
      (typeof ctx.get === 'function'
        ? (ctx.get('wxarcSessionChat') as ((sid: string) => string | null) | undefined)
        : undefined) ?? ctx.wxarcSessionChat;
    if (typeof resolver === 'function') {
      const chatId = resolver(sessionId);
      if (typeof chatId === 'string' && chatId.trim()) return chatId.trim();
    }
  } catch {
  }
  return null;
}

function resolvePrincipalResolver(ctx: MemoToolsContext): MemoPrincipalResolver | null {
  try {
    const resolver =
      (typeof ctx.get === 'function'
        ? (ctx.get('wxarcMemoPrincipal') as MemoPrincipalResolver | undefined)
        : undefined) ?? ctx.wxarcMemoPrincipal;
    if (typeof resolver === 'function') {
      return resolver;
    }
  } catch {
  }
  return null;
}

function resolveTargetDirectory(ctx: MemoToolsContext): MemoTargetResolver | null {
  try {
    const resolver =
      (typeof ctx.get === 'function'
        ? (ctx.get('wxarcTargetDirectory') as MemoTargetResolver | undefined)
        : undefined) ?? ctx.wxarcTargetDirectory;
    if (typeof resolver === 'function') {
      return resolver;
    }
  } catch {
  }
  return null;
}

function resolveCallerAccess(
  ctx: MemoToolsContext,
  exec?: ToolExecutionContext,
): ResolvedCallerAccess {
  const { sessionId, delegationDepth, origin } = assertRootSessionCaller(exec);
  const principalResolver = resolvePrincipalResolver(ctx);
  let principal: MemoCallerPrincipal | null = null;
  if (principalResolver) {
    try {
      principal = principalResolver(sessionId, exec);
    } catch {
      principal = null;
    }
  }
  const principalMatches = Boolean(principal && principal.sessionId === sessionId);
  const boundChatId =
    (principalMatches ? asOptionalString(principal?.boundChatId) : null) ??
    resolveBoundWechatChat(ctx, sessionId);
  const currentRoomKey =
    (principalMatches ? asOptionalString(principal?.roomKey) : null) ??
    (boundChatId ? `wechat:${boundChatId}` : null);
  const canCrossRoom = Boolean(
    principalMatches &&
      principal &&
      principal.isAdminDm === true &&
      principal.allowCrossRoom === true &&
      principal.delegationDepth === 0 &&
      delegationDepth === 0 &&
      origin !== 'subagent',
  );
  const adminId =
    canCrossRoom && principal ? asOptionalString(principal.adminId) : null;

  return {
    sessionId,
    delegationDepth,
    boundChatId,
    currentRoomKey,
    canCrossRoom,
    adminId,
  };
}

function assertConsistentWechatTargets(
  roomKey: string | null,
  targetChatId: string | null,
  notifyWechatChatId: string | null,
): void {
  const roomChatId = extractChatIdFromRoomKey(roomKey);
  if (roomChatId && targetChatId && roomChatId !== targetChatId) {
    throw new MemoTargetError(
      'MEMO_TARGET_MISMATCH',
      'roomKey and targetChatId refer to different chats.',
    );
  }
  if (roomChatId && notifyWechatChatId && roomChatId !== notifyWechatChatId) {
    throw new MemoTargetError(
      'MEMO_TARGET_MISMATCH',
      'roomKey and notifyWechatChatId refer to different chats.',
    );
  }
  if (targetChatId && notifyWechatChatId && targetChatId !== notifyWechatChatId) {
    throw new MemoTargetError(
      'MEMO_TARGET_MISMATCH',
      'targetChatId and notifyWechatChatId refer to different chats.',
    );
  }
}

function resolveVerifiedDirectoryTarget(
  resolver: MemoTargetResolver,
  query: {
    roomKey: string | null;
    targetChatId: string | null;
    notifyWechatChatId: string | null;
    targetSessionId: string | null;
    targetName: string | null;
  },
): MemoTargetBinding {
  const resolution = resolver(query);
  if (!resolution || resolution.status === 'not_found') {
    throw new MemoTargetError(
      'MEMO_TARGET_NOT_FOUND',
      resolution?.detail || 'Target room not found in target directory.',
    );
  }
  if (resolution.status === 'ambiguous') {
    throw new MemoTargetError(
      'MEMO_TARGET_AMBIGUOUS',
      resolution.detail || 'Target room is ambiguous; specify an exact room.',
      resolution.candidates,
    );
  }
  if (resolution.status !== 'matched' || !resolution.target) {
    throw new MemoTargetError(
      'MEMO_TARGET_INVALID',
      'Target directory did not return a valid room binding.',
    );
  }

  const chatId = asOptionalString(resolution.target.chatId);
  const roomKey = asOptionalString(resolution.target.roomKey);
  const notifyWechatChatId = asOptionalString(resolution.target.notifyWechatChatId);
  const targetSessionId = asOptionalString(resolution.target.targetSessionId);

  if (!chatId || !roomKey || !notifyWechatChatId) {
    throw new MemoTargetError(
      'MEMO_TARGET_INVALID',
      'Resolved target is missing required chatId, roomKey, or notifyWechatChatId.',
    );
  }
  if (roomKey !== `wechat:${chatId}` || notifyWechatChatId !== chatId) {
    throw new MemoTargetError(
      'MEMO_TARGET_MISMATCH',
      'Resolved target binding is internally inconsistent.',
    );
  }
  if (query.roomKey && query.roomKey !== roomKey) {
    throw new MemoTargetError(
      'MEMO_TARGET_MISMATCH',
      'Requested roomKey does not match resolved target.',
    );
  }
  if (query.targetChatId && query.targetChatId !== chatId) {
    throw new MemoTargetError(
      'MEMO_TARGET_MISMATCH',
      'Requested targetChatId does not match resolved target.',
    );
  }
  if (query.notifyWechatChatId && query.notifyWechatChatId !== notifyWechatChatId) {
    throw new MemoTargetError(
      'MEMO_TARGET_MISMATCH',
      'Requested notifyWechatChatId does not match resolved target.',
    );
  }
  if (query.targetSessionId && targetSessionId && query.targetSessionId !== targetSessionId) {
    throw new MemoTargetError(
      'MEMO_TARGET_MISMATCH',
      'Requested targetSessionId does not match resolved target.',
    );
  }

  return {
    chatId,
    roomKey,
    notifyWechatChatId,
    targetSessionId,
    title: resolution.target.title ?? null,
  };
}

function resolveAddTarget(
  ctx: MemoToolsContext,
  access: ResolvedCallerAccess,
  rawKind: MemoKind,
  args: Record<string, unknown>,
): ResolvedAddTarget {
  const reqRoomKey = asOptionalString(args.roomKey);
  const reqTargetChatId = asOptionalString(args.targetChatId);
  const reqNotifyChatId = asOptionalString(args.notifyWechatChatId);
  const reqTargetSessionId = asOptionalString(args.targetSessionId);
  const reqTargetName = asOptionalString(args.targetName);

  assertConsistentWechatTargets(reqRoomKey, reqTargetChatId, reqNotifyChatId);

  if (!access.canCrossRoom) {
    if (reqTargetName !== null) {
      throw new MemoAuthorizationError(
        'Cross-room target lookup requires a verified admin DM context.',
      );
    }
    if (access.currentRoomKey !== null) {
      if (reqRoomKey !== null && reqRoomKey !== access.currentRoomKey) {
        throw new MemoAuthorizationError('Cannot create memos for another room.');
      }
      if (reqTargetChatId !== null && reqTargetChatId !== access.boundChatId) {
        throw new MemoAuthorizationError('Cannot override targetChatId for another room.');
      }
      if (reqNotifyChatId !== null && reqNotifyChatId !== access.boundChatId) {
        throw new MemoAuthorizationError('Cannot override notifyWechatChatId for another room.');
      }
      if (reqTargetSessionId !== null && reqTargetSessionId !== access.sessionId) {
        throw new MemoAuthorizationError('Cannot override targetSessionId for another session.');
      }
      return {
        roomKey: access.currentRoomKey,
        targetChatId: access.boundChatId,
        notifyWechatChatId:
          reqNotifyChatId ?? (rawKind === 'time_nudge' ? access.boundChatId : null),
        targetSessionId: access.sessionId,
      };
    }

    if (reqTargetSessionId !== null && reqTargetSessionId !== access.sessionId) {
      throw new MemoAuthorizationError('Cannot override targetSessionId for another session.');
    }
    const targetChatId = reqTargetChatId;
    const notifyWechatChatId =
      reqNotifyChatId ?? (rawKind === 'time_nudge' ? targetChatId : null);
    const roomKey =
      reqRoomKey ?? (targetChatId ? `wechat:${targetChatId}` : `session:${access.sessionId}`);
    return {
      roomKey,
      targetChatId,
      notifyWechatChatId,
      targetSessionId: access.sessionId,
    };
  }

  const hasExplicitTarget = Boolean(
    reqRoomKey || reqTargetChatId || reqNotifyChatId || reqTargetSessionId || reqTargetName,
  );
  const targetsCurrentAdminDm =
    !reqTargetName &&
    access.currentRoomKey !== null &&
    (!reqRoomKey || reqRoomKey === access.currentRoomKey) &&
    (!reqTargetChatId || reqTargetChatId === access.boundChatId) &&
    (!reqNotifyChatId || reqNotifyChatId === access.boundChatId) &&
    (!reqTargetSessionId || reqTargetSessionId === access.sessionId);

  if (!hasExplicitTarget || targetsCurrentAdminDm) {
    const fallbackRoom =
      access.currentRoomKey ??
      (access.boundChatId ? `wechat:${access.boundChatId}` : `session:${access.sessionId}`);
    return {
      roomKey: fallbackRoom,
      targetChatId: access.boundChatId,
      notifyWechatChatId:
        reqNotifyChatId ?? (rawKind === 'time_nudge' ? access.boundChatId : null),
      targetSessionId: access.sessionId,
    };
  }

  const targetResolver = resolveTargetDirectory(ctx);
  if (targetResolver) {
    const resolved = resolveVerifiedDirectoryTarget(targetResolver, {
      roomKey: reqRoomKey,
      targetChatId: reqTargetChatId,
      notifyWechatChatId: reqNotifyChatId,
      targetSessionId: reqTargetSessionId,
      targetName: reqTargetName,
    });
    const boundSessionId = resolved.targetSessionId ?? reqTargetSessionId ?? null;
    if (
      resolved.roomKey !== access.currentRoomKey &&
      boundSessionId !== null &&
      boundSessionId === access.sessionId
    ) {
      throw new MemoTargetError(
        'MEMO_TARGET_MISMATCH',
        'Cross-room memo targetSessionId cannot reuse admin DM session.',
      );
    }
    return {
      roomKey: resolved.roomKey,
      targetChatId: resolved.chatId,
      notifyWechatChatId: resolved.notifyWechatChatId,
      targetSessionId: boundSessionId,
    };
  }

  if (reqTargetName !== null) {
    throw new MemoTargetError(
      'MEMO_TARGET_INVALID',
      'Cannot resolve targetName without a target directory service.',
    );
  }
  if (!reqRoomKey) {
    throw new MemoTargetError(
      'MEMO_TARGET_INVALID',
      'Cross-room memo requires an explicit verified roomKey.',
    );
  }
  if (reqTargetSessionId !== null && reqTargetSessionId === access.sessionId) {
    throw new MemoTargetError(
      'MEMO_TARGET_MISMATCH',
      'Cross-room memo targetSessionId cannot reuse admin DM session.',
    );
  }

  const roomChatId = extractChatIdFromRoomKey(reqRoomKey);
  if (roomChatId) {
    if (!reqNotifyChatId) {
      throw new MemoTargetError(
        'MEMO_TARGET_INVALID',
        'Cross-room WeChat memo requires an explicit notifyWechatChatId matching roomKey.',
      );
    }
    return {
      roomKey: reqRoomKey,
      targetChatId: reqTargetChatId ?? roomChatId,
      notifyWechatChatId: reqNotifyChatId,
      targetSessionId: reqTargetSessionId ?? null,
    };
  }

  return {
    roomKey: reqRoomKey,
    targetChatId: reqTargetChatId,
    notifyWechatChatId: reqNotifyChatId,
    targetSessionId: reqTargetSessionId ?? null,
  };
}

export function registerMemoTools(
  ctx: MemoToolsContext,
  engine: MemoEngine,
): Array<() => void> {
  const tools =
    (typeof ctx.get === 'function'
      ? (ctx.get('tools') as ToolsRegistryLike | undefined)
      : undefined) ?? ctx.tools;
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
        description: 'Room identifier (defaults to current room; verified admin DM may pass a verified target room)',
      },
      targetChatId: {
        type: 'string',
        description: 'Optional WeChat chatId for atmosphere check and proactive opening',
      },
      targetSessionId: {
        type: 'string',
        description: 'Optional verified target DSH sessionId for cross-room memos created by admin DM',
      },
      targetName: {
        type: 'string',
        description: 'Optional room/chat display name resolved via target directory (admin DM only)',
      },
      idempotencyKey: {
        type: 'string',
        description: 'Optional idempotency key to deduplicate retried memo creation requests',
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
    execute: async (
      args,
      exec,
    ): Promise<{ ok: true; memo: MemoRecord; activeInRoom: number; deduplicated: boolean }> => {
      const access = resolveCallerAccess(ctx, exec);
      const rawKind = String(args.kind || '') as MemoKind;
      if (!VALID_KINDS.has(rawKind)) {
        throw new TypeError(`Unsupported memo kind: ${String(args.kind)}`);
      }
      const basis = asOptionalString(args.basis);
      if (!basis) {
        throw new TypeError('watcher_memo_add requires a non-empty basis');
      }

      const resolvedTarget = resolveAddTarget(ctx, access, rawKind, args);
      const idempotencyKey = asOptionalString(args.idempotencyKey);

      const { memo, deduplicated } = engine.createMemoWithIdempotency({
        kind: rawKind,
        idempotencyKey,
        roomKey: resolvedTarget.roomKey,
        targetSessionId: resolvedTarget.targetSessionId,
        targetChatId: resolvedTarget.targetChatId,
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
        notifyWechatChatId: resolvedTarget.notifyWechatChatId,
      });

      return {
        ok: true,
        memo,
        activeInRoom: engine.store.countActiveMemos(resolvedTarget.roomKey),
        deduplicated,
      };
    },
  });

  const listSchema = {
    type: 'object',
    properties: {
      allRooms: {
        type: 'boolean',
        description: 'Explicitly list memos across all rooms (verified admin DM only)',
      },
      roomKey: { type: 'string', description: 'Optional roomKey filter' },
      targetChatId: { type: 'string', description: 'Optional WeChat chatId filter' },
      targetName: {
        type: 'string',
        description: 'Optional room/chat display name resolved via target directory (admin DM only)',
      },
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
    execute: async (
      args,
      exec,
    ): Promise<{
      ok: true;
      memos: MemoRecord[];
      count: number;
      scope: 'room' | 'all_rooms';
      roomKey: string | null;
    }> => {
      const access = resolveCallerAccess(ctx, exec);
      const allRooms = args.allRooms === true;
      const reqRoomKey = asOptionalString(args.roomKey);
      const reqTargetChatId = asOptionalString(args.targetChatId);
      const reqTargetName = asOptionalString(args.targetName);
      const rawStatus = asOptionalString(args.status) as MemoStatus | null;
      const status = rawStatus && VALID_STATUSES.has(rawStatus) ? rawStatus : undefined;
      const rawKind = asOptionalString(args.kind) as MemoKind | null;
      const kind = rawKind && VALID_KINDS.has(rawKind) ? rawKind : undefined;
      const limit = asOptionalNumber(args.limit) ?? 50;

      if (allRooms) {
        if (!access.canCrossRoom) {
          throw new MemoAuthorizationError(
            'Listing memos across all rooms requires a verified admin DM context.',
          );
        }
        if (reqRoomKey || reqTargetChatId || reqTargetName) {
          throw new MemoTargetError(
            'MEMO_TARGET_INVALID',
            'Cannot combine allRooms=true with a specific room filter.',
          );
        }
        const memos = engine.store.listMemos({ status, kind, limit });
        return { ok: true, memos, count: memos.length, scope: 'all_rooms', roomKey: null };
      }

      assertConsistentWechatTargets(reqRoomKey, reqTargetChatId, null);

      if (!access.canCrossRoom) {
        if (reqTargetName !== null) {
          throw new MemoAuthorizationError(
            'Cross-room target lookup requires a verified admin DM context.',
          );
        }
        if (access.currentRoomKey !== null) {
          if (reqRoomKey !== null && reqRoomKey !== access.currentRoomKey) {
            throw new MemoAuthorizationError('Cannot list memos for another room.');
          }
          if (reqTargetChatId !== null && reqTargetChatId !== access.boundChatId) {
            throw new MemoAuthorizationError('Cannot list memos for another chat.');
          }
          const memos = engine.store.listMemos({
            roomKey: access.currentRoomKey,
            status,
            kind,
            limit,
          });
          return {
            ok: true,
            memos,
            count: memos.length,
            scope: 'room',
            roomKey: access.currentRoomKey,
          };
        }

        const scopedRoomKey = reqRoomKey ?? (reqTargetChatId ? `wechat:${reqTargetChatId}` : undefined);
        const memos = engine.store.listMemos({
          roomKey: scopedRoomKey,
          targetSessionId: access.sessionId,
          status,
          kind,
          limit,
        });
        return {
          ok: true,
          memos,
          count: memos.length,
          scope: 'room',
          roomKey: scopedRoomKey ?? `session:${access.sessionId}`,
        };
      }

      let targetRoomKey: string | null = null;
      const hasExplicitFilter = Boolean(reqRoomKey || reqTargetChatId || reqTargetName);
      if (!hasExplicitFilter) {
        targetRoomKey =
          access.currentRoomKey ??
          (access.boundChatId ? `wechat:${access.boundChatId}` : `session:${access.sessionId}`);
      } else if (
        !reqTargetName &&
        access.currentRoomKey !== null &&
        (!reqRoomKey || reqRoomKey === access.currentRoomKey) &&
        (!reqTargetChatId || reqTargetChatId === access.boundChatId)
      ) {
        targetRoomKey = access.currentRoomKey;
      } else {
        const targetResolver = resolveTargetDirectory(ctx);
        if (targetResolver) {
          const resolved = resolveVerifiedDirectoryTarget(targetResolver, {
            roomKey: reqRoomKey,
            targetChatId: reqTargetChatId,
            notifyWechatChatId: null,
            targetSessionId: null,
            targetName: reqTargetName,
          });
          targetRoomKey = resolved.roomKey;
        } else {
          if (reqTargetName !== null) {
            throw new MemoTargetError(
              'MEMO_TARGET_INVALID',
              'Cannot resolve targetName without a target directory service.',
            );
          }
          targetRoomKey = reqRoomKey ?? (reqTargetChatId ? `wechat:${reqTargetChatId}` : null);
        }
      }

      if (!targetRoomKey) {
        throw new MemoTargetError('MEMO_TARGET_INVALID', 'Unable to determine target room for list.');
      }

      const memos = engine.store.listMemos({
        roomKey: targetRoomKey,
        status,
        kind,
        limit,
      });
      return {
        ok: true,
        memos,
        count: memos.length,
        scope: 'room',
        roomKey: targetRoomKey,
      };
    },
  });

  const cancelSchema = {
    type: 'object',
    required: ['memoId'],
    properties: {
      memoId: { type: 'string', description: 'ID of the memo to cancel' },
      roomKey: {
        type: 'string',
        description: 'Optional roomKey ownership verification (recommended for admin cross-room cancel)',
      },
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
      const access = resolveCallerAccess(ctx, exec);
      const memoId = asOptionalString(args.memoId);
      if (!memoId) {
        throw new TypeError('watcher_memo_cancel requires memoId');
      }
      const reason = asOptionalString(args.reason) ?? 'cancelled_by_tool';
      const reqRoomKey = asOptionalString(args.roomKey);

      if (!access.canCrossRoom) {
        if (access.currentRoomKey !== null) {
          if (reqRoomKey !== null && reqRoomKey !== access.currentRoomKey) {
            return { ok: false, memo: null, detail: CANCEL_DENIED_DETAIL };
          }
          const updated = engine.store.cancelMemo(memoId, reason, {
            roomKey: access.currentRoomKey,
            allowCrossRoom: false,
          });
          if (!updated) {
            return { ok: false, memo: null, detail: CANCEL_DENIED_DETAIL };
          }
          return { ok: true, memo: updated, detail: `Cancelled memo ${memoId}` };
        }

        const updated = engine.store.cancelMemo(memoId, reason, {
          roomKey: reqRoomKey,
          targetSessionId: access.sessionId,
          allowCrossRoom: false,
        });
        if (!updated) {
          return { ok: false, memo: null, detail: CANCEL_DENIED_DETAIL };
        }
        return { ok: true, memo: updated, detail: `Cancelled memo ${memoId}` };
      }

      const updated = engine.store.cancelMemo(memoId, reason, {
        roomKey: reqRoomKey,
        allowCrossRoom: true,
      });
      if (!updated) {
        return { ok: false, memo: null, detail: 'Memo not found or not cancellable' };
      }
      return { ok: true, memo: updated, detail: `Cancelled memo ${memoId}` };
    },
  });

  return [addTool, listTool, cancelTool].filter(
    (dispose): dispose is () => void => typeof dispose === 'function',
  );
}
