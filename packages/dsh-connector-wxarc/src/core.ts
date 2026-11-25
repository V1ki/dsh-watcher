import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { articleURL } from './article-url.js';

export const STREAMS = {
  text: '/text/events',
  sns: '/sns/events',
  media: '/events',
} as const;

export type StreamKind = keyof typeof STREAMS;

export interface QuoteData {
  status: 'available' | 'missing';
  body?: string;
  sender?: string;
  text?: string;
  truncated?: boolean;
  type?: number;
  target_id?: number;
}

export interface MentionInfo {
  status: string;
  sourceKey?: string;
  recipients?: string[];
  toSelf?: boolean;
}

export interface GroupMemberIdentity {
  id: string;
  nickname?: string;
  groupNickname?: string;
  uiName: string;
  uniqueUiName: boolean;
}

export interface SenderIdentity {
  id: string;
  nickname?: string;
  groupNickname?: string;
  uiName?: string;
  uniqueUiName?: boolean;
  mentions?: MentionInfo;
  botNames?: string[];
  groupMembers?: GroupMemberIdentity[];
}

export interface EventArticle {
  status?: string;
  title?: string;
  url?: string;
  text?: string;
  snapshot?: boolean;
  fetched_at?: string | number;
  [key: string]: unknown;
}

export interface EventImage {
  sticker?: boolean;
  thumbnailOnly?: boolean;
  variant?: 'high' | 'image' | 'thumb';
  [key: string]: unknown;
}

export interface EventBatch {
  messages: WxarcEvent[];
  background?: WxarcEvent[];
  notice?: string;
  replyContext?: WxarcEvent[];
}

export interface MemoTriggerContext {
  memoId: string;
  targetSessionId?: string | null;
  title?: string;
  basis: string;
  windowStart?: string | null;
  windowEnd?: string | null;
}

export interface WxarcEvent {
  id: number;
  kind: StreamKind;
  session?: string;
  session_name?: string;
  sender?: string;
  text?: string;
  user_name?: string;
  tid?: string;
  type?: string;
  ts?: number;
  local_type?: number;
  created_at?: number;
  item_id?: number;
  link?: { url: string };
  quote?: QuoteData;
  seq?: number;
  received_at?: string;
  senderId?: string;
  sourceId?: string;
  sourceKey?: string;
  generation?: string;
  account?: string;
  senderIdentity?: SenderIdentity;
  groupMembers?: GroupMemberIdentity[];
  mentions?: MentionInfo;
  botNames?: string[];
  batch?: EventBatch;
  article?: EventArticle;
  image?: EventImage;
  manualRequestedAt?: number;
  dshRunId?: string;
  memoTrigger?: MemoTriggerContext;
}

export interface StoredEvent extends WxarcEvent {
  seq: number;
  received_at: string;
}

export interface CursorRow {
  id: number;
  anchor: string | null;
}

export interface ListEventsOptions {
  kind?: StreamKind | '';
  query?: string;
  limit?: number;
  before?: number;
}

export interface StoreSummary {
  cursors: Record<StreamKind, number>;
  retained: number;
}

export interface ListenerConfig {
  url: string;
  pollMs: number;
  retain: number;
}

export interface SourceHealth {
  running: boolean;
  wechatRunning: boolean;
  textStatus: string;
  lastTextSuccess: number | null;
  textError: string | null;
  missingKeys: number;
  mediaError: string | null;
}

export interface ListenerState {
  connected: boolean;
  lastSuccess: string | null;
  lastError: string | null;
  sourceHealth: SourceHealth | null;
  startedAt: string;
}

export interface ListenerStatus extends ListenerState, StoreSummary {
  healthy: boolean;
  url: string;
  pollMs: number;
  retainPerStream: number;
  automaticAI: boolean;
}

export type Fetcher = (
  url: string,
  init: { signal: AbortSignal; redirect: RequestRedirect },
) => Promise<Response>;

interface BootstrapResponse {
  health?: {
    wechat_root?: string;
    store?: string;
    wechat_running?: boolean;
    listener?: {
      running?: boolean;
      text?: {
        status?: string;
        last_success?: number | null;
        last_error?: unknown;
        missing_keys?: unknown[];
      };
      media?: {
        last_error?: unknown;
      };
    };
  };
  cursors?: Partial<Record<StreamKind, unknown>>;
}

interface StoredEventRow {
  seq: number;
  payload: string;
  received_at: string;
}

export function isQuote(event: { kind?: string; local_type?: number; text?: string }): boolean {
  return (
    event.kind === 'text' &&
    typeof event.local_type === 'number' &&
    event.local_type % 4294967296 === 49 &&
    (Math.floor(event.local_type / 4294967296) === 57 || Boolean(event.text?.startsWith('[引用] ')))
  );
}

export function quoteData(row: Record<string, unknown>): QuoteData | null {
  if (!isQuote({ ...row, kind: 'text' }) || !row.quote || typeof row.quote !== 'object') {
    return null;
  }
  const q = row.quote as Record<string, unknown>;
  const out: QuoteData = { status: q.status === 'available' ? 'available' : 'missing' };
  const limits: Array<['body' | 'sender' | 'text', number]> = [
    ['body', 4000],
    ['sender', 200],
    ['text', 4000],
  ];
  for (const [key, limit] of limits) {
    if (typeof q[key] === 'string') out[key] = q[key].slice(0, limit);
  }
  if (typeof q.text === 'string' && q.text.length > 4000) out.truncated = true;
  if (typeof q.type === 'number' && Number.isSafeInteger(q.type)) out.type = q.type;
  if (typeof q.target_id === 'number' && Number.isSafeInteger(q.target_id) && q.target_id > 0) {
    out.target_id = q.target_id;
  }
  return out;
}

export function messageBody(event: { kind?: string; local_type?: number; text?: string }): string {
  return isQuote(event)
    ? (event.text ?? '').replace(/^\[(?:引用|链接\/文件)\]\s?/, '')
    : (event.text as string);
}

export function endpoint(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error('wxarc 地址必须是本机回环 HTTP 根地址');
  }
  return url.origin;
}

export function normalize(kind: StreamKind, row: unknown): WxarcEvent {
  if (!row || typeof row !== 'object') throw new Error('wxarc 返回了无效事件 ID');
  const record = row as Record<string, unknown>;
  if (typeof record.id !== 'number' || !Number.isSafeInteger(record.id) || record.id <= 0) {
    throw new Error('wxarc 返回了无效事件 ID');
  }
  const out: WxarcEvent = { id: record.id, kind };
  const stringKeys = [
    'session',
    'session_name',
    'sender',
    'text',
    'user_name',
    'tid',
    'type',
  ] as const;
  for (const key of stringKeys) {
    if (typeof record[key] === 'string') out[key] = record[key];
  }
  const numberKeys = ['ts', 'local_type', 'created_at', 'item_id'] as const;
  for (const key of numberKeys) {
    const val = record[key];
    if (typeof val === 'number' && Number.isFinite(val)) out[key] = val;
  }
  const rawLink = record.link as { url?: unknown } | undefined;
  const link = articleURL(rawLink?.url);
  if (link) out.link = { url: link };
  const quote = kind === 'text' ? quoteData(record) : null;
  if (quote) out.quote = quote;
  return out;
}

function anchor(row: WxarcEvent): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        row.id,
        row.kind,
        row.session,
        row.ts,
        row.text,
        row.tid,
        row.item_id,
        row.created_at,
      ]),
    )
    .digest('hex');
}

export class Store {
  dir: string;
  db: DatabaseSync;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const file = join(dir, 'events.sqlite');
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cursors (kind TEXT PRIMARY KEY, id INTEGER NOT NULL, anchor TEXT);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, event_id INTEGER NOT NULL, payload TEXT NOT NULL, received_at TEXT NOT NULL, UNIQUE(kind,event_id));`);
    for (const kind of Object.keys(STREAMS)) {
      this.db.prepare('INSERT OR IGNORE INTO cursors VALUES (?,0,NULL)').run(kind);
    }
  }

  bind(identity: string): void {
    this.db.prepare('INSERT OR IGNORE INTO meta VALUES (?,?)').run('source', identity);
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get('source') as
      | { value: string }
      | undefined;
    if (row?.value !== identity) {
      throw new Error('wxarc 账号或来源已改变；请核查后为新来源配置独立数据目录');
    }
  }

  cursor(kind: StreamKind): CursorRow {
    return this.db
      .prepare('SELECT id,anchor FROM cursors WHERE kind=?')
      .get(kind) as unknown as CursorRow;
  }

  commit(kind: StreamKind, expected: number, rows: WxarcEvent[], retain: number): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.cursor(kind).id !== expected) {
        throw new Error('监听游标被其他实例更新，稍后重试');
      }
      let previous = expected;
      for (const row of rows) {
        if (row.kind !== kind || row.id <= previous) {
          throw new Error('wxarc 事件顺序异常，未推进游标');
        }
        this.db
          .prepare('INSERT INTO events(kind,event_id,payload,received_at) VALUES (?,?,?,?)')
          .run(kind, row.id, JSON.stringify(row), new Date().toISOString());
        previous = row.id;
      }
      if (rows.length) {
        this.db
          .prepare('UPDATE cursors SET id=?,anchor=? WHERE kind=?')
          .run(previous, anchor(rows.at(-1)!), kind);
      }
      this.db
        .prepare(
          'DELETE FROM events WHERE kind=? AND seq NOT IN (SELECT seq FROM events WHERE kind=? ORDER BY seq DESC LIMIT ?)',
        )
        .run(kind, kind, retain);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  list({ kind = '', query = '', limit = 100, before = 0 }: ListEventsOptions = {}): StoredEvent[] {
    if (kind && !(kind in STREAMS)) throw new Error('未知事件类型');
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 200 ||
      !Number.isSafeInteger(before) ||
      before < 0 ||
      typeof query !== 'string' ||
      query.length > 200
    ) {
      throw new Error('查询参数无效');
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM events WHERE (?='' OR kind=?) AND (?=0 OR seq<?) AND (?='' OR instr(lower(payload),lower(?))>0) ORDER BY seq DESC LIMIT ?`,
      )
      .all(kind, kind, before, before, query, query, limit) as unknown as StoredEventRow[];
    return rows.map((r) => ({
      ...(JSON.parse(r.payload) as WxarcEvent),
      seq: r.seq,
      received_at: r.received_at,
    }));
  }

  summary(): StoreSummary {
    const cursors = Object.fromEntries(
      (Object.keys(STREAMS) as StreamKind[]).map((k) => [k, this.cursor(k).id]),
    ) as Record<StreamKind, number>;
    const countRow = this.db.prepare('SELECT COUNT(*) AS n FROM events').get() as unknown as {
      n: number;
    };
    return { cursors, retained: countRow.n };
  }

  close(): void {
    this.db.close();
  }
}

export class Listener {
  config: ListenerConfig;
  store: Store;
  fetcher: Fetcher;
  base: string;
  controller: AbortController;
  state: ListenerState;
  wechatRoot?: string;

  constructor(config: ListenerConfig, store: Store, fetcher: Fetcher = fetch) {
    this.config = config;
    this.store = store;
    this.fetcher = fetcher;
    this.base = endpoint(config.url);
    this.controller = new AbortController();
    this.state = {
      connected: false,
      lastSuccess: null,
      lastError: null,
      sourceHealth: null,
      startedAt: new Date().toISOString(),
    };
  }

  async get(path: string): Promise<unknown> {
    const response = await this.fetcher(this.base + path, {
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`wxarc HTTP ${response.status}`);
    const reader = response.body!.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 8 * 1024 * 1024) throw new Error('wxarc 单次响应超过 8 MiB');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  async enrichQuote(event: WxarcEvent): Promise<WxarcEvent> {
    if (!isQuote(event) || event.quote?.text) return event;
    const rows = (await this.get(`/ui/refresh?kind=text&ids=${event.id}`)) as Array<
      Record<string, unknown>
    >;
    const row = rows.find((r) => r.id === event.id);
    const matchKeys = ['session', 'text', 'ts', 'local_type'] as const;
    if (!row || matchKeys.some((k) => row[k] !== event[k])) {
      throw new Error('引用消息来源已改变');
    }
    return { ...event, quote: quoteData(row) || { status: 'missing' } };
  }

  async tick(): Promise<void> {
    const boot = (await this.get('/ui/bootstrap')) as BootstrapResponse;
    if (!boot.health?.wechat_root || !boot.health?.store) {
      throw new Error('wxarc 来源尚未就绪');
    }
    this.store.bind(JSON.stringify([this.base, boot.health.store, boot.health.wechat_root]));
    this.wechatRoot = boot.health.wechat_root;
    const source = boot.health.listener;
    this.state.sourceHealth = {
      running: source?.running === true,
      wechatRunning: boot.health.wechat_running === true,
      textStatus: source?.text?.status ?? 'unknown',
      lastTextSuccess: source?.text?.last_success ?? null,
      textError: source?.text?.last_error ? 'wxarc 消息采集出错，请检查 wxarc' : null,
      missingKeys: source?.text?.missing_keys?.length ?? 0,
      mediaError: source?.media?.last_error ? 'wxarc 媒体采集出错，请检查 wxarc' : null,
    };
    for (const [kind, path] of Object.entries(STREAMS) as Array<[StreamKind, string]>) {
      const saved = this.store.cursor(kind);
      const tail = boot.cursors?.[kind];
      if (typeof tail !== 'number' || !Number.isSafeInteger(tail) || tail < saved.id) {
        throw new Error(`${kind} 事件库回退，已停止推进游标，请核查 wxarc 数据`);
      }
      const raw = await this.get(`${path}?since_id=${Math.max(0, saved.id - 1)}&wait=0`);
      if (!Array.isArray(raw) || raw.length > 200) {
        throw new Error('wxarc 事件响应格式无效');
      }
      const rows = raw.map((row) => normalize(kind, row));
      if (saved.id) {
        if (rows[0]?.id !== saved.id || anchor(rows[0]) !== saved.anchor) {
          throw new Error(`${kind} 事件来源不匹配，已停止推进游标，请核查是否重建了 wxarc 索引`);
        }
        rows.shift();
      }
      this.store.commit(kind, saved.id, rows, this.config.retain);
    }
    this.state.connected = true;
    this.state.lastError = null;
    this.state.lastSuccess = new Date().toISOString();
  }

  async run(): Promise<void> {
    while (!this.controller.signal.aborted) {
      try {
        await this.tick();
      } catch (error: unknown) {
        if (this.controller.signal.aborted) break;
        this.state.connected = false;
        const rawMessage =
          typeof error === 'object' &&
          error !== null &&
          'message' in error &&
          (error as { message?: unknown }).message
            ? String((error as { message: unknown }).message)
            : String(error);
        this.state.lastError =
          error instanceof SyntaxError ? 'wxarc 返回了无效 JSON' : rawMessage.slice(0, 250);
      }
      await new Promise<void>((resolve) => {
        if (this.controller.signal.aborted) return resolve();
        const finish = () => {
          clearTimeout(timer);
          this.controller.signal.removeEventListener('abort', finish);
          resolve();
        };
        const timer = setTimeout(finish, this.config.pollMs);
        this.controller.signal.addEventListener('abort', finish, { once: true });
      });
    }
  }

  status(): ListenerStatus {
    const h = this.state.sourceHealth;
    const fresh = Boolean(h?.lastTextSuccess && Date.now() / 1000 - h.lastTextSuccess < 120);
    return {
      ...this.state,
      ...this.store.summary(),
      healthy: Boolean(
        this.state.connected &&
          h?.running &&
          h?.wechatRunning &&
          h?.textStatus === 'active' &&
          !h?.textError &&
          !h?.mediaError &&
          !h?.missingKeys &&
          fresh,
      ),
      url: this.base,
      pollMs: this.config.pollMs,
      retainPerStream: this.config.retain,
      automaticAI: false,
    };
  }

  stop(): void {
    this.controller.abort();
  }
}
