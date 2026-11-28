import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { replyTarget, replyTargetContext, isNativeMention } from '../src/reply-target.js';
import { batchContent } from '../src/batch.js';
import { decisionPrompt, parseDecision } from '../src/ai.js';
import { SwiftCua } from '../src/cua.js';
import { matchHistory } from '../src/resend.js';
import type { WxarcEvent } from '../src/core.js';
import type { ClipboardFn } from '../src/clipboard.js';

interface NativeFixtureOptions {
  ambiguousName?: boolean;
  missingTrigger?: boolean;
  noMentionEcho?: boolean;
  lowQuoteConfidence?: boolean;
  noQuote?: boolean;
  duplicatePicker?: boolean;
  cropOverhang?: number;
  avatarNoise?: boolean;
  nearbySender?: boolean;
  noPicker?: boolean;
  userEdited?: boolean;
  quoteChanged?: boolean;
  foreignQuote?: boolean;
  plainAt?: boolean;
  wrongPerson?: boolean;
}

interface ActionEntry {
  m: string;
  p: Record<string, unknown>;
}

interface RegionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FindTextMatch {
  windowId: number;
  confidence: number;
  text: string;
  rect: RegionRect;
}

const incoming = (n: number, at = true): WxarcEvent => ({
  id: n,
  kind: 'text',
  session: 'room@chatroom',
  senderId: `u${n}`,
  sourceKey: `k${n}`,
  local_type: 1,
  text: `消息${n}`,
  mentions: {
    status: 'verified',
    sourceKey: `k${n}`,
    recipients: at ? ['bot'] : [],
    toSelf: at,
  },
});

test('native mentions require source metadata, not names in prose or quotes', () => {
  assert.ok(isNativeMention(incoming(1), 'bot'));
  for (const e of [
    { ...incoming(1), mentions: undefined, text: '@bot 你好' },
    { ...incoming(1), mentions: { ...incoming(1).mentions!, sourceKey: 'changed' } },
    { ...incoming(1), session: 'private' },
    incoming(1, false),
  ]) {
    assert.ok(!isNativeMention(e, 'bot'));
  }
});

test('batch reply quotes actual @ message rather than later unrelated speaker, with bounded selection', () => {
  const first = incoming(1);
  const second = incoming(2);
  const last = incoming(3, false);
  const e: WxarcEvent = { ...last, batch: { messages: [first, second, last] } };
  assert.equal(replyTarget(e, { action: 'reply' }, 'bot')?.event, second);
  assert.equal(replyTarget(e, { action: 'reply', replyTo: 'current' }, 'bot')?.event, second);
  assert.equal(replyTarget(e, { action: 'reply', replyTo: 'message:1' }, 'bot')?.event, first);
  for (const replyTo of ['message:3', 'message:9']) {
    assert.throws(() => replyTarget(e, { action: 'reply', replyTo }, 'bot'));
  }
  assert.equal(replyTarget(e, { action: 'ignore' }, 'bot'), null);
  assert.ok(replyTargetContext(e).includes('message:2'));
  assert.ok(!replyTargetContext(e).includes('message:3'));
  assert.equal(
    parseDecision('{"action":"reply","text":"回答","replyTo":"message:2"}', 'text').replyTo,
    'message:2',
  );
});

test('superseded reply retains original mention; other-chat targets cannot escape the current chat', () => {
  const original = incoming(1);
  const extra = incoming(2, false);
  const e: WxarcEvent = { ...extra, batch: { messages: [extra], replyContext: [original] } };
  assert.equal(replyTarget(e, { action: 'reply' }, 'bot')?.event, original);
  original.session = 'other@chatroom';
  assert.throws(() => replyTarget(e, { action: 'reply' }, 'bot'), /同会话/);
});

test('XML mention parsing only trusts direct native recipient metadata', () => {
  execFileSync(
    process.env.WXARC_TEST_PYTHON || 'python3',
    [
      '-c',
      `
import importlib.util,sys
s=importlib.util.spec_from_file_location('m',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
assert m.parse_mentions('<msgsource><atuserlist><![CDATA[alice,bob,alice]]></atuserlist></msgsource>')==['alice','bob']
assert m.parse_mentions('<msgsource><quoted><atuserlist>bot</atuserlist></quoted></msgsource>')==[]
assert m.parse_mentions('<msgsource><alnode/></msgsource>')==[]
for x in ['<bad/>','<msgsource><atuserlist>a</atuserlist><atuserlist>b</atuserlist></msgsource>','<!DOCTYPE x><msgsource/>','<msgsource><atuserlist>a b</atuserlist></msgsource>']:
 try:m.parse_mentions(x)
 except ValueError:pass
 else:raise AssertionError(x)
`,
      new URL('../src/mention-source.py', import.meta.url).pathname,
    ],
    { stdio: 'pipe' },
  );
});

function nativeFixture(options: NativeFixtureOptions = {}) {
  let input = '';
  let quote = false;
  let sent = false;
  let count = 0;
  let body = '';
  const prefix = '\u2005@个人昵称\u2005';
  const actions: ActionEntry[] = [];
  const target: WxarcEvent = {
    ...incoming(1),
    text: '约在下午三点，带上资料',
    sender: 'raw_id',
    senderIdentity: {
      id: 'u1',
      nickname: '个人昵称',
      uiName: '群中备注',
      groupNickname: '群昵称',
      uniqueUiName: !options.ambiguousName,
    },
  };
  const job: {
    event: WxarcEvent;
    quoteEvent: WxarcEvent;
    rule: { title: string };
    decision: { action: 'reply'; text: string; replyTo?: string };
    mention: { id: string; name: string };
  } = {
    event: incoming(2, false),
    quoteEvent: target,
    rule: { title: '群' },
    decision: { action: 'reply', text: '三点见', replyTo: 'current' },
    mention: { id: 'u1', name: '群中备注' },
  };
  const quoteText = '引用 群中备注 的消息 : ' + target.text;
  const runner = async (_path: string, args: string[]) => {
    const m = args.at(-2) ?? '';
    const p = JSON.parse(args.at(-1) ?? '{}') as Record<string, unknown>;
    actions.push({ m, p });
    let result: Record<string, unknown> = {};
    if (m === 'getAppState') {
      result = {
        state: {
          info: {
            frontmostApp: 'com.tencent.xinWeChat',
            permissions: { accessibility: true },
            window: { id: 1, bounds: { x: 0, y: 0, width: 800, height: 800 } },
          },
          accessibility: {
            nodes: [
              { identifier: 'current_chat_name_label', value: '群' },
              {
                identifier: 'chat_input_field',
                index: 33,
                value: input,
                states: ['focused'],
                frame: { x: 300, y: 600, width: 400, height: 60 },
              },
              { identifier: 'chat_message_list', frame: { x: 300, y: 100, width: 400, height: 450 } },
              ...(!options.missingTrigger
                ? [
                    {
                      identifier: 'chat_bubble_item_view',
                      title: target.text,
                      frame: { x: 300, y: 200, width: 400, height: 60 },
                    },
                  ]
                : []),
              ...(quote
                ? [
                    { role: 'AXGroup', title: quoteText, frame: { x: 300, y: 670, width: 300, height: 30 } },
                    { role: 'AXButton', title: '删除引用消息', frame: { x: 700, y: 670, width: 20, height: 20 } },
                  ]
                : []),
              { role: 'AXButton', title: '发送', frame: { x: 700, y: 730, width: 60, height: 20 } },
              ...(sent
                ? [
                    {
                      identifier: 'chat_bubble_item_view',
                      title:
                        (options.noMentionEcho ? '' : prefix) +
                        job.decision.text +
                        (options.missingTrigger || options.lowQuoteConfidence || options.noQuote
                          ? ''
                          : '\n' + quoteText),
                    },
                  ]
                : []),
            ],
          },
        },
      };
    }
    if (m === 'findText') {
      const mention = p.text === '群中备注';
      const quoteMenu = p.text === '引用' || (p.text === '' && p.limit === 60);
      const matches: FindTextMatch[] = Array.from(
        { length: mention && options.duplicatePicker ? 2 : 1 },
        () => ({
          windowId: 1,
          confidence: !mention && !quoteMenu && options.lowQuoteConfidence ? 0.5 : 1,
          text: mention ? String(p.text) : quoteMenu ? '引用' : '约在下午三点,带上资料',
          rect: mention
            ? { x: 300, y: 560, width: 60, height: 20 }
            : quoteMenu
              ? { x: 400, y: 400, width: 40, height: 20 }
              : { x: 320, y: 220, width: 180, height: 20 },
        }),
      );
      result = { matches };
      if (mention) {
        const region = p.region as RegionRect;
        if (options.cropOverhang) matches[0].rect.x = region.x - options.cropOverhang;
        if (options.avatarNoise && region.x < 292) {
          result.matches = matches.map((item) => ({
            ...item,
            text: '& ' + item.text,
            confidence: 0.3,
          }));
        }
        if (options.nearbySender) {
          (result.matches as FindTextMatch[]).push({
            windowId: 1,
            confidence: 1,
            text: String(p.text),
            rect: { x: 370, y: 520, width: 60, height: 14 },
          });
        }
        if (options.noPicker) result.matches = [];
        if (options.userEdited) input = '用户刚写的草稿';
        if (options.quoteChanged) quote = false;
        if (options.foreignQuote) quote = true;
      }
    }
    if (m === 'click' && p.y === 410) quote = true;
    if (m === 'pressKey' && p.key === 'Shift+2') input = '@';
    if (m === 'pressKey' && p.key === 'Cmd+c') count++;
    if (m === 'typeText') {
      const typed = String(p.text ?? '');
      if (input === '@') input += typed;
      else {
        input += typed;
        body = typed;
      }
    }
    if (m === 'click' && p.y === 570) input = options.plainAt ? '@个人昵称 ' : '\uFFFC';
    if (m === 'pressKey' && p.key === 'Backspace') {
      input = '';
      body = '';
    }
    if (m === 'click' && p.y === 680) quote = false;
    if (m === 'click' && p.y === 740) {
      sent = true;
      input = '';
      quote = false;
    }
    return { stdout: JSON.stringify(result) };
  };
  const clipboard: ClipboardFn = async (r) =>
    r.action === 'snapshot'
      ? { count, items: [] }
      : r.action === 'read'
        ? { count, text: (options.wrongPerson ? '\u2005@另一人\u2005' : prefix) + body }
        : { restored: true };
  return {
    job,
    cua: new SwiftCua('/fake', runner, async () => {}, clipboard),
    actions,
    signal: AbortSignal.timeout(5000),
    setInput: (v: string) => {
      input = v;
    },
  };
}

test('native picker inserts member object and quotes earlier actual sender; prepare never sends', async () => {
  const f = nativeFixture();
  const commit = await f.cua.prepare(f.job, f.signal);
  assert.ok(f.actions.some((a) => a.m === 'pressKey' && a.p.key === 'Shift+2'));
  assert.ok(!f.actions.some((a) => a.m === 'click' && a.p.y === 740));
  assert.deepEqual(await commit(f.signal), { confirmed: true });
});

test('plain @ text, wrong member, duplicate names and ambiguous picker cannot be sent', async () => {
  for (const option of [
    { plainAt: true },
    { wrongPerson: true },
    { ambiguousName: true },
    { duplicatePicker: true },
  ]) {
    const f = nativeFixture(option);
    await assert.rejects(f.cua.prepare(f.job, f.signal));
    assert.ok(!f.actions.some((a) => a.m === 'click' && a.p.y === 740));
  }
});

test('replacing a native mention with identical plain text blocks sending and cleanup', async () => {
  const f = nativeFixture();
  const commit = await f.cua.prepare(f.job, f.signal);
  f.setInput('\u2005@个人昵称\u2005三点见');
  await assert.rejects(commit(f.signal), /原生 @/);
  await assert.rejects(commit.discard!(f.signal));
  assert.ok(!f.actions.some((a) => a.m === 'pressKey' && a.p.key === 'Backspace'));
});

test('superseded native mention and quote draft clears without sending', async () => {
  const f = nativeFixture();
  const commit = await f.cua.prepare(f.job, f.signal);
  await commit.discard!(f.signal);
  assert.ok(f.actions.some((a) => a.m === 'click' && a.p.y === 680));
  assert.ok(!f.actions.some((a) => a.m === 'click' && a.p.y === 740));
});

test('message author label above the picker is not a second native mention candidate', async () => {
  const f = nativeFixture({ nearbySender: true });
  const commit = await f.cua.prepare(f.job, f.signal);
  assert.ok(f.actions.some((a) => a.m === 'click' && a.p.y === 570));
  assert.ok(!f.actions.some((a) => a.m === 'click' && a.p.y === 527));
  await commit.discard!(f.signal);
});

test('missing or duplicate picker cleans only the exact owned query and quote', async () => {
  for (const opts of [{ noPicker: true }, { duplicatePicker: true }]) {
    const f = nativeFixture(opts);
    await assert.rejects(f.cua.prepare(f.job, f.signal), /已清理本次/);
    assert.ok(f.actions.some((a) => a.m === 'pressKey' && a.p.key === 'Backspace'));
    assert.ok(f.actions.some((a) => a.m === 'click' && a.p.y === 680));
    assert.ok(!f.actions.some((a) => a.m === 'click' && a.p.y === 740));
  }
});

test('picker failure does not erase changed user text or an unverified quote', async () => {
  for (const opts of [
    { noPicker: true, userEdited: true },
    { noPicker: true, quoteChanged: true },
  ]) {
    const f = nativeFixture(opts);
    await assert.rejects(f.cua.prepare(f.job, f.signal), /无法安全清理/);
    assert.ok(!f.actions.some((a) => a.m === 'pressKey' && a.p.key === 'Backspace'));
  }
});

test('missing source preserves verified native mention while omitting the quote', async () => {
  const f = nativeFixture({ missingTrigger: true });
  const commit = await f.cua.prepare(f.job, f.signal);
  assert.ok(f.actions.some((a) => a.m === 'pressKey' && a.p.key === 'Shift+2'));
  assert.ok(!f.actions.some((a) => a.m === 'scroll' || a.p.mouseButton === 'right'));
  const receipt = await commit(f.signal);
  assert.equal(receipt.confirmed, true);
  assert.match(receipt.detail ?? '', /取消引用并直接回复/);
});

test('unquoted fallback draft can be discarded without sending', async () => {
  const f = nativeFixture({ missingTrigger: true });
  const commit = await f.cua.prepare(f.job, f.signal);
  await commit.discard!(f.signal);
  assert.ok(f.actions.some((a) => a.m === 'pressKey' && a.p.key === 'Backspace'));
  assert.ok(!f.actions.some((a) => a.m === 'click' && (a.p.y === 680 || a.p.y === 740)));
});

test('unquoted mention failure cleans its own query but never a new user quote', async () => {
  const f = nativeFixture({ missingTrigger: true, noPicker: true });
  await assert.rejects(f.cua.prepare(f.job, f.signal), /已清理本次/);
  assert.ok(f.actions.some((a) => a.m === 'pressKey' && a.p.key === 'Backspace'));
  const changed = nativeFixture({ missingTrigger: true, noPicker: true, foreignQuote: true });
  await assert.rejects(changed.cua.prepare(changed.job, changed.signal), /无法安全清理/);
  assert.ok(!changed.actions.some((a) => a.m === 'pressKey' && a.p.key === 'Backspace'));
});

test('unquoted native mention is not confirmed by a reply bubble lacking the member name', async () => {
  const f = nativeFixture({ missingTrigger: true, noMentionEcho: true });
  const commit = await f.cua.prepare(f.job, f.signal);
  assert.equal((await commit(f.signal)).confirmed, false);
});

test('low-confidence quote position falls back to a verified native mention without opening a menu', async () => {
  const f = nativeFixture({ lowQuoteConfidence: true });
  const commit = await f.cua.prepare(f.job, f.signal);
  assert.ok(f.actions.some((a) => a.m === 'pressKey' && a.p.key === 'Shift+2'));
  assert.ok(
    !f.actions.some((a) => a.p.mouseButton === 'right' || (a.m === 'findText' && a.p.text === '引用')),
  );
  const receipt = await commit(f.signal);
  assert.equal(receipt.confirmed, true);
  assert.match(receipt.detail ?? '', /引用位置无法可靠识别/);
});

test('one native mention quotes, while multiple messages suppress quotes even from the same person', () => {
  const a = incoming(1);
  const b = incoming(2);
  const last = incoming(3, false);
  assert.equal(replyTarget(a, { action: 'reply' }, 'bot')?.quote, true);
  for (const second of [b, { ...b, senderId: a.senderId }]) {
    const e: WxarcEvent = { ...last, batch: { messages: [a, second, last] } };
    for (const replyTo of [undefined, 'current', 'message:1', 'message:2']) {
      const t = replyTarget(e, { action: 'reply', replyTo }, 'bot')!;
      assert.equal(t.quote, false);
      assert.equal(t.mention, true);
    }
  }
  const e: WxarcEvent = { ...b, batch: { replyContext: [a], messages: [b] } };
  assert.equal(replyTarget(e, { action: 'reply' }, 'bot')?.quote, false);
});

test('compact input has each message once and numbers retained and current targets correctly', () => {
  const a = incoming(1);
  const b: WxarcEvent = { ...incoming(2), senderId: 'u1' };
  const c = incoming(3, false);
  const e: WxarcEvent = { ...c, batch: { replyContext: [a], messages: [b, c] } };
  const text = batchContent(e)[0].text ?? '';
  for (const m of [a, b, c]) assert.equal(text.split(m.text!).length - 1, 1);
  assert.equal(replyTargetContext(e), '原生 @：message:1、message:2');
  assert.match(text, /\[message:1\]/);
  assert.match(text, /\[message:2\]/);
  assert.match(text, /\[message:3\]/);
  assert.ok(!text.includes('程序将为回复'));
  assert.ok(!text.includes('"senderId"'));
  assert.ok(!text.includes('输出其 replyTo'));
  assert.equal(replyTarget(e, { action: 'reply', replyTo: 'message:2' }, 'bot')?.event, b);
});

test('explicit no-quote delivery keeps native mention and never opens the quote menu', async () => {
  const f = nativeFixture({ noQuote: true });
  delete f.job.decision.replyTo;
  const commit = await f.cua.prepare(f.job, f.signal);
  assert.ok(f.actions.some((a) => a.m === 'pressKey' && a.p.key === 'Shift+2'));
  assert.ok(
    !f.actions.some((a) => a.p.mouseButton === 'right' || (a.m === 'findText' && a.p.text === '引用')),
  );
  assert.equal((await commit(f.signal)).confirmed, true);
});

test('mention OCR excludes avatar icons rather than accepting decorated names', async () => {
  const f = nativeFixture({ avatarNoise: true });
  const commit = await f.cua.prepare(f.job, f.signal);
  const search = f.actions.find((a) => a.m === 'findText' && a.p.text === '群中备注')!;
  const region = search.p.region as RegionRect;
  assert.equal(region.x, 292);
  assert.ok(region.width <= 100);
  assert.equal((await commit(f.signal)).confirmed, true);
});

test('subpixel OCR crop overhang is tolerated but hits outside the picker remain blocked', async () => {
  const f = nativeFixture({ cropOverhang: 0.2 });
  const commit = await f.cua.prepare(f.job, f.signal);
  await commit.discard!(f.signal);
  const outside = nativeFixture({ cropOverhang: 8 });
  await assert.rejects(outside.cua.prepare(outside.job, outside.signal));
  assert.ok(!outside.actions.some((a) => a.m === 'click' && a.p.y === 740));
});

test('long Chinese nickname uses wider/taller OCR band, retries animating picker with whitespace-normalized OCR, and still verifies native @ via pasteboard', async () => {
  const longName = '橘子不是唯一的水果';
  let input = '';
  let quote = false;
  let sent = false;
  let count = 0;
  let body = '';
  const prefix = `\u2005@${longName}\u2005`;
  let ocrCalls = 0;
  const actions: ActionEntry[] = [];
  const pauses: number[] = [];
  const target: WxarcEvent = {
    ...incoming(1),
    text: '约在下午三点，带上资料',
    sender: 'raw_id',
    senderIdentity: {
      id: 'u1',
      nickname: longName,
      uiName: longName,
      groupNickname: longName,
      uniqueUiName: true,
    },
  };
  const job = {
    event: incoming(2, false),
    quoteEvent: target,
    rule: { title: 'W集团' },
    decision: { action: 'reply' as const, text: '三点见', replyTo: 'current' },
    mention: { id: 'u1', name: longName },
  };
  const quoteText = `引用 ${longName} 的消息 : ${target.text}`;
  const runner = async (_path: string, args: string[]) => {
    const m = args.at(-2) ?? '';
    const p = JSON.parse(args.at(-1) ?? '{}') as Record<string, unknown>;
    actions.push({ m, p });
    let result: Record<string, unknown> = {};
    if (m === 'getAppState') {
      result = {
        state: {
          info: {
            frontmostApp: 'com.tencent.xinWeChat',
            permissions: { accessibility: true },
            window: { id: 1, bounds: { x: 0, y: 0, width: 800, height: 800 } },
          },
          accessibility: {
            nodes: [
              { identifier: 'current_chat_name_label', value: 'W集团' },
              {
                identifier: 'chat_input_field',
                index: 33,
                value: input,
                states: ['focused'],
                frame: { x: 300, y: 600, width: 400, height: 60 },
              },
              { identifier: 'chat_message_list', frame: { x: 300, y: 100, width: 400, height: 450 } },
              {
                identifier: 'chat_bubble_item_view',
                title: target.text,
                frame: { x: 300, y: 200, width: 400, height: 60 },
              },
              ...(quote
                ? [
                    { role: 'AXGroup', title: quoteText, frame: { x: 300, y: 670, width: 300, height: 30 } },
                    { role: 'AXButton', title: '删除引用消息', frame: { x: 700, y: 670, width: 20, height: 20 } },
                  ]
                : []),
              { role: 'AXButton', title: '发送', frame: { x: 700, y: 730, width: 60, height: 20 } },
              ...(sent
                ? [
                    {
                      identifier: 'chat_bubble_item_view',
                      title: prefix + job.decision.text + '\n' + quoteText,
                    },
                  ]
                : []),
            ],
          },
        },
      };
    }
    if (m === 'findText') {
      if (p.text === '引用' || (p.text === '' && p.limit === 60)) {
        result = {
          matches: [{ windowId: 1, confidence: 1, text: '引用', rect: { x: 400, y: 400, width: 40, height: 20 } }],
        };
      } else if (p.text === target.text!.slice(0, 4)) {
        result = {
          matches: [
            {
              windowId: 1,
              confidence: 1,
              text: '约在下午三点,带上资料',
              rect: { x: 320, y: 220, width: 180, height: 20 },
            },
          ],
        };
      } else {
        ocrCalls++;
        if (ocrCalls === 3 && p.text === '') {
          result = {
            matches: [
              {
                windowId: 1,
                confidence: 0.9,
                text: '橘子 不是唯一的水果',
                rect: { x: 340, y: 536, width: 220, height: 20 },
              },
            ],
          };
        } else {
          result = { matches: [] };
        }
      }
    }
    if (m === 'click' && p.y === 410) quote = true;
    if (m === 'pressKey' && p.key === 'Shift+2') input = '@';
    if (m === 'pressKey' && p.key === 'Cmd+c') count++;
    if (m === 'typeText') {
      const typed = String(p.text ?? '');
      if (input === '@') input += typed;
      else {
        input += typed;
        body = typed;
      }
    }
    if (m === 'click' && p.y === 546) input = '\uFFFC';
    if (m === 'click' && p.y === 740) {
      sent = true;
      input = '';
      quote = false;
    }
    return { stdout: JSON.stringify(result) };
  };
  const clipboard: ClipboardFn = async (r) =>
    r.action === 'snapshot'
      ? { count, items: [] }
      : r.action === 'read'
        ? { count, text: prefix + body }
        : { restored: true };
  const cua = new SwiftCua(
    '/fake',
    runner,
    async (ms: number) => {
      pauses.push(ms);
    },
    clipboard,
  );
  const commit = await cua.prepare(job, AbortSignal.timeout(5000));
  const firstMentionSearch = actions.find((a) => a.m === 'findText' && a.p.text === longName)!;
  const region = firstMentionSearch.p.region as RegionRect;
  assert.ok(region.width >= 300 && region.width <= 420);
  assert.equal(region.height, 70);
  assert.ok(pauses.includes(200));
  assert.deepEqual(await commit(AbortSignal.timeout(5000)), { confirmed: true });
});

test('mention failure runs streamlined direct cleanup of typed query and quote with minimal CUA calls', async () => {
  const f = nativeFixture({ noPicker: true });
  await assert.rejects(f.cua.prepare(f.job, f.signal), /已清理本次/);
  const escapeIndex = f.actions.findIndex((a) => a.m === 'pressKey' && a.p.key === 'Escape');
  assert.ok(escapeIndex > 0);
  const cleanupActions = f.actions.slice(escapeIndex - 1);
  assert.ok(cleanupActions.length <= 8, `expected <=8 cleanup calls, got ${cleanupActions.length}`);
  assert.ok(!cleanupActions.some((a) => a.m === 'axFocus'));
  assert.ok(cleanupActions.some((a) => a.m === 'pressKey' && a.p.key === 'Backspace'));
  assert.ok(cleanupActions.some((a) => a.m === 'click' && a.p.y === 680));
  assert.ok(!f.actions.some((a) => a.m === 'click' && a.p.y === 740));
});

test('mention failure cleanup re-focuses editor if Escape blurs it, then clears query and quote', async () => {
  let input = '';
  let quote = false;
  let focused = true;
  const actions: ActionEntry[] = [];
  const target: WxarcEvent = {
    ...incoming(1),
    text: '约在下午三点，带上资料',
    sender: 'raw_id',
    senderIdentity: {
      id: 'u1',
      nickname: '个人昵称',
      uiName: '群中备注',
      groupNickname: '群昵称',
      uniqueUiName: true,
    },
  };
  const job = {
    event: incoming(2, false),
    quoteEvent: target,
    rule: { title: '群' },
    decision: { action: 'reply' as const, text: '三点见', replyTo: 'current' },
    mention: { id: 'u1', name: '群中备注' },
  };
  const quoteText = '引用 群中备注 的消息 : ' + target.text;
  const runner = async (_path: string, args: string[]) => {
    const m = args.at(-2) ?? '';
    const p = JSON.parse(args.at(-1) ?? '{}') as Record<string, unknown>;
    actions.push({ m, p });
    let result: Record<string, unknown> = {};
    if (m === 'getAppState') {
      result = {
        state: {
          info: {
            frontmostApp: 'com.tencent.xinWeChat',
            permissions: { accessibility: true },
            window: { id: 1, bounds: { x: 0, y: 0, width: 800, height: 800 } },
          },
          accessibility: {
            nodes: [
              { identifier: 'current_chat_name_label', value: '群' },
              {
                identifier: 'chat_input_field',
                index: 33,
                value: input,
                states: focused ? ['focused'] : [],
                frame: { x: 300, y: 600, width: 400, height: 60 },
              },
              { identifier: 'chat_message_list', frame: { x: 300, y: 100, width: 400, height: 450 } },
              {
                identifier: 'chat_bubble_item_view',
                title: target.text,
                frame: { x: 300, y: 200, width: 400, height: 60 },
              },
              ...(quote
                ? [
                    { role: 'AXGroup', title: quoteText, frame: { x: 300, y: 670, width: 300, height: 30 } },
                    { role: 'AXButton', title: '删除引用消息', frame: { x: 700, y: 670, width: 20, height: 20 } },
                  ]
                : []),
              { role: 'AXButton', title: '发送', frame: { x: 700, y: 730, width: 60, height: 20 } },
            ],
          },
        },
      };
    }
    if (m === 'findText') {
      if (p.text === '引用' || (p.text === '' && p.limit === 60)) {
        result = {
          matches: [{ windowId: 1, confidence: 1, text: '引用', rect: { x: 400, y: 400, width: 40, height: 20 } }],
        };
      } else if (p.text === target.text!.slice(0, 4)) {
        result = {
          matches: [
            {
              windowId: 1,
              confidence: 1,
              text: '约在下午三点,带上资料',
              rect: { x: 320, y: 220, width: 180, height: 20 },
            },
          ],
        };
      } else {
        result = { matches: [] };
      }
    }
    if (m === 'click' && p.y === 410) quote = true;
    if (m === 'pressKey' && p.key === 'Shift+2') input = '@';
    if (m === 'typeText') input += String(p.text ?? '');
    if (m === 'pressKey' && p.key === 'Escape') focused = false;
    if (m === 'axFocus') focused = true;
    if (m === 'pressKey' && p.key === 'Backspace') input = '';
    if (m === 'click' && p.y === 680) quote = false;
    return { stdout: JSON.stringify(result) };
  };
  const cua = new SwiftCua('/fake', runner, async () => {});
  await assert.rejects(cua.prepare(job, AbortSignal.timeout(5000)), /已清理本次/);
  const escapeIndex = actions.findIndex((a) => a.m === 'pressKey' && a.p.key === 'Escape');
  const cleanupActions = actions.slice(escapeIndex);
  assert.ok(cleanupActions.some((a) => a.m === 'axFocus'));
  assert.equal(input, '');
  assert.equal(quote, false);
});

test('parseDecision validates optional mentions array and decisionPrompt exposes group members', () => {
  assert.deepEqual(
    parseDecision(
      '{"action":"reply","text":"收到","replyTo":"message:1","mentions":["wxid_a","wxid_b","wxid_a"]}',
      'text',
    ).mentions,
    ['wxid_a', 'wxid_b'],
  );
  assert.equal(
    parseDecision('{"action":"reply","text":"收到","mentions":[]}', 'text').mentions,
    undefined,
  );
  for (const bad of [
    '{"action":"reply","text":"收到","mentions":["a","b","c","d"]}',
    '{"action":"reply","text":"收到","mentions":["bad id"]}',
    '{"action":"reply","text":"收到","mentions":[123]}',
    '{"action":"ignore","text":"","mentions":["wxid_a"]}',
    '{"action":"comment","text":"好","mentions":["wxid_a"]}',
  ]) {
    assert.throws(() => parseDecision(bad, bad.includes('comment') ? 'sns' : 'text'));
  }
  const { system } = decisionPrompt(
    { instructions: '按规则回复' },
    {
      kind: 'text',
      session: 'room@chatroom',
      sender: '甲',
      text: '@bot 帮我 @ 一下乙',
      groupMembers: [
        { id: 'wxid_a', nickname: '甲', groupNickname: '', uiName: '甲', uniqueUiName: true },
        { id: 'wxid_b', nickname: '乙', groupNickname: '橘子', uiName: '橘子', uniqueUiName: true },
        { id: 'wxid_c', nickname: '重名', groupNickname: '', uiName: '重名', uniqueUiName: false },
      ],
    },
    [],
  );
  assert.ok(system.includes('wxid_b'));
  assert.ok(system.includes('橘子'));
  assert.ok(system.includes('"duplicateName":true'));
});

test('SwiftCua inserts multiple consecutive native mentions including third-party members and confirms bubble', async () => {
  let input = '';
  let sent = false;
  let count = 0;
  let copied = '';
  let body = '';
  const actions: ActionEntry[] = [];
  const target: WxarcEvent = {
    ...incoming(1),
    text: '@bot 你 @ 一下我和橘子试试',
    sender: 'u1',
    senderIdentity: {
      id: 'u1',
      nickname: '甲',
      uiName: '甲',
      groupNickname: '甲',
      uniqueUiName: true,
    },
  };
  const job = {
    event: incoming(1),
    quoteEvent: target,
    rule: { title: '群' },
    decision: { action: 'reply' as const, text: '都叫上了' },
    mentions: [
      { id: 'u1', name: '甲', nickname: '甲', groupNickname: '甲', uniqueUiName: true },
      {
        id: 'u2',
        name: '橘子水果',
        nickname: '橘子水果',
        groupNickname: '橘子水果',
        uniqueUiName: true,
      },
    ],
  };
  const runner = async (_path: string, args: string[]) => {
    const m = args.at(-2) ?? '';
    const p = JSON.parse(args.at(-1) ?? '{}') as Record<string, unknown>;
    actions.push({ m, p });
    let result: Record<string, unknown> = {};
    if (m === 'getAppState') {
      result = {
        state: {
          info: {
            frontmostApp: 'com.tencent.xinWeChat',
            permissions: { accessibility: true },
            window: { id: 1, bounds: { x: 0, y: 0, width: 800, height: 800 } },
          },
          accessibility: {
            nodes: [
              { identifier: 'current_chat_name_label', value: '群' },
              {
                identifier: 'chat_input_field',
                index: 33,
                value: input,
                states: ['focused'],
                frame: { x: 300, y: 600, width: 400, height: 60 },
              },
              { identifier: 'chat_message_list', frame: { x: 300, y: 100, width: 400, height: 450 } },
              {
                identifier: 'chat_bubble_item_view',
                title: target.text,
                frame: { x: 300, y: 200, width: 400, height: 60 },
              },
              { role: 'AXButton', title: '发送', frame: { x: 700, y: 730, width: 60, height: 20 } },
              ...(sent
                ? [
                    {
                      identifier: 'chat_bubble_item_view',
                      title: '@甲 @橘子水果 都叫上了',
                    },
                  ]
                : []),
            ],
          },
        },
      };
    }
    if (m === 'findText') {
      if (p.text === '甲') {
        result = {
          matches: [{ windowId: 1, confidence: 1, text: '甲', rect: { x: 305, y: 560, width: 30, height: 20 } }],
        };
      } else if (p.text === '橘子水果') {
        result = {
          matches: [
            {
              windowId: 1,
              confidence: 1,
              text: '橘子水果',
              rect: { x: 480, y: 560, width: 80, height: 20 },
            },
          ],
        };
      }
    }
    if (m === 'pressKey' && p.key === 'Shift+2') input += '@';
    if (m === 'pressKey' && p.key === 'Cmd+c') count++;
    if (m === 'typeText') {
      const typed = String(p.text ?? '');
      input += typed;
      if (!input.includes('@')) body = typed;
    }
    if (m === 'click' && p.y === 570 && Number(p.x) < 400) {
      input = '\uFFFC';
      copied = '\u2005@甲\u2005';
    }
    if (m === 'click' && p.y === 570 && Number(p.x) > 400) {
      input = '\uFFFC\uFFFC';
      copied = '\u2005@甲\u2005@橘子水果\u2005';
    }
    if (m === 'click' && p.y === 740) {
      sent = true;
      input = '';
    }
    return { stdout: JSON.stringify(result) };
  };
  const clipboard: ClipboardFn = async (r) =>
    r.action === 'snapshot'
      ? { count, items: [] }
      : r.action === 'read'
        ? { count, text: copied + body }
        : { restored: true };
  const cua = new SwiftCua('/fake', runner, async () => {}, clipboard);
  const commit = await cua.prepare(job, AbortSignal.timeout(5000));
  const secondSearch = actions.find((a) => a.m === 'findText' && a.p.text === '橘子水果')!;
  assert.ok((secondSearch.p.region as RegionRect).width >= 400);
  assert.deepEqual(await commit(AbortSignal.timeout(5000)), { confirmed: true });

  const nonUniqueJob = {
    ...job,
    mentions: [{ id: 'u2', name: '橘子水果', uniqueUiName: false }],
  };
  await assert.rejects(cua.prepare(nonUniqueJob, AbortSignal.timeout(5000)), /可核对的成员身份/);
});

test('multi-mention picker failure tags failed mentionId and matchHistory verifies multi-mention receipts', async () => {
  let input = '';
  let count = 0;
  const target: WxarcEvent = {
    ...incoming(1),
    text: '@bot 叫两人',
    sender: 'u1',
    senderIdentity: { id: 'u1', nickname: '甲', uiName: '甲', groupNickname: '甲', uniqueUiName: true },
  };
  const job = {
    event: incoming(1),
    quoteEvent: target,
    rule: { title: '群' },
    decision: { action: 'reply' as const, text: '好' },
    mentions: [
      { id: 'u1', name: '甲', nickname: '甲', groupNickname: '甲', uniqueUiName: true },
      { id: 'u2', name: '失踪人', nickname: '失踪人', groupNickname: '', uniqueUiName: true },
    ],
  };
  const runner = async (_path: string, args: string[]) => {
    const m = args.at(-2) ?? '';
    const p = JSON.parse(args.at(-1) ?? '{}') as Record<string, unknown>;
    if (m === 'getAppState') {
      return {
        stdout: JSON.stringify({
          state: {
            info: {
              frontmostApp: 'com.tencent.xinWeChat',
              permissions: { accessibility: true },
              window: { id: 1, bounds: { x: 0, y: 0, width: 800, height: 800 } },
            },
            accessibility: {
              nodes: [
                { identifier: 'current_chat_name_label', value: '群' },
                {
                  identifier: 'chat_input_field',
                  index: 33,
                  value: input,
                  states: ['focused'],
                  frame: { x: 300, y: 600, width: 400, height: 60 },
                },
                { identifier: 'chat_message_list', frame: { x: 300, y: 100, width: 400, height: 450 } },
                {
                  identifier: 'chat_bubble_item_view',
                  title: target.text,
                  frame: { x: 300, y: 200, width: 400, height: 60 },
                },
                { role: 'AXButton', title: '发送', frame: { x: 700, y: 730, width: 60, height: 20 } },
              ],
            },
          },
        }),
      };
    }
    if (m === 'findText') {
      if (p.text === '甲') {
        return {
          stdout: JSON.stringify({
            matches: [{ windowId: 1, confidence: 1, text: '甲', rect: { x: 305, y: 560, width: 30, height: 20 } }],
          }),
        };
      }
      return { stdout: JSON.stringify({ matches: [] }) };
    }
    if (m === 'pressKey' && p.key === 'Shift+2') input += '@';
    if (m === 'pressKey' && p.key === 'Cmd+c') count++;
    if (m === 'typeText') input += String(p.text ?? '');
    if (m === 'click' && p.y === 570) input = '\uFFFC';
    if (m === 'pressKey' && p.key === 'Backspace') input = '';
    return { stdout: '{}' };
  };
  const clipboard: ClipboardFn = async (r) =>
    r.action === 'snapshot'
      ? { count, items: [] }
      : r.action === 'read'
        ? { count, text: '\u2005@甲\u2005' }
        : { restored: true };
  const cua = new SwiftCua('/fake', runner, async () => {}, clipboard);
  await assert.rejects(cua.prepare(job, AbortSignal.timeout(5000)), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /已清理本次未发送的 @ 查询和引用/);
    assert.equal((err as { mentionId?: string }).mentionId, 'u2');
    return true;
  });
  assert.equal(input, '');

  const rows = [
    { id: 10, ts: 100, sender: 'bot', local_type: 1, text: '@甲\u2005@橘子水果\u2005都叫上了' },
  ];
  assert.equal(
    matchHistory(rows, 'bot', '都叫上了', [
      ['甲'],
      ['橘子水果'],
    ]).length,
    1,
  );
});

test('selectMention pauses after click, retries transient post-click getAppState 1007, and does not re-click when AX pill settles slowly', async () => {
  let input = '';
  let sent = false;
  let count = 0;
  let body = '';
  let postClickStateReads = 0;
  let candidateClicks = 0;
  const events: string[] = [];
  const target: WxarcEvent = {
    ...incoming(1),
    text: '查一下状态',
    sender: 'u1',
    senderIdentity: {
      id: 'u1',
      nickname: 'viki',
      uiName: 'viki',
      groupNickname: 'viki',
      uniqueUiName: true,
    },
  };
  const job = {
    event: incoming(1),
    quoteEvent: target,
    rule: { title: '群' },
    decision: { action: 'reply' as const, text: '好的' },
    mention: { id: 'u1', name: 'viki' },
  };
  const runner = async (_path: string, args: string[]) => {
    const m = args.at(-2) ?? '';
    const p = JSON.parse(args.at(-1) ?? '{}') as Record<string, unknown>;
    events.push(m);
    if (m === 'getAppState') {
      if (candidateClicks > 0) {
        postClickStateReads++;
        if (postClickStateReads === 1) {
          throw Object.assign(new Error('timeout'), { code: 1007, stderr: 'CUAService timeout' });
        }
        if (postClickStateReads === 2) {
          input = '@viki';
        } else if (postClickStateReads === 3) {
          input = '\uFFFC';
        }
      }
      return {
        stdout: JSON.stringify({
          state: {
            info: {
              frontmostApp: 'com.tencent.xinWeChat',
              permissions: { accessibility: true },
              window: { id: 1, bounds: { x: 0, y: 0, width: 800, height: 800 } },
            },
            accessibility: {
              nodes: [
                { identifier: 'current_chat_name_label', value: '群' },
                {
                  identifier: 'chat_input_field',
                  index: 33,
                  value: input,
                  states: ['focused'],
                  frame: { x: 300, y: 600, width: 400, height: 60 },
                },
                { identifier: 'chat_message_list', frame: { x: 300, y: 100, width: 400, height: 450 } },
                {
                  identifier: 'chat_bubble_item_view',
                  title: target.text,
                  frame: { x: 300, y: 200, width: 400, height: 60 },
                },
                { role: 'AXButton', title: '发送', frame: { x: 700, y: 730, width: 60, height: 20 } },
                ...(sent
                  ? [{ identifier: 'chat_bubble_item_view', title: '@viki 好的' }]
                  : []),
              ],
            },
          },
        }),
      };
    }
    if (m === 'findText') {
      return {
        stdout: JSON.stringify({
          matches: [{ windowId: 1, confidence: 1, text: 'viki', rect: { x: 305, y: 560, width: 40, height: 20 } }],
        }),
      };
    }
    if (m === 'pressKey' && p.key === 'Shift+2') input = '@';
    if (m === 'pressKey' && p.key === 'Cmd+c') count++;
    if (m === 'typeText') {
      const typed = String(p.text ?? '');
      input += typed;
      if (!input.startsWith('@')) body = typed;
    }
    if (m === 'click' && p.y === 570) {
      candidateClicks++;
      events.push('click-mention');
    }
    if (m === 'click' && p.y === 740) {
      sent = true;
      input = '';
    }
    return { stdout: '{}' };
  };
  const clipboard: ClipboardFn = async (r) =>
    r.action === 'snapshot'
      ? { count, items: [] }
      : r.action === 'read'
        ? { count, text: '\u2005@viki\u2005' + body }
        : { restored: true };
  const cua = new SwiftCua(
    '/fake',
    runner,
    async (ms) => {
      events.push(`pause:${ms}`);
    },
    clipboard,
  );
  const commit = await cua.prepare(job, AbortSignal.timeout(5000));
  assert.equal(candidateClicks, 1);
  const clickIdx = events.indexOf('click-mention');
  assert.equal(events[clickIdx + 1], 'pause:180');
  assert.equal(events[clickIdx + 2], 'getAppState');
  assert.equal(events[clickIdx + 3], 'pause:150');
  assert.equal(events[clickIdx + 4], 'getAppState');
  assert.equal(events[clickIdx + 5], 'pause:180');
  assert.deepEqual(await commit(AbortSignal.timeout(5000)), { confirmed: true });
});

test('selectMention post-click failure cleans up inserted \\uFFFC pill and quote so next job is not cascade-blocked, but never wipes user edits', async () => {
  let input = '';
  let quote = false;
  let sent = false;
  let count = 0;
  let body = '';
  let postClickFailuresLeft = 3;
  let editAfterClick = false;
  const actions: ActionEntry[] = [];
  const target: WxarcEvent = {
    ...incoming(1),
    text: '查一下状态',
    sender: 'u1',
    senderIdentity: {
      id: 'u1',
      nickname: 'viki',
      uiName: 'viki',
      groupNickname: 'viki',
      uniqueUiName: true,
    },
  };
  const quoteText = '引用 viki 的消息 : ' + target.text;
  const job = {
    event: incoming(1),
    quoteEvent: target,
    rule: { title: '群' },
    decision: { action: 'reply' as const, text: '收到了', replyTo: 'current' },
    mention: { id: 'u1', name: 'viki' },
  };
  const runner = async (_path: string, args: string[]) => {
    const m = args.at(-2) ?? '';
    const p = JSON.parse(args.at(-1) ?? '{}') as Record<string, unknown>;
    actions.push({ m, p });
    if (m === 'getAppState') {
      if (input.includes('\uFFFC') && postClickFailuresLeft > 0) {
        postClickFailuresLeft--;
        throw Object.assign(new Error('timeout'), { code: 1007, stderr: 'CUAService timeout' });
      }
      return {
        stdout: JSON.stringify({
          state: {
            info: {
              frontmostApp: 'com.tencent.xinWeChat',
              permissions: { accessibility: true },
              window: { id: 1, bounds: { x: 0, y: 0, width: 800, height: 800 } },
            },
            accessibility: {
              nodes: [
                { identifier: 'current_chat_name_label', value: '群' },
                {
                  identifier: 'chat_input_field',
                  index: 33,
                  value: input,
                  states: ['focused'],
                  frame: { x: 300, y: 600, width: 400, height: 60 },
                },
                { identifier: 'chat_message_list', frame: { x: 300, y: 100, width: 400, height: 450 } },
                {
                  identifier: 'chat_bubble_item_view',
                  title: target.text,
                  frame: { x: 300, y: 200, width: 400, height: 60 },
                },
                ...(quote
                  ? [
                      { role: 'AXGroup', title: quoteText, frame: { x: 300, y: 670, width: 300, height: 30 } },
                      { role: 'AXButton', title: '删除引用消息', frame: { x: 700, y: 670, width: 20, height: 20 } },
                    ]
                  : []),
                { role: 'AXButton', title: '发送', frame: { x: 700, y: 730, width: 60, height: 20 } },
                ...(sent
                  ? [{ identifier: 'chat_bubble_item_view', title: '\u2005@viki\u2005收到了\n' + quoteText }]
                  : []),
              ],
            },
          },
        }),
      };
    }
    if (m === 'findText') {
      if (p.text === '' && p.limit === 60) {
        return {
          stdout: JSON.stringify({
            matches: [{ windowId: 1, confidence: 1, text: '引用', rect: { x: 400, y: 400, width: 40, height: 20 } }],
          }),
        };
      }
      if (p.text === target.text!.slice(0, 4)) {
        return {
          stdout: JSON.stringify({
            matches: [{ windowId: 1, confidence: 1, text: target.text, rect: { x: 320, y: 220, width: 180, height: 20 } }],
          }),
        };
      }
      return {
        stdout: JSON.stringify({
          matches: [{ windowId: 1, confidence: 1, text: 'viki', rect: { x: 305, y: 560, width: 40, height: 20 } }],
        }),
      };
    }
    if (m === 'click' && p.y === 410) quote = true;
    if (m === 'click' && p.y === 680) quote = false;
    if (m === 'pressKey' && p.key === 'Shift+2') input = '@';
    if (m === 'pressKey' && p.key === 'Cmd+c') count++;
    if (m === 'typeText') {
      const typed = String(p.text ?? '');
      input += typed;
      if (!input.startsWith('@')) body = typed;
    }
    if (m === 'click' && p.y === 570) input = editAfterClick ? '\uFFFC 用户手动补充' : '\uFFFC';
    if (m === 'pressKey' && p.key === 'Backspace') {
      input = '';
      body = '';
    }
    if (m === 'click' && p.y === 740) {
      sent = true;
      input = '';
      quote = false;
    }
    return { stdout: '{}' };
  };
  const clipboard: ClipboardFn = async (r) =>
    r.action === 'snapshot'
      ? { count, items: [] }
      : r.action === 'read'
        ? { count, text: '\u2005@viki\u2005' + body }
        : { restored: true };
  const cua = new SwiftCua('/fake', runner, async () => {}, clipboard);
  await assert.rejects(
    cua.prepare(job, AbortSignal.timeout(5000)),
    /SwiftCUA getAppState 操作失败（code=1007, CUAService timeout）.*已清理本次未发送的 @ 查询和引用/,
  );
  assert.equal(input, '');
  assert.equal(quote, false);
  assert.ok(!actions.some((a) => a.m === 'pressKey' && a.p.key === 'Escape'));

  const nextCommit = await cua.prepare(job, AbortSignal.timeout(5000));
  assert.deepEqual(await nextCommit(AbortSignal.timeout(5000)), { confirmed: true });

  editAfterClick = true;
  postClickFailuresLeft = 3;
  actions.length = 0;
  await assert.rejects(
    cua.prepare(job, AbortSignal.timeout(5000)),
    /半成品草稿无法安全清理/,
  );
  assert.equal(input, '\uFFFC 用户手动补充');
  assert.equal(quote, true);
  assert.ok(!actions.some((a) => a.m === 'pressKey' && a.p.key === 'Backspace'));
});

test('selectMention third read-only OCR attempt catches slow or taller @ popup without weakening uniqueness', async () => {
  let input = '';
  let sent = false;
  let count = 0;
  let body = '';
  let mentionScans = 0;
  const pauses: number[] = [];
  const regions: RegionRect[] = [];
  const target: WxarcEvent = {
    ...incoming(1),
    text: '找人',
    sender: 'u1',
    senderIdentity: {
      id: 'u1',
      nickname: 'viki',
      uiName: 'viki',
      groupNickname: 'viki',
      uniqueUiName: true,
    },
  };
  const job = {
    event: incoming(1),
    quoteEvent: target,
    rule: { title: '群' },
    decision: { action: 'reply' as const, text: '来了' },
    mention: { id: 'u1', name: 'viki' },
  };
  const runner = async (_path: string, args: string[]) => {
    const m = args.at(-2) ?? '';
    const p = JSON.parse(args.at(-1) ?? '{}') as Record<string, unknown>;
    if (m === 'getAppState') {
      return {
        stdout: JSON.stringify({
          state: {
            info: {
              frontmostApp: 'com.tencent.xinWeChat',
              permissions: { accessibility: true },
              window: { id: 1, bounds: { x: 0, y: 0, width: 800, height: 800 } },
            },
            accessibility: {
              nodes: [
                { identifier: 'current_chat_name_label', value: '群' },
                {
                  identifier: 'chat_input_field',
                  index: 33,
                  value: input,
                  states: ['focused'],
                  frame: { x: 300, y: 600, width: 400, height: 60 },
                },
                { identifier: 'chat_message_list', frame: { x: 300, y: 100, width: 400, height: 450 } },
                {
                  identifier: 'chat_bubble_item_view',
                  title: target.text,
                  frame: { x: 300, y: 200, width: 400, height: 60 },
                },
                { role: 'AXButton', title: '发送', frame: { x: 700, y: 730, width: 60, height: 20 } },
                ...(sent ? [{ identifier: 'chat_bubble_item_view', title: '@viki 来了' }] : []),
              ],
            },
          },
        }),
      };
    }
    if (m === 'findText') {
      mentionScans++;
      regions.push(p.region as RegionRect);
      if (mentionScans === 4) {
        return {
          stdout: JSON.stringify({
            matches: [{ windowId: 1, confidence: 0.92, text: 'viki', rect: { x: 310, y: 455, width: 40, height: 20 } }],
          }),
        };
      }
      return { stdout: JSON.stringify({ matches: [] }) };
    }
    if (m === 'pressKey' && p.key === 'Shift+2') input = '@';
    if (m === 'pressKey' && p.key === 'Cmd+c') count++;
    if (m === 'typeText') {
      const typed = String(p.text ?? '');
      input += typed;
      if (!input.startsWith('@')) body = typed;
    }
    if (m === 'click' && p.y === 465) input = '\uFFFC';
    if (m === 'click' && p.y === 740) {
      sent = true;
      input = '';
    }
    return { stdout: '{}' };
  };
  const clipboard: ClipboardFn = async (r) =>
    r.action === 'snapshot'
      ? { count, items: [] }
      : r.action === 'read'
        ? { count, text: '\u2005@viki\u2005' + body }
        : { restored: true };
  const cua = new SwiftCua(
    '/fake',
    runner,
    async (ms) => {
      pauses.push(ms);
    },
    clipboard,
  );
  const commit = await cua.prepare(job, AbortSignal.timeout(5000));
  assert.equal(mentionScans, 4);
  assert.equal(regions[3].height, 160);
  assert.ok(regions[3].width >= 260);
  assert.ok(pauses.includes(250));
  assert.deepEqual(await commit(AbortSignal.timeout(5000)), { confirmed: true });
});

test('prepareMention cleans up owned draft and quote on Shift+2/typeText failure, wrongPerson clipboard mismatch, and quote-only validation failure', async () => {
  const wrongPersonFixture = nativeFixture({ wrongPerson: true });
  await assert.rejects(
    wrongPersonFixture.cua.prepare(wrongPersonFixture.job, wrongPersonFixture.signal),
    /原生 @ 名称或成员对象不一致；已清理本次未发送的 @ 查询和引用/,
  );
  assert.ok(wrongPersonFixture.actions.some((a) => a.m === 'pressKey' && a.p.key === 'Backspace'));
  assert.ok(wrongPersonFixture.actions.some((a) => a.m === 'click' && a.p.y === 680));

  const ambiguousFixture = nativeFixture({ ambiguousName: true });
  await assert.rejects(
    ambiguousFixture.cua.prepare(ambiguousFixture.job, ambiguousFixture.signal),
    /原生 @ 缺少可核对的成员身份；已清理本次未发送的引用/,
  );
  assert.ok(!ambiguousFixture.actions.some((a) => a.m === 'pressKey' && a.p.key === 'Backspace'));
  assert.ok(ambiguousFixture.actions.some((a) => a.m === 'click' && a.p.y === 680));

  let input = '';
  let quote = false;
  let failTypeText = true;
  const actions: ActionEntry[] = [];
  const target: WxarcEvent = {
    ...incoming(1),
    text: '帮我确认一下',
    sender: 'u1',
    senderIdentity: {
      id: 'u1',
      nickname: '甲',
      uiName: '甲',
      groupNickname: '甲',
      uniqueUiName: true,
    },
  };
  const quoteText = '引用 甲 的消息 : ' + target.text;
  const job = {
    event: incoming(1),
    quoteEvent: target,
    rule: { title: '群' },
    decision: { action: 'reply' as const, text: '好', replyTo: 'current' },
    mention: { id: 'u1', name: '甲' },
  };
  const runner = async (_path: string, args: string[]) => {
    const m = args.at(-2) ?? '';
    const p = JSON.parse(args.at(-1) ?? '{}') as Record<string, unknown>;
    actions.push({ m, p });
    if (m === 'getAppState') {
      return {
        stdout: JSON.stringify({
          state: {
            info: {
              frontmostApp: 'com.tencent.xinWeChat',
              permissions: { accessibility: true },
              window: { id: 1, bounds: { x: 0, y: 0, width: 800, height: 800 } },
            },
            accessibility: {
              nodes: [
                { identifier: 'current_chat_name_label', value: '群' },
                {
                  identifier: 'chat_input_field',
                  index: 33,
                  value: input,
                  states: ['focused'],
                  frame: { x: 300, y: 600, width: 400, height: 60 },
                },
                { identifier: 'chat_message_list', frame: { x: 300, y: 100, width: 400, height: 450 } },
                {
                  identifier: 'chat_bubble_item_view',
                  title: target.text,
                  frame: { x: 300, y: 200, width: 400, height: 60 },
                },
                ...(quote
                  ? [
                      { role: 'AXGroup', title: quoteText, frame: { x: 300, y: 670, width: 300, height: 30 } },
                      { role: 'AXButton', title: '删除引用消息', frame: { x: 700, y: 670, width: 20, height: 20 } },
                    ]
                  : []),
                { role: 'AXButton', title: '发送', frame: { x: 700, y: 730, width: 60, height: 20 } },
              ],
            },
          },
        }),
      };
    }
    if (m === 'findText') {
      if (p.text === '' && p.limit === 60) {
        return {
          stdout: JSON.stringify({
            matches: [{ windowId: 1, confidence: 1, text: '引用', rect: { x: 400, y: 400, width: 40, height: 20 } }],
          }),
        };
      }
      return {
        stdout: JSON.stringify({
          matches: [{ windowId: 1, confidence: 1, text: target.text, rect: { x: 320, y: 220, width: 180, height: 20 } }],
        }),
      };
    }
    if (m === 'click' && p.y === 410) quote = true;
    if (m === 'click' && p.y === 680) quote = false;
    if (m === 'pressKey' && p.key === 'Shift+2') input = '@';
    if (m === 'typeText' && failTypeText) {
      failTypeText = false;
      throw Object.assign(new Error('typeText failed'), { code: 1008 });
    }
    if (m === 'pressKey' && p.key === 'Backspace') input = '';
    return { stdout: '{}' };
  };
  const cua = new SwiftCua('/fake', runner, async () => {});
  await assert.rejects(
    cua.prepare(job, AbortSignal.timeout(5000)),
    /SwiftCUA typeText 操作失败.*已清理本次未发送的 @ 查询和引用/,
  );
  assert.equal(input, '');
  assert.equal(quote, false);
  assert.ok(actions.some((a) => a.m === 'pressKey' && a.p.key === 'Escape'));
  assert.ok(actions.some((a) => a.m === 'pressKey' && a.p.key === 'Backspace'));
});
