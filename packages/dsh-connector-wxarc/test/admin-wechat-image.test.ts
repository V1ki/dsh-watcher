import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import type { AdminWechatMessage } from '@local/dsh-hub/contracts';
import { Automation } from '../src/automation.js';
import { createWxarcBridge } from '../src/bridge.js';
import { Store } from '../src/core.js';
import { createWxarcHostBridge, type HostBridgeDeliverContext } from '../src/host-side-bridge.js';
import { loadLocalImage, type OutgoingImageData } from '../src/outgoing-image.js';
import { OBSTRUCTED } from '../src/resend.js';
import { createWechatTransport } from '../src/transport.js';

const VALID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

const VALID_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);

const VALID_GIF = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'binary');

function createFixture(t: TestContext, controllerId = 'wxid_admin_demo') {
  const dir = mkdtempSync(join(tmpdir(), 'wxarc-admin-img-'));
  const store = new Store(dir);
  let clock = 1_700_000_000_000;
  const textSends: string[] = [];
  const imageSends: Array<{ session?: string; image?: string; mime: string; bytesLen: number }> = [];
  const warnLogs: string[] = [];
  let imageCommitImpl: (
    img: OutgoingImageData,
  ) => Promise<{ confirmed: boolean; detail?: string }> = async () => ({ confirmed: true });

  const cua = {
    prepare: async (job: Record<string, any>) => async () => {
      textSends.push(job.decision.text);
      return { confirmed: true };
    },
  };
  const listener = {
    status: () => ({ healthy: true }),
    wechatRoot: '/data/wxid_bot_1234',
    enrichQuote: async (ev: Record<string, any>) => {
      if (ev.local_type === 49 && typeof ev.text === 'string' && ev.text.startsWith('[引用] ')) {
        return {
          ...ev,
          quote: {
            status: 'available',
            body: ev.text.replace(/^\[引用\]\s?/, ''),
            text: '[#150] 原始问题汇报',
          },
        };
      }
      return ev;
    },
  };
  const auto = new Automation({
    store,
    listener,
    cua,
    wxarcHome: dir,
    resolveSource: (_h: string, e: Record<string, any>) => ({
      ...e,
      sourceKey: `key-${e.id}`,
      senderId: e.senderId ?? e.sender,
      account: '/data/wxid_bot_1234/db_storage',
    }),
    resolveTarget: async (e: Record<string, any>) => ({
      kind: 'text',
      sourceId: e.session,
      title: e.session,
      search: e.session,
      wechatId: e.session,
      uniqueTitle: true,
    }),
    prepareOutgoingImage: async (_auto, job, img) => {
      const commit = async () => {
        imageSends.push({
          session: job.event.session,
          image: job.decision.image,
          mime: img.mime,
          bytesLen: img.bytes.length,
        });
        return imageCommitImpl(img);
      };
      commit.discard = async () => {};
      commit.deliveryDetail = `图片：${job.decision.image ?? ''}`;
      return commit;
    },
    logger: {
      warn: (...args: unknown[]) => {
        warnLogs.push(args.map((x) => String(x)).join(' '));
      },
    },
    now: () => clock,
  });

  auto.save(
    {
      ...auto.settings().policy,
      enabled: true,
      mode: 'send',
      provider: 'test',
      model: 'test',
      ownId: 'wxid_bot',
      controllerId,
      instructions: '自然回复',
      allChats: true,
    },
    0,
  );

  t.after(async () => {
    await auto.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  return {
    dir,
    store,
    auto,
    listener,
    textSends,
    imageSends,
    warnLogs,
    setClock: (v: number) => {
      clock = v;
    },
    setImageCommitImpl: (
      fn: (img: OutgoingImageData) => Promise<{ confirmed: boolean; detail?: string }>,
    ) => {
      imageCommitImpl = fn;
    },
  };
}

test('exposes controllerId across WxarcBridge, WxarcHostBridge, and DualModeWechatTransport (Cordis & HTTP)', async (t) => {
  const f = createFixture(t, 'wxid_admin_001');
  const wxarcBridge = createWxarcBridge({
    automation: f.auto,
    listener: f.listener,
    token: 'bridge-secret-ctrl',
  });

  const bridgeStatus = wxarcBridge.status();
  assert.equal(bridgeStatus.ownId, 'wxid_bot');
  assert.equal(bridgeStatus.controllerId, 'wxid_admin_001');

  const cordisTransport = createWechatTransport({
    config: { mode: 'cordis' },
    localBridge: wxarcBridge,
  });
  const cordisStatus = await cordisTransport.status();
  assert.equal(cordisStatus.mode, 'cordis');
  assert.equal(cordisStatus.ownId, 'wxid_bot');
  assert.equal(cordisStatus.controllerId, 'wxid_admin_001');

  const server = createServer((req, res) => {
    void wxarcBridge.handleHttpRequest(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const port = (server.address() as AddressInfo).port;

  const httpTransport = createWechatTransport({
    config: {
      mode: 'http',
      remoteBaseUrl: `http://127.0.0.1:${port}`,
      bridgeToken: 'bridge-secret-ctrl',
    },
  });
  const httpStatus = await httpTransport.status();
  assert.equal(httpStatus.mode, 'http');
  assert.equal(httpStatus.ownId, 'wxid_bot');
  assert.equal(httpStatus.controllerId, 'wxid_admin_001');

  const hostDb = new DatabaseSync(':memory:');
  t.after(() => hostDb.close());
  const hostBridge = createWxarcHostBridge({
    db: hostDb,
    token: 'host-secret',
    automation: {
      settings: () => ({
        policy: { ownId: 'wxid_bot', controllerId: 'wxid_host_admin' },
      }),
    },
    listener: { status: () => ({ healthy: true }) },
  });
  const hostStatus = hostBridge.status();
  assert.equal(hostStatus.ownId, 'wxid_bot');
  assert.equal(hostStatus.controllerId, 'wxid_host_admin');
});

test('sendProactive supports image-only, text+image, marks sending before commit, marks uncertain on mid-send failure, and rejects invalid imagePath', async (t) => {
  const f = createFixture(t);
  const pngPath = join(f.dir, 'shot.png');
  const jpgPath = join(f.dir, 'photo.jpg');
  const fakePngPath = join(f.dir, 'fake.png');
  const gifPath = join(f.dir, 'anim.gif');
  const wrongMagicPngPath = join(f.dir, 'jpg-named.png');
  const oversizedPath = join(f.dir, 'huge.png');

  writeFileSync(pngPath, VALID_PNG);
  writeFileSync(jpgPath, VALID_JPEG);
  writeFileSync(fakePngPath, Buffer.from('not an image at all', 'utf8'));
  writeFileSync(gifPath, VALID_GIF);
  writeFileSync(wrongMagicPngPath, VALID_JPEG);
  writeFileSync(oversizedPath, Buffer.concat([VALID_PNG, Buffer.alloc(8 * 1024 * 1024)]));

  assert.equal(loadLocalImage(pngPath).mime, 'image/png');
  assert.equal(loadLocalImage(jpgPath).mime, 'image/jpeg');

  for (const badPath of [
    './relative.png',
    join(f.dir, 'does-not-exist.png'),
    gifPath,
    fakePngPath,
    wrongMagicPngPath,
    oversizedPath,
  ]) {
    const res = await f.auto.sendProactive({
      idempotencyKey: `bad-${badPath}`,
      session: 'wxid_admin_demo',
      text: '不会发送',
      imagePath: badPath,
    });
    assert.equal(res.status, 'failed');
  }
  assert.equal(f.textSends.length, 0);
  assert.equal(f.imageSends.length, 0);

  const imageOnly = await f.auto.sendProactive({
    idempotencyKey: 'img-only-1',
    session: 'wxid_admin_demo',
    text: '',
    imagePath: pngPath,
  });
  assert.equal(imageOnly.status, 'sent');
  assert.equal(f.textSends.length, 0);
  assert.equal(f.imageSends.length, 1);
  assert.equal(f.imageSends[0].mime, 'image/png');
  assert.equal(f.imageSends[0].image, 'shot.png');

  const events: string[] = [];
  const origPrepare = f.auto.cua.prepare;
  f.auto.cua.prepare = async (job: Record<string, any>) => async () => {
    events.push(`text:${job.decision.text}`);
    f.textSends.push(job.decision.text);
    return { confirmed: true };
  };
  f.setImageCommitImpl(async () => {
    const row = f.store.db
      .prepare('SELECT status, clicked_at FROM proactive_deliveries WHERE idempotency_key = ?')
      .get('text-plus-img-1') as { status: string; clicked_at: number | null };
    assert.equal(row.status, 'sending');
    assert.ok(typeof row.clicked_at === 'number' && row.clicked_at > 0);
    events.push('image:photo.jpg');
    return { confirmed: true };
  });

  const textAndImage = await f.auto.sendProactive({
    idempotencyKey: 'text-plus-img-1',
    session: 'wxid_admin_demo',
    text: ['改好了，看截图'],
    imagePath: jpgPath,
  });
  assert.equal(textAndImage.status, 'sent');
  assert.deepEqual(events, ['text:改好了，看截图', 'image:photo.jpg']);

  f.auto.cua.prepare = origPrepare;
  let crashAttempts = 0;
  f.setImageCommitImpl(async () => {
    crashAttempts += 1;
    throw new Error('click failed while sending screenshot');
  });
  const crashed = await f.auto.sendProactive({
    idempotencyKey: 'img-crash-1',
    session: 'wxid_admin_demo',
    text: '',
    imagePath: pngPath,
  });
  assert.equal(crashed.status, 'uncertain');
  assert.equal(crashAttempts, 1);

  const noReplay = await f.auto.sendProactive({
    idempotencyKey: 'img-crash-1',
    session: 'wxid_admin_demo',
    text: '',
    imagePath: pngPath,
  });
  assert.equal(noReplay.status, 'uncertain');
  assert.equal(crashAttempts, 1);

  const wxarcBridge = createWxarcBridge({
    automation: f.auto,
    listener: f.listener,
    token: 'img-http-token',
  });
  f.setImageCommitImpl(async () => ({ confirmed: true }));
  const server = createServer((req, res) => {
    void wxarcBridge.handleHttpRequest(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const port = (server.address() as AddressInfo).port;
  const httpTransport = createWechatTransport({
    config: {
      mode: 'http',
      remoteBaseUrl: `http://127.0.0.1:${port}`,
      bridgeToken: 'img-http-token',
    },
  });
  const httpSend = await httpTransport.send({
    chatId: 'wxid_admin_demo',
    text: 'HTTP 截图发送',
    imagePath: pngPath,
    idempotencyKey: 'http-img-1',
  });
  assert.equal(httpSend.status, 'sent');

  const hostDb = new DatabaseSync(':memory:');
  t.after(() => hostDb.close());
  const deliveredHost: HostBridgeDeliverContext[] = [];
  const hostBridge = createWxarcHostBridge({
    db: hostDb,
    ownId: 'wxid_bot',
    deliverParts: (ctx) => {
      deliveredHost.push(ctx);
    },
  });
  const hostImgOk = await hostBridge.send({
    chatId: 'wxid_admin_demo',
    text: '',
    imagePath: pngPath,
    idempotencyKey: 'host-img-1',
  });
  assert.equal(hostImgOk.status, 'sent');
  assert.equal(deliveredHost.length, 1);
  assert.equal(deliveredHost[0].imagePath, pngPath);

  const hostImgBad = await hostBridge.send({
    chatId: 'wxid_admin_demo',
    text: '坏图',
    imagePath: fakePngPath,
    idempotencyKey: 'host-img-bad',
  });
  assert.equal(hostImgBad.status, 'failed');
});

test('adminWechatHandler intercepts controllerId DMs when handled, forwards quote context, falls through on unhandled/error, and ignores non-admins', async (t) => {
  const f = createFixture(t, 'wxid_admin_demo');
  const pngPath = join(f.dir, 'reply-shot.png');
  writeFileSync(pngPath, VALID_PNG);
  const nowSec = Math.floor(1_700_000_000_000 / 1000);

  const received: AdminWechatMessage[] = [];
  f.auto.setAdminWechatHandler(async (msg) => {
    received.push(msg);
    if (msg.text === '下一个') {
      return {
        handled: true,
        replyText: '已切换到下一条 [#151]',
        imagePath: pngPath,
      };
    }
    if (msg.text === '引用确认') {
      return {
        handled: true,
        replyText: `收到关于 ${msg.quotedText} 的反馈`,
      };
    }
    if (msg.text === '触发异常') {
      throw new Error('router boom');
    }
    return { handled: false };
  });

  f.store.commit(
    'text',
    0,
    [
      {
        id: 101,
        kind: 'text',
        session: 'wxid_admin_demo',
        sender: 'wxid_admin_demo',
        text: '下一个',
        ts: nowSec - 10,
        local_type: 1,
      },
      {
        id: 102,
        kind: 'text',
        session: 'wxid_admin_demo',
        sender: 'wxid_admin_demo',
        text: '[引用] 引用确认',
        ts: nowSec - 9,
        local_type: 49,
      },
      {
        id: 103,
        kind: 'text',
        session: 'wxid_admin_demo',
        sender: 'wxid_admin_demo',
        text: '晚上吃啥',
        ts: nowSec - 8,
        local_type: 1,
      },
      {
        id: 104,
        kind: 'text',
        session: 'wxid_admin_demo',
        sender: 'wxid_admin_demo',
        text: '触发异常',
        ts: nowSec - 7,
        local_type: 1,
      },
      {
        id: 105,
        kind: 'text',
        session: 'wxid_other_user',
        sender: 'wxid_other_user',
        text: '下一个',
        ts: nowSec - 6,
        local_type: 1,
      },
      {
        id: 106,
        kind: 'text',
        session: 'group1@chatroom',
        sender: 'wxid_admin_demo',
        text: '下一个',
        ts: nowSec - 5,
        local_type: 1,
      },
    ],
    1000,
  );

  await f.auto.collect();
  await new Promise((r) => setTimeout(r, 800));

  assert.equal(received.length, 4);
  assert.equal(received[0].text, '下一个');
  assert.equal(received[1].text, '引用确认');
  assert.equal(received[1].quotedText, '[#150] 原始问题汇报');
  assert.equal(received[2].text, '晚上吃啥');
  assert.equal(received[3].text, '触发异常');

  assert.ok(f.warnLogs.some((line) => line.includes('router boom')));

  const jobs = f.auto.jobs();
  const jobTexts = jobs.map((j) => j.event.text).sort();
  assert.deepEqual(jobTexts, ['下一个', '下一个', '晚上吃啥', '触发异常']);
  assert.equal(
    jobs.some((j) => j.event.session === 'wxid_admin_demo' && j.event.text === '下一个'),
    false,
  );
  assert.equal(
    jobs.some((j) => j.event.session === 'wxid_admin_demo' && j.event.text === '[引用] 引用确认'),
    false,
  );

  assert.ok(f.textSends.includes('已切换到下一条 [#151]'));
  assert.ok(f.textSends.includes('收到关于 [#150] 原始问题汇报 的反馈'));
  assert.equal(f.imageSends.length, 1);
  assert.equal(f.imageSends[0].session, 'wxid_admin_demo');
  assert.equal(f.imageSends[0].image, 'reply-shot.png');

  const deliveries = f.auto.proactiveDeliveries(10);
  assert.ok(deliveries.some((d) => d.idempotency_key === 'admin-wechat-reply:1' && d.status === 'sent'));
  assert.ok(deliveries.some((d) => d.idempotency_key === 'admin-wechat-reply:2' && d.status === 'sent'));
});

test('concurrent duplicate idempotencyKey while queued never replays in Automation or WxarcHostBridge', async (t) => {
  const f = createFixture(t, 'wxid_admin_demo');
  let sendAttempts = 0;
  let crashAttempts = 0;
  f.auto.cua.prepare = async (job: Record<string, any>) => async () => {
    await new Promise((r) => setTimeout(r, 40));
    if (job.decision.text === 'crash-once') {
      crashAttempts += 1;
      throw new Error('mid-click crash');
    }
    sendAttempts += 1;
    f.textSends.push(job.decision.text);
    return { confirmed: true };
  };

  const blocker = f.auto.sendProactive({
    idempotencyKey: 'blocker-key',
    session: 'wxid_admin_demo',
    text: '先占队列',
  });
  const dup1 = f.auto.sendProactive({
    idempotencyKey: 'dup-queued-key',
    session: 'wxid_admin_demo',
    text: '并发只发一次',
  });
  const dup2 = f.auto.sendProactive({
    idempotencyKey: 'dup-queued-key',
    session: 'wxid_admin_demo',
    text: '并发只发一次',
  });
  const crash1 = f.auto.sendProactive({
    idempotencyKey: 'dup-crash-key',
    session: 'wxid_admin_demo',
    text: 'crash-once',
  });
  const crash2 = f.auto.sendProactive({
    idempotencyKey: 'dup-crash-key',
    session: 'wxid_admin_demo',
    text: 'crash-once',
  });

  const [bRes, r1, r2, c1, c2] = await Promise.all([blocker, dup1, dup2, crash1, crash2]);
  assert.equal(bRes.status, 'sent');
  assert.equal(r1.status, 'sent');
  assert.equal(r2.status, 'sent');
  assert.equal(r1.deliveryId, r2.deliveryId);
  assert.equal(sendAttempts, 2);
  assert.equal(c1.status, 'uncertain');
  assert.equal(c2.status, 'uncertain');
  assert.equal(c1.deliveryId, c2.deliveryId);
  assert.equal(crashAttempts, 1);

  const hostDb = new DatabaseSync(':memory:');
  t.after(() => hostDb.close());
  let hostDeliverCalls = 0;
  const hostBridge = createWxarcHostBridge({
    db: hostDb,
    ownId: 'wxid_bot',
    deliverParts: async (ctx) => {
      await new Promise((r) => setTimeout(r, 30));
      hostDeliverCalls += 1;
      if (ctx.parts[0] === 'host-crash') {
        throw new Error('host click crash');
      }
    },
  });

  const [hBlock, hDup1, hDup2, hCrash1, hCrash2] = await Promise.all([
    hostBridge.send({ chatId: 'wxid_admin_demo', text: '占队', idempotencyKey: 'h-block' }),
    hostBridge.send({ chatId: 'wxid_admin_demo', text: '只发一次', idempotencyKey: 'h-dup' }),
    hostBridge.send({ chatId: 'wxid_admin_demo', text: '只发一次', idempotencyKey: 'h-dup' }),
    hostBridge.send({ chatId: 'wxid_admin_demo', text: 'host-crash', idempotencyKey: 'h-crash' }),
    hostBridge.send({ chatId: 'wxid_admin_demo', text: 'host-crash', idempotencyKey: 'h-crash' }),
  ]);
  assert.equal(hBlock.status, 'sent');
  assert.equal(hDup1.status, 'sent');
  assert.equal(hDup2.status, 'sent');
  assert.equal(hDup1.deliveryId, hDup2.deliveryId);
  assert.equal(hCrash1.status, 'uncertain');
  assert.equal(hCrash2.status, 'uncertain');
  assert.equal(hCrash1.deliveryId, hCrash2.deliveryId);
  assert.equal(hostDeliverCalls, 3);
});

test('pendingAdminReply logs warning and falls back to text-only when imagePath is missing', async (t) => {
  const f = createFixture(t, 'wxid_admin_demo');
  const nowSec = Math.floor(1_700_000_000_000 / 1000);
  f.auto.setAdminWechatHandler(async () => ({
    handled: true,
    replyText: '截图临时文件没了，但文字得送达',
    imagePath: join(f.dir, 'deleted-screenshot.png'),
  }));
  f.store.commit(
    'text',
    0,
    [
      {
        id: 201,
        kind: 'text',
        session: 'wxid_admin_demo',
        sender: 'wxid_admin_demo',
        text: '下一个',
        ts: nowSec - 5,
        local_type: 1,
      },
    ],
    1000,
  );

  await f.auto.collect();
  await new Promise((r) => setTimeout(r, 400));

  assert.ok(f.warnLogs.some((line) => line.includes('管理员微信自动回复未送达')));
  assert.ok(f.textSends.includes('截图临时文件没了，但文字得送达'));
  assert.equal(f.imageSends.length, 0);
  const deliveries = f.auto.proactiveDeliveries(10);
  assert.ok(
    deliveries.some(
      (d) => d.idempotency_key === 'admin-wechat-reply:1:text-fallback' && d.status === 'sent',
    ),
  );
});

test('sendProactive retries up to 2 times on OBSTRUCTED only when sentSteps === 0 and never retries after sentSteps > 0', async (t) => {
  const f = createFixture(t, 'wxid_admin_demo');
  f.auto.proactiveRetryDelaysMs = [5, 10];

  let firstKeyAttempts = 0;
  f.auto.cua.prepare = async (job: Record<string, any>) => {
    if (job.decision.text === 'retry-and-succeed') {
      firstKeyAttempts += 1;
      if (firstKeyAttempts <= 2) {
        throw new Error(OBSTRUCTED);
      }
      return async () => {
        f.textSends.push(job.decision.text);
        return { confirmed: true };
      };
    }
    if (job.decision.text === 'retry-and-exhaust') {
      firstKeyAttempts += 1;
      throw new Error(OBSTRUCTED);
    }
    if (job.decision.text === 'seg-1') {
      return async () => {
        f.textSends.push(job.decision.text);
        return { confirmed: true };
      };
    }
    if (job.decision.text === 'seg-2') {
      firstKeyAttempts += 1;
      throw new Error(OBSTRUCTED);
    }
    return async () => ({ confirmed: true });
  };

  const ok = await f.auto.sendProactive({
    idempotencyKey: 'proactive-retry-ok',
    session: 'wxid_admin_demo',
    text: 'retry-and-succeed',
  });
  assert.equal(ok.status, 'sent');
  assert.equal(firstKeyAttempts, 3);
  assert.ok(f.textSends.includes('retry-and-succeed'));

  firstKeyAttempts = 0;
  const failed = await f.auto.sendProactive({
    idempotencyKey: 'proactive-retry-exhaust',
    session: 'wxid_admin_demo',
    text: 'retry-and-exhaust',
  });
  assert.equal(failed.status, 'failed');
  assert.equal(firstKeyAttempts, 3);
  const failedRow = f.store.db
    .prepare('SELECT status, clicked_at FROM proactive_deliveries WHERE idempotency_key = ?')
    .get('proactive-retry-exhaust') as { status: string; clicked_at: number | null };
  assert.equal(failedRow.status, 'failed');
  assert.equal(failedRow.clicked_at, null);

  firstKeyAttempts = 0;
  const partialUncertain = await f.auto.sendProactive({
    idempotencyKey: 'proactive-no-retry-after-sent-step',
    session: 'wxid_admin_demo',
    text: ['seg-1', 'seg-2'],
  });
  assert.equal(partialUncertain.status, 'uncertain');
  assert.equal(firstKeyAttempts, 1);
  assert.ok(f.textSends.includes('seg-1'));
});
