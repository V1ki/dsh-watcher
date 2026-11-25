import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import type { SenderIdentity, WxarcEvent } from './core.js';
import type { ContactOptions } from './source.js';

export type { SenderIdentity };

interface CachedIdentity {
  identity: SenderIdentity;
  expires: number;
}

const DELIMITERS: Record<string, string> = {
  '[': '［',
  ']': '］',
  '(': '（',
  ')': '）',
  '#': '＃',
};

const clean = (value: unknown): string =>
  typeof value === 'string'
    ? value
        .replace(/[\r\n\t\u0000-\u001f\u007f\u2028\u2029]/g, ' ')
        .replace(/[\[\]()#]/g, (c) => DELIMITERS[c] ?? c)
        .trim()
        .slice(0, 200)
    : '';

export function speakerLabel(event: {
  senderId?: string;
  sender?: string;
  senderIdentity?: SenderIdentity;
}): string {
  const id = clean(event.senderId);
  if (!id) return clean(event.sender) || '未知群成员';
  const identity: Partial<SenderIdentity> =
    event.senderIdentity && event.senderIdentity.id === event.senderId ? event.senderIdentity : {};
  const nickname = clean(identity.nickname);
  const fallback = event.sender !== event.senderId ? clean(event.sender) : '';
  const display = clean(identity.groupNickname) || nickname || fallback || '未知昵称';
  return `[${display}](${nickname || '未知昵称'}#${id})`;
}

export function createSenderEnricher(
  options: ContactOptions,
  root: () => string | undefined,
  { now = Date.now }: { now?: () => number } = {},
): (event: WxarcEvent, signal?: AbortSignal) => Promise<WxarcEvent> {
  const cache = new Map<string, CachedIdentity>();
  return async (event: WxarcEvent, signal?: AbortSignal): Promise<WxarcEvent> => {
    if (event.kind !== 'text' || !event.session?.endsWith('@chatroom') || !event.senderId) {
      return event;
    }
    const account = root();
    const isMemoTrigger = Boolean(event.memoTrigger);
    const key = JSON.stringify([
      account,
      event.session,
      event.senderId,
      isMemoTrigger ? 'memo' : event.sourceKey,
    ]);
    let entry = cache.get(key);
    if (!entry || entry.expires <= now()) {
      try {
        const identity = await new Promise<SenderIdentity>((resolve, reject) => {
          const child = execFile(
            options.python,
            [fileURLToPath(new URL('./contacts.py', import.meta.url))],
            {
              timeout: 25000,
              maxBuffer: 512 * 1024,
              signal,
              env: {
                ...process.env,
                PATH: `${dirname(options.python)}:/usr/local/bin:/opt/homebrew/bin:${process.env.PATH || '/usr/bin:/bin'}`,
              },
            },
            (error, stdout) => {
              if (error) return reject(error);
              try {
                const value = JSON.parse(stdout) as SenderIdentity;
                if (
                  value.id !== event.senderId ||
                  typeof value.nickname !== 'string' ||
                  typeof value.groupNickname !== 'string'
                ) {
                  throw Error('invalid sender identity');
                }
                resolve(value);
              } catch (e) {
                reject(e);
              }
            },
          );
          child.stdin?.on('error', () => {});
          child.stdin?.end(
            JSON.stringify({
              mode: 'sender',
              root: account,
              home: options.home,
              project: options.project,
              sourceId: event.session,
              senderId: event.senderId,
              includeMembers: true,
              ...(isMemoTrigger
                ? {}
                : {
                    event: {
                      id: event.id,
                      sourceKey: event.sourceKey,
                      ts: event.ts,
                      local_type: event.local_type,
                      text: event.text,
                    },
                  }),
            }),
          );
        });
        entry = { identity, expires: now() + 60000 };
        if (cache.size >= 1000) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(key, entry);
      } catch {
        signal?.throwIfAborted();
        return {
          ...event,
          mentions: { status: 'unavailable' },
          senderIdentity: { id: event.senderId, nickname: '', groupNickname: '' },
        };
      }
    }
    const groupMembers = Array.isArray(entry.identity.groupMembers)
      ? entry.identity.groupMembers.filter(
          (m) =>
            Boolean(m) &&
            typeof m.id === 'string' &&
            m.id.length > 0 &&
            m.id.length <= 200 &&
            typeof m.uiName === 'string' &&
            typeof m.uniqueUiName === 'boolean',
        )
      : [];
    return {
      ...event,
      mentions: entry.identity.mentions,
      senderIdentity: entry.identity,
      ...(groupMembers.length ? { groupMembers } : {}),
      botNames: Array.isArray(entry.identity.botNames)
        ? entry.identity.botNames.filter((n): n is string => typeof n === 'string' && n.length <= 200)
        : [],
    };
  };
}
