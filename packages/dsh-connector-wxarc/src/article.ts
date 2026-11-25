import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { articleURL } from './article-url.js';

export { articleURL } from './article-url.js';

const PROVENANCE_KEYS = ['session', 'text', 'ts', 'local_type'] as const;

export interface ParsedArticle {
  title?: string;
  text: string;
  hasContent?: boolean;
  url?: string;
  method?: string;
  fetched_at?: number;
  hash?: string;
}

export type VerifiedArticle<T extends ParsedArticle = ParsedArticle> = T & {
  text: string;
  chars: number;
};

export interface EnrichedArticle extends VerifiedArticle {
  status: 'read';
  cached?: boolean;
  snapshot?: boolean;
  refreshFailed?: boolean;
  hash?: string;
  fetched_at?: number;
}

export interface ArticleEvent {
  id: number;
  kind: string;
  session?: string;
  text?: string;
  ts?: number;
  local_type?: number;
  link?: { url?: string };
  article?: EnrichedArticle;
}

interface RefreshArticleRow {
  id?: number;
  session?: string;
  text?: string;
  ts?: number;
  local_type?: number;
  link?: { url?: string };
}

interface CachedArticleRow {
  url: string;
  title: string;
  text: string;
  method: string;
  fetched_at: number;
  hash: string;
}

export interface ArticleStore {
  db: {
    exec(sql: string): void;
    prepare(sql: string): {
      get(...params: string[]): unknown;
      run(...params: Array<string | number>): unknown;
    };
  };
}

export interface ArticleListener {
  get(path: string): Promise<unknown>;
}

export interface ArticleCua {
  readArticle(
    job: { event: ArticleEvent; rule: unknown; url: string },
    signal: AbortSignal,
  ): Promise<{ title: string; text: string; method?: string }>;
}

export type ArticleFetcher = (input: string, init?: RequestInit) => Promise<Response>;

export interface ArticleReaderOptions {
  store: ArticleStore;
  listener: ArticleListener;
  cua: ArticleCua;
  python: string;
  fetcher?: ArticleFetcher;
  now?: () => number;
}

export const titleOf = (event: { text?: string }): string =>
  (event.text ?? '').replace(/^\[链接\]\s*/, '').trim();

const norm = (text: string): string => text.replace(/\s/g, '');

export function verifyArticle<T extends ParsedArticle>(
  article: T | null | undefined,
  expectedTitle: string,
): VerifiedArticle<T> {
  if (!article || typeof article.text !== 'string' || article.text.trim().length < 180) {
    throw new Error('没有读到足够的文章正文');
  }
  if (norm(article.title || '') !== norm(expectedTitle)) {
    throw new Error('打开的文章标题与收到的链接不一致');
  }
  if (article.text.length > 60000) {
    throw new Error('文章超过当前完整读取上限，未仅用部分内容回复');
  }
  const trimmed = article.text.trim();
  return { ...article, text: trimmed, chars: trimmed.length };
}

export function parseHTML(
  python: string,
  html: string,
  signal?: AbortSignal,
): Promise<ParsedArticle> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      python,
      ['-B', fileURLToPath(new URL('./article-parser.py', import.meta.url))],
      { signal, timeout: 8000, maxBuffer: 1024 * 1024 },
      (err, out) => {
        if (err) return reject(new Error('文章正文解析失败'));
        try {
          resolve(JSON.parse(out) as ParsedArticle);
        } catch {
          reject(new Error('文章正文解析失败'));
        }
      },
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify({ html }));
  });
}

export class ArticleReader {
  store: ArticleStore;
  listener: ArticleListener;
  cua: ArticleCua;
  python: string;
  fetcher: ArticleFetcher;
  now: () => number;

  constructor({
    store,
    listener,
    cua,
    python,
    fetcher = fetch,
    now = Date.now,
  }: ArticleReaderOptions) {
    this.store = store;
    this.listener = listener;
    this.cua = cua;
    this.python = python;
    this.fetcher = fetcher;
    this.now = now;
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS article_cache(url TEXT PRIMARY KEY,title TEXT NOT NULL,text TEXT NOT NULL,method TEXT NOT NULL,fetched_at INTEGER NOT NULL,hash TEXT NOT NULL)',
    );
  }

  async http(
    url: string,
    expectedTitle: string,
    signal: AbortSignal,
  ): Promise<VerifiedArticle<ParsedArticle>> {
    let next = url;
    for (let n = 0; n < 4; n++) {
      const response = await this.fetcher(next, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
        redirect: 'manual',
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        const redirected = location ? articleURL(new URL(location, next).href) : null;
        if (!redirected) throw new Error('文章跳转到验证页或非公众号地址');
        next = redirected;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('公众号网页请求失败');
      }
      if (!response.body) {
        throw new Error('公众号网页请求失败');
      }
      const reader = response.body.getReader();
      let bytes = 0;
      const parts: Uint8Array[] = [];
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > 4 * 1024 * 1024) throw new Error('文章页面超过读取上限');
          parts.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const parsed = await parseHTML(this.python, Buffer.concat(parts).toString('utf8'), signal);
      if (!parsed.hasContent) throw new Error('网页没有提供正文，可能需要在微信中验证');
      return verifyArticle({ ...parsed, url, method: 'http' }, expectedTitle);
    }
    throw new Error('文章跳转过多');
  }

  async enrich<T extends ArticleEvent>(
    event: T,
    rule: unknown,
    signal: AbortSignal,
  ): Promise<T & { link?: { url: string }; article?: EnrichedArticle }> {
    const localType = event.local_type ?? 0;
    if (
      event.kind !== 'text' ||
      localType % 4294967296 !== 49 ||
      !event.text?.startsWith('[链接]')
    ) {
      return event as T & { link?: { url: string }; article?: EnrichedArticle };
    }
    const rows = (await this.listener.get(
      `/ui/refresh?kind=text&ids=${event.id}`,
    )) as RefreshArticleRow[];
    const original = rows.find((r) => r.id === event.id);
    if (!original || PROVENANCE_KEYS.some((k) => original[k] !== event[k])) {
      throw new Error('文章来源已改变，未读取');
    }
    const rawURL = original.link?.url;
    const url = articleURL(rawURL);
    if (!url) {
      if (rawURL && !/^https?:\/\/mp\.weixin\.qq\.com[/:?]/i.test(rawURL)) {
        return event as T & { link?: { url: string }; article?: EnrichedArticle };
      }
      throw new Error('这条文章消息没有可核对的公众号链接，未仅凭标题回复');
    }
    const title = titleOf(event);
    const cached = this.store.db
      .prepare('SELECT * FROM article_cache WHERE url=?')
      .get(url) as CachedArticleRow | undefined;
    if (cached && this.now() - cached.fetched_at < 3600000 && norm(cached.title) === norm(title)) {
      return {
        ...event,
        link: { url },
        article: { ...verifyArticle(cached, title), status: 'read', cached: true },
      };
    }
    let article: VerifiedArticle<ParsedArticle>;
    try {
      article = await this.http(url, title, signal);
    } catch {
      signal.throwIfAborted();
      try {
        const read = await this.cua.readArticle({ event, rule, url }, signal);
        article = verifyArticle({ ...read, url, method: 'wechat' }, title);
      } catch (guiError) {
        signal.throwIfAborted();
        if (
          cached &&
          norm(cached.title) === norm(title) &&
          createHash('sha256').update(cached.text).digest('hex') === cached.hash
        ) {
          return {
            ...event,
            link: { url },
            article: {
              ...verifyArticle(cached, title),
              status: 'read',
              cached: true,
              snapshot: true,
              refreshFailed: true,
            },
          };
        }
        throw guiError;
      }
    }
    const hash = createHash('sha256').update(article.text).digest('hex');
    const fetchedAt = this.now();
    this.store.db
      .prepare(
        'INSERT INTO article_cache VALUES (?,?,?,?,?,?) ON CONFLICT(url) DO UPDATE SET title=excluded.title,text=excluded.text,method=excluded.method,fetched_at=excluded.fetched_at,hash=excluded.hash',
      )
      .run(url, article.title ?? '', article.text, article.method ?? '', fetchedAt, hash);
    this.store.db.exec(
      'DELETE FROM article_cache WHERE url NOT IN (SELECT url FROM article_cache ORDER BY fetched_at DESC LIMIT 200)',
    );
    return {
      ...event,
      link: { url },
      article: { ...article, status: 'read', hash, fetched_at: fetchedAt },
    };
  }
}
