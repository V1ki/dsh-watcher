import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GuardHook } from '../src/contracts.js';
import { WatcherDb, openWatcherDb } from '../src/db.js';
import { DoorGuard, createDoorGuard } from '../src/guard.js';

function findRepoRoot(startDir: string): string {
  let current = startDir;
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(current, 'pnpm-workspace.yaml'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Could not locate repo root from ${startDir}`);
}

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = findRepoRoot(currentDir);

const EXPECTED_TABLES = [
  'circuit_breaker_log',
  'delivery_receipts',
  'entities',
  'entity_edges',
  'inbox_items',
  'memo_seen_urls',
  'memos',
  'owner_lease',
  'persona_memory',
  'personas',
  'proactive_budget',
  'runtime_meta',
  'source_cursors',
  'staged_drafts',
  'thread_subscriptions',
  'workstreams',
];

interface PackageManifest {
  name?: string;
  type?: string;
  main?: string;
  types?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  engines?: { dsh?: string };
  dsh?: {
    manifestVersion?: number;
    bundle?: { patch?: string; platforms?: string[] };
    client?: { inject?: string[] };
  };
}

test('WatcherDb in-memory creates all 15 STRICT tables and wxarc-compatible persona schema', () => {
  const store = openWatcherDb({ inMemory: true });
  try {
    assert.equal(store.inMemory, true);
    assert.deepEqual(store.listTables(), EXPECTED_TABLES);
    assert.equal(store.getMeta('config_revision'), '1');

    const personaCols = (store.db.prepare('PRAGMA table_info(personas)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    assert.deepEqual(personaCols, ['id', 'revision', 'config', 'style', 'style_meta']);

    const memoryCols = (store.db.prepare('PRAGMA table_info(persona_memory)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    assert.deepEqual(memoryCols, [
      'id',
      'persona_id',
      'scope',
      'event_seq',
      'note',
      'quote',
      'at',
      'source_key',
      'category',
      'metadata',
    ]);

    const indexes = store.db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'persona_memory'")
      .all() as Array<{ name: string; sql: string }>;
    const sourceIdx = indexes.find((i) => i.name === 'persona_memory_source');
    assert.ok(sourceIdx, 'persona_memory_source unique index should exist');
    assert.match(sourceIdx.sql, /UNIQUE INDEX/i);

    store.db
      .prepare(
        `INSERT INTO persona_memory (persona_id, scope, event_seq, note, quote, at, source_key)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('double', 'github:example-owner/repo#1', 1, 'prefers concise replies', 'keep it short', Date.now(), 'src:1');

    assert.throws(() => {
      store.db
        .prepare(
          `INSERT INTO persona_memory (persona_id, scope, event_seq, note, quote, at, source_key)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('double', 'owner:example-owner', 2, 'dup source key', 'quote', Date.now(), 'src:1');
    });

    store.transaction(() => {
      store.setMeta('tx_key', 'committed');
      store.transaction(() => {
        store.setMeta('nested_key', 'ok');
      });
    });
    assert.equal(store.getMeta('tx_key'), 'committed');
    assert.equal(store.getMeta('nested_key'), 'ok');

    assert.throws(() => {
      store.transaction(() => {
        store.setMeta('tx_key', 'rolled_back');
        throw new Error('boom');
      });
    }, /boom/);
    assert.equal(store.getMeta('tx_key'), 'committed');
  } finally {
    store.close();
  }
});

test('WatcherDb on disk sets permissions, WAL mode, and blocks 2nd owner with exclusive lease', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-watcher-db-'));
  const stateDir = path.join(tmpDir, 'state');

  let first: WatcherDb | null = null;
  let third: WatcherDb | null = null;
  try {
    first = new WatcherDb({ stateDir });
    assert.equal(first.leaseAcquired, true);
    assert.deepEqual(first.listTables(), EXPECTED_TABLES);

    const dirMode = fs.statSync(stateDir).mode & 0o777;
    const dbMode = fs.statSync(path.join(stateDir, 'state.sqlite')).mode & 0o777;
    assert.equal(dirMode, 0o700);
    assert.equal(dbMode, 0o600);

    const journalRow = first.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    const fkRow = first.db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    assert.equal(String(journalRow.journal_mode).toLowerCase(), 'wal');
    assert.equal(fkRow.foreign_keys, 1);

    assert.throws(
      () => new WatcherDb({ stateDir }),
      (err: unknown) =>
        err instanceof Error &&
        'code' in err &&
        (err as { code?: unknown }).code === 'WATCHER_LEASE_HELD',
    );

    first.close();
    first = null;

    third = new WatcherDb({ stateDir });
    assert.equal(third.leaseAcquired, true);
    third.touchLeaseHeartbeat();
    const leaseRow = third.db
      .prepare("SELECT holder_id FROM owner_lease WHERE lease_name = 'watcher-primary'")
      .get() as { holder_id: string };
    assert.equal(leaseRow.holder_id, third.holderId);
  } finally {
    if (first) first.close();
    if (third) third.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('DoorGuard defaults to passthrough and supports ordered register/block/dispose', async () => {
  const guard = createDoorGuard();
  assert.ok(guard instanceof DoorGuard);

  assert.deepEqual(await guard.beforeEnterRoom({ roomKey: 'gh:example-owner/test#1' }), {
    allow: true,
    reason: 'passthrough',
  });
  assert.deepEqual(await guard.beforeSendOut({ sinkId: 'github.comment' }), {
    allow: true,
    reason: 'passthrough',
  });

  const order: string[] = [];
  const disposeFirst = guard.registerGuard({
    name: 'allow-first',
    beforeEnterRoom: () => {
      order.push('allow-first');
      return { allow: true };
    },
    beforeSendOut: async (ctx) => {
      order.push(`send:${ctx.sinkId}`);
      if (ctx.sinkId === 'blocked.sink') {
        return { allow: false, reason: 'sink blocked', code: 'DENY_SINK' };
      }
      return { allow: true };
    },
  });

  const disposeSecond = guard.registerGuard({
    name: 'block-enter',
    beforeEnterRoom: () => {
      order.push('block-enter');
      return { allow: false, reason: 'room paused', code: 'ROOM_PAUSED' };
    },
    beforeSendOut: () => {
      order.push('should-not-run-after-short-circuit');
      return { allow: true };
    },
  });

  assert.deepEqual(guard.listGuards(), ['allow-first', 'block-enter']);

  const enterDecision = await guard.beforeEnterRoom({ roomKey: 'r1' });
  assert.equal(enterDecision.allow, false);
  assert.equal(enterDecision.guardName, 'block-enter');
  assert.equal(enterDecision.code, 'ROOM_PAUSED');
  assert.deepEqual(order, ['allow-first', 'block-enter']);

  order.length = 0;
  const sendDecision = await guard.beforeSendOut({ sinkId: 'blocked.sink' });
  assert.equal(sendDecision.allow, false);
  assert.equal(sendDecision.guardName, 'allow-first');
  assert.equal(sendDecision.reason, 'sink blocked');
  assert.deepEqual(order, ['send:blocked.sink']);

  disposeSecond();
  disposeSecond();
  assert.deepEqual(guard.listGuards(), ['allow-first']);
  assert.deepEqual(await guard.beforeEnterRoom({ roomKey: 'r1' }), {
    allow: true,
    reason: 'passthrough',
  });

  disposeFirst();
  assert.deepEqual(guard.listGuards(), []);
  assert.deepEqual(await guard.beforeSendOut({ sinkId: 'blocked.sink' }), {
    allow: true,
    reason: 'passthrough',
  });

  assert.throws(() => guard.registerGuard({} as unknown as GuardHook), TypeError);
  assert.throws(() => guard.registerGuard({ name: 'empty' }), TypeError);
});

test('dsh-hub package.json manifest, TypeScript configs, AGENTS.md, and cordis.patch.yml meet DSH 0.2.2 constraints', () => {
  const pkgDir = path.join(REPO_ROOT, 'packages', 'dsh-hub');
  const manifestPath = path.join(pkgDir, 'package.json');
  const patchPath = path.join(pkgDir, 'cordis.patch.yml');

  assert.ok(fs.existsSync(manifestPath), `missing ${manifestPath}`);
  assert.ok(fs.existsSync(patchPath), `missing ${patchPath}`);
  assert.ok(fs.existsSync(path.join(pkgDir, 'tsconfig.json')));
  assert.ok(fs.existsSync(path.join(pkgDir, 'tsconfig.client.json')));
  assert.ok(fs.existsSync(path.join(pkgDir, 'tsconfig.test.json')));
  assert.ok(fs.existsSync(path.join(pkgDir, 'AGENTS.md')));

  const pkg = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PackageManifest;
  const patch = fs.readFileSync(patchPath, 'utf8');

  assert.equal(pkg.name, '@local/dsh-hub');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.main, 'lib/index.js');
  assert.equal(pkg.types, 'lib/index.d.ts');
  assert.equal(pkg.dsh?.manifestVersion, 1);
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.equal(pkg.engines?.dsh, '>=0.2.2-rc.1 <0.3.0');

  const deps = pkg.dependencies || {};
  assert.equal('@deepseek-ai/cordis' in deps, false);
  assert.equal('@deepseek-ai/schemastery' in deps, false);
  assert.ok(pkg.peerDependencies?.['@deepseek-ai/cordis']);
  assert.ok(pkg.peerDependencies?.['@deepseek-ai/schemastery']);
  assert.match(patch, /id:\s*hub\b/);

  for (const mod of [
    '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-client-ui-layout',
    '@deepseek-ai/dsh-client-ui-sidebar',
    '@deepseek-ai/dsh-client-ui-workspace',
  ]) {
    assert.ok(pkg.dsh?.client?.inject?.includes(mod), `dsh-hub client.inject missing ${mod}`);
  }
});
