import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { WatcherDb as WatcherDbContract } from './contracts.js';

export const SCHEMA_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql');

export interface HubDbOptions {
  stateDir?: string;
  homeDir?: string;
  inMemory?: boolean;
  acquireLease?: boolean;
  leaseName?: string;
  holderId?: string;
}

export type WatcherDbOptions = HubDbOptions;

export class WatcherLeaseError extends Error {
  readonly code = 'WATCHER_LEASE_HELD';
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'WatcherLeaseError';
    this.cause = cause;
  }
}

export const HubLeaseError = WatcherLeaseError;

export function expandHome(dir?: string, homeDir?: string): string {
  const baseHome = homeDir ?? os.homedir();
  if (!dir) return resolveStateDir(undefined, baseHome);
  if (dir === '~') return baseHome;
  return dir.startsWith('~/') ? path.join(baseHome, dir.slice(2)) : path.resolve(dir);
}

export function resolveStateDir(stateDir?: string, homeDir?: string): string {
  const baseHome = homeDir ?? os.homedir();
  if (typeof stateDir === 'string' && stateDir.trim()) {
    const trimmed = stateDir.trim();
    if (trimmed === '~') return baseHome;
    return trimmed.startsWith('~/') ? path.join(baseHome, trimmed.slice(2)) : path.resolve(trimmed);
  }
  const hubDir = path.join(baseHome, '.dsh', 'storages', 'hub');
  const watcherDir = path.join(baseHome, '.dsh', 'storages', 'watcher');
  if (!fs.existsSync(path.join(hubDir, 'state.sqlite')) && fs.existsSync(path.join(watcherDir, 'state.sqlite'))) {
    return watcherDir;
  }
  return hubDir;
}

function chmodSafe(filePath: string, mode: number): void {
  try {
    if (fs.existsSync(filePath)) fs.chmodSync(filePath, mode);
  } catch {
  }
}

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export class HubDb implements WatcherDbContract {
  readonly db: DatabaseSync;
  readonly stateDir: string;
  readonly inMemory: boolean;
  readonly holderId: string;
  readonly leaseName: string;
  leaseAcquired: boolean;
  private leaseDb: DatabaseSync | null;
  private txDepth: number;
  private closed: boolean;

  constructor(options: HubDbOptions = {}) {
    const {
      stateDir,
      homeDir,
      inMemory = false,
      acquireLease = !inMemory,
      leaseName = 'watcher-primary',
      holderId = `hub-${process.pid}-${randomUUID().slice(0, 8)}`,
    } = options;

    this.inMemory = Boolean(inMemory);
    this.stateDir = this.inMemory ? ':memory:' : resolveStateDir(stateDir, homeDir);
    this.leaseName = leaseName;
    this.holderId = holderId;
    this.leaseDb = null;
    this.leaseAcquired = false;
    this.txDepth = 0;
    this.closed = false;

    const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8');

    if (this.inMemory) {
      this.db = new DatabaseSync(':memory:');
      this.db.exec('PRAGMA foreign_keys = ON;');
      this.db.exec(schemaSql);
      this.upsertLeaseRow();
      return;
    }

    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    chmodSafe(this.stateDir, 0o700);

    const leasePath = path.join(this.stateDir, 'automation-owner.sqlite');
    const statePath = path.join(this.stateDir, 'state.sqlite');

    if (acquireLease) {
      this.acquireExclusiveLease(leasePath);
    }

    try {
      this.db = new DatabaseSync(statePath);
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA busy_timeout = 5000;');
      this.db.exec('PRAGMA foreign_keys = ON;');
      this.db.exec(schemaSql);
      chmodSafe(statePath, 0o600);
      chmodSafe(leasePath, 0o600);
      if (this.leaseAcquired) {
        this.upsertLeaseRow();
      }
    } catch (err) {
      this.releaseExclusiveLease();
      throw err;
    }
  }

  private acquireExclusiveLease(leasePath: string): void {
    const leaseDb = new DatabaseSync(leasePath);
    try {
      leaseDb.exec('PRAGMA busy_timeout = 0;');
      leaseDb.exec('PRAGMA locking_mode = EXCLUSIVE;');
      leaseDb.exec('BEGIN EXCLUSIVE;');
      this.leaseDb = leaseDb;
      this.leaseAcquired = true;
    } catch (err) {
      try {
        leaseDb.close();
      } catch {
      }
      throw new WatcherLeaseError(
        `Failed to acquire exclusive hub lease at ${leasePath}: ${formatErrorMessage(err)}`,
        err,
      );
    }
  }

  private releaseExclusiveLease(): void {
    if (!this.leaseDb) return;
    try {
      this.leaseDb.exec('ROLLBACK;');
    } catch {
    }
    try {
      this.leaseDb.close();
    } catch {
    }
    this.leaseDb = null;
    this.leaseAcquired = false;
  }

  private upsertLeaseRow(): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO owner_lease (lease_name, holder_pid, holder_id, acquired_at, heartbeat_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(lease_name) DO UPDATE SET
           holder_pid = excluded.holder_pid,
           holder_id = excluded.holder_id,
           acquired_at = excluded.acquired_at,
           heartbeat_at = excluded.heartbeat_at`,
      )
      .run(this.leaseName, process.pid, this.holderId, now, now);
  }

  touchLeaseHeartbeat(): void {
    if (this.closed) return;
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE owner_lease SET heartbeat_at = ? WHERE lease_name = ? AND holder_id = ?')
      .run(now, this.leaseName, this.holderId);
  }

  transaction<T>(fn: () => T): T {
    if (this.closed) throw new Error('HubDb is closed');
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
    const row = this.db.prepare('SELECT value FROM runtime_meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : fallback;
  }

  setMeta(key: string, value: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO runtime_meta (key, value, updated_at)
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
    try {
      this.db.close();
    } finally {
      this.releaseExclusiveLease();
    }
  }
}

export const WatcherDb = HubDb;
export type WatcherDb = HubDb;

export function openHubDb(options: HubDbOptions = {}): HubDb {
  return new HubDb(options);
}

export const openWatcherDb = openHubDb;
