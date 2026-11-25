import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { PersonaDb as PersonaDbContract } from './contracts.js';

export const DEFAULT_PERSONA_STATE_DIR = '~/.dsh/storages/persona';
export const DEFAULT_LEGACY_WATCHER_DB = '~/.dsh/storages/watcher/state.sqlite';
export const DEFAULT_LEGACY_WXARC_DB = '~/.dsh/wxarc-listener/events.sqlite';
export const DEFAULT_LEGACY_WXARC_DIR = '~/.dsh/wxarc-listener';

const PERSONA_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS personas (
  id          TEXT PRIMARY KEY,
  revision    INTEGER NOT NULL,
  config      TEXT NOT NULL,
  style       TEXT NOT NULL DEFAULT '',
  style_meta  TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE TABLE IF NOT EXISTS persona_memory (
  id          INTEGER PRIMARY KEY,
  persona_id  TEXT NOT NULL,
  scope       TEXT NOT NULL,
  event_seq   INTEGER NOT NULL,
  note        TEXT NOT NULL,
  quote       TEXT NOT NULL,
  at          INTEGER NOT NULL,
  source_key  TEXT,
  category    TEXT NOT NULL DEFAULT '聊天偏好',
  metadata    TEXT NOT NULL DEFAULT '{}',
  UNIQUE (persona_id, scope, event_seq, note)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS persona_memory_source
  ON persona_memory (persona_id, source_key)
  WHERE source_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_persona_memory_persona_scope
  ON persona_memory (persona_id, scope, id DESC);

CREATE TABLE IF NOT EXISTS persona_meta (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
) STRICT;
`;

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
      this.db.exec(PERSONA_SCHEMA_SQL);
      return;
    }

    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    chmodSafe(this.stateDir, 0o700);

    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(PERSONA_SCHEMA_SQL);
    chmodSafe(this.dbPath, 0o600);
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
        this.db.exec(isNested ? `ROLLBACK TO SAVEPOINT ${sp}; RELEASE SAVEPOINT ${sp}` : 'ROLLBACK');
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
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
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
