import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { AgentBridge } from '../src/agent.js';
import { decide, parseDecision } from '../src/ai.js';
import { Automation, validatePolicy } from '../src/automation.js';
import { Store } from '../src/core.js';
import { archiveHistory } from '../src/resend.js';
import { openReadOnly, sourceMessage } from '../src/source.js';

const policy = (extra: Record<string, any> = {}) => ({
  enabled: true,
  mode: 'draft',
  provider: 'test',
  model: 'test',
  ownId: 'wxid_me',
  instructions: '用简短中文回应。',
  rules: [{ kind: 'text', sourceId: 'peer', title: 'Peer', search: 'peer123', wechatId: 'peer123' }],
  maxAgeSeconds: 300,
  maxPerHour: 20,
  ...extra,
});

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'wxarc-auto-'));
  const store = new Store(dir);
  const calls: Array<Record<string, any>> = [];
  const deliveries: Array<Record<string, any>> = [];
  const llm: Record<string, any> = {
    async prepareCall(config: Record<string, any>) {
      return {
        config,
        async *stream(request: Record<string, any>) {
          calls.push(request);
          yield {
            type: 'text-delta',
            text: '{"action":"reply","text":"收到，谢谢","reason":"回复新消息"}',
          };
          yield { type: 'finish', reason: { kind: 'stop' } };
        },
      };
    },
  };
  const cua: Record<string, any> = {
    async prepare(job: Record<string, any>) {
      deliveries.push(job);
      return async () => ({ confirmed: true });
    },
  };
  const listener = { status: () => ({ healthy: true }), wechatRoot: '/data/wxid_me_abcd' };
  const resolveSource = (_home: string, event: Record<string, any>) => ({
    ...event,
    sourceKey: `key-${event.id}`,
    senderId: event.sender,
    account: '/data/wxid_me_abcd/db_storage',
  });
  const args = {
    store,
    llm,
    cua,
    listener,
    wxarcHome: dir,
    resolveSource,
    now: () => 1000000,
  };
  const auto = new Automation(args);
  const append = (id: number, extra: Record<string, any> = {}) =>
    store.commit(
      'text',
      store.cursor('text').id,
      [
        {
          id,
          kind: 'text',
          session: 'peer',
          sender: 'peer',
          text: '你好',
          ts: 1000,
          local_type: 1,
          ...extra,
        },
      ],
      1000,
    );
  t.after(async () => {
    await auto.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { auto, append, args, calls, deliveries, store };
}

test('disabled by default; enabling ignores existing history and drafts only new incoming events', async (t) => {
  const f = fixture(t);
  f.append(1);
  await f.auto.collect();
  assert.equal(f.auto.jobs().length, 0);
  f.auto.save(policy(), 0);
  await f.auto.collect();
  assert.equal(f.auto.jobs().length, 0);
  f.append(2);
  await f.auto.collect();
  await f.auto.collect();
  await f.auto.process();
  assert.equal(f.auto.jobs().length, 1);
  assert.equal(f.auto.jobs()[0].status, 'draft');
  assert.equal(f.calls.length, 1);
  assert.equal(f.deliveries.length, 0);
  assert.deepEqual(f.calls[0].tools, []);
});

test('ignores own, stale, unlisted and non-text messages', async (t) => {
  const f = fixture(t);
  f.auto.save(policy(), 0);
  f.append(1, { sender: 'wxid_me' });
  f.append(2, { ts: 1 });
  f.append(3, { session: 'other' });
  f.append(4, { local_type: 43 });
  await f.auto.collect();
  assert.equal(f.auto.jobs().length, 0);
});

test('stable identity failures block AI instead of guessing by display name', async (t) => {
  const f = fixture(t);
  f.auto.save(policy({ ownId: 'someone_else' }), 0);
  f.append(1);
  await f.auto.collect();
  assert.equal(f.auto.jobs()[0].status, 'blocked');
  assert.equal(f.calls.length, 0);
});

test('automatic send happens after durable intent, never repeats an uncertain delivery', async (t) => {
  const f = fixture(t);
  f.auto.save(policy({ mode: 'send' }), 0);
  f.args.cua.prepare = async (job: Record<string, any>) => async () => {
    assert.equal(f.auto.job(job.id).status, 'sending');
    throw new Error('connection lost after click');
  };
  f.append(1);
  await f.auto.collect();
  await f.auto.process();
  assert.equal(f.auto.jobs()[0].status, 'uncertain');
  await f.auto.process();
  assert.equal(f.calls.length, 1);
  await f.auto.close();
  const restarted = new Automation(f.args);
  assert.equal(restarted.jobs()[0].status, 'uncertain');
  await assert.rejects(restarted.sendDraft(1));
  await restarted.close();
});

test('successful reply is confirmed; settings changes invalidate pending drafts', async (t) => {
  const f = fixture(t);
  f.auto.save(policy({ mode: 'send' }), 0);
  f.append(1);
  await f.auto.collect();
  await f.auto.process();
  assert.equal(f.auto.jobs()[0].status, 'sent');
  assert.equal(f.deliveries.length, 1);
  f.auto.save(policy(), 1);
  f.append(2);
  await f.auto.collect();
  await f.auto.process();
  f.auto.save(policy({ enabled: false }), 2);
  assert.equal(f.auto.jobs()[0].status, 'cancelled');
  await assert.rejects(f.auto.sendDraft(f.auto.jobs()[0].id));
});

test('filehelper self test requires explicit prefix and does not consume its own sent reply', async (t) => {
  const f = fixture(t);
  f.auto.save(
    policy({
      mode: 'send',
      rules: [
        {
          kind: 'text',
          sourceId: 'filehelper',
          title: '文件传输助手',
          search: '文件传输助手',
          wechatId: '',
          testPrefix: '[DSH测试]',
        },
      ],
    }),
    0,
  );
  f.append(1, { session: 'filehelper', sender: 'wxid_me', text: '[DSH测试]你好' });
  await f.auto.collect();
  await f.auto.process();
  assert.equal(f.auto.jobs()[0].status, 'sent');
  f.append(2, { session: 'filehelper', sender: 'wxid_me', text: '收到，谢谢' });
  await f.auto.collect();
  assert.equal(f.auto.jobs().length, 1);
});

test('changing policy during model call prevents sending the stale decision', async (t) => {
  const f = fixture(t);
  f.auto.save(policy({ mode: 'send' }), 0);
  f.append(1);
  await f.auto.collect();
  f.args.llm.prepareCall = async (config: Record<string, any>) => ({
    config,
    stream: async function* () {
      f.auto.save(policy({ enabled: false }), 1);
      yield { type: 'text-delta', text: '{"action":"reply","text":"old"}' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });
  await f.auto.process();
  assert.equal(f.deliveries.length, 0);
  assert.equal(f.auto.jobs()[0].status, 'failed');
});

test('decision parser rejects recipient changes and unfinished model streams', async () => {
  assert.throws(() => parseDecision('{"action":"reply","text":"x","recipient":"other"}', 'text'));
  assert.throws(() => parseDecision('{"action":"comment","text":"x"}', 'text'));
  assert.throws(() => validatePolicy(policy({ rules: [] })));
  const llm = {
    prepareCall: async (config: Record<string, any>) => ({
      config,
      stream: async function* () {
        yield { type: 'text-delta', text: '{"action":"reply","text":"x"}' };
        yield { type: 'finish', reason: { kind: 'max-tokens' } };
      },
    }),
  };
  await assert.rejects(
    decide(llm as any, policy() as any, { kind: 'text' } as any, [], new AbortController().signal),
  );
});

test('failed model attempts remain recorded without blocking subsequent messages', async (t) => {
  const f = fixture(t);
  f.auto.save(policy({ maxPerHour: 1 }), 0);
  let attempts = 0;
  f.args.llm.prepareCall = async () => {
    attempts++;
    throw new Error('provider failure');
  };
  f.append(1);
  f.append(2);
  await f.auto.collect();
  await f.auto.process();
  await f.auto.process();
  assert.equal(attempts, 2);
  assert.equal(f.auto.jobs().filter((j) => j.status === 'failed').length, 2);
  assert.equal(
    (f.store.db.prepare('SELECT COUNT(*) n FROM automation_attempts').get() as { n: number }).n,
    2,
  );
});

test('only one automation owner can use a state directory', (t) => {
  const f = fixture(t);
  assert.throws(() => new Automation(f.args), /已有自动处理实例/);
});

test('Moments mode is explicit and validated independently from all-chat scope', () => {
  assert.equal(validatePolicy(policy({ mode: 'send', rules: [], moments: 'send' })).moments, 'send');
  assert.throws(() => validatePolicy(policy({ moments: 'anything' })));
});

test('all-chat scope resolves new private and group routes, while skipping own and system events', async (t) => {
  const f = fixture(t);
  const resolved: string[] = [];
  f.auto.resolveTarget = async (e) => {
    resolved.push(e.session);
    return {
      kind: e.kind,
      sourceId: e.session,
      title: e.session,
      search: e.session,
      wechatId: '',
      uniqueTitle: true,
      route: 'group',
    };
  };
  f.auto.save(policy({ rules: [], allChats: true }), 0);
  f.append(1, { session: 'new-private' });
  f.append(2, { session: 'new-group@chatroom' });
  f.append(3, { sender: 'wxid_me', session: 'new-private' });
  f.append(4, { local_type: 10000 });
  await f.auto.collect();
  assert.deepEqual(resolved, ['new-private', 'new-group@chatroom']);
  assert.equal(f.auto.jobs().length, 2);
});

test('link message subtypes are readable while media-only events do not invent image contents', async (t) => {
  const f = fixture(t);
  f.auto.save(policy(), 0);
  f.append(1, { local_type: 21474836529, text: '[链接]文章标题' });
  f.append(2, { local_type: 3, text: '[图片]' });
  await f.auto.collect();
  await f.auto.process();
  assert.equal(f.calls.length, 1);
  assert.equal(f.auto.jobs().find((j) => j.status === 'draft')!.event.local_type, 21474836529);
  await f.auto.process();
  assert.equal(f.calls.length, 1);
  assert.equal(f.auto.jobs()[0].status, 'failed');
});

test('all-chat contact lookup failure blocks AI and does not fall back to a guessed title', async (t) => {
  const f = fixture(t);
  f.auto.resolveTarget = async () => {
    throw new Error('ambiguous');
  };
  f.auto.save(policy({ rules: [], allChats: true }), 0);
  f.append(1);
  await f.auto.collect();
  await f.auto.process();
  assert.equal(f.auto.jobs()[0].status, 'blocked');
  assert.equal(f.calls.length, 0);
});

test('scope changes during a contact lookup do not enqueue the obsolete route', async (t) => {
  const f = fixture(t);
  f.auto.resolveTarget = async () => {
    f.auto.save(policy({ enabled: false }), 1);
    return { title: 'x' };
  };
  f.auto.save(policy({ rules: [], allChats: true }), 0);
  f.append(1);
  await f.auto.collect();
  assert.equal(f.auto.jobs().length, 0);
});

test('manual processing respects freshness, scope, own sender, and delivery idempotence', async (t) => {
  const f = fixture(t);
  f.auto.save(policy({ mode: 'send' }), 0);
  f.append(1);
  await f.auto.queueEvent(1, 1);
  await f.auto.process();
  await f.auto.queueEvent(1, 1);
  await f.auto.process();
  assert.equal(f.deliveries.length, 1);
  f.append(2, { sender: 'wxid_me' });
  await assert.rejects(f.auto.queueEvent(2, 1), /本人/);
  f.append(3, { session: 'other' });
  await assert.rejects(f.auto.queueEvent(3, 1), /范围/);
  f.auto.save(policy({ enabled: false }), 1);
  await assert.rejects(f.auto.queueEvent(1, 2));
});

test('manual retry is possible only for a pre-send failure, preserving uncertain outcomes', async (t) => {
  const f = fixture(t);
  f.auto.save(policy({ mode: 'send' }), 0);
  f.args.cua.prepare = async () => {
    throw new Error('UI not ready');
  };
  f.append(1);
  await f.auto.collect();
  await f.auto.process();
  assert.equal(f.auto.job(1).status, 'failed');
  await f.auto.queueEvent(1, 1);
  f.args.cua.prepare = async () => async () => ({ confirmed: false });
  await f.auto.process();
  assert.equal(f.auto.job(1).status, 'uncertain');
  await f.auto.queueEvent(1, 1);
  await f.auto.process();
  assert.equal(f.calls.length, 2);
});

test('recipient changes between generation and sending stop delivery', async (t) => {
  const f = fixture(t);
  let lookup = 0;
  f.auto.resolveTarget = async (e) => ({
    kind: 'text',
    sourceId: e.session,
    title: ++lookup === 1 ? 'Old' : 'Renamed',
    wechatId: 'id',
    uniqueTitle: true,
    route: 'contact',
  });
  f.auto.save(policy({ mode: 'send', allChats: true, rules: [] }), 0);
  f.append(1);
  await f.auto.collect();
  await f.auto.process();
  assert.equal(f.deliveries.length, 0);
  assert.equal(f.auto.job(1).status, 'failed');
});

test('Moments draft setting does not publish while chat sending is enabled', async (t) => {
  const f = fixture(t);
  f.auto.resolveTarget = async (e) => ({
    kind: 'sns',
    sourceId: e.user_name,
    title: 'author',
    search: 'author',
    wechatId: '',
    uniqueTitle: true,
  });
  f.args.llm.prepareCall = async (config: Record<string, any>) => ({
    config,
    stream: async function* () {
      yield { type: 'text-delta', text: '{"action":"comment","text":"评论草稿"}' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });
  f.auto.save(policy({ mode: 'send', rules: [], moments: 'draft' }), 0);
  f.store.commit(
    'sns',
    0,
    [{ id: 1, kind: 'sns', user_name: 'author', sender: 'author', text: '动态正文', tid: '1', ts: 1000 }],
    1000,
  );
  await f.auto.collect();
  await f.auto.process();
  assert.equal(f.auto.job(1).status, 'draft');
  assert.equal(f.deliveries.length, 0);
});

test('new-device waiting time drafts Moments; only posts created after the deadline auto-publish', async (t) => {
  const f = fixture(t);
  let clock = 1000000;
  f.auto.now = () => clock;
  f.auto.resolveTarget = async (e) => ({
    kind: 'sns',
    sourceId: e.user_name,
    title: 'author',
    search: 'author',
    wechatId: '',
    uniqueTitle: true,
  });
  f.args.llm.prepareCall = async (config: Record<string, any>) => ({
    config,
    stream: async function* () {
      yield { type: 'text-delta', text: '{"action":"comment","text":"comment"}' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });
  f.auto.save(policy({ mode: 'send', rules: [], moments: 'send', momentsNotBefore: 1001000 }), 0);
  const post = (id: number, ts: number) =>
    f.store.commit(
      'sns',
      f.store.cursor('sns').id,
      [{ id, kind: 'sns', user_name: 'author', sender: 'author', text: 'new post', tid: String(id), ts }],
      1000,
    );
  post(1, 1000);
  await f.auto.collect();
  await f.auto.process();
  assert.equal(f.auto.job(1).status, 'draft');
  assert.equal(f.deliveries.length, 0);
  await assert.rejects(f.auto.sendDraft(1), /生效时间/);
  assert.equal(f.deliveries.length, 0);
  clock = 1002000;
  post(2, 1000);
  await f.auto.collect();
  await f.auto.process();
  assert.equal(f.auto.job(2).status, 'draft');
  assert.equal(f.deliveries.length, 0);
  post(3, 1002);
  await f.auto.collect();
  await f.auto.process();
  assert.equal(f.auto.job(3).status, 'sent');
  assert.equal(f.deliveries.length, 1);
});

test('manual retries remain counted without an hourly limit', async (t) => {
  const f = fixture(t);
  f.auto.save(policy({ mode: 'send', maxPerHour: 2 }), 0);
  f.args.cua.prepare = async () => {
    throw new Error('not ready');
  };
  f.append(1);
  await f.auto.queueEvent(1, 1);
  await f.auto.process();
  await f.auto.queueEvent(1, 1);
  await f.auto.process();
  await f.auto.queueEvent(1, 1);
  await f.auto.process();
  assert.equal(f.calls.length, 3);
  assert.equal(f.auto.job(1).status, 'failed');
});

test('article enrichment feeds full body to native AI and persists reading evidence', async (t) => {
  const f = fixture(t);
  f.auto.enrich = async (e) => ({
    ...e,
    article: {
      status: 'read',
      title: '文章',
      text: '正文关键事实',
      chars: 6,
      url: 'https://mp.weixin.qq.com/s/example',
    },
  });
  f.auto.save(policy({ mode: 'send' }), 0);
  f.append(1, { local_type: 21474836529, text: '[链接]文章' });
  await f.auto.collect();
  await f.auto.process();
  const content = JSON.parse(f.calls[0].messages[0].content[0].text) as {
    article: { text: string };
  };
  assert.equal(content.article.text, '正文关键事实');
  assert.equal(f.auto.job(1).event.article.chars, 6);
  assert.equal(f.deliveries.length, 1);
});

test('article read failure blocks without consuming model budget or sending a title-only response', async (t) => {
  const f = fixture(t);
  f.auto.enrich = async () => {
    throw new Error('微信文章需要验证');
  };
  f.auto.save(policy({ mode: 'send' }), 0);
  f.append(1, { local_type: 21474836529, text: '[链接]文章' });
  await f.auto.collect();
  await f.auto.process();
  assert.equal(f.auto.job(1).status, 'blocked');
  assert.match(f.auto.job(1).detail, /需要验证/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.deliveries.length, 0);
  assert.equal(
    (f.store.db.prepare('SELECT COUNT(*) n FROM automation_attempts').get() as { n: number }).n,
    0,
  );
});

test('explicit old article preview never reopens an already sent job or sends again', async (t) => {
  const f = fixture(t);
  f.auto.enrich = async (e) => ({
    ...e,
    article: { status: 'read', title: '文章', text: '正文关键事实', chars: 6 },
  });
  f.auto.save(policy({ mode: 'send' }), 0);
  f.append(1, { local_type: 21474836529, text: '[链接]文章' });
  await f.auto.collect();
  await f.auto.process();
  f.auto.now = () => 2000000;
  const preview = await f.auto.previewArticle(1, 1);
  assert.equal(preview.sent, false);
  assert.equal(f.auto.job(1).status, 'sent');
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.calls.length, 2);
});

test('persona switches cancel pending drafts and prevent a prior persona generation from sending', async (t) => {
  const f = fixture(t);
  f.auto.personas = {
    get: (id: string) => ({ id, name: id, revision: 1 }),
    ready: () => ({}),
    context: (id: string) => ({ id, name: id, definition: '角色', memory: [], learning: false }),
    remember: () => {},
  };
  f.auto.save(policy({ mode: 'send', personaId: 'first' }), 0);
  f.append(1);
  await f.auto.collect();
  f.args.llm.prepareCall = async (config: Record<string, any>) => ({
    config,
    stream: async function* () {
      f.auto.save(policy({ mode: 'send', personaId: 'second' }), 1);
      yield { type: 'text-delta', text: '{"action":"reply","text":"旧人设"}' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });
  await f.auto.process();
  assert.equal(f.deliveries.length, 0);
  assert.equal(f.auto.job(1).status, 'failed');
  assert.equal(f.auto.settings().policy.personaId, 'second');
});

test('explicit selection of one older image does not replay surrounding history', async (t) => {
  const f = fixture(t);
  f.auto.save(policy(), 0);
  f.append(1, { local_type: 3, text: '[图片]', ts: 10 });
  f.append(2, { ts: 10 });
  await f.auto.collect();
  assert.equal(f.auto.jobs().length, 0);
  await assert.rejects(f.auto.queueEvent(1, 1), /时效/);
  const j = await f.auto.queueEvent(1, 1, true);
  assert.equal(j.event.manualRequestedAt, 1000000);
  assert.equal(f.auto.jobs().length, 1);
  assert.equal(f.auto.jobs()[0].event.local_type, 3);
});

test('debounce defaults to ten seconds or ten messages and retires the fixed-window setting', () => {
  const p = validatePolicy(policy());
  assert.equal(p.debounceMs, 10000);
  assert.equal(p.debounceMaxMessages, 10);
  assert.ok(!('debounceMaxMs' in validatePolicy(policy({ debounceMaxMs: 10000 }))));
  for (const value of [0, 25, 1.5]) {
    assert.throws(() => validatePolicy(policy({ debounceMaxMessages: value })));
  }
});

test('legacy hourly cap is ignored without changing cursor, revision or queued work', async (t) => {
  const f = fixture(t);
  f.auto.save(policy(), 0);
  f.append(1);
  await f.auto.collect();
  const before = f.auto.settings();
  const jobs = f.auto.jobs();
  f.store.db
    .prepare('UPDATE automation_config SET policy=? WHERE id=1')
    .run(JSON.stringify({ ...before.policy, maxPerHour: 1 }));
  assert.deepEqual(f.auto.settings(), before);
  assert.deepEqual(f.auto.jobs(), jobs);
  assert.equal('maxPerHour' in validatePolicy(policy({ maxPerHour: 60 })), false);
});

test('direct-reply fallback reason is saved with the confirmed delivery', async (t) => {
  const f = fixture(t);
  f.auto.save(policy({ mode: 'send' }), 0);
  const detail = '当前会话未显示触发原消息，已取消引用并直接回复';
  f.args.cua.prepare = async () =>
    Object.assign(async () => ({ confirmed: true, detail }), { deliveryDetail: detail });
  f.append(1);
  await f.auto.collect();
  await f.auto.process();
  assert.equal(f.auto.job(1).status, 'sent');
  assert.ok(f.auto.job(1).detail.includes(detail));
});

test('restart preserves confirmed prefixes and uncertain per-bubble sends', async (t) => {
  const f = fixture(t);
  f.auto.save(policy({ mode: 'send' }), 0);
  f.append(1);
  f.append(2);
  await f.auto.collect();
  f.auto.state(1, 'preparing', '', { action: 'reply', text: ['已发送', '未发送'] });
  f.auto.state(2, 'preparing', '', { action: 'reply', text: ['未知'] });
  f.store.db
    .prepare(
      "INSERT INTO automation_deliveries(job_id,part_index,text,status,detail,updated_at) VALUES (1,0,'已发送','sent','',?)",
    )
    .run(1);
  f.store.db
    .prepare(
      "INSERT INTO automation_deliveries(job_id,part_index,text,status,detail,updated_at) VALUES (2,0,'未知','sending','',?)",
    )
    .run(1);
  await f.auto.close();
  const restarted = new Automation(f.args);
  assert.equal(restarted.job(1).status, 'partial');
  assert.equal(restarted.job(2).status, 'uncertain');
  assert.equal(restarted.deliveryParts(2)[0].status, 'uncertain');
  await assert.rejects(restarted.sendDraft(1));
  await assert.rejects(restarted.sendDraft(2));
  await restarted.close();
});

test('read-only wxarc index and search connections configure busy_timeout=5000', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wxarc-ro-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = '/data/wxid_me_abcd';
  const account = join(root, 'db_storage');
  const idx = new DatabaseSync(join(dir, 'index.db'));
  const srch = new DatabaseSync(join(dir, 'search.db'));
  idx.exec(
    'PRAGMA journal_mode=WAL; CREATE TABLE live_event_sources(event_id INTEGER PRIMARY KEY, search_msg_id INTEGER, shard TEXT, table_name TEXT, local_id INTEGER, fingerprint TEXT, source_key TEXT)',
  );
  srch.exec(
    'PRAGMA journal_mode=WAL; CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); CREATE TABLE msgs(id INTEGER PRIMARY KEY, session TEXT, sender TEXT, ts INTEGER, local_type INTEGER, text TEXT)',
  );
  const fp = createHash('sha256')
    .update(JSON.stringify(['peer', 'peer', 1000, 1, '你好']))
    .digest('hex');
  const key = createHash('sha256')
    .update(JSON.stringify([account, 'message/message_0.db', 'Msg_peer', 7, fp]))
    .digest('hex');
  idx
    .prepare('INSERT INTO live_event_sources VALUES (1,10,?,?,?,?,?)')
    .run('message/message_0.db', 'Msg_peer', 7, fp, key);
  srch.prepare('INSERT INTO meta VALUES (?,?)').run('source_identity', JSON.stringify({ account }));
  srch.prepare('INSERT INTO meta VALUES (?,?)').run('index_generation', 'gen-1');
  srch.prepare('INSERT INTO msgs VALUES (10,?,?,?,?,?)').run('peer', 'peer', 1000, 1, '你好');
  srch.prepare('INSERT INTO msgs VALUES (11,?,?,?,?,?)').run('peer', 'wxid_me', 1001, 1, '收到');
  idx.close();
  srch.close();

  const ro = openReadOnly(join(dir, 'index.db'));
  try {
    assert.equal((ro.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout, 5000);
  } finally {
    ro.close();
  }

  const event = { id: 1, kind: 'text', session: 'peer', text: '你好', ts: 1000, local_type: 1 };
  const src = sourceMessage(dir, event as any);
  assert.equal(src.sourceKey, key);
  const rows = archiveHistory(dir, src as any, 'wxid_me', root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, '收到');
});

function nativeDebounced(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'wxarc-busy-'));
  const store = new Store(dir);
  let clock = Date.now();
  const hooks: Record<string, (...args: any[]) => any> = {};
  const agents = new Map<string, any>();
  const prompts: Array<Record<string, any>> = [];
  const sent: Array<Record<string, any>> = [];
  const listener = { status: () => ({ healthy: true }), wechatRoot: '/data/wxid_me_abcd' };
  const auto = new Automation({
    store,
    listener,
    wxarcHome: dir,
    now: () => clock,
    cua: {
      prepare: async (j: Record<string, any>) => async () => {
        sent.push(j);
        return { confirmed: true };
      },
    },
    resolveSource: (_h, e) => ({
      ...e,
      sourceKey: `key-${e.id}`,
      senderId: e.sender,
      account: '/data/wxid_me_abcd/db_storage',
    }),
    resolveTarget: async (e) => ({ title: e.session, sourceId: e.session, kind: 'text' }),
    identify: async (e) => ({
      ...e,
      senderIdentity: { id: e.senderId, nickname: e.senderId, groupNickname: '群内' + e.senderId },
      botNames: ['小助手'],
    }),
  });
  const emit = (id: string, type: string, data: Record<string, any>) =>
    hooks['session/event']({ id }, { type, data });
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
    llm: { resolveCallConfig: async () => ({}) },
    workspaceController: {
      create: async () => ({ created: false, workspace: { workspaceId: 'ws' } }),
    },
    workspaceRegistry: { get: () => ({ attachSession: async () => {} }) },
    sessionController: {
      resolveAgent: async (id: string) =>
        agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found' } },
      create: async ({ sessionId, cwd }: { sessionId: string; cwd: string }) => {
        const a: any = {
          id: sessionId,
          cwd,
          session: { header: {} },
          inbox: { clear() {} },
          model: { select() {} },
          whenIdle: async () => {},
          cancel() {
            a.cancelled = true;
          },
          busy: false,
        };
        agents.set(sessionId, a);
        hooks['agent/created']({ agent: a });
        return { sessionId };
      },
      rename: async () => {},
      state: async ({ sessionId }: { sessionId: string }) => ({
        running: agents.get(sessionId)?.busy || false,
        queue: [],
        pendingInput: [],
      }),
      prompt: async (r: Record<string, any>) => {
        prompts.push(r);
        agents.get(r.sessionId).busy = true;
        emit(r.sessionId, 'user/message', { source: { kind: 'user', rpcId: r.requestId } });
        emit(r.sessionId, 'turn/start', { turn: prompts.length });
      },
    },
  };
  const bridge = new AgentBridge(ctx, store, {
    root: join(dir, 'work'),
    personas: { context: () => ({ name: '测试角色' }) },
    settings: () => auto.settings(),
  });
  auto.agentBridge = bridge;
  auto.save(
    {
      ...auto.settings().policy,
      enabled: true,
      allChats: true,
      mode: 'send',
      provider: 'test',
      model: 'test',
      ownId: 'wxid_me',
      instructions: '自然回复',
      debounceMs: 10000,
      debounceMaxMessages: 10,
    },
    0,
  );
  const push = (id: number, sender: string, text: string, session: string) =>
    store.commit(
      'text',
      store.cursor('text').id,
      [{ id, kind: 'text', session, sender, text, local_type: 1, ts: Math.floor(clock / 1000) }],
      1000,
    );
  const done = (run: { id: string }, text = '{"action":"reply","text":"好的收到"}') => {
    const r = bridge.run(run.id)!;
    emit(r.session_id, 'assistant/message', {
      turn: r.turn,
      message: { content: [{ type: 'text', text }] },
    });
    emit(r.session_id, 'turn/end', { turn: r.turn, reason: { kind: 'completed' } });
    agents.get(r.session_id).busy = false;
  };
  const advance = (ms: number) => {
    clock += ms;
  };
  t.after(async () => {
    await auto.close();
    await bridge.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { auto, bridge, agents, prompts, sent, push, done, advance };
}

test('processNative does not freeze batches while target session has an active run so later messages still coalesce', async (t) => {
  const f = nativeDebounced(t);
  f.push(1, 'a', '帮我查一下', 'roomA@chatroom');
  await f.auto.collect();
  f.advance(10000);
  await f.auto.process();
  assert.equal(f.prompts.length, 1);
  const first = f.auto.jobs().find((j) => j.event.id === 1)!;
  assert.equal(first.status, 'agent_running');

  f.push(2, 'a', '补充一', 'roomA@chatroom');
  f.push(3, 'a', '补充二', 'roomA@chatroom');
  await f.auto.collect();
  f.advance(15000);
  await f.auto.process();
  assert.equal(f.prompts.length, 1);
  const j2 = f.auto.jobs().find((j) => j.event.id === 2)!;
  const j3 = f.auto.jobs().find((j) => j.event.id === 3)!;
  assert.equal(j2.status, 'queued');
  assert.equal(j3.status, 'queued');
  assert.equal(j2.event.batch, undefined);
  assert.equal(j3.event.batch, undefined);

  f.push(4, 'a', '补充三', 'roomA@chatroom');
  await f.auto.collect();
  f.done(f.bridge.run(first.event.dshRunId)!);
  await f.auto.process();
  assert.equal(f.auto.job(first.id).status, 'superseded');

  f.advance(10000);
  await f.auto.process();
  assert.equal(f.prompts.length, 2);
  const parent = f.auto.jobs().find((j) => j.status === 'agent_running')!;
  assert.equal(parent.event.id, 4);
  assert.deepEqual(
    parent.event.batch.messages.map((m: { id: number }) => m.id),
    [2, 3, 4],
  );

  f.done(f.bridge.run(parent.event.dshRunId)!);
  await f.auto.process();
  assert.equal(f.auto.job(parent.id).status, 'sent');
  f.agents.get(parent.event.dshSessionId).busy = true;
  f.push(5, 'a', '主人忙碌时消息一', 'roomA@chatroom');
  f.push(6, 'a', '主人忙碌时消息二', 'roomA@chatroom');
  await f.auto.collect();
  f.advance(15000);
  await f.auto.process();
  assert.equal(f.prompts.length, 2);
  assert.equal(f.auto.jobs().find((j) => j.event.id === 5)!.status, 'queued');
  assert.equal(f.auto.jobs().find((j) => j.event.id === 6)!.event.batch, undefined);
  f.push(7, 'a', '主人忙碌时消息三', 'roomA@chatroom');
  await f.auto.collect();
  f.agents.get(parent.event.dshSessionId).busy = false;
  f.advance(10000);
  await f.auto.process();
  assert.equal(f.prompts.length, 3);
  const next = f.auto.jobs().find((j) => j.status === 'agent_running')!;
  assert.deepEqual(
    next.event.batch.messages.map((m: { id: number }) => m.id),
    [5, 6, 7],
  );
});

test('processNative does not freeze batches when global open runs >= 3 so waiting chats coalesce once a slot opens', async (t) => {
  const f = nativeDebounced(t);
  f.push(1, 'a', '问题1', 'room1@chatroom');
  f.push(2, 'b', '问题2', 'room2@chatroom');
  f.push(3, 'c', '问题3', 'room3@chatroom');
  await f.auto.collect();
  f.advance(10000);
  await f.auto.process();
  await f.auto.process();
  await f.auto.process();
  assert.equal(f.prompts.length, 3);

  f.push(4, 'd', '第四个群消息一', 'room4@chatroom');
  f.push(5, 'd', '第四个群消息二', 'room4@chatroom');
  await f.auto.collect();
  f.advance(15000);
  await f.auto.process();
  assert.equal(f.prompts.length, 3);
  const j4 = f.auto.jobs().find((j) => j.event.id === 4)!;
  const j5 = f.auto.jobs().find((j) => j.event.id === 5)!;
  assert.equal(j4.status, 'queued');
  assert.equal(j5.status, 'queued');
  assert.equal(j4.event.batch, undefined);
  assert.equal(j5.event.batch, undefined);

  f.push(6, 'd', '第四个群消息三', 'room4@chatroom');
  await f.auto.collect();
  const r1 = f.auto.jobs().find((j) => j.event.session === 'room1@chatroom')!;
  f.done(f.bridge.run(r1.event.dshRunId)!);
  await f.auto.process();
  assert.equal(f.auto.job(r1.id).status, 'sent');

  f.advance(10000);
  await f.auto.process();
  assert.equal(f.prompts.length, 4);
  const started = f.auto
    .jobs()
    .find((j) => j.event.session === 'room4@chatroom' && j.status === 'agent_running')!;
  assert.equal(started.event.id, 6);
  assert.deepEqual(
    started.event.batch.messages.map((m: { id: number }) => m.id),
    [4, 5, 6],
  );
});

test('deliverOne resolves multi-member mentions, skips duplicate/missing members, and retries without failed picker target', async (t) => {
  const f = fixture(t);
  f.auto.save(policy({ mode: 'send', allChats: true, rules: [] }), 0);
  const groupMembers = [
    { id: 'wxid_sender', nickname: '甲', groupNickname: '', uiName: '甲', uniqueUiName: true },
    { id: 'wxid_orange', nickname: '橘子水果', groupNickname: '', uiName: '橘子水果', uniqueUiName: true },
    { id: 'wxid_dup', nickname: '重名', groupNickname: '', uiName: '重名', uniqueUiName: false },
  ];
  f.auto.resolveTarget = async () => ({
    kind: 'text',
    sourceId: 'room@chatroom',
    title: '测试群',
    search: '测试群',
    wechatId: '',
    route: 'group',
    uniqueTitle: true,
  });
  f.auto.resolveSource = (_home: string, ev: any) => ({
    ...ev,
    account: '/data/wxid_me_abcd/db_storage',
    senderId: ev.senderId || 'wxid_sender',
    sourceKey: ev.sourceKey || 'k1',
  });
  f.auto.identify = async (ev: any) => ({
    ...ev,
    senderIdentity: {
      id: 'wxid_sender',
      nickname: '甲',
      groupNickname: '',
      uiName: '甲',
      uniqueUiName: true,
    },
    groupMembers,
    mentions: {
      status: 'verified',
      sourceKey: ev.sourceKey || 'k1',
      recipients: ['wxid_me'],
      toSelf: true,
    },
  });
  const seenPrepared: Array<string[]> = [];
  f.args.cua.prepare = async (job: any) => {
    const ids = (job.mentions || []).map((m: { id: string }) => m.id);
    seenPrepared.push(ids);
    if (ids.includes('wxid_orange')) {
      throw Object.assign(
        new Error('无法唯一核对微信 @ 成员菜单（OCR=空）；已清理本次未发送的 @ 查询和引用'),
        { mentionId: 'wxid_orange' },
      );
    }
    return Object.assign(async () => ({ confirmed: true }), { deliveryDetail: job.deliveryDetail });
  };
  f.store.commit(
    'text',
    0,
    [
      {
        id: 1,
        kind: 'text',
        session: 'room@chatroom',
        session_name: '测试群',
        sender: '甲',
        text: '@bot 你 @ 一下我和橘子',
        ts: 1000,
        local_type: 1,
      },
    ],
    100,
  );
  await f.auto.collect();
  f.auto.state(1, 'draft', '', {
    action: 'reply',
    text: '都叫上了',
    replyTo: 'message:1',
    mentions: ['wxid_orange', 'wxid_dup', 'wxid_missing'],
  });
  const stored = f.auto.job(1);
  f.store.db
    .prepare('UPDATE automation_jobs SET event=? WHERE id=1')
    .run(
      JSON.stringify({
        ...stored.event,
        senderId: 'wxid_sender',
        sourceKey: 'k1',
        mentions: { status: 'verified', sourceKey: 'k1', recipients: ['wxid_me'], toSelf: true },
        groupMembers,
      }),
    );
  await f.auto.deliver(f.auto.job(1), AbortSignal.timeout(5000));
  assert.deepEqual(seenPrepared, [['wxid_sender', 'wxid_orange'], ['wxid_sender']]);
  const done = f.auto.job(1);
  assert.equal(done.status, 'sent');
  assert.ok(done.detail.includes('存在重名'));
  assert.ok(done.detail.includes('不在当前群列表中'));
  assert.ok(done.detail.includes('已跳过成员「橘子水果」的原生 @'));
  assert.deepEqual(
    done.event.deliveryMentions.map((m: { id: string }) => m.id),
    ['wxid_sender'],
  );
});
