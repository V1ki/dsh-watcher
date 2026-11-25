import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openHubDb } from '@local/dsh-hub';
import type {
  ConnectorDescriptor,
  HubService,
  NormalizedEvent,
  SinkInvokeInput,
  SinkInvokeResult,
  WatchSource,
  WechatAtmosphere,
  WechatSendInput,
  WechatSendResult,
  WechatTransport,
} from '@local/dsh-hub/contracts';
import {
  apply,
  MemoEngine,
  MemoRoomCapError,
  pickRandomFireAt,
  registerMemoTools,
  type MemoToolDefinition,
  type WebSearchClient,
  type WebSearchResultItem,
} from '../src/index.js';

const EV_REHASH_URL = 'https://baijiahao.baidu.com/s?id=1001&utm_source=feed';
const EV_STALE_URL = 'https://auto.example.com/news/ev-recall-old';
const EV_CLICKBAIT_URL = 'https://news.example.com/ev-recall-rumor';
const EV_OFFICIAL_URL = 'https://official-ev.example.com/announcements/recall-battery-fix';

const GEMINI_RUMOR_URL = 'https://x.com/randomuser/status/123456789';
const GEMINI_WORKAROUND_URL = 'https://github.com/community/antigravity-429-proxy-bypass';
const GEMINI_REDDIT_URL = 'https://reddit.com/r/LocalLLaMA/comments/gemini_acp_speculation';
const GEMINI_OFFICIAL_URL = 'https://ai.google.dev/gemini-api/docs/acp-release-notes';

interface MockHarness {
  hub: HubService;
  watcher: HubService;
  ingested: NormalizedEvent[];
  sinkCalls: Array<{ sinkId: string; input: SinkInvokeInput }>;
  wechatSent: WechatSendInput[];
  registeredSources: WatchSource[];
  registeredConnectors: ConnectorDescriptor[];
  setAtmosphere: (next: Partial<WechatAtmosphere>) => void;
  setSinkMode: (mode: 'execute' | 'unavailable') => void;
  close: () => void;
}

function createMockHarness(initialAtmosphere: Partial<WechatAtmosphere> = {}): MockHarness {
  const db = openHubDb({ inMemory: true });
  const ingested: NormalizedEvent[] = [];
  const sinkCalls: Array<{ sinkId: string; input: SinkInvokeInput }> = [];
  const wechatSent: WechatSendInput[] = [];
  const registeredSources: WatchSource[] = [];
  const registeredConnectors: ConnectorDescriptor[] = [];
  let sinkMode: 'execute' | 'unavailable' = 'execute';

  let atmosphereState: WechatAtmosphere = {
    chatId: 'chat-moyu',
    healthy: true,
    paused: false,
    messageCount: 0,
    lastMessageAt: null,
    secondsSinceLastMessage: 3600,
    ownSpokeSince: false,
    quiet: true,
    recentMessages: [],
    ...initialAtmosphere,
  };

  let transport: WechatTransport | null = {
    async send(input: WechatSendInput): Promise<WechatSendResult> {
      wechatSent.push(input);
      return { status: 'sent', deliveryId: 'wx-del-1' };
    },
    async recentMessages() {
      return atmosphereState.recentMessages;
    },
    async getAtmosphere(params) {
      return { ...atmosphereState, chatId: params.chatId };
    },
    async status() {
      return { ok: true, mode: 'cordis', healthy: true };
    },
  };

  const hub = {
    configRevision: 1,
    db,
    wardrobe: null,
    guard: {} as HubService['guard'],
    getWardrobe: () => null,
    registerConnector(desc: ConnectorDescriptor) {
      registeredConnectors.push(desc);
      return () => {
        const idx = registeredConnectors.indexOf(desc);
        if (idx >= 0) registeredConnectors.splice(idx, 1);
      };
    },
    listConnectors() {
      return registeredConnectors.map((c) => ({
        id: c.id,
        label: c.label,
        kind: c.kind,
        panelId: c.panelId,
        panelLabel: c.panelLabel,
        health: c.health?.(),
      }));
    },
    registerSubscription: () => {
      throw new Error('not implemented in mock');
    },
    resolveSubscription: () => null,
    removeSubscription: () => false,
    listSubscriptions: () => [],
    onUnclaimedEvent: () => () => undefined,
    registerSource(source: WatchSource) {
      registeredSources.push(source);
      return () => {
        const idx = registeredSources.indexOf(source);
        if (idx >= 0) registeredSources.splice(idx, 1);
      };
    },
    registerResolver: () => () => undefined,
    registerSink: () => () => undefined,
    registerRule: () => () => undefined,
    registerWechatTransport(next: WechatTransport) {
      transport = next;
      return () => {
        transport = null;
      };
    },
    getWechatTransport() {
      return transport;
    },
    async ingest(event: NormalizedEvent) {
      ingested.push(event);
      return { accepted: true, inboxId: `inb_${ingested.length}` };
    },
    async invokeSink(sinkId: string, input: SinkInvokeInput): Promise<SinkInvokeResult> {
      sinkCalls.push({ sinkId, input });
      if (sinkMode === 'unavailable') {
        return { status: 'failed', detail: 'sink unavailable' };
      }
      return { status: 'executed', receiptId: `rcpt_${sinkCalls.length}` };
    },
    approveDraft: async () => ({ status: 'executed' }),
    discardDraft: async () => undefined,
    listInbox: () => [],
    listWorkstreams: () => [],
    listDrafts: () => [],
    getStatus: () => ({
      sources: [],
      connectors: [],
      sinks: [],
      wechatTransportMode: 'cordis',
      activeWorkstreams: 0,
      activeSubscriptions: 0,
      unreadInbox: 0,
      pendingDrafts: 0,
      autoSessionsThisHour: 0,
      configRevision: 1,
    }),
  } as HubService;

  return {
    hub,
    watcher: hub,
    ingested,
    sinkCalls,
    wechatSent,
    registeredSources,
    registeredConnectors,
    setAtmosphere(next) {
      atmosphereState = { ...atmosphereState, ...next };
    },
    setSinkMode(mode) {
      sinkMode = mode;
    },
    close() {
      db.close();
    },
  };
}

describe('Mode 1: time_nudge (randomized odd-minute window, no backfill, atmosphere & 24h budget)', () => {
  it('picks randomized odd-minute fire time inside window and never lands on :00', () => {
    const start = '2026-11-20T10:30:00.000Z';
    const end = '2026-11-20T12:30:00.000Z';
    const samples = [0, 0.13, 0.27, 0.5, 0.72, 0.99];

    for (const seed of samples) {
      const fireIso = pickRandomFireAt(start, end, () => seed);
      const fireDate = new Date(fireIso);
      const fireMs = fireDate.getTime();
      assert.ok(fireMs >= Date.parse(start) && fireMs <= Date.parse(end));
      assert.notEqual(fireDate.getUTCMinutes(), 0);
      assert.equal(fireDate.getUTCMinutes() % 2, 1);
    }
  });

  it('expires missed window without backfill after restart', async () => {
    const harness = createMockHarness();
    try {
      let currentTime = new Date('2026-11-18T10:00:00.000Z');
      const engine = new MemoEngine({
        watcher: harness.watcher,
        now: () => currentTime,
        rng: () => 0.4,
      });

      const memo = engine.createMemo({
        kind: 'time_nudge',
        roomKey: 'wechat:chat-moyu',
        targetChatId: 'chat-moyu',
        title: '周五产品演示',
        basis: '周三小李在摸鱼群说周五要做产品演示，有点慌',
        windowStart: '2026-11-20T10:30:00.000Z',
        windowEnd: '2026-11-20T12:30:00.000Z',
        keywords: ['演示', 'demo'],
      });

      assert.ok(memo.randomFireAt);
      assert.equal(new Date(memo.randomFireAt).getUTCMinutes() % 2, 1);

      currentTime = new Date('2026-11-20T14:00:00.000Z');
      const tickRes = await engine.tick();

      assert.equal(tickRes.polled, 1);
      assert.equal(tickRes.events, 0);
      assert.equal(tickRes.results[0].action, 'expired');
      assert.equal(harness.ingested.length, 0);
      assert.equal(engine.store.getMemo(memo.id)?.status, 'expired');
    } finally {
      harness.close();
    }
  });

  it('tears memo when chat is paused, active, owner spoke, or topic already discussed', async () => {
    const cases: Array<{ label: string; atm: Partial<WechatAtmosphere>; expectedReason: string }> = [
      {
        label: 'chat paused',
        atm: { paused: true, quiet: true },
        expectedReason: 'chat_paused',
      },
      {
        label: 'owner already spoke',
        atm: { ownSpokeSince: true, quiet: true },
        expectedReason: 'owner_already_spoke',
      },
      {
        label: 'active conversation right now',
        atm: { quiet: false, secondsSinceLastMessage: 45 },
        expectedReason: 'active_conversation',
      },
      {
        label: 'topic already discussed',
        atm: {
          quiet: true,
          secondsSinceLastMessage: 2400,
          recentMessages: [
            {
              chatId: 'chat-moyu',
              sender: '小李',
              text: '今天的演示超顺利，老板很满意！',
              timestamp: Date.parse('2026-11-20T10:45:00.000Z'),
            },
          ],
        },
        expectedReason: 'topic_already_discussed',
      },
    ];

    for (const tc of cases) {
      const harness = createMockHarness(tc.atm);
      try {
        let currentTime = new Date('2026-11-20T10:00:00.000Z');
        const engine = new MemoEngine({
          watcher: harness.watcher,
          now: () => currentTime,
          rng: () => 0.25,
        });

        const memo = engine.createMemo({
          kind: 'time_nudge',
          roomKey: 'wechat:chat-moyu',
          targetChatId: 'chat-moyu',
          title: '周五演示问候',
          basis: '周五问小李产品演示是否顺利',
          windowStart: '2026-11-20T10:30:00.000Z',
          windowEnd: '2026-11-20T12:30:00.000Z',
          keywords: ['演示'],
        });

        currentTime = new Date(Date.parse(memo.randomFireAt as string) + 5_000);
        const tickRes = await engine.tick();

        assert.equal(tickRes.results[0].action, 'torn', tc.label);
        assert.equal(tickRes.results[0].reason, tc.expectedReason, tc.label);
        assert.equal(harness.ingested.length, 0, tc.label);
        assert.equal(engine.store.getMemo(memo.id)?.status, 'torn', tc.label);
      } finally {
        harness.close();
      }
    }
  });

  it('fires cleanly when quiet and enforces 24h max-1 proactive budget per room', async () => {
    const harness = createMockHarness({ quiet: true, secondsSinceLastMessage: 5400 });
    try {
      let currentTime = new Date('2026-11-20T10:00:00.000Z');
      const engine = new MemoEngine({
        watcher: harness.watcher,
        now: () => currentTime,
        rng: () => 0.1,
      });

      const first = engine.createMemo({
        kind: 'time_nudge',
        roomKey: 'wechat:chat-moyu',
        targetChatId: 'chat-moyu',
        title: '周五演示问候',
        basis: '小李周五下午产品演示',
        windowStart: '2026-11-20T10:30:00.000Z',
        windowEnd: '2026-11-20T12:30:00.000Z',
        keywords: ['演示'],
      });

      const second = engine.createMemo({
        kind: 'time_nudge',
        roomKey: 'wechat:chat-moyu',
        targetChatId: 'chat-moyu',
        title: '周末聚餐提醒',
        basis: '顺口问一下周末聚餐地点',
        windowStart: '2026-11-20T13:00:00.000Z',
        windowEnd: '2026-11-20T15:00:00.000Z',
        keywords: ['聚餐'],
      });

      currentTime = new Date(Date.parse(first.randomFireAt as string) + 5_000);
      const res1 = await engine.tick();
      assert.equal(res1.events, 1);
      assert.equal(res1.results[0].action, 'fired');
      assert.equal(engine.store.getMemo(first.id)?.status, 'fired');
      assert.equal(harness.ingested.length, 1);
      assert.equal(harness.ingested[0].type, 'memo.time_nudge.due');

      currentTime = new Date(Date.parse(second.randomFireAt as string) + 5_000);
      const res2 = await engine.tick();
      assert.equal(res2.events, 0);
      assert.equal(res2.results[0].action, 'torn');
      assert.equal(res2.results[0].reason, 'proactive_budget_exhausted');
      assert.equal(engine.store.getMemo(second.id)?.status, 'torn');
      assert.equal(harness.ingested.length, 1);
    } finally {
      harness.close();
    }
  });

  it('allows next-day time_nudge in same evening window even when under 24h after previous day fire (calendar_day budget)', async () => {
    const harness = createMockHarness({ quiet: true, secondsSinceLastMessage: 5400 });
    try {
      let currentTime = new Date(2026, 10, 22, 17, 14, 11);
      const engine = new MemoEngine({
        watcher: harness.watcher,
        now: () => currentTime,
        rng: () => 0.1,
      });

      const day1 = engine.createMemo({
        kind: 'time_nudge',
        roomKey: 'wechat:chat-baduanjin',
        targetChatId: 'chat-baduanjin',
        notifyWechatChatId: 'chat-baduanjin',
        title: '提醒做八段锦（Day 1）',
        basis: '每天傍晚提醒做八段锦',
        windowStart: new Date(2026, 10, 22, 17, 0, 0).toISOString(),
        windowEnd: new Date(2026, 10, 22, 19, 0, 0).toISOString(),
        randomFireAt: new Date(2026, 10, 22, 17, 13, 43).toISOString(),
      });

      const res1 = await engine.tick();
      assert.equal(res1.results[0].action, 'fired');
      assert.equal(engine.store.getMemo(day1.id)?.status, 'fired');

      const day2 = engine.createMemo({
        kind: 'time_nudge',
        roomKey: 'wechat:chat-baduanjin',
        targetChatId: 'chat-baduanjin',
        notifyWechatChatId: 'chat-baduanjin',
        title: '提醒做八段锦（Day 2）',
        basis: '每天傍晚提醒做八段锦',
        windowStart: new Date(2026, 10, 23, 17, 0, 0).toISOString(),
        windowEnd: new Date(2026, 10, 23, 19, 0, 0).toISOString(),
        randomFireAt: new Date(2026, 10, 23, 17, 3, 21).toISOString(),
      });

      currentTime = new Date(2026, 10, 23, 17, 3, 37);
      const res2 = await engine.tick();
      assert.equal(res2.events, 1);
      assert.equal(res2.results[0].action, 'fired');
      assert.equal(engine.store.getMemo(day2.id)?.status, 'fired');
      assert.equal(harness.wechatSent.length, 2);
    } finally {
      harness.close();
    }
  });

  it('defers time_nudge instead of tearing when proactive budget recovers before windowEnd', async () => {
    const harness = createMockHarness({ quiet: true, secondsSinceLastMessage: 5400 });
    try {
      let currentTime = new Date('2026-11-22T09:14:11.000Z');
      const engine = new MemoEngine({
        watcher: harness.watcher,
        config: {
          proactiveBudgetMode: 'rolling',
          proactiveBudgetHours: 24,
          proactiveBudgetMaxPerRoom: 1,
        },
        now: () => currentTime,
      });

      engine.store.recordProactiveSend({
        roomKey: 'wechat:chat-baduanjin',
        channel: 'wechat',
        memoId: 'memo_prev',
        summary: 'previous day reminder',
        sentAt: '2026-11-22T09:14:11.000Z',
      });

      const memo = engine.createMemo({
        kind: 'time_nudge',
        roomKey: 'wechat:chat-baduanjin',
        targetChatId: 'chat-baduanjin',
        notifyWechatChatId: 'chat-baduanjin',
        title: '提醒做八段锦',
        basis: '17:00-19:00 窗口内提醒做八段锦',
        windowStart: '2026-11-23T09:00:00.000Z',
        windowEnd: '2026-11-23T11:00:00.000Z',
        randomFireAt: '2026-11-23T09:03:21.000Z',
      });

      currentTime = new Date('2026-11-23T09:03:37.000Z');
      const deferred = await engine.tick();
      assert.equal(deferred.events, 0);
      assert.equal(deferred.results[0].action, 'deferred');
      assert.equal(deferred.results[0].reason, 'proactive_budget_exhausted');
      const storedAfterDefer = engine.store.getMemo(memo.id);
      assert.equal(storedAfterDefer?.status, 'active');
      assert.equal(storedAfterDefer?.resultSummary, 'deferred:proactive_budget_exhausted');
      assert.equal(storedAfterDefer?.nextCheckAt, '2026-11-23T09:14:12.000Z');

      currentTime = new Date('2026-11-23T09:14:15.000Z');
      const fired = await engine.tick();
      assert.equal(fired.events, 1);
      assert.equal(fired.results[0].action, 'fired');
      assert.equal(engine.store.getMemo(memo.id)?.status, 'fired');
      assert.equal(harness.wechatSent.length, 1);
    } finally {
      harness.close();
    }
  });
});

describe('Mode 2: news_followup (dedupe seen URLs, filter clickbait/stale, fire on genuine update, 3-day expiry)', () => {
  it('filters stale/clickbait/rehash, dedupes seen URLs, and fires on genuine official update', async () => {
    const harness = createMockHarness({ quiet: true, secondsSinceLastMessage: 7200 });
    try {
      let currentTime = new Date('2026-11-20T08:00:00.000Z');
      let searchItems: WebSearchResultItem[] = [
        {
          url: EV_STALE_URL,
          title: '某品牌电动车召回3万辆原因还在查',
          snippet: '截至昨日已召回3万辆，原因调查中',
          publishedAt: '2026-11-19T06:00:00.000Z',
        },
        {
          url: EV_CLICKBAIT_URL,
          title: '震惊！网传某品牌电动车召回盘点汇总',
          snippet: '营销号整理汇总，据说召回3万辆原因还在查',
          publishedAt: '2026-11-20T12:00:00.000Z',
        },
        {
          url: EV_REHASH_URL,
          title: '某品牌电动车召回3万辆，原因仍在调查',
          snippet: '召回3万辆，原因还在查',
          publishedAt: '2026-11-20T13:00:00.000Z',
        },
      ];

      const web: WebSearchClient = {
        async search() {
          return { sources: searchItems };
        },
      };

      const engine = new MemoEngine({
        watcher: harness.watcher,
        web,
        now: () => currentTime,
      });

      const memo = engine.createMemo({
        kind: 'news_followup',
        roomKey: 'wechat:chat-work',
        targetChatId: 'chat-work',
        title: '电动车召回后续',
        basis: '工作群聊过某品牌电动车召回新闻',
        keywords: ['电动车', '召回'],
        knownFacts: ['召回 3 万辆', '原因还在查'],
        knownFactsUpdatedAt: '2026-11-20T00:00:00.000Z',
        intervalHours: 8,
      });

      currentTime = new Date('2026-11-20T16:30:00.000Z');
      const firstRun = await engine.tick();
      assert.equal(firstRun.events, 0);
      assert.equal(firstRun.results[0].action, 'deferred');
      assert.equal(engine.store.getMemo(memo.id)?.status, 'active');
      assert.equal(engine.store.listSeenUrls(memo.id).length, 3);

      searchItems = [
        {
          url: EV_REHASH_URL,
          title: '某品牌电动车召回3万辆，原因仍在调查',
          snippet: '召回3万辆，原因还在查',
          publishedAt: '2026-11-20T13:00:00.000Z',
        },
        {
          url: EV_OFFICIAL_URL,
          title: '官方公告：某品牌电动车召回原因查明，免费更换5万套电池包',
          snippet: '官方最新声明确认电芯隔膜批次缺陷，即日起为车主免费更换电池包并提供代步补偿',
          publishedAt: '2026-11-21T01:00:00.000Z',
        },
      ];

      currentTime = new Date('2026-11-21T01:30:00.000Z');
      const secondRun = await engine.tick();
      assert.equal(secondRun.events, 1);
      assert.equal(secondRun.results[0].action, 'completed');
      assert.equal(
        secondRun.results[0].scoutOutcome?.rejected.some((r) => r.verdict === 'already_seen'),
        true,
      );
      assert.equal(engine.store.getMemo(memo.id)?.status, 'completed');
      assert.equal(harness.ingested.length, 1);
      assert.equal(harness.ingested[0].type, 'memo.news_followup.matched');
      assert.equal(harness.ingested[0].rawRef?.url, EV_OFFICIAL_URL);
    } finally {
      harness.close();
    }
  });

  it('expires news_followup memo after 3 days when no update occurs', async () => {
    const harness = createMockHarness();
    try {
      let currentTime = new Date('2026-11-20T08:00:00.000Z');
      const web: WebSearchClient = {
        async search() {
          return { sources: [] };
        },
      };
      const engine = new MemoEngine({
        watcher: harness.watcher,
        web,
        now: () => currentTime,
      });

      const memo = engine.createMemo({
        kind: 'news_followup',
        roomKey: 'wechat:chat-work',
        targetChatId: 'chat-work',
        title: '热点后续追踪',
        basis: '盯紧 3 天看有没有官方通报',
        keywords: ['热点', '通报'],
      });

      assert.ok(memo.expiresAt);
      const diffHours = (Date.parse(memo.expiresAt) - currentTime.getTime()) / 3_600_000;
      assert.equal(diffHours, 72);

      currentTime = new Date('2026-11-23T08:01:00.000Z');
      const res = await engine.tick();
      assert.equal(res.results[0].action, 'expired');
      assert.equal(engine.store.getMemo(memo.id)?.status, 'expired');
    } finally {
      harness.close();
    }
  });
});

describe('Mode 3: long_watch (Issue #223 official ACP release watch + cross-channel WeChat ping)', () => {
  it('ignores rumors/workarounds and wakes #223 room + pings WeChat on official ACP announcement', async () => {
    const harness = createMockHarness();
    try {
      let currentTime = new Date('2026-11-20T09:00:00.000Z');
      let searchItems: WebSearchResultItem[] = [
        {
          url: GEMINI_RUMOR_URL,
          title: 'Old tweet screenshot rumor: Gemini ACP leaked?',
          snippet: 'Unconfirmed speculation about Gemini ACP support from screenshot',
          publishedAt: '2026-11-24T09:00:00.000Z',
        },
        {
          url: GEMINI_WORKAROUND_URL,
          title: 'Gemini Antigravity 429 fix proxy bypass workaround',
          snippet: 'Unofficial wrapper to bypass 429 error using cookie proxy (ban risk)',
          publishedAt: '2026-11-24T09:10:00.000Z',
        },
        {
          url: GEMINI_REDDIT_URL,
          title: 'Community discussion on Gemini third-party harness release',
          snippet: 'Official support maybe coming soon?',
          publishedAt: '2026-11-24T09:20:00.000Z',
        },
      ];

      const web: WebSearchClient = {
        async search() {
          return { sources: searchItems };
        },
      };

      const engine = new MemoEngine({
        watcher: harness.watcher,
        web,
        now: () => currentTime,
      });

      const memo = engine.createMemo({
        kind: 'long_watch',
        roomKey: 'github:example-owner/dsh-watcher#223',
        targetSessionId: 'sess-issue-223',
        title: 'Issue #223 Gemini 官方 ACP 支持',
        basis: 'Antigravity 订阅授权后 429，社区绕过办法会封号，决定蹲 Gemini 官方正式支持 ACP 或第三方 harness',
        keywords: ['Gemini', 'ACP', 'harness'],
        acceptCriteria: 'Official Google Gemini announcement or docs supporting ACP or third-party harness',
        officialDomains: ['ai.google.dev', 'blog.google', 'github.com/google-gemini'],
        intervalHours: 96,
        notifyWechatChatId: 'owner-dm',
      });

      assert.equal(memo.expiresAt, null);

      currentTime = new Date('2026-11-24T10:00:00.000Z');
      const run1 = await engine.tick();
      assert.equal(run1.events, 0);
      assert.equal(run1.results[0].action, 'deferred');
      assert.equal(engine.store.getMemo(memo.id)?.status, 'active');
      assert.equal(harness.ingested.length, 0);
      assert.equal(harness.sinkCalls.length, 0);

      searchItems = [
        {
          url: GEMINI_OFFICIAL_URL,
          title: 'Gemini API Release Notes: Official ACP and Third-Party Harness Support',
          snippet:
            'Google officially announced native ACP protocol support and third-party harness documentation for Gemini subscriptions.',
          publishedAt: '2026-11-28T11:00:00.000Z',
        },
      ];

      currentTime = new Date('2026-11-28T11:30:00.000Z');
      const immediate = await engine.checkNow(memo.id);

      assert.equal(immediate.action, 'completed');
      assert.equal(immediate.status, 'completed');
      assert.equal(immediate.eventIngested, true);
      assert.equal(immediate.wechatPingSent, true);
      assert.equal(engine.store.getMemo(memo.id)?.status, 'completed');

      assert.equal(harness.ingested.length, 1);
      assert.equal(harness.ingested[0].type, 'memo.long_watch.matched');
      assert.equal(harness.ingested[0].threadKey, 'github:example-owner/dsh-watcher#223');
      assert.equal(harness.ingested[0].rawRef?.url, GEMINI_OFFICIAL_URL);

      assert.equal(harness.sinkCalls.length, 1);
      assert.equal(harness.sinkCalls[0].sinkId, 'wxarc.send');
      assert.equal(harness.sinkCalls[0].input.target.chatId, 'owner-dm');

      const repeatCheck = await engine.checkNow(memo.id);
      assert.equal(repeatCheck.action, 'skipped');
    } finally {
      harness.close();
    }
  });

  it('falls back to WechatTransport.send when wxarc.send sink is unavailable', async () => {
    const harness = createMockHarness();
    harness.setSinkMode('unavailable');
    try {
      const currentTime = new Date('2026-11-28T12:00:00.000Z');
      const web: WebSearchClient = {
        async search() {
          return {
            sources: [
              {
                url: GEMINI_OFFICIAL_URL,
                title: 'Gemini Official ACP Release Announcement',
                snippet: 'Official release notes for Gemini ACP third-party harness support',
                publishedAt: '2026-11-28T11:55:00.000Z',
              },
            ],
          };
        },
      };

      const engine = new MemoEngine({
        watcher: harness.watcher,
        web,
        now: () => currentTime,
      });

      const memo = engine.createMemo({
        kind: 'long_watch',
        roomKey: 'github:example-owner/dsh-watcher#223',
        title: 'Issue #223',
        basis: 'Wait for official ACP support',
        keywords: ['Gemini', 'ACP'],
        knownFactsUpdatedAt: '2026-11-20T00:00:00.000Z',
        officialDomains: ['ai.google.dev'],
        notifyWechatChatId: 'owner-dm',
      });

      const result = await engine.checkNow(memo.id);
      assert.equal(result.action, 'completed');
      assert.equal(result.wechatPingSent, true);
      assert.equal(harness.wechatSent.length, 1);
      assert.equal(harness.wechatSent[0].chatId, 'owner-dm');
    } finally {
      harness.close();
    }
  });
});

describe('Room tools & Cordis apply() integration', () => {
  it('enforces root-session guard, per-room cap, list, and cancel tools', async () => {
    const harness = createMockHarness();
    try {
      const registered = new Map<string, MemoToolDefinition>();
      const engine = new MemoEngine({
        watcher: harness.watcher,
        config: { maxActivePerRoom: 2 },
        now: () => new Date('2026-11-20T10:00:00.000Z'),
      });

      registerMemoTools(
        {
          tools: {
            register(def) {
              registered.set(def.name, def);
              return () => registered.delete(def.name);
            },
          },
        },
        engine,
      );

      assert.deepEqual(
        [...registered.keys()].sort(),
        ['watcher_memo_add', 'watcher_memo_cancel', 'watcher_memo_list'],
      );

      const addTool = registered.get('watcher_memo_add') as MemoToolDefinition;
      const listTool = registered.get('watcher_memo_list') as MemoToolDefinition;
      const cancelTool = registered.get('watcher_memo_cancel') as MemoToolDefinition;

      await assert.rejects(
        () => addTool.execute({ kind: 'long_watch', basis: 'no session' }),
        /root session/i,
      );
      await assert.rejects(
        () =>
          addTool.execute(
            { kind: 'long_watch', basis: 'subagent blocked' },
            { agent: { id: 'sub-1', session: { header: { delegationDepth: 1, origin: 'subagent' } } } },
          ),
        /Subagents/i,
      );

      const rootExec = { agent: { id: 'sess-room-1', session: { header: { delegationDepth: 0 } } } };
      const added1 = (await addTool.execute(
        { kind: 'long_watch', roomKey: 'room-a', title: 'Watch 1', basis: 'Basis 1' },
        rootExec,
      )) as { ok: true; memo: { id: string }; activeInRoom: number };
      assert.equal(added1.activeInRoom, 1);

      await addTool.execute(
        { kind: 'long_watch', roomKey: 'room-a', title: 'Watch 2', basis: 'Basis 2' },
        rootExec,
      );

      await assert.rejects(
        () =>
          addTool.execute(
            { kind: 'long_watch', roomKey: 'room-a', title: 'Watch 3', basis: 'Basis 3' },
            rootExec,
          ),
        MemoRoomCapError,
      );

      const listed = (await listTool.execute(
        { roomKey: 'room-a', status: 'active' },
        rootExec,
      )) as { ok: true; count: number };
      assert.equal(listed.count, 2);

      const cancelled = (await cancelTool.execute(
        { memoId: added1.memo.id, reason: 'no longer needed' },
        rootExec,
      )) as { ok: boolean; memo: { status: string } };
      assert.equal(cancelled.ok, true);
      assert.equal(cancelled.memo.status, 'torn');

      const added3 = (await addTool.execute(
        { kind: 'long_watch', roomKey: 'room-a', title: 'Watch 3', basis: 'Basis 3' },
        rootExec,
      )) as { ok: true; activeInRoom: number };
      assert.equal(added3.activeInRoom, 2);
    } finally {
      harness.close();
    }
  });

  it('wires WatchSource, trigger descriptor, and tools via Cordis apply() and cleans up on dispose', () => {
    const harness = createMockHarness();
    const disposeListeners: Array<() => void> = [];
    const registeredTools: string[] = [];

    try {
      const result = apply(
        {
          hub: harness.hub,
          tools: {
            register(def) {
              registeredTools.push(def.name);
              return () => {
                const idx = registeredTools.indexOf(def.name);
                if (idx >= 0) registeredTools.splice(idx, 1);
              };
            },
          },
          on(event, listener) {
            if (event === 'dispose') disposeListeners.push(listener);
          },
        },
        { tickIntervalMs: 60_000 },
      );

      assert.equal(harness.registeredSources.length, 1);
      assert.equal(harness.registeredSources[0].id, 'memo');
      assert.equal(harness.registeredConnectors.length, 1);
      assert.equal(harness.registeredConnectors[0].id, 'memo');
      assert.equal(harness.registeredConnectors[0].label, '待惦记便签');
      assert.equal(harness.registeredConnectors[0].kind, 'trigger');
      assert.equal(harness.registeredConnectors[0].panelId, 'dsh-hub-panel');
      assert.equal(harness.registeredConnectors[0].panelLabel, 'Hub 总控台');
      assert.equal(harness.registeredConnectors[0].health?.().ok, true);
      assert.equal(registeredTools.length, 3);
      assert.equal(result.engine.asWatchSource().health?.().ok, true);

      for (const fn of disposeListeners) fn();
      assert.equal(harness.registeredSources.length, 0);
      assert.equal(harness.registeredConnectors.length, 0);
      assert.equal(registeredTools.length, 0);
    } finally {
      harness.close();
    }
  });

  it('registers DSH 0.2.2 parameters/output via ctx.inject and sends direct WeChat reminder for explicit time_nudge', async () => {
    const harness = createMockHarness({ ownSpokeSince: true, quiet: false, secondsSinceLastMessage: 10 });
    const registeredDefs: Array<{ name: string; parameters?: Record<string, unknown>; output?: unknown }> = [];
    try {
      const result = apply(
        {
          hub: harness.hub,
          inject(deps, cb) {
            if (deps.includes('tools')) {
              cb({
                get: (name) =>
                  name === 'tools'
                    ? {
                        register(def: { name: string; parameters?: Record<string, unknown>; output?: unknown }) {
                          registeredDefs.push(def);
                          return () => {};
                        },
                      }
                    : undefined,
                effect: () => {},
              });
            }
          },
        },
        { tickIntervalMs: 60_000 },
      );

      assert.equal(registeredDefs.length, 3);
      for (const def of registeredDefs) {
        assert.ok(def.parameters);
        assert.ok(def.output);
      }

      let currentTime = new Date('2027-06-24T01:00:00.000Z');
      const engine = new MemoEngine({
        watcher: harness.watcher,
        now: () => currentTime,
        rng: () => 0.5,
      });

      const memo = engine.createMemo({
        kind: 'time_nudge',
        roomKey: 'wechat:wxid_owner',
        targetChatId: 'wxid_owner',
        notifyWechatChatId: 'wxid_owner',
        title: '服务器 203.0.113.11 到期续费提醒',
        basis: '服务器 203.0.113.11 将于 2027-06-30 到期',
        windowStart: '2027-06-24T01:30:00.000Z',
        windowEnd: '2027-06-24T02:30:00.000Z',
      });

      currentTime = new Date('2027-06-24T02:15:00.000Z');
      const tickRes = await engine.tick();
      assert.equal(tickRes.results.length, 1);
      assert.equal(tickRes.results[0].action, 'fired');
      assert.equal(tickRes.results[0].wechatPingSent, true);
      assert.equal(harness.wechatSent.length, 1);
      assert.equal(harness.wechatSent[0].chatId, 'wxid_owner');
      assert.match(String(harness.wechatSent[0].text), /203\.0\.113\.11/);
      assert.equal(engine.store.getMemo(memo.id)?.status, 'fired');
      result.engine.stop();
    } finally {
      harness.close();
    }
  });

  it('routes time_nudge through transport.triggerMemoNudge to original WeChat session without raw text send', async () => {
    const harness = createMockHarness({ quiet: true, secondsSinceLastMessage: 5400 });
    const nudges: Array<{ memoId: string; chatId: string; targetSessionId?: string | null; title?: string; basis: string }> = [];
    const baseTransport = harness.hub.getWechatTransport()!;
    harness.hub.registerWechatTransport({
      ...baseTransport,
      async triggerMemoNudge(input) {
        nudges.push(input);
        return {
          status: 'queued',
          jobId: 42,
          sessionId: 'sess-wechat-group-1',
          detail: 'Queued for WeChat DSH conversation',
        };
      },
    });

    try {
      let currentTime = new Date('2026-11-25T09:00:00.000Z');
      const engine = new MemoEngine({
        watcher: harness.watcher,
        now: () => currentTime,
      });

      const memo = engine.createMemo({
        kind: 'time_nudge',
        roomKey: 'wechat:demo-family@chatroom',
        targetSessionId: 'sess-wechat-group-1',
        targetChatId: 'demo-family@chatroom',
        notifyWechatChatId: 'demo-family@chatroom',
        title: '提醒小周做八段锦（11/25）',
        basis: '每天傍晚在群里 @ 小周做八段锦',
        windowStart: '2026-11-25T09:00:00.000Z',
        windowEnd: '2026-11-25T09:50:00.000Z',
        randomFireAt: '2026-11-25T09:37:42.000Z',
      });

      currentTime = new Date('2026-11-25T09:38:00.000Z');
      const tickRes = await engine.tick();

      assert.equal(tickRes.results.length, 1);
      assert.equal(tickRes.results[0].action, 'fired');
      assert.equal(tickRes.results[0].reason, 'queued_to_wechat_session');
      assert.equal(nudges.length, 1);
      assert.equal(nudges[0].memoId, memo.id);
      assert.equal(nudges[0].chatId, 'demo-family@chatroom');
      assert.equal(nudges[0].targetSessionId, 'sess-wechat-group-1');
      assert.equal(harness.wechatSent.length, 0);
      assert.equal(harness.ingested.length, 1);
      assert.equal(harness.ingested[0].payload.handledByWechatSession, true);
      assert.equal(harness.ingested[0].payload.handledSessionId, 'sess-wechat-group-1');
      assert.match(String(engine.store.getMemo(memo.id)?.resultSummary), /^fired_wechat_session:/);
    } finally {
      harness.close();
    }
  });
});
