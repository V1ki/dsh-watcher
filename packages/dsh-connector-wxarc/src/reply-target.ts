import type { WxarcEvent } from './core.js';

export interface ReplyTargetResult {
  event: WxarcEvent;
  mention: boolean;
  quote: boolean;
}

export const replyMessages = (event: WxarcEvent): WxarcEvent[] => [
  ...(event.batch?.replyContext || []),
  ...(event.batch?.messages || [event]),
];

export function isNativeMention(event: WxarcEvent, ownId: string): boolean {
  return Boolean(
    event.session?.endsWith('@chatroom') &&
      event.mentions?.status === 'verified' &&
      event.mentions.sourceKey === event.sourceKey &&
      Boolean(event.senderId) &&
      event.mentions.recipients?.includes(ownId),
  );
}

export function replyTarget(
  event: WxarcEvent,
  decision: { action: string; replyTo?: string },
  ownId: string,
): ReplyTargetResult | null {
  if (event.kind !== 'text' || !['reply', 'sticker'].includes(decision.action)) return null;
  const all = replyMessages(event);
  const native = all.filter((e) => isNativeMention(e, ownId));
  const index = /^message:(\d+)$/.exec(decision.replyTo || '');
  let selected: WxarcEvent | null | undefined = index ? all[Number(index[1]) - 1] : null;
  if (index && !selected) throw Error('引用消息不在当前批次');
  if (native.length) {
    if (selected && !native.includes(selected)) throw Error('本批次必须选择实际 @ 机器人的消息');
    selected ||= native.at(-1);
  } else if (!selected && decision.replyTo === 'current') {
    selected = event.batch?.messages?.at(-1) || event;
  }
  if (!selected) return null;
  if (selected.session !== event.session || !selected.sourceKey || !selected.senderId) {
    throw Error('引用目标缺少同会话稳定身份');
  }
  return { event: selected, mention: isNativeMention(selected, ownId), quote: native.length <= 1 };
}

export function replyTargetContext(event: Partial<WxarcEvent>): string {
  const all = replyMessages(event as WxarcEvent);
  const targets = all
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.mentions?.status === 'verified' && e.mentions.toSelf);
  if (!targets.length) return '';
  return '原生 @：' + targets.map(({ i }) => `message:${i + 1}`).join('、');
}

export const REPLY_TARGET_RULES =
  '聊天输入中的 [message:序号] 是本轮消息编号，原生 @ 行仅列出经程序核验、真正 @ 机器人的消息编号。它不是新的聊天发言。只有一条原生 @ 消息时，程序默认 @ 回该发言人并尝试引用原消息；同一轮有多条原生 @ 消息时，不引用任何原消息，仍只生成一组连贯回复，可用 replyTo 选择要 @ 回的发言人。无论同一人还是多人连续 @，均按消息条数判断。选择编号时返回 "replyTo":"message:序号"，只能选择本轮列出的原生 @ 目标；省略或 current 时默认最后一条原生 @ 消息。没有原生 @ 时，"replyTo":"current" 表示引用本轮最后一条消息，仅在明确要求或确有必要时使用。群聊中如需主动原生 @ 群内其他成员或同时 @ 多人，可附加 "mentions":["微信ID", ...]（最多 3 人，仅从本群成员列表中选择，不要填自己或标记 duplicateName:true 的重名成员）；若同时有 replyTo，程序会自动把发言人排在前面并与 mentions 去重合并。text 只写回复正文，不自行添加 @昵称或复述引用；真实 @ 和引用由程序完成，引用不可用时可能直接回复。此前未发送的目标只作待回应上下文，不是新收到的消息。';
