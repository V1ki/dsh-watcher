import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type {
  DynamicPersonaCard,
  DynamicPersonaCardInput,
  DynamicPersonaMemoryItem,
  FoundationBundle,
  FoundationImportResult,
  FoundationSource,
  LearnStyleOptions,
  LegacyMigrationResult,
  PersonaConfig,
  PersonaDb,
  PersonaKind,
  PersonaMemoryMetadata,
  PersonaMemoryRecord,
  PersonaRecord,
  PersonaWardrobe,
  PreviewChatInput,
  PreviewChatResult,
  RecordTurnPreferenceInput,
  StyleSampleFile,
  StyleSampleInfo,
  StyleSampleItem,
  WxarcImportResult,
} from './contracts.js';
import {
  DEFAULT_LEGACY_WATCHER_DB,
  DEFAULT_LEGACY_WXARC_DB,
  DEFAULT_LEGACY_WXARC_DIR,
  expandHome,
} from './db.js';

const DEFAULT_CARD_MEMORY_LIMIT = 16;
const DEFAULT_MAX_MEMORIES_PER_SCOPE = 24;
const DEFAULT_CATEGORY = '聊天偏好';
const FOUNDATION_PREFIX = 'foundation:';
const OWNER_SCOPE_PREFIX = 'owner:';
const FOUNDATION_FALLBACK_CATEGORY = '基础事实';
const FOUNDATION_MATCH_LIMIT = 6;
const FOUNDATION_FALLBACK_LIMIT = 4;
const SAMPLE_FILENAME = 'owner-style-sample.json';

const DEFAULT_NAMES: Record<PersonaKind, string> = {
  double: '我的分身',
  original: '原创角色',
  fiction: '同人角色',
};

export class PersonaNotFoundError extends Error {
  readonly code = 'PERSONA_NOT_FOUND';

  constructor(id: string) {
    super(`Persona not found: ${id}`);
    this.name = 'PersonaNotFoundError';
  }
}

export class PersonaRevisionConflictError extends Error {
  readonly code = 'PERSONA_REVISION_CONFLICT';

  constructor(id: string, expectedRevision: number) {
    super(`Persona revision conflict for ${id}: expected ${expectedRevision}`);
    this.name = 'PersonaRevisionConflictError';
  }
}

export interface StyleSummarizeInput {
  persona: PersonaRecord;
  samples: StyleSampleItem[];
  source?: string;
  policy?: Record<string, unknown>;
}

export interface PreviewRunnerInput {
  card: DynamicPersonaCard;
  message: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  scope: string;
  channel?: string;
}

export interface PersonaWardrobeLlm {
  summarizeStyle?: (input: StyleSummarizeInput, signal?: AbortSignal) => Promise<string> | string;
  previewChat?: (input: PreviewRunnerInput, signal?: AbortSignal) => Promise<string> | string;
  complete?: (
    input: {
      system: string;
      prompt: string;
      history?: Array<{ role: 'user' | 'assistant'; content: string }>;
    },
    signal?: AbortSignal,
  ) => Promise<string> | string;
}

export interface PersonaWardrobeOptions {
  summarizeFn?: (input: StyleSummarizeInput, signal?: AbortSignal) => Promise<string> | string;
  previewRunner?: (input: PreviewRunnerInput, signal?: AbortSignal) => Promise<string> | string;
  cardMemoryLimit?: number;
  maxMemoriesPerScope?: number;
  sampleDirs?: string[];
  legacyDbPaths?: string[];
  now?: () => number;
}

export interface CreatePersonaInput {
  id?: string;
  kind: PersonaKind;
  name?: string;
  definition?: string;
  learning?: boolean;
  work?: string;
  character?: string;
  style?: string;
}

export interface RecordTurnPreferenceCompatInput
  extends Omit<RecordTurnPreferenceInput, 'sourceText' | 'memories'> {
  sourceText?: string;
  memories?: Array<{
    note: string;
    quote?: string;
    category?: string;
    sourceKey?: string;
    metadata?: PersonaMemoryMetadata;
  }>;
  note?: string | null;
  evidence?: string;
  speaker?: string;
  sourceKey?: string;
  preview?: boolean;
}

interface PersonaRow {
  id: string;
  revision: number;
  config: string;
  style: string;
  style_meta: string;
  memory_count?: number;
}

interface PersonaMemoryRow {
  id: number;
  persona_id: string;
  scope: string;
  event_seq: number;
  note: string;
  quote: string;
  at: number;
  source_key: string | null;
  category: string;
  metadata: string;
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function normalizeKind(raw: unknown): PersonaKind {
  if (raw === 'double' || raw === 'original' || raw === 'fiction') return raw;
  return 'original';
}

function rowToPersonaRecord(row: PersonaRow): PersonaRecord {
  const cfg = parseJsonObject(row.config);
  const kind = normalizeKind(cfg.kind);
  return {
    id: row.id,
    kind,
    name: typeof cfg.name === 'string' && cfg.name.trim() ? cfg.name : DEFAULT_NAMES[kind],
    definition: typeof cfg.definition === 'string' ? cfg.definition : '',
    learning: cfg.learning === undefined ? true : Boolean(cfg.learning),
    work: typeof cfg.work === 'string' ? cfg.work : '',
    character: typeof cfg.character === 'string' ? cfg.character : '',
    revision: Number(row.revision),
    style: row.style ?? '',
    styleMeta: parseJsonObject(row.style_meta),
    memoryCount: Number(row.memory_count ?? 0),
  };
}

function rowToMemoryRecord(row: PersonaMemoryRow): PersonaMemoryRecord {
  return {
    id: Number(row.id),
    personaId: row.persona_id,
    scope: row.scope,
    eventSeq: Number(row.event_seq),
    note: row.note,
    quote: row.quote,
    at: Number(row.at),
    sourceKey: row.source_key ?? null,
    category: row.category || DEFAULT_CATEGORY,
    metadata: parseJsonObject(row.metadata),
  };
}

function serializeConfig(config: PersonaConfig): string {
  return JSON.stringify({
    id: config.id,
    kind: normalizeKind(config.kind),
    name: config.name,
    definition: config.definition,
    learning: Boolean(config.learning),
    work: config.work,
    character: config.character,
  });
}

function extractQueryTokens(text: string): string[] {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return [];
  const tokens = new Set<string>();
  const cjkRuns = normalized.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const run of cjkRuns) {
    if (run.length === 1) {
      tokens.add(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) {
      tokens.add(run.slice(i, i + 2));
    }
  }
  const asciiRuns = normalized.match(/[a-z0-9_]{2,}/g) ?? [];
  for (const token of asciiRuns) {
    tokens.add(token);
  }
  return Array.from(tokens);
}

function rankFoundationMemories(rows: PersonaMemoryRecord[], queryText?: string): PersonaMemoryRecord[] {
  if (rows.length === 0) return [];
  const tokens = queryText ? extractQueryTokens(queryText) : [];
  if (tokens.length > 0) {
    const scored: Array<{ record: PersonaMemoryRecord; score: number }> = [];
    for (const record of rows) {
      const title = typeof record.metadata.title === 'string' ? record.metadata.title : '';
      const tags = Array.isArray(record.metadata.tags)
        ? record.metadata.tags.map((t) => String(t)).join(' ')
        : '';
      const titleAndTags = `${title} ${tags}`.toLowerCase();
      const haystack = `${record.category} ${title} ${tags} ${record.note} ${record.quote}`.toLowerCase();
      let score = 0;
      for (const token of tokens) {
        if (haystack.includes(token)) {
          score += titleAndTags.includes(token) ? 2 : 1;
        }
      }
      if (score > 0) {
        scored.push({ record, score });
      }
    }
    if (scored.length > 0) {
      scored.sort((a, b) => b.score - a.score || a.record.id - b.record.id);
      return scored.slice(0, FOUNDATION_MATCH_LIMIT).map((item) => item.record);
    }
  }
  return rows
    .filter((row) => row.category === FOUNDATION_FALLBACK_CATEGORY)
    .sort((a, b) => a.id - b.id)
    .slice(0, FOUNDATION_FALLBACK_LIMIT);
}

function toDynamicMemoryItem(mem: PersonaMemoryRecord): DynamicPersonaMemoryItem {
  const meta = mem.metadata;
  const observedFrom = typeof meta.observed_from === 'string' ? meta.observed_from : undefined;
  const observedTo = typeof meta.observed_to === 'string' ? meta.observed_to : undefined;
  const sourceIds = Array.isArray(meta.source_ids)
    ? meta.source_ids.map((s) => String(s))
    : mem.sourceKey
      ? [mem.sourceKey]
      : undefined;
  return {
    note: mem.note,
    quote: mem.quote || undefined,
    category: mem.category,
    title: typeof meta.title === 'string' ? meta.title : undefined,
    status: typeof meta.status === 'string' ? meta.status : undefined,
    period: observedFrom || observedTo ? [observedFrom, observedTo] : undefined,
    caveat: typeof meta.caveat === 'string' ? meta.caveat : undefined,
    sourceIds,
  };
}

function formatPromptBlock(
  persona: PersonaRecord,
  foundationMemories: PersonaMemoryRecord[],
  recentMemories: PersonaMemoryRecord[],
): string {
  const lines: string[] = [
    `[Persona: ${persona.name} (${persona.kind})]`,
  ];
  if (persona.definition.trim()) lines.push(`Core: ${persona.definition.trim()}`);
  if (persona.work.trim()) lines.push(`Work: ${persona.work.trim()}`);
  if (persona.character.trim()) lines.push(`Character: ${persona.character.trim()}`);
  if (persona.style.trim()) lines.push(`Style Summary: ${persona.style.trim()}`);
  if (foundationMemories.length > 0) {
    lines.push('Owner Foundation Facts:');
    for (const mem of foundationMemories) {
      const title = typeof mem.metadata.title === 'string' && mem.metadata.title.trim()
        ? `${mem.metadata.title.trim()}: `
        : '';
      const caveat = typeof mem.metadata.caveat === 'string' && mem.metadata.caveat.trim()
        ? ` (注意: ${mem.metadata.caveat.trim()})`
        : '';
      lines.push(`- [${mem.category}] ${title}${mem.note.trim()}${caveat}`);
    }
  }
  if (recentMemories.length > 0) {
    lines.push('Recent Preferences:');
    for (const mem of recentMemories) {
      const quotePart = mem.quote.trim() ? ` ("${mem.quote.trim().slice(0, 80)}")` : '';
      lines.push(`- [${mem.category}] ${mem.note.trim()}${quotePart}`);
    }
  }
  return lines.join('\n');
}

function normalizeSampleArray(raw: unknown): StyleSampleItem[] {
  const items = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object'
      ? ((raw as Record<string, unknown>).samples ?? (raw as Record<string, unknown>).messages ?? [])
      : [];
  if (!Array.isArray(items)) return [];
  const out: StyleSampleItem[] = [];
  for (const entry of items) {
    if (typeof entry === 'string' && entry.trim()) {
      out.push({ text: entry.trim() });
    } else if (entry && typeof entry === 'object') {
      const obj = entry as Record<string, unknown>;
      const text = typeof obj.text === 'string' ? obj.text : typeof obj.content === 'string' ? obj.content : '';
      if (text.trim()) {
        out.push({
          text: text.trim(),
          context: typeof obj.context === 'string' ? obj.context.trim() : undefined,
          scene: typeof obj.scene === 'string' ? obj.scene.trim() : undefined,
        });
      }
    }
  }
  return out;
}

function fallbackStyleSummary(samples: StyleSampleItem[]): string {
  const avgLen = Math.round(samples.reduce((sum, s) => sum + s.text.length, 0) / samples.length);
  const tone = avgLen <= 24 ? '简短直接' : avgLen <= 60 ? '自然口语' : '详细耐心';
  const hasQuestion = samples.some((s) => /[?？]/.test(s.text));
  const hasExclaim = samples.some((s) => /[!！]/.test(s.text));
  const traits = [tone];
  if (hasQuestion) traits.push('常带反问确认');
  if (hasExclaim) traits.push('语气有起伏');
  return `基于 ${samples.length} 条样本提炼：风格${traits.join('、')}，平均句长约 ${avgLen} 字。`;
}

export class PersonaWardrobeImpl implements PersonaWardrobe {
  private readonly store: PersonaDb;
  private readonly llm?: PersonaWardrobeLlm;
  private readonly options: PersonaWardrobeOptions;
  private readonly cardMemoryLimit: number;
  private readonly maxMemoriesPerScope: number;

  constructor(store: PersonaDb, llm?: PersonaWardrobeLlm, options: PersonaWardrobeOptions = {}) {
    this.store = store;
    this.llm = llm;
    this.options = options;
    this.cardMemoryLimit = options.cardMemoryLimit ?? DEFAULT_CARD_MEMORY_LIMIT;
    this.maxMemoriesPerScope = options.maxMemoriesPerScope ?? DEFAULT_MAX_MEMORIES_PER_SCOPE;
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private findPersonaRow(id: string): PersonaRow | undefined {
    return this.store.db
      .prepare(
        `SELECT p.id, p.revision, p.config, p.style, p.style_meta,
                (SELECT COUNT(*) FROM persona_memory m WHERE m.persona_id = p.id) AS memory_count
         FROM personas p
         WHERE p.id = ?`,
      )
      .get(id) as PersonaRow | undefined;
  }

  list(): PersonaRecord[] {
    const rows = this.store.db
      .prepare(
        `SELECT p.id, p.revision, p.config, p.style, p.style_meta,
                (SELECT COUNT(*) FROM persona_memory m WHERE m.persona_id = p.id) AS memory_count
         FROM personas p
         ORDER BY p.id ASC`,
      )
      .all() as unknown as PersonaRow[];
    return rows.map(rowToPersonaRecord);
  }

  get(id: string): PersonaRecord {
    const row = this.findPersonaRow(id);
    if (!row) throw new PersonaNotFoundError(id);
    return rowToPersonaRecord(row);
  }

  create(input: PersonaKind | CreatePersonaInput): PersonaRecord {
    const spec: CreatePersonaInput = typeof input === 'string' ? { kind: input } : input;
    const kind = normalizeKind(spec.kind);
    const id = spec.id?.trim() || `${kind}-${randomUUID().slice(0, 8)}`;
    const config: PersonaConfig = {
      id,
      kind,
      name: spec.name?.trim() || DEFAULT_NAMES[kind],
      definition: spec.definition ?? '',
      learning: spec.learning ?? true,
      work: spec.work ?? '',
      character: spec.character ?? '',
    };
    const style = spec.style ?? '';
    this.store.db
      .prepare('INSERT INTO personas (id, revision, config, style, style_meta) VALUES (?, 1, ?, ?, ?)')
      .run(id, serializeConfig(config), style, '{}');
    return this.get(id);
  }

  save(value: PersonaConfig, revision: number): PersonaRecord {
    const existing = this.findPersonaRow(value.id);
    if (!existing) throw new PersonaNotFoundError(value.id);
    const nextStyle = value.style !== undefined ? value.style : existing.style;
    const result = this.store.db
      .prepare(
        `UPDATE personas
         SET config = ?, style = ?, revision = revision + 1
         WHERE id = ? AND revision = ?`,
      )
      .run(serializeConfig(value), nextStyle, value.id, revision);
    if (Number(result.changes) === 0) {
      throw new PersonaRevisionConflictError(value.id, revision);
    }
    return this.get(value.id);
  }

  delete(id: string): boolean {
    return this.store.transaction(() => {
      this.store.db.prepare('DELETE FROM persona_memory WHERE persona_id = ?').run(id);
      const result = this.store.db.prepare('DELETE FROM personas WHERE id = ?').run(id);
      return Number(result.changes) > 0;
    });
  }

  getDynamicCard(input: DynamicPersonaCardInput): DynamicPersonaCard | null;
  getDynamicCard(personaId: string, scope: string): DynamicPersonaCard | null;
  getDynamicCard(
    inputOrId: DynamicPersonaCardInput | string,
    scopeArg?: string,
  ): DynamicPersonaCard | null {
    const input: DynamicPersonaCardInput =
      typeof inputOrId === 'string'
        ? { personaId: inputOrId, scope: scopeArg ?? '' }
        : inputOrId;
    const row = this.findPersonaRow(input.personaId);
    if (!row) return null;
    const persona = rowToPersonaRecord(row);
    const limit = Math.max(0, Math.min(input.limit ?? this.cardMemoryLimit, this.cardMemoryLimit));
    const memRows =
      limit > 0 && input.scope
        ? (this.store.db
            .prepare(
              `SELECT id, persona_id, scope, event_seq, note, quote, at, source_key, category, metadata
               FROM persona_memory
               WHERE persona_id = ? AND scope = ?
                 AND (source_key IS NULL OR source_key NOT LIKE 'foundation:%')
               ORDER BY at DESC, id DESC
               LIMIT ?`,
            )
            .all(persona.id, input.scope, limit) as unknown as PersonaMemoryRow[])
        : [];
    const recentMemories = memRows.map(rowToMemoryRecord).reverse();

    let foundationMemories: PersonaMemoryRecord[] = [];
    const ownerId = input.ownerId?.trim();
    if (ownerId) {
      const ownerScope = `${OWNER_SCOPE_PREFIX}${ownerId}`;
      const fRows = this.store.db
        .prepare(
          `SELECT id, persona_id, scope, event_seq, note, quote, at, source_key, category, metadata
           FROM persona_memory
           WHERE persona_id = ? AND scope = ? AND source_key LIKE 'foundation:%'
           ORDER BY id ASC`,
        )
        .all(persona.id, ownerScope) as unknown as PersonaMemoryRow[];
      foundationMemories = rankFoundationMemories(fRows.map(rowToMemoryRecord), input.queryText);
    } else if (input.ownerPreview === true) {
      const fRows = this.store.db
        .prepare(
          `SELECT id, persona_id, scope, event_seq, note, quote, at, source_key, category, metadata
           FROM persona_memory
           WHERE persona_id = ? AND scope LIKE 'owner:%' AND source_key LIKE 'foundation:%'
           ORDER BY id ASC`,
        )
        .all(persona.id) as unknown as PersonaMemoryRow[];
      foundationMemories = rankFoundationMemories(fRows.map(rowToMemoryRecord), input.queryText);
    }

    const combined = [...foundationMemories, ...recentMemories];
    const promptBlock = formatPromptBlock(persona, foundationMemories, recentMemories);
    return {
      id: persona.id,
      name: persona.name,
      kind: persona.kind,
      definition: persona.definition,
      work: persona.work,
      character: persona.character,
      style: persona.style,
      learning: persona.learning,
      cardMarkdown: promptBlock,
      memory: combined.map(toDynamicMemoryItem),
      promptBlock,
    };
  }

  recordTurnPreference(input: RecordTurnPreferenceCompatInput): { recorded: number } {
    if (input.preview === true) return { recorded: 0 };
    if (!input.scope || input.scope.startsWith('sns:')) return { recorded: 0 };
    const row = this.findPersonaRow(input.personaId);
    if (!row) return { recorded: 0 };
    const persona = rowToPersonaRecord(row);
    if (!persona.learning) return { recorded: 0 };

    const rawItems =
      Array.isArray(input.memories) && input.memories.length > 0
        ? input.memories
        : input.note && input.note.trim()
          ? [{ note: input.note, quote: input.evidence ?? input.sourceText ?? '' }]
          : [];
    const items = rawItems.filter((item) => typeof item.note === 'string' && item.note.trim().length > 0);
    if (items.length === 0) return { recorded: 0 };

    const sourceText = typeof input.sourceText === 'string' ? input.sourceText : undefined;
    const ts = this.now();
    const eventSeq = input.eventSeq ?? ts;
    const speaker = input.speaker ?? input.sender ?? '';

    const recorded = this.store.transaction(() => {
      let inserted = 0;
      const insertStmt = this.store.db.prepare(
        `INSERT OR IGNORE INTO persona_memory
         (persona_id, scope, event_seq, note, quote, at, source_key, category, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      items.forEach((item, idx) => {
        const quote = (item.quote ?? input.evidence ?? '').trim();
        if (!quote) return;
        if (sourceText !== undefined && !sourceText.includes(quote)) return;
        const sourceKey =
          item.sourceKey ??
          (input.sourceKey ? (items.length === 1 ? input.sourceKey : `${input.sourceKey}#${idx}`) : null);
        const category = item.category?.trim() || DEFAULT_CATEGORY;
        const metaObj: PersonaMemoryMetadata = {
          ...(item.metadata ?? {}),
          ...(speaker ? { speaker } : {}),
        };
        const res = insertStmt.run(
          persona.id,
          input.scope,
          eventSeq,
          item.note.trim(),
          quote,
          ts + idx,
          sourceKey,
          category,
          JSON.stringify(metaObj),
        );
        inserted += Number(res.changes);
      });

      this.store.db
        .prepare(
          `DELETE FROM persona_memory
           WHERE persona_id = ? AND scope = ? AND source_key IS NULL
             AND id NOT IN (
               SELECT id FROM persona_memory
               WHERE persona_id = ? AND scope = ? AND source_key IS NULL
               ORDER BY at DESC, id DESC
               LIMIT ?
             )`,
        )
        .run(persona.id, input.scope, persona.id, input.scope, this.maxMemoriesPerScope);

      return inserted;
    });

    return { recorded };
  }

  listMemories(id: string, filter: { scope?: string; limit?: number } = {}): PersonaMemoryRecord[] {
    const clauses = ['persona_id = ?'];
    const params: Array<string | number> = [id];
    if (filter.scope !== undefined) {
      clauses.push('scope = ?');
      params.push(filter.scope);
    }
    const limitClause = filter.limit !== undefined ? ' LIMIT ?' : '';
    if (filter.limit !== undefined) {
      params.push(Math.max(0, filter.limit));
    }
    const rows = this.store.db
      .prepare(
        `SELECT id, persona_id, scope, event_seq, note, quote, at, source_key, category, metadata
         FROM persona_memory
         WHERE ${clauses.join(' AND ')}
         ORDER BY at DESC, id DESC${limitClause}`,
      )
      .all(...params) as unknown as PersonaMemoryRow[];
    return rows.map(rowToMemoryRecord);
  }

  editMemory(id: string, memoryId: number, note: string): void {
    const trimmed = note.trim();
    if (!trimmed) throw new Error('Memory note must be non-empty');
    const existing = this.store.db
      .prepare('SELECT metadata FROM persona_memory WHERE persona_id = ? AND id = ?')
      .get(id, memoryId) as { metadata: string } | undefined;
    if (!existing) {
      throw new Error(`Memory ${memoryId} not found for persona ${id}`);
    }
    const nextMeta = { ...parseJsonObject(existing.metadata), editedAt: this.now() };
    this.store.db
      .prepare('UPDATE persona_memory SET note = ?, metadata = ? WHERE persona_id = ? AND id = ?')
      .run(trimmed, JSON.stringify(nextMeta), id, memoryId);
  }

  clearMemories(id: string, scope?: string): { deleted: number } {
    const res =
      scope !== undefined
        ? this.store.db
            .prepare('DELETE FROM persona_memory WHERE persona_id = ? AND scope = ?')
            .run(id, scope)
        : this.store.db.prepare('DELETE FROM persona_memory WHERE persona_id = ?').run(id);
    return { deleted: Number(res.changes) };
  }

  private resolveSampleFilePath(): string | null {
    const dirs: string[] = [];
    if (Array.isArray(this.options.sampleDirs) && this.options.sampleDirs.length > 0) {
      for (const dir of this.options.sampleDirs) {
        dirs.push(expandHome(dir));
      }
    } else {
      if (!this.store.inMemory && this.store.stateDir && this.store.stateDir !== ':memory:') {
        dirs.push(this.store.stateDir);
      }
      dirs.push(expandHome(DEFAULT_LEGACY_WXARC_DIR));
    }
    for (const dir of dirs) {
      const candidate = path.join(dir, SAMPLE_FILENAME);
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  private readSampleFileAt(filePath: string): StyleSampleFile {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    const samples = normalizeSampleArray(parsed);
    const meta =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    return {
      source: typeof meta.source === 'string' ? meta.source : filePath,
      createdAt: typeof meta.createdAt === 'string' ? meta.createdAt : undefined,
      stats: meta.stats,
      samples,
    };
  }

  sample(): StyleSampleFile {
    const filePath = this.resolveSampleFilePath();
    if (!filePath) {
      throw new Error('Owner style sample file not found');
    }
    const file = this.readSampleFileAt(filePath);
    if (file.samples.length === 0) {
      throw new Error('Owner style sample file contains no valid samples');
    }
    return file;
  }

  sampleInfo(): StyleSampleInfo {
    const filePath = this.resolveSampleFilePath();
    if (!filePath) return { available: false };
    try {
      const file = this.readSampleFileAt(filePath);
      return {
        available: file.samples.length > 0,
        count: file.samples.length,
        source: file.source,
        createdAt: file.createdAt,
        stats: file.stats,
        path: filePath,
      };
    } catch {
      return { available: false, path: filePath };
    }
  }

  async learnStyleFromSamples(
    id: string,
    revision: number,
    options: LearnStyleOptions = {},
    signal?: AbortSignal,
  ): Promise<PersonaRecord> {
    if (signal?.aborted) throw new Error('Style learning aborted');
    const persona = this.get(id);
    if (persona.revision !== revision) {
      throw new PersonaRevisionConflictError(id, revision);
    }

    let samples: StyleSampleItem[] = [];
    let resolvedSource = options.source ?? options.samplePath;
    if (options.samples) {
      samples = normalizeSampleArray(options.samples);
    } else if (options.samplePath) {
      const file = this.readSampleFileAt(expandHome(options.samplePath));
      samples = file.samples;
      resolvedSource = options.source ?? file.source ?? options.samplePath;
    } else {
      const file = this.sample();
      samples = file.samples;
      resolvedSource = options.source ?? file.source;
    }
    if (samples.length === 0) {
      throw new Error('No style samples provided');
    }

    const summarizeInput: StyleSummarizeInput = {
      persona,
      samples,
      source: resolvedSource,
      policy: options.policy,
    };

    let summary: string;
    if (this.options.summarizeFn) {
      summary = await this.options.summarizeFn(summarizeInput, signal);
    } else if (this.llm?.summarizeStyle) {
      summary = await this.llm.summarizeStyle(summarizeInput, signal);
    } else if (this.llm?.complete) {
      const sampleLines = samples.slice(0, 40).map((s) => `- ${s.text}`).join('\n');
      summary = await this.llm.complete(
        {
          system: 'Extract a concise speaking style summary in 2-4 sentences. Never copy raw logs verbatim.',
          prompt: `Persona: ${persona.name}\nSamples:\n${sampleLines}`,
        },
        signal,
      );
    } else {
      summary = fallbackStyleSummary(samples);
    }

    if (signal?.aborted) throw new Error('Style learning aborted');
    const nextStyle = summary.trim();
    const styleMeta = {
      ...persona.styleMeta,
      source: resolvedSource ?? 'inline',
      sampleCount: samples.length,
      updatedAt: new Date(this.now()).toISOString(),
      policy: options.policy ?? null,
    };

    const res = this.store.db
      .prepare(
        `UPDATE personas
         SET style = ?, style_meta = ?, revision = revision + 1
         WHERE id = ? AND revision = ?`,
      )
      .run(nextStyle, JSON.stringify(styleMeta), id, revision);
    if (Number(res.changes) === 0) {
      throw new PersonaRevisionConflictError(id, revision);
    }
    return this.get(id);
  }

  async previewChat(input: PreviewChatInput, signal?: AbortSignal): Promise<PreviewChatResult> {
    if (signal?.aborted) throw new Error('Preview chat aborted');
    const scope = input.scope ?? 'preview:owner';
    const card = this.getDynamicCard({
      personaId: input.personaId,
      scope,
      channel: input.channel,
      ownerId: input.ownerId,
      ownerPreview: true,
      queryText: input.queryText ?? input.message,
    });
    if (!card) throw new PersonaNotFoundError(input.personaId);

    const runnerInput: PreviewRunnerInput = {
      card,
      message: input.message,
      history: input.history ?? [],
      scope,
      channel: input.channel,
    };

    let reply: string;
    if (this.options.previewRunner) {
      reply = await this.options.previewRunner(runnerInput, signal);
    } else if (this.llm?.previewChat) {
      reply = await this.llm.previewChat(runnerInput, signal);
    } else if (this.llm?.complete) {
      reply = await this.llm.complete(
        {
          system: card.promptBlock,
          prompt: input.message,
          history: runnerInput.history,
        },
        signal,
      );
    } else {
      reply = `[preview:${card.name}] ${input.message}`;
    }

    return {
      reply,
      personaId: card.id,
      dryRun: true,
      memoryMutated: false,
    };
  }

  importFoundation(bundle: FoundationBundle, sources: FoundationSource[] = []): FoundationImportResult {
    const sourceMap = new Map<string, FoundationSource>();
    for (const src of sources) {
      if (src && typeof src.source_id === 'string' && src.source_id.trim()) {
        sourceMap.set(src.source_id.trim(), src);
      }
    }
    const records = Array.isArray(bundle.records) ? bundle.records : [];
    const now = this.now();
    const touchedPersonas = new Set<string>();
    if (bundle.default_persona_id) touchedPersonas.add(bundle.default_persona_id);

    let added = 0;
    this.store.transaction(() => {
      const checkStmt = this.store.db.prepare(
        'SELECT id FROM persona_memory WHERE persona_id = ? AND source_key = ?',
      );
      const insertStmt = this.store.db.prepare(
        `INSERT INTO persona_memory
         (persona_id, scope, event_seq, note, quote, at, source_key, category, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const updateStmt = this.store.db.prepare(
        `UPDATE persona_memory
         SET scope = ?, note = ?, quote = ?, category = ?, metadata = ?
         WHERE id = ?`,
      );

      for (let i = 0; i < records.length; i += 1) {
        const rec = records[i];
        if (!rec || typeof rec.id !== 'string' || !rec.id.trim()) continue;
        const statement = typeof rec.statement === 'string' ? rec.statement.trim() : '';
        if (!statement) continue;
        const personaId = (rec.owner_persona_id || bundle.default_persona_id || '').trim();
        const subjectId = (rec.subject_id || bundle.subject_id || '').trim();
        if (!personaId || !subjectId) continue;
        touchedPersonas.add(personaId);

        const sourceKey = `${FOUNDATION_PREFIX}${rec.id.trim()}`;
        const scope = `${OWNER_SCOPE_PREFIX}${subjectId}`;
        const category = rec.category?.trim() || FOUNDATION_FALLBACK_CATEGORY;
        const sourceIds = Array.isArray(rec.source_ids) ? rec.source_ids.map((s) => String(s)) : [];
        const evidence: FoundationSource[] = [];
        for (const sid of sourceIds) {
          const found = sourceMap.get(sid);
          if (found) evidence.push(found);
        }
        const quote = (evidence[0]?.text ?? evidence[0]?.note ?? '').trim();
        const metadata: PersonaMemoryMetadata = {
          id: rec.id.trim(),
          title: rec.title,
          tags: Array.isArray(rec.tags) ? rec.tags.map((t) => String(t)) : undefined,
          status: rec.status,
          observed_from: rec.observed_from,
          observed_to: rec.observed_to,
          caveat: rec.caveat,
          source_ids: sourceIds,
          evidence,
          visibility: rec.visibility,
          source_snapshot: bundle.source_snapshot,
        };

        const existing = checkStmt.get(personaId, sourceKey) as { id: number } | undefined;
        if (existing) {
          updateStmt.run(scope, statement, quote, category, JSON.stringify(metadata), existing.id);
        } else {
          insertStmt.run(personaId, scope, 0, statement, quote, now + i, sourceKey, category, JSON.stringify(metadata));
          added += 1;
        }
      }
    });

    let total = 0;
    const countStmt = this.store.db.prepare(
      "SELECT COUNT(*) AS cnt FROM persona_memory WHERE persona_id = ? AND source_key LIKE 'foundation:%'",
    );
    for (const pid of touchedPersonas) {
      const row = countStmt.get(pid) as { cnt: number } | undefined;
      total += Number(row?.cnt ?? 0);
    }
    return { added, total };
  }

  autoMigrateIfEmpty(): LegacyMigrationResult {
    if (this.store.inMemory) {
      return { migrated: false, personasImported: 0, memoriesImported: 0, sourcePath: null };
    }
    const existingCountRow = this.store.db
      .prepare('SELECT COUNT(*) AS cnt FROM personas')
      .get() as { cnt: number } | undefined;
    if (Number(existingCountRow?.cnt ?? 0) > 0) {
      return { migrated: false, personasImported: 0, memoriesImported: 0, sourcePath: null };
    }
    if (this.store.getMeta('legacy_migration_done') === '1') {
      return { migrated: false, personasImported: 0, memoriesImported: 0, sourcePath: null };
    }

    const candidates =
      Array.isArray(this.options.legacyDbPaths) && this.options.legacyDbPaths.length > 0
        ? this.options.legacyDbPaths.map((p) => expandHome(p))
        : [expandHome(DEFAULT_LEGACY_WATCHER_DB), expandHome(DEFAULT_LEGACY_WXARC_DB)];

    for (const candidate of candidates) {
      if (!candidate || candidate === this.store.dbPath) continue;
      if (!fs.existsSync(candidate)) continue;
      let hasData = false;
      try {
        const probe = new DatabaseSync(candidate, { readOnly: true });
        try {
          const tbl = probe
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('personas', 'persona_memory')")
            .all() as Array<{ name: string }>;
          const names = new Set(tbl.map((t) => t.name));
          if (names.has('personas')) {
            const pCnt = probe.prepare('SELECT COUNT(*) AS cnt FROM personas').get() as { cnt: number } | undefined;
            if (Number(pCnt?.cnt ?? 0) > 0) hasData = true;
          }
          if (!hasData && names.has('persona_memory')) {
            const mCnt = probe.prepare('SELECT COUNT(*) AS cnt FROM persona_memory').get() as { cnt: number } | undefined;
            if (Number(mCnt?.cnt ?? 0) > 0) hasData = true;
          }
        } finally {
          probe.close();
        }
      } catch {
        continue;
      }

      if (!hasData) continue;
      const res = this.importFromWxarcSqlite(candidate);
      this.store.setMeta('legacy_migration_done', '1');
      this.store.setMeta('legacy_migration_source', candidate);
      return {
        migrated: true,
        personasImported: res.personasImported,
        memoriesImported: res.memoriesImported,
        sourcePath: candidate,
      };
    }

    return { migrated: false, personasImported: 0, memoriesImported: 0, sourcePath: null };
  }

  importFromWxarcSqlite(sqlitePath: string): WxarcImportResult {
    const src = new DatabaseSync(sqlitePath, { readOnly: true });
    try {
      const tableRows = src
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>;
      const tables = new Set(tableRows.map((r) => r.name));

      let personasImported = 0;
      let memoriesImported = 0;

      this.store.transaction(() => {
        if (tables.has('personas')) {
          const cols = new Set(
            (src.prepare('PRAGMA table_info(personas)').all() as Array<{ name: string }>).map((c) => c.name),
          );
          const rows = src.prepare('SELECT * FROM personas').all() as Array<Record<string, unknown>>;
          const stmt = this.store.db.prepare(
            'INSERT OR IGNORE INTO personas (id, revision, config, style, style_meta) VALUES (?, ?, ?, ?, ?)',
          );
          for (const row of rows) {
            const id = typeof row.id === 'string' ? row.id : '';
            if (!id) continue;
            const revision = cols.has('revision') && Number.isFinite(Number(row.revision)) ? Number(row.revision) : 1;
            const config = cols.has('config') && typeof row.config === 'string' ? row.config : JSON.stringify({ id });
            const style = cols.has('style') && typeof row.style === 'string' ? row.style : '';
            const styleMeta = cols.has('style_meta') && typeof row.style_meta === 'string' ? row.style_meta : '{}';
            const res = stmt.run(id, revision, config, style, styleMeta);
            personasImported += Number(res.changes);
          }
        }

        if (tables.has('persona_memory')) {
          const cols = new Set(
            (src.prepare('PRAGMA table_info(persona_memory)').all() as Array<{ name: string }>).map((c) => c.name),
          );
          const rows = src.prepare('SELECT * FROM persona_memory').all() as Array<Record<string, unknown>>;
          const stmt = this.store.db.prepare(
            `INSERT OR IGNORE INTO persona_memory
             (persona_id, scope, event_seq, note, quote, at, source_key, category, metadata)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          );
          for (const row of rows) {
            const personaId = typeof row.persona_id === 'string' ? row.persona_id : '';
            const scope = typeof row.scope === 'string' ? row.scope : '';
            const note = typeof row.note === 'string' ? row.note : '';
            if (!personaId || !scope || !note) continue;
            const eventSeq = cols.has('event_seq') && Number.isFinite(Number(row.event_seq)) ? Number(row.event_seq) : 0;
            const quote = cols.has('quote') && typeof row.quote === 'string' ? row.quote : '';
            const at = cols.has('at') && Number.isFinite(Number(row.at)) ? Number(row.at) : this.now();
            const sourceKey = cols.has('source_key') && typeof row.source_key === 'string' ? row.source_key : null;
            const category = cols.has('category') && typeof row.category === 'string' && row.category
              ? row.category
              : DEFAULT_CATEGORY;
            const metadata = cols.has('metadata') && typeof row.metadata === 'string' ? row.metadata : '{}';
            const res = stmt.run(personaId, scope, eventSeq, note, quote, at, sourceKey, category, metadata);
            memoriesImported += Number(res.changes);
          }
        }
      });

      return { personasImported, memoriesImported, sourcePath: sqlitePath };
    } finally {
      src.close();
    }
  }
}

export { PersonaWardrobeImpl as PersonaWardrobeStore };

export function createPersonaWardrobe(
  store: PersonaDb,
  llm?: PersonaWardrobeLlm,
  options?: PersonaWardrobeOptions,
): PersonaWardrobeImpl {
  return new PersonaWardrobeImpl(store, llm, options);
}
