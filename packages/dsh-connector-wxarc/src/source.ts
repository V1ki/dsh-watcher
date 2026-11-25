import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WxarcEvent } from './core.js';

export interface SourceMessage extends WxarcEvent {
  senderId: string;
  sourceId: string;
  sourceKey: string;
  generation?: string;
  account?: string;
}

export interface ContactOptions {
  project: string;
  home: string;
  python: string;
}

export interface ContactTarget {
  kind?: string;
  sourceId: string;
  title: string;
  search?: string;
  wechatId?: string;
  route?: string;
  uniqueTitle?: boolean;
  error?: string;
}

interface SnsEventRow {
  tid: string;
  user_name: string;
  ts: number;
  text: string;
}

interface LiveEventSourceRow {
  event_id: number;
  search_msg_id: number;
  shard: string;
  table_name: string;
  local_id: number;
  fingerprint: string;
  source_key: string;
}

interface SearchMsgRow {
  id: number;
  session: string;
  sender: string;
  ts: number;
  local_type: number;
  text: string;
}

interface MetaRow {
  value: string;
}

export function openReadOnly(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000;');
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}

export function sourceMessage(home: string, event: WxarcEvent): SourceMessage {
  if (event.kind === 'sns') {
    if (!event.user_name || !event.tid) throw new Error('朋友圈事件缺少作者或动态 ID');
    const index = openReadOnly(join(home, 'index.db'));
    try {
      const row = index
        .prepare('SELECT tid,user_name,ts,text FROM sns_events WHERE id=?')
        .get(event.id) as unknown as SnsEventRow | undefined;
      const keys = ['tid', 'user_name', 'ts', 'text'] as const;
      if (!row || keys.some((k) => row[k] !== event[k])) {
        throw new Error('朋友圈来源映射已改变');
      }
      return {
        ...event,
        senderId: event.user_name,
        sourceId: event.user_name,
        sourceKey: `sns:${event.tid}`,
      };
    } finally {
      index.close();
    }
  }
  if (event.kind !== 'text') throw new Error('媒体事件不能独立触发回复');
  const index = openReadOnly(join(home, 'index.db'));
  let search: DatabaseSync | undefined;
  try {
    search = openReadOnly(join(home, 'search.db'));
    const origin = index
      .prepare('SELECT * FROM live_event_sources WHERE event_id=?')
      .get(event.id) as unknown as LiveEventSourceRow | undefined;
    if (!origin) throw new Error('消息缺少稳定来源映射');
    const row = search
      .prepare('SELECT * FROM msgs WHERE id=?')
      .get(origin.search_msg_id) as unknown as SearchMsgRow | undefined;
    if (
      !row ||
      row.session !== event.session ||
      row.text !== event.text ||
      row.ts !== event.ts ||
      row.local_type !== event.local_type
    ) {
      throw new Error('消息来源映射已改变');
    }
    const fp = createHash('sha256')
      .update(JSON.stringify([row.session, row.sender, row.ts, row.local_type, row.text]))
      .digest('hex');
    if (fp !== origin.fingerprint) throw new Error('消息来源指纹不匹配');
    const identityRow = search
      .prepare("SELECT value FROM meta WHERE key='source_identity'")
      .get() as unknown as MetaRow | undefined;
    const identity = JSON.parse(identityRow?.value || '{}') as { account?: string };
    const generationRow = search
      .prepare("SELECT value FROM meta WHERE key='index_generation'")
      .get() as unknown as MetaRow | undefined;
    const generation = generationRow?.value;
    const key = createHash('sha256')
      .update(
        JSON.stringify([identity.account, origin.shard, origin.table_name, origin.local_id, fp]),
      )
      .digest('hex');
    if (
      key !== origin.source_key ||
      !generation ||
      !row.sender ||
      row.sender.startsWith('unknown:')
    ) {
      throw new Error('无法可靠识别消息发送者');
    }
    return {
      ...event,
      senderId: row.sender,
      sourceId: row.session,
      sourceKey: origin.source_key,
      generation,
      account: identity.account,
    };
  } finally {
    index.close();
    search?.close();
  }
}

export function validateAccount(
  source: { account?: string },
  ownId: string | undefined,
  wechatRoot: string | undefined,
): void {
  if (!wechatRoot || !ownId || !resolve(wechatRoot).split('/').at(-1)?.startsWith(`${ownId}_`)) {
    throw new Error('配置的本人微信 ID 与 wxarc 当前账号不一致');
  }
  if (source.account && resolve(source.account) !== resolve(wechatRoot, 'db_storage')) {
    throw new Error('搜索索引的账号与当前 wxarc 账号不一致');
  }
}

export async function contactTarget(
  options: ContactOptions,
  event: WxarcEvent,
  root: string | undefined,
  signal?: AbortSignal,
): Promise<ContactTarget> {
  const request = {
    project: options.project,
    home: options.home,
    root,
    sourceId: event.kind === 'sns' ? event.user_name : event.session,
    kind: event.kind,
    event: { tid: event.tid, text: event.text, ts: event.ts },
  };
  return new Promise<ContactTarget>((resolvePromise, reject) => {
    const child = execFile(
      options.python,
      [fileURLToPath(new URL('./contacts.py', import.meta.url))],
      {
        timeout: 25000,
        maxBuffer: 65536,
        signal,
        env: {
          ...process.env,
          PATH: `${dirname(options.python)}:/usr/local/bin:/opt/homebrew/bin:${process.env.PATH || '/usr/bin:/bin'}`,
        },
      },
      (error, stdout) => {
        if (error) return reject(new Error('通讯录读取失败，未猜测收件人'));
        try {
          const target = JSON.parse(stdout) as ContactTarget;
          if (target.error || target.sourceId !== request.sourceId || !target.title) {
            throw new Error();
          }
          resolvePromise(target);
        } catch {
          reject(new Error('通讯录结果无效'));
        }
      },
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify(request));
  });
}
