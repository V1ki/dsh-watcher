import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { WechatApprovals } from '../src/approvals.js';
import type { ApprovalConsumeEventLike, ApprovalRequestLike } from '../src/approvals.js';
import { Store } from '../src/core.js';

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'wxarc-approval-'));
  const store = new Store(dir);
  let forwarded: ApprovalRequestLike | undefined;
  const broker = new WechatApprovals(
    store,
    () => ({ policy: { controllerId: 'owner' } }),
    async (req) => {
      forwarded = req;
      return new Promise(() => {});
    },
  );
  t.after(() => {
    broker.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const abort = new AbortController();
  const agent = { id: 'session' };
  const exec: {
    agent: { id: string };
    callId: string;
    name: string;
    arguments: Record<string, unknown>;
  } = {
    agent,
    callId: 'tool-1',
    name: 'bash',
    arguments: { command: 'remove specified example application' },
  };
  const run = { id: 'run', preview: 0, manual: 0 };
  broker.capture(exec);
  const request = () =>
    broker.request(
      { agent, callId: exec.callId, toolName: exec.name, signal: abort.signal },
      async () => 'unavailable',
      run,
    );
  const answer = (code: string, extra: Partial<ApprovalConsumeEventLike> = {}) =>
    broker.consume({
      kind: 'text',
      session: 'owner',
      senderId: 'owner',
      local_type: 1,
      text: `确认 ${code}`,
      ts: Math.floor(Date.now() / 1000),
      sourceKey: 'verified-incoming',
      ...extra,
    });
  return { broker, store, abort, request, answer, forwarded: () => forwarded, run, exec };
}

test('verified private owner grants only the exact notified live call; UI request is withdrawn', async (t) => {
  const f = setup(t);
  const p = f.request();
  const row = f.broker.notices()[0];
  await Promise.resolve();
  assert.equal(f.answer(row.code), true);
  assert.equal(f.broker.hasPending('run'), true);
  f.broker.notice(row.code, 'sent');
  assert.equal(f.answer(row.code, { senderId: 'other' }), false);
  assert.equal(f.answer(row.code, { session: 'group@chatroom' }), false);
  assert.equal(f.broker.hasPending('run'), true);
  assert.equal(f.answer(row.code), true);
  assert.equal(await p, 'allowed-once');
  assert.equal(f.forwarded()?.signal?.aborted, true);
  assert.equal(f.broker.hasPending('run'), false);
  assert.equal(f.answer(row.code), true);
  assert.equal(
    (f.store.db.prepare('SELECT decision_source FROM wechat_approvals').get() as {
      decision_source: string;
    }).decision_source,
    'verified-incoming',
  );
});

test('old message, expired token, and cancellation never grant approval', async (t) => {
  const f = setup(t);
  const p = f.request();
  const r = f.broker.notices()[0];
  f.broker.notice(r.code, 'sent');
  f.answer(r.code, { ts: 1 });
  assert.equal(f.broker.hasPending('run'), true);
  f.store.db.prepare('UPDATE wechat_approvals SET expires_at=1').run();
  f.answer(r.code);
  assert.throws(() => f.broker.decide(r.code, 'allowed-once'), /失效/);
  f.abort.abort();
  assert.equal(await p, 'cancelled');
});

test('native UI denial wins once and owner cannot later reuse its code', async (t) => {
  const f = setup(t);
  f.broker.forward = async () => 'rejected';
  const p = f.request();
  const r = f.broker.notices()[0];
  assert.equal(await p, 'rejected');
  f.broker.notice(r.code, 'sent');
  f.answer(r.code);
  assert.equal(
    (f.store.db.prepare('SELECT status FROM wechat_approvals').get() as { status: string }).status,
    'rejected',
  );
});

test('settings panel remains a valid one-shot approval entry with the full operation', async (t) => {
  const f = setup(t);
  const p = f.request();
  const r = f.broker.notices()[0];
  assert.match(f.broker.message(r), /remove specified example application/);
  f.broker.decide(r.code, 'allowed-once');
  assert.equal(await p, 'allowed-once');
  assert.throws(() => f.broker.decide(r.code, 'allowed-once'), /失效/);
});

test('preview tasks and credentials stay on native approval, not copied to WeChat', async (t) => {
  const f = setup(t);
  f.run.preview = 1;
  assert.equal(await f.request(), 'unavailable');
  assert.equal(f.broker.notices().length, 0);
  f.run.preview = 0;
  f.broker.capture({
    ...f.exec,
    arguments: { command: 'curl -H Authorization:BearerExample' },
  });
  assert.equal(await f.request(), 'unavailable');
  assert.equal(f.broker.notices().length, 0);
});

test('one exact live invocation can reuse approval across native sandbox layers, but later calls cannot', async (t) => {
  const f = setup(t);
  const first = f.request();
  const row = f.broker.notices()[0];
  f.broker.notice(row.code, 'sent');
  f.answer(row.code);
  assert.equal(await first, 'allowed-once');
  assert.equal(await f.request(), 'allowed-once');
  assert.equal(
    (f.store.db.prepare('SELECT COUNT(*) n FROM wechat_approvals').get() as { n: number }).n,
    1,
  );
  f.broker.release(f.exec);
  f.broker.capture(f.exec);
  const later = f.request();
  assert.equal(f.broker.notices().length, 1);
  f.abort.abort();
  assert.equal(await later, 'cancelled');
});

test('plain confirmation needs one notified live request and cannot replay across calls', async (t) => {
  const f = setup(t);
  const first = f.request();
  const row = f.broker.notices()[0];
  f.answer('', { text: '确认' });
  assert.equal(f.broker.hasPending('run'), true);
  f.broker.notice(row.code, 'sent');
  f.answer('', { text: '确认。' });
  assert.equal(await first, 'allowed-once');
  f.broker.release(f.exec);
  f.exec.callId = 'tool-2';
  f.broker.capture(f.exec);
  const second = f.request();
  const row2 = f.broker.notices()[0];
  f.broker.notice(row2.code, 'sent');
  f.answer('', { text: '确认。' });
  assert.equal(f.broker.hasPending('run'), true);
  f.abort.abort();
  assert.equal(await second, 'cancelled');
});

test('plain confirmation never selects between multiple pending requests', async (t) => {
  const f = setup(t);
  const first = f.request();
  f.exec.callId = 'tool-2';
  f.broker.capture(f.exec);
  const second = f.request();
  for (const row of f.broker.notices()) {
    f.broker.notice(row.code, 'sent');
  }
  assert.equal(f.answer('', { text: '确认' }), true);
  assert.equal(
    (
      f.store.db
        .prepare("SELECT COUNT(*) n FROM wechat_approvals WHERE status='pending'")
        .get() as { n: number }
    ).n,
    2,
  );
  f.abort.abort();
  await Promise.all([first, second]);
});

test('confirmation sent before a delayed notification does not approve', async (t) => {
  const f = setup(t);
  const p = f.request();
  const row = f.broker.notices()[0];
  f.broker.notice(row.code, 'sent');
  f.store.db.prepare('UPDATE wechat_approvals SET notified_at=?').run(Date.now() + 10000);
  f.answer(row.code);
  assert.equal(f.broker.hasPending('run'), true);
  f.abort.abort();
  await p;
});

test('concurrent approval requests for one live invocation share one notice and decision', async (t) => {
  const f = setup(t);
  const a = f.request();
  f.broker.capture(f.exec);
  const b = f.request();
  assert.equal(f.broker.notices().length, 1);
  const row = f.broker.notices()[0];
  f.broker.decide(row.code, 'allowed-once');
  assert.deepEqual(await Promise.all([a, b]), ['allowed-once', 'allowed-once']);
  assert.equal(
    (f.store.db.prepare('SELECT COUNT(*) n FROM wechat_approvals').get() as { n: number }).n,
    1,
  );
});

test('task approval is explicit, audited, scoped to one run and never grants protected operations', async (t) => {
  const f = setup(t);
  f.exec.arguments = { command: 'ls /Applications' };
  f.broker.capture(f.exec);
  f.broker.eligible(f.exec, true);
  const p = f.request();
  const row = f.broker.notices()[0];
  assert.match(f.broker.message(row), /批准本轮任务/);
  f.broker.notice(row.code, 'sent');
  f.answer(row.code, { text: '批准本轮任务' });
  assert.equal(await p, 'allowed-once');
  assert.equal(
    (
      f.store.db.prepare('SELECT status,scope FROM wechat_approvals').get() as {
        status: string;
        scope: string;
      }
    ).status,
    'allowed-task',
  );
  f.broker.release(f.exec);
  f.exec.callId = 'tool-next';
  f.broker.capture(f.exec);
  f.broker.eligible(f.exec, true);
  assert.equal(f.broker.allows(f.exec, f.run), true);
  assert.equal(f.broker.allows(f.exec, { ...f.run, id: 'next-run' }), false);
  assert.equal(f.broker.allows(f.exec, { ...f.run, manual: 1 }), false);
  assert.equal(f.broker.allows(f.exec, { ...f.run, preview: 1 }), false);
  f.broker.eligible(f.exec, false);
  assert.equal(f.broker.allows(f.exec, f.run), false);
  assert.equal(
    (f.store.db.prepare('SELECT COUNT(*) n FROM wechat_task_uses').get() as { n: number }).n,
    1,
  );
  f.broker.eligible(f.exec, true);
  f.broker.revoke(f.run.id);
  assert.equal(f.broker.allows(f.exec, f.run), false);
});

test('one-shot approval never silently becomes a task grant and protected calls reject task approval', async (t) => {
  const f = setup(t);
  const p = f.request();
  const row = f.broker.notices()[0];
  assert.throws(() => f.broker.decide(row.code, 'allowed-task'), /单次/);
  f.broker.notice(row.code, 'sent');
  f.answer(row.code, { text: '批准本轮任务' });
  assert.equal(f.broker.hasPending(f.run.id), true);
  f.answer(row.code, { text: '确认', sourceKey: 'second-answer' });
  assert.equal(await p, 'allowed-once');
  f.exec.callId = 'later';
  f.broker.capture(f.exec);
  f.broker.eligible(f.exec, true);
  assert.equal(f.broker.allows(f.exec, f.run), false);
});

test('task grants expire on revision, owner, caller, time and service restart changes', async (t) => {
  const f = setup(t);
  f.broker.eligible(f.exec, true);
  const p = f.request();
  const row = f.broker.notices()[0];
  f.broker.decide(row.code, 'allowed-task');
  await p;
  const grant = f.broker.grants.get(f.run.id)!;
  assert.equal(f.broker.allows(f.exec, f.run), true);
  f.broker.settings = () => ({ revision: 1, policy: { controllerId: 'owner' } });
  assert.equal(f.broker.allows(f.exec, f.run), false);
  f.broker.settings = () => ({ policy: { controllerId: 'other' } });
  assert.equal(f.broker.allows(f.exec, f.run), false);
  f.broker.settings = () => ({ policy: { controllerId: 'owner' } });
  assert.equal(f.broker.allows({ ...f.exec, agent: { id: 'other' } }, f.run), false);
  grant.expires = 1;
  assert.equal(f.broker.allows(f.exec, f.run), false);
  grant.expires = Date.now() + 10000;
  f.broker.close();
  const restarted = new WechatApprovals(f.store, f.broker.settings);
  t.after(() => restarted.close());
  restarted.capture(f.exec);
  restarted.eligible(f.exec, true);
  assert.equal(restarted.allows(f.exec, f.run), false);
});

test('changed live call arguments cancel old pending confirmation', async (t) => {
  const f = setup(t);
  const p = f.request();
  f.exec.arguments = { command: 'different operation' };
  f.broker.capture(f.exec);
  assert.equal(await p, 'cancelled');
  const newer = f.request();
  assert.equal(f.broker.notices().length, 1);
  f.abort.abort();
  await newer;
});

test('stdin-fed sudo arguments are not mirrored into owner chat', async (t) => {
  const f = setup(t);
  f.broker.capture({
    ...f.exec,
    arguments: { command: "printf '%s' example | /usr/bin/sudo -S true" },
  });
  assert.equal(await f.request(), 'unavailable');
  assert.equal(f.broker.notices().length, 0);
});
