import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDecision, decisionPrompt } from '../src/ai.js';
import { SwiftCua } from '../src/cua.js';

interface ReplyQuoteFixtureOptions {
  existingQuote?: boolean;
  missingTrigger?: boolean;
  duplicate?: boolean;
  wrongQuote?: boolean;
  noQuoteEcho?: boolean;
  lowConfidence?: boolean;
  noOCR?: boolean;
  duplicateOCR?: boolean;
  userEdited?: boolean;
  newQuote?: boolean;
}

interface ActionRecord {
  method: string;
  p: Record<string, unknown>;
}

test('native quote protocol only permits current message for chat replies', () => {
  const decision = { action: 'reply', text: '可不是嘛', replyTo: 'current' };
  assert.equal(parseDecision(JSON.stringify(decision), 'text').replyTo, 'current');
  for (const bad of [
    { ...decision, replyTo: 'other-id' },
    { ...decision, action: 'comment' },
    { ...decision, action: 'ignore' },
  ]) {
    assert.throws(() => parseDecision(JSON.stringify(bad), bad.action === 'comment' ? 'sns' : 'text'));
  }
  assert.ok(
    decisionPrompt({ instructions: '' }, { kind: 'text', local_type: 1 }, []).system.includes(
      '"replyTo":"current"',
    ),
  );
  assert.ok(
    !decisionPrompt({ instructions: '' }, { kind: 'sns' }, []).system.includes('"replyTo":"current"'),
  );
});

function fixture(options: ReplyQuoteFixtureOptions = {}) {
  let input = '';
  let quoted = Boolean(options.existingQuote);
  let sent = false;
  let quoteText = '引用 Peer 的消息 : 引用这句话';
  const actions: ActionRecord[] = [];
  const frame = { x: 300, y: 300, width: 350, height: 60 };
  const job = {
    event: { id: 1, kind: 'text' as const, local_type: 1, sender: 'Peer', text: '引用这句话' },
    rule: { title: 'Peer' },
    decision: { action: 'reply' as const, text: '这样就对啦', replyTo: 'current' },
  };
  const runner = async (_path: string, args: string[]) => {
    const method = args.at(-2) ?? '';
    const p = JSON.parse(args.at(-1) ?? '{}') as Record<string, unknown>;
    actions.push({ method, p });
    let result: Record<string, unknown> = {};
    if (method === 'getAppState') {
      result = {
        state: {
          info: {
            frontmostApp: 'com.tencent.xinWeChat',
            permissions: { accessibility: true },
            window: { id: 73, bounds: { x: 100, y: 100, width: 600, height: 500 } },
          },
          accessibility: {
            nodes: [
              { identifier: 'current_chat_name_label', value: 'Peer' },
              {
                identifier: 'chat_input_field',
                value: input,
                frame: { x: 300, y: 450, width: 350, height: 40 },
                states: ['focused'],
              },
              { identifier: 'chat_message_list', frame: { x: 300, y: 200, width: 350, height: 220 } },
              ...Array.from({ length: options.missingTrigger ? 0 : options.duplicate ? 2 : 1 }, () => ({
                identifier: 'chat_bubble_item_view',
                title: '引用这句话',
                frame,
              })),
              ...(quoted
                ? [
                    {
                      role: 'AXGroup',
                      title: options.wrongQuote ? '引用 Other 的消息 : 引用这句话' : quoteText,
                      frame: { x: 300, y: 500, width: 280, height: 26 },
                    },
                    {
                      role: 'AXButton',
                      title: '删除引用消息',
                      frame: { x: 590, y: 502, width: 16, height: 16 },
                    },
                  ]
                : []),
              { role: 'AXButton', title: '发送', frame: { x: 600, y: 550, width: 40, height: 24 } },
              ...(sent
                ? [
                    {
                      identifier: 'chat_bubble_item_view',
                      title:
                        job.decision.text +
                        (options.noQuoteEcho ||
                        options.missingTrigger ||
                        options.lowConfidence ||
                        options.noOCR ||
                        options.duplicateOCR
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
    if (method === 'findText') {
      const matches = [
        {
          text: p.text === '引用' ? '@ 引用' : '引用这句话',
          confidence: p.region ? 0.3 : 0.99,
          source: 'ocr',
          windowId: 73,
          rect: p.region
            ? { x: 300, y: 530, width: 30, height: 20 }
            : { x: 220, y: 220, width: 90, height: 20 },
        },
      ];
      result = { matches };
      if (p.text !== '引用') {
        if (options.lowConfidence) matches[0].confidence = 0.5;
        if (options.noOCR) result.matches = [];
        if (options.duplicateOCR) matches.push({ ...matches[0] });
        if (options.userEdited) input = '用户刚写的内容';
        if (options.newQuote) quoted = true;
      }
    }
    if (method === 'click' && p.y === 540) quoted = true;
    if (method === 'typeText') input = String(p.text ?? '');
    if (method === 'click' && p.y === 562) {
      sent = true;
      input = '';
      quoted = false;
    }
    return { stdout: JSON.stringify(result) };
  };
  return {
    job,
    actions,
    cua: new SwiftCua('/fake', runner, async () => {}),
    signal: new AbortController().signal,
    changeQuote: () => {
      quoteText = '引用 Peer 的消息 : 被改动了';
    },
  };
}

test('native quote selects OCR text in bubble and menu outside window, then verifies actual quoted echo', async () => {
  const f = fixture();
  const commit = await f.cua.prepare(f.job, f.signal);
  assert.ok(f.actions.some((x) => x.method === 'click' && x.p.mouseButton === 'right'));
  assert.ok(f.actions.some((x) => x.method === 'findText' && Boolean(x.p.region)));
  assert.ok(!f.actions.some((x) => x.method === 'click' && x.p.y === 562));
  assert.deepEqual(await commit(f.signal), { confirmed: true });
});

test('ambiguous bubble, wrong author and preexisting quote prevent typing', async () => {
  for (const opts of [{ duplicate: true }, { wrongQuote: true }, { existingQuote: true }]) {
    const f = fixture(opts);
    await assert.rejects(f.cua.prepare(f.job, f.signal));
    assert.ok(!f.actions.some((x) => x.method === 'typeText'));
  }
});

test('changing quote after prepare prevents sending', async () => {
  const f = fixture();
  const commit = await f.cua.prepare(f.job, f.signal);
  f.changeQuote();
  await assert.rejects(commit(f.signal));
  assert.ok(!f.actions.some((x) => x.method === 'click' && x.p.y === 562));
});

test('a plain text echo does not confirm native quote delivery', async () => {
  const f = fixture({ noQuoteEcho: true });
  const commit = await f.cua.prepare(f.job, f.signal);
  assert.deepEqual(await commit(f.signal), { confirmed: false });
});

test('missing quote source falls back to a plain reply without choosing another bubble', async () => {
  const f = fixture({ missingTrigger: true });
  const commit = await f.cua.prepare(f.job, f.signal);
  assert.ok(
    !f.actions.some(
      (x) => x.method === 'findText' || x.method === 'scroll' || x.p.mouseButton === 'right',
    ),
  );
  const receipt = await commit(f.signal);
  assert.equal(receipt.confirmed, true);
  assert.match(receipt.detail ?? '', /取消引用并直接回复/);
});

test('unreliable OCR location skips quotation and confirms a plain reply', async () => {
  for (const opts of [{ lowConfidence: true }, { noOCR: true }, { duplicateOCR: true }]) {
    const f = fixture(opts);
    const commit = await f.cua.prepare(f.job, f.signal);
    assert.ok(!f.actions.some((x) => x.p.mouseButton === 'right'));
    const receipt = await commit(f.signal);
    assert.equal(receipt.confirmed, true);
    assert.match(receipt.detail ?? '', /引用位置无法可靠识别/);
  }
});

test('quote fallback never types over a new draft or quote', async () => {
  for (const opts of [{ userEdited: true }, { newQuote: true }]) {
    const f = fixture({ lowConfidence: true, ...opts });
    await assert.rejects(f.cua.prepare(f.job, f.signal), /出现了草稿或引用/);
    assert.ok(!f.actions.some((x) => x.method === 'typeText' || x.p.mouseButton === 'right'));
  }
});
