import type { DatabaseSync } from 'node:sqlite';

export type ActionTier = 'inbox-only' | 'triage' | 'review' | 'autonomous';

export type TrustLevel = 'untrusted' | 'triage' | 'owner' | 'system';

export type SinkKind = 'idempotent' | 'staged-draft' | 'irreversible-gui';

export type DeliveryMode = 'followup' | 'steer' | 'inject';

export type WatchStatus = 'active' | 'awaiting_agent' | 'paused' | 'ended';

export type DeliveryState =
  | 'queued'
  | 'in_flight'
  | 'delivered'
  | 'uncertain'
  | 'suppressed_takeover'
  | 'failed';

export type EdgeRelation =
  | 'fixes'
  | 'closes'
  | 'implements'
  | 'linked_pr'
  | 'cross_referenced'
  | 'manual_link'
  | 'supersedes';

export type TriageVerdict =
  | 'ACTION_REQUIRED'
  | 'CONFLICT_OR_STALE'
  | 'OBSOLETE_OR_DUPLICATE'
  | 'INFO_ONLY';

export type SessionVaultTier = 0 | 1 | 2 | 3;

export type VaultVisibility = 'external' | 'work' | 'family' | 'owner_private';

export type SessionPrincipalRole = 'owner_session' | 'worker' | 'external_chat' | 'interactive' | 'unknown';

export interface ToolExecutionContext {
  agent?: {
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
  };
}

export interface SessionPrincipal {
  sessionId: string;
  role: SessionPrincipalRole;
  tier: SessionVaultTier;
  trustLevel: TrustLevel;
  boundSource?: string | null;
  boundThreadKey?: string | null;
  boundDecisionId?: string | null;
  boundRepo?: string | null;
  boundRoomKey?: string | null;
  targetCircle?: VaultVisibility | null;
}

export interface ResolvedSessionPrincipal {
  sessionId: string | null;
  rootSessionId: string | null;
  role: SessionPrincipalRole;
  tier: SessionVaultTier;
  trustLevel: TrustLevel;
  delegationDepth: number;
  isSubagent: boolean;
  tainted: boolean;
  turnPrivateRead: boolean;
  allowedCircles: VaultVisibility[];
  boundSource?: string | null;
  boundThreadKey?: string | null;
  boundDecisionId?: string | null;
  boundRepo?: string | null;
  boundRoomKey?: string | null;
  targetCircle?: VaultVisibility | null;
}

export interface VaultScope {
  allowedCircles: VaultVisibility[];
  tier: SessionVaultTier;
  sessionId: string;
  rootSessionId: string;
  role: SessionPrincipalRole;
  boundSource?: string | null;
  boundThreadKey?: string | null;
  boundRepo?: string | null;
  boundRoomKey?: string | null;
}

export interface VaultSearchQuery {
  query: string;
  sources?: string[];
  circle?: VaultVisibility;
  person?: string;
  since?: string;
  until?: string;
  limit?: number;
}

export interface VaultSearchHit {
  source: string;
  itemId: string;
  circle: VaultVisibility;
  roomKey?: string;
  roomName?: string;
  author?: string;
  occurredAt: string;
  snippet: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

export interface VaultContextOptions {
  before?: number;
  after?: number;
}

export interface VaultContextEntry {
  itemId: string;
  circle: VaultVisibility;
  roomKey?: string;
  roomName?: string;
  author?: string;
  occurredAt: string;
  text: string;
  isTarget?: boolean;
  metadata?: Record<string, unknown>;
}

export interface VaultContextResult {
  source: string;
  itemId: string;
  circle: VaultVisibility;
  roomKey?: string;
  roomName?: string;
  items: VaultContextEntry[];
  truncated?: boolean;
  metadata?: Record<string, unknown>;
}

export interface VaultProvider {
  readonly id: string;
  readonly label: string;
  search(
    query: VaultSearchQuery,
    scope: VaultScope,
  ): Promise<VaultSearchHit[]> | VaultSearchHit[];
  context?(
    itemId: string,
    opts: VaultContextOptions,
    scope: VaultScope,
  ): Promise<VaultContextResult | null> | VaultContextResult | null;
}

export interface VaultProviderSummary {
  id: string;
  label: string;
  supportsContext: boolean;
}

export interface VaultSearchResponse {
  ok: true;
  query: string;
  tier: SessionVaultTier;
  allowedCircles: VaultVisibility[];
  tainted: boolean;
  total: number;
  hits: VaultSearchHit[];
  sourcesSearched: string[];
  providerErrors?: Array<{ source: string; error: string }>;
}

export interface VaultContextResponse {
  ok: true;
  source: string;
  itemId: string;
  tier: SessionVaultTier;
  allowedCircles: VaultVisibility[];
  tainted: boolean;
  result: VaultContextResult | null;
}

export interface VaultService {
  registerProvider(provider: VaultProvider): () => void;
  listProviders(): VaultProviderSummary[];
  search(query: VaultSearchQuery, exec?: ToolExecutionContext): Promise<VaultSearchResponse>;
  context(
    source: string,
    itemId: string,
    opts?: VaultContextOptions,
    exec?: ToolExecutionContext,
  ): Promise<VaultContextResponse>;
}

export interface TargetDirectoryQuery {
  source?: string;
  query?: string;
  roomKey?: string | null;
  targetChatId?: string | null;
  notifyWechatChatId?: string | null;
  targetSessionId?: string | null;
  targetName?: string | null;
}

export interface TargetDirectoryEntry {
  source: string;
  targetId: string;
  roomKey: string;
  title?: string | null;
  chatId?: string | null;
  notifyWechatChatId?: string | null;
  targetSessionId?: string | null;
  kind?: string;
  circle?: VaultVisibility | null;
  metadata?: Record<string, unknown>;
}

export interface TargetDirectoryResolution {
  status: 'matched' | 'not_found' | 'ambiguous';
  target?: TargetDirectoryEntry;
  candidates?: TargetDirectoryEntry[];
  detail?: string;
}

export interface TargetDirectoryListOptions {
  source?: string;
  query?: string;
  kind?: string;
  limit?: number;
}

export interface TargetDirectoryProvider {
  readonly id?: string;
  readonly source?: string;
  resolveTarget(
    query: TargetDirectoryQuery,
  ): Promise<TargetDirectoryResolution | null> | TargetDirectoryResolution | null;
  listTargets(
    opts?: TargetDirectoryListOptions,
  ): Promise<TargetDirectoryEntry[]> | TargetDirectoryEntry[];
}

export type ThreadLifecycleState = 'closed' | 'merged' | 'ended';

export interface ThreadLifecycleEvent {
  source: string;
  threadKey: string;
  entityKey: string | null;
  state: ThreadLifecycleState;
  lifecycleOnly: boolean;
  inboxId: string;
  event: NormalizedEvent;
  subscription: ThreadSubscription | null;
  occurredAt: string;
}

export type ThreadLifecycleHandler = (
  lifecycle: ThreadLifecycleEvent,
) => Promise<void> | void;

export interface GuardContext {
  hook?: 'beforeEnterRoom' | 'beforeSendOut';
  source?: string;
  action?: string;
  sinkId?: string;
  roomKey?: string;
  sessionId?: string | null;
  targetCircle?: VaultVisibility | null;
  workstreamId?: string | null;
  event?: NormalizedEvent;
  target?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface GuardDecision {
  allow: boolean;
  reason?: string;
  code?: string;
  guardName?: string;
  stageOnly?: boolean;
  tainted?: boolean;
  publicTaintWarning?: boolean;
  warningText?: string;
  metadata?: Record<string, unknown>;
}

export interface GuardHook {
  name: string;
  beforeEnterRoom?: (ctx: GuardContext) => GuardDecision | Promise<GuardDecision>;
  beforeSendOut?: (ctx: GuardContext) => GuardDecision | Promise<GuardDecision>;
}

export interface DoorGuard {
  beforeEnterRoom(ctx?: GuardContext): Promise<GuardDecision>;
  beforeSendOut(ctx?: GuardContext): Promise<GuardDecision>;
  registerGuard(hook: GuardHook): () => void;
  listGuards(): string[];
  setSessionTaintChecker?(checker: ((sessionId: string) => boolean) | null): void;
  setSessionTargetCircleResolver?(
    resolver: ((sessionId: string) => VaultVisibility | null | undefined) | null,
  ): void;
}

export interface NormalizedEvent {
  id: string;
  source: string;
  type: string;
  dedupeKey: string;
  threadKey: string;
  entityKey?: string;
  actor: {
    id: string;
    login?: string;
    displayName?: string;
    isBot?: boolean;
  };
  trustLevel: TrustLevel;
  occurredAt: string;
  summary: string;
  payload: Record<string, unknown>;
  rawRef?: {
    url?: string;
    externalId?: string;
    repo?: string;
    number?: number;
  };
}

export interface WatchSource {
  readonly id: string;
  readonly label: string;
  pollNow?: (watchId?: string, signal?: AbortSignal) => Promise<{ polled: number; events: number }>;
  health?: () => { ok: boolean; consecutiveErrors: number; lastError?: string; nextPollAt?: string };
  dispose?: () => Promise<void> | void;
}

export interface ConnectorDescriptor {
  id: string;
  label: string;
  kind: 'connector' | 'trigger';
  panelId?: string;
  panelLabel?: string;
  health?: () => { ok: boolean; detail?: string };
}

export interface ConnectorSummary {
  id: string;
  label: string;
  kind: string;
  panelId?: string;
  panelLabel?: string;
  health?: { ok: boolean; detail?: string };
}

export interface ThreadSubscription {
  id: string;
  source: string;
  threadKey: string;
  workstreamId: string | null;
  sessionId: string;
  personaId: string | null;
  owner: string;
  status: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface RegisterSubscriptionInput {
  source: string;
  threadKey: string;
  sessionId: string;
  workstreamId?: string | null;
  personaId?: string | null;
  owner?: string;
  status?: string;
  metadata?: Record<string, unknown>;
}

export type UnclaimedEventHandler = (
  event: NormalizedEvent,
  ctx: { inboxId: string },
) =>
  | Promise<{ handled: boolean; subscription?: ThreadSubscription } | void>
  | { handled: boolean; subscription?: ThreadSubscription }
  | void;

export interface IngestResult {
  accepted: boolean;
  deduped?: boolean;
  inboxId?: string;
  routedVia?: 'subscription' | 'router' | 'rule' | 'inbox' | 'lifecycle';
}

export interface ResolvedEntityContext {
  workspacePath: string | null;
  sensitiveWorkspace?: boolean;
  workstreamKey: string;
  targetSessionId?: string;
  supersededBySessionId?: string;
  suggestedTitle?: string;
  contextHeader?: string;
  preGateTags?: string[];
  metadata?: Record<string, unknown>;
}

export interface EntityResolver {
  readonly id: string;
  readonly sources: string[];
  resolve: (event: NormalizedEvent, signal?: AbortSignal) => Promise<ResolvedEntityContext | null>;
}

export interface SinkInvokeInput {
  action: string;
  target: Record<string, unknown>;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  sessionId?: string;
  targetCircle?: VaultVisibility;
  stageOnly?: boolean;
  approved?: boolean;
}

export interface SinkInvokeResult {
  status: 'executed' | 'staged' | 'skipped' | 'uncertain' | 'failed';
  receiptId?: string;
  draftId?: string;
  externalUrl?: string;
  detail?: string;
  stageOnlyForced?: boolean;
  publicTaintWarning?: boolean;
  warningText?: string;
}

export interface ActionSink {
  readonly id: string;
  readonly label: string;
  readonly kind: SinkKind;
  readonly requiresApproval?: boolean;
  invoke: (input: SinkInvokeInput, signal?: AbortSignal) => Promise<SinkInvokeResult>;
}

export interface PosteriorHandlerConfig {
  tier: ActionTier;
  resolver?: string;
  sessionPolicy: 'none' | 'reuse-or-spawn' | 'reuse-only' | 'ephemeral-review';
  deliveryMode?: DeliveryMode;
  skill?: string;
  persona?: string;
  agentPreset?: string;
  allowedTools?: string[];
  allowedSinks?: string[];
  cooldownSeconds?: number;
  maxWakeups?: number;
  ownerLogins?: string[];
  requiredLabel?: string;
}

export interface RoutingRule {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  match: {
    source: string | '*';
    type?: string | string[];
    repo?: string | string[];
    trustLevel?: TrustLevel | TrustLevel[];
    excludeBots?: boolean;
    predicate?: (event: NormalizedEvent) => boolean;
  };
  handler: PosteriorHandlerConfig;
}

export interface WorkstreamRecord {
  id: string;
  source: string;
  workstreamKey: string;
  primaryEntityKey: string;
  entityKeys: string[];
  workspacePath: string;
  sessionId: string | null;
  supersededBy: string | null;
  status: WatchStatus;
  mode: 'once' | 'repeat';
  trustMode: 'triage' | 'autonomous';
  deliveryCount: number;
  maxWakeups: number;
  ttlExpiresAt: string;
  lastWakeupAt: string | null;
  configRevision: number;
  createdAt: string;
  updatedAt: string;
}

export interface EntityGraphEdge {
  id: string;
  fromEntityKey: string;
  toEntityKey: string;
  relation: EdgeRelation;
  strength: 'tight' | 'loose';
  evidence?: string;
  discoveredAt: string;
}

export interface InboxItem {
  id: string;
  eventId: string;
  source: string;
  type: string;
  entityKey: string | null;
  workstreamId: string | null;
  sessionId: string | null;
  actor: string;
  summary: string;
  tier: ActionTier;
  verdict?: TriageVerdict;
  preGateTags: string[];
  status: 'unread' | 'triaged' | 'action_required' | 'resolved' | 'muted';
  rawUrl?: string;
  occurredAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StagedDraft {
  id: string;
  sinkId: string;
  action: string;
  workstreamId: string | null;
  sessionId: string | null;
  target: Record<string, unknown>;
  payload: Record<string, unknown>;
  previewText: string;
  idempotencyKey: string;
  status: 'pending_approval' | 'approved' | 'executing' | 'executed' | 'uncertain' | 'rejected' | 'expired';
  createdAt: string;
  updatedAt: string;
}

export interface DeliveryReceipt {
  id: string;
  workstreamId: string;
  sessionId: string;
  messageId: string;
  eventIds: string[];
  trustMode: 'triage' | 'autonomous';
  state: DeliveryState;
  error?: string;
  deliveredAt: string;
  settledAt?: string;
}

export type PersonaKind = 'double' | 'original' | 'fiction';

export interface PersonaConfig {
  id: string;
  kind: PersonaKind;
  name: string;
  definition: string;
  learning: boolean;
  work: string;
  character: string;
  style?: string;
}

export interface PersonaRecord extends PersonaConfig {
  revision: number;
  style: string;
  styleMeta: Record<string, unknown>;
  memoryCount: number;
}

export interface PersonaMemoryRecord {
  id: number;
  personaId: string;
  scope: string;
  eventSeq: number;
  note: string;
  quote: string;
  at: number;
  sourceKey: string | null;
  category: string;
  metadata: Record<string, unknown>;
}

export interface DynamicPersonaCardInput {
  personaId: string;
  scope: string;
  channel?: 'wechat' | 'github' | 'memo' | string;
  roomKey?: string;
  queryText?: string;
  ownerId?: string;
  ownerPreview?: boolean;
  limit?: number;
}

export interface DynamicPersonaCard {
  id: string;
  name: string;
  kind: PersonaKind;
  definition: string;
  work: string;
  character: string;
  style: string;
  learning: boolean;
  cardMarkdown?: string;
  memory: Array<{
    note: string;
    quote?: string;
    category?: string;
    title?: string;
    status?: string;
    period?: [string | undefined, string | undefined];
    caveat?: string;
    sourceIds?: string[];
  }>;
  promptBlock: string;
}

export interface RecordTurnPreferenceInput {
  personaId: string;
  scope: string;
  eventSeq?: number;
  sender?: string;
  sourceText: string;
  memories: Array<{ note: string; quote: string; category?: string }>;
}

export interface LearnStyleOptions {
  samplePath?: string;
  samples?: Array<{ text: string; context?: string }>;
  source?: string;
  policy?: Record<string, unknown>;
}

export interface PreviewChatInput {
  personaId: string;
  message: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  scope?: string;
  channel?: string;
  ownerId?: string;
}

export interface PreviewChatResult {
  reply: string;
  personaId: string;
  dryRun: true;
  memoryMutated: false;
}

export interface WxarcImportResult {
  personasImported: number;
  memoriesImported: number;
  sourcePath: string;
}

export interface PersonaWardrobe {
  list(): PersonaRecord[];
  get(id: string): PersonaRecord;
  create(kind: PersonaKind): PersonaRecord;
  save(value: PersonaConfig, revision: number): PersonaRecord;
  delete(id: string): boolean;
  getDynamicCard(input: DynamicPersonaCardInput): DynamicPersonaCard | null;
  recordTurnPreference(input: RecordTurnPreferenceInput): { recorded: number };
  listMemories(id: string, filter?: { scope?: string; limit?: number }): PersonaMemoryRecord[];
  editMemory(id: string, memoryId: number, note: string): void;
  clearMemories(id: string, scope?: string): { deleted: number };
  learnStyleFromSamples(
    id: string,
    revision: number,
    options?: LearnStyleOptions,
    signal?: AbortSignal,
  ): Promise<PersonaRecord>;
  previewChat(input: PreviewChatInput, signal?: AbortSignal): Promise<PreviewChatResult>;
  importFromWxarcSqlite?(sqlitePath: string): WxarcImportResult;
  sampleInfo?(): unknown;
  importFoundation?(bundle: unknown, sources?: unknown): unknown;
  resolveVaultVisibility?(roomKey: string): VaultVisibility;
  searchVaultKnowledge?(query: {
    query: string;
    allowedCircles: ReadonlyArray<VaultVisibility>;
    person?: string;
    since?: string;
    until?: string;
    limit?: number;
  }): Promise<VaultSearchHit[]> | VaultSearchHit[];
  getVaultKnowledgeContext?(
    itemId: string,
    opts?: VaultContextOptions & { allowedCircles?: ReadonlyArray<VaultVisibility> },
  ): Promise<unknown> | unknown;
}

export interface WechatSendInput {
  chatId: string;
  text: string | string[];
  idempotencyKey: string;
  mode?: 'send' | 'draft';
  reason?: string;
  imagePath?: string;
}

export interface WechatSendResult {
  status: 'sent' | 'staged' | 'uncertain' | 'skipped' | 'failed';
  deliveryId?: string;
  detail?: string;
}

export interface WechatMemoNudgeInput {
  memoId: string;
  chatId: string;
  targetSessionId?: string | null;
  title?: string;
  basis: string;
  windowStart?: string | null;
  windowEnd?: string | null;
}

export interface WechatMemoNudgeResult {
  status: 'queued' | 'skipped' | 'failed';
  jobId?: number;
  sessionId?: string;
  detail?: string;
}

export interface WechatMessage {
  seq?: number;
  chatId: string;
  sender?: string;
  senderId?: string;
  isOwn?: boolean;
  text: string;
  timestamp: number;
}

export interface WechatAtmosphere {
  chatId: string;
  healthy: boolean;
  paused: boolean;
  messageCount: number;
  lastMessageAt: number | null;
  secondsSinceLastMessage: number | null;
  ownSpokeSince: boolean;
  quiet: boolean;
  recentMessages: WechatMessage[];
}

export interface WechatTransportStatus {
  ok: boolean;
  mode: 'cordis' | 'http' | 'unavailable';
  healthy: boolean;
  endpoint?: string;
  ownId?: string;
  controllerId?: string;
  detail?: string;
}

export interface AdminWechatMessage {
  session: string;
  senderId: string;
  text: string;
  quotedText?: string;
  seq?: number;
  timestamp?: number;
  sourceKey?: string;
  localType?: number;
  imagePath?: string;
  voiceTranscript?: string;
  articleSummary?: string;
  mediaPaths?: string[];
}

export interface AdminWechatHandleResult {
  handled: boolean;
  replyText?: string;
  imagePath?: string;
}

export type AdminWechatHandler = (
  message: AdminWechatMessage,
) => Promise<AdminWechatHandleResult | void> | AdminWechatHandleResult | void;

export interface WechatTransport {
  send(input: WechatSendInput, signal?: AbortSignal): Promise<WechatSendResult>;
  triggerMemoNudge?(input: WechatMemoNudgeInput, signal?: AbortSignal): Promise<WechatMemoNudgeResult>;
  recentMessages(
    params: { chatId: string; limit?: number; sinceTs?: number },
    signal?: AbortSignal,
  ): Promise<WechatMessage[]>;
  getAtmosphere(
    params: { chatId: string; sinceMinutes?: number; limit?: number; quietThresholdSeconds?: number },
    signal?: AbortSignal,
  ): Promise<WechatAtmosphere>;
  status(signal?: AbortSignal): Promise<WechatTransportStatus>;
}

export type MemoKind = 'time_nudge' | 'news_followup' | 'long_watch';

export type MemoStatus = 'active' | 'fired' | 'torn' | 'completed' | 'expired';

export interface MemoRecord {
  id: string;
  kind: MemoKind;
  roomKey: string;
  targetSessionId: string | null;
  targetChatId: string | null;
  source: string;
  title: string;
  basis: string;
  windowStart: string | null;
  windowEnd: string | null;
  randomFireAt: string | null;
  intervalHours: number | null;
  expiresAt: string | null;
  keywords: string[];
  knownFacts: string[];
  acceptCriteria: string | null;
  officialDomains: string[];
  status: MemoStatus;
  lastCheckedAt: string | null;
  nextCheckAt: string | null;
  notifyWechatChatId: string | null;
  resultSummary: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface WatcherDb {
  readonly db: DatabaseSync;
  readonly stateDir: string;
  readonly inMemory: boolean;
  readonly leaseAcquired: boolean;
  readonly holderId: string;
  transaction<T>(fn: () => T): T;
  getMeta(key: string, fallback?: string): string | undefined;
  setMeta(key: string, value: string): void;
  touchLeaseHeartbeat(): void;
  listTables(): string[];
  close(): void;
}

export type HubDb = WatcherDb;

export interface GitHubAppStatusView {
  configured: boolean;
  appId: number | null;
  slug: string | null;
  defaultRepo: string | null;
  installationId: number | null;
  botLogin: string | null;
  permissions?: Record<string, string>;
  lastVerifiedAt?: string | null;
  lastError?: string | null;
}

export interface GitHubAuthStatusView {
  configured: boolean;
  source: 'credentials' | 'gh-cli' | 'none';
  login: string | null;
  scopes: string[];
  notificationsScopeMissing: boolean;
  hasBotToken: boolean;
  botLogin?: string | null;
  actMode?: 'app' | 'token' | 'read-fallback' | 'none';
  githubApp?: GitHubAppStatusView | null;
  lastVerifiedAt?: string | null;
  lastError?: string | null;
}

export interface GitHubRepoConfigItem {
  repo: string;
  localPath?: string;
  defaultBranch?: string;
  sensitive?: boolean;
  autoSend?: boolean;
  enabled?: boolean;
  personaId?: string | null;
}

export interface GitHubPinnedConfigItem {
  repo: string;
  number: number;
  linkedPrs: number[];
  watchReactions: boolean;
}

export interface GitHubAdminConfigView {
  authStatus: GitHubAuthStatusView;
  enableNotifications: boolean;
  pollIntervalMs: number;
  pinnedPollIntervalMs?: number;
  autoSendOwners: string[];
  ownerLogins?: string[];
  botLogin?: string;
  defaultPersonaId?: string | null;
  repos: GitHubRepoConfigItem[];
  pinnedItems: GitHubPinnedConfigItem[];
}

export interface GitHubAdminConfigUpdate {
  enableNotifications?: boolean;
  pollIntervalMs?: number;
  pinnedPollIntervalMs?: number;
  autoSendOwners?: string[];
  ownerLogins?: string[];
  botLogin?: string;
  defaultPersonaId?: string | null;
  repos?: GitHubRepoConfigItem[];
  pinnedItems?: Array<{
    repo: string;
    number: number;
    linkedPrs?: number[];
    watchReactions?: boolean;
  }>;
}

export interface GitHubSaveTokenInput {
  slot: 'read' | 'act';
  token: string;
  login?: string;
  isBot?: boolean;
}

export interface GitHubVerifyTokenResult {
  ok: boolean;
  login: string | null;
  scopes: string[];
  notificationsScopeMissing: boolean;
  status?: number;
  error?: string;
}

export interface GitHubSaveTokenResult {
  ok: boolean;
  slot: 'read' | 'act';
  savedTo: 'credentials' | 'file';
  verified: GitHubVerifyTokenResult;
  authStatus: GitHubAuthStatusView;
}

export interface GitHubAppSaveInput {
  appId: number;
  slug?: string;
  privateKeyPem?: string;
  installationId?: number;
  repo?: string;
}

export interface GitHubAppVerifyResult {
  ok: boolean;
  appId?: number | null;
  slug?: string | null;
  botLogin?: string | null;
  installationId?: number | null;
  repository?: string | null;
  permissions?: Record<string, string>;
  commentsAllowed?: boolean;
  pullRequestsAllowed?: boolean;
  status?: number;
  error?: string;
}

export interface GitHubAppSaveResult {
  ok: boolean;
  savedTo: 'credentials' | 'file';
  verified: GitHubAppVerifyResult;
  authStatus: GitHubAuthStatusView;
}

export interface GitHubAdminAdapter {
  getConfig(): Promise<GitHubAdminConfigView> | GitHubAdminConfigView;
  updateConfig(next: GitHubAdminConfigUpdate): Promise<GitHubAdminConfigView> | GitHubAdminConfigView;
  saveToken(input: GitHubSaveTokenInput): Promise<GitHubSaveTokenResult>;
  verifyToken(token?: string): Promise<GitHubVerifyTokenResult>;
  saveApp?(input: GitHubAppSaveInput): Promise<GitHubAppSaveResult>;
  verifyApp?(opts?: { repo?: string }): Promise<GitHubAppVerifyResult>;
  deleteApp?(): Promise<{ ok: boolean; authStatus: GitHubAuthStatusView }>;
  pollNow(): Promise<{ polled: number; events: number; authStatus?: GitHubAuthStatusView }>;
  listRecentEvents?(): Promise<unknown[]> | unknown[];
}

export interface HubStatus {
  sources: Array<{ id: string; label: string; health?: ReturnType<NonNullable<WatchSource['health']>> }>;
  connectors: ConnectorSummary[];
  sinks: Array<{ id: string; label: string; kind: SinkKind }>;
  wechatTransportMode: WechatTransportStatus['mode'];
  activeWorkstreams: number;
  activeSubscriptions: number;
  unreadInbox: number;
  pendingDrafts: number;
  autoSessionsThisHour: number;
  configRevision: number;
  vaultProviders?: number;
}

export interface HubService {
  readonly configRevision: number;
  readonly wardrobe?: PersonaWardrobe | null;
  readonly guard: DoorGuard;
  readonly db: WatcherDb;
  readonly vault?: VaultService;

  getWardrobe(): PersonaWardrobe | null;

  registerConnector(desc: ConnectorDescriptor): () => void;
  listConnectors(): ConnectorSummary[];

  registerSubscription(input: RegisterSubscriptionInput): ThreadSubscription;
  resolveSubscription(source: string, threadKey: string): ThreadSubscription | null;
  removeSubscription(source: string, threadKey: string): boolean;
  listSubscriptions(filter?: { source?: string; status?: string }): ThreadSubscription[];

  onUnclaimedEvent(handler: UnclaimedEventHandler): () => void;
  onThreadLifecycle?(handler: ThreadLifecycleHandler): () => void;

  registerVaultProvider?(provider: VaultProvider): () => void;

  registerSessionPrincipal?(principal: SessionPrincipal): () => void;
  getSessionPrincipal?(sessionId: string): SessionPrincipal | null;
  setSessionTurnOverride?(sessionId: string, tier: SessionVaultTier, ttlMs?: number): void;
  clearSessionTurnOverride?(sessionId: string): void;
  markSessionTainted?(sessionId: string, reason?: string): void;
  isSessionTainted?(sessionId: string): boolean;
  markTurnPrivateRead?(sessionId: string): void;
  clearTurnPrivateRead?(sessionId: string): void;
  isTurnPrivateRead?(sessionId: string): boolean;
  resolveSessionPrincipal?(exec?: ToolExecutionContext): ResolvedSessionPrincipal;

  registerTargetDirectory?(provider: TargetDirectoryProvider): () => void;
  resolveTarget?(query: TargetDirectoryQuery): Promise<TargetDirectoryResolution>;
  listTargets?(opts?: TargetDirectoryListOptions): Promise<TargetDirectoryEntry[]>;

  registerSource(source: WatchSource): () => void;
  registerResolver(resolver: EntityResolver): () => void;
  registerSink(sink: ActionSink): () => void;
  registerRule(rule: RoutingRule): () => void;
  registerWechatTransport(transport: WechatTransport): () => void;
  getWechatTransport(): WechatTransport | null;
  registerAdminWechatHandler?(handler: AdminWechatHandler): () => void;
  dispatchAdminWechatMessage?(message: AdminWechatMessage): Promise<AdminWechatHandleResult>;
  registerGitHubAdmin?(admin: GitHubAdminAdapter): () => void;
  getGitHubAdmin?(): GitHubAdminAdapter | null;

  ingest(event: NormalizedEvent): Promise<IngestResult>;
  invokeSink(sinkId: string, input: SinkInvokeInput, signal?: AbortSignal): Promise<SinkInvokeResult>;
  approveDraft(draftId: string): Promise<SinkInvokeResult>;
  discardDraft(draftId: string, reason?: string): Promise<void>;

  listInbox(filter?: { source?: string; status?: InboxItem['status']; limit?: number }): InboxItem[];
  listWorkstreams(filter?: { sessionId?: string; status?: WatchStatus }): WorkstreamRecord[];
  listDrafts(filter?: { status?: StagedDraft['status'] }): StagedDraft[];
  getStatus(): HubStatus;
}

export type WatcherService = HubService;

export interface CordisHubContext {
  hub: HubService;
  watcher: HubService;
  vault?: VaultService;
  personaWardrobe?: PersonaWardrobe;
}

export type CordisWatcherContext = CordisHubContext;
