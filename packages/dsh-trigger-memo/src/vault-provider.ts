import type {
  HubService,
  MemoRecord,
  PersonaWardrobe,
  VaultContextEntry,
  VaultContextOptions,
  VaultContextResult,
  VaultProvider,
  VaultScope,
  VaultSearchHit,
  VaultSearchQuery,
  VaultVisibility,
} from '@local/dsh-hub/contracts';
import type { MemoStore } from './store.js';

export interface MemoVaultProviderOptions {
  store: MemoStore;
  hub?: HubService;
  getWardrobe?: () => PersonaWardrobe | null;
}

const VALID_CIRCLES = new Set<VaultVisibility>(['external', 'work', 'family', 'owner_private']);
const MAX_SNIPPET_LENGTH = 220;
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 20;
const DEFAULT_CONTEXT_WINDOW = 5;
const MAX_CONTEXT_WINDOW = 15;

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function truncateSnippet(raw: string, maxLen = MAX_SNIPPET_LENGTH): string {
  const compact = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLen) return compact;
  if (maxLen <= 1) return compact.slice(0, Math.max(0, maxLen));
  return `${compact.slice(0, maxLen - 1).trimEnd()}…`;
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

function extractSearchTokens(text: string): string[] {
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
  const asciiRuns = normalized.match(/[a-z0-9_#.-]{2,}/g) ?? [];
  for (const token of asciiRuns) {
    tokens.add(token);
  }
  return Array.from(tokens);
}

function computeMatchScore(
  queryText: string,
  tokens: string[],
  primaryText: string,
  secondaryText: string,
): number {
  if (!queryText) return 1;
  const lowerQuery = queryText.toLowerCase();
  const primary = primaryText.toLowerCase();
  const secondary = secondaryText.toLowerCase();
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

function extractMetadataStrings(metadata: Record<string, unknown>): string[] {
  const keys = ['speaker', 'author', 'person', 'sender', 'owner', 'matchedTitle'];
  const out: string[] = [];
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim()) {
      out.push(value.trim());
    }
  }
  return out;
}

function matchesPerson(personLower: string, memo: MemoRecord): boolean {
  if (!personLower) return true;
  const fields: Array<string | null | undefined> = [
    memo.title,
    memo.basis,
    memo.roomKey,
    memo.targetChatId,
    memo.source,
    memo.resultSummary,
    ...memo.keywords,
    ...memo.knownFacts,
    ...extractMetadataStrings(memo.metadata),
  ];
  for (const field of fields) {
    if (field && field.toLowerCase().includes(personLower)) {
      return true;
    }
  }
  return false;
}

function resolveMemoTimestamp(memo: MemoRecord): { iso: string; ms: number } {
  const iso = memo.updatedAt || memo.createdAt || '';
  const ms = Date.parse(iso);
  if (Number.isFinite(ms)) return { iso, ms };
  const fallbackMs = Date.parse(memo.createdAt || '');
  return {
    iso: memo.createdAt || iso,
    ms: Number.isFinite(fallbackMs) ? fallbackMs : 0,
  };
}

function formatMemoSnippet(memo: MemoRecord): string {
  const head = `[${memo.kind}/${memo.status}]`;
  const titlePart = memo.title ? ` ${memo.title}：` : ' ';
  const summaryPart = memo.resultSummary ? ` | ${memo.resultSummary}` : '';
  return truncateSnippet(`${head}${titlePart}${memo.basis}${summaryPart}`, MAX_SNIPPET_LENGTH);
}

function formatMemoContextText(memo: MemoRecord, seenUrlCount?: number): string {
  const lines: string[] = [
    `[${memo.kind}/${memo.status}] ${memo.title || '(无标题)'}`,
    `内容：${memo.basis}`,
  ];
  if (memo.windowStart || memo.windowEnd) {
    lines.push(`时间窗口：${memo.windowStart ?? '-'} ~ ${memo.windowEnd ?? '-'}`);
  }
  if (memo.keywords.length > 0) {
    lines.push(`关键词：${memo.keywords.join(', ')}`);
  }
  if (memo.knownFacts.length > 0) {
    lines.push(`已知事实：${memo.knownFacts.join('；')}`);
  }
  if (memo.acceptCriteria) {
    lines.push(`验收条件：${memo.acceptCriteria}`);
  }
  if (memo.resultSummary) {
    lines.push(`结果摘要：${memo.resultSummary}`);
  }
  if (typeof seenUrlCount === 'number' && seenUrlCount > 0) {
    lines.push(`已追踪链接数：${seenUrlCount}`);
  }
  return lines.join('\n');
}

export function resolveMemoVaultVisibility(
  memo: Pick<MemoRecord, 'roomKey'>,
  wardrobe?: PersonaWardrobe | null,
): VaultVisibility {
  const roomKey = typeof memo.roomKey === 'string' ? memo.roomKey.trim() : '';
  if (!roomKey || roomKey.startsWith('session:')) {
    return 'owner_private';
  }
  if (typeof wardrobe?.resolveVaultVisibility === 'function') {
    try {
      const resolved = wardrobe.resolveVaultVisibility(roomKey);
      if (VALID_CIRCLES.has(resolved)) {
        return resolved;
      }
    } catch {
      return 'owner_private';
    }
  }
  return 'owner_private';
}

export function createMemoVaultProvider(options: MemoVaultProviderOptions): VaultProvider {
  const { store, hub } = options;
  const resolveWardrobe = (): PersonaWardrobe | null => {
    if (options.getWardrobe) {
      const fromFn = options.getWardrobe();
      if (fromFn) return fromFn;
    }
    return hub?.getWardrobe?.() ?? hub?.wardrobe ?? null;
  };

  return {
    id: 'memo',
    label: '便签提醒',
    search(query: VaultSearchQuery, scope: VaultScope): VaultSearchHit[] {
      const allowedSet = new Set<VaultVisibility>(
        Array.isArray(scope.allowedCircles) ? scope.allowedCircles : [],
      );
      if (allowedSet.size === 0) return [];
      if (query.circle && !allowedSet.has(query.circle)) return [];

      const effectiveAllowed = query.circle ? new Set<VaultVisibility>([query.circle]) : allowedSet;
      const limit = clampInt(query.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);
      const queryText = typeof query.query === 'string' ? query.query.trim() : '';
      const tokens = extractSearchTokens(queryText);
      const personLower = typeof query.person === 'string' ? query.person.trim().toLowerCase() : '';
      const sinceMs = parseTimestampFilter(query.since);
      const untilMs = parseTimestampFilter(query.until);
      const wardrobe = resolveWardrobe();

      const memos = store.listMemos({ limit: 500 });
      const candidates: Array<{ hit: VaultSearchHit; occurredAtMs: number }> = [];

      for (const memo of memos) {
        const circle = resolveMemoVaultVisibility(memo, wardrobe);
        if (!effectiveAllowed.has(circle)) continue;

        const ts = resolveMemoTimestamp(memo);
        if (sinceMs !== null && ts.ms < sinceMs) continue;
        if (untilMs !== null && ts.ms > untilMs) continue;
        if (!matchesPerson(personLower, memo)) continue;

        const primaryText = `${memo.title} ${memo.keywords.join(' ')} ${memo.roomKey} ${memo.kind} ${memo.status}`;
        const secondaryText = `${memo.basis} ${memo.knownFacts.join(' ')} ${memo.acceptCriteria ?? ''} ${memo.resultSummary ?? ''}`;
        const baseScore = computeMatchScore(queryText, tokens, primaryText, secondaryText);
        if (queryText && baseScore <= 0) continue;

        const score = baseScore + (memo.status === 'active' ? 0.5 : 0);
        candidates.push({
          occurredAtMs: ts.ms,
          hit: {
            source: 'memo',
            itemId: memo.id,
            circle,
            roomKey: memo.roomKey,
            author: memo.source || undefined,
            occurredAt: ts.iso,
            snippet: formatMemoSnippet(memo),
            score,
            metadata: {
              kind: memo.kind,
              status: memo.status,
              title: memo.title,
              windowStart: memo.windowStart,
              windowEnd: memo.windowEnd,
              expiresAt: memo.expiresAt,
              keywords: memo.keywords,
            },
          },
        });
      }

      candidates.sort((a, b) => {
        const scoreDiff = (b.hit.score ?? 0) - (a.hit.score ?? 0);
        if (scoreDiff !== 0) return scoreDiff;
        return b.occurredAtMs - a.occurredAtMs;
      });

      return candidates.slice(0, limit).map((item) => item.hit);
    },

    context(
      itemId: string,
      opts: VaultContextOptions,
      scope: VaultScope,
    ): VaultContextResult | null {
      const allowedSet = new Set<VaultVisibility>(
        Array.isArray(scope.allowedCircles) ? scope.allowedCircles : [],
      );
      if (allowedSet.size === 0) return null;

      const memo = store.getMemo(itemId);
      if (!memo) return null;

      const wardrobe = resolveWardrobe();
      const targetCircle = resolveMemoVaultVisibility(memo, wardrobe);
      if (!allowedSet.has(targetCircle)) return null;

      const beforeCount = clampInt(opts?.before, DEFAULT_CONTEXT_WINDOW, 0, MAX_CONTEXT_WINDOW);
      const afterCount = clampInt(opts?.after, DEFAULT_CONTEXT_WINDOW, 0, MAX_CONTEXT_WINDOW);

      const roomMemos = store
        .listMemos({ roomKey: memo.roomKey, limit: 200 })
        .filter((item) => allowedSet.has(resolveMemoVaultVisibility(item, wardrobe)))
        .sort((a, b) => {
          const timeDiff = resolveMemoTimestamp(a).ms - resolveMemoTimestamp(b).ms;
          if (timeDiff !== 0) return timeDiff;
          return a.id.localeCompare(b.id);
        });

      const targetIndex = roomMemos.findIndex((item) => item.id === memo.id);
      const startIndex = targetIndex >= 0 ? Math.max(0, targetIndex - beforeCount) : 0;
      const endIndex =
        targetIndex >= 0 ? Math.min(roomMemos.length, targetIndex + afterCount + 1) : 0;
      const selected = targetIndex >= 0 ? roomMemos.slice(startIndex, endIndex) : [memo];
      const seenUrls = store.listSeenUrls(memo.id);

      const items: VaultContextEntry[] = selected.map((entry) => {
        const isTarget = entry.id === memo.id;
        const entryCircle = resolveMemoVaultVisibility(entry, wardrobe);
        return {
          itemId: entry.id,
          circle: entryCircle,
          roomKey: entry.roomKey,
          author: entry.source || undefined,
          occurredAt: resolveMemoTimestamp(entry).iso,
          text: formatMemoContextText(entry, isTarget ? seenUrls.length : undefined),
          ...(isTarget ? { isTarget: true } : {}),
          metadata: {
            kind: entry.kind,
            status: entry.status,
            title: entry.title,
          },
        };
      });

      const truncated =
        targetIndex >= 0 && (startIndex > 0 || endIndex < roomMemos.length);

      return {
        source: 'memo',
        itemId: memo.id,
        circle: targetCircle,
        roomKey: memo.roomKey,
        items,
        truncated,
        metadata: {
          kind: memo.kind,
          status: memo.status,
          title: memo.title,
          windowStart: memo.windowStart,
          windowEnd: memo.windowEnd,
          nextCheckAt: memo.nextCheckAt,
          expiresAt: memo.expiresAt,
          seenUrlCount: seenUrls.length,
        },
      };
    },
  };
}
