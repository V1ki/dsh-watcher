import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  ActionSink,
  ConnectorDescriptor,
  RoutingRule,
  SinkInvokeInput,
  SinkInvokeResult,
  WatcherService,
  WechatTransport,
} from '@local/dsh-hub/contracts';
import { openWatcherDb } from '@local/dsh-hub';
import {
  GITHUB_TO_WECHAT_RULE_ID,
  WXARC_PROACTIVE_SEND_TOOL,
  WXARC_SEND_SINK_ID,
  WxarcBridgeHttpError,
  WxarcBridgeSecurityError,
  apply,
  createWechatSendSink,
  createWechatTransport,
  createWxarcHostBridge,
  validateBridgeBaseUrl,
  type HostBridgeDeliverContext,
  type HostBridgeSendRequest,
  type WechatBridgePluginContext,
} from '../src/index.js';
import type { WechatToolDefinition } from '../src/send-sink.js';

const HTTP_SCHEME = 'http://';
const PERSONAL_WXARC_URL = 'http://127.0.0.1:8765';
const LAN_BRIDGE_URL = 'http://192.0.2.10:33080';
const BOT_OWN_ID = 'wxid_bot_demo_001';
const PERSONAL_OWN_ID = 'wxid_owner_demo';
const BRIDGE_TOKEN = 'test-shared-secret-token-33080';

function createWxarcSqlite(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      event_id INTEGER NOT NULL,
      payload TEXT NOT NULL,
      received_at TEXT NOT NULL,
      UNIQUE(kind, event_id)
    );
    CREATE TABLE wxarc_chat_state (
      scope TEXT PRIMARY KEY,
      paused INTEGER NOT NULL DEFAULT 0,
      last_reply_at INTEGER NOT NULL DEFAULT 0,
      last_sender TEXT NOT NULL DEFAULT '',
      context_seq INTEGER NOT NULL DEFAULT 0,
      notice TEXT NOT NULL DEFAULT '',
      pending_reply INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

function insertTextEvent(
  db: DatabaseSync,
  eventId: number,
  payload: {
    session: string;
    sender: string;
    senderId?: string;
    text: string;
    ts: number;
    isOwn?: boolean;
  },
): void {
  db.prepare(
    'INSERT INTO events (kind, event_id, payload, received_at) VALUES (?, ?, ?, ?)',
  ).run('text', eventId, JSON.stringify({ kind: 'text', ...payload }), new Date().toISOString());
}

async function startHostBridgeServer(options: {
  db: DatabaseSync;
  token?: string;
  ownId?: string;
  personaId?: string;
  healthy?: boolean;
  deliverParts?: (ctx: HostBridgeDeliverContext) => Promise<void> | void;
  now?: () => number;
}) {
  const bridge = createWxarcHostBridge({
    db: options.db,
    token: options.token ?? BRIDGE_TOKEN,
    ownId: options.ownId ?? BOT_OWN_ID,
    personaId: options.personaId ?? 'default',
    listener: {
      status: () => ({ healthy: options.healthy !== false }),
    },
    deliverParts: options.deliverParts,
    now: options.now,
  });

  const server = http.createServer(bridge.asHttpListener());
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `${HTTP_SCHEME}127.0.0.1:${address.port}`;

  return {
    bridge,
    server,
    baseUrl,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

describe('DualModeWechatTransport & Host-Side Bridge', () => {
  it('auto-selects Cordis in-process service when available and falls back to HTTP Bearer transport', async () => {
    const wxarcDb = createWxarcSqlite();
    const nowMs = Date.now();
    insertTextEvent(wxarcDb, 1, {
      session: 'room-dev@chatroom',
      sender: 'Alice',
      senderId: 'wxid_alice',
      text: 'Hello over HTTP bridge',
      ts: Math.floor((nowMs - 3600_000) / 1000),
    });

    const delivered: HostBridgeDeliverContext[] = [];
    const host = await startHostBridgeServer({
      db: wxarcDb,
      deliverParts: (ctx) => {
        delivered.push(ctx);
      },
      now: () => nowMs,
    });

    try {
      const httpTransport = createWechatTransport({
        config: {
          mode: 'auto',
          remoteBaseUrl: host.baseUrl,
          bridgeTokenCredential: 'wxarc-bridge-token',
          expectedOwnId: BOT_OWN_ID,
        },
        credentials: {
          get: async (key) => (key === 'wxarc-bridge-token' ? { token: BRIDGE_TOKEN } : null),
        },
        now: () => nowMs,
      });

      assert.equal(httpTransport.getActiveMode(), 'http');

      const st = await httpTransport.status();
      assert.equal(st.ok, true);
      assert.equal(st.mode, 'http');
      assert.equal(st.healthy, true);
      assert.equal(st.ownId, BOT_OWN_ID);
      assert.equal(st.endpoint, host.baseUrl);

      const msgs = await httpTransport.recentMessages({ chatId: 'room-dev@chatroom', limit: 10 });
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0].text, 'Hello over HTTP bridge');

      const sendRes = await httpTransport.send({
        chatId: 'room-dev@chatroom',
        text: ['Line 1', 'Line 2'],
        idempotencyKey: 'http-send-001',
        reason: 'round-trip test',
      });
      assert.equal(sendRes.status, 'sent');
      assert.ok(sendRes.deliveryId);
      assert.equal(delivered.length, 1);
      assert.deepEqual(delivered[0].parts, ['Line 1', 'Line 2']);

      const replayRes = await httpTransport.send({
        chatId: 'room-dev@chatroom',
        text: ['Line 1', 'Line 2'],
        idempotencyKey: 'http-send-001',
      });
      assert.equal(replayRes.status, 'sent');
      assert.equal(delivered.length, 1);

      let cordisCalls = 0;
      const cordisTransport = createWechatTransport({
        ctx: {
          get: (serviceName) => {
            if (serviceName === 'wxarcBridge') {
              return {
                status: () => ({ ok: true, healthy: true, ownId: BOT_OWN_ID }),
                recentMessages: async () => {
                  cordisCalls += 1;
                  return host.bridge.recentMessages({ chatId: 'room-dev@chatroom', limit: 5 });
                },
                send: async (input: HostBridgeSendRequest) => {
                  cordisCalls += 1;
                  return host.bridge.send(input);
                },
              };
            }
            return undefined;
          },
        },
        config: {
          mode: 'auto',
          remoteBaseUrl: host.baseUrl,
        },
      });

      assert.equal(cordisTransport.getActiveMode(), 'cordis');
      const cordisStatus = await cordisTransport.status();
      assert.equal(cordisStatus.mode, 'cordis');
      assert.equal(cordisStatus.healthy, true);

      const cordisMsgs = await cordisTransport.recentMessages({ chatId: 'room-dev@chatroom' });
      assert.equal(cordisMsgs.length, 1);
      assert.equal(cordisCalls, 1);
    } finally {
      await host.close();
      wxarcDb.close();
    }
  });

  it('rejects invalid/missing Bearer tokens with 401 and blocks personal wxarc URL and non-loopback hosts', async () => {
    assert.throws(
      () => validateBridgeBaseUrl(PERSONAL_WXARC_URL),
      (err: unknown) =>
        err instanceof WxarcBridgeSecurityError && err.code === 'PERSONAL_WXARC_FORBIDDEN',
    );
    assert.throws(
      () => validateBridgeBaseUrl(PERSONAL_WXARC_URL, { allowLanHost: true }),
      (err: unknown) =>
        err instanceof WxarcBridgeSecurityError && err.code === 'PERSONAL_WXARC_FORBIDDEN',
    );
    assert.throws(
      () => validateBridgeBaseUrl(LAN_BRIDGE_URL),
      (err: unknown) =>
        err instanceof WxarcBridgeSecurityError && err.code === 'NON_LOOPBACK_FORBIDDEN',
    );
    assert.equal(validateBridgeBaseUrl(LAN_BRIDGE_URL, { allowLanHost: true }), LAN_BRIDGE_URL);

    const wxarcDb = createWxarcSqlite();
    const host = await startHostBridgeServer({ db: wxarcDb });

    try {
      const badTokenTransport = createWechatTransport({
        config: {
          mode: 'http',
          remoteBaseUrl: host.baseUrl,
          bridgeToken: 'wrong-token',
        },
      });

      const statusRes = await badTokenTransport.status();
      assert.equal(statusRes.ok, false);
      assert.equal(statusRes.healthy, false);

      await assert.rejects(
        () => badTokenTransport.recentMessages({ chatId: 'filehelper' }),
        (err: unknown) => err instanceof WxarcBridgeHttpError && err.statusCode === 401,
      );

      const sendRes = await badTokenTransport.send({
        chatId: 'filehelper',
        text: 'should fail auth',
        idempotencyKey: 'auth-fail-1',
      });
      assert.equal(sendRes.status, 'failed');
      assert.match(sendRes.detail || '', /401/);

      const rawResp = await fetch(`${host.baseUrl}/wxarc/bridge/status`);
      assert.equal(rawResp.status, 401);
    } finally {
      await host.close();
      wxarcDb.close();
    }
  });

  it('computes getAtmosphere accurately for paused, own-spoke, recently active, and quiet chats', async () => {
    const wxarcDb = createWxarcSqlite();
    const nowMs = 1_750_000_000_000;
    const nowSec = Math.floor(nowMs / 1000);

    insertTextEvent(wxarcDb, 10, {
      session: 'chat-quiet',
      sender: 'Bob',
      senderId: 'wxid_bob',
      text: 'Old message two hours ago',
      ts: nowSec - 7200,
    });

    insertTextEvent(wxarcDb, 11, {
      session: 'chat-active',
      sender: 'Carol',
      senderId: 'wxid_carol',
      text: 'Just talking right now',
      ts: nowSec - 45,
    });

    insertTextEvent(wxarcDb, 12, {
      session: 'chat-own',
      sender: 'Bot',
      senderId: BOT_OWN_ID,
      text: 'I already checked in',
      ts: nowSec - 900,
    });

    insertTextEvent(wxarcDb, 13, {
      session: 'chat-paused',
      sender: 'Dave',
      senderId: 'wxid_dave',
      text: 'Earlier note',
      ts: nowSec - 10_000,
    });
    wxarcDb
      .prepare('INSERT INTO wxarc_chat_state (scope, paused) VALUES (?, 1)')
      .run(JSON.stringify([BOT_OWN_ID, 'default', 'chat-paused']));

    const host = await startHostBridgeServer({
      db: wxarcDb,
      ownId: BOT_OWN_ID,
      personaId: 'default',
      now: () => nowMs,
    });

    try {
      const transport = createWechatTransport({
        config: {
          mode: 'http',
          remoteBaseUrl: host.baseUrl,
          bridgeToken: BRIDGE_TOKEN,
        },
        now: () => nowMs,
      });

      const quietAtm = await transport.getAtmosphere({
        chatId: 'chat-quiet',
        sinceMinutes: 30,
      });
      assert.equal(quietAtm.quiet, true);
      assert.equal(quietAtm.chatPaused, false);
      assert.equal(quietAtm.ownSpokeRecently, false);
      assert.equal(quietAtm.shouldSkipReason, null);
      assert.equal(quietAtm.secondsSinceLastMessage, 7200);
      assert.deepEqual(quietAtm.recentLines, ['Bob: Old message two hours ago']);

      const activeAtm = await transport.getAtmosphere('chat-active', { sinceMinutes: 30 });
      assert.equal(activeAtm.quiet, false);
      assert.equal(activeAtm.shouldSkipReason, 'recent_activity');
      assert.equal(activeAtm.secondsSinceLastMessage, 45);

      const ownAtm = await transport.getAtmosphere({ chatId: 'chat-own', sinceMinutes: 30 });
      assert.equal(ownAtm.quiet, false);
      assert.equal(ownAtm.ownSpokeRecently, true);
      assert.equal(ownAtm.ownSpokeSince, true);
      assert.equal(ownAtm.shouldSkipReason, 'own_spoke_recently');

      const pausedAtm = await transport.getAtmosphere({ chatId: 'chat-paused', sinceMinutes: 30 });
      assert.equal(pausedAtm.quiet, false);
      assert.equal(pausedAtm.paused, true);
      assert.equal(pausedAtm.chatPaused, true);
      assert.equal(pausedAtm.shouldSkipReason, 'chat_paused');
    } finally {
      await host.close();
      wxarcDb.close();
    }
  });
});

describe('wxarc.send Sink, Safety Guards & wxarc_proactive_send Tool', () => {
  it('blocks personal-account ownId mismatch and enforces serial queue without replaying uncertain deliveries', async () => {
    const personalDb = createWxarcSqlite();
    const personalHost = await startHostBridgeServer({
      db: personalDb,
      ownId: PERSONAL_OWN_ID,
    });

    try {
      const personalTransport = createWechatTransport({
        config: {
          mode: 'http',
          remoteBaseUrl: personalHost.baseUrl,
          bridgeToken: BRIDGE_TOKEN,
        },
      });
      const guardedSink = createWechatSendSink({
        transport: personalTransport,
        config: {
          ownId: BOT_OWN_ID,
          blockedOwnIds: [PERSONAL_OWN_ID],
          allowedTargets: ['filehelper'],
          requireApprovalByDefault: false,
        },
      });

      const blocked = await guardedSink.invoke({
        action: 'send',
        target: { chatId: 'filehelper' },
        payload: { text: 'Must never go out on personal account' },
        idempotencyKey: 'personal-block-1',
      });
      assert.equal(blocked.status, 'failed');
      assert.match(blocked.detail || '', /forbidden personal WeChat account/i);
    } finally {
      await personalHost.close();
      personalDb.close();
    }

    const wxarcDb = createWxarcSqlite();
    const watcherDb = openWatcherDb({ inMemory: true });
    let activeWorkers = 0;
    let maxConcurrent = 0;
    const order: string[] = [];
    let failOnceCount = 0;

    const host = await startHostBridgeServer({
      db: wxarcDb,
      ownId: BOT_OWN_ID,
      deliverParts: async (ctx) => {
        activeWorkers += 1;
        maxConcurrent = Math.max(maxConcurrent, activeWorkers);
        order.push(`start:${ctx.parts[0]}`);
        await delay(25);
        if (ctx.parts[0] === 'trigger-crash') {
          failOnceCount += 1;
          activeWorkers -= 1;
          throw new Error('SwiftCUA click timeout after focus');
        }
        order.push(`end:${ctx.parts[0]}`);
        activeWorkers -= 1;
      },
    });

    try {
      const transport = createWechatTransport({
        config: {
          mode: 'http',
          remoteBaseUrl: host.baseUrl,
          bridgeToken: BRIDGE_TOKEN,
          expectedOwnId: BOT_OWN_ID,
        },
      });

      const sink = createWechatSendSink({
        transport,
        config: {
          ownId: BOT_OWN_ID,
          allowedTargets: ['filehelper', 'room-1'],
          requireApprovalByDefault: false,
        },
        db: watcherDb,
      });

      assert.equal(sink.id, WXARC_SEND_SINK_ID);
      assert.equal(sink.kind, 'irreversible-gui');

      const [r1, r2] = await Promise.all([
        sink.invoke({
          action: 'send',
          target: { chatId: 'filehelper' },
          payload: { text: 'first' },
          idempotencyKey: 'serial-1',
        }),
        sink.invoke({
          action: 'send',
          target: { chatId: 'filehelper' },
          payload: { text: 'second' },
          idempotencyKey: 'serial-2',
        }),
      ]);

      assert.equal(r1.status, 'executed');
      assert.equal(r2.status, 'executed');
      assert.equal(maxConcurrent, 1);
      assert.deepEqual(order, ['start:first', 'end:first', 'start:second', 'end:second']);

      const tooMany = await sink.invoke({
        action: 'send',
        target: { chatId: 'filehelper' },
        payload: { text: ['1', '2', '3', '4', '5', '6'] },
        idempotencyKey: 'too-many-segments',
      });
      assert.equal(tooMany.status, 'failed');

      const staged = await sink.invoke({
        action: 'send',
        target: { chatId: 'filehelper' },
        payload: { text: 'Please approve this draft' },
        idempotencyKey: 'stage-only-1',
        stageOnly: true,
      });
      assert.equal(staged.status, 'staged');
      assert.ok(staged.draftId);

      const uncertain1 = await sink.invoke({
        action: 'send',
        target: { chatId: 'filehelper' },
        payload: { text: 'trigger-crash' },
        idempotencyKey: 'crash-key-1',
      });
      assert.equal(uncertain1.status, 'uncertain');
      assert.equal(failOnceCount, 1);

      const uncertainReplay = await sink.invoke({
        action: 'send',
        target: { chatId: 'filehelper' },
        payload: { text: 'trigger-crash' },
        idempotencyKey: 'crash-key-1',
      });
      assert.equal(uncertainReplay.status, 'uncertain');
      assert.equal(failOnceCount, 1);

      wxarcDb
        .prepare(
          `INSERT INTO proactive_deliveries (
             id, idempotency_key, session, parts_json, mode, status, detail, reason,
             clicked_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'send', 'sending', 'in-flight before restart', '', ?, ?, ?)`,
        )
        .run('wxp_crash_row', 'restart-key-1', 'filehelper', '["hello"]', 1000, 1000, 1000);

      const restartedBridge = createWxarcHostBridge({
        db: wxarcDb,
        ownId: BOT_OWN_ID,
      });
      const recovered = await restartedBridge.send({
        chatId: 'filehelper',
        text: 'hello',
        idempotencyKey: 'restart-key-1',
      });
      assert.equal(recovered.status, 'uncertain');
    } finally {
      await host.close();
      watcherDb.close();
      wxarcDb.close();
    }
  });

  it('wires transport, sink, wxarc_proactive_send tool, and GitHub->WeChat rule in apply()', async () => {
    const wxarcDb = createWxarcSqlite();
    const watcherDb = openWatcherDb({ inMemory: true });
    const host = await startHostBridgeServer({ db: wxarcDb, ownId: BOT_OWN_ID });

    let registeredTransport: WechatTransport | null = null;
    const sinks = new Map<string, ActionSink>();
    const rules = new Map<string, RoutingRule>();
    const tools = new Map<string, WechatToolDefinition>();
    const disposeListeners: Array<() => void> = [];

    const mockWatcher = {
      db: watcherDb,
      registerWechatTransport(transport: WechatTransport) {
        registeredTransport = transport;
        return () => {
          registeredTransport = null;
        };
      },
      registerSink(sink: ActionSink) {
        sinks.set(sink.id, sink);
        return () => {
          sinks.delete(sink.id);
        };
      },
      registerRule(rule: RoutingRule) {
        rules.set(rule.id, rule);
        return () => {
          rules.delete(rule.id);
        };
      },
      async invokeSink(sinkId: string, input: SinkInvokeInput): Promise<SinkInvokeResult> {
        const sink = sinks.get(sinkId);
        if (!sink) throw new Error(`Unknown sink: ${sinkId}`);
        return sink.invoke(input);
      },
    } as unknown as WatcherService;

    const ctx: WechatBridgePluginContext = {
      watcher: mockWatcher,
      tools: {
        register(def) {
          tools.set(def.name, def);
          return () => {
            tools.delete(def.name);
          };
        },
      },
      on(event, listener) {
        if (event === 'dispose') disposeListeners.push(listener);
      },
    };

    try {
      const handle = apply(ctx, {
        mode: 'http',
        remoteBaseUrl: host.baseUrl,
        bridgeToken: BRIDGE_TOKEN,
        ownId: BOT_OWN_ID,
        defaultNotifyTarget: 'filehelper',
        allowedTargets: ['filehelper'],
        requireApprovalByDefault: false,
      });

      assert.ok(registeredTransport);
      assert.equal(sinks.has(WXARC_SEND_SINK_ID), true);
      assert.equal(rules.has(GITHUB_TO_WECHAT_RULE_ID), true);
      assert.equal(tools.has(WXARC_PROACTIVE_SEND_TOOL), true);

      const rule = rules.get(GITHUB_TO_WECHAT_RULE_ID)!;
      assert.equal(
        rule.match.predicate?.({
          id: 'ev-223',
          source: 'github',
          type: 'github.issue.comment',
          dedupeKey: 'gh:223',
          threadKey: 'gh:example-owner/dsh#223',
          actor: { id: 'example-owner' },
          trustLevel: 'owner',
          occurredAt: new Date().toISOString(),
          summary: 'Action required on #223',
          payload: { verdict: 'ACTION_REQUIRED' },
        }),
        true,
      );

      const tool = tools.get(WXARC_PROACTIVE_SEND_TOOL)!;
      await assert.rejects(
        () => tool.execute({ text: 'No session' }),
        /root session context/i,
      );
      await assert.rejects(
        () =>
          tool.execute(
            { text: 'Subagent blocked' },
            { agent: { id: 'sub-1', session: { header: { delegationDepth: 1 } } } },
          ),
        /Subagents are not permitted/i,
      );

      const toolRes = await tool.execute(
        {
          chatId: 'filehelper',
          text: ['GitHub Issue #223 needs attention', 'Check PR details in DSH'],
          reason: 'GitHub ACTION_REQUIRED cross-channel alert',
          idempotencyKey: 'gh-223-ping',
        },
        { agent: { id: 'root-session-1', session: { header: { delegationDepth: 0 } } } },
      );
      assert.equal(toolRes.status, 'executed');
      assert.ok(toolRes.receiptId);

      assert.equal(handle.sink.id, WXARC_SEND_SINK_ID);
      for (const listener of disposeListeners) listener();
      assert.equal(registeredTransport, null);
      assert.equal(sinks.size, 0);
      assert.equal(rules.size, 0);
      assert.equal(tools.size, 0);
    } finally {
      await host.close();
      watcherDb.close();
      wxarcDb.close();
    }
  });

  it('wires in-process Cordis transport automatically when mounted with webServer and watcher', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wxarc-unified-'));
    const watcherDb = openWatcherDb({ inMemory: true });
    const disposers: Array<() => unknown> = [];
    let registeredTransport: WechatTransport | null = null;
    const connectors = new Map<string, ConnectorDescriptor>();
    const sinks = new Map<string, ActionSink>();
    const rules = new Map<string, RoutingRule>();
    const tools = new Map<string, unknown>();

    const mockWatcher = {
      db: watcherDb,
      registerConnector(desc: ConnectorDescriptor) {
        connectors.set(desc.id, desc);
        return () => {
          connectors.delete(desc.id);
        };
      },
      registerWechatTransport(transport: WechatTransport) {
        registeredTransport = transport;
        return () => {
          registeredTransport = null;
        };
      },
      registerSink(sink: ActionSink) {
        sinks.set(sink.id, sink);
        return () => {
          sinks.delete(sink.id);
        };
      },
      registerRule(rule: RoutingRule) {
        rules.set(rule.id, rule);
        return () => {
          rules.delete(rule.id);
        };
      },
      async invokeSink(sinkId: string, input: SinkInvokeInput): Promise<SinkInvokeResult> {
        const sink = sinks.get(sinkId);
        if (!sink) throw new Error(`Unknown sink: ${sinkId}`);
        return sink.invoke(input);
      },
    } as unknown as WatcherService;

    const fullCtx: Record<string, any> = {
      on: () => () => {},
      systemPrompt: { section: () => () => {} },
      agents: { get: () => undefined },
      connection: { requestRejection: () => undefined },
      webServer: {
        host: '127.0.0.1',
        port: 3080,
        register: () => () => {},
      },
      effect: (fn: () => () => unknown) => disposers.push(fn()),
      inject: (keys: string[], fn: (child: any) => void) => {
        if (keys.includes('tools')) {
          fn({
            effect: (effectFn: () => () => unknown) => disposers.push(effectFn()),
            tools: {
              register: (tool: { name: string }) => {
                tools.set(tool.name, tool);
                return () => {
                  tools.delete(tool.name);
                };
              },
            },
          });
        }
        if (keys.includes('hub')) {
          fn({
            hub: mockWatcher,
            effect: (effectFn: () => () => unknown) => disposers.push(effectFn()),
            tools: {
              register: (tool: { name: string }) => {
                tools.set(tool.name, tool);
                return () => {
                  tools.delete(tool.name);
                };
              },
            },
          });
        }
      },
      logger: { info() {}, warn() {} },
    };

    try {
      apply(fullCtx, {
        stateDir: dir,
        url: 'http://127.0.0.1:1',
        pollMs: 3000,
        retain: 1000,
        mode: 'auto',
      });

      assert.ok(registeredTransport);
      assert.equal(connectors.get('wxarc')?.label, '微信消息');
      assert.equal(connectors.get('wxarc')?.panelId, 'wxarc-listener');
      assert.equal(connectors.get('wxarc')?.kind, 'connector');
      const st = await (registeredTransport as WechatTransport).status();
      assert.equal(st.mode, 'cordis');
      assert.equal(st.ok, true);
      assert.equal(sinks.has(WXARC_SEND_SINK_ID), true);
      assert.equal(rules.has(GITHUB_TO_WECHAT_RULE_ID), true);
      assert.equal(tools.has(WXARC_PROACTIVE_SEND_TOOL), true);
      assert.equal(tools.has('wxarc_status'), true);
      assert.equal(tools.has('wxarc_messages'), true);
      assert.equal(tools.has('wxarc_sticker_search'), true);
    } finally {
      for (const dispose of disposers.reverse()) {
        await dispose();
      }
      watcherDb.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
