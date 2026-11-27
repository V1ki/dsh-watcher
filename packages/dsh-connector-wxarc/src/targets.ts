import type { DatabaseSync } from 'node:sqlite';

export interface TargetDirectoryEntry {
  chatId: string;
  roomKey: string;
  sessionId: string | null;
  title: string;
  isGroup: boolean;
  circle?: string;
}

export type TargetLookupResult =
  | {
      ok: true;
      status: 'unique';
      target: TargetDirectoryEntry;
    }
  | {
      ok: false;
      status: 'not_found' | 'ambiguous';
      query: string;
      candidates: TargetDirectoryEntry[];
      error: string;
    };

export interface MemoTargetBinding {
  chatId: string;
  roomKey: string;
  notifyWechatChatId: string;
  targetSessionId: string | null;
  title?: string | null;
}

export interface MemoTargetResolution {
  status: 'matched' | 'not_found' | 'ambiguous';
  target?: MemoTargetBinding;
  candidates?: Array<{ chatId: string; roomKey: string; title?: string | null }>;
  detail?: string;
}

export interface MemoTargetQuery {
  roomKey?: string | null;
  targetChatId?: string | null;
  notifyWechatChatId?: string | null;
  targetSessionId?: string | null;
  targetName?: string | null;
}

export interface TargetDirectorySource {
  db: DatabaseSync;
  rules?: Array<{ kind?: string; sourceId?: string; title?: string }>;
  circleForRoom?: (chatId: string) => string | undefined;
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

function normalizeRoomKey(chatId: string): string {
  return `wechat:${chatId}`;
}

function stripRoomPrefix(value: string): string {
  return value.startsWith('wechat:') ? value.slice('wechat:'.length) : value;
}

function safeParseContext(raw: string): { event?: { kind?: string; session?: string } } | null {
  try {
    const parsed = JSON.parse(raw) as { event?: { kind?: string; session?: string } };
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function collectTargets(source: TargetDirectorySource): TargetDirectoryEntry[] {
  const byChatId = new Map<string, TargetDirectoryEntry>();

  const upsert = (chatIdRaw: string, titleRaw?: string | null, sessionIdRaw?: string | null): void => {
    const chatId = chatIdRaw.trim();
    if (!chatId) return;
    const title = (titleRaw || '').trim();
    const sessionId = (sessionIdRaw || '').trim() || null;
    const existing = byChatId.get(chatId);
    if (existing) {
      if (title && (!existing.title || existing.title === chatId)) {
        existing.title = title;
      }
      if (sessionId && !existing.sessionId) {
        existing.sessionId = sessionId;
      }
      return;
    }
    const circle = source.circleForRoom?.(chatId);
    byChatId.set(chatId, {
      chatId,
      roomKey: normalizeRoomKey(chatId),
      sessionId,
      title: title || chatId,
      isGroup: chatId.endsWith('@chatroom'),
      ...(circle ? { circle } : {}),
    });
  };

  for (const rule of source.rules || []) {
    if (rule && rule.kind === 'text' && typeof rule.sourceId === 'string') {
      upsert(rule.sourceId, rule.title);
    }
  }

  try {
    const eventRows = source.db
      .prepare(
        "SELECT json_extract(payload,'$.session') AS id, MAX(NULLIF(json_extract(payload,'$.session_name'), '')) AS title FROM events WHERE kind='text' GROUP BY id",
      )
      .all() as unknown as Array<{ id: string | null; title: string | null }>;
    for (const row of eventRows) {
      if (typeof row.id === 'string' && row.id.trim()) {
        upsert(row.id, row.title);
      }
    }
  } catch {
    void 0;
  }

  try {
    const convRows = source.db
      .prepare('SELECT session_id, title, context FROM dsh_conversations ORDER BY created_at DESC')
      .all() as unknown as Array<{ session_id: string; title: string; context: string }>;
    for (const row of convRows) {
      const parsed = safeParseContext(row.context);
      if (parsed?.event?.kind === 'text' && typeof parsed.event.session === 'string') {
        const cleanTitle = row.title.replace(/^微信\s*·\s*/, '').replace(/\s*·\s*[^·]+$/, '').trim();
        upsert(parsed.event.session, cleanTitle || undefined, row.session_id);
      }
    }
  } catch {
    void 0;
  }

  return Array.from(byChatId.values()).sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
}

export function listRoomTargets(
  source: TargetDirectorySource,
  limit = DEFAULT_LIST_LIMIT,
): TargetDirectoryEntry[] {
  const safeLimit = Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(limit || DEFAULT_LIST_LIMIT)));
  return collectTargets(source).slice(0, safeLimit);
}

export function resolveUniqueTarget(
  source: TargetDirectorySource,
  rawQuery: string,
): TargetLookupResult {
  const query = typeof rawQuery === 'string' ? rawQuery.trim() : '';
  if (!query) {
    return {
      ok: false,
      status: 'not_found',
      query: '',
      candidates: [],
      error: '请提供要解析的微信群名、chatId、roomKey 或 sessionId。',
    };
  }

  const all = collectTargets(source);
  const stripped = stripRoomPrefix(query);

  const exactId = all.filter(
    (entry) =>
      entry.chatId === query ||
      entry.chatId === stripped ||
      entry.roomKey === query ||
      (entry.sessionId !== null && entry.sessionId === query),
  );
  if (exactId.length === 1) {
    return { ok: true, status: 'unique', target: exactId[0] };
  }
  if (exactId.length > 1) {
    return {
      ok: false,
      status: 'ambiguous',
      query,
      candidates: exactId.slice(0, 10),
      error: `目标 "${query}" 匹配到多个会话，请提供唯一的 chatId 或 roomKey；严禁猜测或回退到私聊。`,
    };
  }

  const lower = query.toLowerCase();
  const exactTitle = all.filter((entry) => entry.title.trim().toLowerCase() === lower);
  if (exactTitle.length === 1) {
    return { ok: true, status: 'unique', target: exactTitle[0] };
  }
  if (exactTitle.length > 1) {
    return {
      ok: false,
      status: 'ambiguous',
      query,
      candidates: exactTitle.slice(0, 10),
      error: `名称 "${query}" 存在 ${exactTitle.length} 个同名聊天，请从候选列表中指定唯一 roomKey/chatId；严禁猜测或回退到私聊。`,
    };
  }

  const partialTitle = all.filter((entry) => entry.title.trim().toLowerCase().includes(lower));
  if (partialTitle.length === 1) {
    return { ok: true, status: 'unique', target: partialTitle[0] };
  }
  if (partialTitle.length > 1) {
    return {
      ok: false,
      status: 'ambiguous',
      query,
      candidates: partialTitle.slice(0, 10),
      error: `关键词 "${query}" 匹配到 ${partialTitle.length} 个聊天，请明确唯一群名或 roomKey/chatId；严禁猜测或回退到私聊。`,
    };
  }

  return {
    ok: false,
    status: 'not_found',
    query,
    candidates: [],
    error: `花名册中找不到与 "${query}" 匹配的微信会话；已拒绝操作，严禁回退到当前私聊。`,
  };
}

export function resolveMemoTarget(
  source: TargetDirectorySource,
  query: MemoTargetQuery,
): MemoTargetResolution {
  const fields: Array<{ label: string; value: string }> = [];
  const entries: Array<[string, string | null | undefined]> = [
    ['roomKey', query.roomKey],
    ['targetChatId', query.targetChatId],
    ['notifyWechatChatId', query.notifyWechatChatId],
    ['targetSessionId', query.targetSessionId],
    ['targetName', query.targetName],
  ];
  for (const [label, raw] of entries) {
    if (typeof raw === 'string' && raw.trim()) {
      fields.push({ label, value: raw.trim() });
    }
  }
  if (fields.length === 0) {
    return {
      status: 'not_found',
      detail: '未提供可解析的微信目标会话；严禁回退到当前私聊。',
    };
  }

  let matched: TargetDirectoryEntry | null = null;
  for (const field of fields) {
    const res = resolveUniqueTarget(source, field.value);
    if (!res.ok) {
      if (res.status === 'ambiguous') {
        return {
          status: 'ambiguous',
          candidates: res.candidates.map((c) => ({
            chatId: c.chatId,
            roomKey: c.roomKey,
            title: c.title,
          })),
          detail: res.error,
        };
      }
      return {
        status: 'not_found',
        detail: res.error,
      };
    }
    if (matched && matched.chatId !== res.target.chatId) {
      return {
        status: 'not_found',
        detail: `目标字段冲突（${field.label}="${field.value}" 与其他目标字段指向不同会话），已拒绝操作。`,
      };
    }
    matched = res.target;
  }

  if (!matched) {
    return {
      status: 'not_found',
      detail: '未找到匹配的微信目标会话。',
    };
  }

  return {
    status: 'matched',
    target: {
      chatId: matched.chatId,
      roomKey: matched.roomKey,
      notifyWechatChatId: matched.chatId,
      targetSessionId: matched.sessionId,
      title: matched.title,
    },
  };
}
