import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDecision, decisionPrompt } from '../src/ai.js';
import { SwiftCua } from '../src/cua.js';
import type { CuaOcrMatch } from '../src/cua.js';
import { OBSTRUCTED, retryableDetail } from '../src/resend.js';

interface ReplyQuoteFixtureOptions {
  existingQuote?: boolean;
  missingTrigger?: boolean;
  duplicate?: boolean;
  outsideList?: boolean;
  nonTextEvent?: boolean;
  wrongQuote?: boolean;
  noQuoteEcho?: boolean;
  lowConfidence?: boolean;
  noOCR?: boolean;
  duplicateOCR?: boolean;
  userEdited?: boolean;
  newQuote?: boolean;
  unfocusedMainWindow?: boolean;
  menuText?: string;
  menuMatches?: CuaOcrMatch[];
  menuScans?: CuaOcrMatch[][];
  menuNotFound?: boolean;
  userEditedAfterRightClick?: boolean;
  manualQuoteAfterRightClick?: boolean;
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
  let mainFocused = !options.unfocusedMainWindow;
  let quoteText = '引用 Peer 的消息 : 引用这句话';
  let menuScanCount = 0;
  let rightClickCount = 0;
  const actions: ActionRecord[] = [];
  const pauses: number[] = [];
  const frame = options.outsideList
    ? { x: 300, y: 180, width: 350, height: 60 }
    : { x: 300, y: 300, width: 350, height: 60 };
  const job = {
    event: options.nonTextEvent
      ? {
          id: 1,
          kind: 'text' as const,
          local_type: 3,
          sender: 'Peer',
          text: '[图片]',
          image: { status: 'read', hash: 'abc' },
        }
      : { id: 1, kind: 'text' as const, local_type: 1, sender: 'Peer', text: '引用这句话' },
    rule: { title: 'Peer' },
    decision: { action: 'reply' as const, text: '这样就对啦', replyTo: 'current' },
  };
  const willFallbackToPlain = Boolean(
    options.missingTrigger ||
      options.duplicate ||
      options.outsideList ||
      options.nonTextEvent ||
      options.lowConfidence ||
      options.noOCR ||
      options.duplicateOCR ||
      options.wrongQuote ||
      options.menuNotFound,
  );
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
          ...(options.unfocusedMainWindow
            ? {
                windows: [
                  { id: 73, title: '微信', isFocused: mainFocused },
                  { id: 958, title: '小程序', isFocused: !mainFocused },
                ],
              }
            : {}),
          accessibility: {
            nodes: [
              ...(options.unfocusedMainWindow ? [{ role: 'AXWindow', index: 1 }] : []),
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
                title: options.nonTextEvent ? '图片' : '引用这句话',
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
                        (options.noQuoteEcho || willFallbackToPlain ? '' : '\n' + quoteText),
                    },
                  ]
                : []),
            ],
          },
        },
      };
    }
    if (method === 'axAction' && p.action === 'AXRaise' && p.windowId === 73) {
      mainFocused = true;
    }
    if (method === 'click' && p.mouseButton === 'right') {
      rightClickCount++;
    }
    if (method === 'findText') {
      const isMenuScan = Boolean(p.region);
      if (isMenuScan) {
        menuScanCount++;
        if (options.menuScans) {
          const idx = Math.min(menuScanCount - 1, options.menuScans.length - 1);
          result = { matches: options.menuScans[idx] ?? [] };
        } else if (options.menuMatches) {
          result = { matches: options.menuMatches };
        } else if (options.menuNotFound) {
          result = {
            matches: [
              { text: '复制', confidence: 0.95, source: 'ocr', windowId: 73, rect: { x: 300, y: 470, width: 32, height: 20 } },
              { text: '转发', confidence: 0.95, source: 'ocr', windowId: 73, rect: { x: 302, y: 500, width: 32, height: 20 } },
              { text: '收藏', confidence: 0.95, source: 'ocr', windowId: 73, rect: { x: 301, y: 530, width: 32, height: 20 } },
            ],
          };
        } else {
          result = {
            matches: [
              { text: '复制', confidence: 0.95, source: 'ocr', windowId: 73, rect: { x: 300, y: 500, width: 30, height: 20 } },
              {
                text: options.menuText ?? '@ 引用',
                confidence: 0.3,
                source: 'ocr',
                windowId: 73,
                rect: { x: 300, y: 530, width: 30, height: 20 },
              },
            ],
          };
        }
      } else {
        const matches = [
          {
            text: '引用这句话',
            confidence: options.lowConfidence ? 0.5 : 0.99,
            source: 'ocr',
            windowId: 73,
            rect: { x: 220, y: 220, width: 90, height: 20 },
          },
        ];
        result = { matches };
        if (options.noOCR) result.matches = [];
        if (options.duplicateOCR) matches.push({ ...matches[0] });
        if (options.userEdited) input = '用户刚写的内容';
        if (options.newQuote) quoted = true;
      }
    }
    if (method === 'pressKey' && p.key === 'Escape') {
      if (options.userEditedAfterRightClick) input = '用户刚打的草稿';
      if (options.manualQuoteAfterRightClick) quoted = true;
    }
    if (method === 'click' && p.y === 540) quoted = true;
    if (method === 'click' && p.x === 598 && p.y === 510) quoted = false;
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
    pauses,
    getMenuScanCount: () => menuScanCount,
    getRightClickCount: () => rightClickCount,
    cua: new SwiftCua('/fake', runner, async (ms) => {
      pauses.push(ms);
    }),
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
  const menuFind = f.actions.find((x) => x.method === 'findText' && Boolean(x.p.region));
  assert.ok(menuFind);
  assert.equal(menuFind.p.text, '');
  assert.equal(menuFind.p.limit, 60);
  assert.ok(!f.actions.some((x) => x.method === 'click' && x.p.y === 562));
  assert.deepEqual(await commit(f.signal), { confirmed: true });
});

test('prepareQuote raises unfocused main window before right-clicking', async () => {
  const f = fixture({ unfocusedMainWindow: true });
  const commit = await f.cua.prepare(f.job, f.signal);
  const raiseIdx = f.actions.findIndex((x) => x.method === 'axAction' && x.p.action === 'AXRaise');
  const rightClickIdx = f.actions.findIndex((x) => x.method === 'click' && x.p.mouseButton === 'right');
  assert.ok(raiseIdx >= 0);
  assert.ok(rightClickIdx > raiseIdx);
  assert.deepEqual(await commit(f.signal), { confirmed: true });
});

test('native quote matches 1x icon misreads and spaced text cleanly', async () => {
  for (const menuText of ['口引用', 'Q引用', 'G引用', '0引用', '□ 引用', '引 用']) {
    const f = fixture({ menuText });
    const commit = await f.cua.prepare(f.job, f.signal);
    assert.deepEqual(await commit(f.signal), { confirmed: true });
  }
});

test('menu column X alignment isolates quote menu item from chat bubble containing 引用', async () => {
  const f = fixture({
    menuMatches: [
      { text: '引用', confidence: 0.99, source: 'ocr', windowId: 73, rect: { x: 120, y: 280, width: 30, height: 20 } },
      { text: '复制', confidence: 0.95, source: 'ocr', windowId: 73, rect: { x: 304, y: 470, width: 32, height: 20 } },
      { text: '转发', confidence: 0.95, source: 'ocr', windowId: 73, rect: { x: 302, y: 500, width: 32, height: 20 } },
      { text: '口引用', confidence: 0.4, source: 'ocr', windowId: 73, rect: { x: 300, y: 530, width: 30, height: 20 } },
      { text: '删除', confidence: 0.95, source: 'ocr', windowId: 73, rect: { x: 303, y: 560, width: 32, height: 20 } },
    ],
  });
  const commit = await f.cua.prepare(f.job, f.signal);
  assert.ok(f.actions.some((x) => x.method === 'click' && x.p.x === 315 && x.p.y === 540));
  assert.ok(!f.actions.some((x) => x.method === 'click' && x.p.x === 135));
  assert.deepEqual(await commit(f.signal), { confirmed: true });
});

test('tall merged OCR box over single-line height threshold is ignored and degrades safely', async () => {
  const f = fixture({
    menuNotFound: true,
    menuMatches: [
      { text: '复制', confidence: 0.95, source: 'ocr', windowId: 73, rect: { x: 300, y: 470, width: 32, height: 20 } },
      { text: '口引用', confidence: 0.8, source: 'ocr', windowId: 73, rect: { x: 300, y: 510, width: 36, height: 54 } },
    ],
  });
  const commit = await f.cua.prepare(f.job, f.signal);
  assert.ok(!f.actions.some((x) => x.method === 'click' && x.p.y === 537));
  assert.ok(f.actions.some((x) => x.method === 'pressKey' && x.p.key === 'Escape' && x.p.windowId === 73));
  const receipt = await commit(f.signal);
  assert.equal(receipt.confirmed, true);
  assert.match(receipt.detail ?? '', /找不到微信原生引用菜单（OCR=/);
});

test('first empty scan retries pause and rescan before issuing a second right-click', async () => {
  const f = fixture({
    menuScans: [
      [],
      [
        { text: '复制', confidence: 0.95, source: 'ocr', windowId: 73, rect: { x: 300, y: 500, width: 32, height: 20 } },
        { text: '引用', confidence: 0.9, source: 'ocr', windowId: 73, rect: { x: 300, y: 530, width: 30, height: 20 } },
      ],
    ],
  });
  const commit = await f.cua.prepare(f.job, f.signal);
  assert.equal(f.getRightClickCount(), 1);
  assert.equal(f.getMenuScanCount(), 2);
  assert.deepEqual(f.pauses.slice(0, 2), [250, 250]);
  assert.deepEqual(await commit(f.signal), { confirmed: true });
});

test('two empty scans with no menu neighbors safely retry one right-click and succeed', async () => {
  const f = fixture({
    menuScans: [
      [],
      [],
      [
        { text: '转发', confidence: 0.95, source: 'ocr', windowId: 73, rect: { x: 300, y: 500, width: 32, height: 20 } },
        { text: 'Q引用', confidence: 0.6, source: 'ocr', windowId: 73, rect: { x: 300, y: 530, width: 30, height: 20 } },
      ],
    ],
  });
  const commit = await f.cua.prepare(f.job, f.signal);
  assert.equal(f.getRightClickCount(), 2);
  assert.equal(f.getMenuScanCount(), 3);
  assert.deepEqual(f.pauses.slice(0, 3), [250, 250, 300]);
  assert.deepEqual(await commit(f.signal), { confirmed: true });
});

test('preexisting quote still hard-rejects without typing or touching the UI', async () => {
  const f = fixture({ existingQuote: true });
  await assert.rejects(f.cua.prepare(f.job, f.signal), /草稿或引用/);
  assert.ok(!f.actions.some((x) => x.method === 'typeText' || x.p.mouseButton === 'right'));
});

test('pre-right-click quote failures degrade cleanly without right-clicking', async () => {
  for (const [opts, pattern] of [
    [{ duplicate: true }, /无法唯一定位需要引用的原消息，已取消引用并直接回复/],
    [{ outsideList: true }, /需要引用的消息没有完整显示，已取消引用并直接回复/],
    [{ nonTextEvent: true }, /当前仅支持原生引用文字消息，已取消引用并直接回复/],
  ] as const) {
    const f = fixture(opts);
    const commit = await f.cua.prepare(f.job, f.signal);
    assert.ok(!f.actions.some((x) => x.p.mouseButton === 'right'));
    const receipt = await commit(f.signal);
    assert.equal(receipt.confirmed, true);
    assert.match(receipt.detail ?? '', pattern);
  }
});

test('missing quote menu runs Escape cleanup, refocuses input, and falls back with OCR diagnostics', async () => {
  const f = fixture({ menuNotFound: true });
  const commit = await f.cua.prepare(f.job, f.signal);
  assert.equal(f.getRightClickCount(), 1);
  assert.ok(f.actions.some((x) => x.method === 'pressKey' && x.p.key === 'Escape' && x.p.windowId === 73));
  assert.ok(f.actions.some((x) => x.method === 'click' && x.p.x === 475 && x.p.y === 470));
  const receipt = await commit(f.signal);
  assert.equal(receipt.confirmed, true);
  assert.match(receipt.detail ?? '', /找不到微信原生引用菜单（OCR=复制 \| 转发 \| 收藏），已取消引用并直接回复/);
});

test('wrong quote preview cleans up inserted quote bar via Escape and remove button, then falls back cleanly', async () => {
  const f = fixture({ wrongQuote: true });
  const commit = await f.cua.prepare(f.job, f.signal);
  assert.ok(f.actions.some((x) => x.method === 'pressKey' && x.p.key === 'Escape' && x.p.windowId === 73));
  assert.ok(f.actions.some((x) => x.method === 'click' && x.p.x === 598 && x.p.y === 510));
  assert.ok(f.actions.some((x) => x.method === 'click' && x.p.x === 475 && x.p.y === 470));
  const receipt = await commit(f.signal);
  assert.equal(receipt.confirmed, true);
  assert.match(receipt.detail ?? '', /微信引用框中的发言人或原文不一致，已取消引用并直接回复/);
});

test('post-right-click cleanup hard-aborts if user typed draft or manually quoted', async () => {
  for (const opts of [
    { menuNotFound: true, userEditedAfterRightClick: true },
    { menuNotFound: true, manualQuoteAfterRightClick: true },
    { wrongQuote: true, userEditedAfterRightClick: true },
  ]) {
    const f = fixture(opts);
    await assert.rejects(f.cua.prepare(f.job, f.signal), /出现了草稿或引用/);
    assert.ok(!f.actions.some((x) => x.method === 'typeText'));
    assert.ok(!f.actions.some((x) => x.method === 'click' && x.p.x === 598 && x.p.y === 510));
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

test('retryableDetail whitelists quote menu location errors with optional OCR suffix and blocks unsafe cleanup errors', () => {
  assert.equal(retryableDetail(OBSTRUCTED), true);
  assert.equal(retryableDetail('找不到微信原生引用菜单'), true);
  assert.equal(retryableDetail('找不到微信原生引用菜单（OCR=复制 | 转发）'), true);
  assert.equal(retryableDetail('找不到微信原生引用菜单（命中多项，OCR=引用 | 引用）'), true);
  assert.equal(retryableDetail('原文在本会话重复，无法唯一定位对应的引用消息'), true);
  assert.equal(retryableDetail('需要引用的消息没有完整显示'), true);
  assert.equal(retryableDetail('微信中已有未发送草稿或引用，暂停自动操作'), false);
  assert.equal(retryableDetail('找不到微信原生引用菜单；半成品草稿无法安全清理'), false);
  assert.equal(retryableDetail('引用失败清理前出现了草稿或引用，未覆盖'), false);
});

test('prepareQuote post-click non-QuoteUnavailableError cleans up inserted quote bar when input is empty, and preserves user draft', async () => {
  const runCase = async (userDraftAfterClick: string) => {
    let input = '';
    let quoted = false;
    let postClickFailuresLeft = 3;
    const actions: ActionRecord[] = [];
    const job = {
      event: { id: 1, kind: 'text' as const, local_type: 1, sender: 'Peer', text: '引用这句话' },
      rule: { title: 'Peer' },
      decision: { action: 'reply' as const, text: '这样就对啦', replyTo: 'current' },
    };
    const runner = async (_path: string, args: string[]) => {
      const method = args.at(-2) ?? '';
      const p = JSON.parse(args.at(-1) ?? '{}') as Record<string, unknown>;
      actions.push({ method, p });
      if (method === 'getAppState') {
        if (quoted && postClickFailuresLeft > 0) {
          postClickFailuresLeft--;
          throw Object.assign(new Error('timeout'), { code: 1007, stderr: 'CUAService timeout' });
        }
        return {
          stdout: JSON.stringify({
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
                  {
                    identifier: 'chat_bubble_item_view',
                    title: '引用这句话',
                    frame: { x: 300, y: 300, width: 350, height: 60 },
                  },
                  ...(quoted
                    ? [
                        {
                          role: 'AXGroup',
                          title: '引用 Peer 的消息 : 引用这句话',
                          frame: { x: 300, y: 500, width: 280, height: 26 },
                        },
                        {
                          role: 'AXButton',
                          title: '删除引用消息',
                          frame: { x: 590, y: 502, width: 16, height: 16 },
                        },
                      ]
                    : []),
                ],
              },
            },
          }),
        };
      }
      if (method === 'findText') {
        if (p.region) {
          return {
            stdout: JSON.stringify({
              matches: [
                { text: '复制', confidence: 0.95, source: 'ocr', windowId: 73, rect: { x: 300, y: 500, width: 30, height: 20 } },
                { text: '引用', confidence: 0.95, source: 'ocr', windowId: 73, rect: { x: 300, y: 530, width: 30, height: 20 } },
              ],
            }),
          };
        }
        return {
          stdout: JSON.stringify({
            matches: [
              { text: '引用这句话', confidence: 0.99, source: 'ocr', windowId: 73, rect: { x: 220, y: 220, width: 90, height: 20 } },
            ],
          }),
        };
      }
      if (method === 'click' && p.y === 540) {
        quoted = true;
        if (userDraftAfterClick) input = userDraftAfterClick;
      }
      if (method === 'click' && p.x === 598 && p.y === 510) quoted = false;
      return { stdout: '{}' };
    };
    const cua = new SwiftCua('/fake', runner, async () => {});
    return { cua, job, actions, isQuoted: () => quoted, getInput: () => input };
  };

  const clean = await runCase('');
  await assert.rejects(
    clean.cua.prepare(clean.job, new AbortController().signal),
    /SwiftCUA getAppState 操作失败.*已清理本次未发送的引用/,
  );
  assert.equal(clean.isQuoted(), false);
  assert.ok(clean.actions.some((a) => a.method === 'click' && a.p.x === 598 && a.p.y === 510));

  const dirty = await runCase('用户刚输入的草稿');
  await assert.rejects(
    dirty.cua.prepare(dirty.job, new AbortController().signal),
    /半成品草稿无法安全清理/,
  );
  assert.equal(dirty.isQuoted(), true);
  assert.equal(dirty.getInput(), '用户刚输入的草稿');
  assert.ok(!dirty.actions.some((a) => a.method === 'click' && a.p.x === 598 && a.p.y === 510));
});
