import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { PersonaDb as PersonaDbContract } from './contracts.js';

export const DEFAULT_PERSONA_STATE_DIR = '~/.dsh/storages/persona';
export const DEFAULT_LEGACY_WATCHER_DB = '~/.dsh/storages/watcher/state.sqlite';
export const DEFAULT_LEGACY_WXARC_DB = '~/.dsh/wxarc-listener/events.sqlite';
export const DEFAULT_LEGACY_WXARC_DIR = '~/.dsh/wxarc-listener';

const PERSONA_CORE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS personas (
  id          TEXT PRIMARY KEY,
  revision    INTEGER NOT NULL,
  config      TEXT NOT NULL,
  style       TEXT NOT NULL DEFAULT '',
  style_meta  TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE TABLE IF NOT EXISTS persona_memory (
  id            INTEGER PRIMARY KEY,
  persona_id    TEXT NOT NULL,
  scope         TEXT NOT NULL,
  event_seq     INTEGER NOT NULL,
  note          TEXT NOT NULL,
  quote         TEXT NOT NULL,
  at            INTEGER NOT NULL,
  source_key    TEXT,
  category      TEXT NOT NULL DEFAULT '聊天偏好',
  subject_wxid  TEXT NOT NULL DEFAULT '',
  speaker_wxid  TEXT NOT NULL DEFAULT '',
  visibility    TEXT NOT NULL DEFAULT 'room' CHECK (visibility IN ('room', 'circle', 'dm_only', 'owner_private')),
  audience_tag  TEXT NOT NULL DEFAULT '' CHECK (audience_tag IN ('', 'family', 'work', 'external')),
  edited_at     INTEGER,
  revoked_at    INTEGER,
  metadata      TEXT NOT NULL DEFAULT '{}',
  UNIQUE (persona_id, scope, event_seq, note)
) STRICT;

CREATE TABLE IF NOT EXISTS persona_meta (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS chat_circle (
  chat_id     TEXT PRIMARY KEY,
  circle      TEXT NOT NULL DEFAULT 'external' CHECK (circle IN ('family', 'work', 'external')),
  label       TEXT NOT NULL DEFAULT '',
  updated_at  INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS foundation_imports (
  bundle_id        TEXT PRIMARY KEY,
  persona_id       TEXT NOT NULL,
  source_snapshot  TEXT NOT NULL,
  watermark        INTEGER,
  imported_at      INTEGER NOT NULL,
  payload_hash     TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS media_asset (
  id            TEXT PRIMARY KEY,
  msg_id        TEXT NOT NULL,
  chat_id       TEXT NOT NULL,
  sender_wxid   TEXT NOT NULL DEFAULT '',
  media_type    TEXT NOT NULL CHECK (media_type IN ('image', 'voice', 'video')),
  sha256        TEXT NOT NULL DEFAULT '',
  dhash         TEXT NOT NULL DEFAULT '',
  thumb_path    TEXT NOT NULL DEFAULT '',
  duration_ms   INTEGER NOT NULL DEFAULT 0,
  circle        TEXT NOT NULL DEFAULT 'external' CHECK (circle IN ('family', 'work', 'external')),
  visibility    TEXT NOT NULL DEFAULT 'room' CHECK (visibility IN ('room', 'circle', 'dm_only', 'owner_private')),
  transcript    TEXT NOT NULL DEFAULT '',
  metadata      TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL,
  UNIQUE (msg_id, sha256)
) STRICT;

CREATE TABLE IF NOT EXISTS visual_observation (
  id              TEXT PRIMARY KEY,
  persona_id      TEXT NOT NULL DEFAULT '',
  media_asset_id  TEXT NOT NULL,
  chat_id         TEXT NOT NULL,
  sender_wxid     TEXT NOT NULL DEFAULT '',
  subject_wxid    TEXT NOT NULL DEFAULT '',
  circle          TEXT NOT NULL DEFAULT 'external' CHECK (circle IN ('family', 'work', 'external')),
  visibility      TEXT NOT NULL DEFAULT 'room' CHECK (visibility IN ('room', 'circle', 'dm_only', 'owner_private')),
  status          TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'confirmed', 'rejected')),
  summary         TEXT NOT NULL,
  tags            TEXT NOT NULL DEFAULT '[]',
  entity_guesses  TEXT NOT NULL DEFAULT '[]',
  confidence      REAL NOT NULL DEFAULT 0,
  quality_tier    TEXT NOT NULL DEFAULT 'low' CHECK (quality_tier IN ('high', 'medium', 'low')),
  model           TEXT NOT NULL DEFAULT '',
  source_msg_id   TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  FOREIGN KEY (media_asset_id) REFERENCES media_asset(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS event_fact (
  id             TEXT PRIMARY KEY,
  persona_id     TEXT NOT NULL DEFAULT '',
  subject_wxid   TEXT NOT NULL DEFAULT '',
  subject_name   TEXT NOT NULL DEFAULT '',
  predicate      TEXT NOT NULL,
  object_name    TEXT NOT NULL,
  statement      TEXT NOT NULL,
  tags           TEXT NOT NULL DEFAULT '[]',
  circle         TEXT NOT NULL DEFAULT 'external' CHECK (circle IN ('family', 'work', 'external')),
  visibility     TEXT NOT NULL DEFAULT 'circle' CHECK (visibility IN ('room', 'circle', 'dm_only', 'owner_private')),
  room_chat_id   TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('candidate', 'confirmed', 'rejected')),
  evidence_type  TEXT NOT NULL CHECK (evidence_type IN ('text', 'voice', 'owner_confirmed')),
  confidence     REAL NOT NULL DEFAULT 1,
  edited_at      INTEGER,
  revoked_at     INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS reference_card (
  id             TEXT PRIMARY KEY,
  entity_type    TEXT NOT NULL CHECK (entity_type IN ('person', 'object', 'pet', 'place')),
  entity_name    TEXT NOT NULL,
  aliases        TEXT NOT NULL DEFAULT '[]',
  subject_wxid   TEXT NOT NULL DEFAULT '',
  tags           TEXT NOT NULL DEFAULT '[]',
  description    TEXT NOT NULL DEFAULT '',
  image_path     TEXT NOT NULL DEFAULT '',
  dhash          TEXT NOT NULL DEFAULT '',
  circle         TEXT NOT NULL DEFAULT 'external' CHECK (circle IN ('family', 'work', 'external')),
  visibility     TEXT NOT NULL DEFAULT 'circle' CHECK (visibility IN ('room', 'circle', 'dm_only', 'owner_private')),
  room_chat_id   TEXT NOT NULL DEFAULT '',
  quality_score  REAL NOT NULL DEFAULT 1,
  reviewed_by    TEXT NOT NULL DEFAULT '',
  revoked_at     INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS memory_evidence (
  id              TEXT PRIMARY KEY,
  target_type     TEXT NOT NULL CHECK (target_type IN ('visual_observation', 'event_fact', 'persona_memory', 'reference_card')),
  target_id       TEXT NOT NULL,
  evidence_kind   TEXT NOT NULL CHECK (evidence_kind IN ('text', 'voice', 'visual', 'owner_confirmed', 'media_asset')),
  source_msg_id   TEXT NOT NULL DEFAULT '',
  chat_id         TEXT NOT NULL DEFAULT '',
  sender_wxid     TEXT NOT NULL DEFAULT '',
  media_asset_id  TEXT NOT NULL DEFAULT '',
  excerpt         TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL
) STRICT;

CREATE VIRTUAL TABLE IF NOT EXISTS reference_card_fts USING fts5(
  card_id UNINDEXED,
  search_text,
  tokenize = 'unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS event_fact_fts USING fts5(
  fact_id UNINDEXED,
  search_text,
  tokenize = 'unicode61'
);
`;

const PERSONA_INDEX_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS persona_memory_source
  ON persona_memory (persona_id, source_key)
  WHERE source_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_persona_memory_persona_scope
  ON persona_memory (persona_id, scope, id DESC);

CREATE INDEX IF NOT EXISTS idx_persona_memory_visibility_audience
  ON persona_memory (persona_id, visibility, audience_tag, subject_wxid);

CREATE INDEX IF NOT EXISTS idx_persona_memory_active
  ON persona_memory (persona_id, scope, revoked_at, at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_media_asset_chat
  ON media_asset (chat_id, circle, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_visual_observation_chat_status
  ON visual_observation (chat_id, status, circle, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_event_fact_circle
  ON event_fact (circle, visibility, status, revoked_at, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_reference_card_circle
  ON reference_card (circle, visibility, revoked_at, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_evidence_target
  ON memory_evidence (target_type, target_id, created_at DESC);
`;

const REQUIRED_MEMORY_COLUMNS = [
  'subject_wxid',
  'speaker_wxid',
  'visibility',
  'audience_tag',
  'edited_at',
  'revoked_at',
] as const;

export interface PersonaDbOptions {
  stateDir?: string;
  inMemory?: boolean;
}

export function expandHome(dir?: string): string {
  if (!dir) return path.join(os.homedir(), '.dsh', 'storages', 'persona');
  if (dir === '~') return os.homedir();
  return dir.startsWith('~/') ? path.join(os.homedir(), dir.slice(2)) : path.resolve(dir);
}

function chmodSafe(filePath: string, mode: number): void {
  try {
    if (fs.existsSync(filePath)) fs.chmodSync(filePath, mode);
  } catch {
  }
}

function migratePersonaMemoryLosslessly(db: DatabaseSync): void {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(persona_memory)').all() as Array<{ name: string }>).map(
      (col) => col.name,
    ),
  );
  if (REQUIRED_MEMORY_COLUMNS.every((col) => columns.has(col))) {
    return;
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const beforeRow = db.prepare('SELECT COUNT(*) AS cnt FROM persona_memory').get() as {
      cnt: number;
    };
    const expectedCount = Number(beforeRow?.cnt ?? 0);

    db.exec(`
      CREATE TABLE persona_memory_v2 (
        id            INTEGER PRIMARY KEY,
        persona_id    TEXT NOT NULL,
        scope         TEXT NOT NULL,
        event_seq     INTEGER NOT NULL,
        note          TEXT NOT NULL,
        quote         TEXT NOT NULL,
        at            INTEGER NOT NULL,
        source_key    TEXT,
        category      TEXT NOT NULL DEFAULT '聊天偏好',
        subject_wxid  TEXT NOT NULL DEFAULT '',
        speaker_wxid  TEXT NOT NULL DEFAULT '',
        visibility    TEXT NOT NULL DEFAULT 'room' CHECK (visibility IN ('room', 'circle', 'dm_only', 'owner_private')),
        audience_tag  TEXT NOT NULL DEFAULT '' CHECK (audience_tag IN ('', 'family', 'work', 'external')),
        edited_at     INTEGER,
        revoked_at    INTEGER,
        metadata      TEXT NOT NULL DEFAULT '{}',
        UNIQUE (persona_id, scope, event_seq, note)
      ) STRICT;
    `);

    const subjectExpr = columns.has('subject_wxid')
      ? `COALESCE(subject_wxid, CASE WHEN scope LIKE 'owner:%' THEN substr(scope, 7) ELSE '' END)`
      : `CASE WHEN scope LIKE 'owner:%' THEN substr(scope, 7) ELSE '' END`;
    const speakerExpr = columns.has('speaker_wxid')
      ? `COALESCE(speaker_wxid, '')`
      : `CASE WHEN json_valid(metadata) AND typeof(json_extract(metadata, '$.speakerWxid')) = 'text' THEN json_extract(metadata, '$.speakerWxid') ELSE '' END`;
    const visibilityExpr = columns.has('visibility')
      ? `CASE WHEN visibility IN ('room', 'circle', 'dm_only', 'owner_private') THEN visibility WHEN scope LIKE 'owner:%' OR source_key LIKE 'foundation:%' THEN 'owner_private' ELSE 'room' END`
      : `CASE WHEN scope LIKE 'owner:%' OR source_key LIKE 'foundation:%' THEN 'owner_private' ELSE 'room' END`;
    const audienceExpr = columns.has('audience_tag')
      ? `CASE WHEN audience_tag IN ('', 'family', 'work', 'external') THEN audience_tag ELSE '' END`
      : `''`;
    const editedAtExpr = columns.has('edited_at')
      ? `edited_at`
      : `CASE WHEN json_valid(metadata) AND typeof(json_extract(metadata, '$.editedAt')) IN ('integer', 'real') THEN CAST(json_extract(metadata, '$.editedAt') AS INTEGER) ELSE NULL END`;
    const revokedAtExpr = columns.has('revoked_at') ? `revoked_at` : `NULL`;

    db.exec(`
      INSERT INTO persona_memory_v2 (
        id, persona_id, scope, event_seq, note, quote, at, source_key, category,
        subject_wxid, speaker_wxid, visibility, audience_tag, edited_at, revoked_at, metadata
      )
      SELECT
        id, persona_id, scope, event_seq, note, quote, at, source_key, category,
        ${subjectExpr},
        ${speakerExpr},
        ${visibilityExpr},
        ${audienceExpr},
        ${editedAtExpr},
        ${revokedAtExpr},
        metadata
      FROM persona_memory;
    `);

    const afterRow = db.prepare('SELECT COUNT(*) AS cnt FROM persona_memory_v2').get() as {
      cnt: number;
    };
    if (Number(afterRow?.cnt ?? 0) !== expectedCount) {
      throw new Error(
        `Lossless persona_memory migration row count mismatch: expected ${expectedCount}, got ${afterRow?.cnt ?? 0}`,
      );
    }

    db.exec('DROP TABLE persona_memory; ALTER TABLE persona_memory_v2 RENAME TO persona_memory;');
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
    }
    throw err;
  }
}

function initializeDatabaseSchema(db: DatabaseSync): void {
  db.exec(PERSONA_CORE_SCHEMA_SQL);
  migratePersonaMemoryLosslessly(db);
  db.exec(PERSONA_INDEX_SQL);
  const existingVer = db
    .prepare("SELECT value FROM persona_meta WHERE key = 'memory_version'")
    .get() as { value: string } | undefined;
  if (!existingVer) {
    db.prepare(
      `INSERT OR IGNORE INTO persona_meta (key, value, updated_at) VALUES ('memory_version', '1', ?)`,
    ).run(new Date().toISOString());
  }
}

export class PersonaDbImpl implements PersonaDbContract {
  readonly db: DatabaseSync;
  readonly stateDir: string;
  readonly dbPath: string;
  readonly inMemory: boolean;
  private txDepth: number;
  private closed: boolean;

  constructor(options: PersonaDbOptions = {}) {
    const { stateDir = DEFAULT_PERSONA_STATE_DIR, inMemory = false } = options;

    this.inMemory = Boolean(inMemory);
    this.stateDir = this.inMemory ? ':memory:' : expandHome(stateDir);
    this.dbPath = this.inMemory ? ':memory:' : path.join(this.stateDir, 'state.sqlite');
    this.txDepth = 0;
    this.closed = false;

    if (this.inMemory) {
      this.db = new DatabaseSync(':memory:');
      this.db.exec('PRAGMA foreign_keys = ON;');
      initializeDatabaseSchema(this.db);
      return;
    }

    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    chmodSafe(this.stateDir, 0o700);

    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    initializeDatabaseSchema(this.db);
    chmodSafe(this.dbPath, 0o600);
    chmodSafe(`${this.dbPath}-wal`, 0o600);
    chmodSafe(`${this.dbPath}-shm`, 0o600);
  }

  transaction<T>(fn: () => T): T {
    if (this.closed) throw new Error('PersonaDb is closed');
    const isNested = this.txDepth > 0;
    const sp = isNested ? `sp_${this.txDepth}` : null;
    this.db.exec(isNested ? `SAVEPOINT ${sp}` : 'BEGIN IMMEDIATE');
    this.txDepth += 1;
    try {
      const result = fn();
      this.txDepth -= 1;
      this.db.exec(isNested ? `RELEASE SAVEPOINT ${sp}` : 'COMMIT');
      return result;
    } catch (err) {
      this.txDepth -= 1;
      try {
        this.db.exec(
          isNested ? `ROLLBACK TO SAVEPOINT ${sp}; RELEASE SAVEPOINT ${sp}` : 'ROLLBACK',
        );
      } catch {
      }
      throw err;
    }
  }

  getMeta(key: string, fallback?: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM persona_meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : fallback;
  }

  setMeta(key: string, value: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO persona_meta (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, String(value), now);
  }

  listTables(): string[] {
    const rows = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

export function openPersonaDb(options: PersonaDbOptions = {}): PersonaDbImpl {
  return new PersonaDbImpl(options);
}
