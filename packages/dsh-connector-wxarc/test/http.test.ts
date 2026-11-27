import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { allowed, apply } from '../src/index.js';

test('browser trust fence accepts same origin, rejects foreign Origin, Host and fetch metadata', () => {
  const req = (headers: Record<string, string | undefined>) => ({ headers });
  assert.equal(allowed(req({ host: '127.0.0.1:3080' }), 3080), true);
  assert.equal(
    allowed(req({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }), 3080),
    true,
  );
  assert.equal(allowed(req({ host: 'evil.test:3080' }), 3080), false);
  assert.equal(allowed(req({ host: '127.0.0.1:3080', origin: 'http://evil.test' }), 3080), false);
  assert.equal(
    allowed(req({ host: '127.0.0.1:3080', 'sec-fetch-site': 'same-site' }), 3080),
    false,
  );
});

test('mounted plugin exposes read-only HTTP and tools, reports unavailable source, disposes cleanly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wxarc-http-'));
  const disposers: Array<() => unknown> = [];
  const definitions: Array<Record<string, any>> = [];
  let handler!: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const ctx = {
    on: () => () => {},
    systemPrompt: { section: () => () => {} },
    agents: { get: () => undefined },
    connection: {
      requestRejection: (req: IncomingMessage) =>
        req.headers.cookie === 'test-auth=yes' ? undefined : 401,
    },
    webServer: {
      host: '127.0.0.1',
      port,
      register: (route: { handler: typeof handler }) => {
        handler = route.handler;
        return () => {};
      },
    },
    effect: (fn: () => () => unknown) => disposers.push(fn()),
    inject: (_keys: string[], fn: (child: any) => void) =>
      fn({
        effect: (effectFn: () => () => unknown) => disposers.push(effectFn()),
        tools: {
          register: (tool: Record<string, any>) => {
            definitions.push(tool);
            return () => {};
          },
        },
      }),
    logger: { info() {} },
  };
  try {
    apply(ctx, { stateDir: dir, url: 'http://127.0.0.1:1', pollMs: 3000, retain: 1000 });
    const get = (path: string, opts: RequestInit = {}) =>
      fetch(`http://127.0.0.1:${port}/wxarc/${path}`, {
        ...opts,
        headers: { Cookie: 'test-auth=yes', ...(opts.headers as Record<string, string>) },
      });
    const status = (await (await get('status')).json()) as { healthy: boolean };
    assert.equal(status.healthy, false);
    assert.equal((await get('events')).status, 200);
    assert.equal((await get('events', { headers: { Cookie: '' } })).status, 401);
    assert.equal((await get('events?limit=-1')).status, 400);
    assert.equal((await get('status', { method: 'POST' })).status, 405);
    assert.equal((await get('status', { headers: { Origin: 'http://evil.test' } })).status, 403);
    assert.equal((await get('missing')).status, 404);
    const people = (await (await get('personas')).json()) as {
      personas: Array<Record<string, any>>;
    };
    assert.equal(people.personas.length, 3);
    assert.equal((await get('personas', { headers: { Cookie: '' } })).status, 401);
    const post = (path: string, value: unknown, method = 'POST') =>
      get(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
      });
    const fiction = people.personas.find((p) => p.id === 'fiction')!;
    assert.equal(
      (await post('personas/fiction', { persona: { ...fiction, character: '' }, revision: 1 }, 'PUT'))
        .status,
      200,
    );
    assert.equal(
      (await post('personas/fiction/activate', { revision: 0, personaRevision: 2 })).status,
      409,
    );
    const original = people.personas.find((p) => p.id === 'original')!;
    assert.equal(
      (
        await post(
          'personas/original',
          { persona: { ...original, name: '测试人物' }, revision: 1 },
          'PUT',
        )
      ).status,
      200,
    );
    assert.equal(
      (await post('personas/original', { persona: original, revision: 1 }, 'PUT')).status,
      409,
    );
    assert.equal(
      (await post('personas/original/activate', { revision: 0, personaRevision: 2 })).status,
      200,
    );
    assert.equal(
      ((await (await get('automation')).json()) as { policy: { personaId: string } }).policy
        .personaId,
      'original',
    );
    assert.equal(
      (await post('personas/original/preview', { text: '测试', kind: 'text', revision: 2 })).status,
      409,
    );
    assert.deepEqual(
      definitions.map((d) => d.name),
      [
        'wxarc_sticker_search',
        'wxarc_status',
        'wxarc_messages',
        'wxarc_targets',
        'wxarc_nas_search',
      ],
    );
    assert.equal(
      (await definitions.find((d) => d.name === 'wxarc_status')!.execute({})).automaticAI,
      false,
    );
    assert.deepEqual(
      (await definitions.find((d) => d.name === 'wxarc_messages')!.execute({})).events,
      [],
    );
    const rendered = definitions
      .find((d) => d.name === 'wxarc_sticker_search')!
      .output.render(
        {},
        {
          ticket: 'test',
          image: {
            attachmentId: 'image-id',
            mediaType: 'image/jpeg',
            bytes: 100,
            width: 424,
            height: 160,
          },
        },
      );
    assert.equal(rendered[1].attachment.attachmentId, 'image-id');
    assert.equal(rendered[1].data, undefined);
  } finally {
    for (const dispose of disposers.reverse()) {
      await dispose();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('/wxarc/automation caches targets by text max_seq and refreshes when new text events arrive', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wxarc-http-targets-'));
  const disposers: Array<() => unknown> = [];
  let handler!: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const ctx = {
    on: () => () => {},
    systemPrompt: { section: () => () => {} },
    agents: { get: () => undefined },
    connection: {
      requestRejection: (req: IncomingMessage) =>
        req.headers.cookie === 'test-auth=yes' ? undefined : 401,
    },
    webServer: {
      host: '127.0.0.1',
      port,
      register: (route: { handler: typeof handler }) => {
        handler = route.handler;
        return () => {};
      },
    },
    effect: (fn: () => () => unknown) => disposers.push(fn()),
    inject: (_keys: string[], fn: (child: any) => void) =>
      fn({
        effect: (effectFn: () => () => unknown) => disposers.push(effectFn()),
        tools: { register: () => () => {} },
      }),
    logger: { info() {} },
  };
  try {
    apply(ctx, { stateDir: dir, url: 'http://127.0.0.1:1', pollMs: 3000, retain: 1000 });
    const getTargets = async () =>
      (
        (await (
          await fetch(`http://127.0.0.1:${port}/wxarc/automation`, {
            headers: { Cookie: 'test-auth=yes' },
          })
        ).json()) as { targets: Array<{ id: string; title: string }> }
      ).targets;
    assert.deepEqual(await getTargets(), []);
    const db = new DatabaseSync(join(dir, 'events.sqlite'));
    try {
      db.prepare("INSERT INTO events(kind,event_id,payload,received_at) VALUES ('text',1,?,?)").run(
        JSON.stringify({
          id: 1,
          kind: 'text',
          session: 'peer1',
          session_name: 'Alice',
          text: 'hi',
          ts: 1000,
        }),
        new Date().toISOString(),
      );
      assert.deepEqual(await getTargets(), [{ id: 'peer1', title: 'Alice' }]);
      db.prepare("UPDATE events SET payload=? WHERE kind='text' AND event_id=1").run(
        JSON.stringify({
          id: 1,
          kind: 'text',
          session: 'peer1',
          session_name: 'Mutated',
          text: 'hi',
          ts: 1000,
        }),
      );
      db.prepare("INSERT INTO events(kind,event_id,payload,received_at) VALUES ('sns',1,?,?)").run(
        JSON.stringify({
          id: 1,
          kind: 'sns',
          user_name: 'author',
          text: 'post',
          ts: 1001,
        }),
        new Date().toISOString(),
      );
      assert.deepEqual(await getTargets(), [{ id: 'peer1', title: 'Alice' }]);
      db.prepare("INSERT INTO events(kind,event_id,payload,received_at) VALUES ('text',2,?,?)").run(
        JSON.stringify({
          id: 2,
          kind: 'text',
          session: 'peer2',
          session_name: 'Bob',
          text: 'yo',
          ts: 1002,
        }),
        new Date().toISOString(),
      );
      const refreshed = (await getTargets()).sort((a, b) => a.id.localeCompare(b.id));
      assert.deepEqual(refreshed, [
        { id: 'peer1', title: 'Mutated' },
        { id: 'peer2', title: 'Bob' },
      ]);
    } finally {
      db.close();
    }
  } finally {
    for (const dispose of disposers.reverse()) {
      await dispose();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
