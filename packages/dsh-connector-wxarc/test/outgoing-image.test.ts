import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  linkSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeReply } from '../src/agent.js';
import { outgoingImage } from '../src/outgoing-image.js';
import { Automation } from '../src/automation.js';

test('image replies are chat-only, one relative image and optional caption', () => {
  assert.equal(nativeReply('{"action":"image","image":"设计稿.jpg"}', 'text').text, '');
  for (const [name, kind] of [
    ['../secret.png', 'text'],
    ['x.png', 'sns'],
    ['https://x/a.png', 'text'],
    ['x.svg', 'text'],
  ] as const) {
    assert.throws(() => nativeReply(JSON.stringify({ action: 'image', image: name }), kind));
  }
});

test('bind images to one workspace, reject links and changed content', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wxpic-')));
  const cwd = join(root, 'a'.repeat(20));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(cwd);
  const p = join(cwd, 'a.png');
  const data = Buffer.from('89504e470d0a1a0a', 'hex');
  writeFileSync(p, data);
  const h = outgoingImage(root, cwd, 'a.png').hash;
  writeFileSync(p, Buffer.concat([data, data]));
  assert.notEqual(outgoingImage(root, cwd, 'a.png').hash, h);
  symlinkSync(p, join(cwd, 'sym.png'));
  assert.throws(() => outgoingImage(root, cwd, 'sym.png'));
  linkSync(p, join(cwd, 'hard.png'));
  assert.throws(() => outgoingImage(root, cwd, 'hard.png'));
  assert.throws(() => outgoingImage(root, tmpdir(), 'a.png'));
});

test('reject unbound image before delivering even its caption', async () => {
  const auto = {
    agentBridge: { run: () => null },
    deliverOne: () => assert.fail('delivery called'),
  };
  await assert.rejects(
    Automation.prototype.deliver.call(
      auto as unknown as Automation,
      { id: 1, event: {}, decision: { action: 'image', text: '看图' } } as never,
      new AbortController().signal,
    ),
    /所属会话/,
  );
});

test('native image decision delivers exact bytes, with @ carried by the first bubble only', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wxdeliver-')));
  const cwd = join(root, 'b'.repeat(20));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(cwd);
  const name = 'chart.png';
  const data = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  writeFileSync(join(cwd, name), data);
  const decision = {
    action: 'image',
    text: '',
    image: name,
    imageHash: outgoingImage(root, cwd, name).hash,
  };
  const event: {
    kind: string;
    session: string;
    sourceKey: string;
    senderId: string;
    dshRunId: string;
    dshSessionId: string;
    mentions?: { status: string; sourceKey: string; recipients: string[] };
  } = {
    kind: 'text',
    session: 'a@chatroom',
    sourceKey: 'q',
    senderId: 'peer',
    dshRunId: 'run',
    dshSessionId: 'dsh',
  };
  const bridge = {
    root,
    run: () => ({ job_id: 13, session_id: 'dsh', event }),
    conversation: () => ({ cwd }),
  };
  const calls: Array<{ decision: { action: string }; imageBytes?: { bytes: Buffer } }> = [];
  const auto = {
    outgoingPython: process.env.WXARC_TEST_PYTHON || 'python3',
    agentBridge: bridge,
    settings: () => ({ policy: { ownId: 'me' } }),
    job: () => ({ event }),
    deliveryParts: () => [],
    deliverOne: async (p: { decision: { action: string }; imageBytes?: { bytes: Buffer } }) => {
      calls.push(p);
      return true;
    },
  };
  const invoke = () =>
    Automation.prototype.deliver.call(
      auto as unknown as Automation,
      { id: 13, event, decision } as never,
      new AbortController().signal,
    );
  await invoke();
  assert.deepEqual(
    calls.map((p) => p.decision.action),
    ['image'],
  );
  assert.deepEqual(calls[0].imageBytes?.bytes, data);
  calls.length = 0;
  event.mentions = { status: 'verified', sourceKey: 'q', recipients: ['me'] };
  await invoke();
  assert.deepEqual(
    calls.map((p) => p.decision.action),
    ['reply', 'image'],
  );
  writeFileSync(join(cwd, name), Buffer.concat([data, data]));
  calls.length = 0;
  await assert.rejects(invoke(), /已修改/);
  assert.equal(calls.length, 0);
});
