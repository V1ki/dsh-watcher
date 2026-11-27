import { createHash } from 'node:crypto';
import type {
  AudienceTag,
  ChatCircle,
  ChatCircleRecord,
  ContextStamp,
  ContextStampInput,
  DynamicPersonaCardInput,
  MemoryVisibility,
  PersonaDb,
  PersonaMemoryMetadata,
  PersonaMemoryRecord,
  VaultVisibility,
} from './contracts.js';
import {
  VALID_AUDIENCE_TAGS,
  VALID_CHAT_CIRCLES,
  VALID_MEMORY_VISIBILITIES,
  buildChatCircleLookupKeys,
  isDrawerRecordAllowed,
  normalizeChatId,
} from './multimodal.js';

export const DEFAULT_MEMORY_CATEGORY = '聊天偏好';
export const FOUNDATION_SOURCE_PREFIX = 'foundation:';
export const OWNER_SCOPE_PREFIX = 'owner:';
export const FOUNDATION_FALLBACK_CATEGORY = '基础事实';
export const FOUNDATION_MATCH_LIMIT = 6;
export const FOUNDATION_FALLBACK_LIMIT = 4;

export interface PersonaMemoryFullRow {
  id: number;
  persona_id: string;
  scope: string;
  event_seq: number;
  note: string;
  quote: string;
  at: number;
  source_key: string | null;
  category: string;
  subject_wxid?: string;
  speaker_wxid?: string;
  visibility?: string;
  audience_tag?: string;
  edited_at?: number | null;
  revoked_at?: number | null;
  metadata: string;
}

export interface CardAccessContext {
  activeChatId: string;
  isGroup: boolean;
  circle: ChatCircle;
  allowOwnerPrivate: boolean;
  version: number;
}

export function parseMetadataJson(raw: string | null | undefined): PersonaMemoryMetadata {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as PersonaMemoryMetadata)
      : {};
  } catch {
    return {};
  }
}

export function coerceVisibility(
  raw: unknown,
  fallback: MemoryVisibility = 'room',
): MemoryVisibility {
  if (typeof raw === 'string' && VALID_MEMORY_VISIBILITIES.has(raw as MemoryVisibility)) {
    return raw as MemoryVisibility;
  }
  return fallback;
}

export function coerceAudienceTag(raw: unknown, fallback: AudienceTag = ''): AudienceTag {
  if (typeof raw === 'string' && VALID_AUDIENCE_TAGS.has(raw as AudienceTag)) {
    return raw as AudienceTag;
  }
  return fallback;
}

export function coerceChatCircle(raw: unknown, fallback: ChatCircle = 'external'): ChatCircle {
  if (typeof raw === 'string' && VALID_CHAT_CIRCLES.has(raw as ChatCircle)) {
    return raw as ChatCircle;
  }
  return fallback;
}

export function rowToFullMemoryRecord(row: PersonaMemoryFullRow): PersonaMemoryRecord {
  const metadata = parseMetadataJson(row.metadata);
  const defaultVis: MemoryVisibility =
    row.scope.startsWith(OWNER_SCOPE_PREFIX) || row.source_key?.startsWith(FOUNDATION_SOURCE_PREFIX)
      ? 'owner_private'
      : 'room';
  return {
    id: Number(row.id),
    personaId: row.persona_id,
    scope: row.scope,
    eventSeq: Number(row.event_seq),
    note: row.note,
    quote: row.quote,
    at: Number(row.at),
    sourceKey: row.source_key ?? null,
    category: row.category || DEFAULT_MEMORY_CATEGORY,
    subjectWxid: typeof row.subject_wxid === 'string' ? row.subject_wxid : '',
    speakerWxid: typeof row.speaker_wxid === 'string' ? row.speaker_wxid : '',
    visibility: coerceVisibility(row.visibility ?? metadata.visibility, defaultVis),
    audienceTag: coerceAudienceTag(row.audience_tag ?? metadata.audienceTag, ''),
    editedAt:
      row.edited_at !== undefined && row.edited_at !== null
        ? Number(row.edited_at)
        : typeof metadata.editedAt === 'number'
          ? metadata.editedAt
          : null,
    revokedAt:
      row.revoked_at !== undefined && row.revoked_at !== null
        ? Number(row.revoked_at)
        : typeof metadata.revokedAt === 'number'
          ? metadata.revokedAt
          : null,
    metadata,
  };
}

export function getMemoryVersion(store: PersonaDb): number {
  const raw = store.getMeta('memory_version', '1');
  const parsed = Number.parseInt(raw ?? '1', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export function bumpMemoryVersion(store: PersonaDb): number {
  const next = getMemoryVersion(store) + 1;
  store.setMeta('memory_version', String(next));
  return next;
}

export function getChatCircleRecord(store: PersonaDb, chatId: string): ChatCircleRecord {
  const keys = buildChatCircleLookupKeys(chatId);
  if (keys.length === 0) {
    return { chatId: '', circle: 'external', label: '', updatedAt: 0, labeled: false };
  }
  const stmt = store.db.prepare(
    'SELECT chat_id, circle, label, updated_at FROM chat_circle WHERE chat_id = ?',
  );
  for (const key of keys) {
    const row = stmt.get(key) as
      | { chat_id: string; circle: string; label: string; updated_at: number }
      | undefined;
    if (row) {
      return {
        chatId: row.chat_id,
        circle: coerceChatCircle(row.circle, 'external'),
        label: row.label ?? '',
        updatedAt: Number(row.updated_at),
        labeled: true,
      };
    }
  }
  return { chatId: keys[0]!, circle: 'external', label: '', updatedAt: 0, labeled: false };
}

export function resolveVaultVisibilityRecord(
  store: PersonaDb,
  roomKey: string,
): VaultVisibility {
  const record = getChatCircleRecord(store, roomKey);
  if (!record.labeled) {
    return 'owner_private';
  }
  if (record.circle === 'work') return 'work';
  if (record.circle === 'family') return 'family';
  if (record.circle === 'external') return 'external';
  return 'owner_private';
}

export function resolveRecordVaultVisibility(
  store: PersonaDb,
  input: {
    visibility: MemoryVisibility;
    circle: ChatCircle;
    roomChatId: string;
  },
): VaultVisibility {
  if (input.visibility === 'owner_private' || input.visibility === 'dm_only') {
    return 'owner_private';
  }
  const normalizedRoom = normalizeChatId(input.roomChatId);
  if (normalizedRoom) {
    const roomRec = getChatCircleRecord(store, normalizedRoom);
    if (!roomRec.labeled) {
      return 'owner_private';
    }
    if (
      input.visibility === 'circle' &&
      (input.circle === 'family' || input.circle === 'work') &&
      roomRec.circle === 'external'
    ) {
      return input.circle;
    }
    if (roomRec.circle === 'work') return 'work';
    if (roomRec.circle === 'family') return 'family';
    if (roomRec.circle === 'external') return 'external';
    return 'owner_private';
  }
  if (input.circle === 'family') return 'family';
  if (input.circle === 'work') return 'work';
  if (input.circle === 'external' && input.visibility === 'circle') return 'external';
  return 'owner_private';
}

export function setChatCircleRecord(
  store: PersonaDb,
  chatId: string,
  circle: ChatCircle,
  label: string | undefined,
  now: number,
): ChatCircleRecord {
  const normalized = normalizeChatId(chatId);
  if (!normalized) {
    throw new Error('chatId must be non-empty');
  }
  if (!VALID_CHAT_CIRCLES.has(circle)) {
    throw new Error(`Invalid chat circle: ${String(circle)}`);
  }
  const cleanLabel = (label ?? '').trim();
  store.transaction(() => {
    store.db
      .prepare(
        `INSERT INTO chat_circle (chat_id, circle, label, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET
           circle = excluded.circle,
           label = excluded.label,
           updated_at = excluded.updated_at`,
      )
      .run(normalized, circle, cleanLabel, now);
    bumpMemoryVersion(store);
  });
  return {
    chatId: normalized,
    circle,
    label: cleanLabel,
    updatedAt: now,
    labeled: true,
  };
}

export function deleteChatCircleRecord(store: PersonaDb, chatId: string): boolean {
  const keys = buildChatCircleLookupKeys(chatId);
  if (keys.length === 0) return false;
  return store.transaction(() => {
    const stmt = store.db.prepare('DELETE FROM chat_circle WHERE chat_id = ?');
    for (const key of keys) {
      const res = stmt.run(key);
      if (Number(res.changes) > 0) {
        bumpMemoryVersion(store);
        return true;
      }
    }
    return false;
  });
}

export function listChatCircleRecords(store: PersonaDb): ChatCircleRecord[] {
  const rows = store.db
    .prepare('SELECT chat_id, circle, label, updated_at FROM chat_circle ORDER BY chat_id ASC')
    .all() as Array<{ chat_id: string; circle: string; label: string; updated_at: number }>;
  return rows.map((row) => ({
    chatId: row.chat_id,
    circle: coerceChatCircle(row.circle, 'external'),
    label: row.label ?? '',
    updatedAt: Number(row.updated_at),
    labeled: true,
  }));
}

export function computeContextStamp(store: PersonaDb, input: ContextStampInput): ContextStamp {
  const chatId = normalizeChatId(input.chatId ?? input.scope ?? '');
  const version = getMemoryVersion(store);
  const circle = getChatCircleRecord(store, chatId).circle;
  const participants = Array.isArray(input.participants)
    ? Array.from(new Set(input.participants.map((p) => p.trim()).filter(Boolean))).sort()
    : [];
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        personaId: input.personaId,
        chatId,
        scope: input.scope ?? '',
        circle,
        participants,
        version,
      }),
      'utf8',
    )
    .digest('hex')
    .slice(0, 16);
  return {
    version,
    circle,
    stamp: `v${version}:${circle}:${digest}`,
  };
}

export function resolveCardAccess(
  store: PersonaDb,
  input: DynamicPersonaCardInput,
): CardAccessContext {
  const activeChatId = normalizeChatId(input.chatId ?? input.roomKey ?? input.scope ?? '');
  const scopeChatId = normalizeChatId(input.scope ?? '');
  const isGroup =
    input.isGroup === true ||
    activeChatId.endsWith('@chatroom') ||
    scopeChatId.endsWith('@chatroom');
  const circle = getChatCircleRecord(store, activeChatId).circle;
  let allowOwnerPrivate = false;
  if (!isGroup) {
    if (input.includeOwnerMemory === true) {
      allowOwnerPrivate = true;
    } else if (input.includeOwnerMemory === false) {
      allowOwnerPrivate = false;
    } else if (input.ownerPreview === true) {
      allowOwnerPrivate = true;
    }
  }
  return {
    activeChatId,
    isGroup,
    circle,
    allowOwnerPrivate,
    version: getMemoryVersion(store),
  };
}

export function selectDrawerMemories(
  store: PersonaDb,
  personaId: string,
  input: DynamicPersonaCardInput,
  access: CardAccessContext,
  limit: number,
  rankFoundationFn: (rows: PersonaMemoryRecord[], queryText?: string) => PersonaMemoryRecord[],
): { foundationMemories: PersonaMemoryRecord[]; recentMemories: PersonaMemoryRecord[] } {
  const cols =
    'id, persona_id, scope, event_seq, note, quote, at, source_key, category, subject_wxid, speaker_wxid, visibility, audience_tag, edited_at, revoked_at, metadata';

  let recentMemories: PersonaMemoryRecord[] = [];
  if (limit > 0) {
    const rawRows = store.db
      .prepare(
        `SELECT ${cols}
         FROM persona_memory
         WHERE persona_id = ?
           AND revoked_at IS NULL
           AND (source_key IS NULL OR source_key NOT LIKE 'foundation:%' OR visibility != 'owner_private')
         ORDER BY at DESC, id DESC`,
      )
      .all(personaId) as unknown as PersonaMemoryFullRow[];

    const circleCache = new Map<string, ChatCircle>();
    const resolveScopeCircle = (scope: string): ChatCircle => {
      const cid = normalizeChatId(scope);
      if (!cid) return 'external';
      const cached = circleCache.get(cid);
      if (cached) return cached;
      const val = getChatCircleRecord(store, cid).circle;
      circleCache.set(cid, val);
      return val;
    };

    const allowed: PersonaMemoryRecord[] = [];
    for (const row of rawRows) {
      const rec = rowToFullMemoryRecord(row);
      const recordRoomChatId = normalizeChatId(rec.scope);
      const recordCircle: ChatCircle =
        rec.audienceTag === 'family' || rec.audienceTag === 'work' || rec.audienceTag === 'external'
          ? rec.audienceTag
          : resolveScopeCircle(rec.scope);
      const isSameExactScope = Boolean(input.scope && rec.scope === input.scope);
      const ok =
        rec.visibility === 'room'
          ? isSameExactScope ||
            isDrawerRecordAllowed({
              recordVisibility: rec.visibility,
              recordCircle,
              recordRoomChatId,
              recordSubjectWxid: rec.subjectWxid,
              activeChatId: access.activeChatId,
              activeCircle: access.circle,
              isGroupChat: access.isGroup,
              allowOwnerPrivate: access.allowOwnerPrivate,
            })
          : isDrawerRecordAllowed({
              recordVisibility: rec.visibility,
              recordCircle,
              recordRoomChatId,
              recordSubjectWxid: rec.subjectWxid,
              activeChatId: access.activeChatId,
              activeCircle: access.circle,
              isGroupChat: access.isGroup,
              allowOwnerPrivate: access.allowOwnerPrivate,
            });
      if (ok) {
        allowed.push(rec);
        if (allowed.length >= limit) break;
      }
    }
    recentMemories = allowed.reverse();
  }

  let foundationMemories: PersonaMemoryRecord[] = [];
  if (access.allowOwnerPrivate && !access.isGroup) {
    const ownerId = input.ownerId?.trim();
    let fRows: PersonaMemoryFullRow[] = [];
    if (ownerId) {
      fRows = store.db
        .prepare(
          `SELECT ${cols}
           FROM persona_memory
           WHERE persona_id = ? AND scope = ? AND source_key LIKE 'foundation:%' AND visibility = 'owner_private' AND revoked_at IS NULL
           ORDER BY id ASC`,
        )
        .all(personaId, `${OWNER_SCOPE_PREFIX}${ownerId}`) as unknown as PersonaMemoryFullRow[];
    } else if (input.ownerPreview === true) {
      fRows = store.db
        .prepare(
          `SELECT ${cols}
           FROM persona_memory
           WHERE persona_id = ? AND scope LIKE 'owner:%' AND source_key LIKE 'foundation:%' AND visibility = 'owner_private' AND revoked_at IS NULL
           ORDER BY id ASC`,
        )
        .all(personaId) as unknown as PersonaMemoryFullRow[];
    } else if (access.activeChatId) {
      fRows = store.db
        .prepare(
          `SELECT ${cols}
           FROM persona_memory
           WHERE persona_id = ? AND scope = ? AND source_key LIKE 'foundation:%' AND visibility = 'owner_private' AND revoked_at IS NULL
           ORDER BY id ASC`,
        )
        .all(personaId, `${OWNER_SCOPE_PREFIX}${access.activeChatId}`) as unknown as PersonaMemoryFullRow[];
    }
    foundationMemories = rankFoundationFn(fRows.map(rowToFullMemoryRecord), input.queryText);
  }

  return { foundationMemories, recentMemories };
}
