import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/core.js';
import type { WxarcEvent } from '../src/core.js';
import { Personas, validatePersona } from '../src/personas.js';
import type { FoundationBundle, FoundationSource } from '../src/personas.js';
import { decide, decisionPrompt, parseDecision, parseReply } from '../src/ai.js';
import type { LlmClient, LlmStreamRequest } from '../src/ai.js';

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'wxarc-personas-'));
  const store = new Store(dir);
  const calls: LlmStreamRequest[] = [];
  const llm: LlmClient = {
    prepareCall: async (config) => ({
      config,
      stream: async function* (request) {
        calls.push(request);
        yield {
          type: 'text-delta',
          text: '{"style":"常用短句，直接提出问题；语气依对象有所变化。"}',
        };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    }),
  };
  const personas = new Personas(store, llm);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, personas, llm, calls };
}

test('three persona categories persist independent edits and require a named fictional character', (t) => {
  const f = setup(t);
  assert.equal(f.personas.list().length, 3);
  assert.equal(f.personas.ready('fiction').character, '孙悟空');
  const blank = f.personas.get('fiction');
  f.personas.save({ ...blank, character: '' }, blank.revision);
  assert.throws(() => f.personas.ready('fiction'), /作品/);
  const p = f.personas.get('original');
  f.personas.save({ ...p, name: '小雨' }, p.revision);
  assert.equal(new Personas(f.store, f.llm).get('original').name, '小雨');
  assert.equal(f.personas.get('double').name, '我的分身');
  assert.throws(() => f.personas.save(p, p.revision), /已更新/);
  const extra = f.personas.create('original');
  assert.notEqual(extra.id, p.id);
  assert.throws(() => validatePersona({ ...extra, learning: 'true' }));
});

test('learning requires exact incoming evidence, is isolated by persona/chat, bounded and clearable', (t) => {
  const f = setup(t);
  const event: Partial<WxarcEvent> & { kind: 'text' } = {
    kind: 'text',
    seq: 1,
    session: 'a',
    sender: 'Alice',
    text: '叫我小张就好，回复短一点',
  };
  f.personas.remember('original', event, {
    memory: [
      { note: '希望简短', quote: '回复短一点' },
      { note: '虚构偏好', quote: '根本没说过' },
    ],
  });
  assert.equal(f.personas.context('original', event)!.memory.length, 1);
  assert.equal(f.personas.context('original', { ...event, session: 'b' })!.memory.length, 0);
  assert.equal(f.personas.context('double', event)!.memory.length, 0);
  assert.match(f.personas.memories('original')[0].note, /Alice/);
  for (let i = 2; i < 40; i++) {
    f.personas.remember('original', { ...event, seq: i }, {
      memory: [{ note: '短一点', quote: '回复短一点' }],
    });
  }
  assert.equal(f.personas.memories('original').length, 24);
  const p = f.personas.get('original');
  f.personas.save({ ...p, learning: false }, p.revision);
  f.personas.remember('original', { ...event, seq: 99 }, {
    memory: [{ note: '暂停后不能新增', quote: '回复短一点' }],
  });
  assert.ok(!f.personas.memories('original').some((x) => x.event_seq === 99));
  f.personas.clear('original');
  assert.equal(f.personas.memories('original').length, 0);
});

test('style extraction uses imported own samples, preserves provenance and rejects a stale write', async (t) => {
  const f = setup(t);
  writeFileSync(
    join(f.store.dir, 'owner-style-sample.json'),
    JSON.stringify({
      source: 'test own messages',
      createdAt: '2026-11-14',
      samples: Array.from({ length: 20 }, () => ({ text: '这个具体怎么用？', scene: '私聊' })),
    }),
  );
  const p = await f.personas.learnStyle(
    'double',
    1,
    { provider: 'test', model: 'test' },
    new AbortController().signal,
  );
  assert.equal(p.styleMeta.count, 20);
  assert.match(p.style, /短句/);
  assert.match(f.calls[0].system, /不提炼行为权限/);
  assert.deepEqual(f.calls[0].tools, []);
  await assert.rejects(
    f.personas.learnStyle('double', 1, {}, new AbortController().signal),
    /已更新/,
  );
});

test('memory field only accepted for enabled learning and never accepts model-selected recipient', () => {
  const output =
    '{"action":"reply","text":"好呀","memory":[{"note":"偏好短回复","quote":"回复短一点"}]}';
  assert.throws(() => parseDecision(output, 'text'));
  assert.equal(parseDecision(output, 'text', true).memory?.length, 1);
  assert.throws(() =>
    parseDecision('{"action":"reply","text":"x","recipient":"evil"}', 'text', true),
  );
});

test('role identity and observations are supplied separately; learning prompt includes explicit evidence bounds', async (t) => {
  const f = setup(t);
  let captured: LlmStreamRequest | undefined;
  const llm: LlmClient = {
    prepareCall: async (config) => ({
      config,
      stream: async function* (r) {
        captured = r;
        yield { type: 'text-delta', text: '{"action":"reply","text":"这个点挺有意思的","memory":[]}' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    }),
  };
  const event: Partial<WxarcEvent> & { kind: 'text' } = {
    kind: 'text',
    text: '分享一篇文章',
    session: 'a@chatroom',
  };
  await decide(
    llm,
    { provider: 'test', model: 'test', instructions: '自然聊天' },
    event,
    [],
    new AbortController().signal,
    f.personas.context('original', event),
  );
  assert.match(captured!.system, /小岚/);
  assert.match(captured!.system, /逐字引用/);
  assert.match(captured!.system, /不要默认写文章摘要/);
  assert.equal(
    (JSON.parse(captured!.messages[0].content[0].text) as { chatType: string }).chatType,
    '群聊',
  );
});

test('editing learned notes is scoped to their owner persona', (t) => {
  const f = setup(t);
  const e: Partial<WxarcEvent> & { kind: 'text' } = {
    kind: 'text',
    seq: 1,
    session: 'a',
    sender: 'A',
    text: '回复短一点',
  };
  f.personas.remember('original', e, { memory: [{ note: '短回复', quote: e.text! }] });
  const m = f.personas.memories('original')[0];
  assert.throws(() => f.personas.editMemory('double', m.id, '更短'), /不存在/);
  f.personas.editMemory('original', m.id, '偏好简洁，必要时可展开');
  assert.equal(f.personas.memories('original')[0].note, '偏好简洁，必要时可展开');
});

test('short plain dialogue is preserved, while malformed protocol and reasoning never become a reply', () => {
  assert.equal(
    parseReply('确实，规则堆多了容易互相打架。', 'text').text,
    '确实，规则堆多了容易互相打架。',
  );
  assert.equal(parseReply('这景色看着挺舒服。', 'sns').action, 'comment');
  assert.equal(parseReply('无需回复', 'text').action, 'ignore');
  for (const raw of [
    '{"action":"reply",',
    '<think>thinking</think>',
    'analysis: secret',
    'x'.repeat(501),
  ]) {
    assert.throws(() => parseReply(raw, 'text'));
  }
  assert.throws(() => parseReply('{"action":"reply","text":"x","recipient":"someone"}', 'text'));
});

function foundation(): { bundle: FoundationBundle; sources: FoundationSource[] } {
  const records = Array.from({ length: 9 }, (_, i) => ({
    id: `K${i}`,
    owner_persona_id: 'double',
    subject_id: 'owner',
    visibility: 'owner_private',
    category: '工作知识',
    title: i === 8 ? 'Router 计划' : '工时资料',
    statement: i === 8 ? '曾计划构建 Router' : '本人协调工时资料' + i,
    source_ids: ['source'],
    status: 'plan_at_source',
    observed_from: '2026-11-01',
    observed_to: '2026-11-02',
    caveat: '计划不等于完成',
    tags: i === 8 ? ['Router'] : ['工时'],
  }));
  return {
    bundle: {
      default_persona_id: 'double',
      subject_id: 'owner',
      source_snapshot: 'snapshot',
      records,
    },
    sources: [{ source_id: 'source', id: 123, text: '我打算构建 Router', date: '2026-11-02' }],
  };
}

test('foundation shares the memory store but only verified owner or local preview can retrieve it', (t) => {
  const f = setup(t);
  const { bundle, sources } = foundation();
  assert.equal(f.personas.importFoundation(bundle, sources).added, 9);
  const e: Partial<WxarcEvent> & { kind: 'text' } = {
    kind: 'text',
    session: 'owner',
    senderId: 'owner',
    text: 'Router 的进展呢',
  };
  const policy = { controllerId: 'owner' };
  const m = f.personas.context('double', e, policy)!.memory;
  assert.equal(m[0].title, 'Router 计划');
  assert.equal(m[0].status, 'plan_at_source');
  assert.deepEqual(m[0].sourceIds, ['source']);
  const denied: Array<Partial<WxarcEvent> & { kind: 'text' | 'sns' }> = [
    { ...e, session: 'group@chatroom' },
    { ...e, senderId: 'attacker' },
    { ...e, kind: 'sns' },
  ];
  for (const event of denied) {
    assert.equal(f.personas.context('double', event, policy)!.memory.length, 0);
  }
  assert.equal(f.personas.context('double', e, {})!.memory.length, 0);
  assert.equal(f.personas.context('original', e, policy)!.memory.length, 0);
  assert.equal(
    f.personas.context('double', { ...e, session: 'preview' }, policy, true)!.memory[0].title,
    'Router 计划',
  );
  assert.equal(
    f.personas.context('double', { ...e, text: '工时资料' }, policy)!.memory.length,
    6,
  );
});

test('foundation import preserves edits, provenance and old preferences across repeated import and restart', (t) => {
  const f = setup(t);
  const { bundle, sources } = foundation();
  const p = f.personas.get('double');
  f.personas.save({ ...p, learning: true }, p.revision);
  f.personas.importFoundation(bundle, sources);
  const row = f.personas.memories('double').find((m) => m.metadata.id === 'K8')!;
  f.personas.editMemory('double', row.id, 'Router 已由本人核实完成');
  assert.equal(f.personas.importFoundation(bundle, sources).added, 0);
  const e: Partial<WxarcEvent> & { kind: 'text' } = {
    kind: 'text',
    session: 'owner',
    senderId: 'owner',
    sender: '我',
    text: '以后回复短一点',
  };
  for (let seq = 1; seq <= 30; seq++) {
    f.personas.remember('double', { ...e, seq }, {
      memory: [{ note: '偏好短回复', quote: '回复短一点' }],
    });
  }
  assert.equal(f.personas.memories('double').length, 33);
  const restart = new Personas(f.store, f.llm);
  const memory = restart.context('double', { ...e, text: 'Router' }, { controllerId: 'owner' })!
    .memory;
  assert.equal(memory.length, 17);
  assert.equal(memory[16].status, 'user_corrected');
  assert.equal(memory[16].note, 'Router 已由本人核实完成');
  assert.equal(restart.memories('double').find((m) => m.id === row.id)!.metadata.evidence![0].id, 123);
  restart.clear('double');
  assert.equal(restart.get('double').memoryCount, 0);
});

test('invalid foundation cannot partially import records or assign another identity', (t) => {
  const f = setup(t);
  const { bundle, sources } = foundation();
  bundle.records[8].subject_id = 'other';
  assert.throws(() => f.personas.importFoundation(bundle, sources), /归属/);
  assert.equal(f.personas.get('double').memoryCount, 0);
});

test('memory appears once in system context and never bloats the incoming message', () => {
  const { system, content } = decisionPrompt(
    { instructions: '自然回复' },
    { kind: 'text', session: 'owner', text: '你好' },
    [],
    { memory: [{ note: 'UNIQUE_FOUNDATION_NOTE', status: 'plan_at_source' }] },
  );
  assert.equal(system.split('UNIQUE_FOUNDATION_NOTE').length - 1, 1);
  assert.ok(!content.includes('UNIQUE_FOUNDATION_NOTE'));
  assert.match(system, /计划不等于完成/);
});
