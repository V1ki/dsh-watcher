import type {
  HubService,
  MemoKind,
  MemoRecord,
  MemoStatus,
  SessionPrincipalRole,
  SessionVaultTier,
  TargetDirectoryEntry,
  TargetDirectoryQuery,
  ToolExecutionContext,
  TrustLevel,
} from '@local/dsh-hub/contracts';
import type { MemoEngine } from './scheduler.js';

export type { ToolExecutionContext };

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
  hub?: HubService;
  watcher?: HubService;
  controllerId?: string;
  tools?: ToolsRegistryLike;
  wxarcSessionChat?: (sessionId: string) => string | null;
  wxarcMemoPrincipal?: MemoPrincipalResolver;
  wxarcTargetDirectory?: MemoTargetResolver;
}

interface ResolvedCallerAccess {
  sessionId: string;
  role: SessionPrincipalRole;
  tier: SessionVaultTier;
  trustLevel: TrustLevel;
  delegationDepth: number;
  boundChatId: string | null;
  currentRoomKey: string | null;
  boundThreadKey: string | null;
  canCrossRoom: boolean;
  adminId: string | null;
}

interface ResolvedAddTarget {
  roomKey: string;
  targetChatId: string | null;
  notifyWechatChatId: string | null;
  targetSessionId: string | null;
}

interface DirectoryLookupResult {
  status: 'matched' | 'not_found';
  target?: ResolvedAddTarget;
  hasDirectory: boolean;
}

const VALID_KINDS = new Set<MemoKind>(['time_nudge', 'news_followup', 'long_watch']);
const VALID_STATUSES = new Set<MemoStatus>(['active', 'fired', 'torn', 'completed', 'expired']);
const CANCEL_DENIED_DETAIL = 'Memo not found or not cancellable in current room';

function assertRootSessionCaller(exec?: ToolExecutionContext): {
  sessionId: string;
  delegationDepth: number;
  origin: string | undefined;
} {
  const sessionId = typeof exec?.agent?.id === 'string' ? exec.agent.id.trim() : '';
  const header = exec?.agent?.session?.header;
  if (!sessionId) {
    throw new Error('watcher_memo_* tools require an active DSH root session context (exec.agent.id).');
  }
  const delegationDepth = Number(header?.delegationDepth ?? 0);
  const origin = header?.origin;
  if (delegationDepth > 0 || origin === 'subagent') {
    throw new MemoAuthorizationError('Subagents are not permitted to invoke watcher_memo_* tools.');
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
  if (roomKey.startsWith('wxarc:')) {
    const rest = roomKey.slice('wxarc:'.length).trim();
    return rest || null;
  }
  return null;
}

function isChatRoomKey(roomKey: string | null): boolean {
  if (!roomKey) return false;
  return (
    roomKey.startsWith('wechat:') ||
    roomKey.startsWith('wxarc:') ||
    roomKey.startsWith('dingtalk:')
  );
}

function resolveHubService(ctx: MemoToolsContext, engine: MemoEngine): HubService {
  const fromGet =
    typeof ctx.get === 'function'
      ? ((ctx.get('hub') ?? ctx.get('watcher')) as HubService | undefined)
      : undefined;
  return fromGet ?? ctx.hub ?? ctx.watcher ?? engine.hub;
}

async function resolveOwnerControllerId(
  ctx: MemoToolsContext,
  hub: HubService,
  engine: MemoEngine,
): Promise<string | null> {
  try {
    const transport = hub.getWechatTransport?.();
    if (transport && typeof transport.status === 'function') {
      const status = await transport.status();
      const fromTransport = asOptionalString(status?.controllerId);
      if (fromTransport) return fromTransport;
    }
  } catch {
  }
  const fromConfig = asOptionalString(engine.config.defaultNotifyWechatChatId);
  if (fromConfig) return fromConfig;
  const fromCtx =
    asOptionalString(typeof ctx.get === 'function' ? ctx.get('controllerId') : undefined) ??
    asOptionalString(ctx.controllerId);
  return fromCtx;
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

function mapLegacyPrincipal(
  ctx: MemoToolsContext,
  sessionId: string,
  principal: MemoCallerPrincipal,
): ResolvedCallerAccess {
  if (principal.delegationDepth > 0) {
    throw new MemoAuthorizationError('Subagents are not permitted to invoke watcher_memo_* tools.');
  }
  const boundChatId =
    asOptionalString(principal.boundChatId) ?? resolveBoundWechatChat(ctx, sessionId);
  const currentRoomKey =
    asOptionalString(principal.roomKey) ?? (boundChatId ? `wechat:${boundChatId}` : null);
  const isVerifiedAdmin = principal.isAdminDm === true && principal.allowCrossRoom === true;
  if (isVerifiedAdmin) {
    return {
      sessionId,
      role: 'owner_session',
      tier: 3,
      trustLevel: 'owner',
      delegationDepth: 0,
      boundChatId,
      currentRoomKey,
      boundThreadKey: null,
      canCrossRoom: true,
      adminId: asOptionalString(principal.adminId) ?? boundChatId,
    };
  }
  return {
    sessionId,
    role: 'external_chat',
    tier: 1,
    trustLevel: 'untrusted',
    delegationDepth: 0,
    boundChatId,
    currentRoomKey,
    boundThreadKey: null,
    canCrossRoom: false,
    adminId: null,
  };
}

function resolveLegacyAccess(
  ctx: MemoToolsContext,
  sessionId: string,
  exec?: ToolExecutionContext,
): ResolvedCallerAccess | null {
  const principalResolver = resolvePrincipalResolver(ctx);
  let principal: MemoCallerPrincipal | null = null;
  if (principalResolver) {
    try {
      principal = principalResolver(sessionId, exec);
    } catch {
      principal = null;
    }
  }
  if (principal && principal.sessionId === sessionId) {
    return mapLegacyPrincipal(ctx, sessionId, principal);
  }
  const boundChatId = resolveBoundWechatChat(ctx, sessionId);
  if (boundChatId) {
    return {
      sessionId,
      role: 'external_chat',
      tier: 1,
      trustLevel: 'untrusted',
      delegationDepth: 0,
      boundChatId,
      currentRoomKey: `wechat:${boundChatId}`,
      boundThreadKey: null,
      canCrossRoom: false,
      adminId: null,
    };
  }
  return null;
}

function resolveCallerAccess(
  ctx: MemoToolsContext,
  hub: HubService,
  exec?: ToolExecutionContext,
): ResolvedCallerAccess {
  const { sessionId } = assertRootSessionCaller(exec);

  if (typeof hub.resolveSessionPrincipal === 'function') {
    const hubPrincipal = hub.resolveSessionPrincipal(exec);
    if (hubPrincipal.isSubagent || hubPrincipal.delegationDepth > 0) {
      throw new MemoAuthorizationError('Subagents are not permitted to invoke watcher_memo_* tools.');
    }
    const explicitRegistered =
      typeof hub.getSessionPrincipal === 'function' ? hub.getSessionPrincipal(sessionId) : null;
    if (!explicitRegistered && hubPrincipal.role === 'interactive') {
      const legacy = resolveLegacyAccess(ctx, sessionId, exec);
      if (legacy) return legacy;
    }
    const boundRoomKey = asOptionalString(hubPrincipal.boundRoomKey);
    const boundThreadKey = asOptionalString(hubPrincipal.boundThreadKey);
    const currentRoomKey = boundRoomKey ?? boundThreadKey;
    const boundChatId = extractChatIdFromRoomKey(currentRoomKey);
    const canCrossRoom = Boolean(
      hubPrincipal.tier === 3 &&
        (hubPrincipal.role === 'owner_session' || hubPrincipal.role === 'interactive') &&
        hubPrincipal.delegationDepth === 0 &&
        !hubPrincipal.isSubagent,
    );
    return {
      sessionId,
      role: hubPrincipal.role,
      tier: hubPrincipal.tier,
      trustLevel: hubPrincipal.trustLevel,
      delegationDepth: hubPrincipal.delegationDepth,
      boundChatId,
      currentRoomKey,
      boundThreadKey,
      canCrossRoom,
      adminId: hubPrincipal.role === 'owner_session' ? boundChatId : null,
    };
  }

  const legacy = resolveLegacyAccess(ctx, sessionId, exec);
  if (legacy) return legacy;

  return {
    sessionId,
    role: 'unknown',
    tier: 0,
    trustLevel: 'untrusted',
    delegationDepth: 0,
    boundChatId: null,
    currentRoomKey: null,
    boundThreadKey: null,
    canCrossRoom: false,
    adminId: null,
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

function mapHubCandidates(
  candidates?: TargetDirectoryEntry[],
): Array<{ chatId: string; roomKey: string; title?: string | null }> | undefined {
  if (!Array.isArray(candidates) || candidates.length === 0) return undefined;
  return candidates.map((entry) => ({
    chatId: asOptionalString(entry.chatId) ?? asOptionalString(entry.targetId) ?? entry.roomKey,
    roomKey: entry.roomKey,
    title: entry.title ?? null,
  }));
}

function validateHubTargetEntry(
  entry: TargetDirectoryEntry,
  query: {
    roomKey: string | null;
    targetChatId: string | null;
    notifyWechatChatId: string | null;
    targetSessionId: string | null;
    targetName: string | null;
  },
): ResolvedAddTarget {
  const roomKey = asOptionalString(entry.roomKey);
  if (!roomKey) {
    throw new MemoTargetError(
      'MEMO_TARGET_INVALID',
      'Resolved target is missing required roomKey.',
    );
  }
  const roomChatId = extractChatIdFromRoomKey(roomKey);
  const isWechat = Boolean(roomChatId) || entry.source === 'wechat' || entry.source === 'wxarc';
  const chatId =
    asOptionalString(entry.chatId) ??
    roomChatId ??
    (isWechat ? asOptionalString(entry.targetId) : null);
  const notifyWechatChatId =
    asOptionalString(entry.notifyWechatChatId) ?? (isWechat ? chatId : null);
  const targetSessionId = asOptionalString(entry.targetSessionId);

  if (isWechat) {
    if (!chatId || !notifyWechatChatId) {
      throw new MemoTargetError(
        'MEMO_TARGET_INVALID',
        'Resolved WeChat target is missing required chatId or notifyWechatChatId.',
      );
    }
    if ((roomChatId && roomChatId !== chatId) || notifyWechatChatId !== chatId) {
      throw new MemoTargetError(
        'MEMO_TARGET_MISMATCH',
        'Resolved target binding is internally inconsistent.',
      );
    }
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
    roomKey,
    targetChatId: chatId,
    notifyWechatChatId,
    targetSessionId,
  };
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

async function resolveDirectoryTarget(
  ctx: MemoToolsContext,
  hub: HubService,
  query: {
    roomKey: string | null;
    targetChatId: string | null;
    notifyWechatChatId: string | null;
    targetSessionId: string | null;
    targetName: string | null;
  },
): Promise<DirectoryLookupResult> {
  let hubHasDirectory = false;

  if (typeof hub.resolveTarget === 'function') {
    const hubQuery: TargetDirectoryQuery = {
      query: query.targetName ?? query.roomKey ?? query.targetChatId ?? undefined,
      roomKey: query.roomKey,
      targetChatId: query.targetChatId,
      notifyWechatChatId: query.notifyWechatChatId,
      targetSessionId: query.targetSessionId,
      targetName: query.targetName,
    };
    const hubRes = await hub.resolveTarget(hubQuery);
    if (hubRes?.status === 'matched' && hubRes.target) {
      return {
        status: 'matched',
        target: validateHubTargetEntry(hubRes.target, query),
        hasDirectory: true,
      };
    }
    if (hubRes?.status === 'ambiguous') {
      throw new MemoTargetError(
        'MEMO_TARGET_AMBIGUOUS',
        hubRes.detail || 'Target room is ambiguous; specify an exact room.',
        mapHubCandidates(hubRes.candidates),
      );
    }
    if (typeof hub.listTargets === 'function') {
      try {
        const probe = await hub.listTargets({ limit: 1 });
        hubHasDirectory = Array.isArray(probe) && probe.length > 0;
      } catch {
        hubHasDirectory = true;
      }
    } else {
      hubHasDirectory = true;
    }
  }

  const legacyResolver = resolveTargetDirectory(ctx);
  if (legacyResolver) {
    const resolved = resolveVerifiedDirectoryTarget(legacyResolver, query);
    return {
      status: 'matched',
      target: {
        roomKey: resolved.roomKey,
        targetChatId: resolved.chatId,
        notifyWechatChatId: resolved.notifyWechatChatId,
        targetSessionId: resolved.targetSessionId,
      },
      hasDirectory: true,
    };
  }

  return { status: 'not_found', hasDirectory: hubHasDirectory };
}

async function resolveAddTarget(
  ctx: MemoToolsContext,
  hub: HubService,
  engine: MemoEngine,
  access: ResolvedCallerAccess,
  rawKind: MemoKind,
  args: Record<string, unknown>,
): Promise<ResolvedAddTarget> {
  const reqRoomKey = asOptionalString(args.roomKey);
  const reqTargetChatId = asOptionalString(args.targetChatId);
  const reqNotifyChatId = asOptionalString(args.notifyWechatChatId);
  const reqTargetSessionId = asOptionalString(args.targetSessionId);
  const reqTargetName = asOptionalString(args.targetName);

  assertConsistentWechatTargets(reqRoomKey, reqTargetChatId, reqNotifyChatId);

  if (access.role === 'unknown') {
    throw new MemoAuthorizationError('Unknown or unauthorized session cannot create memos.');
  }

  if (access.role === 'worker') {
    if (access.trustLevel === 'untrusted') {
      throw new MemoAuthorizationError('Untrusted worker sessions are not permitted to create memos.');
    }
    const boundRoom = access.boundThreadKey ?? access.currentRoomKey;
    if (!boundRoom) {
      throw new MemoAuthorizationError('Worker session has no bound room and cannot create memos.');
    }
    if (reqTargetName !== null) {
      throw new MemoAuthorizationError('Worker sessions cannot perform cross-room target lookup.');
    }
    if (reqRoomKey !== null && reqRoomKey !== boundRoom) {
      throw new MemoAuthorizationError('Worker sessions can only create memos for their bound room.');
    }
    const boundChatId = extractChatIdFromRoomKey(boundRoom);
    if (reqTargetChatId !== null && reqTargetChatId !== boundChatId) {
      throw new MemoAuthorizationError('Worker sessions cannot override targetChatId for another room.');
    }
    if (reqTargetSessionId !== null && reqTargetSessionId !== access.sessionId) {
      throw new MemoAuthorizationError('Worker sessions cannot override targetSessionId.');
    }
    if (reqNotifyChatId !== null) {
      if (reqNotifyChatId.endsWith('@chatroom')) {
        throw new MemoAuthorizationError('Worker sessions cannot notify arbitrary group chats.');
      }
      const controllerId = await resolveOwnerControllerId(ctx, hub, engine);
      if (!controllerId || reqNotifyChatId !== controllerId) {
        throw new MemoAuthorizationError(
          'Worker notifyWechatChatId must be empty or match the verified owner controllerId.',
        );
      }
    }
    return {
      roomKey: boundRoom,
      targetChatId: boundChatId,
      notifyWechatChatId: reqNotifyChatId,
      targetSessionId: access.sessionId,
    };
  }

  if (access.role === 'external_chat' || !access.canCrossRoom) {
    if (reqTargetName !== null) {
      throw new MemoAuthorizationError(
        'Cross-room target lookup requires a verified tier-3 owner session.',
      );
    }
    if (!access.currentRoomKey) {
      throw new MemoAuthorizationError(
        'Unauthorized session without a bound room cannot create memos.',
      );
    }
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
        reqNotifyChatId !== null
          ? access.boundChatId
          : rawKind === 'time_nudge'
            ? access.boundChatId
            : null,
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

  const lookup = await resolveDirectoryTarget(ctx, hub, {
    roomKey: reqRoomKey,
    targetChatId: reqTargetChatId,
    notifyWechatChatId: reqNotifyChatId,
    targetSessionId: reqTargetSessionId,
    targetName: reqTargetName,
  });

  if (lookup.status === 'matched' && lookup.target) {
    const resolved = lookup.target;
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
      targetChatId: resolved.targetChatId,
      notifyWechatChatId: resolved.notifyWechatChatId,
      targetSessionId: boundSessionId,
    };
  }

  if (lookup.hasDirectory) {
    if (
      reqTargetName !== null ||
      reqTargetChatId !== null ||
      isChatRoomKey(reqRoomKey) ||
      !reqRoomKey
    ) {
      throw new MemoTargetError(
        'MEMO_TARGET_NOT_FOUND',
        'Target room not found in target directory.',
      );
    }
    if (reqTargetSessionId !== null && reqTargetSessionId === access.sessionId) {
      throw new MemoTargetError(
        'MEMO_TARGET_MISMATCH',
        'Cross-room memo targetSessionId cannot reuse admin DM session.',
      );
    }
    if (reqNotifyChatId !== null) {
      const controllerId = await resolveOwnerControllerId(ctx, hub, engine);
      if (!controllerId || reqNotifyChatId !== controllerId) {
        const notifyCheck = await resolveDirectoryTarget(ctx, hub, {
          roomKey: null,
          targetChatId: null,
          notifyWechatChatId: reqNotifyChatId,
          targetSessionId: null,
          targetName: null,
        });
        if (notifyCheck.status !== 'matched') {
          throw new MemoTargetError(
            'MEMO_TARGET_NOT_FOUND',
            'Requested notifyWechatChatId not found in target directory.',
          );
        }
      }
    }
    return {
      roomKey: reqRoomKey,
      targetChatId: null,
      notifyWechatChatId: reqNotifyChatId,
      targetSessionId: reqTargetSessionId ?? null,
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
  const hub = resolveHubService(ctx, engine);

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
      const access = resolveCallerAccess(ctx, hub, exec);
      const rawKind = String(args.kind || '') as MemoKind;
      if (!VALID_KINDS.has(rawKind)) {
        throw new TypeError(`Unsupported memo kind: ${String(args.kind)}`);
      }
      const basis = asOptionalString(args.basis);
      if (!basis) {
        throw new TypeError('watcher_memo_add requires a non-empty basis');
      }

      const resolvedTarget = await resolveAddTarget(ctx, hub, engine, access, rawKind, args);
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
      const access = resolveCallerAccess(ctx, hub, exec);
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
            'Listing memos across all rooms requires a verified tier-3 owner session.',
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
        if (access.role === 'unknown') {
          throw new MemoAuthorizationError(
            'Unknown or unauthorized session cannot list memos.',
          );
        }
        if (reqTargetName !== null) {
          throw new MemoAuthorizationError(
            'Cross-room target lookup requires a verified tier-3 owner session.',
          );
        }
        const boundRoom =
          access.role === 'worker'
            ? (access.boundThreadKey ?? access.currentRoomKey)
            : access.currentRoomKey;
        if (!boundRoom) {
          throw new MemoAuthorizationError(
            'Unauthorized session without a bound room cannot list memos.',
          );
        }
        const boundChatId = extractChatIdFromRoomKey(boundRoom) ?? access.boundChatId;
        if (reqRoomKey !== null && reqRoomKey !== boundRoom) {
          throw new MemoAuthorizationError('Cannot list memos for another room.');
        }
        if (reqTargetChatId !== null && reqTargetChatId !== boundChatId) {
          throw new MemoAuthorizationError('Cannot list memos for another chat.');
        }
        const memos = engine.store.listMemos({
          roomKey: boundRoom,
          status,
          kind,
          limit,
        });
        return {
          ok: true,
          memos,
          count: memos.length,
          scope: 'room',
          roomKey: boundRoom,
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
        const lookup = await resolveDirectoryTarget(ctx, hub, {
          roomKey: reqRoomKey,
          targetChatId: reqTargetChatId,
          notifyWechatChatId: null,
          targetSessionId: null,
          targetName: reqTargetName,
        });
        if (lookup.status === 'matched' && lookup.target) {
          targetRoomKey = lookup.target.roomKey;
        } else if (lookup.hasDirectory) {
          if (
            reqTargetName !== null ||
            reqTargetChatId !== null ||
            isChatRoomKey(reqRoomKey) ||
            !reqRoomKey
          ) {
            throw new MemoTargetError(
              'MEMO_TARGET_NOT_FOUND',
              'Target room not found in target directory.',
            );
          }
          targetRoomKey = reqRoomKey;
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
      const access = resolveCallerAccess(ctx, hub, exec);
      const memoId = asOptionalString(args.memoId);
      if (!memoId) {
        throw new TypeError('watcher_memo_cancel requires memoId');
      }
      const reason = asOptionalString(args.reason) ?? 'cancelled_by_tool';
      const reqRoomKey = asOptionalString(args.roomKey);

      if (!access.canCrossRoom) {
        if (
          access.role === 'unknown' ||
          (access.role === 'worker' && access.trustLevel === 'untrusted')
        ) {
          return { ok: false, memo: null, detail: CANCEL_DENIED_DETAIL };
        }
        const boundRoom =
          access.role === 'worker'
            ? (access.boundThreadKey ?? access.currentRoomKey)
            : access.currentRoomKey;
        if (!boundRoom) {
          return { ok: false, memo: null, detail: CANCEL_DENIED_DETAIL };
        }
        if (reqRoomKey !== null && reqRoomKey !== boundRoom) {
          return { ok: false, memo: null, detail: CANCEL_DENIED_DETAIL };
        }
        const updated = engine.store.cancelMemo(memoId, reason, {
          roomKey: boundRoom,
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
