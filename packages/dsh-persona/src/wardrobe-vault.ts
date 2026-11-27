import type {
  EventFactRecord,
  PersonaDb,
  PersonaMemoryRecord,
  ReferenceCardRecord,
  VaultKnowledgeContextEntry,
  VaultKnowledgeContextOptions,
  VaultKnowledgeContextResult,
  VaultKnowledgeHit,
  VaultKnowledgeSearchQuery,
  VaultVisibility,
} from './contracts.js';
import { buildFtsMatchQuery, extractSearchTokens } from './multimodal.js';
import { listEvidenceOp, rowToEventFact, rowToReferenceCard } from './wardrobe-multimodal.js';
import {
  type PersonaMemoryFullRow,
  getChatCircleRecord,
  resolveRecordVaultVisibility,
  rowToFullMemoryRecord,
} from './wardrobe-policy.js';

const MAX_VAULT_SNIPPET_LENGTH = 220;
const DEFAULT_VAULT_SEARCH_LIMIT = 10;
const MAX_VAULT_SEARCH_LIMIT = 50;
const DEFAULT_CONTEXT_WINDOW = 5;
const MAX_CONTEXT_WINDOW = 15;

const MEMORY_COLS =
  'id, persona_id, scope, event_seq, note, quote, at, source_key, category, subject_wxid, speaker_wxid, visibility, audience_tag, edited_at, revoked_at, metadata';

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function toIsoTimestamp(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  return new Date(safe).toISOString();
}

function parseTimestampFilter(raw: string | undefined): number | null {
  if (!raw || !raw.trim()) return null;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const parsedNum = Number(trimmed);
    return Number.isFinite(parsedNum) ? parsedNum : null;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatCompactSnippet(raw: string, maxLen = MAX_VAULT_SNIPPET_LENGTH): string {
  const compact = raw.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLen) return compact;
  return `${compact.slice(0, maxLen - 1)}…`;
}

function computeTextMatchScore(
  queryText: string,
  tokens: string[],
  primaryText: string,
  secondaryText: string,
): number {
  if (!queryText) return 1;
  const primary = primaryText.toLowerCase();
  const secondary = secondaryText.toLowerCase();
  const lowerQuery = queryText.toLowerCase();
  let score = 0;
  if (primary.includes(lowerQuery)) {
    score += 4;
  } else if (secondary.includes(lowerQuery)) {
    score += 2.5;
  }
  for (const token of tokens) {
    if (primary.includes(token)) {
      score += 2;
    } else if (secondary.includes(token)) {
      score += 1;
    }
  }
  return score;
}

function matchesPersonFilter(personLower: string, fields: Array<string | undefined>): boolean {
  if (!personLower) return true;
  for (const field of fields) {
    if (field && field.toLowerCase().includes(personLower)) {
      return true;
    }
  }
  return false;
}

function matchesTimeWindow(tsMs: number, sinceMs: number | null, untilMs: number | null): boolean {
  if (sinceMs !== null && tsMs < sinceMs) return false;
  if (untilMs !== null && tsMs > untilMs) return false;
  return true;
}

function resolveFoundationAuthor(rec: PersonaMemoryRecord): string | undefined {
  if (typeof rec.metadata.speaker === 'string' && rec.metadata.speaker.trim()) {
    return rec.metadata.speaker.trim();
  }
  if (rec.speakerWxid.trim()) return rec.speakerWxid.trim();
  if (rec.subjectWxid.trim()) return rec.subjectWxid.trim();
  return undefined;
}

function formatFoundationSnippet(rec: PersonaMemoryRecord): string {
  const title =
    typeof rec.metadata.title === 'string' && rec.metadata.title.trim()
      ? `${rec.metadata.title.trim()}: `
      : '';
  const quotePart = rec.quote.trim() ? ` ("${rec.quote.trim()}")` : '';
  return formatCompactSnippet(`[${rec.category}] ${title}${rec.note.trim()}${quotePart}`);
}

function formatEventFactSnippet(fact: EventFactRecord): string {
  const prefix = fact.subjectName.trim() ? `${fact.subjectName.trim()} ` : '';
  const base = fact.statement.trim() || `${prefix}${fact.predicate} ${fact.objectName}`.trim();
  const tagPart = fact.tags.length > 0 ? ` [${fact.tags.join(', ')}]` : '';
  return formatCompactSnippet(`${base}${tagPart}`);
}

function formatReferenceCardSnippet(card: ReferenceCardRecord): string {
  const aliases = card.aliases.length > 0 ? ` (${card.aliases.join(' / ')})` : '';
  const desc = card.description.trim() ? `: ${card.description.trim()}` : '';
  const tags = card.tags.length > 0 ? ` [${card.tags.join(', ')}]` : '';
  return formatCompactSnippet(`[${card.entityType}] ${card.entityName}${aliases}${desc}${tags}`);
}

function resolveRoomName(store: PersonaDb, roomKey: string | undefined): string | undefined {
  if (!roomKey) return undefined;
  const label = getChatCircleRecord(store, roomKey).label.trim();
  return label || undefined;
}

export function searchVaultKnowledgeOp(
  store: PersonaDb,
  query: VaultKnowledgeSearchQuery,
): VaultKnowledgeHit[] {
  if (!Array.isArray(query.allowedCircles) || query.allowedCircles.length === 0) {
    return [];
  }
  const allowedSet = new Set<VaultVisibility>(query.allowedCircles);
  const limit = clampInt(query.limit, DEFAULT_VAULT_SEARCH_LIMIT, 0, MAX_VAULT_SEARCH_LIMIT);
  if (limit === 0) return [];

  const queryText = (query.query ?? '').trim();
  const tokens = extractSearchTokens(queryText);
  const personLower = (query.person ?? '').trim().toLowerCase();
  const sinceMs = parseTimestampFilter(query.since);
  const untilMs = parseTimestampFilter(query.until);
  const ftsQuery = queryText ? buildFtsMatchQuery([queryText]) : null;

  const candidates: Array<{ hit: VaultKnowledgeHit; occurredAtMs: number }> = [];

  if (allowedSet.has('owner_private')) {
    const fRows = store.db
      .prepare(
        `SELECT ${MEMORY_COLS}
         FROM persona_memory
         WHERE source_key LIKE 'foundation:%' AND revoked_at IS NULL
         ORDER BY at DESC, id DESC`,
      )
      .all() as unknown as PersonaMemoryFullRow[];

    for (const row of fRows) {
      const rec = rowToFullMemoryRecord(row);
      if (!rec.note.trim()) continue;
      if (!matchesTimeWindow(rec.at, sinceMs, untilMs)) continue;

      const title = typeof rec.metadata.title === 'string' ? rec.metadata.title : '';
      const caveat = typeof rec.metadata.caveat === 'string' ? rec.metadata.caveat : '';
      const tags = Array.isArray(rec.metadata.tags)
        ? rec.metadata.tags.map((item) => String(item))
        : [];
      const author = resolveFoundationAuthor(rec);

      if (
        !matchesPersonFilter(personLower, [
          author,
          rec.speakerWxid,
          rec.subjectWxid,
          title,
          rec.note,
          rec.quote,
          ...tags,
        ])
      ) {
        continue;
      }

      const score = computeTextMatchScore(
        queryText,
        tokens,
        `${title} ${tags.join(' ')} ${rec.category}`,
        `${rec.note} ${rec.quote} ${caveat} ${author ?? ''}`,
      );
      if (queryText && score <= 0) continue;

      candidates.push({
        occurredAtMs: rec.at,
        hit: {
          source: 'persona',
          itemId: `foundation:${rec.id}`,
          kind: 'foundation',
          circle: 'owner_private',
          author,
          occurredAt: toIsoTimestamp(rec.at),
          snippet: formatFoundationSnippet(rec),
          score,
        },
      });
    }
  }

  const ftsFactIds = new Set<string>();
  if (ftsQuery) {
    try {
      const rows = store.db
        .prepare('SELECT fact_id FROM event_fact_fts WHERE event_fact_fts MATCH ? LIMIT 64')
        .all(ftsQuery) as Array<{ fact_id: string }>;
      for (const r of rows) ftsFactIds.add(r.fact_id);
    } catch {
    }
  }

  const factRows = store.db
    .prepare(
      "SELECT * FROM event_fact WHERE revoked_at IS NULL AND status = 'confirmed' ORDER BY updated_at DESC, id DESC",
    )
    .all() as Array<Record<string, unknown>>;

  for (const row of factRows) {
    const fact = rowToEventFact(row);
    const circle = resolveRecordVaultVisibility(store, {
      visibility: fact.visibility,
      circle: fact.circle,
      roomChatId: fact.roomChatId,
    });
    if (!allowedSet.has(circle)) continue;

    const occurredAtMs = fact.updatedAt || fact.createdAt;
    if (!matchesTimeWindow(occurredAtMs, sinceMs, untilMs)) continue;

    const author = fact.subjectName.trim() || fact.subjectWxid.trim() || undefined;
    if (
      !matchesPersonFilter(personLower, [
        fact.subjectName,
        fact.subjectWxid,
        fact.objectName,
        fact.statement,
        ...fact.tags,
      ])
    ) {
      continue;
    }

    let score = computeTextMatchScore(
      queryText,
      tokens,
      `${fact.subjectName} ${fact.objectName} ${fact.predicate} ${fact.tags.join(' ')}`,
      `${fact.statement} ${fact.subjectWxid}`,
    );
    if (ftsFactIds.has(fact.id)) {
      score += 2;
    }
    if (queryText && score <= 0) continue;

    const roomKey = fact.roomChatId.trim() || undefined;
    const roomName = resolveRoomName(store, roomKey);

    candidates.push({
      occurredAtMs,
      hit: {
        source: 'persona',
        itemId: `fact:${fact.id}`,
        kind: 'event_fact',
        circle,
        ...(roomKey ? { roomKey } : {}),
        ...(roomName ? { roomName } : {}),
        ...(author ? { author } : {}),
        occurredAt: toIsoTimestamp(occurredAtMs),
        snippet: formatEventFactSnippet(fact),
        score,
      },
    });
  }

  const ftsCardIds = new Set<string>();
  if (ftsQuery) {
    try {
      const rows = store.db
        .prepare('SELECT card_id FROM reference_card_fts WHERE reference_card_fts MATCH ? LIMIT 64')
        .all(ftsQuery) as Array<{ card_id: string }>;
      for (const r of rows) ftsCardIds.add(r.card_id);
    } catch {
    }
  }

  const cardRows = store.db
    .prepare('SELECT * FROM reference_card WHERE revoked_at IS NULL ORDER BY updated_at DESC, id DESC')
    .all() as Array<Record<string, unknown>>;

  for (const row of cardRows) {
    const card = rowToReferenceCard(row);
    const circle = resolveRecordVaultVisibility(store, {
      visibility: card.visibility,
      circle: card.circle,
      roomChatId: card.roomChatId,
    });
    if (!allowedSet.has(circle)) continue;

    const occurredAtMs = card.updatedAt || card.createdAt;
    if (!matchesTimeWindow(occurredAtMs, sinceMs, untilMs)) continue;

    const author = card.entityName.trim() || card.subjectWxid.trim() || undefined;
    if (
      !matchesPersonFilter(personLower, [
        card.entityName,
        ...card.aliases,
        card.subjectWxid,
        card.description,
        ...card.tags,
      ])
    ) {
      continue;
    }

    let score = computeTextMatchScore(
      queryText,
      tokens,
      `${card.entityName} ${card.aliases.join(' ')} ${card.tags.join(' ')} ${card.entityType}`,
      `${card.description} ${card.subjectWxid}`,
    );
    if (ftsCardIds.has(card.id)) {
      score += 2;
    }
    if (queryText && score <= 0) continue;

    const roomKey = card.roomChatId.trim() || undefined;
    const roomName = resolveRoomName(store, roomKey);

    candidates.push({
      occurredAtMs,
      hit: {
        source: 'persona',
        itemId: `card:${card.id}`,
        kind: 'reference_card',
        circle,
        ...(roomKey ? { roomKey } : {}),
        ...(roomName ? { roomName } : {}),
        ...(author ? { author } : {}),
        occurredAt: toIsoTimestamp(occurredAtMs),
        snippet: formatReferenceCardSnippet(card),
        score,
      },
    });
  }

  candidates.sort(
    (a, b) =>
      b.hit.score - a.hit.score ||
      b.occurredAtMs - a.occurredAtMs ||
      a.hit.itemId.localeCompare(b.hit.itemId),
  );

  return candidates.slice(0, limit).map((entry) => entry.hit);
}

function isNeighborCirclePermitted(
  neighborCircle: VaultVisibility,
  anchorCircle: VaultVisibility,
  allowedSet: Set<VaultVisibility> | null,
): boolean {
  if (allowedSet !== null) {
    return allowedSet.has(neighborCircle);
  }
  return neighborCircle === anchorCircle;
}

function buildFoundationContext(
  store: PersonaDb,
  memoryId: number,
  beforeLimit: number,
  afterLimit: number,
  allowedSet: Set<VaultVisibility> | null,
): VaultKnowledgeContextResult | null {
  if (allowedSet !== null && !allowedSet.has('owner_private')) {
    return null;
  }
  const row = store.db
    .prepare(
      `SELECT ${MEMORY_COLS}
       FROM persona_memory
       WHERE id = ? AND source_key LIKE 'foundation:%' AND revoked_at IS NULL`,
    )
    .get(memoryId) as unknown as PersonaMemoryFullRow | undefined;
  if (!row) return null;

  const rec = rowToFullMemoryRecord(row);
  const allRows = store.db
    .prepare(
      `SELECT ${MEMORY_COLS}
       FROM persona_memory
       WHERE persona_id = ? AND source_key LIKE 'foundation:%' AND revoked_at IS NULL
       ORDER BY at ASC, id ASC`,
    )
    .all(rec.personaId) as unknown as PersonaMemoryFullRow[];

  const records = allRows.map(rowToFullMemoryRecord).filter((item) => item.note.trim().length > 0);
  const idx = records.findIndex((item) => item.id === rec.id);
  const beforeSlice = idx > 0 ? records.slice(Math.max(0, idx - beforeLimit), idx) : [];
  const afterSlice = idx >= 0 ? records.slice(idx + 1, idx + 1 + afterLimit) : [];

  const toEntry = (item: PersonaMemoryRecord): VaultKnowledgeContextEntry => ({
    itemId: `foundation:${item.id}`,
    kind: 'foundation',
    circle: 'owner_private',
    author: resolveFoundationAuthor(item),
    occurredAt: toIsoTimestamp(item.at),
    text: formatFoundationSnippet(item),
  });

  const title =
    typeof rec.metadata.title === 'string' && rec.metadata.title.trim()
      ? rec.metadata.title.trim()
      : undefined;
  const caveat =
    typeof rec.metadata.caveat === 'string' && rec.metadata.caveat.trim()
      ? `\n注意: ${rec.metadata.caveat.trim()}`
      : '';

  return {
    source: 'persona',
    itemId: `foundation:${rec.id}`,
    kind: 'foundation',
    circle: 'owner_private',
    author: resolveFoundationAuthor(rec),
    occurredAt: toIsoTimestamp(rec.at),
    ...(title ? { title } : {}),
    content: `${rec.note.trim()}${caveat}`,
    ...(rec.quote.trim() ? { quote: rec.quote.trim() } : {}),
    metadata: {
      personaId: rec.personaId,
      category: rec.category,
      sourceKey: rec.sourceKey,
      ...(Array.isArray(rec.metadata.tags) ? { tags: rec.metadata.tags } : {}),
      ...(Array.isArray(rec.metadata.source_ids) ? { sourceIds: rec.metadata.source_ids } : {}),
      ...(Array.isArray(rec.metadata.evidence) ? { evidence: rec.metadata.evidence } : {}),
    },
    before: beforeSlice.map(toEntry),
    after: afterSlice.map(toEntry),
  };
}

function buildEventFactContext(
  store: PersonaDb,
  factId: string,
  beforeLimit: number,
  afterLimit: number,
  allowedSet: Set<VaultVisibility> | null,
): VaultKnowledgeContextResult | null {
  const row = store.db
    .prepare("SELECT * FROM event_fact WHERE id = ? AND revoked_at IS NULL AND status = 'confirmed'")
    .get(factId) as Record<string, unknown> | undefined;
  if (!row) return null;

  const fact = rowToEventFact(row);
  const circle = resolveRecordVaultVisibility(store, {
    visibility: fact.visibility,
    circle: fact.circle,
    roomChatId: fact.roomChatId,
  });
  if (allowedSet !== null && !allowedSet.has(circle)) {
    return null;
  }

  const evidence = listEvidenceOp(store, 'event_fact', fact.id);
  const peerRows = fact.roomChatId
    ? (store.db
        .prepare(
          "SELECT * FROM event_fact WHERE room_chat_id = ? AND revoked_at IS NULL AND status = 'confirmed' ORDER BY created_at ASC, id ASC",
        )
        .all(fact.roomChatId) as Array<Record<string, unknown>>)
    : (store.db
        .prepare(
          "SELECT * FROM event_fact WHERE room_chat_id = '' AND circle = ? AND revoked_at IS NULL AND status = 'confirmed' ORDER BY created_at ASC, id ASC",
        )
        .all(fact.circle) as Array<Record<string, unknown>>);

  const permittedPeers: Array<{ fact: EventFactRecord; circle: VaultVisibility }> = [];
  for (const pRow of peerRows) {
    const peer = rowToEventFact(pRow);
    const peerCircle = resolveRecordVaultVisibility(store, {
      visibility: peer.visibility,
      circle: peer.circle,
      roomChatId: peer.roomChatId,
    });
    if (peer.id === fact.id || isNeighborCirclePermitted(peerCircle, circle, allowedSet)) {
      permittedPeers.push({ fact: peer, circle: peerCircle });
    }
  }

  const idx = permittedPeers.findIndex((item) => item.fact.id === fact.id);
  const beforeSlice = idx > 0 ? permittedPeers.slice(Math.max(0, idx - beforeLimit), idx) : [];
  const afterSlice = idx >= 0 ? permittedPeers.slice(idx + 1, idx + 1 + afterLimit) : [];

  const toEntry = (item: { fact: EventFactRecord; circle: VaultVisibility }): VaultKnowledgeContextEntry => ({
    itemId: `fact:${item.fact.id}`,
    kind: 'event_fact',
    circle: item.circle,
    author: item.fact.subjectName.trim() || item.fact.subjectWxid.trim() || undefined,
    occurredAt: toIsoTimestamp(item.fact.updatedAt || item.fact.createdAt),
    text: formatEventFactSnippet(item.fact),
  });

  const roomKey = fact.roomChatId.trim() || undefined;
  const roomName = resolveRoomName(store, roomKey);
  const author = fact.subjectName.trim() || fact.subjectWxid.trim() || undefined;
  const firstExcerpt = evidence.find((ev) => ev.excerpt.trim())?.excerpt.trim();

  return {
    source: 'persona',
    itemId: `fact:${fact.id}`,
    kind: 'event_fact',
    circle,
    ...(roomKey ? { roomKey } : {}),
    ...(roomName ? { roomName } : {}),
    ...(author ? { author } : {}),
    occurredAt: toIsoTimestamp(fact.updatedAt || fact.createdAt),
    title: `${fact.predicate}: ${fact.objectName}`,
    content: fact.statement,
    ...(firstExcerpt ? { quote: firstExcerpt } : {}),
    metadata: {
      subjectWxid: fact.subjectWxid,
      subjectName: fact.subjectName,
      predicate: fact.predicate,
      objectName: fact.objectName,
      tags: fact.tags,
      evidenceType: fact.evidenceType,
      confidence: fact.confidence,
      evidence,
    },
    before: beforeSlice.map(toEntry),
    after: afterSlice.map(toEntry),
  };
}

function buildReferenceCardContext(
  store: PersonaDb,
  cardId: string,
  beforeLimit: number,
  afterLimit: number,
  allowedSet: Set<VaultVisibility> | null,
): VaultKnowledgeContextResult | null {
  const row = store.db
    .prepare('SELECT * FROM reference_card WHERE id = ? AND revoked_at IS NULL')
    .get(cardId) as Record<string, unknown> | undefined;
  if (!row) return null;

  const card = rowToReferenceCard(row);
  const circle = resolveRecordVaultVisibility(store, {
    visibility: card.visibility,
    circle: card.circle,
    roomChatId: card.roomChatId,
  });
  if (allowedSet !== null && !allowedSet.has(circle)) {
    return null;
  }

  const terms = [card.entityName, ...card.aliases]
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean);
  const factRows = store.db
    .prepare(
      "SELECT * FROM event_fact WHERE revoked_at IS NULL AND status = 'confirmed' ORDER BY created_at ASC, id ASC",
    )
    .all() as Array<Record<string, unknown>>;

  const relatedBefore: VaultKnowledgeContextEntry[] = [];
  const relatedAfter: VaultKnowledgeContextEntry[] = [];

  for (const fRow of factRows) {
    const fact = rowToEventFact(fRow);
    const factCircle = resolveRecordVaultVisibility(store, {
      visibility: fact.visibility,
      circle: fact.circle,
      roomChatId: fact.roomChatId,
    });
    if (!isNeighborCirclePermitted(factCircle, circle, allowedSet)) continue;

    const hay = `${fact.subjectName} ${fact.objectName} ${fact.statement} ${fact.tags.join(' ')}`.toLowerCase();
    const matchedSubject = Boolean(card.subjectWxid && fact.subjectWxid === card.subjectWxid);
    const matchedTerm = terms.some((term) => hay.includes(term));
    if (!matchedSubject && !matchedTerm) continue;

    const entry: VaultKnowledgeContextEntry = {
      itemId: `fact:${fact.id}`,
      kind: 'event_fact',
      circle: factCircle,
      author: fact.subjectName.trim() || fact.subjectWxid.trim() || undefined,
      occurredAt: toIsoTimestamp(fact.updatedAt || fact.createdAt),
      text: formatEventFactSnippet(fact),
    };
    if (fact.createdAt <= card.createdAt) {
      relatedBefore.push(entry);
    } else {
      relatedAfter.push(entry);
    }
  }

  const roomKey = card.roomChatId.trim() || undefined;
  const roomName = resolveRoomName(store, roomKey);
  const author = card.entityName.trim() || card.subjectWxid.trim() || undefined;
  const contentParts = [`[${card.entityType}] ${card.entityName}`];
  if (card.aliases.length > 0) contentParts.push(`别名: ${card.aliases.join(', ')}`);
  if (card.description.trim()) contentParts.push(card.description.trim());
  if (card.tags.length > 0) contentParts.push(`标签: ${card.tags.join(', ')}`);

  return {
    source: 'persona',
    itemId: `card:${card.id}`,
    kind: 'reference_card',
    circle,
    ...(roomKey ? { roomKey } : {}),
    ...(roomName ? { roomName } : {}),
    ...(author ? { author } : {}),
    occurredAt: toIsoTimestamp(card.updatedAt || card.createdAt),
    title: card.entityName,
    content: contentParts.join('\n'),
    metadata: {
      entityType: card.entityType,
      aliases: card.aliases,
      subjectWxid: card.subjectWxid,
      tags: card.tags,
      qualityScore: card.qualityScore,
      reviewedBy: card.reviewedBy,
    },
    before: beforeLimit > 0 ? relatedBefore.slice(-beforeLimit) : [],
    after: afterLimit > 0 ? relatedAfter.slice(0, afterLimit) : [],
  };
}

export function getVaultKnowledgeContextOp(
  store: PersonaDb,
  itemId: string,
  opts: VaultKnowledgeContextOptions = {},
): VaultKnowledgeContextResult | null {
  const trimmed = (itemId ?? '').trim();
  if (!trimmed) return null;

  const beforeLimit = clampInt(opts.before, DEFAULT_CONTEXT_WINDOW, 0, MAX_CONTEXT_WINDOW);
  const afterLimit = clampInt(opts.after, DEFAULT_CONTEXT_WINDOW, 0, MAX_CONTEXT_WINDOW);
  const allowedSet = Array.isArray(opts.allowedCircles)
    ? new Set<VaultVisibility>(opts.allowedCircles)
    : null;

  if (trimmed.startsWith('foundation:')) {
    const rawId = trimmed.slice('foundation:'.length).trim();
    const numericId = Number(rawId);
    if (!Number.isInteger(numericId) || numericId <= 0) return null;
    return buildFoundationContext(store, numericId, beforeLimit, afterLimit, allowedSet);
  }
  if (trimmed.startsWith('fact:')) {
    const factId = trimmed.slice('fact:'.length).trim();
    if (!factId) return null;
    return buildEventFactContext(store, factId, beforeLimit, afterLimit, allowedSet);
  }
  if (trimmed.startsWith('card:')) {
    const cardId = trimmed.slice('card:'.length).trim();
    if (!cardId) return null;
    return buildReferenceCardContext(store, cardId, beforeLimit, afterLimit, allowedSet);
  }

  return (
    buildEventFactContext(store, trimmed, beforeLimit, afterLimit, allowedSet) ??
    buildReferenceCardContext(store, trimmed, beforeLimit, afterLimit, allowedSet)
  );
}
