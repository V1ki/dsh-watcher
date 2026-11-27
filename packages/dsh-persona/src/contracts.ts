import type { DatabaseSync } from 'node:sqlite';

export type PersonaKind = 'double' | 'original' | 'fiction';

export type ChatCircle = 'family' | 'work' | 'external';

export type MemoryVisibility = 'room' | 'circle' | 'dm_only' | 'owner_private';

export type AudienceTag = 'family' | 'work' | 'external' | '';

export type MediaType = 'image' | 'voice' | 'video';

export type ObservationStatus = 'candidate' | 'confirmed' | 'rejected';

export type QualityTier = 'high' | 'medium' | 'low';

export type PromotionEvidenceType = 'text' | 'voice' | 'owner_confirmed';

export type EvidenceKind = 'text' | 'voice' | 'visual' | 'owner_confirmed' | 'media_asset';

export type EvidenceTargetType =
  | 'visual_observation'
  | 'event_fact'
  | 'persona_memory'
  | 'reference_card';

export type ReferenceEntityType = 'person' | 'object' | 'pet' | 'place';

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

export interface PersonaMemoryMetadata {
  id?: string;
  title?: string;
  tags?: string[];
  status?: string;
  editedAt?: number;
  revokedAt?: number;
  revokeReason?: string;
  observed_from?: string;
  observed_to?: string;
  caveat?: string;
  source_ids?: string[];
  evidence?: FoundationSource[];
  speaker?: string;
  speakerWxid?: string;
  subjectWxid?: string;
  category?: string;
  visibility?: MemoryVisibility | string;
  audienceTag?: AudienceTag | string;
  importConflict?: {
    incomingNote: string;
    sourceSnapshot?: string;
    detectedAt: number;
  };
  [key: string]: unknown;
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
  subjectWxid: string;
  speakerWxid: string;
  visibility: MemoryVisibility;
  audienceTag: AudienceTag;
  editedAt: number | null;
  revokedAt: number | null;
  metadata: PersonaMemoryMetadata;
}

export interface ChatCircleRecord {
  chatId: string;
  circle: ChatCircle;
  label: string;
  updatedAt: number;
  labeled: boolean;
}

export interface ContextStampInput {
  personaId: string;
  chatId?: string;
  scope?: string;
  participants?: string[];
}

export interface ContextStamp {
  version: number;
  circle: ChatCircle;
  stamp: string;
}

export interface DynamicPersonaCardInput {
  personaId: string;
  scope: string;
  channel?: 'wechat' | 'github' | 'memo' | string;
  roomKey?: string;
  chatId?: string;
  senderWxid?: string;
  subjectWxids?: string[];
  isGroup?: boolean;
  queryText?: string;
  ownerId?: string;
  includeOwnerMemory?: boolean;
  ownerPreview?: boolean;
  limit?: number;
}

export interface DynamicPersonaMemoryItem {
  note: string;
  quote?: string;
  category?: string;
  title?: string;
  status?: string;
  period?: [string | undefined, string | undefined];
  caveat?: string;
  sourceIds?: string[];
  visibility?: MemoryVisibility;
  audienceTag?: AudienceTag;
  subjectWxid?: string;
  speakerWxid?: string;
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
  version: number;
  circle: ChatCircle;
  ownerMemoryIncluded: boolean;
  cardMarkdown?: string;
  memory: DynamicPersonaMemoryItem[];
  promptBlock: string;
}

export interface RecordTurnPreferenceInput {
  personaId: string;
  scope: string;
  eventSeq?: number;
  sender?: string;
  senderWxid?: string;
  speakerWxid?: string;
  subjectWxid?: string;
  chatId?: string;
  visibility?: MemoryVisibility;
  audienceTag?: AudienceTag;
  sourceText: string;
  memories: Array<{
    note: string;
    quote: string;
    category?: string;
    visibility?: MemoryVisibility;
    audienceTag?: AudienceTag;
    subjectWxid?: string;
    speakerWxid?: string;
    metadata?: PersonaMemoryMetadata;
  }>;
}

export interface AddPersonaMemoryInput {
  personaId: string;
  scope: string;
  note: string;
  quote?: string;
  eventSeq?: number;
  sourceKey?: string | null;
  category?: string;
  subjectWxid?: string;
  speakerWxid?: string;
  visibility?: MemoryVisibility;
  audienceTag?: AudienceTag;
  metadata?: PersonaMemoryMetadata;
}

export interface StyleSampleItem {
  text: string;
  context?: string;
  scene?: string;
  [key: string]: unknown;
}

export interface StyleSampleFile {
  source?: string;
  createdAt?: string;
  stats?: unknown;
  samples: StyleSampleItem[];
}

export interface StyleSampleInfo {
  available: boolean;
  count?: number;
  source?: string;
  createdAt?: string;
  stats?: unknown;
  path?: string;
}

export interface LearnStyleOptions {
  samplePath?: string;
  samples?: StyleSampleItem[];
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
  queryText?: string;
}

export interface PreviewChatResult {
  reply: string;
  personaId: string;
  dryRun: true;
  memoryMutated: false;
}

export interface FoundationSource {
  source_id: string;
  text?: string;
  note?: string;
  [key: string]: unknown;
}

export interface FoundationSignature {
  alg: 'hmac-sha256' | 'ed25519';
  value: string;
  keyId?: string;
}

export interface FoundationRevocation {
  id: string;
  reason?: string;
  revoked_at?: number;
}

export interface FoundationRecord {
  id: string;
  owner_persona_id: string;
  subject_id: string;
  subject_wxid?: string;
  speaker_wxid?: string;
  visibility: string;
  audience_tag?: AudienceTag;
  category: string;
  title?: string;
  statement: string;
  source_ids: string[];
  status?: string;
  observed_from?: string;
  observed_to?: string;
  caveat?: string;
  tags?: string[];
  revoked?: boolean;
  revoked_at?: number | null;
  base_hash?: string;
  [key: string]: unknown;
}

export interface FoundationBundle {
  version?: number;
  bundle_id?: string;
  default_persona_id: string;
  subject_id: string;
  target_own_id?: string;
  source_snapshot: string;
  issued_at?: string | number;
  watermark?: number;
  signature?: FoundationSignature;
  revocations?: FoundationRevocation[];
  records: FoundationRecord[];
}

export interface ImportFoundationOptions {
  expectedOwnId?: string;
  blockedOwnIds?: string[];
  hmacSecret?: string | Buffer;
  ed25519PublicKey?: string | Buffer;
  requireSignature?: boolean;
  rejectReplay?: boolean;
}

export interface FoundationImportConflict {
  recordId: string;
  sourceKey: string;
  memoryId: number;
  reason: 'manual_edit_preserved' | 'revoked_tombstone';
  localNote: string;
  incomingNote: string;
  editedAt?: number | null;
  revokedAt?: number | null;
}

export interface FoundationImportResult {
  added: number;
  updated: number;
  revoked: number;
  skippedRevoked: number;
  conflicts: FoundationImportConflict[];
  total: number;
  version: number;
}

export interface MediaAssetInput {
  id?: string;
  msgId: string;
  chatId: string;
  senderWxid?: string;
  mediaType: MediaType;
  sha256?: string;
  dhash?: string;
  thumbPath?: string;
  durationMs?: number;
  circle?: ChatCircle;
  visibility?: MemoryVisibility;
  transcript?: string;
  metadata?: Record<string, unknown>;
}

export interface MediaAssetRecord {
  id: string;
  msgId: string;
  chatId: string;
  senderWxid: string;
  mediaType: MediaType;
  sha256: string;
  dhash: string;
  thumbPath: string;
  durationMs: number;
  circle: ChatCircle;
  visibility: MemoryVisibility;
  transcript: string;
  metadata: Record<string, unknown>;
  createdAt: number;
}

export interface VisualObservationInput {
  id?: string;
  personaId?: string;
  mediaAssetId: string;
  chatId: string;
  senderWxid?: string;
  subjectWxid?: string;
  circle?: ChatCircle;
  visibility?: MemoryVisibility;
  summary: string;
  tags?: string[];
  entityGuesses?: string[];
  confidence?: number;
  qualityTier?: QualityTier;
  model?: string;
  sourceMsgId?: string;
}

export interface VisualObservationRecord {
  id: string;
  personaId: string;
  mediaAssetId: string;
  chatId: string;
  senderWxid: string;
  subjectWxid: string;
  circle: ChatCircle;
  visibility: MemoryVisibility;
  status: ObservationStatus;
  summary: string;
  tags: string[];
  entityGuesses: string[];
  confidence: number;
  qualityTier: QualityTier;
  model: string;
  sourceMsgId: string;
  createdAt: number;
  updatedAt: number;
}

export interface PromoteObservationInput {
  observationId: string;
  evidenceType: PromotionEvidenceType;
  evidenceExcerpt?: string;
  sourceMsgId?: string;
  confirmedBy?: string;
  subjectWxid?: string;
  subjectName?: string;
  predicate: string;
  objectName: string;
  statement: string;
  tags?: string[];
  circle?: ChatCircle;
  visibility?: MemoryVisibility;
  confidence?: number;
}

export interface EventFactInput {
  id?: string;
  personaId?: string;
  subjectWxid?: string;
  subjectName?: string;
  predicate: string;
  objectName: string;
  statement: string;
  tags?: string[];
  circle?: ChatCircle;
  visibility?: MemoryVisibility;
  roomChatId?: string;
  evidenceType: PromotionEvidenceType;
  evidenceExcerpt?: string;
  sourceMsgId?: string;
  confirmedBy?: string;
  confidence?: number;
}

export interface EventFactRecord {
  id: string;
  personaId: string;
  subjectWxid: string;
  subjectName: string;
  predicate: string;
  objectName: string;
  statement: string;
  tags: string[];
  circle: ChatCircle;
  visibility: MemoryVisibility;
  roomChatId: string;
  status: ObservationStatus;
  evidenceType: PromotionEvidenceType;
  confidence: number;
  editedAt: number | null;
  revokedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ReferenceCardInput {
  id?: string;
  entityType: ReferenceEntityType;
  entityName: string;
  aliases?: string[];
  subjectWxid?: string;
  tags?: string[];
  description?: string;
  imagePath?: string;
  dhash?: string;
  circle?: ChatCircle;
  visibility?: MemoryVisibility;
  roomChatId?: string;
  qualityScore?: number;
  reviewedBy?: string;
}

export interface ReferenceCardRecord {
  id: string;
  entityType: ReferenceEntityType;
  entityName: string;
  aliases: string[];
  subjectWxid: string;
  tags: string[];
  description: string;
  imagePath: string;
  dhash: string;
  circle: ChatCircle;
  visibility: MemoryVisibility;
  roomChatId: string;
  qualityScore: number;
  reviewedBy: string;
  revokedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryEvidenceInput {
  id?: string;
  targetType: EvidenceTargetType;
  targetId: string;
  evidenceKind: EvidenceKind;
  sourceMsgId?: string;
  chatId?: string;
  senderWxid?: string;
  mediaAssetId?: string;
  excerpt?: string;
}

export interface MemoryEvidenceRecord {
  id: string;
  targetType: EvidenceTargetType;
  targetId: string;
  evidenceKind: EvidenceKind;
  sourceMsgId: string;
  chatId: string;
  senderWxid: string;
  mediaAssetId: string;
  excerpt: string;
  createdAt: number;
}

export interface MultimodalRecallInput {
  chatId: string;
  senderWxid?: string;
  tags?: string[];
  queryText?: string;
  dhash?: string;
  maxHammingDistance?: number;
  includeOwnerMemory?: boolean;
  isGroup?: boolean;
  limitCards?: number;
  limitFacts?: number;
}

export interface MultimodalRecallCardHit {
  card: ReferenceCardRecord;
  score: number;
  hammingDistance: number | null;
  matchedBy: Array<'fts' | 'dhash' | 'sender'>;
}

export interface MultimodalRecallFactHit {
  fact: EventFactRecord;
  score: number;
  matchedBy: Array<'fts' | 'sender' | 'entity'>;
}

export interface MultimodalRecallResult {
  chatId: string;
  circle: ChatCircle;
  version: number;
  cards: MultimodalRecallCardHit[];
  facts: MultimodalRecallFactHit[];
}

export interface WxarcImportResult {
  personasImported: number;
  memoriesImported: number;
  sourcePath: string;
}

export interface LegacyMigrationResult {
  migrated: boolean;
  personasImported: number;
  memoriesImported: number;
  sourcePath: string | null;
}

export interface PersonaDb {
  readonly db: DatabaseSync;
  readonly stateDir: string;
  readonly dbPath: string;
  readonly inMemory: boolean;
  transaction<T>(fn: () => T): T;
  getMeta(key: string, fallback?: string): string | undefined;
  setMeta(key: string, value: string): void;
  listTables(): string[];
  close(): void;
}

export interface PersonaWardrobe {
  list(): PersonaRecord[];
  get(id: string): PersonaRecord;
  create(kind: PersonaKind): PersonaRecord;
  save(value: PersonaConfig, revision: number): PersonaRecord;
  delete(id: string): boolean;
  getVersion(): number;
  getContextStamp(input: ContextStampInput): ContextStamp;
  getChatCircle(chatId: string): ChatCircleRecord;
  setChatCircle(chatId: string, circle: ChatCircle, label?: string): ChatCircleRecord;
  deleteChatCircle(chatId: string): boolean;
  listChatCircles(): ChatCircleRecord[];
  getDynamicCard(input: DynamicPersonaCardInput): DynamicPersonaCard | null;
  recordTurnPreference(input: RecordTurnPreferenceInput): { recorded: number };
  addMemory(input: AddPersonaMemoryInput): PersonaMemoryRecord;
  listMemories(
    id: string,
    filter?: { scope?: string; limit?: number; includeRevoked?: boolean },
  ): PersonaMemoryRecord[];
  editMemory(id: string, memoryId: number, note: string): void;
  revokeMemory(id: string, memoryIdOrSourceKey: number | string, reason?: string): boolean;
  clearMemories(id: string, scope?: string): { deleted: number };
  sample(): StyleSampleFile;
  sampleInfo(): StyleSampleInfo;
  learnStyleFromSamples(
    id: string,
    revision: number,
    options?: LearnStyleOptions,
    signal?: AbortSignal,
  ): Promise<PersonaRecord>;
  previewChat(input: PreviewChatInput, signal?: AbortSignal): Promise<PreviewChatResult>;
  importFoundation(
    bundle: FoundationBundle,
    sources?: FoundationSource[],
    options?: ImportFoundationOptions,
  ): FoundationImportResult;
  importFromWxarcSqlite(sqlitePath: string): WxarcImportResult;
  upsertMediaAsset(input: MediaAssetInput): MediaAssetRecord;
  recordVisualObservation(input: VisualObservationInput): VisualObservationRecord;
  listVisualObservations(filter?: {
    chatId?: string;
    status?: ObservationStatus;
    circle?: ChatCircle;
    limit?: number;
  }): VisualObservationRecord[];
  promoteObservationToFact(input: PromoteObservationInput): {
    observation: VisualObservationRecord;
    fact: EventFactRecord;
  };
  rejectObservation(observationId: string, reason?: string): boolean;
  recordEventFact(input: EventFactInput): EventFactRecord;
  listEventFacts(filter?: {
    circle?: ChatCircle;
    includeRevoked?: boolean;
    limit?: number;
  }): EventFactRecord[];
  revokeEventFact(factId: string, reason?: string): boolean;
  upsertReferenceCard(input: ReferenceCardInput): ReferenceCardRecord;
  listReferenceCards(filter?: {
    circle?: ChatCircle;
    entityType?: ReferenceEntityType;
    includeRevoked?: boolean;
  }): ReferenceCardRecord[];
  deleteReferenceCard(cardId: string): boolean;
  listEvidence(targetType: EvidenceTargetType, targetId: string): MemoryEvidenceRecord[];
  recallMultimodal(input: MultimodalRecallInput): MultimodalRecallResult;
}
