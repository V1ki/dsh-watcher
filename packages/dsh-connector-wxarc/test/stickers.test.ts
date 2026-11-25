import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Stickers, stickerLayout } from '../src/stickers.js';
import type { StickerJob, StickersAutomation } from '../src/stickers.js';
import type { CuaAppState, CuaNode } from '../src/cua.js';
import { nativeReply } from '../src/agent.js';

const ticket = '12345678-1234-1234-1234-123456789012';
const signal = (): AbortSignal => new AbortController().signal;

function fixture() {
  const search: CuaNode = {
    role: 'AXTextArea',
    title: '搜索',
    value: '烧烤',
    frame: { x: 1004, y: 319, width: 360, height: 20 },
  };
  const state: CuaAppState = {
    info: {
      frontmostApp: 'com.tencent.xinWeChat',
      window: { id: 73, bounds: { x: 0, y: 0, width: 1600, height: 1000 } },
    },
    accessibility: {
      nodes: [
        {
          role: 'AXWindow',
          subrole: 'AXDialog',
          frame: { x: 928, y: 267, width: 514, height: 514 },
          children: [
            search,
            {
              identifier: 'emoticon_panel_tool_bar',
              frame: { x: 952, y: 709, width: 466, height: 48 },
            },
          ],
        },
      ],
    },
  };
  let clicked = 0;
  let shot = 'data:image/jpeg;base64,ORIGINAL';
  let rows: Array<{ payload: string }> = [];
  const auto: StickersAutomation = {
    cua: {
      state: async () => state,
      chat: () => ({ input: { value: '' } }),
      call: async () => ({ screenshots: [{ url: shot }] }),
      clickFrame: async () => {
        clicked++;
      },
      pause: async () => {},
    },
    tail: () => 20,
    settings: () => ({ policy: { ownId: 'wxid_me' } }),
    listener: { wechatRoot: '/data/wxid_me_abcd' },
    store: { db: { prepare: () => ({ all: () => rows }) } },
    resolveSource: (_h, e) => e as { session?: string; senderId?: string; local_type?: number; account?: string },
  };
  const service = new Stickers(auto, {});
  const layout = stickerLayout(state, '烧烤');
  service.lease = {
    ticket,
    runId: 'run',
    jobId: 1,
    query: '烧烤',
    layout,
    windowId: 73,
    hashes: Array<string>(10).fill(createHash('sha256').update(shot).digest('hex')),
    stable: [1],
    expires: Date.now() + 90000,
  };
  const job: StickerJob = {
    id: 1,
    event: { session: 'group', dshRunId: 'run' },
    rule: { title: 'group' },
    decision: { action: 'sticker', text: '饿了', sticker: { ticket, index: 1 } },
  };
  return {
    service,
    job,
    state,
    search,
    clicked: () => clicked,
    setShot: (v: string) => {
      shot = v;
    },
    setRows: (v: Array<Record<string, unknown>>) => {
      rows = v.map((e) => ({ payload: JSON.stringify(e) }));
    },
  };
}

test('sticker protocol never accepts arbitrary coordinates, recipients or Moments sends', () => {
  const value = { action: 'sticker', text: '饿了', sticker: { ticket, index: 1 } };
  assert.equal(nativeReply(JSON.stringify(value), 'text').action, 'sticker');
  for (const bad of [
    { ...value, recipient: 'other' },
    { ...value, sticker: { ticket, index: 11 } },
    { ...value, sticker: { ticket, index: 1, x: 100 } },
  ]) {
    assert.throws(() => nativeReply(JSON.stringify(bad), 'text'));
  }
  assert.throws(() => nativeReply(JSON.stringify(value), 'sns'));
});

test('sticker preparation never sends and requires the same run, preview, query and layout', async () => {
  const f = fixture();
  await f.service.prepare(f.job, signal());
  assert.equal(f.clicked(), 0);
  await assert.rejects(f.service.prepare({ ...f.job, id: 2 }, signal()));
  await assert.rejects(
    f.service.prepare({ ...f.job, event: { ...f.job.event, dshRunId: 'other' } }, signal()),
  );
  f.setShot('data:image/jpeg;base64,CHANGED');
  await assert.rejects(f.service.prepare(f.job, signal()), /预览已改变/);
  f.search.value = '其他';
  await assert.rejects(f.service.prepare(f.job, signal()), /搜索词/);
  assert.equal(f.clicked(), 0);
});

test('one click is confirmed only by an outgoing sticker from this account in the intended chat', async () => {
  const f = fixture();
  const commit = await f.service.prepare(f.job, signal());
  f.setRows([
    { session: 'group', senderId: 'wxid_me', local_type: 47, account: '/data/wxid_me_abcd/db_storage' },
  ]);
  assert.deepEqual(await commit(signal()), { confirmed: true });
  assert.equal(f.clicked(), 1);
  assert.equal(f.service.lease, null);
  await assert.rejects(commit(signal()), /不能重复点击/);
  assert.equal(f.clicked(), 1);
  const g = fixture();
  const send = await g.service.prepare(g.job, signal());
  g.setRows([
    { session: 'other', senderId: 'wxid_me', local_type: 47 },
    { session: 'group', senderId: 'peer', local_type: 47 },
    { session: 'group', senderId: 'wxid_me', local_type: 1 },
  ]);
  assert.equal((await send(signal())).confirmed, false);
  assert.equal(g.clicked(), 1);
});

test('a changed candidate between preparation and commit never gets clicked', async () => {
  const f = fixture();
  const commit = await f.service.prepare(f.job, signal());
  f.setShot('data:image/jpeg;base64,DIFFERENT');
  await assert.rejects(commit(signal()), /预览已改变/);
  assert.equal(f.clicked(), 0);
});
