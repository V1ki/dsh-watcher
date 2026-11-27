import { randomUUID } from 'node:crypto';
import type {
  ChatCircle,
  EventFactInput,
  EventFactRecord,
  EvidenceKind,
  EvidenceTargetType,
  MediaAssetInput,
  MediaAssetRecord,
  MediaType,
  MemoryEvidenceInput,
  MemoryEvidenceRecord,
  ObservationStatus,
  PersonaDb,
  PromoteObservationInput,
  PromotionEvidenceType,
  QualityTier,
  ReferenceCardInput,
  ReferenceCardRecord,
  ReferenceEntityType,
  VisualObservationInput,
  VisualObservationRecord,
} from './contracts.js';
import {
  MultimodalEvidenceError,
  VALID_PROMOTION_EVIDENCE_TYPES,
  buildFtsIndexDocument,
  normalizeChatId,
  normalizeHexDhash,
} from './multimodal.js';
import {
  bumpMemoryVersion,
  coerceChatCircle,
  coerceVisibility,
  getChatCircleRecord,
} from './wardrobe-policy.js';

const VALID_MEDIA_TYPES = new Set<MediaType>(['image', 'voice', 'video']);
const VALID_QUALITY_TIERS = new Set<QualityTier>(['high', 'medium', 'low']);
const VALID_ENTITY_TYPES = new Set<ReferenceEntityType>(['person', 'object', 'pet', 'place']);

function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.map((v) => String(v).trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function parseObjectJson(raw: string | null | undefined): Record<string, unknown> {
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

export function rowToMediaAsset(row: Record<string, unknown>): MediaAssetRecord {
  return {
    id: String(row.id),
    msgId: String(row.msg_id),
    chatId: String(row.chat_id),
    senderWxid: String(row.sender_wxid ?? ''),
    mediaType: String(row.media_type) as MediaType,
    sha256: String(row.sha256 ?? ''),
    dhash: String(row.dhash ?? ''),
    thumbPath: String(row.thumb_path ?? ''),
    durationMs: Number(row.duration_ms ?? 0),
    circle: coerceChatCircle(row.circle, 'external'),
    visibility: coerceVisibility(row.visibility, 'room'),
    transcript: String(row.transcript ?? ''),
    metadata: parseObjectJson(row.metadata as string | undefined),
    createdAt: Number(row.created_at),
  };
}

export function rowToObservation(row: Record<string, unknown>): VisualObservationRecord {
  return {
    id: String(row.id),
    personaId: String(row.persona_id ?? ''),
    mediaAssetId: String(row.media_asset_id),
    chatId: String(row.chat_id),
    senderWxid: String(row.sender_wxid ?? ''),
    subjectWxid: String(row.subject_wxid ?? ''),
    circle: coerceChatCircle(row.circle, 'external'),
    visibility: coerceVisibility(row.visibility, 'room'),
    status: String(row.status) as ObservationStatus,
    summary: String(row.summary),
    tags: parseStringArray(row.tags as string | undefined),
    entityGuesses: parseStringArray(row.entity_guesses as string | undefined),
    confidence: Number(row.confidence ?? 0),
    qualityTier: (VALID_QUALITY_TIERS.has(row.quality_tier as QualityTier)
      ? row.quality_tier
      : 'low') as QualityTier,
    model: String(row.model ?? ''),
    sourceMsgId: String(row.source_msg_id ?? ''),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function rowToEventFact(row: Record<string, unknown>): EventFactRecord {
  return {
    id: String(row.id),
    personaId: String(row.persona_id ?? ''),
    subjectWxid: String(row.subject_wxid ?? ''),
    subjectName: String(row.subject_name ?? ''),
    predicate: String(row.predicate),
    objectName: String(row.object_name),
    statement: String(row.statement),
    tags: parseStringArray(row.tags as string | undefined),
    circle: coerceChatCircle(row.circle, 'external'),
    visibility: coerceVisibility(row.visibility, 'circle'),
    roomChatId: String(row.room_chat_id ?? ''),
    status: String(row.status) as ObservationStatus,
    evidenceType: String(row.evidence_type) as PromotionEvidenceType,
    confidence: Number(row.confidence ?? 1),
    editedAt: row.edited_at !== null && row.edited_at !== undefined ? Number(row.edited_at) : null,
    revokedAt: row.revoked_at !== null && row.revoked_at !== undefined ? Number(row.revoked_at) : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function rowToReferenceCard(row: Record<string, unknown>): ReferenceCardRecord {
  return {
    id: String(row.id),
    entityType: String(row.entity_type) as ReferenceEntityType,
    entityName: String(row.entity_name),
    aliases: parseStringArray(row.aliases as string | undefined),
    subjectWxid: String(row.subject_wxid ?? ''),
    tags: parseStringArray(row.tags as string | undefined),
    description: String(row.description ?? ''),
    imagePath: String(row.image_path ?? ''),
    dhash: String(row.dhash ?? ''),
    circle: coerceChatCircle(row.circle, 'external'),
    visibility: coerceVisibility(row.visibility, 'circle'),
    roomChatId: String(row.room_chat_id ?? ''),
    qualityScore: Number(row.quality_score ?? 1),
    reviewedBy: String(row.reviewed_by ?? ''),
    revokedAt: row.revoked_at !== null && row.revoked_at !== undefined ? Number(row.revoked_at) : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function insertEvidenceRow(store: PersonaDb, input: MemoryEvidenceInput, now: number): void {
  const id = input.id?.trim() || `ev-${randomUUID().slice(0, 12)}`;
  store.db
    .prepare(
      `INSERT OR IGNORE INTO memory_evidence
       (id, target_type, target_id, evidence_kind, source_msg_id, chat_id, sender_wxid, media_asset_id, excerpt, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.targetType,
      input.targetId,
      input.evidenceKind,
      (input.sourceMsgId ?? '').trim(),
      normalizeChatId(input.chatId ?? ''),
      (input.senderWxid ?? '').trim(),
      (input.mediaAssetId ?? '').trim(),
      (input.excerpt ?? '').trim(),
      now,
    );
}

export function upsertMediaAssetOp(
  store: PersonaDb,
  input: MediaAssetInput,
  now: number,
): MediaAssetRecord {
  const msgId = (input.msgId ?? '').trim();
  const chatId = normalizeChatId(input.chatId);
  if (!msgId || !chatId) {
    throw new MultimodalEvidenceError('MEDIA_ASSET_INVALID', 'msgId and chatId are required');
  }
  if (!VALID_MEDIA_TYPES.has(input.mediaType)) {
    throw new MultimodalEvidenceError('MEDIA_TYPE_INVALID', `Invalid mediaType: ${String(input.mediaType)}`);
  }
  const sha256 = (input.sha256 ?? '').trim();
  const dhash = normalizeHexDhash(input.dhash);
  const circle = input.circle
    ? coerceChatCircle(input.circle, 'external')
    : getChatCircleRecord(store, chatId).circle;
  const visibility = coerceVisibility(
    input.visibility,
    circle === 'family' || circle === 'work' ? 'circle' : 'room',
  );

  const existing = store.db
    .prepare('SELECT id FROM media_asset WHERE msg_id = ? AND sha256 = ?')
    .get(msgId, sha256) as { id: string } | undefined;
  const id = existing?.id || input.id?.trim() || `media-${randomUUID().slice(0, 12)}`;

  store.transaction(() => {
    if (existing) {
      store.db
        .prepare(
          `UPDATE media_asset
           SET chat_id = ?, sender_wxid = ?, media_type = ?, dhash = ?, thumb_path = ?, duration_ms = ?, circle = ?, visibility = ?, transcript = ?, metadata = ?
           WHERE id = ?`,
        )
        .run(
          chatId,
          (input.senderWxid ?? '').trim(),
          input.mediaType,
          dhash,
          (input.thumbPath ?? '').trim(),
          Math.max(0, Math.trunc(input.durationMs ?? 0)),
          circle,
          visibility,
          (input.transcript ?? '').trim(),
          JSON.stringify(input.metadata ?? {}),
          id,
        );
    } else {
      store.db
        .prepare(
          `INSERT INTO media_asset
           (id, msg_id, chat_id, sender_wxid, media_type, sha256, dhash, thumb_path, duration_ms, circle, visibility, transcript, metadata, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             chat_id = excluded.chat_id,
             sender_wxid = excluded.sender_wxid,
             media_type = excluded.media_type,
             sha256 = excluded.sha256,
             dhash = excluded.dhash,
             thumb_path = excluded.thumb_path,
             duration_ms = excluded.duration_ms,
             circle = excluded.circle,
             visibility = excluded.visibility,
             transcript = excluded.transcript,
             metadata = excluded.metadata`,
        )
        .run(
          id,
          msgId,
          chatId,
          (input.senderWxid ?? '').trim(),
          input.mediaType,
          sha256,
          dhash,
          (input.thumbPath ?? '').trim(),
          Math.max(0, Math.trunc(input.durationMs ?? 0)),
          circle,
          visibility,
          (input.transcript ?? '').trim(),
          JSON.stringify(input.metadata ?? {}),
          now,
        );
    }
    bumpMemoryVersion(store);
  });

  const row = store.db.prepare('SELECT * FROM media_asset WHERE id = ?').get(id) as Record<
    string,
    unknown
  >;
  return rowToMediaAsset(row);
}

export function recordVisualObservationOp(
  store: PersonaDb,
  input: VisualObservationInput,
  now: number,
): VisualObservationRecord {
  const mediaAssetId = (input.mediaAssetId ?? '').trim();
  const chatId = normalizeChatId(input.chatId);
  const summary = (input.summary ?? '').trim();
  if (!mediaAssetId || !chatId || !summary) {
    throw new MultimodalEvidenceError(
      'OBSERVATION_INVALID',
      'mediaAssetId, chatId, and summary are required',
    );
  }
  const asset = store.db
    .prepare('SELECT id FROM media_asset WHERE id = ?')
    .get(mediaAssetId) as { id: string } | undefined;
  if (!asset) {
    throw new MultimodalEvidenceError(
      'MEDIA_ASSET_NOT_FOUND',
      `Media asset not found: ${mediaAssetId}`,
    );
  }
  const id = input.id?.trim() || `obs-${randomUUID().slice(0, 12)}`;
  const circle = input.circle
    ? coerceChatCircle(input.circle, 'external')
    : getChatCircleRecord(store, chatId).circle;
  const visibility = coerceVisibility(
    input.visibility,
    circle === 'family' || circle === 'work' ? 'circle' : 'room',
  );
  const qualityTier: QualityTier =
    input.qualityTier && VALID_QUALITY_TIERS.has(input.qualityTier) ? input.qualityTier : 'low';
  const tags = Array.isArray(input.tags) ? input.tags.map((t) => String(t).trim()).filter(Boolean) : [];
  const guesses = Array.isArray(input.entityGuesses)
    ? input.entityGuesses.map((g) => String(g).trim()).filter(Boolean)
    : [];
  const confidence =
    typeof input.confidence === 'number' && Number.isFinite(input.confidence)
      ? Math.max(0, Math.min(1, input.confidence))
      : 0;

  store.transaction(() => {
    store.db
      .prepare(
        `INSERT INTO visual_observation
         (id, persona_id, media_asset_id, chat_id, sender_wxid, subject_wxid, circle, visibility, status, summary, tags, entity_guesses, confidence, quality_tier, model, source_msg_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        (input.personaId ?? '').trim(),
        mediaAssetId,
        chatId,
        (input.senderWxid ?? '').trim(),
        (input.subjectWxid ?? '').trim(),
        circle,
        visibility,
        summary,
        JSON.stringify(tags),
        JSON.stringify(guesses),
        confidence,
        qualityTier,
        (input.model ?? '').trim(),
        (input.sourceMsgId ?? '').trim(),
        now,
        now,
      );
    insertEvidenceRow(
      store,
      {
        targetType: 'visual_observation',
        targetId: id,
        evidenceKind: 'visual',
        sourceMsgId: input.sourceMsgId,
        chatId,
        senderWxid: input.senderWxid,
        mediaAssetId,
        excerpt: summary,
      },
      now,
    );
    bumpMemoryVersion(store);
  });

  const row = store.db.prepare('SELECT * FROM visual_observation WHERE id = ?').get(id) as Record<
    string,
    unknown
  >;
  return rowToObservation(row);
}

export function listVisualObservationsOp(
  store: PersonaDb,
  filter: {
    chatId?: string;
    status?: ObservationStatus;
    circle?: ChatCircle;
    limit?: number;
  } = {},
): VisualObservationRecord[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (filter.chatId) {
    clauses.push('chat_id = ?');
    params.push(normalizeChatId(filter.chatId));
  }
  if (filter.status) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  if (filter.circle) {
    clauses.push('circle = ?');
    params.push(filter.circle);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limitSql = filter.limit !== undefined ? ' LIMIT ?' : '';
  if (filter.limit !== undefined) params.push(Math.max(0, Math.trunc(filter.limit)));
  const rows = store.db
    .prepare(`SELECT * FROM visual_observation ${where} ORDER BY created_at DESC${limitSql}`)
    .all(...params) as Array<Record<string, unknown>>;
  return rows.map(rowToObservation);
}

function assertPromotionEvidence(evidenceType: unknown): PromotionEvidenceType {
  if (
    typeof evidenceType !== 'string' ||
    !VALID_PROMOTION_EVIDENCE_TYPES.has(evidenceType as PromotionEvidenceType)
  ) {
    throw new MultimodalEvidenceError(
      'VISUAL_ONLY_PROMOTION_FORBIDDEN',
      `Fact promotion requires text, voice, or owner_confirmed evidence; got: ${String(evidenceType)}`,
    );
  }
  return evidenceType as PromotionEvidenceType;
}

function indexEventFactFts(store: PersonaDb, fact: EventFactRecord): void {
  store.db.prepare('DELETE FROM event_fact_fts WHERE fact_id = ?').run(fact.id);
  const doc = buildFtsIndexDocument([
    fact.subjectName,
    fact.predicate,
    fact.objectName,
    fact.statement,
    fact.tags,
  ]);
  if (doc) {
    store.db
      .prepare('INSERT INTO event_fact_fts (fact_id, search_text) VALUES (?, ?)')
      .run(fact.id, doc);
  }
}

export function promoteObservationToFactOp(
  store: PersonaDb,
  input: PromoteObservationInput,
  now: number,
): { observation: VisualObservationRecord; fact: EventFactRecord } {
  const evidenceType = assertPromotionEvidence(input.evidenceType);
  const obsRow = store.db
    .prepare('SELECT * FROM visual_observation WHERE id = ?')
    .get(input.observationId) as Record<string, unknown> | undefined;
  if (!obsRow) {
    throw new MultimodalEvidenceError(
      'OBSERVATION_NOT_FOUND',
      `Visual observation not found: ${input.observationId}`,
    );
  }
  const existingObs = rowToObservation(obsRow);
  if (existingObs.status === 'rejected') {
    throw new MultimodalEvidenceError(
      'OBSERVATION_REJECTED',
      `Cannot promote rejected observation: ${input.observationId}`,
    );
  }

  const predicate = (input.predicate ?? '').trim();
  const objectName = (input.objectName ?? '').trim();
  const statement = (input.statement ?? '').trim();
  if (!predicate || !objectName || !statement) {
    throw new MultimodalEvidenceError(
      'EVENT_FACT_INVALID',
      'predicate, objectName, and statement are required',
    );
  }

  const circle = input.circle
    ? coerceChatCircle(input.circle, existingObs.circle)
    : existingObs.circle;
  const visibility = coerceVisibility(
    input.visibility,
    circle === 'family' || circle === 'work' ? 'circle' : 'room',
  );
  const tags = Array.isArray(input.tags)
    ? input.tags.map((t) => String(t).trim()).filter(Boolean)
    : existingObs.tags;
  const factId = `fact-${randomUUID().slice(0, 12)}`;
  const confidence =
    typeof input.confidence === 'number' && Number.isFinite(input.confidence)
      ? Math.max(0, Math.min(1, input.confidence))
      : 1;

  store.transaction(() => {
    store.db
      .prepare("UPDATE visual_observation SET status = 'confirmed', updated_at = ? WHERE id = ?")
      .run(now, existingObs.id);

    store.db
      .prepare(
        `INSERT INTO event_fact
         (id, persona_id, subject_wxid, subject_name, predicate, object_name, statement, tags, circle, visibility, room_chat_id, status, evidence_type, confidence, edited_at, revoked_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, NULL, NULL, ?, ?)`,
      )
      .run(
        factId,
        existingObs.personaId,
        (input.subjectWxid ?? existingObs.subjectWxid ?? existingObs.senderWxid).trim(),
        (input.subjectName ?? '').trim(),
        predicate,
        objectName,
        statement,
        JSON.stringify(tags),
        circle,
        visibility,
        existingObs.chatId,
        evidenceType,
        confidence,
        now,
        now,
      );

    const createdFact = rowToEventFact(
      store.db.prepare('SELECT * FROM event_fact WHERE id = ?').get(factId) as Record<
        string,
        unknown
      >,
    );
    indexEventFactFts(store, createdFact);

    insertEvidenceRow(
      store,
      {
        targetType: 'event_fact',
        targetId: factId,
        evidenceKind: evidenceType,
        sourceMsgId: input.sourceMsgId ?? existingObs.sourceMsgId,
        chatId: existingObs.chatId,
        senderWxid: input.confirmedBy ?? existingObs.senderWxid,
        mediaAssetId: existingObs.mediaAssetId,
        excerpt: input.evidenceExcerpt ?? statement,
      },
      now,
    );
    bumpMemoryVersion(store);
  });

  const observation = rowToObservation(
    store.db.prepare('SELECT * FROM visual_observation WHERE id = ?').get(existingObs.id) as Record<
      string,
      unknown
    >,
  );
  const fact = rowToEventFact(
    store.db.prepare('SELECT * FROM event_fact WHERE id = ?').get(factId) as Record<
      string,
      unknown
    >,
  );
  return { observation, fact };
}

export function rejectObservationOp(
  store: PersonaDb,
  observationId: string,
  now: number,
): boolean {
  return store.transaction(() => {
    const res = store.db
      .prepare("UPDATE visual_observation SET status = 'rejected', updated_at = ? WHERE id = ?")
      .run(now, observationId);
    const changed = Number(res.changes) > 0;
    if (changed) bumpMemoryVersion(store);
    return changed;
  });
}

export function recordEventFactOp(
  store: PersonaDb,
  input: EventFactInput,
  now: number,
): EventFactRecord {
  const evidenceType = assertPromotionEvidence(input.evidenceType);
  const predicate = (input.predicate ?? '').trim();
  const objectName = (input.objectName ?? '').trim();
  const statement = (input.statement ?? '').trim();
  if (!predicate || !objectName || !statement) {
    throw new MultimodalEvidenceError(
      'EVENT_FACT_INVALID',
      'predicate, objectName, and statement are required',
    );
  }
  const roomChatId = normalizeChatId(input.roomChatId ?? '');
  const circle = input.circle
    ? coerceChatCircle(input.circle, 'external')
    : roomChatId
      ? getChatCircleRecord(store, roomChatId).circle
      : 'external';
  const visibility = coerceVisibility(
    input.visibility,
    circle === 'family' || circle === 'work' ? 'circle' : 'room',
  );
  const tags = Array.isArray(input.tags) ? input.tags.map((t) => String(t).trim()).filter(Boolean) : [];
  const id = input.id?.trim() || `fact-${randomUUID().slice(0, 12)}`;
  const confidence =
    typeof input.confidence === 'number' && Number.isFinite(input.confidence)
      ? Math.max(0, Math.min(1, input.confidence))
      : 1;

  store.transaction(() => {
    store.db
      .prepare(
        `INSERT INTO event_fact
         (id, persona_id, subject_wxid, subject_name, predicate, object_name, statement, tags, circle, visibility, room_chat_id, status, evidence_type, confidence, edited_at, revoked_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, NULL, NULL, ?, ?)`,
      )
      .run(
        id,
        (input.personaId ?? '').trim(),
        (input.subjectWxid ?? '').trim(),
        (input.subjectName ?? '').trim(),
        predicate,
        objectName,
        statement,
        JSON.stringify(tags),
        circle,
        visibility,
        roomChatId,
        evidenceType,
        confidence,
        now,
        now,
      );
    const createdFact = rowToEventFact(
      store.db.prepare('SELECT * FROM event_fact WHERE id = ?').get(id) as Record<string, unknown>,
    );
    indexEventFactFts(store, createdFact);
    insertEvidenceRow(
      store,
      {
        targetType: 'event_fact',
        targetId: id,
        evidenceKind: evidenceType,
        sourceMsgId: input.sourceMsgId,
        chatId: roomChatId,
        senderWxid: input.confirmedBy ?? input.subjectWxid,
        excerpt: input.evidenceExcerpt ?? statement,
      },
      now,
    );
    bumpMemoryVersion(store);
  });

  return rowToEventFact(
    store.db.prepare('SELECT * FROM event_fact WHERE id = ?').get(id) as Record<string, unknown>,
  );
}

export function listEventFactsOp(
  store: PersonaDb,
  filter: { circle?: ChatCircle; includeRevoked?: boolean; limit?: number } = {},
): EventFactRecord[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (filter.circle) {
    clauses.push('circle = ?');
    params.push(filter.circle);
  }
  if (!filter.includeRevoked) {
    clauses.push('revoked_at IS NULL');
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limitSql = filter.limit !== undefined ? ' LIMIT ?' : '';
  if (filter.limit !== undefined) params.push(Math.max(0, Math.trunc(filter.limit)));
  const rows = store.db
    .prepare(`SELECT * FROM event_fact ${where} ORDER BY updated_at DESC${limitSql}`)
    .all(...params) as Array<Record<string, unknown>>;
  return rows.map(rowToEventFact);
}

export function revokeEventFactOp(store: PersonaDb, factId: string, now: number): boolean {
  return store.transaction(() => {
    const res = store.db
      .prepare('UPDATE event_fact SET revoked_at = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(now, now, factId);
    const changed = Number(res.changes) > 0;
    if (changed) {
      store.db.prepare('DELETE FROM event_fact_fts WHERE fact_id = ?').run(factId);
      bumpMemoryVersion(store);
    }
    return changed;
  });
}

export function upsertReferenceCardOp(
  store: PersonaDb,
  input: ReferenceCardInput,
  now: number,
): ReferenceCardRecord {
  if (!VALID_ENTITY_TYPES.has(input.entityType)) {
    throw new MultimodalEvidenceError(
      'REFERENCE_CARD_INVALID',
      `Invalid entityType: ${String(input.entityType)}`,
    );
  }
  const entityName = (input.entityName ?? '').trim();
  if (!entityName) {
    throw new MultimodalEvidenceError('REFERENCE_CARD_INVALID', 'entityName is required');
  }
  const id = input.id?.trim() || `ref-${randomUUID().slice(0, 12)}`;
  const aliases = Array.isArray(input.aliases)
    ? input.aliases.map((a) => String(a).trim()).filter(Boolean)
    : [];
  const tags = Array.isArray(input.tags) ? input.tags.map((t) => String(t).trim()).filter(Boolean) : [];
  const roomChatId = normalizeChatId(input.roomChatId ?? '');
  const circle = input.circle
    ? coerceChatCircle(input.circle, 'external')
    : roomChatId
      ? getChatCircleRecord(store, roomChatId).circle
      : 'external';
  const visibility = coerceVisibility(
    input.visibility,
    circle === 'family' || circle === 'work' ? 'circle' : 'room',
  );
  const dhash = normalizeHexDhash(input.dhash);
  const qualityScore =
    typeof input.qualityScore === 'number' && Number.isFinite(input.qualityScore)
      ? Math.max(0, Math.min(1, input.qualityScore))
      : 1;

  store.transaction(() => {
    store.db
      .prepare(
        `INSERT INTO reference_card
         (id, entity_type, entity_name, aliases, subject_wxid, tags, description, image_path, dhash, circle, visibility, room_chat_id, quality_score, reviewed_by, revoked_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           entity_type = excluded.entity_type,
           entity_name = excluded.entity_name,
           aliases = excluded.aliases,
           subject_wxid = excluded.subject_wxid,
           tags = excluded.tags,
           description = excluded.description,
           image_path = excluded.image_path,
           dhash = excluded.dhash,
           circle = excluded.circle,
           visibility = excluded.visibility,
           room_chat_id = excluded.room_chat_id,
           quality_score = excluded.quality_score,
           reviewed_by = excluded.reviewed_by,
           revoked_at = NULL,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        input.entityType,
        entityName,
        JSON.stringify(aliases),
        (input.subjectWxid ?? '').trim(),
        JSON.stringify(tags),
        (input.description ?? '').trim(),
        (input.imagePath ?? '').trim(),
        dhash,
        circle,
        visibility,
        roomChatId,
        qualityScore,
        (input.reviewedBy ?? '').trim(),
        now,
        now,
      );

    store.db.prepare('DELETE FROM reference_card_fts WHERE card_id = ?').run(id);
    const ftsDoc = buildFtsIndexDocument([entityName, aliases, tags, input.description]);
    if (ftsDoc) {
      store.db
        .prepare('INSERT INTO reference_card_fts (card_id, search_text) VALUES (?, ?)')
        .run(id, ftsDoc);
    }
    bumpMemoryVersion(store);
  });

  return rowToReferenceCard(
    store.db.prepare('SELECT * FROM reference_card WHERE id = ?').get(id) as Record<string, unknown>,
  );
}

export function listReferenceCardsOp(
  store: PersonaDb,
  filter: {
    circle?: ChatCircle;
    entityType?: ReferenceEntityType;
    includeRevoked?: boolean;
  } = {},
): ReferenceCardRecord[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filter.circle) {
    clauses.push('circle = ?');
    params.push(filter.circle);
  }
  if (filter.entityType) {
    clauses.push('entity_type = ?');
    params.push(filter.entityType);
  }
  if (!filter.includeRevoked) {
    clauses.push('revoked_at IS NULL');
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = store.db
    .prepare(`SELECT * FROM reference_card ${where} ORDER BY updated_at DESC`)
    .all(...params) as Array<Record<string, unknown>>;
  return rows.map(rowToReferenceCard);
}

export function deleteReferenceCardOp(store: PersonaDb, cardId: string, now: number): boolean {
  return store.transaction(() => {
    const res = store.db
      .prepare('UPDATE reference_card SET revoked_at = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(now, now, cardId);
    const changed = Number(res.changes) > 0;
    if (changed) {
      store.db.prepare('DELETE FROM reference_card_fts WHERE card_id = ?').run(cardId);
      bumpMemoryVersion(store);
    }
    return changed;
  });
}

export function listEvidenceOp(
  store: PersonaDb,
  targetType: EvidenceTargetType,
  targetId: string,
): MemoryEvidenceRecord[] {
  const rows = store.db
    .prepare(
      'SELECT * FROM memory_evidence WHERE target_type = ? AND target_id = ? ORDER BY created_at DESC',
    )
    .all(targetType, targetId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    targetType: String(row.target_type) as EvidenceTargetType,
    targetId: String(row.target_id),
    evidenceKind: String(row.evidence_kind) as EvidenceKind,
    sourceMsgId: String(row.source_msg_id ?? ''),
    chatId: String(row.chat_id ?? ''),
    senderWxid: String(row.sender_wxid ?? ''),
    mediaAssetId: String(row.media_asset_id ?? ''),
    excerpt: String(row.excerpt ?? ''),
    createdAt: Number(row.created_at),
  }));
}
