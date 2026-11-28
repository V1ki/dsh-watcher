import test from 'node:test';
import assert from 'node:assert/strict';
import { SwiftCua, hasTrigger } from '../src/cua.js';
import type { CuaAppState, CuaJob, CuaNode, CuaRule, CuaRunner } from '../src/cua.js';
import type { ClipboardFn } from '../src/clipboard.js';

interface FixtureOptions {
  draft?: string;
  locked?: boolean;
  missingTrigger?: boolean;
  wrongTitle?: boolean;
  ambiguous?: boolean;
  noEcho?: boolean;
  emoji?: boolean;
  staleClipboard?: boolean;
  wrongEmoji?: boolean;
  changeBeforeSend?: boolean;
}

interface RecordedAction {
  method: string;
  params: Record<string, unknown>;
}

function fixture(options: FixtureOptions = {}) {
  const actions: RecordedAction[] = [];
  let search = false;
  let query = '';
  let input = options.draft || '';
  let sent = false;
  let copyCount = 0;
  const frame = { x: 100, y: 200, width: 100, height: 40 };
  const job: CuaJob = {
    event: { kind: 'text', text: '你好' },
    rule: { sourceId: 'peer', title: 'Peer', search: 'peer123', wechatId: 'peer123' },
    decision: { text: '回复测试正文' },
  };
  const runner: CuaRunner = async (_path, args) => {
    const method = args.at(-2) ?? '';
    const params = JSON.parse(args.at(-1) ?? '{}') as Record<string, unknown>;
    actions.push({ method, params });
    let result: Record<string, unknown> = {};
    if (method === 'getAppState') {
      result = {
        state: {
          info: {
            frontmostApp: options.locked ? 'com.apple.loginwindow' : 'com.tencent.xinWeChat',
            permissions: { accessibility: true },
          },
          text: options.missingTrigger ? '其他人的消息' : '你好',
          accessibility: {
            nodes: search
              ? [{ role: 'AXTextArea', title: '搜索', states: ['focused'], value: query, frame }]
              : [
                  {
                    identifier: 'current_chat_name_label',
                    value: options.wrongTitle || options.ambiguous ? 'Wrong person' : 'Peer',
                  },
                  {
                    identifier: 'chat_input_field',
                    role: 'AXTextArea',
                    value: input,
                    states: ['focused'],
                    frame,
                  },
                  {
                    role: 'AXButton',
                    title: '发送',
                    states: ['enabled'],
                    frame: { ...frame, y: 500 },
                  },
                  ...(sent && !options.noEcho
                    ? [{ role: 'AXStaticText', value: job.decision.text }]
                    : []),
                ],
          },
        },
      };
    }
    if (method === 'pressKey' && params.key === 'Cmd+f') search = true;
    if (method === 'typeText') {
      const text = String(params.text ?? '');
      if (search) query = text;
      else input = options.emoji ? text.replace(/\[(旺柴|捂脸)\]/g, '\uFFFC') : text;
    }
    if (method === 'pressKey' && params.key === 'Cmd+c') copyCount++;
    if (method === 'pressKey' && params.key === 'Backspace') input = '';
    if (method === 'findText') {
      const match = {
        text: '微信号:peer123',
        source: 'ocr',
        confidence: 0.99,
        windowId: 73,
        rect: { x: 10, y: 20, width: 100, height: 40 },
      };
      result = { matches: options.ambiguous ? [match, match] : [match] };
    }
    if (method === 'click' && params.coordinateSpace === 'window') search = false;
    if (method === 'click' && params.y === 520) {
      sent = true;
      input = '';
    }
    return { stdout: JSON.stringify(result) };
  };
  const clipboardCalls: string[] = [];
  const pasteboard: ClipboardFn = async (request) => {
    clipboardCalls.push(request.action);
    if (request.action === 'snapshot') {
      return { count: 10, items: [{ plain: 'original clipboard' }] };
    }
    if (request.action === 'read') {
      return {
        count: options.staleClipboard ? 10 : 11,
        text:
          options.wrongEmoji || (copyCount === 2 && options.changeBeforeSend)
            ? '回复测试正文[捂脸]'
            : job.decision.text,
      };
    }
    return { restored: true };
  };
  return {
    cua: new SwiftCua('/test/cua', runner, async () => {}, pasteboard),
    job,
    actions,
    clipboardCalls,
    signal: new AbortController().signal,
    setInput: (text: string) => {
      input = text;
    },
  };
}

test('locked desktop and existing draft prevent any input action', async () => {
  for (const options of [{ locked: true }, { draft: '用户自己的草稿' }]) {
    const f = fixture(options);
    await assert.rejects(f.cua.prepare(f.job, f.signal));
    assert.ok(f.actions.every((a) => a.method === 'getAppState'));
  }
});

test('ambiguous search result and wrong chat title prevent reply typing', async () => {
  for (const options of [{ ambiguous: true }, { wrongTitle: true }]) {
    const f = fixture(options);
    await assert.rejects(f.cua.prepare(f.job, f.signal));
    assert.ok(
      !f.actions.some((a) => a.method === 'typeText' && a.params.text === f.job.decision.text),
    );
  }
});

test('prepare never sends; commit checks title, content and resulting outgoing message', async () => {
  const f = fixture();
  const commit = await f.cua.prepare(f.job, f.signal);
  assert.ok(!f.actions.some((a) => a.method === 'click' && a.params.y === 520));
  assert.deepEqual(await commit(f.signal), { confirmed: true });
});

test('a successful click without a new message is not a delivery confirmation', async () => {
  const f = fixture({ noEcho: true });
  const commit = await f.cua.prepare(f.job, f.signal);
  assert.deepEqual(await commit(f.signal), { confirmed: false });
});

test('a superseded draft can be cleared without sending; user edits are never deleted', async () => {
  const f = fixture();
  const commit = await f.cua.prepare(f.job, f.signal);
  await commit.discard?.(f.signal);
  assert.ok(f.actions.some((a) => a.method === 'pressKey' && a.params.key === 'Backspace'));
  assert.ok(!f.actions.some((a) => a.method === 'click' && a.params.y === 520));
  const edited = fixture();
  const old = await edited.cua.prepare(edited.job, edited.signal);
  edited.setInput('用户手动修改的内容');
  await assert.rejects(old.discard!(edited.signal), /输入内容/);
  assert.ok(!edited.actions.some((a) => a.method === 'pressKey' && a.params.key === 'Backspace'));
});

test('Moments lookup requires a full, unique author/body match and visible post', () => {
  const cua = new SwiftCua('/test/cua');
  const frame = { x: 10, y: 100, width: 400, height: 200 };
  const post: CuaNode = { title: 'Ann hello 1分钟前', frame };
  const area: CuaNode = { title: '评论区', frame: { ...frame, y: 300, height: 80 } };
  const children: CuaNode[] = [post, area];
  const state: CuaAppState = {
    accessibility: {
      nodes: [{ identifier: 'sns_list', frame: { x: 10, y: 100, width: 400, height: 500 }, children }],
    },
  };
  const job = { rule: { title: 'Ann' }, event: { text: 'hello' } };
  assert.equal(cua.moment(state, job).post, post);
  assert.throws(() => cua.moment(state, { rule: { title: 'An' }, event: { text: 'n hello' } }));
  assert.throws(() => cua.moment(state, { rule: { title: 'Ann' }, event: { text: 'hell' } }));
  children.push({ ...post }, area);
  assert.throws(() => cua.moment(state, job));
});

test('Moments editor must be focused and contained in the selected post comment area', () => {
  const cua = new SwiftCua('/test/cua');
  const area = { frame: { x: 100, y: 300, width: 400, height: 100 } };
  const input: CuaNode = {
    role: 'AXTextArea',
    states: ['focused'],
    frame: { x: 110, y: 310, width: 300, height: 40 },
    value: 'comment',
  };
  const state: CuaAppState = { accessibility: { nodes: [input] } };
  assert.equal(cua.commentInput(state, area).value, 'comment');
  input.frame!.y = 100;
  assert.throws(() => cua.commentInput(state, area));
  input.frame!.y = 310;
  input.states = [];
  assert.throws(() => cua.commentInput(state, area));
});

test('already selected matching chat is reused without clicking and toggling it closed', async () => {
  const f = fixture();
  await f.cua.openChat({ ...f.job.rule, uniqueTitle: true }, f.signal);
  assert.ok(f.actions.every((a) => a.method === 'getAppState'));
});

test('image trigger requires verified image data and a real chat image bubble', () => {
  const image = { local_type: 3, text: '[图片]', image: { status: 'read', hash: 'verified-hash' } };
  const state: CuaAppState = {
    accessibility: { nodes: [{ identifier: 'chat_bubble_item_view', title: '图片' }] },
  };
  assert.equal(hasTrigger(state, image), true);
  assert.equal(hasTrigger(state, { local_type: 3, text: '[图片]' }), false);
  assert.equal(hasTrigger({ text: '图片', accessibility: { nodes: [{ title: '图片' }] } }, image), false);
});

test('quote trigger matches the actual body rather than the synthetic quote label', () => {
  const e = { kind: 'text', local_type: 57 * 4294967296 + 49, text: '[引用] 后半句不用说' };
  const s: CuaAppState = {
    accessibility: {
      nodes: [
        {
          identifier: 'chat_bubble_item_view',
          title: '后半句不用说\nknight: 可不是嘛，后面是解释',
        },
      ],
    },
  };
  assert.equal(hasTrigger(s, e), true);
  assert.equal(hasTrigger(s, { ...e, text: '[引用] 另一条消息' }), false);
});

test('inline emoji is verified by copied full text before send; clipboard is restored', async () => {
  const f = fixture({ emoji: true });
  f.job.decision.text += '[旺柴]';
  const commit = await f.cua.prepare(f.job, f.signal);
  assert.deepEqual(await commit(f.signal), { confirmed: true });
  assert.deepEqual(f.clipboardCalls, ['snapshot', 'read', 'restore', 'snapshot', 'read', 'restore']);
  assert.equal(f.actions.filter((a) => a.method === 'click' && a.params.y === 520).length, 1);
});

test('wrong emoji and stale clipboard reject delivery despite identical AX placeholders', async () => {
  for (const options of [{ wrongEmoji: true }, { staleClipboard: true }]) {
    const f = fixture({ emoji: true, ...options });
    f.job.decision.text += '[旺柴]';
    await assert.rejects(f.cua.prepare(f.job, f.signal), /含表情/);
    assert.equal(f.clipboardCalls.at(-1), 'restore');
    assert.ok(!f.actions.some((a) => a.method === 'click' && a.params.y === 520));
  }
});

test('changed emoji before commit is re-read and rejected', async () => {
  const f = fixture({ emoji: true, changeBeforeSend: true });
  f.job.decision.text += '[旺柴]';
  const commit = await f.cua.prepare(f.job, f.signal);
  await assert.rejects(commit(f.signal), /含表情/);
  assert.equal(f.clipboardCalls.at(-1), 'restore');
  assert.ok(!f.actions.some((a) => a.method === 'click' && a.params.y === 520));
});

test('plain text avoids clipboard entirely', async () => {
  const f = fixture();
  const commit = await f.cua.prepare(f.job, f.signal);
  await commit(f.signal);
  assert.deepEqual(f.clipboardCalls, []);
});

test('a missing visible trigger allows a verified direct reply and records the fallback', async () => {
  const f = fixture({ missingTrigger: true });
  const commit = await f.cua.prepare(f.job, f.signal);
  assert.ok(!f.actions.some((a) => a.method === 'click' && a.params.y === 520));
  const receipt = await commit(f.signal);
  assert.equal(receipt.confirmed, true);
  assert.match(receipt.detail ?? '', /未显示触发原消息/);
});

test('the synthetic link/file label on a quote does not hide its actual body', () => {
  const e = { kind: 'text', local_type: 57 * 4294967296 + 49, text: '[链接/文件] 这个周五就可以' };
  assert.equal(
    hasTrigger(
      {
        accessibility: {
          nodes: [
            {
              identifier: 'chat_bubble_item_view',
              title: '这个周五就可以\n引用 小陈 的消息 : 什么时间',
            },
          ],
        },
      },
      e,
    ),
    true,
  );
});

test('openChat clicks an already-visible unique search field directly without redundant Cmd+f', async () => {
  const actions: RecordedAction[] = [];
  let focused = false;
  let query = '';
  let currentChat = 'Other';
  const searchFrame = { x: 40, y: 60, width: 180, height: 28 };
  const rule: CuaRule = { sourceId: 'peer', title: 'Peer', search: 'peer123', wechatId: 'peer123' };
  const runner: CuaRunner = async (_path, args) => {
    const method = args.at(-2) ?? '';
    const params = JSON.parse(args.at(-1) ?? '{}') as Record<string, unknown>;
    actions.push({ method, params });
    if (method === 'getAppState') {
      return {
        stdout: JSON.stringify({
          state: {
            info: {
              frontmostApp: 'com.tencent.xinWeChat',
              permissions: { accessibility: true },
              window: { id: 73, title: '微信', bounds: { x: 0, y: 0, width: 900, height: 700 } },
            },
            accessibility: {
              nodes: [
                {
                  role: 'AXTextField',
                  title: '搜索',
                  states: focused ? ['focused'] : [],
                  value: query,
                  frame: searchFrame,
                },
                { identifier: 'current_chat_name_label', value: currentChat },
                {
                  identifier: 'chat_input_field',
                  role: 'AXTextArea',
                  value: '',
                  states: [],
                  frame: { x: 300, y: 600, width: 400, height: 40 },
                },
              ],
            },
          },
        }),
      };
    }
    if (method === 'click' && params.coordinateSpace === 'global') focused = true;
    if (method === 'typeText') query = String(params.text ?? '');
    if (method === 'findText') {
      return {
        stdout: JSON.stringify({
          matches: [
            {
              text: '微信号:peer123',
              source: 'ocr',
              confidence: 0.99,
              windowId: 73,
              rect: { x: 40, y: 120, width: 160, height: 24 },
            },
          ],
        }),
      };
    }
    if (method === 'click' && params.coordinateSpace === 'window') currentChat = 'Peer';
    return { stdout: '{}' };
  };
  const cua = new SwiftCua('/test/cua', runner, async () => {});
  const state = await cua.openChat(rule, new AbortController().signal);
  assert.equal(cua.chat(state, 'Peer').input.value, '');
  assert.ok(!actions.some((a) => a.method === 'pressKey' && a.params.key === 'Cmd+f'));
});

test('openChat disambiguates multiple search fields by unique focused field after Cmd+f', async () => {
  const actions: RecordedAction[] = [];
  let opened = false;
  let query = '';
  let currentChat = 'Other';
  const frame1 = { x: 40, y: 60, width: 180, height: 28 };
  const frame2 = { x: 340, y: 60, width: 180, height: 28 };
  const rule: CuaRule = { sourceId: 'peer', title: 'Peer', search: 'peer123', wechatId: 'peer123' };
  const runner: CuaRunner = async (_path, args) => {
    const method = args.at(-2) ?? '';
    const params = JSON.parse(args.at(-1) ?? '{}') as Record<string, unknown>;
    actions.push({ method, params });
    if (method === 'getAppState') {
      return {
        stdout: JSON.stringify({
          state: {
            info: {
              frontmostApp: 'com.tencent.xinWeChat',
              permissions: { accessibility: true },
              window: { id: 73, title: '微信', bounds: { x: 0, y: 0, width: 900, height: 700 } },
            },
            accessibility: {
              nodes: [
                ...(opened
                  ? [
                      { role: 'AXTextField', title: '搜索', states: [], value: '', frame: frame1 },
                      {
                        role: 'AXTextField',
                        title: '搜索',
                        states: ['focused'],
                        value: query,
                        frame: frame2,
                      },
                    ]
                  : []),
                { identifier: 'current_chat_name_label', value: currentChat },
                {
                  identifier: 'chat_input_field',
                  role: 'AXTextArea',
                  value: '',
                  states: [],
                  frame: { x: 300, y: 600, width: 400, height: 40 },
                },
              ],
            },
          },
        }),
      };
    }
    if (method === 'pressKey' && params.key === 'Cmd+f') opened = true;
    if (method === 'typeText') query = String(params.text ?? '');
    if (method === 'findText') {
      return {
        stdout: JSON.stringify({
          matches: [
            {
              text: '微信号:peer123',
              source: 'ocr',
              confidence: 0.99,
              windowId: 73,
              rect: { x: 340, y: 120, width: 160, height: 24 },
            },
          ],
        }),
      };
    }
    if (method === 'click' && params.coordinateSpace === 'window') currentChat = 'Peer';
    return { stdout: '{}' };
  };
  const cua = new SwiftCua('/test/cua', runner, async () => {});
  const state = await cua.openChat(rule, new AbortController().signal);
  assert.equal(cua.chat(state, 'Peer').input.value, '');
  assert.ok(actions.some((a) => a.method === 'pressKey' && a.params.key === 'Cmd+f'));
});

test('selectSession pauses after AXRaise so WindowServer Z-order settles before occlusion check', async () => {
  const events: string[] = [];
  let currentChat = 'Other';
  const win = { x: 100, y: 80, width: 800, height: 600 };
  const row = { x: 120, y: 160, width: 220, height: 50 };
  const makeState = (): CuaAppState => ({
    info: {
      frontmostApp: 'com.tencent.xinWeChat',
      permissions: { accessibility: true },
      window: { id: 73, title: '微信', bounds: win },
    },
    accessibility: {
      nodes: [
        { role: 'AXWindow', index: 0, title: '微信' },
        { identifier: 'session_item_Peer', index: 12, frame: row },
        { identifier: 'current_chat_name_label', value: currentChat },
        {
          identifier: 'chat_input_field',
          role: 'AXTextArea',
          value: '',
          states: [],
          frame: { x: 400, y: 560, width: 400, height: 40 },
        },
      ],
    },
  });
  const runner: CuaRunner = async (path, args) => {
    if (path === '/usr/bin/osascript') {
      events.push('layout');
      return {
        stdout: JSON.stringify({
          bounds: win,
          usable: [{ x: 0, y: 25, width: 1600, height: 900 }],
          covers: [],
        }),
      };
    }
    const method = args.at(-2) ?? '';
    const params = JSON.parse(args.at(-1) ?? '{}') as Record<string, unknown>;
    events.push(method === 'axAction' ? `axAction:${String(params.action)}` : method);
    if (method === 'getAppState') return { stdout: JSON.stringify({ state: makeState() }) };
    if (method === 'click') currentChat = 'Peer';
    return { stdout: '{}' };
  };
  const cua = new SwiftCua('/test/cua', runner, async (ms) => {
    events.push(`pause:${ms}`);
  });
  const state = await cua.selectSession(makeState(), { title: 'Peer' }, new AbortController().signal);
  assert.equal(cua.chat(state, 'Peer').input.value, '');
  const raiseIdx = events.indexOf('axAction:AXRaise');
  const pauseIdx = events.indexOf('pause:200');
  const layoutIdx = events.indexOf('layout');
  assert.ok(
    raiseIdx >= 0 && pauseIdx > raiseIdx && layoutIdx > pauseIdx,
    `unexpected event order: ${events.join(', ')}`,
  );
});

test('openChat recovers main WeChat window when a secondary window is active without overwriting drafts', async () => {
  let activeWindow = 99;
  const mainNodes = (draft: string): CuaNode[] => [
    { role: 'AXWindow', index: 0, title: '微信' },
    { identifier: 'current_chat_name_label', value: 'Peer' },
    {
      identifier: 'chat_input_field',
      role: 'AXTextArea',
      value: draft,
      states: [],
      frame: { x: 300, y: 600, width: 400, height: 40 },
    },
  ];
  const makeRunner =
    (draft: string): CuaRunner =>
    async (_path, args) => {
      const method = args.at(-2) ?? '';
      const params = JSON.parse(args.at(-1) ?? '{}') as Record<string, unknown>;
      if (method === 'getAppState') {
        const wid = Number(params.windowId || activeWindow);
        return {
          stdout: JSON.stringify({
            state: {
              info: {
                frontmostApp: 'com.tencent.xinWeChat',
                permissions: { accessibility: true },
                window: {
                  id: wid,
                  title: wid === 10 ? '微信' : '微信 (窗口)',
                  bounds: { x: 0, y: 0, width: 900, height: 700 },
                },
              },
              windows: [
                { id: 99, title: '微信 (窗口)' },
                { id: 10, title: '微信' },
              ],
              accessibility: {
                nodes:
                  wid === 10
                    ? mainNodes(draft)
                    : [{ role: 'AXWindow', index: 0, title: '微信 (窗口)' }],
              },
            },
          }),
        };
      }
      if (method === 'axAction' && params.action === 'AXRaise' && params.windowId === 10) {
        activeWindow = 10;
      }
      return { stdout: '{}' };
    };
  const cua = new SwiftCua('/test/cua', makeRunner(''), async () => {});
  const state = await cua.openChat(
    { sourceId: 'peer', title: 'Peer', search: 'peer123', wechatId: 'peer123' },
    new AbortController().signal,
  );
  assert.equal(cua.chat(state, 'Peer').input.value, '');
  activeWindow = 99;
  const drafted = new SwiftCua('/test/cua', makeRunner('未发送草稿'), async () => {});
  await assert.rejects(
    drafted.openChat(
      { sourceId: 'peer', title: 'Peer', search: 'peer123', wechatId: 'peer123' },
      new AbortController().signal,
    ),
    /未发送草稿/,
  );
});

test('openChat falls back to Cmd+f search when selectSession is obstructed', async () => {
  const actions: RecordedAction[] = [];
  let searchFocused = false;
  let query = '';
  let currentChat = 'Other';
  const win = { x: 70, y: 25, width: 1850, height: 1055 };
  const row = { x: 90, y: 120, width: 220, height: 50 };
  const searchFrame = { x: 90, y: 50, width: 180, height: 28 };
  const rule: CuaRule = {
    sourceId: 'wxid_admin',
    title: 'DemoUser',
    search: 'demo_user_id',
    wechatId: 'demo_user_id',
    uniqueTitle: true,
  };
  const runner: CuaRunner = async (path, args) => {
    if (path === '/usr/bin/osascript') {
      actions.push({ method: 'desktop-layout', params: {} });
      return {
        stdout: JSON.stringify({
          bounds: win,
          usable: [win],
          covers: [{ x: 70, y: 25, width: 400, height: 300 }],
        }),
      };
    }
    const method = args.at(-2) ?? '';
    const params = JSON.parse(args.at(-1) ?? '{}') as Record<string, unknown>;
    actions.push({ method, params });
    if (method === 'getAppState') {
      return {
        stdout: JSON.stringify({
          state: {
            info: {
              frontmostApp: 'com.tencent.xinWeChat',
              permissions: { accessibility: true },
              window: { id: 73, title: '微信', bounds: win },
            },
            accessibility: {
              nodes: [
                { role: 'AXWindow', index: 0, title: '微信' },
                { identifier: 'session_item_DemoUser', index: 12, frame: row },
                {
                  role: 'AXTextField',
                  title: '搜索',
                  states: searchFocused ? ['focused'] : [],
                  value: query,
                  frame: searchFrame,
                },
                { identifier: 'current_chat_name_label', value: currentChat },
                {
                  identifier: 'chat_input_field',
                  role: 'AXTextArea',
                  value: '',
                  states: [],
                  frame: { x: 400, y: 960, width: 600, height: 40 },
                },
              ],
            },
          },
        }),
      };
    }
    if (method === 'pressKey' && params.key === 'Cmd+f') searchFocused = true;
    if (method === 'typeText') query = String(params.text ?? '');
    if (method === 'findText') {
      return {
        stdout: JSON.stringify({
          matches: [
            {
              text: '微信号:demo_user_id',
              source: 'ocr',
              confidence: 0.99,
              windowId: 73,
              rect: { x: 40, y: 120, width: 160, height: 24 },
            },
          ],
        }),
      };
    }
    if (method === 'click' && params.coordinateSpace === 'window') currentChat = 'DemoUser';
    return { stdout: '{}' };
  };
  const cua = new SwiftCua('/test/cua', runner, async () => {});
  const state = await cua.openChat(rule, new AbortController().signal);
  assert.equal(cua.chat(state, 'DemoUser').input.value, '');
  assert.ok(actions.some((a) => a.method === 'desktop-layout'));
  assert.ok(actions.some((a) => a.method === 'pressKey' && a.params.key === 'Cmd+f'));
  assert.ok(actions.some((a) => a.method === 'typeText' && a.params.text === 'demo_user_id'));
  assert.ok(
    !actions.some((a) => a.method === 'click' && a.params.coordinateSpace === 'global'),
  );
});

test('state() retries transient getAppState failures up to twice with abortable pauses and surfaces diagnostics', async () => {
  const pauses: number[] = [];
  let calls = 0;
  const okState: CuaAppState = {
    info: {
      frontmostApp: 'com.tencent.xinWeChat',
      permissions: { accessibility: true },
    },
    accessibility: { nodes: [] },
  };
  const transientRunner: CuaRunner = async () => {
    calls++;
    if (calls <= 2) {
      throw Object.assign(new Error('timeout'), { code: 1007, stderr: 'CUAService timeout' });
    }
    return { stdout: JSON.stringify({ state: okState }) };
  };
  const cua = new SwiftCua('/test/cua', transientRunner, async (ms) => {
    pauses.push(ms);
  });
  const state = await cua.state(new AbortController().signal);
  assert.equal(state.info?.frontmostApp, 'com.tencent.xinWeChat');
  assert.equal(calls, 3);
  assert.deepEqual(pauses, [150, 300]);

  let failCalls = 0;
  const failPauses: number[] = [];
  const alwaysFailRunner: CuaRunner = async () => {
    failCalls++;
    throw Object.assign(new Error('timeout'), { code: 1007, stderr: 'CUAService getAppState timeout' });
  };
  const failing = new SwiftCua('/test/cua', alwaysFailRunner, async (ms) => {
    failPauses.push(ms);
  });
  await assert.rejects(
    failing.state(new AbortController().signal),
    /SwiftCUA getAppState 操作失败（code=1007, CUAService getAppState timeout）；请检查微信界面与 SwiftCUA 服务/,
  );
  assert.equal(failCalls, 3);
  assert.deepEqual(failPauses, [150, 300]);
});

test('state() never retries on aborted signal, locked desktop, missing accessibility permission, or ENOENT', async () => {
  const abortController = new AbortController();
  abortController.abort(new Error('cancelled'));
  let abortedCalls = 0;
  const abortedCua = new SwiftCua(
    '/test/cua',
    async () => {
      abortedCalls++;
      return { stdout: '{}' };
    },
    async () => {},
  );
  await assert.rejects(abortedCua.state(abortController.signal), /cancelled/);
  assert.equal(abortedCalls, 0);

  let lockCalls = 0;
  const lockPauses: number[] = [];
  const lockedCua = new SwiftCua(
    '/test/cua',
    async () => {
      lockCalls++;
      return {
        stdout: JSON.stringify({
          state: {
            info: {
              frontmostApp: 'com.apple.loginwindow',
              permissions: { accessibility: true },
            },
          },
        }),
      };
    },
    async (ms) => {
      lockPauses.push(ms);
    },
  );
  await assert.rejects(lockedCua.state(new AbortController().signal), /桌面已锁定/);
  assert.equal(lockCalls, 1);
  assert.deepEqual(lockPauses, []);

  let permCalls = 0;
  const permPauses: number[] = [];
  const permCua = new SwiftCua(
    '/test/cua',
    async () => {
      permCalls++;
      return {
        stdout: JSON.stringify({
          state: {
            info: {
              frontmostApp: 'com.tencent.xinWeChat',
              permissions: { accessibility: false },
            },
          },
        }),
      };
    },
    async (ms) => {
      permPauses.push(ms);
    },
  );
  await assert.rejects(permCua.state(new AbortController().signal), /辅助功能权限/);
  assert.equal(permCalls, 1);
  assert.deepEqual(permPauses, []);

  let enoentCalls = 0;
  const enoentCua = new SwiftCua(
    '/test/cua',
    async () => {
      enoentCalls++;
      throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    },
    async () => {},
  );
  await assert.rejects(enoentCua.state(new AbortController().signal), /SwiftCUA getAppState 操作失败/);
  assert.equal(enoentCalls, 1);

  const midAbort = new AbortController();
  let midCalls = 0;
  const midAbortCua = new SwiftCua(
    '/test/cua',
    async () => {
      midCalls++;
      throw Object.assign(new Error('timeout'), { code: 1007 });
    },
    async (_ms, sig) => {
      midAbort.abort(new Error('mid-pause abort'));
      sig.throwIfAborted();
    },
  );
  await assert.rejects(midAbortCua.state(midAbort.signal), /mid-pause abort/);
  assert.equal(midCalls, 1);
});

test('prepare() cleans up owned draft when post-typeText verification fails, but never wipes a user-edited draft', async () => {
  const f = fixture({ emoji: true, wrongEmoji: true });
  f.job.decision.text += '[旺柴]';
  await assert.rejects(f.cua.prepare(f.job, f.signal), /含表情.*已清理本次未发送的草稿/);
  assert.equal(f.clipboardCalls.at(-1), 'restore');
  assert.ok(f.actions.some((a) => a.method === 'pressKey' && a.params.key === 'Backspace'));
  f.job.decision.text = '下一条消息';
  const secondCommit = await f.cua.prepare(f.job, f.signal);
  assert.equal((await secondCommit(f.signal)).confirmed, true);

  let input = '';
  let mutated = false;
  const editedActions: RecordedAction[] = [];
  const frame = { x: 100, y: 200, width: 100, height: 40 };
  const editedRunner: CuaRunner = async (_path, args) => {
    const method = args.at(-2) ?? '';
    const params = JSON.parse(args.at(-1) ?? '{}') as Record<string, unknown>;
    editedActions.push({ method, params });
    if (method === 'getAppState') {
      return {
        stdout: JSON.stringify({
          state: {
            info: {
              frontmostApp: 'com.tencent.xinWeChat',
              permissions: { accessibility: true },
            },
            text: '你好',
            accessibility: {
              nodes: [
                { identifier: 'current_chat_name_label', value: 'Peer' },
                {
                  identifier: 'chat_input_field',
                  role: 'AXTextArea',
                  value: input,
                  states: ['focused'],
                  frame,
                },
                { role: 'AXButton', title: '发送', states: ['enabled'], frame: { ...frame, y: 500 } },
              ],
            },
          },
        }),
      };
    }
    if (method === 'typeText') {
      input = String(params.text ?? '');
      if (!mutated) {
        mutated = true;
        input = '用户中途修改了输入框';
      }
    }
    if (method === 'pressKey' && params.key === 'Backspace') input = '';
    return { stdout: '{}' };
  };
  const editedCua = new SwiftCua('/test/cua', editedRunner, async () => {});
  await assert.rejects(
    editedCua.prepare(
      {
        event: { kind: 'text', text: '你好' },
        rule: { sourceId: 'peer', title: 'Peer', search: 'peer123', wechatId: 'peer123' },
        decision: { text: '自动回复正文' },
      },
      new AbortController().signal,
    ),
    /半成品草稿无法安全清理/,
  );
  assert.equal(input, '用户中途修改了输入框');
  assert.ok(!editedActions.some((a) => a.method === 'pressKey' && a.params.key === 'Backspace'));
});
