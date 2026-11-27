import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentBridge } from '../src/agent.js';
import { Automation } from '../src/automation.js';
import { batchContent } from '../src/batch.js';
import { Store, messageBody } from '../src/core.js';
import { ImageReader } from '../src/images.js';
import { MediaPreprocessor, buildMultimodalPromptGuidance } from '../src/media.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6dGAAAAAASUVORK5CYII=',
  'base64',
);
const WAV_HEADER = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.alloc(4, 0),
  Buffer.from('WAVE', 'ascii'),
  Buffer.alloc(40, 1),
]);
const signal = () => new AbortController().signal;

test('P2: Automation unblocks voice (local_type 34) and video (local_type 43) with empty text while still filtering system notices', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wxarc-p2-auto-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  t.after(() => store.close());
  const nowSec = Math.floor(Date.now() / 1000);
  const auto = new Automation({
    store,
    listener: { status: () => ({ healthy: true }), wechatRoot: '/data/wxid_me_abcd' },
    cua: { prepare: async () => async () => ({ confirmed: true }) },
    wxarcHome: dir,
  });
  auto.save(
    {
      ...auto.settings().policy,
      enabled: true,
      allChats: true,
      mode: 'draft',
      provider: 'test',
      model: 'test',
      instructions: '自然回复',
      ownId: 'wxid_me',
      debounceMs: 0,
    },
    0,
  );

  store.commit(
    'text',
    store.cursor('text').id,
    [
      {
        id: 1,
        kind: 'text',
        session: 'family@chatroom',
        sender: '妈妈',
        local_type: 34,
        text: '',
        ts: nowSec,
      },
      {
        id: 2,
        kind: 'text',
        session: 'family@chatroom',
        sender: '爸爸',
        local_type: 43,
        text: '',
        ts: nowSec,
      },
      {
        id: 3,
        kind: 'text',
        session: 'family@chatroom',
        sender: '系统',
        local_type: 10000,
        text: '拍了拍',
        ts: nowSec,
      },
    ],
    1000,
  );

  await auto.collect();
  const jobs = auto.jobs();
  assert.equal(jobs.length, 2);
  const types = jobs.map((j: any) => j.event.local_type).sort((a: number, b: number) => a - b);
  assert.deepEqual(types, [34, 43]);
});

test('P2: MediaPreprocessor decodes voice SILK->WAV with graceful cloud fallback when optional NAS ASR fails (502)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wxarc-p2-voice-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const voiceEvent = {
    id: 34,
    kind: 'text',
    session: 'family@chatroom',
    sender: '妈妈',
    local_type: 34,
    text: '',
    ts: 1700000000,
  };
  let decodeCalled = false;
  let nasCalled = false;
  let cloudCalled = false;

  const media = new MediaPreprocessor({
    dir,
    listener: {
      base: 'http://127.0.0.1:28765',
      get: async () => [
        {
          ...voiceEvent,
          media: { kind: 'voice', status: 'available', url: '/voice/34.silk', duration_sec: 8 },
        },
      ],
    },
    fetcher: async (url) => {
      assert.equal(url, 'http://127.0.0.1:28765/voice/34.silk');
      return new Response(Buffer.from('#!SILK_V3_MOCK'));
    },
    decodeSilk: async ({ wavPath }) => {
      decodeCalled = true;
      writeFileSync(wavPath, WAV_HEADER);
      return { wavPath, bytes: WAV_HEADER, durationSec: 8 };
    },
    optionalNasAsr: async () => {
      nasCalled = true;
      throw new Error('HTTP 502 Bad Gateway from NAS 18000');
    },
    cloudAsr: async (input) => {
      cloudCalled = true;
      assert.equal(input.mimeType, 'audio/wav');
      return { transcript: '这辆红色小火车是姑姑送的', provider: 'cloud-asr' };
    },
  });

  const enriched = await media.enrichVoice(voiceEvent, signal());
  assert.equal(decodeCalled, true);
  assert.equal(nasCalled, true);
  assert.equal(cloudCalled, true);
  assert.equal(enriched.voice?.status, 'transcribed');
  assert.equal(enriched.voice?.nasDegraded, true);
  assert.equal(enriched.voice?.usedCloudAsr, true);
  assert.equal(enriched.voice?.transcript, '这辆红色小火车是姑姑送的');
  assert.equal(messageBody(enriched), '[语音转写] 这辆红色小火车是姑姑送的');
});

test('P2: MediaPreprocessor extracts video keyframes + audio only in allowed family short videos and degrades cleanly to poster_only otherwise', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wxarc-p2-video-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const shortVideo = {
    id: 43,
    kind: 'text',
    session: 'family@chatroom',
    sender: '爸爸',
    local_type: 43,
    text: '[视频]',
    ts: 1700000100,
  };
  let extractCalls = 0;

  const media = new MediaPreprocessor({
    dir,
    listener: {
      base: 'http://127.0.0.1:28765',
      get: async () => [
        {
          ...shortVideo,
          media: {
            kind: 'video',
            status: 'available',
            poster_url: '/poster/43.png',
            video_url: '/video/43.mp4',
            duration_sec: 12,
          },
        },
      ],
    },
    fetcher: async (url) => {
      if (url.endsWith('/poster/43.png')) {
        return new Response(PNG_1X1);
      }
      return new Response(Buffer.from('MP4_MOCK_BYTES'));
    },
    extractVideoTracks: async ({ maxKeyframes }) => {
      extractCalls += 1;
      assert.ok(maxKeyframes >= 3 && maxKeyframes <= 5);
      return {
        keyframes: [{ bytes: PNG_1X1 }, { bytes: PNG_1X1 }, { bytes: PNG_1X1 }],
        audioBytes: WAV_HEADER,
      };
    },
    cloudAsr: async () => ({ transcript: '宝宝在拼乐高' }),
  });

  const externalResult = await media.enrichVideo(
    shortVideo,
    { allowDeepVideo: false, circle: 'external' },
    signal(),
  );
  assert.equal(extractCalls, 0);
  assert.equal(externalResult.video?.status, 'poster_only');
  assert.equal(externalResult.video?.keyframesSkippedReason, 'circle_not_allowed_for_deep_video');
  assert.equal(media.videoImageParts(externalResult).length, 1);

  const familyResult = await media.enrichVideo(
    shortVideo,
    { allowDeepVideo: true, circle: 'family' },
    signal(),
  );
  assert.equal(extractCalls, 1);
  assert.equal(familyResult.video?.status, 'ready');
  assert.equal(familyResult.video?.keyframes?.length, 3);
  assert.equal(familyResult.video?.transcript, '宝宝在拼乐高');
  assert.equal(media.videoImageParts(familyResult).length, 3);
  assert.match(messageBody(familyResult), /\[视频画外音转写\] 宝宝在拼乐高/);

  const batchParts = batchContent(
    {
      ...familyResult,
      batch: { messages: [familyResult as any] },
    } as any,
    {
      part: () => ({ type: 'image', mediaType: 'image/png', data: PNG_1X1.toString('base64') }),
      videoParts: (e) => media.videoImageParts(e as any) as any,
    },
  );
  assert.equal(batchParts.filter((p) => p.type === 'image').length, 3);
  assert.match(String(batchParts[0].text), /宝宝在拼乐高/);
});

test('P2 Redlines #8/#9: two-step photo recall attaches max 2 circle-scoped reference cards + confirmed facts in family group, zero in external group, handles NAS-down gracefully, and records candidate-only visual observation', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wxarc-p2-recall-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  t.after(() => store.close());
  const imgDir = join(dir, 'images');
  const reader = new ImageReader({
    dir: imgDir,
    listener: { base: 'http://127.0.0.1:28765', get: async () => [] },
  });
  const incomingHash = createHash('sha256').update(PNG_1X1).digest('hex');
  const incomingPath = join(imgDir, `${incomingHash}.png`);
  writeFileSync(incomingPath, PNG_1X1);

  const refCardPath1 = join(dir, 'ref-kid-1.png');
  const refCardPath2 = join(dir, 'ref-toy-2.png');
  const refCardPath3 = join(dir, 'ref-extra-3.png');
  writeFileSync(refCardPath1, PNG_1X1);
  writeFileSync(refCardPath2, PNG_1X1);
  writeFileSync(refCardPath3, PNG_1X1);

  const prompts: Array<Record<string, any>> = [];
  const agents = new Map<string, any>();
  const hooks: Record<string, (...args: any[]) => any> = {};
  const upsertedAssets: Array<Record<string, any>> = [];
  const recordedObservations: Array<Record<string, any>> = [];
  const recallCalls: Array<Record<string, any>> = [];

  const ctx: any = {
    on: (type: string, fn: (...args: any[]) => any) => {
      hooks[type] = fn;
      return () => {
        delete hooks[type];
      };
    },
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
    },
    workspaceRegistry: { get: () => ({ attachSession: async () => {} }) },
    sessionController: {
      resolveAgent: async (id: string) =>
        agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found' } },
      create: async ({ sessionId, cwd }: { sessionId: string; cwd: string }) => {
        const agent = {
          id: sessionId,
          cwd,
          session: { header: {} },
          inbox: { clear() {} },
          model: { select() {} },
          whenIdle: async () => {},
          cancel() {},
          busy: false,
        };
        agents.set(sessionId, agent);
        hooks['agent/created']?.({ agent });
        return { sessionId };
      },
      rename: async () => {},
      state: async () => ({ running: false, queue: [], pendingInput: [] }),
      prompt: async (req: Record<string, any>) => {
        prompts.push(req);
      },
    },
  };

  const bridge = new AgentBridge(ctx, store, {
    root: join(dir, 'work'),
    images: reader,
    optionalNasVisionTags: async () => {
      throw new Error('HTTP 502 NAS 18000 down');
    },
    extractVisualTags: async () => ({ tags: ['小男孩', '红色小火车'] }),
    personas: {
      context: (_id: string, event: Record<string, any>) => ({
        name: '小岚',
        circle: event.session === 'family@chatroom' ? 'family' : 'external',
      }),
      getChatCircle: (chatId: string) => ({
        chatId,
        circle: chatId === 'family@chatroom' ? 'family' : 'external',
      }),
      recallMultimodal: (input: Record<string, unknown>) => {
        recallCalls.push(input);
        const isFamily = input.chatId === 'family@chatroom';
        return {
          chatId: input.chatId,
          circle: isFamily ? 'family' : 'external',
          version: 3,
          cards: [
            {
              card: {
                id: 'c1',
                entityName: '乐乐',
                description: '正面参考图',
                circle: 'family',
                imagePath: refCardPath1,
              },
            },
            {
              card: {
                id: 'c-work',
                entityName: '同事A',
                description: '工作圈参考图',
                circle: 'work',
                imagePath: refCardPath2,
              },
            },
            {
              card: {
                id: 'c2',
                entityName: '红色小火车',
                description: '木质玩具',
                circle: 'family',
                imagePath: refCardPath2,
              },
            },
            {
              card: {
                id: 'c3',
                entityName: '第三张超限图',
                description: '不应附带',
                circle: 'family',
                imagePath: refCardPath3,
              },
            },
          ],
          facts: [
            {
              fact: {
                subjectName: '姑姑',
                predicate: '送给乐乐',
                objectName: '红色小火车',
                statement: '红色小火车是姑姑上周送给乐乐的',
                circle: 'family',
                status: 'confirmed',
              },
            },
            {
              fact: {
                subjectName: '候选未证实',
                predicate: '猜测',
                objectName: '某玩具',
                statement: '纯视觉猜测不应注入',
                circle: 'family',
                status: 'candidate',
              },
            },
          ],
        };
      },
      upsertMediaAsset: (input: Record<string, unknown>) => {
        upsertedAssets.push(input);
        return { id: `asset-${upsertedAssets.length}` };
      },
      recordVisualObservation: (input: Record<string, unknown>) => {
        recordedObservations.push(input);
        return { id: `obs-${recordedObservations.length}`, status: 'candidate' };
      },
    },
    settings: () => ({
      policy: {
        ownId: 'wxid_me',
        personaId: 'p1',
        provider: 'test',
        model: 'vision-model',
        instructions: '自然回复',
      },
    }),
  });

  const basePhotoEvent = {
    id: 901,
    kind: 'text',
    sender: '妈妈',
    senderId: 'wxid_mom',
    local_type: 3,
    text: '[图片]',
    ts: Math.floor(Date.now() / 1000),
    image: {
      path: incomingPath,
      hash: incomingHash,
      mediaType: 'image/png',
      bytes: PNG_1X1.length,
      dhash: '0f0f0f0f0f0f0f0f',
      status: 'read',
    },
  };

  const familyRun = await bridge.start(
    {
      event: { ...basePhotoEvent, session: 'family@chatroom' },
      rule: { title: '家人群' },
      policy: { ownId: 'wxid_me', personaId: 'p1', provider: 'test', model: 'vision-model' },
    },
    signal(),
  );

  assert.equal(recallCalls.length, 1);
  assert.equal(recallCalls[0].includeOwnerMemory, false);
  assert.equal(recallCalls[0].dhash, '0f0f0f0f0f0f0f0f');
  assert.ok((recallCalls[0].tags as string[]).includes('红色小火车'));

  const familyContentImages = prompts[0].content.filter((p: any) => p.type === 'image');
  assert.equal(familyContentImages.length, 3);
  assert.match(familyContentImages[1].name, /乐乐/);
  assert.match(familyContentImages[2].name, /红色小火车/);

  const familyPrompt = bridge.prompt(familyRun.session_id);
  assert.match(familyPrompt, /四信号综合判断/);
  assert.match(familyPrompt, /质量一票封顶/);
  assert.match(familyPrompt, /三档防尴尬话术/);
  assert.match(familyPrompt, /严禁凭像素脑补典故/);
  assert.match(familyPrompt, /candidate 草稿记录/);
  assert.match(familyPrompt, /NAS 视觉辅助服务当前不可用/);
  assert.match(familyPrompt, /红色小火车是姑姑上周送给乐乐的/);
  assert.doesNotMatch(familyPrompt, /纯视觉猜测不应注入/);
  assert.doesNotMatch(familyPrompt, /同事A/);

  assert.equal(upsertedAssets.length, 1);
  assert.equal(upsertedAssets[0].mediaType, 'image');
  assert.equal(upsertedAssets[0].chatId, 'family@chatroom');
  assert.equal(recordedObservations.length, 1);
  assert.equal(recordedObservations[0].mediaAssetId, 'asset-1');
  assert.equal(recordedObservations[0].chatId, 'family@chatroom');
  assert.equal(recordedObservations[0].circle, 'family');

  const externalRun = await bridge.start(
    {
      event: { ...basePhotoEvent, id: 902, session: 'external_clients@chatroom' },
      rule: { title: '外部客户群' },
      policy: { ownId: 'wxid_me', personaId: 'p1', provider: 'test', model: 'vision-model' },
    },
    signal(),
  );

  const externalContentImages = prompts[1].content.filter((p: any) => p.type === 'image');
  assert.equal(externalContentImages.length, 1);

  const externalPrompt = bridge.prompt(externalRun.session_id);
  assert.match(externalPrompt, /外部群或未贴圈层标签/);
  assert.doesNotMatch(externalPrompt, /乐乐/);
  assert.doesNotMatch(externalPrompt, /红色小火车是姑姑上周送给乐乐的/);

  const guidanceOnly = buildMultimodalPromptGuidance({ hasMedia: false });
  assert.equal(guidanceOnly, '');
});
