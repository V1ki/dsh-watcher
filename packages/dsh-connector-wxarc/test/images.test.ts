import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentBridge } from '../src/agent.js';
import { batchContent } from '../src/batch.js';
import { Store } from '../src/core.js';
import { ImageReader, imageDimensions, imageType } from '../src/images.js';
import type { ImageReaderOptions } from '../src/images.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6dGAAAAAASUVORK5CYII=',
  'base64',
);

function makeJpeg(width: number, height: number, extraBytes = 0): Buffer<ArrayBuffer> {
  const soi = Buffer.from([0xff, 0xd8]);
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00,
    0x01, 0x00, 0x00,
  ]);
  const sof0 = Buffer.alloc(13);
  sof0[0] = 0xff;
  sof0[1] = 0xc0;
  sof0.writeUInt16BE(11, 2);
  sof0[4] = 8;
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  sof0[9] = 1;
  sof0[10] = 1;
  sof0[11] = 0x11;
  sof0[12] = 0;
  const pad = extraBytes > 0 ? Buffer.alloc(extraBytes, 0x22) : Buffer.alloc(0);
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.from(Buffer.concat([soi, app0, sof0, pad, eoi]));
}
const event = { id: 29, kind: 'text', session: 'peer', local_type: 3, text: '[图片]', ts: 123 };

function fixture(t: TestContext, overrides: Partial<ImageReaderOptions> = {}): ImageReader {
  const dir = mkdtempSync(join(tmpdir(), 'wxarc-images-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const listener = {
    base: 'http://127.0.0.1:28765',
    get: async () => [{ ...event, media: { kind: 'image', status: 'available', url: '/preview/54' } }],
  };
  return new ImageReader({
    dir,
    listener,
    fetcher: async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:28765/preview/54');
      assert.equal(options?.redirect, 'error');
      return new Response(png);
    },
    ...overrides,
  });
}

test('canonical image mapping yields byte-exact native attachment without guessing time proximity', async (t) => {
  const r = fixture(t);
  const e = await r.enrich(event, {}, new AbortController().signal);
  assert.ok(e.image);
  const p = r.part(e);
  assert.equal(e.image.mediaType, 'image/png');
  assert.equal(p.type, 'image');
  assert.deepEqual(Buffer.from(p.data, 'base64'), png);
  assert.equal(e.image.source, '/preview/54');
});

test('changed sender conversation, unavailable media, and arbitrary URLs never fetch attachments', async (t) => {
  const r = fixture(t, {
    fetcher: async () => {
      throw new Error('should not fetch');
    },
  });
  for (const row of [
    { ...event, session: 'other' },
    { ...event, media: { kind: 'image', status: 'pending', url: '/preview/54' } },
    { ...event, media: { kind: 'image', status: 'available', url: 'https://evil/image' } },
  ]) {
    r.listener.get = async () => [row];
    await assert.rejects(r.enrich(event, {}, new AbortController().signal), /来源|可核对/);
  }
});

test('attachment integrity, type and response size are checked', async (t) => {
  const r = fixture(t);
  const e = await r.enrich(event, {}, new AbortController().signal);
  assert.ok(e.image);
  writeFileSync(e.image.path, Buffer.concat([png, Buffer.from('changed')]));
  assert.throws(() => r.part(e), /校验/);
  assert.throws(() => imageType(Buffer.from('<html>challenge</html>')), /格式/);
  r.fetcher = async () =>
    new Response('x', { headers: { 'content-length': String(9 * 1024 * 1024) } });
  await assert.rejects(r.enrich(event, {}, new AbortController().signal), /8 MiB/);
});

test('animated sticker preview uses its exact emoji mapping and never fetches external URLs', async (t) => {
  const sticker = { ...event, local_type: 47, text: '[动画表情]' };
  const url = '/emoji/' + 'a'.repeat(32);
  const r = fixture(t, {
    listener: {
      base: 'http://127.0.0.1:28765',
      get: async () => [
        { ...sticker, emoji_status: 'available', emoji_url: url, emoji_preview: 'static' },
      ],
    },
    fetcher: async (address) => {
      assert.equal(address, 'http://127.0.0.1:28765' + url);
      return new Response(png);
    },
  });
  const e = await r.enrich(sticker, {}, new AbortController().signal);
  assert.ok(e.image);
  assert.equal(e.image.sticker, true);
  assert.equal(e.image.preview, 'static');
  assert.deepEqual(Buffer.from(r.part(e).data, 'base64'), png);
  r.listener.get = async () => [
    { ...sticker, emoji_status: 'available', emoji_url: 'https://example.com/emoji' },
  ];
  await assert.rejects(r.enrich(sticker, {}, new AbortController().signal), /地址/);
});

test('ImageReader waits for HD image during grace window on variant=thumb and returns HD immediately once available', async (t) => {
  let clockMs = 1_700_000_010_000;
  const freshEvent = {
    id: 1910,
    kind: 'text',
    session: 'group@chatroom',
    local_type: 3,
    text: '[图片]',
    ts: 1_700_000_000,
  };
  const thumbJpeg = makeJpeg(180, 118, 3000);
  const highJpeg = makeJpeg(961, 628, 30000);
  assert.deepEqual(imageDimensions(thumbJpeg), { width: 180, height: 118 });
  assert.deepEqual(imageDimensions(highJpeg), { width: 961, height: 628 });

  let variant: 'thumb' | 'high' = 'thumb';
  let previewUrl = '/preview/587';
  const fetchedUrls: string[] = [];

  const r = fixture(t, {
    now: () => clockMs,
    thumbGraceSeconds: 35,
    listener: {
      base: 'http://127.0.0.1:28765',
      get: async () => [
        {
          ...freshEvent,
          media: { kind: 'image', status: 'available', url: previewUrl, variant },
        },
      ],
    },
    fetcher: async (url) => {
      fetchedUrls.push(url);
      return new Response(url.endsWith('/588') ? highJpeg : thumbJpeg);
    },
  });

  await assert.rejects(
    r.enrich(freshEvent, {}, new AbortController().signal),
    (err: unknown) => (err as { code?: string })?.code === 'WXARC_IMAGE_PENDING',
  );
  assert.equal(fetchedUrls.length, 0);
  assert.equal(readdirSync(r.dir).length, 0);

  variant = 'high';
  previewUrl = '/preview/588';
  clockMs = 1_700_000_020_000;
  const hd = await r.enrich(freshEvent, {}, new AbortController().signal);
  assert.ok(hd.image);
  assert.equal(hd.image.source, '/preview/588');
  assert.equal(hd.image.variant, 'high');
  assert.equal(hd.image.thumbnailOnly, undefined);
  assert.equal(hd.image.width, 961);
  assert.equal(hd.image.height, 628);
  assert.deepEqual(fetchedUrls, ['http://127.0.0.1:28765/preview/588']);
});

test('ImageReader falls back to thumbnailOnly after grace window expires and handles unversioned 180x118 thumbnails', async (t) => {
  let clockMs = 1_700_000_010_000;
  const freshEvent = {
    id: 1911,
    kind: 'text',
    session: 'group@chatroom',
    local_type: 3,
    text: '[图片]',
    ts: 1_700_000_000,
  };
  const thumbJpeg = makeJpeg(180, 118, 3000);
  const highJpeg = makeJpeg(961, 628, 30000);
  let currentBytes = thumbJpeg;
  let currentUrl = '/preview/601';

  const r = fixture(t, {
    now: () => clockMs,
    thumbGraceSeconds: 35,
    listener: {
      base: 'http://127.0.0.1:28765',
      get: async () => [
        {
          ...freshEvent,
          media: { kind: 'image', status: 'available', url: currentUrl },
        },
      ],
    },
    fetcher: async () => new Response(currentBytes),
  });

  await assert.rejects(
    r.enrich(freshEvent, {}, new AbortController().signal),
    (err: unknown) => (err as { code?: string })?.code === 'WXARC_IMAGE_PENDING',
  );
  assert.equal(readdirSync(r.dir).length, 0);

  currentBytes = highJpeg;
  currentUrl = '/preview/602';
  const upgraded = await r.enrich(freshEvent, {}, new AbortController().signal);
  assert.ok(upgraded.image);
  assert.equal(upgraded.image.source, '/preview/602');
  assert.equal(upgraded.image.thumbnailOnly, undefined);
  assert.equal(upgraded.image.width, 961);

  currentBytes = thumbJpeg;
  currentUrl = '/preview/601';
  clockMs = 1_700_000_035_000;
  const degraded = await r.enrich(freshEvent, {}, new AbortController().signal);
  assert.ok(degraded.image);
  assert.equal(degraded.image.source, '/preview/601');
  assert.equal(degraded.image.thumbnailOnly, true);
  assert.equal(degraded.image.width, 180);
  assert.equal(degraded.image.height, 118);

  const batchParts = batchContent(
    {
      ...degraded,
      kind: 'text',
      batch: { messages: [degraded as any] },
    } as any,
    r as any,
  );
  const batchText = batchParts
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
  assert.ok(batchText.includes('当前仅获取到低清缩略图，细节可能不清'));

  const storeDir = mkdtempSync(join(tmpdir(), 'wxarc-thumb-prompt-'));
  const store = new Store(storeDir);
  const prompted: Array<Record<string, any>> = [];
  const agents = new Map<string, any>();
  const ctx: any = {
    on: () => () => {},
    systemPrompt: { section: () => () => {} },
    agents: { get: (id: string) => agents.get(id) },
    approval: { setPolicy() {} },
    permissionPresets: { set() {} },
    llm: {
      resolveCallConfig: async () => ({}),
      resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }),
    },
    workspaceController: {
      create: async () => ({ created: false, workspace: { workspaceId: 'ws' } }),
      rename: async () => {},
    },
    workspaceRegistry: { get: () => ({ attachSession: async () => {} }) },
    sessionController: {
      resolveAgent: async (id: string) =>
        agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found' } },
      create: async ({ sessionId, cwd }: { sessionId: string; cwd: string }) => {
        agents.set(sessionId, {
          id: sessionId,
          cwd,
          session: { header: {} },
          inbox: { clear() {} },
          model: { select() {} },
          whenIdle: async () => {},
          cancel() {},
        });
        return { sessionId };
      },
      rename: async () => {},
      state: async () => ({ running: false, queue: [], pendingInput: [] }),
      prompt: async (input: Record<string, any>) => {
        prompted.push(input);
      },
    },
  };
  const bridge = new AgentBridge(ctx, store, {
    root: join(storeDir, 'work'),
    personas: { context: () => ({ name: '测试角色' }) },
    images: r as any,
    settings: () => ({
      policy: { ownId: 'wxid_me', instructions: '自然回复', provider: 'test', model: 'test' },
    }),
  });
  t.after(async () => {
    await bridge.close();
    store.close();
    rmSync(storeDir, { recursive: true, force: true });
  });
  await bridge.start(
    {
      jobId: 1,
      event: degraded,
      rule: { title: '群聊' },
      policy: { ownId: 'wxid_me', instructions: '自然回复', provider: 'test', model: 'test' },
    },
    new AbortController().signal,
  );
  assert.equal(prompted.length, 1);
  const singleText = prompted[0].content
    .filter((p: { type?: string }) => p.type === 'text')
    .map((p: { text?: string }) => p.text)
    .join('\n');
  assert.ok(singleText.includes('当前仅获取到低清缩略图，细节可能不清'));
});
