import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import {
  PersonaNotFoundError,
  PersonaRevisionConflictError,
  apply,
  createPersonaHttpHandler,
  createPersonaWardrobe,
  inject,
  name,
  openPersonaDb,
  type FoundationBundle,
  type FoundationSource,
  type WebServerRouteRegistration,
} from '../src/index.js';

function makeMockRequest(opts: {
  method?: string;
  url?: string;
  body?: unknown;
  remoteAddress?: string;
  host?: string;
  origin?: string;
  secFetchSite?: string;
}): IncomingMessage {
  const payload = opts.body === undefined ? '' : JSON.stringify(opts.body);
  const stream = Readable.from(payload ? [Buffer.from(payload, 'utf8')] : []) as unknown as IncomingMessage;
  stream.method = opts.method ?? 'GET';
  stream.url = opts.url ?? '/local-persona/personas';
  const headers: Record<string, string> = {};
  if (opts.host !== undefined) headers.host = opts.host;
  else headers.host = '127.0.0.1:3000';
  if (opts.origin !== undefined) headers.origin = opts.origin;
  if (opts.secFetchSite !== undefined) headers['sec-fetch-site'] = opts.secFetchSite;
  stream.headers = headers;
  (stream as unknown as { socket: { remoteAddress: string } }).socket = {
    remoteAddress: opts.remoteAddress ?? '127.0.0.1',
  };
  return stream;
}

function makeMockResponse(): {
  res: ServerResponse;
  result: () => { status: number; body: Record<string, unknown> };
} {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    set statusCode(code: number) {
      status = code;
    },
    get statusCode() {
      return status;
    },
    setHeader() {},
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
      }
    },
  } as unknown as ServerResponse;
  return {
    res,
    result: () => ({
      status,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>,
    }),
  };
}

test('PersonaWardrobe CRUD, revision CAS, and delete cascade', () => {
  const db = openPersonaDb({ inMemory: true });
  try {
    const wardrobe = createPersonaWardrobe(db);
    assert.deepEqual(wardrobe.list(), []);

    const created = wardrobe.create('double');
    assert.equal(created.kind, 'double');
    assert.equal(created.revision, 1);

    const saved = wardrobe.save(
      {
        id: created.id,
        kind: 'double',
        name: '主人分身',
        definition: '直接清晰',
        learning: true,
        work: 'DSH',
        character: '冷静',
      },
      1,
    );
    assert.equal(saved.revision, 2);
    assert.equal(saved.name, '主人分身');

    assert.throws(
      () =>
        wardrobe.save(
          {
            id: created.id,
            kind: 'double',
            name: 'Stale',
            definition: '',
            learning: true,
            work: '',
            character: '',
          },
          1,
        ),
      PersonaRevisionConflictError,
    );

    wardrobe.recordTurnPreference({
      personaId: created.id,
      scope: 'text:room-1',
      sourceText: '我喜欢短句回复',
      memories: [{ note: '偏好短句', quote: '喜欢短句' }],
    });
    assert.equal(wardrobe.get(created.id).memoryCount, 1);

    assert.equal(wardrobe.delete(created.id), true);
    assert.equal(wardrobe.delete(created.id), false);
    assert.throws(() => wardrobe.get(created.id), PersonaNotFoundError);
    assert.deepEqual(wardrobe.listMemories(created.id), []);
  } finally {
    db.close();
  }
});

test('recordTurnPreference enforces sourceText.includes(quote), 24-cap for source_key IS NULL, and 16-recent card', () => {
  const db = openPersonaDb({ inMemory: true });
  let clock = 1_700_000_000_000;
  try {
    const wardrobe = createPersonaWardrobe(db, undefined, { now: () => (clock += 1000) });
    const persona = wardrobe.create({ id: 'p-turn', kind: 'original', name: '测试角色', learning: true });

    const rejected = wardrobe.recordTurnPreference({
      personaId: persona.id,
      scope: 'text:room-1',
      sourceText: '今天只聊项目进度',
      memories: [{ note: '瞎编记忆', quote: '根本没说过的话' }],
    });
    assert.equal(rejected.recorded, 0);

    for (let i = 1; i <= 30; i += 1) {
      const res = wardrobe.recordTurnPreference({
        personaId: persona.id,
        scope: 'text:room-1',
        eventSeq: i,
        sourceText: `第${i}轮原话内容`,
        memories: [{ note: `偏好-${i}`, quote: `第${i}轮原话` }],
      });
      assert.equal(res.recorded, 1);
    }

    const mems = wardrobe.listMemories(persona.id, { scope: 'text:room-1' });
    assert.equal(mems.length, 24);
    assert.equal(mems[0]?.note, '偏好-30');
    assert.equal(mems[23]?.note, '偏好-7');

    const card = wardrobe.getDynamicCard({ personaId: persona.id, scope: 'text:room-1' });
    assert.ok(card);
    assert.equal(card.memory.length, 16);
    assert.equal(card.memory[0]?.note, '偏好-15');
    assert.equal(card.memory[15]?.note, '偏好-30');

    wardrobe.editMemory(persona.id, mems[0]!.id, '偏好-30-修订');
    const edited = wardrobe.listMemories(persona.id, { limit: 1 })[0];
    assert.equal(edited?.note, '偏好-30-修订');
    assert.equal(typeof edited?.metadata.editedAt, 'number');

    const paused = wardrobe.create({ id: 'p-off', kind: 'double', learning: false });
    assert.equal(
      wardrobe.recordTurnPreference({
        personaId: paused.id,
        scope: 'text:room-1',
        sourceText: '暂停中',
        memories: [{ note: '不记录', quote: '暂停中' }],
      }).recorded,
      0,
    );
    assert.equal(
      wardrobe.recordTurnPreference({
        personaId: persona.id,
        scope: 'sns:moments',
        sourceText: '朋友圈',
        memories: [{ note: '不学朋友圈', quote: '朋友圈' }],
      }).recorded,
      0,
    );

    assert.equal(wardrobe.clearMemories(persona.id, 'text:room-1').deleted, 24);
  } finally {
    db.close();
  }
});

test('importFoundation and owner-private CJK 2-gram ranking in getDynamicCard', () => {
  const db = openPersonaDb({ inMemory: true });
  try {
    const wardrobe = createPersonaWardrobe(db);
    const persona = wardrobe.create({ id: 'owner-double', kind: 'double', name: 'Owner' });

    const records = [
      ...Array.from({ length: 5 }, (_, idx) => ({
        id: `base-${idx + 1}`,
        owner_persona_id: persona.id,
        subject_id: 'owner',
        visibility: 'owner_private',
        category: '基础事实',
        title: `基础档案${idx + 1}`,
        statement: `基础事实描述第${idx + 1}条`,
        source_ids: ['src-1'],
        status: 'confirmed',
      })),
      ...Array.from({ length: 8 }, (_, idx) => ({
        id: `coffee-${idx + 1}`,
        owner_persona_id: persona.id,
        subject_id: 'owner',
        visibility: 'owner_private',
        category: '饮食习惯',
        title: `咖啡偏好${idx + 1}`,
        statement: `平时喝手冲黑咖啡和拿铁第${idx + 1}条`,
        tags: ['咖啡', '手冲'],
        source_ids: ['src-coffee'],
      })),
    ];

    const bundle: FoundationBundle = {
      default_persona_id: persona.id,
      subject_id: 'owner',
      source_snapshot: 'snap-2026',
      records,
    };
    const sources: FoundationSource[] = [
      { source_id: 'src-1', text: '基础事实来源' },
      { source_id: 'src-coffee', text: '早上喜欢喝手冲黑咖啡' },
    ];

    const first = wardrobe.importFoundation(bundle, sources);
    assert.equal(first.added, 13);
    assert.equal(first.total, 13);

    const second = wardrobe.importFoundation(bundle, sources);
    assert.equal(second.added, 0);
    assert.equal(second.total, 13);

    const publicCard = wardrobe.getDynamicCard({
      personaId: persona.id,
      scope: 'text:guest',
      queryText: '手冲咖啡',
    });
    assert.ok(publicCard);
    assert.equal(publicCard.memory.length, 0);

    const wrongOwnerCard = wardrobe.getDynamicCard({
      personaId: persona.id,
      scope: 'text:guest',
      ownerId: 'stranger',
      queryText: '手冲咖啡',
    });
    assert.equal(wrongOwnerCard?.memory.length, 0);

    const matchedCard = wardrobe.getDynamicCard({
      personaId: persona.id,
      scope: 'text:owner',
      ownerId: 'owner',
      queryText: '推荐一杯手冲咖啡',
    });
    assert.ok(matchedCard);
    assert.equal(matchedCard.memory.length, 6);
    assert.ok(matchedCard.memory.every((m) => m.category === '饮食习惯'));
    assert.match(matchedCard.promptBlock, /Owner Foundation Facts/);

    const fallbackCard = wardrobe.getDynamicCard({
      personaId: persona.id,
      scope: 'text:owner',
      ownerPreview: true,
      queryText: '完全无关的太空发射',
    });
    assert.ok(fallbackCard);
    assert.equal(fallbackCard.memory.length, 4);
    assert.ok(fallbackCard.memory.every((m) => m.category === '基础事实'));
  } finally {
    db.close();
  }
});

test('sampleInfo/sample fallback, learnStyleFromSamples, and dry-run previewChat', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-persona-sample-'));
  const stateDir = path.join(tmpDir, 'state');
  const legacyDir = path.join(tmpDir, 'wxarc');
  fs.mkdirSync(legacyDir, { recursive: true });
  const sampleFile = path.join(legacyDir, 'owner-style-sample.json');
  fs.writeFileSync(
    sampleFile,
    JSON.stringify({
      source: 'wxarc-export',
      createdAt: '2026-11-20T00:00:00Z',
      samples: [
        { text: '先说结论，不用绕弯' },
        { text: '直接把日志贴出来看？' },
      ],
    }),
    'utf8',
  );

  const db = openPersonaDb({ stateDir });
  try {
    const wardrobe = createPersonaWardrobe(db, undefined, {
      sampleDirs: [stateDir, legacyDir],
      summarizeFn: async ({ samples }) => `简洁直给风格（共 ${samples.length} 条样本）`,
      previewRunner: async ({ card, message }) => `[preview:${card.name}] ${message}`,
    });

    const info = wardrobe.sampleInfo();
    assert.equal(info.available, true);
    assert.equal(info.count, 2);
    assert.equal(info.path, sampleFile);
    assert.equal(wardrobe.sample().samples.length, 2);

    const persona = wardrobe.create({ id: 'p-style', kind: 'double', name: '分身' });
    const learnedFromFile = await wardrobe.learnStyleFromSamples(persona.id, persona.revision);
    assert.equal(learnedFromFile.revision, 2);
    assert.equal(learnedFromFile.style, '简洁直给风格（共 2 条样本）');

    const learnedInline = await wardrobe.learnStyleFromSamples(persona.id, learnedFromFile.revision, {
      samples: [{ text: '行，就这么定' }],
      source: 'inline-test',
    });
    assert.equal(learnedInline.revision, 3);
    assert.equal(learnedInline.style, '简洁直给风格（共 1 条样本）');

    const preview = await wardrobe.previewChat({
      personaId: persona.id,
      message: '今晚吃啥',
    });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.memoryMutated, false);
    assert.equal(preview.reply, '[preview:分身] 今晚吃啥');
    assert.equal(wardrobe.listMemories(persona.id).length, 0);
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('autoMigrateIfEmpty losslessly migrates 3 personas and 27 memories from legacy SQLite on first boot', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-persona-migrate-'));
  const legacyDbPath = path.join(tmpDir, 'legacy-state.sqlite');
  const newStateDir = path.join(tmpDir, 'persona-state');

  const legacy = new DatabaseSync(legacyDbPath);
  legacy.exec(`
    CREATE TABLE personas (
      id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      config TEXT NOT NULL,
      style TEXT NOT NULL DEFAULT '',
      style_meta TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE persona_memory (
      id INTEGER PRIMARY KEY,
      persona_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      event_seq INTEGER NOT NULL,
      note TEXT NOT NULL,
      quote TEXT NOT NULL,
      at INTEGER NOT NULL,
      source_key TEXT,
      category TEXT NOT NULL DEFAULT '聊天偏好',
      metadata TEXT NOT NULL DEFAULT '{}'
    );
  `);
  const insertPersona = legacy.prepare(
    'INSERT INTO personas (id, revision, config, style, style_meta) VALUES (?, ?, ?, ?, ?)',
  );
  const insertMem = legacy.prepare(
    'INSERT INTO persona_memory (persona_id, scope, event_seq, note, quote, at, source_key, category, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (let p = 1; p <= 3; p += 1) {
    const pid = `legacy-p-${p}`;
    insertPersona.run(
      pid,
      p,
      JSON.stringify({ id: pid, kind: p === 1 ? 'double' : 'original', name: `人格${p}`, definition: `设定${p}`, learning: true }),
      `风格${p}`,
      '{}',
    );
    for (let m = 1; m <= 9; m += 1) {
      insertMem.run(pid, 'owner:demo', m, `记忆-${p}-${m}`, `原话-${p}-${m}`, 1700000000000 + m, `foundation:${p}-${m}`, '基础事实', '{}');
    }
  }
  legacy.close();

  const db = openPersonaDb({ stateDir: newStateDir });
  try {
    const wardrobe = createPersonaWardrobe(db, undefined, { legacyDbPaths: [legacyDbPath] });
    const first = wardrobe.autoMigrateIfEmpty();
    assert.equal(first.migrated, true);
    assert.equal(first.personasImported, 3);
    assert.equal(first.memoriesImported, 27);
    assert.equal(first.sourcePath, legacyDbPath);
    assert.equal(wardrobe.list().length, 3);

    const second = wardrobe.autoMigrateIfEmpty();
    assert.equal(second.migrated, false);
    assert.equal(second.personasImported, 0);
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('HTTP routes enforce loopback owner gate and expose full /local-persona API plus Cordis plugin apply', async () => {
  const db = openPersonaDb({ inMemory: true });
  try {
    const wardrobe = createPersonaWardrobe(db);
    const handler = createPersonaHttpHandler(wardrobe);

    const blockedRes = makeMockResponse();
    await handler(makeMockRequest({ remoteAddress: '192.0.2.55' }), blockedRes.res);
    assert.equal(blockedRes.result().status, 403);
    assert.equal(blockedRes.result().body.error, 'loopback_only');

    const badOriginRes = makeMockResponse();
    await handler(makeMockRequest({ origin: 'https://evil.example' }), badOriginRes.res);
    assert.equal(badOriginRes.result().status, 403);

    const createRes = makeMockResponse();
    await handler(
      makeMockRequest({ method: 'POST', url: '/local-persona/personas', body: { kind: 'double', name: '本地分身' } }),
      createRes.res,
    );
    assert.equal(createRes.result().status, 201);
    const createdPersona = createRes.result().body.persona as { id: string; revision: number };
    assert.ok(createdPersona.id);

    const sampleRes = makeMockResponse();
    await handler(makeMockRequest({ method: 'GET', url: '/local-persona/sample-info' }), sampleRes.res);
    assert.equal(sampleRes.result().status, 200);
    assert.equal(typeof sampleRes.result().body.available, 'boolean');

    const importFoundationRes = makeMockResponse();
    await handler(
      makeMockRequest({
        method: 'POST',
        url: '/local-persona/personas/import-foundation',
        body: {
          bundle: {
            default_persona_id: createdPersona.id,
            subject_id: 'owner',
            source_snapshot: 'snap-1',
            records: [
              {
                id: 'f-1',
                owner_persona_id: createdPersona.id,
                subject_id: 'owner',
                visibility: 'owner_private',
                category: '基础事实',
                statement: '住在上海',
                source_ids: ['s-1'],
              },
            ],
          },
          sources: [{ source_id: 's-1', text: '我在上海工作' }],
        },
      }),
      importFoundationRes.res,
    );
    assert.equal(importFoundationRes.result().status, 200);
    assert.equal(importFoundationRes.result().body.added, 1);

    const previewRes = makeMockResponse();
    await handler(
      makeMockRequest({
        method: 'POST',
        url: `/local-persona/personas/${encodeURIComponent(createdPersona.id)}/preview`,
        body: { message: '你好' },
      }),
      previewRes.res,
    );
    assert.equal(previewRes.result().status, 200);
    assert.equal(previewRes.result().body.dryRun, true);

    const delRes = makeMockResponse();
    await handler(
      makeMockRequest({ method: 'DELETE', url: `/local-persona/personas/${encodeURIComponent(createdPersona.id)}` }),
      delRes.res,
    );
    assert.equal(delRes.result().status, 200);
    assert.equal(delRes.result().body.deleted, true);
  } finally {
    db.close();
  }

  assert.equal(name, 'persona');
  assert.deepEqual(Array.from(inject), []);

  const provided = new Map<string, unknown>();
  const registeredRoutes: WebServerRouteRegistration[] = [];
  const effects: Array<() => void> = [];

  const runtime = apply(
    {
      provide(key, value) {
        provided.set(key, value);
      },
      inject(deps, cb) {
        assert.deepEqual(Array.from(deps), ['webServer']);
        cb({
          webServer: {
            register(route: WebServerRouteRegistration) {
              registeredRoutes.push(route);
              return () => {};
            },
          },
        });
      },
      effect(fn) {
        const cleanup = fn();
        if (typeof cleanup === 'function') effects.push(cleanup);
      },
    },
    { inMemory: true },
  );

  assert.equal(provided.get('personaWardrobe'), runtime.wardrobe);
  assert.equal(registeredRoutes.length, 1);
  assert.equal(registeredRoutes[0]?.path, '/local-persona');
  for (const cleanup of effects) cleanup();
});
