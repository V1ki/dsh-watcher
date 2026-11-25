import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  AgentBridge,
  nativeReply,
  needsOperationConfirmation,
  withinWorkspace,
} from '../src/agent.js';
import { Automation } from '../src/automation.js';
import { Store } from '../src/core.js';

const signal = () => new AbortController().signal;

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'wxarc-native-'));
  const store = new Store(dir);
  const hooks: Record<string, (...args: any[]) => any> = {};
  const agents = new Map<string, any>();
  const prompts: Array<Record<string, any>> = [];
  const sent: Array<Record<string, any>> = [];
  const listener = { status: () => ({ healthy: true }), wechatRoot: '/data/wxid_me_abcd' };
  const auto = new Automation({
    store,
    listener,
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
    wxarcHome: dir,
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
        pendingInput: agents.get(sessionId)?.pending || [],
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
  const policy = {
    ...auto.settings().policy,
    enabled: true,
    allChats: true,
    mode: 'send',
    provider: 'test',
    model: 'test',
    ownId: 'wxid_me',
    instructions: '自然回复',
    debounceMs: 0,
  };
  auto.save(policy, 0);
  const event = (
    session = 'peer',
  ): { kind: 'text'; session: string; sender: string; text: string; ts: number; [key: string]: any } => ({
    kind: 'text',
    session,
    sender: 'peer',
    text: '你好',
    ts: Math.floor(Date.now() / 1000),
  });
  const start = async (e?: Record<string, any>) =>
    bridge.start(
      { event: e || event(), rule: { title: '测试聊天' }, policy: auto.settings().policy },
      signal(),
    );
  const done = (run: { id: string }, text = '{"action":"reply","text":"做好了"}') => {
    const r = bridge.run(run.id)!;
    emit(r.session_id, 'assistant/message', {
      turn: r.turn,
      message: { content: [{ type: 'text', text }] },
    });
    emit(r.session_id, 'turn/end', { turn: r.turn, reason: { kind: 'completed' } });
    agents.get(r.session_id).busy = false;
  };
  const append = (id: number, session = 'peer') =>
    store.commit('text', store.cursor('text').id, [{ ...event(session), id, local_type: 1 }], 1000);
  t.after(async () => {
    await auto.close();
    await bridge.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, auto, bridge, ctx, hooks, agents, prompts, emit, start, done, event, append, sent };
}

test('native session survives repeated tasks and isolates chats and roles', async (t) => {
  const f = setup(t);
  const a = await f.start();
  f.done(a);
  const b = await f.start();
  assert.equal(a.session_id, b.session_id);
  f.done(b);
  const c = await f.start(f.event('group@chatroom'));
  assert.notEqual(c.session_id, a.session_id);
  assert.equal(f.prompts.length, 3);
});

test('DSH group input carries room nickname, personal nickname and verified ID', async (t) => {
  const f = setup(t);
  const event = {
    ...f.event('group@chatroom'),
    sender: '原始备注',
    senderId: 'wxid_member',
    senderIdentity: { id: 'wxid_member', nickname: '林同学', groupNickname: '项目小林' },
  };
  const run = await f.start(event);
  assert.equal(f.prompts[0].content[0].text, '[项目小林](林同学#wxid_member)：你好');
  assert.equal(f.bridge.run(run.id)!.event.senderId, 'wxid_member');
  assert.match(f.bridge.prompt(run.session_id), /同名成员按微信ID区分/);
});

test('only completed final assistant message becomes reply; progress and failures cannot send', async (t) => {
  const f = setup(t);
  const r = await f.start();
  f.emit(r.session_id, 'assistant/message', {
    turn: 1,
    message: {
      content: [
        { type: 'text', text: '我准备读取文件' },
        { type: 'tool-call', name: 'read' },
      ],
    },
  });
  f.emit(r.session_id, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  assert.equal(f.bridge.run(r.id)!.status, 'failed');
});

test('manual owner input suppresses automatic delivery, including after final output', async (t) => {
  const f = setup(t);
  const r = await f.start();
  f.done(r);
  f.emit(r.session_id, 'user/message', { source: { kind: 'user', rpcId: 'owner-input' } });
  assert.equal(f.bridge.run(r.id)!.status, 'manual');
});

test('tool guard preserves denial and asks for commands or paths outside chat cwd', async (t) => {
  const f = setup(t);
  const r = await f.start();
  const agent = f.agents.get(r.session_id);
  const gate = f.hooks['tools/pre-execute'];
  assert.equal(
    (await gate({ agent, name: 'write', arguments: { file_path: 'ok.txt' } }, async () => ({ kind: 'allow' })))
      .kind,
    'allow',
  );
  for (const [name, args] of [
    ['bash', { command: 'pwd' }],
    ['read', { file_path: '../secret' }],
    ['grep', { pattern: 'x', path: '..' }],
    ['wxarc_messages', {}],
  ] as const) {
    assert.equal(
      (await gate({ agent, name, arguments: args }, async () => ({ kind: 'allow' }))).kind,
      'ask',
    );
  }
  assert.equal(
    (await gate({ agent, name: 'write', arguments: { file_path: 'ok.txt' } }, async () => ({ kind: 'deny' })))
      .kind,
    'deny',
  );
});

test('native steps continue beyond both former caps while preserving attempt counts', async (t) => {
  const f = setup(t);
  const r = await f.start();
  const agent = f.agents.get(r.session_id);
  (f.auto as any).settings = () => ({ policy: { maxPerHour: 2 } });
  for (let i = 0; i < 65; i++) {
    assert.equal((await f.hooks['agent/pre-step']({ agent }, async () => ({ kind: 'enter' }))).kind, 'enter');
  }
  assert.equal(f.bridge.run(r.id)!.status, 'running');
  assert.equal(f.bridge.run(r.id)!.steps, 65);
  assert.equal(
    (f.store.db.prepare('SELECT COUNT(*) n FROM automation_attempts').get() as { n: number }).n,
    65,
  );
});

test('native admission proceeds after the former hourly allowance is consumed', async (t) => {
  const f = setup(t);
  const settings = f.auto.settings.bind(f.auto);
  (f.auto as any).settings = () => {
    const s = settings();
    return { ...s, policy: { ...s.policy, maxPerHour: 1 } };
  };
  f.store.db.prepare('INSERT INTO automation_attempts(job_id,at) VALUES (?,?)').run(0, Date.now());
  f.append(1);
  await f.auto.collect();
  await f.auto.process();
  assert.equal(f.prompts.length, 1);
  assert.equal(f.auto.jobs()[0].status, 'agent_running');
});

test('native waiting chat does not block other chat; successful completion sends once', async (t) => {
  const f = setup(t);
  f.append(1);
  f.append(2, 'another');
  await f.auto.collect();
  await f.auto.process();
  const a = f.auto.jobs().find((j) => j.event.session === 'peer')!;
  f.emit(a.event.dshSessionId, 'approval/asked', {});
  f.agents.get(a.event.dshSessionId).pending = ['approval'];
  await f.auto.process();
  assert.equal(f.auto.job(a.id).status, 'agent_waiting');
  assert.equal(f.prompts.length, 2);
  const b = f.auto.jobs().find((j) => j.event.session === 'another')!;
  f.done(f.bridge.run(b.event.dshRunId)!);
  await f.auto.process();
  assert.equal(f.auto.job(b.id).status, 'sent');
  assert.equal(f.sent.length, 1);
  await f.auto.process();
  assert.equal(f.sent.length, 1);
});

test('settings change cancels native work and cannot replay tool execution', async (t) => {
  const f = setup(t);
  f.append(1);
  await f.auto.collect();
  await f.auto.process();
  const j = f.auto.jobs()[0];
  const before = f.auto.settings();
  f.auto.save(before.policy, before.revision);
  assert.equal(f.auto.job(j.id).status, 'cancelled');
  assert.equal(f.bridge.run(j.event.dshRunId)!.status, 'cancelled');
  await assert.rejects(f.auto.queueEvent(j.event_seq, f.auto.settings().revision), /原会话/);
  assert.equal(f.prompts.length, 1);
});

test('file containment checks symlinks; output rejects malformed protocol and reasoning', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wxarc-path-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'work'));
  symlinkSync(tmpdir(), join(dir, 'work', 'escape'));
  assert.equal(withinWorkspace(join(dir, 'work'), 'escape/private'), false);
  assert.equal(withinWorkspace(join(dir, 'work'), 'new/file'), true);
  assert.throws(() => nativeReply('{"action":"reply","text":"x","recipient":"someone"}', 'text'));
  assert.throws(() => nativeReply('<think>abc</think>', 'text'));
  assert.equal(nativeReply('好了，文件写好了。', 'text').action, 'reply');
});

test('restart records interrupt rather than replaying native task', async (t) => {
  const f = setup(t);
  const r = await f.start();
  await f.bridge.close();
  f.store.db.prepare("UPDATE dsh_runs SET status='running' WHERE id=?").run(r.id);
  const b = new AgentBridge(f.ctx, f.store, {
    root: join(f.store.dir, 'restart'),
    personas: { context: () => ({ name: 'x' }) },
    settings: () => f.auto.settings(),
  });
  assert.equal(b.run(r.id)!.status, 'interrupted');
  assert.equal(f.prompts.length, 1);
  await b.close();
});

test('busy session preserves its original context and does not admit another task', async (t) => {
  const f = setup(t);
  const r = await f.start();
  const before = f.bridge.conversation(r.session_id)!.context;
  await assert.rejects(
    f.start({ ...f.event(), text: 'different content' }),
    (e: Error & { code?: string }) => e.code === 'WXARC_BUSY',
  );
  assert.equal(f.bridge.conversation(r.session_id)!.context, before);
  assert.equal(f.prompts.length, 1);
});

test('concurrent admission submits only one task for a chat', async (t) => {
  const f = setup(t);
  const results = await Promise.allSettled([f.start(), f.start()]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(f.prompts.length, 1);
});

test('takeover is recognized when input is queued, before a long-running tool finishes', async (t) => {
  const f = setup(t);
  const r = await f.start();
  f.hooks['agent/inbox/inserted']({
    agent: f.agents.get(r.session_id),
    message: { source: { kind: 'user', rpcId: 'owner-queued' } },
  });
  assert.equal(f.bridge.run(r.id)!.manual, 1);
  f.done(r);
  assert.equal(f.bridge.run(r.id)!.status, 'manual');
});

test('image routes receive actual attachment bytes; text-only route is refused before admission', async (t) => {
  const f = setup(t);
  f.ctx.llm.resolveModelInfo = async () => ({ inputModalities: ['text', 'image'] });
  f.bridge.images = { part: () => ({ type: 'image', mediaType: 'image/png', data: 'TEST-IMAGE' }) };
  const event = { ...f.event(), local_type: 3, text: '[图片]' };
  const run = await f.start(event);
  assert.equal(f.prompts[0].content[1].data, 'TEST-IMAGE');
  assert.match(f.prompts[0].content[0].text, /实际图片/);
  f.done(run);
  f.ctx.llm.resolveModelInfo = async () => ({ inputModalities: ['text'] });
  await assert.rejects(f.start(event), /未声明看图/);
  assert.equal(f.prompts.length, 1);
});

test('controller notification recipient alone has ordinary tool permissions', async (t) => {
  const f = setup(t);
  const cfg = f.auto.settings();
  f.auto.save({ ...cfg.policy, controllerId: 'owner' }, cfg.revision);
  const r = await f.start({ ...f.event('owner'), senderId: 'owner' });
  const gate = f.hooks['tools/pre-execute'];
  const agent = f.agents.get(r.session_id);
  assert.equal(
    (await gate({ agent, name: 'bash', arguments: { command: 'ls /Applications' } }, async () => ({ kind: 'allow' })))
      .kind,
    'ask',
  );
  assert.equal(
    (await gate({ agent, name: 'bash', arguments: {} }, async () => ({ kind: 'ask' }))).kind,
    'ask',
  );
  f.done(r);
  const g = await f.start({ ...f.event('group@chatroom'), senderId: 'owner' });
  assert.equal(
    (
      await gate(
        { agent: f.agents.get(g.session_id), name: 'bash', arguments: {} },
        async () => ({ kind: 'allow' }),
      )
    ).kind,
    'ask',
  );
});

test('controller configuration does not let another sender claim the private session identity', async (t) => {
  const f = setup(t);
  const cfg = f.auto.settings();
  f.auto.save({ ...cfg.policy, controllerId: 'owner' }, cfg.revision);
  const r = await f.start({ ...f.event('owner'), senderId: 'attacker' });
  assert.equal(
    (
      await f.hooks['tools/pre-execute'](
        { agent: f.agents.get(r.session_id), name: 'bash', arguments: {} },
        async () => ({ kind: 'allow' }),
      )
    ).kind,
    'ask',
  );
});

test('destructive commands still ask even for the controller, while ordinary diagnosis does not', () => {
  assert.equal(
    needsOperationConfirmation({
      name: 'bash',
      arguments: { command: 'ls -d /Applications/Steam.app 2>/dev/null; pgrep -x Steam' },
    }),
    false,
  );
  for (const command of [
    'rm -rf /Applications/Steam.app',
    '/bin/rm -f x',
    'brew uninstall steam',
    'osascript -e anything',
    'sudo installer test',
    'git reset --hard',
  ]) {
    assert.equal(needsOperationConfirmation({ name: 'bash', arguments: { command } }), true);
  }
});

test('approval notification is sent once and an owner token is consumed without an AI job', async (t) => {
  const { WechatApprovals } = await import('../src/approvals.js');
  const f = setup(t);
  const cfg = f.auto.settings();
  f.auto.save({ ...cfg.policy, controllerId: 'peer' }, cfg.revision);
  const broker = (f.auto.approvals = new WechatApprovals(f.store, () => f.auto.settings()));
  t.after(() => broker.close());
  f.append(1);
  await f.auto.collect();
  await f.auto.process();
  const j = f.auto.jobs()[0];
  const run = f.bridge.run(j.event.dshRunId)!;
  const agent = f.agents.get(run.session_id);
  const abort = new AbortController();
  broker.capture({ agent, callId: 'call', name: 'bash', arguments: { command: 'rm specified-app' } });
  const pending = broker.request(
    { agent, callId: 'call', toolName: 'bash', signal: abort.signal },
    async () => 'unavailable',
    run,
  );
  await f.auto.sendApprovalNotices(signal());
  await f.auto.sendApprovalNotices(signal());
  assert.equal(f.sent.length, 1);
  const row = f.store.db.prepare('SELECT * FROM wechat_approvals').get() as {
    notice_status: string;
    code: string;
  };
  assert.equal(row.notice_status, 'sent');
  f.store.commit(
    'text',
    f.store.cursor('text').id,
    [{ ...f.event(), id: 2, local_type: 1, text: `确认 ${row.code}` }],
    1000,
  );
  await f.auto.collect();
  assert.equal(await pending, 'allowed-once');
  assert.equal(f.auto.jobs().length, 1);
});

test('explicit owner continuation preserves prior run and refuses concurrent or sent retries', async (t) => {
  const f = setup(t);
  const cfg = f.auto.settings();
  f.auto.save({ ...cfg.policy, controllerId: 'peer' }, cfg.revision);
  f.append(1);
  await f.auto.collect();
  await f.auto.process();
  const before = f.auto.jobs()[0];
  await assert.rejects(f.auto.resumeJob(before.id, f.auto.settings().revision), /已停止/);
  f.bridge.cancel(before.event.dshRunId, 'test cancellation');
  f.agents.get(before.event.dshSessionId).busy = false;
  f.auto.state(before.id, 'failed');
  const next = await f.auto.resumeJob(before.id, f.auto.settings().revision);
  assert.notEqual(next.event.dshRunId, before.event.dshRunId);
  assert.equal(f.bridge.run(before.event.dshRunId)!.status, 'cancelled');
  assert.equal(f.prompts.length, 2);
  assert.match(f.prompts[1].content[0].text, /已完成的操作不要重复执行/);
  await assert.rejects(f.auto.resumeJob(before.id, f.auto.settings().revision));
});

test('delivery anchor must be the verified owner approval for this run, not arbitrary new chat', async (t) => {
  const { WechatApprovals } = await import('../src/approvals.js');
  const f = setup(t);
  const cfg = f.auto.settings();
  f.auto.save({ ...cfg.policy, controllerId: 'peer' }, cfg.revision);
  const broker = (f.auto.approvals = new WechatApprovals(f.store, () => f.auto.settings()));
  t.after(() => broker.close());
  f.append(1);
  await f.auto.collect();
  await f.auto.process();
  const j = f.auto.jobs()[0];
  const run = f.bridge.run(j.event.dshRunId)!;
  const agent = f.agents.get(run.session_id);
  const abort = new AbortController();
  broker.capture({ agent, callId: 'call', name: 'bash', arguments: { command: 'rm specified-app' } });
  const p = broker.request({ agent, callId: 'call', signal: abort.signal }, async () => 'unavailable', run);
  const row = broker.notices()[0];
  broker.notice(row.code, 'sent');
  f.store.commit('text', f.store.cursor('text').id, [{ ...f.event(), id: 2, local_type: 1, text: '确认' }], 1000);
  await f.auto.collect();
  assert.equal(await p, 'allowed-once');
  f.append(3);
  assert.equal(f.auto.approvalAnchor(j)!.id, 2);
  assert.equal(f.auto.approvalAnchor({ ...j, event: { ...j.event, dshRunId: 'different-run' } }), null);
  assert.equal(f.auto.approvalAnchor({ ...j, event: { ...j.event, session: 'group@chatroom' } }), null);
});

test('missing-trigger delivery can retry its completed result without rerunning the agent', async (t) => {
  const f = setup(t);
  f.append(1);
  await f.auto.collect();
  await f.auto.process();
  const j = f.auto.jobs()[0];
  f.done(f.bridge.run(j.event.dshRunId)!);
  const prepare = f.auto.cua.prepare;
  f.auto.cua.prepare = async () => {
    throw Error('当前会话中未找到触发回复的原消息');
  };
  await f.auto.process();
  assert.equal(f.auto.job(j.id).status, 'failed');
  f.auto.cua.prepare = prepare;
  f.auto.archiveHistory = () => [];
  await f.auto.sendDraft(j.id);
  assert.equal(f.auto.job(j.id).status, 'sent');
  assert.equal(f.prompts.length, 1);
  assert.equal(f.sent.length, 1);
  await assert.rejects(f.auto.sendDraft(j.id));
});

test('native follow-ups retain the same session without reattaching old chat or approvals', async (t) => {
  const f = setup(t);
  f.append(1);
  await f.auto.collect();
  await f.auto.process();
  const first = f.auto.jobs()[0];
  f.done(f.bridge.run(first.event.dshRunId)!);
  await f.auto.process();
  f.store.commit(
    'text',
    f.store.cursor('text').id,
    [{ ...f.event(), id: 2, local_type: 1, sender: 'wxid_me', text: 'DSH 有一项操作需要你确认：OLD-APPROVAL-DUMP' }],
    1000,
  );
  f.append(3);
  await f.auto.collect();
  f.auto.recent = () => {
    throw Error('native flow must not re-read chat history');
  };
  await f.auto.process();
  const second = f.auto.jobs()[0];
  assert.equal(second.status, 'agent_running');
  assert.equal(second.event.dshSessionId, first.event.dshSessionId);
  assert.equal(f.prompts.length, 2);
  const text = f.prompts[1].content[0].text;
  assert.equal(text, '你好');
  assert.doesNotMatch(text, /最近聊天记录|OLD-APPROVAL-DUMP|做好了/);
  assert.ok(text.length < 100);
});

test('native input discards legacy transcript arguments but preserves this message article', async (t) => {
  const f = setup(t);
  const event = {
    ...f.event(),
    text: '看看这篇文章',
    article: {
      status: 'read',
      title: '当前文章',
      url: 'https://example.com/current',
      text: 'CURRENT-ARTICLE-BODY',
      snapshot: true,
      fetched_at: 123,
    },
  };
  await f.bridge.start(
    {
      event,
      rule: { title: '测试聊天' },
      policy: f.auto.settings().policy,
      context: [{ sender: 'peer', text: 'OLD-CHAT-BLOCK'.repeat(1000) }],
      preview: true,
    },
    signal(),
  );
  const text = f.prompts[0].content[0].text;
  assert.match(text, /试聊预览/);
  assert.match(text, /CURRENT-ARTICLE-BODY/);
  assert.match(text, /"snapshot":true/);
  assert.doesNotMatch(text, /OLD-CHAT-BLOCK|最近聊天记录/);
});

test('group sticker messages reach the vision route and search is allowed without local-machine privileges', async (t) => {
  const f = setup(t);
  f.ctx.llm.resolveModelInfo = async () => ({ inputModalities: ['text', 'image'] });
  f.bridge.images = { part: () => ({ type: 'image', mediaType: 'image/png', data: 'STICKER' }) };
  f.auto.enrich = async (e) => ({ ...e, image: { status: 'read', sticker: true, preview: 'static' } });
  f.store.commit(
    'text',
    f.store.cursor('text').id,
    [{ ...f.event('group@chatroom'), id: 1, local_type: 47, text: '[动画表情]' }],
    1000,
  );
  await f.auto.collect();
  await f.auto.process();
  const j = f.auto.jobs()[0];
  assert.equal(j.status, 'agent_running');
  assert.equal(f.prompts[0].content[1].data, 'STICKER');
  assert.match(f.prompts[0].content[0].text, /^\[未知昵称\]\(未知昵称#peer\)：\[动画表情\]/);
  assert.doesNotMatch(f.prompts[0].content[0].text, /微信任务/);
  assert.match(f.prompts[0].content[0].text, /不能声称看到了完整动画/);
  const agent = f.agents.get(j.event.dshSessionId);
  assert.equal(
    (
      await f.hooks['tools/pre-execute'](
        { agent, name: 'wxarc_sticker_search', arguments: { query: '惊讶' } },
        async () => ({ kind: 'allow' }),
      )
    ).kind,
    'allow',
  );
  assert.equal(
    (
      await f.hooks['tools/pre-execute'](
        { agent, name: 'bash', arguments: { command: 'pwd' } },
        async () => ({ kind: 'allow' }),
      )
    ).kind,
    'ask',
  );
});

test('local continuation of a verified group task keeps group tool restrictions', async (t) => {
  const f = setup(t);
  f.append(1, 'group@chatroom');
  await f.auto.collect();
  await f.auto.process();
  const old = f.auto.jobs()[0];
  f.bridge.cancel(old.event.dshRunId, 'test');
  f.agents.get(old.event.dshSessionId).busy = false;
  f.auto.state(old.id, 'failed');
  const j = await f.auto.resumeJob(old.id, f.auto.settings().revision);
  const gate = await f.hooks['tools/pre-execute'](
    { agent: f.agents.get(j.event.dshSessionId), name: 'bash', arguments: { command: 'pwd' } },
    async () => ({ kind: 'allow' }),
  );
  assert.equal(gate.kind, 'ask');
  assert.equal(j.event.dshSessionId, old.event.dshSessionId);
});

test('native foundation context reaches the system prompt once, including authenticated preview', async (t) => {
  const { Personas } = await import('../src/personas.js');
  const f = setup(t);
  const p = (f.bridge.personas = new Personas(f.store, {} as any));
  p.importFoundation(
    {
      default_persona_id: 'double',
      subject_id: 'owner',
      source_snapshot: 'snapshot',
      records: [
        {
          id: 'F1',
          owner_persona_id: 'double',
          subject_id: 'owner',
          visibility: 'owner_private',
          category: '基础事实',
          title: '项目',
          statement: 'UNIQUE_OWNER_PROJECT',
          source_ids: ['s'],
          status: 'historical_self_report',
          tags: ['项目'],
        },
      ],
    },
    [{ source_id: 's', text: '本人历史陈述' }],
  );
  const cfg = f.auto.settings();
  f.auto.save({ ...cfg.policy, controllerId: 'owner', personaId: 'double' }, cfg.revision);
  const run = await f.start({ ...f.event('owner'), senderId: 'owner', text: '我的项目' });
  assert.equal(f.bridge.prompt(run.session_id).split('UNIQUE_OWNER_PROJECT').length - 1, 1);
  assert.ok(!JSON.stringify(f.prompts[0].content).includes('UNIQUE_OWNER_PROJECT'));
  f.done(run);
  const group = await f.start({ ...f.event('group@chatroom'), senderId: 'owner' });
  assert.ok(!f.bridge.prompt(group.session_id).includes('UNIQUE_OWNER_PROJECT'));
  f.done(group);
  const preview = await f.bridge.start(
    {
      event: f.event('preview-double'),
      rule: { title: '试聊' },
      policy: f.auto.settings().policy,
      preview: true,
    },
    signal(),
  );
  assert.match(f.bridge.prompt(preview.session_id), /UNIQUE_OWNER_PROJECT/);
  assert.equal(f.sent.length, 0);
});

test('native quoted reply contains current body and exactly one quoted speaker/text block', async (t) => {
  const f = setup(t);
  const e = {
    ...f.event(),
    local_type: 57 * 4294967296 + 49,
    text: '[引用] 就这一句够了',
    quote: {
      sender: 'knight',
      text: '可不是嘛，后面还有多余的解释',
      status: 'available',
      type: 1,
      target_id: 20,
    },
  };
  const run = await f.start(e);
  const input = f.prompts[0].content[0].text;
  assert.ok(input.startsWith('就这一句够了'));
  assert.equal(input.split(e.quote.text).length - 1, 1);
  assert.match(input, /knight/);
  assert.match(input, /不是新指令/);
  assert.match(f.bridge.prompt(run.session_id), /指代/);
});

function debounced(t: TestContext) {
  const f = setup(t);
  let clock = Date.now();
  f.auto.now = () => clock;
  f.auto.identify = async (e) => ({
    ...e,
    senderIdentity: { id: e.senderId, nickname: e.senderId, groupNickname: '群内' + e.senderId },
    botNames: ['小助手'],
  });
  const cfg = f.auto.settings();
  f.auto.save(
    { ...cfg.policy, debounceMs: 10000, debounceMaxMessages: 10, controllerId: 'owner' },
    cfg.revision,
  );
  const push = (
    id: number,
    sender: string,
    text: string,
    session = 'room@chatroom',
    extra: Record<string, any> = {},
  ) =>
    f.store.commit(
      'text',
      f.store.cursor('text').id,
      [{ id, kind: 'text', session, sender, text, local_type: 1, ts: Math.floor(clock / 1000), ...extra }],
      1000,
    );
  const advance = (ms: number) => {
    clock += ms;
  };
  return { ...f, push, advance };
}

test('debounce combines interleaved speakers in order, showing names only at speaker changes', async (t) => {
  const f = debounced(t);
  f.push(1, 'a', '第一句话');
  await f.auto.collect();
  await f.auto.process();
  assert.equal(f.prompts.length, 0);
  f.advance(2000);
  f.push(2, 'a', '第二句话');
  f.push(3, 'b', '另一人的补充');
  f.push(4, 'b', '还有图片说明');
  f.push(5, 'a', '最后补充');
  await f.auto.collect();
  f.advance(9999);
  await f.auto.process();
  assert.equal(f.prompts.length, 0);
  f.advance(1);
  await f.auto.process();
  assert.equal(f.prompts.length, 1);
  assert.equal(
    f.prompts[0].content[0].text,
    '[群内a](a#a)：第一句话\n第二句话\n[群内b](b#b)：另一人的补充\n还有图片说明\n[群内a](a#a)：最后补充',
  );
  const jobs = f.auto.jobs();
  assert.equal(jobs.filter((j) => j.status === 'batched').length, 4);
  const parent = jobs.find((j) => j.status === 'agent_running')!;
  assert.equal(parent.event.id, 5);
  assert.equal(parent.source_key, 'key-5');
  f.done(f.bridge.run(parent.event.dshRunId)!);
  await f.auto.process();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].event.id, 5);
});

test('each arrival restarts a full ten-second wait with no fixed deadline from the first message', async (t) => {
  const f = debounced(t);
  f.push(1, 'a', '第一条');
  await f.auto.collect();
  for (let id = 2; id <= 9; id++) {
    f.advance(8000);
    f.push(id, id % 2 ? 'a' : 'b', '连续补充' + id);
    await f.auto.collect();
    await f.auto.process();
    assert.equal(f.prompts.length, 0);
  }
  f.advance(9999);
  await f.auto.process();
  assert.equal(f.prompts.length, 0);
  f.advance(1);
  await f.auto.process();
  assert.equal(f.prompts.length, 1);
  assert.equal(f.auto.jobs().find((j) => j.status === 'agent_running')!.event.batch.messages.length, 9);
});

test('the tenth message starts processing immediately; overflow stays queued for the next batch', async (t) => {
  const f = debounced(t);
  for (let id = 1; id <= 9; id++) {
    f.push(id, 'a', '新消息' + id);
  }
  await f.auto.collect();
  await f.auto.process();
  assert.equal(f.prompts.length, 0);
  f.push(10, 'b', '第十条');
  f.push(11, 'b', '下一段第一条');
  f.push(12, 'b', '下一段第二条');
  await f.auto.collect();
  await f.auto.process();
  assert.equal(f.prompts.length, 1);
  assert.equal(f.auto.jobs().find((j) => j.status === 'agent_running')!.event.batch.messages.length, 10);
  assert.deepEqual(
    f.auto
      .jobs()
      .filter((j) => j.status === 'queued')
      .map((j) => j.event.id)
      .sort((a, b) => a - b),
    [11, 12],
  );
  assert.doesNotMatch(JSON.stringify(f.prompts[0].content), /下一段/);
});

test('message counts and silence timers are independent between conversations', async (t) => {
  const f = debounced(t);
  for (let id = 1; id <= 5; id++) {
    f.push(id, 'a', '群一' + id);
  }
  await f.auto.collect();
  f.advance(9000);
  for (let id = 6; id <= 10; id++) {
    f.push(id, 'b', '群二' + id, 'other@chatroom');
  }
  await f.auto.collect();
  await f.auto.process();
  assert.equal(f.prompts.length, 0);
  f.advance(1000);
  await f.auto.process();
  assert.equal(f.prompts.length, 1);
  assert.doesNotMatch(JSON.stringify(f.prompts[0].content), /群二/);
  f.advance(9000);
  await f.auto.process();
  assert.equal(f.prompts.length, 2);
  assert.notEqual(f.prompts[0].sessionId, f.prompts[1].sessionId);
});

test('batch attaches multiple images in message order and keeps each quotation with its author', async (t) => {
  const f = debounced(t);
  f.ctx.llm.resolveModelInfo = async () => ({ inputModalities: ['text', 'image'] });
  f.bridge.images = { part: (e) => ({ type: 'image', data: 'image-' + e.id, mediaType: 'image/png' }) };
  f.auto.enrich = async (e) => ({
    ...e,
    ...([3, 47].includes(e.local_type) ? { image: { status: 'read', hash: 'hash-' + e.id } } : {}),
  });
  f.push(1, 'a', '[图片]', 'room@chatroom', { local_type: 3 });
  f.push(2, 'a', '看这个报错');
  f.push(3, 'b', '[引用] 我这边不同', 'room@chatroom', {
    local_type: 57 * 4294967296 + 49,
    quote: { status: 'available', sender: '甲', text: '被引用的原话' },
  });
  f.push(4, 'b', '[图片]', 'room@chatroom', { local_type: 3 });
  await f.auto.collect();
  f.advance(10000);
  await f.auto.process();
  const c = f.prompts[0].content as Array<Record<string, any>>;
  assert.deepEqual(
    c.filter((p) => p.type === 'image').map((p) => p.data),
    ['image-1', 'image-4'],
  );
  assert.match(c[0].text, /群内a/);
  assert.match(c[2].text, /^看这个报错/);
  assert.match(c[2].text, /群内b.*我这边不同/);
  assert.equal(JSON.stringify(c).split('被引用的原话').length - 1, 1);
});

test('new arrivals suppress the old draft and continue the original native session without replaying its input', async (t) => {
  const f = debounced(t);
  f.push(1, 'a', '帮我查询报告');
  await f.auto.collect();
  f.advance(10000);
  await f.auto.process();
  const old = f.auto.jobs()[0];
  const run = f.bridge.run(old.event.dshRunId)!;
  f.push(2, 'a', '只看上个月');
  await f.auto.collect();
  f.done(run, '{"action":"reply","text":"旧草稿"}');
  await f.auto.process();
  assert.equal(f.sent.length, 0);
  assert.equal(f.auto.job(old.id).status, 'superseded');
  f.advance(10000);
  await f.auto.process();
  assert.equal(f.prompts.length, 2);
  assert.equal(f.prompts[1].sessionId, run.session_id);
  const input = JSON.stringify(f.prompts[1].content);
  assert.match(input, /只看上个月/);
  assert.match(input, /之前完成的工具操作不要重复执行/);
  assert.doesNotMatch(input, /帮我查询报告/);
  const next = f.auto.jobs().find((j) => j.status === 'agent_running')!;
  f.done(f.bridge.run(next.event.dshRunId)!);
  await f.auto.process();
  assert.equal(f.sent.length, 1);
});

test('same-sender cancellation stops the pending task; another group member cannot cancel it', async (t) => {
  const f = debounced(t);
  f.push(1, 'a', '查一份报告');
  await f.auto.collect();
  f.advance(10000);
  await f.auto.process();
  const old = f.auto.jobs()[0];
  f.push(2, 'b', '不用了');
  await f.auto.collect();
  await f.auto.process();
  assert.equal(f.auto.job(old.id).status, 'agent_running');
  f.push(3, 'a', '算了，不用了');
  await f.auto.collect();
  await f.auto.process();
  assert.equal(f.auto.job(old.id).status, 'cancelled');
  assert.equal(f.bridge.run(old.event.dshRunId)!.status, 'cancelled');
  assert.equal(f.sent.length, 0);
  assert.ok(f.agents.get(old.event.dshSessionId).cancelled);
});

test('pause is local and durable; explicit re-addressing restores replies without a cooldown', async (t) => {
  const f = debounced(t);
  f.push(1, 'owner', '先别说了');
  await f.auto.collect();
  f.advance(10000);
  await f.auto.process();
  assert.equal(f.prompts.length, 0);
  assert.equal(f.auto.batches.state({ session: 'room@chatroom' } as any).paused, 1);
  f.push(2, 'b', '我们继续聊');
  await f.auto.collect();
  f.advance(10000);
  await f.auto.process();
  assert.equal(f.prompts.length, 0);
  f.push(3, 'b', '@小助手 这个怎么看');
  await f.auto.collect();
  f.advance(10000);
  await f.auto.process();
  assert.equal(f.prompts.length, 1);
  assert.equal(f.auto.batches.state({ session: 'room@chatroom' } as any).paused, 0);
  assert.match(JSON.stringify(f.prompts[0].content), /我们继续聊/);
  assert.equal(f.auto.batches.state({ session: 'other@chatroom' } as any).paused, 0);
});

test('closing-only batches and explicit messages to other members skip the model but stay in context', async (t) => {
  const f = debounced(t);
  f.push(1, 'a', '哈哈哈');
  f.push(2, 'b', '好的');
  await f.auto.collect();
  f.advance(10000);
  await f.auto.process();
  assert.equal(f.prompts.length, 0);
  f.push(3, 'a', '@乙 帮我看看');
  await f.auto.collect();
  f.advance(10000);
  await f.auto.process();
  assert.equal(f.prompts.length, 0);
  f.push(4, 'b', '@小助手 前面在聊什么');
  await f.auto.collect();
  f.advance(10000);
  await f.auto.process();
  assert.equal(f.prompts.length, 1);
  assert.match(JSON.stringify(f.prompts[0].content), /@乙 帮我看看/);
});

test('a supplement arriving during UI preparation discards only the owned draft and never clicks send', async (t) => {
  const f = debounced(t);
  let discarded = 0;
  let clicked = 0;
  f.auto.cua.prepare = async () => {
    f.push(2, 'a', '等等，换成上周');
    const commit: any = async () => {
      clicked++;
      return { confirmed: true };
    };
    commit.discard = async () => {
      discarded++;
    };
    return commit;
  };
  f.push(1, 'a', '给我查询结果');
  await f.auto.collect();
  f.advance(10000);
  await f.auto.process();
  const old = f.auto.jobs()[0];
  f.done(f.bridge.run(old.event.dshRunId)!);
  await f.auto.process();
  assert.equal(clicked, 0);
  assert.equal(discarded, 1);
  assert.equal(f.auto.job(old.id).status, 'superseded');
});

test('batch parent and source links survive reconstructing the coordinator', async (t) => {
  const { ChatBatches } = await import('../src/batch.js');
  const f = debounced(t);
  f.push(1, 'a', '上半句');
  f.push(2, 'a', '下半句');
  await f.auto.collect();
  f.advance(10000);
  const grouped = (await f.auto.batches.prepare(f.auto.jobs().at(-1) as any, signal()))!;
  f.auto.batches = new ChatBatches(f.auto as any);
  const restored = (await f.auto.batches.prepare(f.auto.job(grouped.id) as any, signal()))!;
  assert.equal(restored.event.batch!.messages.length, 2);
  assert.equal(f.auto.jobs().filter((j) => j.status === 'batched').length, 1);
});

test('ignore output may omit text but malformed send decisions still fail closed', () => {
  assert.equal(nativeReply('{"action":"ignore","reason":"别人互聊"}', 'text').text, '');
  assert.throws(() => nativeReply('{"action":"reply"}', 'text'));
});

test('unrelated group chatter does not keep superseding a ready answer', async (t) => {
  const f = debounced(t);
  f.push(1, 'a', '@小助手 查一下结果');
  await f.auto.collect();
  f.advance(10000);
  await f.auto.process();
  const old = f.auto.jobs()[0];
  f.push(2, 'b', '@丙 我们几点出发');
  await f.auto.collect();
  f.done(f.bridge.run(old.event.dshRunId)!);
  await f.auto.process();
  assert.equal(f.auto.job(old.id).status, 'sent');
  assert.equal(f.sent.length, 1);
});

test('closing and pause controls still work with legacy hourly settings', async (t) => {
  const f = debounced(t);
  const cfg = f.auto.settings();
  f.auto.save({ ...cfg.policy, maxPerHour: 1 }, cfg.revision);
  f.store.db.prepare('INSERT INTO automation_attempts(job_id,at) VALUES (?,?)').run(0, Date.now());
  f.push(1, 'a', '谢谢');
  await f.auto.collect();
  f.advance(10000);
  await f.auto.process();
  assert.equal(f.auto.jobs()[0].status, 'ignored');
  f.push(2, 'owner', '先别说了');
  await f.auto.collect();
  f.advance(10000);
  await f.auto.process();
  assert.equal(f.auto.batches.state({ session: 'room@chatroom' } as any).paused, 1);
  assert.equal(f.prompts.length, 0);
});

test('images count toward the same ten-message trigger without an earlier four-image split', async (t) => {
  const f = debounced(t);
  f.ctx.llm.resolveModelInfo = async () => ({ inputModalities: ['text', 'image'] });
  f.bridge.images = { part: (e) => ({ type: 'image', data: 'image-' + e.id, mediaType: 'image/png' }) };
  f.auto.enrich = async (e) => ({
    ...e,
    ...(e.local_type === 3 ? { image: { status: 'read', hash: 'hash-' + e.id } } : {}),
  });
  for (let id = 1; id <= 9; id++) {
    f.push(id, 'a', id <= 5 ? '[图片]' : '说明' + id, 'room@chatroom', { local_type: id <= 5 ? 3 : 1 });
  }
  await f.auto.collect();
  await f.auto.process();
  assert.equal(f.prompts.length, 0);
  f.push(10, 'a', '最后一句');
  await f.auto.collect();
  await f.auto.process();
  assert.equal(f.prompts.length, 1);
  assert.equal(f.prompts[0].content.filter((x: { type: string }) => x.type === 'image').length, 5);
  assert.match(JSON.stringify(f.prompts[0].content), /最后一句/);
});

function nativeMentions(f: ReturnType<typeof debounced>) {
  f.auto.identify = async (e) => ({
    ...e,
    botNames: ['小助手'],
    senderIdentity: {
      id: e.senderId,
      nickname: e.senderId,
      groupNickname: '',
      uiName: e.senderId,
      uniqueUiName: true,
    },
    mentions: {
      status: 'verified',
      sourceKey: e.sourceKey,
      recipients: e.text.startsWith('@小助手') ? ['wxid_me'] : [],
      toSelf: e.text.startsWith('@小助手'),
      quoteUnique: true,
    },
  });
}

test('actual delivery keeps batch provenance but mentions and quotes the original addressed sender', async (t) => {
  const f = debounced(t);
  nativeMentions(f);
  f.push(1, 'a', '@小助手 这个结果如何');
  f.push(2, 'b', '我们另一边继续聊');
  await f.auto.collect();
  f.advance(10000);
  await f.auto.process();
  const j = f.auto.jobs().find((job) => job.status === 'agent_running')!;
  f.done(f.bridge.run(j.event.dshRunId)!);
  await f.auto.process();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].event.id, 2);
  assert.equal(f.sent[0].quoteEvent.id, 1);
  assert.equal(f.sent[0].mention.id, 'a');
  assert.equal(f.auto.job(j.id).event.deliveryReplyTarget.sourceKey, 'key-1');
});

test('supersession persists and carries original native mention through the next run', async (t) => {
  const f = debounced(t);
  nativeMentions(f);
  f.push(1, 'a', '@小助手 查询最新结果');
  await f.auto.collect();
  f.advance(10000);
  await f.auto.process();
  const old = f.auto.jobs()[0];
  f.push(2, 'a', '按季度比较');
  await f.auto.collect();
  f.done(f.bridge.run(old.event.dshRunId)!);
  await f.auto.process();
  assert.equal(f.sent.length, 0);
  assert.equal(JSON.parse(f.auto.batches.state(old.event as any).reply_context as string)[0].id, 1);
  f.advance(10000);
  await f.auto.process();
  const next = f.auto.jobs().find((job) => job.status === 'agent_running')!;
  assert.equal(next.event.batch.replyContext[0].id, 1);
  assert.match(JSON.stringify(f.prompts[1].content), /message:1/);
  f.done(f.bridge.run(next.event.dshRunId)!);
  await f.auto.process();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].quoteEvent.id, 1);
  assert.equal(f.sent[0].event.id, 2);
});

test('configured twenty-message cap fires immediately while every arrival resets twenty-second silence', async (t) => {
  const f = debounced(t);
  const cfg = f.auto.settings();
  f.auto.save({ ...cfg.policy, debounceMs: 20000, debounceMaxMessages: 20 }, cfg.revision);
  f.push(1, 'a', '第一条');
  await f.auto.collect();
  f.advance(19000);
  f.push(2, 'b', '第二条');
  await f.auto.collect();
  f.advance(19999);
  await f.auto.process();
  assert.equal(f.prompts.length, 0);
  for (let id = 3; id <= 20; id++) {
    f.push(id, 'a', '补充' + id);
  }
  await f.auto.collect();
  await f.auto.process();
  assert.equal(f.prompts.length, 1);
  assert.equal(f.auto.jobs().find((j) => j.status === 'agent_running')!.event.batch.messages.length, 20);
});

test('explicit retry of pre-input quote failure reuses the ready reply and sends at most once', async (t) => {
  const f = setup(t);
  f.append(1);
  await f.auto.collect();
  await f.auto.process();
  const j = f.auto.jobs()[0];
  f.done(f.bridge.run(j.event.dshRunId)!);
  const prepare = f.auto.cua.prepare;
  f.auto.cua.prepare = async () => {
    throw Error('无法确定原消息气泡中的文字位置');
  };
  await f.auto.process();
  assert.equal(f.auto.job(j.id).status, 'failed');
  f.auto.cua.prepare = prepare;
  f.auto.archiveHistory = () => [];
  await f.auto.sendDraft(j.id);
  assert.equal(f.auto.job(j.id).status, 'sent');
  assert.equal(f.prompts.length, 1);
  assert.equal(f.sent.length, 1);
  await assert.rejects(f.auto.sendDraft(j.id));
  assert.equal(f.sent.length, 1);
});

test('quote retry cannot resend uncertain delivery or a model result taken over by the owner', async (t) => {
  const f = setup(t);
  f.append(1);
  await f.auto.collect();
  await f.auto.process();
  const j = f.auto.jobs()[0];
  const run = f.bridge.run(j.event.dshRunId)!;
  f.done(run);
  f.auto.state(j.id, 'uncertain', '无法确定原消息气泡中的文字位置', {
    action: 'reply',
    text: '保留结果',
  });
  await assert.rejects(f.auto.sendDraft(j.id));
  f.auto.state(j.id, 'failed', '无法确定原消息气泡中的文字位置');
  f.bridge.update(run.id, { status: 'manual' });
  await assert.rejects(f.auto.sendDraft(j.id));
  assert.equal(f.sent.length, 0);
  assert.equal(f.prompts.length, 1);
});

test('multiple native mentions skip quotation in delivery but retain the selected member', async (t) => {
  const f = debounced(t);
  nativeMentions(f);
  const identify = f.auto.identify;
  f.auto.identify = async (e) => {
    const r = await identify(e);
    r.mentions.quoteUnique = false;
    return r;
  };
  f.push(1, 'a', '@小助手 项目能否延期');
  f.push(2, 'b', '@小助手 先说依赖项');
  f.push(3, 'b', '顺便解释风险');
  await f.auto.collect();
  f.advance(10000);
  await f.auto.process();
  const j = f.auto.jobs().find((job) => job.status === 'agent_running')!;
  const input = (f.prompts[0].content as Array<{ text?: string }>).map((c) => c.text || '').join('');
  const system = f.bridge.prompt(j.event.dshSessionId);
  for (const text of ['@小助手 项目能否延期', '@小助手 先说依赖项', '顺便解释风险']) {
    assert.equal(input.split(text).length - 1, 1);
    assert.ok(!system.includes(text));
  }
  assert.ok(!input.includes('text 只写回复正文'));
  assert.match(system, /同一轮有多条原生 @ 消息时，不引用/);
  assert.equal(input.split('[b](b#b)').length - 1, 1);
  f.done(
    f.bridge.run(j.event.dshRunId)!,
    '{"action":"reply","text":"依赖准备好后再确认日期。","replyTo":"message:1"}',
  );
  await f.auto.process();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].mention.id, 'a');
  assert.equal(f.sent[0].decision.replyTo, undefined);
  assert.equal(f.auto.job(j.id).event.deliveryReplyTarget.quote, false);
  assert.equal(f.auto.job(j.id).status, 'sent');
});

test('duplicate quote source degrades safely by dropping replyTo while preserving native mention and reply text', async (t) => {
  const f = debounced(t);
  nativeMentions(f);
  const identify = f.auto.identify;
  f.auto.identify = async (e) => {
    const r = await identify(e);
    r.mentions.quoteUnique = false;
    return r;
  };
  f.push(1, 'a', '@小助手 收到请回复');
  await f.auto.collect();
  f.advance(10000);
  await f.auto.process();
  const j = f.auto.jobs().find((job) => job.status === 'agent_running')!;
  f.done(
    f.bridge.run(j.event.dshRunId)!,
    '{"action":"reply","text":"好的，马上安排。","replyTo":"message:1"}',
  );
  await f.auto.process();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].mention.id, 'a');
  assert.equal(f.sent[0].decision.text, '好的，马上安排。');
  assert.equal(f.sent[0].decision.replyTo, undefined);
  assert.equal(f.sent[0].deliveryDetail, '原文在本会话重复，已取消引用并直接回复');
  assert.equal(f.auto.job(j.id).event.deliveryReplyTarget.quote, false);
  assert.equal(f.auto.job(j.id).status, 'sent');
  assert.match(f.auto.job(j.id).detail, /原文在本会话重复，已取消引用并直接回复/);
});

test('single unbatched mention receives compact numbering and fixed rules only in system prompt', async (t) => {
  const f = setup(t);
  const e = {
    ...f.event('room@chatroom'),
    local_type: 1,
    senderId: 'member',
    sourceKey: 'stable',
    mentions: { status: 'verified', sourceKey: 'stable', toSelf: true, recipients: ['wxid_me'] },
    text: '@小助手 找一下资料',
  };
  const r = await f.start(e);
  const input = f.prompts[0].content[0].text;
  const system = f.bridge.prompt(r.session_id);
  assert.equal(input.split(e.text).length - 1, 1);
  assert.match(input, /\[message:1\]/);
  assert.ok(!system.includes(e.text));
  assert.ok(!input.includes('程序将为回复'));
  assert.match(system, /只有一条原生 @ 消息时/);
});

test('reply arrays send distinct bubbles in order with durable per-part intent', async (t) => {
  const f = setup(t);
  f.append(1);
  await f.auto.collect();
  await f.auto.process();
  const j = f.auto.jobs()[0];
  const committed: string[] = [];
  f.auto.cua.prepare = async (job: Record<string, any>) => async () => {
    const rows = f.auto.deliveryParts(j.id);
    assert.equal(rows.at(-1)!.status, 'sending');
    assert.equal(rows.at(-1)!.text, job.decision.text);
    committed.push(job.decision.text);
    return { confirmed: true };
  };
  f.done(
    f.bridge.run(j.event.dshRunId)!,
    JSON.stringify({ action: 'reply', text: ['可以', '明天确认时间', '到时见'] }),
  );
  await f.auto.process();
  assert.deepEqual(committed, ['可以', '明天确认时间', '到时见']);
  assert.equal(f.auto.job(j.id).status, 'sent');
  assert.deepEqual(
    f.auto.deliveryParts(j.id).map((p) => p.status),
    ['sent', 'sent', 'sent'],
  );
  await f.auto.process();
  assert.equal(committed.length, 3);
  await assert.rejects(f.auto.sendDraft(j.id));
});

test('array continuation failure stops remaining messages and does not replay sent prefix', async (t) => {
  const f = setup(t);
  f.append(1);
  await f.auto.collect();
  await f.auto.process();
  const j = f.auto.jobs()[0];
  let prepared = 0;
  let committed = 0;
  f.auto.cua.prepare = async () => {
    if (++prepared === 2) {
      throw Error('目标会话中已有草稿');
    }
    return async () => {
      committed++;
      return { confirmed: true };
    };
  };
  f.done(
    f.bridge.run(j.event.dshRunId)!,
    JSON.stringify({ action: 'reply', text: ['第一段已准备', '第二段', '第三段'] }),
  );
  await f.auto.process();
  assert.equal(committed, 1);
  assert.equal(prepared, 2);
  assert.equal(f.auto.job(j.id).status, 'partial');
  assert.equal(f.auto.deliveryParts(j.id)[0].status, 'sent');
  await f.auto.process();
  assert.equal(committed, 1);
  await assert.rejects(f.auto.sendDraft(j.id));
});

test('uncertain second bubble is recorded separately and never retried', async (t) => {
  const f = setup(t);
  f.append(1);
  await f.auto.collect();
  await f.auto.process();
  const j = f.auto.jobs()[0];
  let count = 0;
  f.auto.cua.prepare = async () => async () => ({ confirmed: ++count === 1 });
  f.done(
    f.bridge.run(j.event.dshRunId)!,
    JSON.stringify({ action: 'reply', text: ['前半句', '未确认的后半句', '不应发送'] }),
  );
  await f.auto.process();
  assert.equal(count, 2);
  assert.equal(f.auto.job(j.id).status, 'uncertain');
  assert.deepEqual(
    f.auto.deliveryParts(j.id).map((p) => p.status),
    ['sent', 'uncertain'],
  );
  await f.auto.process();
  assert.equal(count, 2);
  await assert.rejects(f.auto.sendDraft(j.id));
});

test('array adds verified mention and quote only on the first bubble', async (t) => {
  const f = debounced(t);
  nativeMentions(f);
  f.push(1, 'a', '@小助手 下午能过来吗');
  await f.auto.collect();
  f.advance(10000);
  await f.auto.process();
  const j = f.auto.jobs()[0];
  f.done(f.bridge.run(j.event.dshRunId)!, JSON.stringify({ action: 'reply', text: ['可以过去', '大约三点'] }));
  await f.auto.process();
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[0].mention.id, 'a');
  assert.equal(f.sent[0].decision.replyTo, 'current');
  assert.equal(f.sent[1].mention, undefined);
  assert.equal(f.sent[1].decision.replyTo, undefined);
});

test('new supplemental message after first bubble stops the tail and records what was actually sent', async (t) => {
  const f = debounced(t);
  f.push(1, 'a', '能说下进度吗');
  await f.auto.collect();
  f.advance(10000);
  await f.auto.process();
  const j = f.auto.jobs()[0];
  let count = 0;
  f.auto.cua.prepare = async () => async () => {
    count++;
    f.push(2, 'a', '只要最终结果');
    return { confirmed: true };
  };
  f.done(
    f.bridge.run(j.event.dshRunId)!,
    JSON.stringify({ action: 'reply', text: ['第一步已经完成', '接下来说明过程'] }),
  );
  await f.auto.process();
  assert.equal(count, 1);
  assert.equal(f.auto.job(j.id).status, 'partial');
  const notice = f.auto.batches.state(j.event as any).notice as string;
  assert.match(notice, /第一步已经完成/);
  assert.ok(!notice.includes('上一轮生成的回复没有发送'));
});

test('array parsing preserves explicit bubble boundaries and rejects invalid arrays', () => {
  assert.deepEqual(nativeReply('{"action":"reply","text":["  一  ","二\\n三"]}', 'text').text, [
    '一',
    '二\n三',
  ]);
  assert.equal(nativeReply('{"action":"reply","text":"一\\n二"}', 'text').text, '一\n二');
  for (const text of [[], [''], ['a', 3], Array(6).fill('a'), ['a'.repeat(1500), 'b']]) {
    assert.throws(() => nativeReply(JSON.stringify({ action: 'reply', text }), 'text'));
  }
  for (const action of ['ignore', 'comment', 'sticker']) {
    assert.throws(() =>
      nativeReply(JSON.stringify({ action, text: ['a'] }), action === 'comment' ? 'sns' : 'text'),
    );
  }
});

test('ambiguous displayed member names fall back to quote/reply without native mention', async (t) => {
  const f = debounced(t);
  nativeMentions(f);
  const identify = f.auto.identify;
  f.auto.identify = async (e) => {
    const r = await identify(e);
    r.senderIdentity.uniqueUiName = false;
    return r;
  };
  f.push(1, 'a', '@小助手 说一下安排');
  await f.auto.collect();
  f.advance(10000);
  await f.auto.process();
  const j = f.auto.jobs()[0];
  let capturedJob: Record<string, unknown> | null = null;
  f.auto.cua.prepare = async (prepJob: unknown) => {
    const rec = prepJob as Record<string, unknown>;
    capturedJob = rec;
    return Object.assign(async () => ({ confirmed: true }), {
      deliveryDetail: typeof rec.deliveryDetail === 'string' ? rec.deliveryDetail : '',
    });
  };
  f.done(f.bridge.run(j.event.dshRunId)!);
  await f.auto.process();
  assert.ok(capturedJob);
  assert.equal((capturedJob as { mention?: unknown }).mention, null);
  assert.equal(f.auto.job(j.id).status, 'sent');
  assert.match(f.auto.job(j.id).detail, /群内存在重名显示名，已取消原生 @/);
});

test('cancellation after first array bubble stops the remaining bubbles', async (t) => {
  const f = debounced(t);
  f.push(1, 'a', '帮我说明一下');
  await f.auto.collect();
  f.advance(10000);
  await f.auto.process();
  const j = f.auto.jobs()[0];
  let count = 0;
  f.auto.cua.prepare = async () => async () => {
    count++;
    f.push(2, 'a', '算了不用了');
    return { confirmed: true };
  };
  f.done(
    f.bridge.run(j.event.dshRunId)!,
    JSON.stringify({ action: 'reply', text: ['收到', '进一步说明'] }),
  );
  await f.auto.process();
  assert.equal(count, 1);
  assert.equal(f.auto.job(j.id).status, 'partial');
  assert.equal(f.auto.batches.state(j.event as any).pending_reply, 0);
});

test('task grants skip only plugin prompts, retain native restrictions and end with the run', async (t) => {
  const { WechatApprovals } = await import('../src/approvals.js');
  const f = setup(t);
  const cfg = f.auto.settings();
  f.auto.save({ ...cfg.policy, controllerId: 'owner' }, cfg.revision);
  const broker = new WechatApprovals(f.store, () => f.auto.settings(), async () => 'unavailable');
  f.bridge.approvals = broker;
  t.after(() => broker.close());
  const r = await f.start(f.event('group@chatroom'));
  const agent = f.agents.get(r.session_id);
  const gate = f.hooks['tools/pre-execute'];
  const exec = { agent, callId: 'first', name: 'bash', arguments: { command: 'ls /Applications' } };
  assert.equal((await gate(exec, async () => ({ kind: 'allow' }))).kind, 'ask');
  const pending = broker.request(
    { agent, callId: exec.callId, signal: signal() },
    async () => 'unavailable',
    r,
  );
  const row = broker.notices()[0];
  assert.equal(row.task_eligible, 1);
  broker.decide(row.code, 'allowed-task');
  await pending;
  const later = { ...exec, callId: 'next', arguments: { command: 'pwd' } };
  assert.equal((await gate(later, async () => ({ kind: 'allow' }))).kind, 'allow');
  assert.equal((await gate({ ...later, callId: 'denied' }, async () => ({ kind: 'deny' }))).kind, 'deny');
  assert.equal((await gate({ ...later, callId: 'native-ask' }, async () => ({ kind: 'ask' }))).kind, 'ask');
  for (const command of ['rm -f temp', 'brew install x', 'defaults write domain key value']) {
    assert.equal(
      (await gate({ ...later, callId: command, arguments: { command } }, async () => ({ kind: 'allow' })))
        .kind,
      'ask',
    );
  }
  f.done(r);
  assert.equal(broker.grants.has(r.id), false);
  const next = await f.start(f.event('group@chatroom'));
  assert.equal(
    (
      await gate(
        { ...later, agent: f.agents.get(next.session_id), callId: 'new-round' },
        async () => ({ kind: 'allow' }),
      )
    ).kind,
    'ask',
  );
});

test('verified admin gets full access only in private chat and reuses the ordinary group session', async (t) => {
  const f = setup(t);
  const admin = 'wxid_member_one';
  const other = 'wxid_other';
  const proof = 'a'.repeat(64);
  const knobs = new Map<unknown, string>();
  f.ctx.permissionPresets.set = (s: unknown, mode: string) => knobs.set(s, mode);
  const e = (session: string, senderId: string) => ({
    ...f.event(session),
    sourceKey: proof,
    senderId,
  });
  const priv = await f.start(e(admin, admin));
  f.done(priv);
  const room = 'wxgrp@chatroom';
  const group = await f.start(e(room, other));
  f.done(group);
  const save = (ids: string[]) => {
    const cfg = f.auto.settings();
    f.auto.save({ ...cfg.policy, adminIds: ids }, cfg.revision);
  };
  save([admin]);
  const a = f.agents.get(priv.session_id);
  assert.equal(knobs.get(a.session), 'danger-full-access');
  const isolated = await f.start(e(room, admin));
  const g = f.agents.get(isolated.session_id);
  assert.equal(isolated.session_id, group.session_id);
  assert.equal(knobs.get(g.session), 'workspace-write');
  const call = (name: string, command: string, kind = 'allow') =>
    f.hooks['tools/pre-execute']({ agent: g, name, arguments: { command } }, async () => ({ kind }));
  assert.equal((await call('bash', 'pwd')).kind, 'ask');
  assert.equal((await call('bash', 'rm x')).kind, 'ask');
  assert.equal((await call('bash', 'pwd', 'deny')).kind, 'deny');
  f.done(isolated);
  const mixed = await f.start({ ...e(room, admin), batch: { messages: [e(room, other), e(room, admin)] } });
  assert.equal(mixed.session_id, group.session_id);
  f.done(mixed);
  save([]);
  assert.equal(knobs.get(g.session), 'workspace-write');
  assert.equal(knobs.get(a.session), 'workspace-write');
});

test('nickname, quote and group background cannot grant admin', async () => {
  const { adminPrincipal, workspaceKey } = await import('../src/admin.js');
  const p = { ownId: 'bot', adminIds: ['wxid_abc'] };
  const m = { kind: 'text', session: 'r@chatroom', sourceKey: 'f'.repeat(64), senderId: 'wxid_abc' };
  const other = { ...m, senderId: 'other', sender: 'wxid_abc' };
  for (const e of [
    other,
    { ...m, sourceKey: '' },
    { ...m, kind: 'sns' },
    { ...m, batch: { messages: [m], replyContext: [other] } },
    { ...m, batch: { messages: [m], background: [other] } },
  ]) {
    assert.equal(adminPrincipal(e, p), null);
  }
  assert.equal(adminPrincipal(m, p), null);
  assert.equal(workspaceKey(m, p), workspaceKey(other, p));
  const verified = { ...m, session: m.senderId };
  assert.equal(adminPrincipal(verified, p), m.senderId);
  assert.equal(adminPrincipal({ ...verified, sourceKey: '' }, p), null);
  assert.notEqual(workspaceKey(verified, p), workspaceKey({ ...verified, sourceKey: '' }, p));
});

test('idle next-step context admits a new WeChat turn, but never jumps a user or pending approval', async (t) => {
  const f = setup(t);
  const r = await f.start();
  f.done(r);
  const state: { running: boolean; queue: Array<Record<string, any>>; pendingInput: string[] } = {
    running: false,
    queue: [{ placement: 'context' }],
    pendingInput: [],
  };
  f.ctx.sessionController.state = async () => state;
  for (const extra of [{ placement: 'queued' }, { placement: 'steering' }, {}]) {
    state.queue.push(extra);
    await assert.rejects(f.start(), (e: Error & { code?: string }) => e.code === 'WXARC_BUSY');
    state.queue.pop();
  }
  state.pendingInput.push('approval');
  await assert.rejects(f.start(), (e: Error & { code?: string }) => e.code === 'WXARC_BUSY');
  state.pendingInput.pop();
  const run = await f.start();
  assert.equal(run.session_id, r.session_id);
  assert.equal(f.prompts.length, 2);
  assert.deepEqual(state.queue, [{ placement: 'context' }]);
});

test('protected admin operation reaches owner chat through the native hook, exactly once', async (t) => {
  const { WechatApprovals } = await import('../src/approvals.js');
  const f = setup(t);
  const cfg = f.auto.settings();
  const owner = 'wxid_manager';
  f.auto.save({ ...cfg.policy, controllerId: owner, adminIds: [owner] }, cfg.revision);
  const broker = (f.bridge.approvals = f.auto.approvals = new WechatApprovals(
    f.store,
    () => f.auto.settings(),
  ));
  t.after(() => broker.close());
  f.append(1, owner);
  f.auto.resolveSource = (_h, e) => ({
    ...e,
    senderId: owner,
    sourceKey: 'a'.repeat(64),
    account: '/data/wxid_me_abcd/db_storage',
  });
  await f.auto.collect();
  await f.auto.process();
  const job = f.auto.jobs()[0];
  const agent = f.agents.get(job.event.dshSessionId);
  const exec = {
    agent,
    callId: 'admin-op',
    name: 'bash',
    arguments: { command: 'pkill -x ExampleApp' },
  };
  const gate = await f.hooks['tools/pre-execute'](exec, async () => ({ kind: 'allow' }));
  assert.equal(gate.kind, 'ask');
  assert.match(gate.reason, /管理员/);
  const abort = new AbortController();
  const pending = f.hooks['approval/request'](
    { agent, callId: exec.callId, toolName: 'bash', signal: abort.signal },
    async () => 'unavailable',
  );
  await f.auto.sendApprovalNotices(signal());
  await f.auto.sendApprovalNotices(signal());
  assert.equal(f.sent.length, 1);
  const row = f.store.db.prepare('SELECT * FROM wechat_approvals').get() as {
    owner_id: string;
    notice_status: string;
    task_eligible: number;
    code: string;
  };
  assert.equal(row.owner_id, owner);
  assert.equal(row.notice_status, 'sent');
  assert.equal(row.task_eligible, 0);
  assert.match(f.sent[0].decision.text, /pkill -x ExampleApp/);
  assert.throws(() => broker.decide(row.code, 'allowed-task'));
  abort.abort();
  assert.equal(await pending, 'cancelled');
});

async function blockedReply(t: TestContext, parts?: string[]) {
  const f = setup(t);
  let clock = Date.now();
  let archive: Array<Record<string, any>> = [];
  f.auto.now = () => clock;
  f.auto.archiveHistory = () => archive as any;
  f.append(1);
  await f.auto.collect();
  await f.auto.process();
  const job = f.auto.jobs()[0];
  f.done(f.bridge.run(job.event.dshRunId)!, JSON.stringify({ action: 'reply', text: parts || '做好了' }));
  const prepare = f.auto.cua.prepare;
  const { OBSTRUCTED } = await import('../src/resend.js');
  f.auto.cua.prepare = async (j: Record<string, any>) => {
    if (parts && j.decision.text === parts[0]) {
      return prepare(j);
    }
    throw Error(OBSTRUCTED);
  };
  await f.auto.process();
  assert.equal(f.auto.job(job.id).status, 'retry_wait');
  f.auto.cua.prepare = prepare;
  return {
    ...f,
    job,
    setRows: (rows: Array<Record<string, any>>) => {
      archive = rows;
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

test('fresh blocked reply checks wxarc before retry and only clicks once', async (t) => {
  const f = await blockedReply(t);
  await f.auto.process();
  assert.equal(f.sent.length, 0);
  f.advance(5100);
  await f.auto.process();
  await f.auto.process();
  assert.equal(f.auto.job(f.job.id).status, 'sent');
  assert.equal(f.sent.length, 1);
  assert.equal(f.prompts.length, 1);
});

test('outgoing archived reply suppresses resend and records the wxarc message id', async (t) => {
  const f = await blockedReply(t);
  f.setRows([{ id: 83, sender: 'wxid_me', ts: f.job.event.ts + 1, local_type: 1, text: '做好了' }]);
  f.advance(6000);
  await f.auto.process();
  assert.equal(f.auto.job(f.job.id).status, 'sent');
  assert.match(f.auto.job(f.job.id).detail, /83/);
  assert.equal(f.sent.length, 0);
});

test('new peer activity and expired replies stop without a send', async (t) => {
  for (const stale of [true, false]) {
    const f = await blockedReply(t);
    f.setRows([{ id: 84, sender: 'peer', ts: f.job.event.ts + 1, local_type: 1, text: '做好了' }]);
    f.advance(stale ? 301000 : 6000);
    await f.auto.process();
    assert.equal(f.auto.job(f.job.id).status, stale ? 'expired' : 'failed');
    assert.equal(f.sent.length, 0);
  }
});

test('uncertain click is reconciled from wxarc without a second click', async (t) => {
  const f = setup(t);
  let clock = Date.now();
  let clicks = 0;
  let rows: Array<Record<string, any>> = [];
  f.auto.now = () => clock;
  f.auto.archiveHistory = () => rows as any;
  f.auto.cua.prepare = async () => async () => {
    clicks++;
    return { confirmed: false };
  };
  f.append(1);
  await f.auto.collect();
  await f.auto.process();
  const j = f.auto.jobs()[0];
  f.done(f.bridge.run(j.event.dshRunId)!);
  await f.auto.process();
  assert.equal(f.auto.job(j.id).status, 'uncertain');
  clock += 6000;
  await f.auto.process();
  assert.equal(f.auto.job(j.id).status, 'uncertain');
  rows = [{ id: 92, sender: 'wxid_me', ts: Math.floor(clock / 1000), local_type: 1, text: '做好了' }];
  clock += 6000;
  await f.auto.process();
  assert.equal(f.auto.job(j.id).status, 'sent');
  assert.equal(clicks, 1);
  assert.equal(f.prompts.length, 1);
});

test('multipart resend verifies the prefix in wxarc and only sends the missing part', async (t) => {
  const f = await blockedReply(t, ['甲', '乙']);
  assert.equal(f.sent.length, 1);
  f.setRows([{ id: 79, sender: 'wxid_me', ts: f.job.event.ts + 1, local_type: 1, text: '甲' }]);
  f.advance(6000);
  await f.auto.process();
  assert.equal(f.auto.job(f.job.id).status, 'sent');
  assert.deepEqual(
    f.sent.map((j) => j.decision.text),
    ['甲', '乙'],
  );
});

test('a newly archived reply while preparing aborts the pending click', async (t) => {
  const f = await blockedReply(t);
  let discarded = false;
  f.auto.cua.prepare = async () => {
    f.setRows([{ id: 999, sender: 'wxid_me', ts: f.job.event.ts + 1, local_type: 1, text: '做好了' }]);
    return Object.assign(async () => assert.fail('unexpected click'), {
      discard: async () => {
        discarded = true;
      },
    });
  };
  f.advance(6000);
  await f.auto.process();
  assert.equal(discarded, true);
  assert.equal(f.sent.length, 0);
});
