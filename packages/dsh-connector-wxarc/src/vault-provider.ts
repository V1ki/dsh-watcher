import type { DatabaseSync } from 'node:sqlite';
import type {
  PersonaWardrobe,
  TargetDirectoryEntry as HubTargetDirectoryEntry,
  TargetDirectoryListOptions,
  TargetDirectoryProvider,
  TargetDirectoryQuery,
  TargetDirectoryResolution,
  VaultContextEntry,
  VaultContextOptions,
  VaultContextResult,
  VaultProvider,
  VaultScope,
  VaultSearchHit,
  VaultSearchQuery,
  VaultVisibility,
} from '@local/dsh-hub/contracts';
import { messageBody, type WxarcEvent } from './core.js';
import {
  MAX_NAS_SEARCH_LIMIT,
  getNasArchiveContext,
  isDirectNasChatId,
  normalizeNasSessionKey,
  searchNasArchive,
  type NasSearchItem,
} from './nas-search.js';
import {
  listRoomTargets,
  resolveMemoTarget,
  resolveUniqueTarget,
  type TargetDirectoryEntry as LocalTargetDirectoryEntry,
  type TargetDirectorySource,
} from './targets.js';
import type { FetchLike } from './transport.js';

export const VAULT_WXARC_SNIPPET_MAX = 200;
export const VAULT_WXARC_DEFAULT_LIMIT = 10;
export const VAULT_WXARC_MAX_LIMIT = 20;
const VAULT_CONTEXT_DEFAULT_WINDOW = 5;
const VAULT_CONTEXT_MAX_WINDOW = 15;
const WECHAT_SCAN_BATCH = 500;

const VALID_VISIBILITIES = new Set<VaultVisibility>([
  'external',
  'work',
  'family',
  'owner_private',
]);

export interface VaultVisibilityResolverLike {
  resolveVaultVisibility?: (roomKey: string) => VaultVisibility;
}

export interface WechatVaultProviderOptions {
  db: DatabaseSync;
  getWardrobe?: () => VaultVisibilityResolverLike | PersonaWardrobe | null | undefined;
}

export interface NasVaultProviderOptions {
  getConfig: () => { baseUrl?: string; archivePath?: string };
  getWardrobe?: () => VaultVisibilityResolverLike | PersonaWardrobe | null | undefined;
  fetcher?: FetchLike;
  timeoutMs?: number;
}

interface StoredEventRow {
  seq: number;
  payload: string;
  received_at: string;
}

export function compactVaultSnippet(text: string, maxLength = VAULT_WXARC_SNIPPET_MAX): string {
  const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  if (maxLength <= 1) {
    return normalized.slice(0, Math.max(0, maxLength));
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

export function resolveWechatVaultCircle(
  roomKeyOrChatId: string | undefined,
  wardrobe?: VaultVisibilityResolverLike | null,
): VaultVisibility {
  const raw = typeof roomKeyOrChatId === 'string' ? roomKeyOrChatId.trim() : '';
  if (!raw || typeof wardrobe?.resolveVaultVisibility !== 'function') {
    return 'owner_private';
  }
  try {
    const resolved = wardrobe.resolveVaultVisibility(raw);
    return VALID_VISIBILITIES.has(resolved) ? resolved : 'owner_private';
  } catch {
    return 'owner_private';
  }
}

function clampLimit(raw: unknown): number {
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) {
    return VAULT_WXARC_DEFAULT_LIMIT;
  }
  return Math.max(1, Math.min(VAULT_WXARC_MAX_LIMIT, Math.floor(num)));
}

function clampWindow(raw: unknown): number {
  const num = Number(raw);
  if (!Number.isFinite(num) || num < 0) {
    return VAULT_CONTEXT_DEFAULT_WINDOW;
  }
  return Math.max(0, Math.min(VAULT_CONTEXT_MAX_WINDOW, Math.floor(num)));
}

function parseBoundaryMs(raw: string | undefined, isUpperBound = false): number | null {
  if (!raw || !raw.trim()) {
    return null;
  }
  const trimmed = raw.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const asNum = Number(trimmed);
    if (Number.isFinite(asNum) && asNum > 0) {
      return asNum < 10_000_000_000 ? Math.floor(asNum * 1000) : Math.floor(asNum);
    }
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const suffix = isUpperBound ? 'T23:59:59.999+08:00' : 'T00:00:00.000+08:00';
    const parsed = Date.parse(`${trimmed}${suffix}`);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function eventTimestampMs(event: { ts?: number }, fallbackIso?: string): number {
  if (typeof event.ts === 'number' && Number.isFinite(event.ts) && event.ts > 0) {
    return event.ts < 10_000_000_000 ? Math.floor(event.ts * 1000) : Math.floor(event.ts);
  }
  if (fallbackIso) {
    const parsed = Date.parse(fallbackIso);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function toOccurredAtIso(ms: number, fallbackIso?: string): string {
  if (ms > 0) {
    return new Date(ms).toISOString();
  }
  return fallbackIso || '';
}

function extractSearchableEventText(event: WxarcEvent): string {
  const parts: string[] = [];
  const body = messageBody(event);
  if (typeof body === 'string' && body.trim()) {
    parts.push(body.trim());
  }
  if (typeof event.quote?.text === 'string' && event.quote.text.trim()) {
    parts.push(event.quote.text.trim());
  }
  if (typeof event.article?.title === 'string' && event.article.title.trim()) {
    parts.push(event.article.title.trim());
  }
  return parts.join(' ');
}

function parseWechatSeqItemId(itemId: string): number | null {
  const trimmed = String(itemId || '').trim();
  const match = trimmed.match(/^(?:wechat:)?(?:seq:)?(\d+)$/);
  if (!match) {
    return null;
  }
  const seq = Number(match[1]);
  return Number.isSafeInteger(seq) && seq > 0 ? seq : null;
}

function effectiveAllowedCircles(
  scope: VaultScope,
  queryCircle?: VaultVisibility,
): Set<VaultVisibility> {
  const base = Array.isArray(scope.allowedCircles) ? scope.allowedCircles : [];
  if (queryCircle) {
    return new Set(base.filter((c) => c === queryCircle));
  }
  return new Set(base);
}

export function createWechatVaultProvider(options: WechatVaultProviderOptions): VaultProvider {
  const { db, getWardrobe } = options;

  return {
    id: 'wechat',
    label: '微信近期消息',

    search(query: VaultSearchQuery, scope: VaultScope): VaultSearchHit[] {
      const allowed = effectiveAllowedCircles(scope, query.circle);
      if (allowed.size === 0) {
        return [];
      }
      const needle = typeof query.query === 'string' ? query.query.trim().toLowerCase() : '';
      const rawRoomKey = typeof query.roomKey === 'string' ? query.roomKey.trim() : '';
      const roomKeyNeedle = rawRoomKey
        ? rawRoomKey.replace(/^wechat:/i, '').trim().toLowerCase()
        : '';
      const personNeedle =
        typeof query.person === 'string' && query.person.trim()
          ? query.person.trim().toLowerCase()
          : '';
      const sinceMs = parseBoundaryMs(query.since, false);
      const untilMs = parseBoundaryMs(query.until, true);
      const limit = clampLimit(query.limit);
      const wardrobe = getWardrobe?.() ?? null;

      const hits: VaultSearchHit[] = [];
      let beforeSeq = 0;

      while (hits.length < limit) {
        const rows = db
          .prepare(
            "SELECT seq, payload, received_at FROM events WHERE kind='text' AND (?=0 OR seq<?) ORDER BY seq DESC LIMIT ?",
          )
          .all(beforeSeq, beforeSeq, WECHAT_SCAN_BATCH) as unknown as StoredEventRow[];
        if (rows.length === 0) {
          break;
        }
        beforeSeq = rows[rows.length - 1]!.seq;

        for (const row of rows) {
          let event: WxarcEvent;
          try {
            event = JSON.parse(row.payload) as WxarcEvent;
          } catch {
            continue;
          }
          const session = typeof event.session === 'string' ? event.session.trim() : '';
          if (roomKeyNeedle) {
            const normalizedSession = session.replace(/^wechat:/i, '').trim().toLowerCase();
            if (!normalizedSession || normalizedSession !== roomKeyNeedle) {
              continue;
            }
          }
          const circle = resolveWechatVaultCircle(session, wardrobe);
          if (!allowed.has(circle)) {
            continue;
          }
          const tsMs = eventTimestampMs(event, row.received_at);
          if (sinceMs !== null && tsMs > 0 && tsMs < sinceMs) {
            continue;
          }
          if (untilMs !== null && tsMs > 0 && tsMs > untilMs) {
            continue;
          }
          const sender = typeof event.sender === 'string' ? event.sender.trim() : '';
          const senderId = typeof event.senderId === 'string' ? event.senderId.trim() : '';
          const sessionName =
            typeof event.session_name === 'string' ? event.session_name.trim() : '';
          if (personNeedle) {
            const personHay = `${sender} ${senderId} ${sessionName} ${session}`.toLowerCase();
            if (!personHay.includes(personNeedle)) {
              continue;
            }
          }
          const content = extractSearchableEventText(event);
          const textBody = content || (typeof event.text === 'string' ? event.text.trim() : '');
          if (!textBody) {
            continue;
          }
          if (needle) {
            const hay = `${content} ${sender} ${sessionName}`.toLowerCase();
            if (!hay.includes(needle)) {
              continue;
            }
          }
          hits.push({
            source: 'wechat',
            itemId: `seq:${row.seq}`,
            circle,
            ...(session ? { roomKey: `wechat:${session}` } : {}),
            ...(sessionName || session ? { roomName: sessionName || session } : {}),
            ...(sender || senderId ? { author: sender || senderId } : {}),
            occurredAt: toOccurredAtIso(tsMs, row.received_at),
            snippet: compactVaultSnippet(textBody),
            metadata: {
              seq: row.seq,
              eventId: event.id,
              ...(event.local_type !== undefined ? { localType: event.local_type } : {}),
            },
          });
          if (hits.length >= limit) {
            break;
          }
        }
        if (rows.length < WECHAT_SCAN_BATCH) {
          break;
        }
      }

      return hits;
    },

    context(
      itemId: string,
      opts: VaultContextOptions,
      scope: VaultScope,
    ): VaultContextResult | null {
      const seq = parseWechatSeqItemId(itemId);
      if (!seq) {
        return null;
      }
      const allowed = effectiveAllowedCircles(scope);
      if (allowed.size === 0) {
        return null;
      }
      const targetRow = db
        .prepare("SELECT seq, payload, received_at FROM events WHERE kind='text' AND seq=?")
        .get(seq) as StoredEventRow | undefined;
      if (!targetRow) {
        return null;
      }
      let targetEvent: WxarcEvent;
      try {
        targetEvent = JSON.parse(targetRow.payload) as WxarcEvent;
      } catch {
        return null;
      }
      const session = typeof targetEvent.session === 'string' ? targetEvent.session.trim() : '';
      const wardrobe = getWardrobe?.() ?? null;
      const circle = resolveWechatVaultCircle(session, wardrobe);
      if (!allowed.has(circle)) {
        return null;
      }

      const before = clampWindow(opts?.before);
      const after = clampWindow(opts?.after);

      const beforeRows =
        before > 0 && session
          ? (
              db
                .prepare(
                  "SELECT seq, payload, received_at FROM events WHERE kind='text' AND json_extract(payload,'$.session')=? AND seq<? ORDER BY seq DESC LIMIT ?",
                )
                .all(session, seq, before) as unknown as StoredEventRow[]
            ).reverse()
          : [];
      const afterRows =
        after > 0 && session
          ? (db
              .prepare(
                "SELECT seq, payload, received_at FROM events WHERE kind='text' AND json_extract(payload,'$.session')=? AND seq>? ORDER BY seq ASC LIMIT ?",
              )
              .all(session, seq, after) as unknown as StoredEventRow[])
          : [];

      const toEntry = (row: StoredEventRow, isTarget: boolean): VaultContextEntry | null => {
        let ev: WxarcEvent;
        try {
          ev = JSON.parse(row.payload) as WxarcEvent;
        } catch {
          return null;
        }
        const evSession = typeof ev.session === 'string' ? ev.session.trim() : session;
        const evName = typeof ev.session_name === 'string' ? ev.session_name.trim() : '';
        const author =
          (typeof ev.sender === 'string' && ev.sender.trim()) ||
          (typeof ev.senderId === 'string' && ev.senderId.trim()) ||
          undefined;
        const tsMs = eventTimestampMs(ev, row.received_at);
        return {
          itemId: `seq:${row.seq}`,
          circle,
          ...(evSession ? { roomKey: `wechat:${evSession}` } : {}),
          ...(evName || evSession ? { roomName: evName || evSession } : {}),
          ...(author ? { author } : {}),
          occurredAt: toOccurredAtIso(tsMs, row.received_at),
          text: String(messageBody(ev) || ev.text || ''),
          isTarget,
        };
      };

      const items = [
        ...beforeRows.map((r) => toEntry(r, false)),
        toEntry(targetRow, true),
        ...afterRows.map((r) => toEntry(r, false)),
      ].filter((entry): entry is VaultContextEntry => entry !== null);

      const roomName =
        (typeof targetEvent.session_name === 'string' && targetEvent.session_name.trim()) ||
        session ||
        undefined;

      return {
        source: 'wechat',
        itemId: `seq:${targetRow.seq}`,
        circle,
        ...(session ? { roomKey: `wechat:${session}` } : {}),
        ...(roomName ? { roomName } : {}),
        items,
      };
    },
  };
}

function encodeNasVaultItemId(item: NasSearchItem, index: number): string {
  const sessionPart = encodeURIComponent(item.session || '');
  const idPart = item.id !== undefined ? `id:${encodeURIComponent(String(item.id))}` : '';
  const tsPart = item.ts !== undefined ? `ts:${item.ts}` : `idx:${index}`;
  return `nas:${sessionPart}:${idPart || tsPart}`;
}

function decodeNasVaultItemId(
  itemId: string,
): { session: string; id?: string; ts?: number } | null {
  const raw = String(itemId || '').trim();
  if (!raw.startsWith('nas:')) {
    return null;
  }
  const rest = raw.slice('nas:'.length);
  const sepIdx = rest.indexOf(':');
  if (sepIdx < 0) {
    return null;
  }
  let session: string;
  try {
    session = decodeURIComponent(rest.slice(0, sepIdx));
  } catch {
    return null;
  }
  if (!session) {
    return null;
  }
  const ref = rest.slice(sepIdx + 1);
  if (ref.startsWith('id:')) {
    try {
      return { session, id: decodeURIComponent(ref.slice(3)) };
    } catch {
      return null;
    }
  }
  if (ref.startsWith('ts:')) {
    const ts = Number(ref.slice(3));
    return Number.isFinite(ts) ? { session, ts } : null;
  }
  return null;
}

export function createNasVaultProvider(options: NasVaultProviderOptions): VaultProvider {
  const { getConfig, getWardrobe, fetcher, timeoutMs } = options;

  return {
    id: 'nas',
    label: 'NAS 微信历史档案',

    async search(query: VaultSearchQuery, scope: VaultScope): Promise<VaultSearchHit[]> {
      const allowed = effectiveAllowedCircles(scope, query.circle);
      if (allowed.size === 0) {
        return [];
      }
      const cfg = getConfig();
      const baseUrl = typeof cfg.baseUrl === 'string' ? cfg.baseUrl.trim() : '';
      const archivePath = typeof cfg.archivePath === 'string' ? cfg.archivePath.trim() : '';
      if (!baseUrl && !archivePath) {
        return [];
      }

      const queryText = typeof query.query === 'string' ? query.query.trim() : '';
      const rawRoomKey = typeof query.roomKey === 'string' ? query.roomKey.trim() : '';
      const roomSession = rawRoomKey ? rawRoomKey.replace(/^wechat:/i, '').trim() : '';
      const roomSessionNorm = normalizeNasSessionKey(roomSession);
      const roomSessionDirect = isDirectNasChatId(roomSession);
      const person = typeof query.person === 'string' ? query.person.trim() : '';
      const sinceRaw = typeof query.since === 'string' ? query.since.trim() : '';
      const untilRaw = typeof query.until === 'string' ? query.until.trim() : '';
      if (!queryText && !roomSession && !person && !sinceRaw && !untilRaw) {
        return [];
      }

      const limit = clampLimit(query.limit);
      const sinceMs = parseBoundaryMs(sinceRaw || undefined, false);
      const untilMs = parseBoundaryMs(untilRaw || undefined, true);
      const wardrobe = getWardrobe?.() ?? null;
      const nasOptions = {
        ...(baseUrl ? { baseUrl } : {}),
        ...(archivePath ? { archivePath } : {}),
        ...(fetcher ? { fetcher } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };

      let result = await searchNasArchive(
        {
          query: queryText,
          ...(roomSession ? { session: roomSession } : !queryText && person ? { session: person } : {}),
          ...(roomSession || queryText ? (person ? { sender: person } : {}) : {}),
          ...(sinceRaw ? { since: sinceRaw } : {}),
          ...(untilRaw ? { until: untilRaw } : {}),
          limit: MAX_NAS_SEARCH_LIMIT,
        },
        nasOptions,
      );

      if (!roomSession && person && result.items.length === 0) {
        result = await searchNasArchive(
          {
            query: queryText,
            ...(queryText ? { session: person } : { sender: person }),
            ...(sinceRaw ? { since: sinceRaw } : {}),
            ...(untilRaw ? { until: untilRaw } : {}),
            limit: MAX_NAS_SEARCH_LIMIT,
          },
          nasOptions,
        );
      }

      const hits: VaultSearchHit[] = [];
      for (let i = 0; i < result.items.length; i += 1) {
        const item = result.items[i]!;
        const session = typeof item.session === 'string' ? item.session.trim() : '';
        if (roomSessionNorm) {
          const itemSessionNorm = normalizeNasSessionKey(session.replace(/^wechat:/i, '').trim());
          const itemNameNorm = normalizeNasSessionKey(item.sessionName || '');
          const roomMatched = roomSessionDirect
            ? itemSessionNorm === roomSessionNorm
            : itemSessionNorm === roomSessionNorm ||
              itemSessionNorm.includes(roomSessionNorm) ||
              itemNameNorm.includes(roomSessionNorm);
          if (!roomMatched) {
            continue;
          }
        }
        const circle = resolveWechatVaultCircle(session, wardrobe);
        if (!allowed.has(circle)) {
          continue;
        }
        const tsMs = eventTimestampMs(item);
        if (sinceMs !== null && tsMs > 0 && tsMs < sinceMs) {
          continue;
        }
        if (untilMs !== null && tsMs > 0 && tsMs > untilMs) {
          continue;
        }
        hits.push({
          source: 'nas',
          itemId: encodeNasVaultItemId(item, i),
          circle,
          ...(session ? { roomKey: `wechat:${session}` } : {}),
          ...(item.sessionName || session ? { roomName: item.sessionName || session } : {}),
          ...(item.sender || item.senderId ? { author: item.sender || item.senderId } : {}),
          occurredAt: toOccurredAtIso(tsMs),
          snippet: compactVaultSnippet(item.text),
          metadata: {
            untrustedReferenceMaterial: true,
            ...(item.id !== undefined ? { nasItemId: item.id } : {}),
          },
        });
        if (hits.length >= limit) {
          break;
        }
      }

      return hits;
    },

    async context(
      itemId: string,
      opts: VaultContextOptions,
      scope: VaultScope,
    ): Promise<VaultContextResult | null> {
      const parsed = decodeNasVaultItemId(itemId);
      if (!parsed) {
        return null;
      }
      const allowed = effectiveAllowedCircles(scope);
      if (allowed.size === 0) {
        return null;
      }
      const wardrobe = getWardrobe?.() ?? null;
      const circle = resolveWechatVaultCircle(parsed.session, wardrobe);
      if (!allowed.has(circle)) {
        return null;
      }
      const cfg = getConfig();
      const baseUrl = typeof cfg.baseUrl === 'string' ? cfg.baseUrl.trim() : '';
      const archivePath = typeof cfg.archivePath === 'string' ? cfg.archivePath.trim() : '';
      if (!baseUrl && !archivePath) {
        return null;
      }

      const raw = await getNasArchiveContext(
        {
          session: parsed.session,
          itemId: parsed.id,
          ts: parsed.ts,
          before: clampWindow(opts?.before),
          after: clampWindow(opts?.after),
        },
        {
          ...(baseUrl ? { baseUrl } : {}),
          ...(archivePath ? { archivePath } : {}),
          ...(fetcher ? { fetcher } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        },
      );
      if (!raw) {
        return null;
      }

      const items: VaultContextEntry[] = raw.items.map((item, idx) => ({
        itemId: encodeNasVaultItemId(item, idx),
        circle,
        roomKey: `wechat:${raw.session}`,
        ...(item.sessionName || raw.sessionName || raw.session
          ? { roomName: item.sessionName || raw.sessionName || raw.session }
          : {}),
        ...(item.sender || item.senderId ? { author: item.sender || item.senderId } : {}),
        occurredAt: toOccurredAtIso(eventTimestampMs(item)),
        text: item.text,
        isTarget: Boolean(item.isTarget),
      }));

      return {
        source: 'nas',
        itemId,
        circle,
        roomKey: `wechat:${raw.session}`,
        ...(raw.sessionName || raw.session ? { roomName: raw.sessionName || raw.session } : {}),
        items,
      };
    },
  };
}

function mapTargetEntry(
  entry: LocalTargetDirectoryEntry,
  wardrobe?: VaultVisibilityResolverLike | null,
): HubTargetDirectoryEntry {
  const circle = wardrobe?.resolveVaultVisibility
    ? resolveWechatVaultCircle(entry.chatId, wardrobe)
    : VALID_VISIBILITIES.has(entry.circle as VaultVisibility)
      ? (entry.circle as VaultVisibility)
      : null;
  return {
    source: 'wechat',
    targetId: entry.chatId,
    roomKey: entry.roomKey,
    title: entry.title,
    chatId: entry.chatId,
    notifyWechatChatId: entry.chatId,
    targetSessionId: entry.sessionId,
    kind: entry.isGroup ? 'group' : 'dm',
    circle,
  };
}

export function createWechatTargetDirectoryProvider(
  getSource: () => TargetDirectorySource,
  getWardrobe?: () => VaultVisibilityResolverLike | PersonaWardrobe | null | undefined,
): TargetDirectoryProvider {
  return {
    id: 'wxarc',
    source: 'wechat',

    resolveTarget(query: TargetDirectoryQuery): TargetDirectoryResolution | null {
      const requestedSource = typeof query?.source === 'string' ? query.source.trim() : '';
      if (requestedSource && requestedSource !== 'wechat' && requestedSource !== 'wxarc') {
        return null;
      }
      const source = getSource();
      const wardrobe = getWardrobe?.() ?? null;
      const hasStructuredFields = Boolean(
        query.roomKey ||
          query.targetChatId ||
          query.notifyWechatChatId ||
          query.targetSessionId ||
          query.targetName,
      );
      if (hasStructuredFields) {
        const res = resolveMemoTarget(source, {
          roomKey: query.roomKey,
          targetChatId: query.targetChatId,
          notifyWechatChatId: query.notifyWechatChatId,
          targetSessionId: query.targetSessionId,
          targetName: query.targetName,
        });
        if (res.status === 'matched' && res.target) {
          const unique = resolveUniqueTarget(source, res.target.chatId);
          return {
            status: 'matched',
            target: unique.ok
              ? mapTargetEntry(unique.target, wardrobe)
              : {
                  source: 'wechat',
                  targetId: res.target.chatId,
                  roomKey: res.target.roomKey,
                  title: res.target.title ?? res.target.chatId,
                  chatId: res.target.chatId,
                  notifyWechatChatId: res.target.notifyWechatChatId,
                  targetSessionId: res.target.targetSessionId,
                  kind: res.target.chatId.endsWith('@chatroom') ? 'group' : 'dm',
                  circle: resolveWechatVaultCircle(res.target.chatId, wardrobe),
                },
          };
        }
        return {
          status: res.status,
          ...(res.candidates
            ? {
                candidates: res.candidates.map((c) => ({
                  source: 'wechat',
                  targetId: c.chatId,
                  roomKey: c.roomKey,
                  title: c.title ?? c.chatId,
                  chatId: c.chatId,
                  notifyWechatChatId: c.chatId,
                  kind: c.chatId.endsWith('@chatroom') ? 'group' : 'dm',
                })),
              }
            : {}),
          detail: res.detail,
        };
      }

      const rawQuery = typeof query?.query === 'string' ? query.query.trim() : '';
      if (!rawQuery) {
        return { status: 'not_found', detail: '未提供目标查询条件' };
      }
      const unique = resolveUniqueTarget(source, rawQuery);
      if (unique.ok) {
        return {
          status: 'matched',
          target: mapTargetEntry(unique.target, wardrobe),
        };
      }
      return {
        status: unique.status,
        candidates: unique.candidates.map((c) => mapTargetEntry(c, wardrobe)),
        detail: unique.error,
      };
    },

    listTargets(opts?: TargetDirectoryListOptions): HubTargetDirectoryEntry[] {
      const requestedSource = typeof opts?.source === 'string' ? opts.source.trim() : '';
      if (requestedSource && requestedSource !== 'wechat' && requestedSource !== 'wxarc') {
        return [];
      }
      const wardrobe = getWardrobe?.() ?? null;
      const q = typeof opts?.query === 'string' ? opts.query.trim().toLowerCase() : '';
      const kind = typeof opts?.kind === 'string' ? opts.kind.trim().toLowerCase() : '';
      const limit =
        typeof opts?.limit === 'number' && Number.isFinite(opts.limit) && opts.limit > 0
          ? Math.min(200, Math.floor(opts.limit))
          : 50;

      const entries = listRoomTargets(getSource(), 200).map((entry) =>
        mapTargetEntry(entry, wardrobe),
      );

      return entries
        .filter((entry) => {
          if (kind && entry.kind !== kind) {
            return false;
          }
          if (q) {
            const hay = `${entry.title || ''} ${entry.chatId || ''} ${entry.roomKey}`.toLowerCase();
            if (!hay.includes(q)) {
              return false;
            }
          }
          return true;
        })
        .slice(0, limit);
    },
  };
}
