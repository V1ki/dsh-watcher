import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, Listener, endpoint, normalize, messageBody } from '../src/core.js';
import type { Fetcher, ListenerConfig, StreamKind, WxarcEvent } from '../src/core.js';

interface TestRow {
  id: number;
  session: string;
  session_name: string;
  text: string;
  ts: number;
  created_at: number;
  local_type?: number;
  quote?: {
    body?: string;
    sender?: string;
    text?: string;
    type?: number;
    status?: string;
    target_id?: number;
    raw_xml?: string;
  };
  raw_xml?: string;
  path?: string;
  key?: string;
}

interface TestHealth {
  store: string;
  wechat_root: string;
  wechat_running: boolean;
  listener: {
    running: boolean;
    text: {
      status: string;
      last_success: number;
      last_error?: string | null;
      missing_keys: unknown[];
    };
    media: Record<string, unknown>;
  };
}

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'wxarc-test-'));
  const store = new Store(dir);
  const data: Record<StreamKind, TestRow[]> = { text: [], sns: [], media: [] };
  const health: TestHealth = {
    store: '/test',
    wechat_root: '/account-a',
    wechat_running: true,
    listener: {
      running: true,
      text: { status: 'active', last_success: Date.now() / 1000, missing_keys: [] },
      media: {},
    },
  };
  let fail = false;
  const fetcher: Fetcher = async (url) => {
    if (fail) throw new Error('Connection refused');
    const u = new URL(url);
    if (u.pathname === '/ui/bootstrap') {
      return Response.json({
        health,
        cursors: Object.fromEntries(
          Object.entries(data).map(([k, rows]) => [k, rows.at(-1)?.id || 0]),
        ),
      });
    }
    const kind: StreamKind = u.pathname.startsWith('/text')
      ? 'text'
      : u.pathname.startsWith('/sns')
        ? 'sns'
        : 'media';
    return Response.json(
      data[kind].filter((r) => r.id > Number(u.searchParams.get('since_id'))).slice(0, 200),
    );
  };
  const config: ListenerConfig = { url: 'http://127.0.0.1:28765', pollMs: 10, retain: 1000 };
  const listener = new Listener(config, store, fetcher);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    store,
    data,
    health,
    listener,
    config,
    fetcher,
    fail: (v: boolean) => {
      fail = v;
    },
  };
}

const row = (id: number) => ({
  id,
  session: 'test',
  session_name: '示例',
  text: `测试 ${id}`,
  ts: 100,
  created_at: id,
});

test('burst over 200, same timestamps, replay and late old timestamps do not lose messages', async (t) => {
  const f = fixture(t);
  f.data.text = Array.from({ length: 450 }, (_, i) => row(i + 1));
  await f.listener.tick();
  assert.equal(f.store.cursor('text').id, 200);
  await f.listener.tick();
  await f.listener.tick();
  await f.listener.tick();
  assert.equal(f.store.summary().retained, 450);
  f.data.text.push({ ...row(451), ts: 1 });
  await f.listener.tick();
  assert.equal(f.store.cursor('text').id, 451);
});

test('persisted cursor survives reopening and downtime backfill', async (t) => {
  const f = fixture(t);
  f.data.text = [row(1)];
  await f.listener.tick();
  f.store.close();
  const reopened = new Store(f.dir);
  f.store.db = reopened.db;
  f.data.text.push(row(2));
  await new Listener(f.config, f.store, f.fetcher).tick();
  assert.equal(f.store.summary().retained, 2);
  assert.equal(statSync(join(f.dir, 'events.sqlite')).mode & 0o777, 0o600);
});

test('atomic rollback leaves both rows and cursor unchanged on invalid ordering', (t) => {
  const { store } = fixture(t);
  assert.throws(() =>
    store.commit('text', 0, [normalize('text', row(2)), normalize('text', row(1))], 1000),
  );
  assert.equal(store.cursor('text').id, 0);
  assert.equal(store.summary().retained, 0);
});

test('network recovery keeps checkpoint and catches up', async (t) => {
  const f = fixture(t);
  f.data.text = [row(1)];
  await f.listener.tick();
  f.fail(true);
  await assert.rejects(f.listener.tick());
  assert.equal(f.store.cursor('text').id, 1);
  f.fail(false);
  f.data.text.push(row(2));
  await f.listener.tick();
  assert.equal(f.store.summary().retained, 2);
});

test('different account, index rollback and reused IDs are rejected', async (t) => {
  const f = fixture(t);
  f.data.text = [row(1), row(2)];
  await f.listener.tick();
  f.health.wechat_root = '/account-b';
  await assert.rejects(f.listener.tick(), /来源已改变/);
  f.health.wechat_root = '/account-a';
  f.data.text.pop();
  await assert.rejects(f.listener.tick(), /事件库回退/);
  f.data.text.push({ ...row(2), text: 'different source' });
  await assert.rejects(f.listener.tick(), /来源不匹配/);
  assert.equal(f.store.cursor('text').id, 2);
});

test('retention, pagination, literal search and stream namespaces', async (t) => {
  const f = fixture(t);
  f.config.retain = 2;
  f.data.text = [row(1), row(2), row(3)];
  f.data.sns = [row(1)];
  await f.listener.tick();
  assert.equal(f.store.summary().retained, 3);
  assert.equal(f.store.list({ kind: 'text' }).length, 2);
  assert.equal(f.store.list({ query: '测试 3' }).length, 1);
  assert.equal(f.store.list({ query: '%' }).length, 0);
  const first = f.store.list({ limit: 1 });
  assert.equal(f.store.list({ before: first[0].seq }).length, 2);
  await f.listener.tick();
  assert.equal(f.store.summary().retained, 3);
});

test('source collector failure and stale timestamps are not shown as healthy', async (t) => {
  const f = fixture(t);
  await f.listener.tick();
  assert.equal(f.listener.status().healthy, true);
  f.health.listener.text.last_error = 'private detail';
  await f.listener.tick();
  assert.equal(f.listener.status().healthy, false);
  assert.ok(!JSON.stringify(f.listener.status()).includes('private detail'));
  f.health.listener.text.last_error = null;
  f.health.listener.text.last_success = 1;
  await f.listener.tick();
  assert.equal(f.listener.status().healthy, false);
});

test('loopback only; strips raw XML, keys, and local paths', () => {
  for (const u of [
    'https://example.com',
    'http://127.0.0.1@evil.test',
    'http://localhost:28765',
    'http://127.0.0.1/path',
  ]) {
    assert.throws(() => endpoint(u));
  }
  const normalized = normalize('text', {
    ...row(1),
    raw_xml: 'secret',
    path: '/private',
    key: 'secret',
  });
  assert.ok(!JSON.stringify(normalized).includes('secret'));
  assert.ok(!('path' in normalized));
});

test('stop cancels an in-flight fetch and run settles', async (t) => {
  const f = fixture(t);
  const l = new Listener(
    f.config,
    f.store,
    async (_url, { signal }) =>
      new Promise<Response>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      ),
  );
  const running = l.run();
  l.stop();
  await running;
});

test('quoted messages preserve speaker and source text through ingestion without raw metadata', async (t) => {
  const f = fixture(t);
  const incoming: TestRow = {
    ...row(1),
    local_type: 57 * 4294967296 + 49,
    text: '[引用] 你这后半句不用说',
    quote: {
      body: '你这后半句不用说',
      sender: 'knight',
      text: '可不是嘛，我又解释了一大截',
      type: 1,
      status: 'available',
      target_id: 4,
      raw_xml: 'PRIVATE_XML',
    },
  };
  f.data.text = [incoming];
  await f.listener.tick();
  const payloadRow = f.store.db.prepare('SELECT payload FROM events').get() as unknown as {
    payload: string;
  };
  const saved = JSON.parse(payloadRow.payload) as WxarcEvent;
  assert.equal(saved.quote?.sender, 'knight');
  assert.equal(saved.quote?.text, incoming.quote?.text);
  assert.equal(saved.quote?.target_id, 4);
  assert.ok(!JSON.stringify(saved).includes('PRIVATE_XML'));
  assert.equal(messageBody(saved), '你这后半句不用说');
  f.data.text[0].quote!.text = '后续完整引用';
  await f.listener.tick();
  assert.equal(f.store.cursor('text').id, 1);
});

test('late quote enrichment refreshes only the same message and retains readable missing-target snippets', async (t) => {
  const f = fixture(t);
  const event: WxarcEvent = {
    ...row(2),
    kind: 'text',
    local_type: 57 * 4294967296 + 49,
    text: '[引用] 那这句呢',
  };
  let calls = 0;
  f.listener.get = async (path) => {
    calls++;
    assert.equal(path, '/ui/refresh?kind=text&ids=2');
    return [
      {
        ...event,
        quote: { sender: 'A', text: '原消息尚未同步，但有引用摘要', status: 'missing' },
      },
    ];
  };
  const enriched = await f.listener.enrichQuote(event);
  assert.equal(enriched.quote?.status, 'missing');
  assert.match(enriched.quote?.text ?? '', /引用摘要/);
  await f.listener.enrichQuote(enriched);
  assert.equal(calls, 1);
  f.listener.get = async () => [{ ...event, session: 'another-chat', quote: { text: '不应读入' } }];
  await assert.rejects(f.listener.enrichQuote(event), /来源已改变/);
  const plain: WxarcEvent = { ...event, local_type: 1 };
  assert.equal(await f.listener.enrichQuote(plain), plain);
});
