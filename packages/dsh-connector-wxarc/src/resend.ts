import { join } from 'node:path';
import { openReadOnly, sourceMessage, validateAccount } from './source.js';
import { isQuote, messageBody } from './core.js';
import type { WxarcEvent } from './core.js';

export interface ArchiveHistoryRow {
  id: number;
  ts: number;
  sender: string;
  local_type: number;
  text: string;
}

interface OriginalMsgRow {
  session: string;
  ts: number;
  text: string;
  sender: string;
}

export const OBSTRUCTED = '微信会话列表被遮挡，没有可核对的点击位置；未点击或发送';

const RETRYABLE_EXACT_DETAILS = [
  OBSTRUCTED,
  '当前会话中未找到触发回复的原消息',
  '无法确定原消息气泡中的文字位置',
  '原文在本会话重复，无法唯一定位对应的引用消息',
  '无法唯一定位需要引用的原消息',
  '需要引用的消息没有完整显示',
  '没有唯一的微信引用框',
  '微信引用框中的发言人或原文不一致',
];

const RETRYABLE_DETAIL_PREFIXES = [
  '找不到微信原生引用菜单',
  '无法唯一确认微信原生引用菜单',
];

export const retryableDetail = (detail: string): boolean => {
  const text = (detail || '').trim();
  if (!text) return false;
  if (RETRYABLE_EXACT_DETAILS.includes(text)) return true;
  if (text.includes('未覆盖') || text.includes('无法安全清理')) return false;
  return RETRYABLE_DETAIL_PREFIXES.some((prefix) => text.startsWith(prefix));
};

export function archiveHistory(
  home: string,
  event: WxarcEvent,
  ownId: string | undefined,
  root: string | undefined,
): ArchiveHistoryRow[] {
  const source = sourceMessage(home, event);
  validateAccount(source, ownId, root);
  if (
    !source.account ||
    source.sourceKey !== event.sourceKey ||
    source.senderId !== event.senderId ||
    source.generation !== event.generation
  ) {
    throw Error('wxarc 原消息或索引版本变化');
  }
  const index = openReadOnly(join(home, 'index.db'));
  let anchor: number | undefined;
  try {
    const row = index
      .prepare('SELECT search_msg_id FROM live_event_sources WHERE event_id=? AND source_key=?')
      .get(event.id, event.sourceKey ?? null) as unknown as { search_msg_id?: number } | undefined;
    anchor = row?.search_msg_id;
    if (!anchor) throw Error('wxarc 缺少原消息的位置');
  } finally {
    index.close();
  }

  const search = openReadOnly(join(home, 'search.db'));
  try {
    search.exec('BEGIN');
    const generationRow = search
      .prepare("SELECT value FROM meta WHERE key='index_generation'")
      .get() as unknown as { value?: string } | undefined;
    const generation = generationRow?.value;
    const original = search
      .prepare('SELECT session,ts,text,sender FROM msgs WHERE id=?')
      .get(anchor) as unknown as OriginalMsgRow | undefined;
    if (
      generation !== source.generation ||
      !original ||
      original.session !== event.session ||
      original.ts !== event.ts ||
      original.text !== event.text ||
      original.sender !== event.senderId
    ) {
      throw Error('无法核对 wxarc 原消息');
    }
    const rows = search
      .prepare(
        'SELECT id,ts,sender,local_type,text FROM msgs WHERE session=? AND (ts>? OR (ts=? AND id>?)) ORDER BY ts,id LIMIT 257',
      )
      .all(event.session ?? null, event.ts ?? 0, event.ts ?? 0, anchor) as unknown as ArchiveHistoryRow[];
    if (rows.length > 256) throw Error('会话已有大量新消息');
    return rows;
  } finally {
    search.close();
  }
}

export function matchHistory(
  rows: ArchiveHistoryRow[],
  own: string,
  text: string,
  names: string[] | string[][] = [],
): ArchiveHistoryRow[] {
  const groups: string[][] = Array.isArray(names[0])
    ? (names as string[][]).map((g) => Array.from(new Set(g.filter(Boolean)))).filter((g) => g.length > 0)
    : (() => {
        const single = Array.from(new Set((names as string[]).filter(Boolean)));
        return single.length ? [single] : [];
      })();
  let prefixes = [''];
  for (const group of groups) {
    const next: string[] = [];
    for (const prefix of prefixes) {
      for (const name of group) {
        for (const space of ['\u2005', ' ']) {
          next.push(prefix + '@' + name + space);
          if (next.length >= 256) break;
        }
        if (next.length >= 256) break;
      }
      if (next.length >= 256) break;
    }
    prefixes = next;
  }
  const expected = new Set(prefixes.map((prefix) => prefix + text));
  return rows.filter((row) => {
    const event = { ...row, kind: 'text' as const };
    return (
      row.sender === own &&
      (row.local_type === 1 || isQuote(event)) &&
      expected.has(messageBody(event))
    );
  });
}
