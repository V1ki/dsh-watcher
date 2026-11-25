import type { DatabaseSync } from 'node:sqlite';

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

export interface PersonaMemoryMetadata {
  id?: string;
  title?: string;
  tags?: string[];
  status?: string;
  editedAt?: number;
  observed_from?: string;
  observed_to?: string;
  caveat?: string;
  source_ids?: string[];
  evidence?: FoundationSource[];
  speaker?: string;
  category?: string;
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
  metadata: PersonaMemoryMetadata;
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

export interface DynamicPersonaMemoryItem {
  note: string;
  quote?: string;
  category?: string;
  title?: string;
  status?: string;
  period?: [string | undefined, string | undefined];
  caveat?: string;
  sourceIds?: string[];
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
  memory: DynamicPersonaMemoryItem[];
  promptBlock: string;
}

export interface RecordTurnPreferenceInput {
  personaId: string;
  scope: string;
  eventSeq?: number;
  sender?: string;
  sourceText: string;
  memories: Array<{
    note: string;
    quote: string;
    category?: string;
    metadata?: PersonaMemoryMetadata;
  }>;
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

export interface FoundationRecord {
  id: string;
  owner_persona_id: string;
  subject_id: string;
  visibility: string;
  category: string;
  title?: string;
  statement: string;
  source_ids: string[];
  status?: string;
  observed_from?: string;
  observed_to?: string;
  caveat?: string;
  tags?: string[];
  [key: string]: unknown;
}

export interface FoundationBundle {
  default_persona_id: string;
  subject_id: string;
  source_snapshot: string;
  records: FoundationRecord[];
}

export interface FoundationImportResult {
  added: number;
  total: number;
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
  getDynamicCard(input: DynamicPersonaCardInput): DynamicPersonaCard | null;
  recordTurnPreference(input: RecordTurnPreferenceInput): { recorded: number };
  listMemories(id: string, filter?: { scope?: string; limit?: number }): PersonaMemoryRecord[];
  editMemory(id: string, memoryId: number, note: string): void;
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
  importFoundation(bundle: FoundationBundle, sources: FoundationSource[]): FoundationImportResult;
  importFromWxarcSqlite(sqlitePath: string): WxarcImportResult;
}
