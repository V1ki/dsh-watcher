import type {
  AudienceTag,
  ChatCircle,
  MemoryVisibility,
  PromotionEvidenceType,
} from './contracts.js';

export class MultimodalEvidenceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'MultimodalEvidenceError';
    this.code = code;
  }
}

export const VALID_CHAT_CIRCLES = new Set<ChatCircle>(['family', 'work', 'external']);

export const VALID_MEMORY_VISIBILITIES = new Set<MemoryVisibility>([
  'room',
  'circle',
  'dm_only',
  'owner_private',
]);

export const VALID_AUDIENCE_TAGS = new Set<AudienceTag>(['', 'family', 'work', 'external']);

export const VALID_PROMOTION_EVIDENCE_TYPES = new Set<PromotionEvidenceType>([
  'text',
  'voice',
  'owner_confirmed',
]);

export function normalizeChatId(raw: string | null | undefined): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('wechat:')) return trimmed.slice('wechat:'.length).trim();
  if (trimmed.startsWith('text:')) return trimmed.slice('text:'.length).trim();
  if (trimmed.startsWith('sns:')) return trimmed.slice('sns:'.length).trim();
  return trimmed;
}

export function buildChatCircleLookupKeys(raw: string | null | undefined): string[] {
  const normalized = normalizeChatId(raw);
  if (!normalized) return [];
  if (normalized.startsWith('wxarc:')) {
    const bare = normalizeChatId(normalized.slice('wxarc:'.length));
    return bare && bare !== normalized ? [normalized, bare] : [normalized];
  }
  if (!normalized.includes(':')) {
    return [normalized, `wxarc:${normalized}`];
  }
  return [normalized];
}

export function isSameChatId(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const keysA = buildChatCircleLookupKeys(a);
  const keysB = buildChatCircleLookupKeys(b);
  if (keysA.length === 0 || keysB.length === 0) return false;
  for (const ka of keysA) {
    if (keysB.includes(ka)) return true;
  }
  return false;
}

export function isGroupChatId(chatId: string, scope?: string, explicit?: boolean): boolean {
  if (explicit === true) return true;
  if (explicit === false) return false;
  const normalized = normalizeChatId(chatId);
  if (normalized.endsWith('@chatroom')) return true;
  if (scope && normalizeChatId(scope).endsWith('@chatroom')) return true;
  return false;
}

export function extractSearchTokens(text: string): string[] {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return [];
  const tokens = new Set<string>();
  const cjkRuns = normalized.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const run of cjkRuns) {
    if (run.length === 1) {
      tokens.add(run);
      continue;
    }
    tokens.add(run);
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

export function buildFtsIndexDocument(parts: Array<string | string[] | undefined>): string {
  const tokens = new Set<string>();
  for (const part of parts) {
    if (!part) continue;
    const values = Array.isArray(part) ? part : [part];
    for (const val of values) {
      if (typeof val !== 'string' || !val.trim()) continue;
      for (const tok of extractSearchTokens(val)) {
        tokens.add(tok);
      }
    }
  }
  return Array.from(tokens).join(' ');
}

export function buildFtsMatchQuery(parts: Array<string | string[] | undefined>): string | null {
  const tokens = new Set<string>();
  for (const part of parts) {
    if (!part) continue;
    const values = Array.isArray(part) ? part : [part];
    for (const val of values) {
      if (typeof val !== 'string' || !val.trim()) continue;
      for (const tok of extractSearchTokens(val)) {
        const clean = tok.replace(/[^a-z0-9_\u4e00-\u9fff]/g, '');
        if (clean) tokens.add(clean);
      }
    }
  }
  if (tokens.size === 0) return null;
  return Array.from(tokens)
    .slice(0, 32)
    .map((tok) => `"${tok}"`)
    .join(' OR ');
}

export function normalizeHexDhash(raw: string | null | undefined): string {
  if (!raw) return '';
  const cleaned = raw.trim().toLowerCase().replace(/^0x/, '');
  if (!cleaned || !/^[0-9a-f]+$/.test(cleaned)) return '';
  return cleaned;
}

const POPCOUNT_4BIT = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

export function computeDhashHammingDistance(a: string, b: string): number | null {
  const left = normalizeHexDhash(a);
  const right = normalizeHexDhash(b);
  if (!left || !right || left.length !== right.length) {
    return null;
  }
  let distance = 0;
  for (let i = 0; i < left.length; i += 1) {
    const xor = Number.parseInt(left[i]!, 16) ^ Number.parseInt(right[i]!, 16);
    distance += POPCOUNT_4BIT[xor] ?? 0;
  }
  return distance;
}

export function isDrawerRecordAllowed(params: {
  recordVisibility: MemoryVisibility;
  recordCircle: ChatCircle;
  recordRoomChatId: string;
  recordSubjectWxid: string;
  activeChatId: string;
  activeCircle: ChatCircle;
  isGroupChat: boolean;
  allowOwnerPrivate: boolean;
}): boolean {
  const {
    recordVisibility,
    recordCircle,
    recordRoomChatId,
    recordSubjectWxid,
    activeChatId,
    activeCircle,
    isGroupChat,
    allowOwnerPrivate,
  } = params;

  if (recordVisibility === 'owner_private') {
    return allowOwnerPrivate && !isGroupChat;
  }
  if (recordVisibility === 'dm_only') {
    if (isGroupChat) return false;
    if (!activeChatId) return false;
    return (
      isSameChatId(recordRoomChatId, activeChatId) ||
      (recordSubjectWxid !== '' && isSameChatId(recordSubjectWxid, activeChatId))
    );
  }
  if (recordVisibility === 'room') {
    if (!activeChatId) return false;
    return isSameChatId(recordRoomChatId, activeChatId);
  }
  if (recordVisibility === 'circle') {
    if (allowOwnerPrivate && !isGroupChat) {
      return recordCircle === 'family' || recordCircle === 'work';
    }
    if (activeCircle !== 'family' && activeCircle !== 'work') {
      return false;
    }
    return recordCircle === activeCircle;
  }
  return false;
}
