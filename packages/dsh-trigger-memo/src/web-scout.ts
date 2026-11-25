import type { MemoRecord } from '@local/dsh-hub/contracts';
import { normalizeUrlKey, type MemoStore } from './store.js';

export interface WebSearchResultItem {
  url: string;
  title?: string;
  snippet?: string;
  summary?: string;
  content?: string;
  publishedAt?: string | null;
  publishedDate?: string | null;
  date?: string | null;
}

export type WebSearchResponse =
  | WebSearchResultItem[]
  | {
      sources?: WebSearchResultItem[];
      results?: WebSearchResultItem[];
      items?: WebSearchResultItem[];
      answer?: string;
      summary?: string;
    };

export interface WebSearchClient {
  search(
    input: { query: string; maxResults?: number },
    signal?: AbortSignal,
  ): Promise<WebSearchResponse>;
}

export interface NormalizedSearchItem {
  url: string;
  normalizedUrl: string;
  domain: string;
  title: string;
  snippet: string;
  publishedAt: string | null;
  publishedMs: number | null;
}

export type ScoutVerdict =
  | 'accepted'
  | 'already_seen'
  | 'stale'
  | 'low_signal_rehash'
  | 'rumor_or_workaround'
  | 'non_official_domain'
  | 'missing_official_signal'
  | 'criteria_not_met'
  | 'no_new_facts'
  | 'irrelevant';

export interface ScoutCandidate extends NormalizedSearchItem {
  score: number;
  reasons: string[];
}

export interface ScoutRejectedItem extends NormalizedSearchItem {
  verdict: Exclude<ScoutVerdict, 'accepted'>;
  reason: string;
}

export interface ScoutOutcome {
  matched: boolean;
  query: string;
  totalResults: number;
  accepted: ScoutCandidate[];
  rejected: ScoutRejectedItem[];
  summary: string;
  topCandidate: ScoutCandidate | null;
}

export interface WebScoutOptions {
  web: WebSearchClient;
  store?: MemoStore;
  maxResults?: number;
  now?: () => Date;
}

const CLICKBAIT_REHASH_PATTERNS: readonly string[] = [
  '震惊',
  '网传',
  '据说',
  '小道消息',
  '营销号',
  '自媒体',
  '搬运',
  '整理汇总',
  '盘点',
  '旧闻',
  '转发自',
  '吃瓜',
  'rumor',
  'rumour',
  'clickbait',
  'unconfirmed',
  'speculation',
  'rehash',
  'recap',
  'leaked',
  'leak',
];

const WORKAROUND_RUMOR_PATTERNS: readonly string[] = [
  'workaround',
  'bypass',
  'unofficial',
  'proxy',
  'hack',
  'wrapper',
  'reverse-engineer',
  'reverse engineer',
  'cookie',
  'ban risk',
  'account ban',
  '429 fix',
  'screenshot',
  'old tweet',
  'rumor',
  'rumour',
  'speculation',
  'unconfirmed',
  'leak',
  'leaked',
  '绕过',
  '偏方',
  '非官方',
  '代理',
  '逆向',
  '抓包',
  '破解',
  '封号',
  '社区猜测',
  '社区版',
  '旧推特',
  '推特截图',
  '截图',
  '传闻',
  '猜测',
  '网传',
];

const OFFICIAL_RELEASE_SIGNALS: readonly string[] = [
  'official',
  'announcement',
  'announced',
  'announce',
  'release',
  'released',
  'release notes',
  'changelog',
  'documentation',
  'docs',
  'launch',
  'launched',
  'launching',
  'now supports',
  'now available',
  'general availability',
  'introducing',
  'native support',
  'official support',
  'specification',
  'protocol support',
  '官方公告',
  '官方发布',
  '正式支持',
  '正式发布',
  '正式文档',
  '新版本',
  '版本发布',
  '官宣',
  '正式上线',
];

const NEWS_UPDATE_SIGNALS: readonly string[] = [
  '官方',
  '公告',
  '回应',
  '声明',
  '最新进展',
  '查明',
  '结论',
  '免费',
  '更换',
  '补偿',
  '升级',
  '确认',
  '发布',
  '宣布',
  '方案',
  'official',
  'announced',
  'confirmed',
  'resolved',
  'statement',
  'findings',
  'compensation',
  'replacement',
  'free',
];

const LOW_SIGNAL_DOMAINS = new Set([
  'baijiahao.baidu.com',
  'sohu.com',
  'toutiao.com',
  'tieba.baidu.com',
  'weibo.com',
  'xiaohongshu.com',
]);

const COMMUNITY_SOCIAL_DOMAINS = new Set([
  'reddit.com',
  'x.com',
  'twitter.com',
  'v2ex.com',
  'zhihu.com',
  'tieba.baidu.com',
  'bilibili.com',
  'youtube.com',
  'medium.com',
  'dev.to',
  'news.ycombinator.com',
  'weibo.com',
  'xiaohongshu.com',
]);

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'that',
  'this',
  'have',
  'has',
  'will',
  'are',
  'was',
  'were',
  'been',
  'not',
  'but',
  'can',
  'all',
  'any',
  'our',
  'your',
  'their',
  'about',
  'into',
  'over',
  'only',
  'official',
  'support',
  'supports',
  'docs',
  'announcement',
  'release',
  'or',
  'of',
  'to',
  'in',
  'on',
  'by',
  'at',
  'as',
  'is',
  'be',
]);

const CJK_STOPWORDS = new Set([
  '只认',
  '官方',
  '公告',
  '正式',
  '文档',
  '版本',
  '发布',
  '支持',
  '或者',
  '以及',
  '关于',
  '进行',
  '已经',
  '没有',
  '最新',
  '进展',
  '消息',
  '新闻',
  '我们',
  '他们',
]);

export function extractDomain(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

const HTTP_PREFIX = 'http://';
const HTTPS_PREFIX = 'https://';

function stripUrlScheme(raw: string): string {
  if (raw.startsWith(HTTPS_PREFIX)) return raw.slice(HTTPS_PREFIX.length);
  if (raw.startsWith(HTTP_PREFIX)) return raw.slice(HTTP_PREFIX.length);
  return raw;
}

export function isOfficialDomainMatch(rawUrl: string, officialDomains: string[]): boolean {
  if (officialDomains.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase();
  const hostPath = (hostname + parsed.pathname).toLowerCase().replace(/\/+$/, '');

  for (const rawRule of officialDomains) {
    const rule = stripUrlScheme(rawRule.trim().toLowerCase()).replace(/\/+$/, '');
    if (!rule) continue;
    if (rule.includes('/')) {
      if (hostPath === rule || hostPath.startsWith(rule + '/')) {
        return true;
      }
    } else if (hostname === rule || hostname.endsWith('.' + rule)) {
      return true;
    }
  }
  return false;
}

function matchesAnyDomain(hostname: string, domains: Set<string>): boolean {
  if (!hostname) return false;
  for (const d of domains) {
    if (hostname === d || hostname.endsWith('.' + d)) return true;
  }
  return false;
}

function parseTimestampMs(raw?: string | null): number | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
}

function containsAnyPattern(text: string, patterns: readonly string[]): string | null {
  const lower = text.toLowerCase();
  for (const pattern of patterns) {
    if (lower.includes(pattern.toLowerCase())) return pattern;
  }
  return null;
}

function tokenizeText(text: string): Set<string> {
  const tokens = new Set<string>();
  const lower = String(text || '').toLowerCase();

  const latinMatches = lower.match(/[a-z0-9][a-z0-9._+-]{1,}/g) ?? [];
  for (const word of latinMatches) {
    if (!STOPWORDS.has(word)) {
      tokens.add(word);
    }
  }

  const cjkSegments = lower.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  for (const seg of cjkSegments) {
    if (seg.length <= 4 && !CJK_STOPWORDS.has(seg)) {
      tokens.add(seg);
    }
    for (let i = 0; i <= seg.length - 2; i += 1) {
      const gram = seg.slice(i, i + 2);
      if (!CJK_STOPWORDS.has(gram)) {
        tokens.add(gram);
      }
    }
  }
  return tokens;
}

function extractFactNumbers(text: string): Set<string> {
  const matches = String(text || '').match(/\d+(?:\.\d+)?(?:\s*(?:万|亿|千|%|辆|台|元|美元|天|小时|人|次))?/g) ?? [];
  return new Set(matches.map((m) => m.replace(/\s+/g, '').toLowerCase()));
}

function normalizeSearchResponse(resp: WebSearchResponse | null | undefined): NormalizedSearchItem[] {
  if (!resp) return [];
  const rawList = Array.isArray(resp)
    ? resp
    : Array.isArray(resp.sources)
      ? resp.sources
      : Array.isArray(resp.results)
        ? resp.results
        : Array.isArray(resp.items)
          ? resp.items
          : [];

  const out: NormalizedSearchItem[] = [];
  for (const entry of rawList) {
    if (!entry || typeof entry.url !== 'string') continue;
    const url = entry.url.trim();
    const normalizedUrl = normalizeUrlKey(url);
    if (!normalizedUrl) continue;
    const publishedAt = entry.publishedAt ?? entry.publishedDate ?? entry.date ?? null;
    const snippet = String(entry.snippet ?? entry.summary ?? entry.content ?? '').trim();
    out.push({
      url,
      normalizedUrl,
      domain: extractDomain(url),
      title: String(entry.title ?? '').trim(),
      snippet,
      publishedAt,
      publishedMs: parseTimestampMs(publishedAt),
    });
  }
  return out;
}

export function buildSearchQuery(memo: MemoRecord): string {
  const parts: string[] = [];
  if (memo.keywords.length > 0) {
    parts.push(...memo.keywords);
  } else if (memo.title) {
    parts.push(memo.title);
  } else {
    parts.push(memo.basis.slice(0, 80));
  }

  if (memo.kind === 'long_watch') {
    const joined = parts.join(' ').toLowerCase();
    if (!joined.includes('official') && !joined.includes('官方')) {
      parts.push('official announcement');
    }
  }
  return parts.join(' ').trim();
}

export function getKnownFactsCutoffMs(memo: MemoRecord): number | null {
  const metaVal = memo.metadata?.knownFactsUpdatedAt;
  if (typeof metaVal === 'string') {
    const ms = parseTimestampMs(metaVal);
    if (ms !== null) return ms;
  }
  return parseTimestampMs(memo.createdAt);
}

function hasKeywordRelevance(text: string, memo: MemoRecord): boolean {
  const lower = text.toLowerCase();
  const sources = memo.keywords.length > 0 ? memo.keywords : [memo.title, memo.basis];
  for (const kw of sources) {
    const cleaned = kw.trim().toLowerCase();
    if (!cleaned) continue;
    if (lower.includes(cleaned)) return true;
    const kwTokens = tokenizeText(cleaned);
    for (const t of kwTokens) {
      if (t.length >= 2 && lower.includes(t)) return true;
    }
  }
  return false;
}

function evaluateNewsItem(
  item: NormalizedSearchItem,
  memo: MemoRecord,
): { verdict: ScoutVerdict; score: number; reasons: string[] } {
  const combined = `${item.title} ${item.snippet}`.trim();

  const clickbaitHit = containsAnyPattern(combined, CLICKBAIT_REHASH_PATTERNS);
  if (clickbaitHit) {
    return {
      verdict: 'low_signal_rehash',
      score: 0,
      reasons: [`matched low-signal/rehash pattern: ${clickbaitHit}`],
    };
  }

  if (
    matchesAnyDomain(item.domain, LOW_SIGNAL_DOMAINS) &&
    !isOfficialDomainMatch(item.url, memo.officialDomains)
  ) {
    const hasOfficialWord = containsAnyPattern(combined, ['官方公告', '官方声明', 'official']);
    if (!hasOfficialWord) {
      return {
        verdict: 'low_signal_rehash',
        score: 0,
        reasons: [`low-signal aggregator domain: ${item.domain}`],
      };
    }
  }

  if (!hasKeywordRelevance(combined, memo)) {
    return {
      verdict: 'irrelevant',
      score: 0,
      reasons: ['no overlap with memo keywords'],
    };
  }

  const knownText = memo.knownFacts.join(' ');
  const baselineText = [knownText, memo.title, memo.keywords.join(' ')].join(' ');
  const baselineTokens = tokenizeText(baselineText);
  const candidateTokens = tokenizeText(combined);
  const novelTokens: string[] = [];
  for (const tok of candidateTokens) {
    if (!baselineTokens.has(tok)) {
      novelTokens.push(tok);
    }
  }

  const knownNumbers = extractFactNumbers(knownText);
  const candidateNumbers = extractFactNumbers(combined);
  const novelNumbers: string[] = [];
  for (const n of candidateNumbers) {
    if (!knownNumbers.has(n)) novelNumbers.push(n);
  }

  const updateSignal = containsAnyPattern(combined, NEWS_UPDATE_SIGNALS);
  const officialDomainHit =
    memo.officialDomains.length > 0 && isOfficialDomainMatch(item.url, memo.officialDomains);

  const noveltyRatio = candidateTokens.size > 0 ? novelTokens.length / candidateTokens.size : 0;
  const hasNewFact =
    memo.knownFacts.length === 0 ||
    novelNumbers.length > 0 ||
    (Boolean(updateSignal) && novelTokens.length >= 2) ||
    (novelTokens.length >= 4 && noveltyRatio >= 0.45);

  if (!hasNewFact) {
    return {
      verdict: 'no_new_facts',
      score: 0,
      reasons: ['repeats known facts without genuine new development'],
    };
  }

  let score = 50;
  const reasons: string[] = [];
  if (officialDomainHit) {
    score += 30;
    reasons.push(`official domain: ${item.domain}`);
  }
  if (updateSignal) {
    score += 20;
    reasons.push(`update signal: ${updateSignal}`);
  }
  if (novelNumbers.length > 0) {
    score += 15;
    reasons.push(`new figures: ${novelNumbers.slice(0, 3).join(', ')}`);
  }
  reasons.push(`novel tokens: ${novelTokens.length}`);
  return { verdict: 'accepted', score, reasons };
}

function evaluateLongWatchItem(
  item: NormalizedSearchItem,
  memo: MemoRecord,
): { verdict: ScoutVerdict; score: number; reasons: string[] } {
  const combined = `${item.title} ${item.snippet} ${item.url}`.trim();
  const textOnly = `${item.title} ${item.snippet}`.trim();

  const rumorHit = containsAnyPattern(combined, WORKAROUND_RUMOR_PATTERNS);
  if (rumorHit) {
    return {
      verdict: 'rumor_or_workaround',
      score: 0,
      reasons: [`rejected rumor/workaround signal: ${rumorHit}`],
    };
  }

  if (memo.officialDomains.length > 0) {
    if (!isOfficialDomainMatch(item.url, memo.officialDomains)) {
      return {
        verdict: 'non_official_domain',
        score: 0,
        reasons: [`domain ${item.domain} not in officialDomains`],
      };
    }
  } else if (matchesAnyDomain(item.domain, COMMUNITY_SOCIAL_DOMAINS)) {
    return {
      verdict: 'non_official_domain',
      score: 0,
      reasons: [`community/social domain rejected for long_watch: ${item.domain}`],
    };
  }

  const officialSignal = containsAnyPattern(textOnly, OFFICIAL_RELEASE_SIGNALS);
  if (!officialSignal) {
    return {
      verdict: 'missing_official_signal',
      score: 0,
      reasons: ['no official release, docs, or announcement signal'],
    };
  }

  if (!hasKeywordRelevance(textOnly, memo)) {
    return {
      verdict: 'criteria_not_met',
      score: 0,
      reasons: ['does not match watched keywords'],
    };
  }

  if (memo.acceptCriteria) {
    const criteriaTokens = tokenizeText(memo.acceptCriteria);
    if (criteriaTokens.size > 0) {
      const lowerText = textOnly.toLowerCase();
      let hits = 0;
      for (const tok of criteriaTokens) {
        if (lowerText.includes(tok)) hits += 1;
      }
      if (hits === 0) {
        return {
          verdict: 'criteria_not_met',
          score: 0,
          reasons: ['does not satisfy acceptCriteria terms'],
        };
      }
    }
  }

  let score = 70;
  const reasons: string[] = [`official signal: ${officialSignal}`];
  if (memo.officialDomains.length > 0) {
    score += 30;
    reasons.push(`verified official domain: ${item.domain}`);
  }
  return { verdict: 'accepted', score, reasons };
}

export class WebScout {
  private readonly web: WebSearchClient;
  private readonly store?: MemoStore;
  private readonly maxResults: number;
  private readonly now: () => Date;

  constructor(options: WebScoutOptions) {
    this.web = options.web;
    this.store = options.store;
    this.maxResults = Math.max(1, Math.min(20, Number(options.maxResults) || 8));
    this.now = options.now ?? (() => new Date());
  }

  async scout(memo: MemoRecord, signal?: AbortSignal): Promise<ScoutOutcome> {
    const query = buildSearchQuery(memo);
    const response = await this.web.search({ query, maxResults: this.maxResults }, signal);
    const items = normalizeSearchResponse(response);

    const seenUrls = this.store ? this.store.getSeenUrlSet(memo.id) : new Set<string>();
    const cutoffMs = getKnownFactsCutoffMs(memo);
    const seenAtIso = this.now().toISOString();

    const accepted: ScoutCandidate[] = [];
    const rejected: ScoutRejectedItem[] = [];
    const batchSeen = new Set<string>();

    for (const item of items) {
      if (batchSeen.has(item.normalizedUrl) || seenUrls.has(item.normalizedUrl)) {
        rejected.push({
          ...item,
          verdict: 'already_seen',
          reason: 'URL already seen for this memo',
        });
        continue;
      }
      batchSeen.add(item.normalizedUrl);

      if (cutoffMs !== null && item.publishedMs !== null && item.publishedMs < cutoffMs) {
        rejected.push({
          ...item,
          verdict: 'stale',
          reason: `publishedAt ${item.publishedAt} is older than knownFactsUpdatedAt`,
        });
        this.store?.recordSeenUrl(memo.id, {
          url: item.url,
          title: item.title,
          publishedAt: item.publishedAt,
          verdict: 'stale',
          seenAt: seenAtIso,
        });
        continue;
      }

      const evaluation =
        memo.kind === 'long_watch'
          ? evaluateLongWatchItem(item, memo)
          : evaluateNewsItem(item, memo);

      this.store?.recordSeenUrl(memo.id, {
        url: item.url,
        title: item.title,
        publishedAt: item.publishedAt,
        verdict: evaluation.verdict,
        seenAt: seenAtIso,
      });

      if (evaluation.verdict === 'accepted') {
        accepted.push({
          ...item,
          score: evaluation.score,
          reasons: evaluation.reasons,
        });
      } else {
        rejected.push({
          ...item,
          verdict: evaluation.verdict,
          reason: evaluation.reasons.join('; '),
        });
      }
    }

    accepted.sort((a, b) => b.score - a.score || (b.publishedMs ?? 0) - (a.publishedMs ?? 0));
    const topCandidate = accepted[0] ?? null;
    const summary = topCandidate
      ? `${topCandidate.title || topCandidate.domain} (${topCandidate.url})`
      : `No qualifying update across ${items.length} result(s)`;

    return {
      matched: accepted.length > 0,
      query,
      totalResults: items.length,
      accepted,
      rejected,
      summary,
      topCandidate,
    };
  }
}

export function createWebScout(options: WebScoutOptions): WebScout {
  return new WebScout(options);
}
