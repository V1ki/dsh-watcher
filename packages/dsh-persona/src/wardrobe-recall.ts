import type {
  EventFactRecord,
  MultimodalRecallCardHit,
  MultimodalRecallFactHit,
  MultimodalRecallInput,
  MultimodalRecallResult,
  PersonaDb,
  ReferenceCardRecord,
} from './contracts.js';
import {
  buildFtsMatchQuery,
  computeDhashHammingDistance,
  isDrawerRecordAllowed,
  normalizeChatId,
  normalizeHexDhash,
} from './multimodal.js';
import { getChatCircleRecord, getMemoryVersion } from './wardrobe-policy.js';
import { rowToEventFact, rowToReferenceCard } from './wardrobe-multimodal.js';

const DEFAULT_MAX_HAMMING_DISTANCE = 10;
const DEFAULT_LIMIT_CARDS = 5;
const DEFAULT_LIMIT_FACTS = 8;

export function recallMultimodalOp(
  store: PersonaDb,
  input: MultimodalRecallInput,
): MultimodalRecallResult {
  const chatId = normalizeChatId(input.chatId);
  const isGroup = input.isGroup === true || chatId.endsWith('@chatroom');
  const circle = getChatCircleRecord(store, chatId).circle;
  const allowOwnerPrivate = !isGroup && input.includeOwnerMemory === true;
  const version = getMemoryVersion(store);
  const senderWxid = (input.senderWxid ?? '').trim();
  const queryDhash = normalizeHexDhash(input.dhash);
  const maxHamming =
    typeof input.maxHammingDistance === 'number' && Number.isFinite(input.maxHammingDistance)
      ? Math.max(0, Math.trunc(input.maxHammingDistance))
      : DEFAULT_MAX_HAMMING_DISTANCE;
  const limitCards = Math.max(0, Math.min(20, Math.trunc(input.limitCards ?? DEFAULT_LIMIT_CARDS)));
  const limitFacts = Math.max(0, Math.min(30, Math.trunc(input.limitFacts ?? DEFAULT_LIMIT_FACTS)));

  const matchQuery = buildFtsMatchQuery([input.queryText, input.tags]);

  const ftsCardIds = new Set<string>();
  if (matchQuery) {
    try {
      const ftsRows = store.db
        .prepare('SELECT card_id FROM reference_card_fts WHERE reference_card_fts MATCH ? LIMIT 64')
        .all(matchQuery) as Array<{ card_id: string }>;
      for (const r of ftsRows) ftsCardIds.add(r.card_id);
    } catch {
    }
  }

  const cardRows = store.db
    .prepare('SELECT * FROM reference_card WHERE revoked_at IS NULL')
    .all() as Array<Record<string, unknown>>;

  const cardHits: MultimodalRecallCardHit[] = [];
  for (const row of cardRows) {
    const card: ReferenceCardRecord = rowToReferenceCard(row);
    if (
      !allowOwnerPrivate &&
      circle === 'external' &&
      (card.circle === 'family' || card.circle === 'work')
    ) {
      continue;
    }
    const allowed = isDrawerRecordAllowed({
      recordVisibility: card.visibility,
      recordCircle: card.circle,
      recordRoomChatId: card.roomChatId,
      recordSubjectWxid: card.subjectWxid,
      activeChatId: chatId,
      activeCircle: circle,
      isGroupChat: isGroup,
      allowOwnerPrivate,
    });
    if (!allowed) continue;

    const matchedBy: Array<'fts' | 'dhash' | 'sender'> = [];
    let score = 0;
    let hammingDistance: number | null = null;

    if (ftsCardIds.has(card.id)) {
      matchedBy.push('fts');
      score += 2;
    }
    if (queryDhash && card.dhash) {
      const dist = computeDhashHammingDistance(queryDhash, card.dhash);
      if (dist !== null && dist <= maxHamming) {
        hammingDistance = dist;
        matchedBy.push('dhash');
        score += 3 + (maxHamming - dist) / Math.max(1, maxHamming);
      }
    }
    if (senderWxid && card.subjectWxid && card.subjectWxid === senderWxid) {
      matchedBy.push('sender');
      score += 1.5;
    }

    if (matchedBy.length > 0) {
      cardHits.push({ card, score, hammingDistance, matchedBy });
    }
  }

  cardHits.sort(
    (a, b) =>
      b.score - a.score ||
      b.card.qualityScore - a.card.qualityScore ||
      b.card.updatedAt - a.card.updatedAt,
  );
  const selectedCards = cardHits.slice(0, limitCards);

  const entityTerms = new Set<string>();
  for (const hit of selectedCards) {
    if (hit.card.entityName) entityTerms.add(hit.card.entityName.toLowerCase());
    for (const alias of hit.card.aliases) {
      if (alias) entityTerms.add(alias.toLowerCase());
    }
  }

  const ftsFactIds = new Set<string>();
  if (matchQuery) {
    try {
      const ftsRows = store.db
        .prepare('SELECT fact_id FROM event_fact_fts WHERE event_fact_fts MATCH ? LIMIT 64')
        .all(matchQuery) as Array<{ fact_id: string }>;
      for (const r of ftsRows) ftsFactIds.add(r.fact_id);
    } catch {
    }
  }

  const factRows = store.db
    .prepare("SELECT * FROM event_fact WHERE revoked_at IS NULL AND status = 'confirmed'")
    .all() as Array<Record<string, unknown>>;

  const factHits: MultimodalRecallFactHit[] = [];
  for (const row of factRows) {
    const fact: EventFactRecord = rowToEventFact(row);
    if (
      !allowOwnerPrivate &&
      circle === 'external' &&
      (fact.circle === 'family' || fact.circle === 'work')
    ) {
      continue;
    }
    const allowed = isDrawerRecordAllowed({
      recordVisibility: fact.visibility,
      recordCircle: fact.circle,
      recordRoomChatId: fact.roomChatId,
      recordSubjectWxid: fact.subjectWxid,
      activeChatId: chatId,
      activeCircle: circle,
      isGroupChat: isGroup,
      allowOwnerPrivate,
    });
    if (!allowed) continue;

    const matchedBy: Array<'fts' | 'sender' | 'entity'> = [];
    let score = 0;

    if (ftsFactIds.has(fact.id)) {
      matchedBy.push('fts');
      score += 2;
    }
    if (senderWxid && fact.subjectWxid && fact.subjectWxid === senderWxid) {
      matchedBy.push('sender');
      score += 1.5;
    }
    if (entityTerms.size > 0) {
      const haystack = `${fact.subjectName} ${fact.objectName} ${fact.statement} ${fact.tags.join(' ')}`.toLowerCase();
      for (const term of entityTerms) {
        if (haystack.includes(term)) {
          matchedBy.push('entity');
          score += 1.5;
          break;
        }
      }
    }

    if (matchedBy.length > 0) {
      factHits.push({ fact, score, matchedBy });
    }
  }

  factHits.sort(
    (a, b) =>
      b.score - a.score ||
      b.fact.confidence - a.fact.confidence ||
      b.fact.updatedAt - a.fact.updatedAt,
  );

  return {
    chatId,
    circle,
    version,
    cards: selectedCards,
    facts: factHits.slice(0, limitFacts),
  };
}
