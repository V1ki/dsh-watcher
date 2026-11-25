import { execFile } from 'node:child_process';
import { createHash, createPrivateKey, randomUUID, sign, type KeyObject } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  GitHubAppSaveInput,
  GitHubAppStatusView,
  GitHubAppVerifyResult,
  GitHubSaveTokenInput,
  GitHubVerifyTokenResult,
} from '@local/dsh-hub/contracts';

const execFileAsync = promisify(execFile);
const DEFAULT_GH_CLI_CACHE_TTL_MS = 5 * 60_000;
const APP_TOKEN_REFRESH_BUFFER_MS = 5 * 60_000;
const DEFAULT_APP_PROFILE = 'github-app';
const GITHUB_API = 'https://api.github.com';
const LOCK_STALE_MS = 10_000;
const LOCK_MAX_ATTEMPTS = 40;
const LOCK_RETRY_MS = 25;

export type GitHubAuthSlot = 'read' | 'act';

export type GitHubAuthResolvedSlot = 'read' | 'act' | 'read-fallback' | 'gh-cli';

export interface GitHubCredentialRecord {
  token?: string;
  login?: string | null;
  isBot?: boolean;
}

export interface GitHubAppCredentialRecord {
  appId: number;
  slug: string | null;
  privateKeyPem: string;
  installationId: number | null;
  defaultRepo: string | null;
}

export interface DshStoredCredentialRecord {
  kind?: string;
  key?: string;
  env?: Record<string, string>;
  payload?: unknown;
}

export interface GitHubCredentialStore {
  get?: (key: string) => Promise<GitHubCredentialRecord | null | undefined> | GitHubCredentialRecord | null | undefined;
  set?: (key: string, record: GitHubCredentialRecord) => Promise<void> | void;
  delete?: (key: string) => Promise<void> | void;
  readRecord?: (
    key: string,
  ) => Promise<DshStoredCredentialRecord | null | undefined> | DshStoredCredentialRecord | null | undefined;
  writeRecord?: (key: string, record: DshStoredCredentialRecord) => Promise<void> | void;
  deleteRecord?: (key: string) => Promise<void> | void;
  resolve?: (
    ref: string,
  ) => Promise<{ value?: string; source?: string } | null | undefined> | { value?: string; source?: string } | null | undefined;
}

export interface GitHubAuthConfig {
  readCredentialProfile?: string;
  actCredentialProfile?: string;
  appCredentialProfile?: string;
  fallbackGhCli?: boolean;
  ghCliCacheTtlMs?: number;
  credentialsFilePath?: string;
}

export interface GitHubAuthToken {
  token: string;
  slot: GitHubAuthResolvedSlot;
  source: 'credentials' | 'gh-cli' | 'github-app';
  isBot: boolean;
  login: string | null;
}

export interface GitHubAuthReadSlotOptions {
  repo?: string;
  signal?: AbortSignal;
}

export interface GitHubAuthAccessor {
  readSlot(slot?: GitHubAuthSlot, opts?: GitHubAuthReadSlotOptions): Promise<GitHubAuthToken | null>;
  clearCache(): void;
  hasDedicatedActToken?(): Promise<{ configured: boolean; login: string | null }>;
  saveToken?(input: GitHubSaveTokenInput): Promise<{ savedTo: 'credentials' | 'file' }>;
  verifyToken?(token?: string, opts?: { signal?: AbortSignal }): Promise<GitHubVerifyTokenResult>;
  saveApp?(
    input: GitHubAppSaveInput,
  ): Promise<{ savedTo: 'credentials' | 'file'; record: Omit<GitHubAppCredentialRecord, 'privateKeyPem'> }>;
  verifyApp?(opts?: { repo?: string; signal?: AbortSignal }): Promise<GitHubAppVerifyResult>;
  deleteApp?(): Promise<{ ok: boolean }>;
  getAppInfo?(): Promise<GitHubAppStatusView>;
}

export interface GitHubLogger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

export type ExecFileLike = (
  file: string,
  args: string[],
  options?: { timeout?: number; signal?: AbortSignal },
) => Promise<{ stdout: string; stderr?: string }>;

export interface HeaderMapLike {
  get(name: string): string | null;
}

export type HeadersInput = HeaderMapLike | Record<string, string | undefined> | undefined;

export interface AuthFetchResponseLike {
  status: number;
  ok: boolean;
  headers?: HeaderMapLike;
  json(): Promise<unknown>;
  text?: () => Promise<string>;
}

export type AuthFetchLike = (url: string, init?: RequestInit) => Promise<AuthFetchResponseLike>;

export interface CreateGitHubAuthOptions {
  ctx?: {
    get?: (name: string) => unknown;
    credentials?: GitHubCredentialStore;
    logger?: ((scope: string) => GitHubLogger) | GitHubLogger;
  };
  credentials?: GitHubCredentialStore;
  authConfig?: GitHubAuthConfig;
  execFileImpl?: ExecFileLike;
  fetchImpl?: AuthFetchLike;
  logger?: GitHubLogger;
}

export const MISSING_NOTIFICATIONS_SCOPE_HINT =
  'GitHub /notifications returned 403 (missing notifications scope). Run `gh auth refresh -s notifications` to enable account notifications; repository & pinned polling will continue normally.';

function readHeaderValue(headers: HeadersInput, name: string): string {
  if (!headers) return '';
  if (typeof (headers as HeaderMapLike).get === 'function') {
    return String((headers as HeaderMapLike).get(name) || '');
  }
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers as Record<string, string | undefined>)) {
    if (k.toLowerCase() === lower) return String(v || '');
  }
  return '';
}

function readRawHeaderValue(headers: HeadersInput, name: string): string | null {
  if (!headers) return null;
  if (typeof (headers as HeaderMapLike).get === 'function') {
    return (headers as HeaderMapLike).get(name);
  }
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers as Record<string, string | undefined>)) {
    if (k.toLowerCase() === lower && v !== undefined) return String(v);
  }
  return null;
}

export function isMissingNotificationsScope(
  status: number,
  headers: HeadersInput,
  bodyText = '',
): boolean {
  if (status !== 403) return false;
  if (readHeaderValue(headers, 'x-ratelimit-remaining') === '0') return false;

  const scopes = readHeaderValue(headers, 'x-oauth-scopes')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (scopes.length > 0) {
    return !scopes.includes('notifications');
  }

  const text = String(bodyText || '').toLowerCase();
  if (text.includes('rate limit')) return false;
  return true;
}

const DSH_KEY_SEGMENT_RE = /^[a-z][a-z0-9-]*$/;
const DSH_FULL_KEY_RE = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;
const DSH_REF_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function extractFromDshRecord(record: DshStoredCredentialRecord | null | undefined): GitHubCredentialRecord | null {
  if (!record || typeof record !== 'object') return null;
  if (record.kind === 'grant' && record.payload && typeof record.payload === 'object') {
    const p = record.payload as Record<string, unknown>;
    const token =
      typeof p.token === 'string'
        ? p.token.trim()
        : typeof p.access_token === 'string'
          ? p.access_token.trim()
          : typeof p.key === 'string'
            ? p.key.trim()
            : '';
    if (!token) return null;
    return {
      token,
      login: typeof p.login === 'string' ? p.login : null,
      isBot: typeof p.isBot === 'boolean' ? p.isBot : undefined,
    };
  }
  if (record.kind === 'api-key') {
    const token =
      typeof record.key === 'string' && record.key.trim()
        ? record.key.trim()
        : typeof record.env?.GH_TOKEN === 'string' && record.env.GH_TOKEN.trim()
          ? record.env.GH_TOKEN.trim()
          : typeof record.env?.GITHUB_TOKEN === 'string' && record.env.GITHUB_TOKEN.trim()
            ? record.env.GITHUB_TOKEN.trim()
            : '';
    if (!token) return null;
    return { token, login: null };
  }
  return null;
}

export function buildDshRecordKeys(profileId: string): string[] {
  const trimmed = profileId.trim();
  if (!trimmed) return [];
  if (DSH_FULL_KEY_RE.test(trimmed)) return [trimmed];
  if (DSH_KEY_SEGMENT_RE.test(trimmed)) {
    return [`connector-github/${trimmed}`, `watcher-github/${trimmed}`, `gh-watch/${trimmed}`];
  }
  return [];
}

function buildDshRefNames(profileId: string): string[] {
  const trimmed = profileId.trim();
  if (!trimmed) return [];
  const refs: string[] = [];
  if (DSH_REF_RE.test(trimmed)) refs.push(trimmed);
  const normalized = trimmed
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (normalized && DSH_REF_RE.test(normalized)) {
    if (!refs.includes(normalized)) refs.push(normalized);
    const withToken = normalized.endsWith('_TOKEN') ? normalized : `${normalized}_TOKEN`;
    if (!refs.includes(withToken)) refs.push(withToken);
  }
  return refs;
}

export function resolveDefaultCredentialsPath(): string {
  const dshHome = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh');
  return path.join(dshHome, '.credentials.yaml');
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withFileLock<T>(targetPath: string, fn: () => Promise<T> | T): Promise<T> {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockPath = `${targetPath}.lock`;
  let fd: number | null = null;

  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt += 1) {
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(fd, `${process.pid}\n${Date.now()}\n`, 'utf8');
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code !== 'EEXIST') throw err;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
      }
      await sleepMs(LOCK_RETRY_MS);
    }
  }

  if (fd === null) {
    throw new Error(`Timed out acquiring credentials lock: ${lockPath}`);
  }

  try {
    return await fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
    }
  }
}

export function writeFileAtomic(targetPath: string, content: string, mode = 0o600): void {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = `${targetPath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  const fd = fs.openSync(tmpPath, 'w', mode);
  try {
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.chmodSync(tmpPath, mode);
  } catch {
  }
  fs.renameSync(tmpPath, targetPath);
}

function unquoteYamlScalar(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === 'null' || trimmed === '~') return '';
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return String(JSON.parse(trimmed));
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function assertValidRsaPrivateKey(privateKeyPem: string): KeyObject {
  const normalized = String(privateKeyPem || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    throw new Error('private_key_required');
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(normalized);
  } catch {
    throw new Error('invalid_rsa_private_key');
  }
  if (key.asymmetricKeyType !== 'rsa') {
    throw new Error('invalid_rsa_private_key');
  }
  return key;
}

export function createGitHubAppJwt(appId: number, privateKeyPem: string, nowMs = Date.now()): string {
  if (!Number.isInteger(appId) || appId <= 0) {
    throw new Error('invalid_app_id');
  }
  const key = assertValidRsaPrivateKey(privateKeyPem);
  const nowSec = Math.floor(nowMs / 1000);
  const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'RS256' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iss: String(appId),
      iat: nowSec - 60,
      exp: nowSec + 9 * 60,
    }),
  ).toString('base64url');
  const unsigned = `${header}.${payload}`;
  const signature = sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url');
  return `${unsigned}.${signature}`;
}

function fingerprintAppCredential(appId: number, privateKeyPem: string): string {
  return createHash('sha256').update(`${appId}:${privateKeyPem}`).digest('hex').slice(0, 16);
}

function normalizePermissionsMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && v.trim()) {
      out[k] = v.trim();
    }
  }
  return out;
}

function normalizeOptionalRepo(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parts = trimmed.split('/');
  if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
    throw new Error(`invalid_repo_format:${trimmed}`);
  }
  return `${parts[0].trim()}/${parts[1].trim()}`;
}

function extractAppFromDshRecord(
  record: DshStoredCredentialRecord | null | undefined,
): GitHubAppCredentialRecord | null {
  if (!record || typeof record !== 'object') return null;
  if (record.kind !== 'grant' || !record.payload || typeof record.payload !== 'object') return null;
  const p = record.payload as Record<string, unknown>;
  const appId = Number(p.appId);
  const privateKeyPem = typeof p.privateKeyPem === 'string' ? p.privateKeyPem.replace(/\r\n/g, '\n').trim() : '';
  if (!Number.isInteger(appId) || appId <= 0 || !privateKeyPem) return null;
  const slug = typeof p.slug === 'string' && p.slug.trim() ? p.slug.trim() : null;
  const instNum = p.installationId !== undefined && p.installationId !== null ? Number(p.installationId) : NaN;
  const installationId = Number.isInteger(instNum) && instNum > 0 ? instNum : null;
  const defaultRepo = typeof p.defaultRepo === 'string' && p.defaultRepo.trim() ? p.defaultRepo.trim() : null;
  return { appId, slug, privateKeyPem, installationId, defaultRepo };
}

function formatGrantRecordLines(recordKey: string, record: GitHubCredentialRecord): string[] {
  const lines = [
    `  ${recordKey}:`,
    '    kind: grant',
    '    payload:',
    `      token: ${JSON.stringify(String(record.token || ''))}`,
  ];
  if (record.login) {
    lines.push(`      login: ${JSON.stringify(record.login)}`);
  }
  if (typeof record.isBot === 'boolean') {
    lines.push(`      isBot: ${record.isBot ? 'true' : 'false'}`);
  }
  return lines;
}

function formatAppGrantRecordLines(recordKey: string, record: GitHubAppCredentialRecord): string[] {
  const lines = [
    `  ${recordKey}:`,
    '    kind: grant',
    '    payload:',
    `      appId: ${record.appId}`,
    `      privateKeyPem: ${JSON.stringify(record.privateKeyPem)}`,
  ];
  if (record.slug) {
    lines.push(`      slug: ${JSON.stringify(record.slug)}`);
  }
  if (record.installationId) {
    lines.push(`      installationId: ${record.installationId}`);
  }
  if (record.defaultRepo) {
    lines.push(`      defaultRepo: ${JSON.stringify(record.defaultRepo)}`);
  }
  return lines;
}

function upsertYamlRecordLines(
  existingText: string,
  recordKey: string,
  entryLines: string[],
  jsonRecord: DshStoredCredentialRecord,
): string {
  const trimmed = existingText.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const existingRecords =
        parsed.records && typeof parsed.records === 'object' && !Array.isArray(parsed.records)
          ? { ...(parsed.records as Record<string, unknown>) }
          : {};
      existingRecords[recordKey] = jsonRecord;
      return `${JSON.stringify({ ...parsed, records: existingRecords }, null, 2)}\n`;
    } catch {
    }
  }

  if (!trimmed) {
    return ['records:', ...entryLines, ''].join('\n');
  }

  const lines = existingText.replace(/\r\n/g, '\n').split('\n');
  let recordsIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^records\s*:\s*(\{\s*\})?\s*$/.test(lines[i])) {
      recordsIdx = i;
      break;
    }
  }

  if (recordsIdx === -1) {
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return [...lines, 'records:', ...entryLines, ''].join('\n');
  }

  if (/^records\s*:\s*\{\s*\}\s*$/.test(lines[recordsIdx])) {
    lines[recordsIdx] = 'records:';
  }

  let sectionEnd = lines.length;
  for (let i = recordsIdx + 1; i < lines.length; i += 1) {
    if (lines[i].trim() !== '' && !/^\s/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }

  let matchStart = -1;
  let matchIndent = 2;
  for (let i = recordsIdx + 1; i < sectionEnd; i += 1) {
    const m = /^(\s+)([^:\s][^:]*?)\s*:\s*$/.exec(lines[i]);
    if (!m) continue;
    const keyName = unquoteYamlScalar(m[2]);
    if (keyName === recordKey) {
      matchStart = i;
      matchIndent = m[1].length;
      break;
    }
  }

  if (matchStart !== -1) {
    let matchEnd = sectionEnd;
    for (let i = matchStart + 1; i < sectionEnd; i += 1) {
      if (lines[i].trim() === '') continue;
      const indent = /^(\s*)/.exec(lines[i])?.[1].length ?? 0;
      if (indent <= matchIndent) {
        matchEnd = i;
        break;
      }
    }
    const nextLines = [...lines.slice(0, matchStart), ...entryLines, ...lines.slice(matchEnd)];
    return `${nextLines.join('\n').replace(/\n*$/, '')}\n`;
  }

  let insertAt = sectionEnd;
  while (insertAt > recordsIdx + 1 && lines[insertAt - 1].trim() === '') {
    insertAt -= 1;
  }
  const nextLines = [...lines.slice(0, insertAt), ...entryLines, ...lines.slice(insertAt)];
  return `${nextLines.join('\n').replace(/\n*$/, '')}\n`;
}

function upsertYamlGrantRecord(
  existingText: string,
  recordKey: string,
  record: GitHubCredentialRecord,
): string {
  return upsertYamlRecordLines(existingText, recordKey, formatGrantRecordLines(recordKey, record), {
    kind: 'grant',
    payload: {
      token: String(record.token || ''),
      ...(record.login ? { login: record.login } : {}),
      ...(typeof record.isBot === 'boolean' ? { isBot: record.isBot } : {}),
    },
  });
}

function upsertYamlAppRecord(
  existingText: string,
  recordKey: string,
  record: GitHubAppCredentialRecord,
): string {
  return upsertYamlRecordLines(existingText, recordKey, formatAppGrantRecordLines(recordKey, record), {
    kind: 'grant',
    payload: {
      appId: record.appId,
      privateKeyPem: record.privateKeyPem,
      ...(record.slug ? { slug: record.slug } : {}),
      ...(record.installationId ? { installationId: record.installationId } : {}),
      ...(record.defaultRepo ? { defaultRepo: record.defaultRepo } : {}),
    },
  });
}

function deleteYamlRecord(existingText: string, recordKey: string): string {
  const trimmed = existingText.trim();
  if (!trimmed) return existingText;
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed.records && typeof parsed.records === 'object' && !Array.isArray(parsed.records)) {
        const nextRecords = { ...(parsed.records as Record<string, unknown>) };
        delete nextRecords[recordKey];
        return `${JSON.stringify({ ...parsed, records: nextRecords }, null, 2)}\n`;
      }
      return existingText;
    } catch {
      return existingText;
    }
  }

  const lines = existingText.replace(/\r\n/g, '\n').split('\n');
  let recordsIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^records\s*:\s*$/.test(lines[i])) {
      recordsIdx = i;
      break;
    }
  }
  if (recordsIdx === -1) return existingText;

  let sectionEnd = lines.length;
  for (let i = recordsIdx + 1; i < lines.length; i += 1) {
    if (lines[i].trim() !== '' && !/^\s/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }

  let matchStart = -1;
  let matchIndent = 2;
  for (let i = recordsIdx + 1; i < sectionEnd; i += 1) {
    const m = /^(\s+)([^:\s][^:]*?)\s*:\s*$/.exec(lines[i]);
    if (!m) continue;
    if (unquoteYamlScalar(m[2]) === recordKey) {
      matchStart = i;
      matchIndent = m[1].length;
      break;
    }
  }
  if (matchStart === -1) return existingText;

  let matchEnd = sectionEnd;
  for (let i = matchStart + 1; i < sectionEnd; i += 1) {
    if (lines[i].trim() === '') continue;
    const indent = /^(\s*)/.exec(lines[i])?.[1].length ?? 0;
    if (indent <= matchIndent) {
      matchEnd = i;
      break;
    }
  }

  const nextLines = [...lines.slice(0, matchStart), ...lines.slice(matchEnd)];
  let hasRemainingEntries = false;
  for (let i = recordsIdx + 1; i < nextLines.length; i += 1) {
    if (nextLines[i].trim() !== '' && !/^\s/.test(nextLines[i])) break;
    if (nextLines[i].trim() !== '') {
      hasRemainingEntries = true;
      break;
    }
  }
  if (!hasRemainingEntries) {
    nextLines[recordsIdx] = 'records: {}';
  }
  return `${nextLines.join('\n').replace(/\n*$/, '')}\n`;
}

function readYamlAppRecord(content: string, recordKey: string): GitHubAppCredentialRecord | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { records?: Record<string, DshStoredCredentialRecord> };
      return extractAppFromDshRecord(parsed.records?.[recordKey]);
    } catch {
      return null;
    }
  }

  const lines = content.replace(/\r\n/g, '\n').split('\n');
  let recordsIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^records\s*:\s*$/.test(lines[i])) {
      recordsIdx = i;
      break;
    }
  }
  if (recordsIdx === -1) return null;

  let sectionEnd = lines.length;
  for (let i = recordsIdx + 1; i < lines.length; i += 1) {
    if (lines[i].trim() !== '' && !/^\s/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }

  let matchStart = -1;
  let matchIndent = 2;
  for (let i = recordsIdx + 1; i < sectionEnd; i += 1) {
    const m = /^(\s+)([^:\s][^:]*?)\s*:\s*$/.exec(lines[i]);
    if (!m) continue;
    if (unquoteYamlScalar(m[2]) === recordKey) {
      matchStart = i;
      matchIndent = m[1].length;
      break;
    }
  }
  if (matchStart === -1) return null;

  let appId = 0;
  let privateKeyPem = '';
  let slug: string | null = null;
  let installationId: number | null = null;
  let defaultRepo: string | null = null;

  for (let i = matchStart + 1; i < sectionEnd; i += 1) {
    if (lines[i].trim() === '') continue;
    const indent = /^(\s*)/.exec(lines[i])?.[1].length ?? 0;
    if (indent <= matchIndent) break;
    const kv = /^\s+(appId|slug|privateKeyPem|installationId|defaultRepo)\s*:\s*(.+?)\s*$/.exec(lines[i]);
    if (!kv) continue;
    const field = kv[1];
    const val = kv[2];
    if (field === 'appId') {
      const parsed = Number(unquoteYamlScalar(val));
      if (Number.isInteger(parsed) && parsed > 0) appId = parsed;
    } else if (field === 'privateKeyPem') {
      privateKeyPem = unquoteYamlScalar(val).replace(/\r\n/g, '\n').trim();
    } else if (field === 'slug') {
      slug = unquoteYamlScalar(val) || null;
    } else if (field === 'installationId') {
      const parsed = Number(unquoteYamlScalar(val));
      if (Number.isInteger(parsed) && parsed > 0) installationId = parsed;
    } else if (field === 'defaultRepo') {
      defaultRepo = unquoteYamlScalar(val) || null;
    }
  }

  if (!appId || !privateKeyPem) return null;
  return { appId, slug, privateKeyPem, installationId, defaultRepo };
}

function readYamlGrantRecord(content: string, recordKey: string): GitHubCredentialRecord | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { records?: Record<string, DshStoredCredentialRecord> };
      return extractFromDshRecord(parsed.records?.[recordKey]);
    } catch {
      return null;
    }
  }

  const lines = content.replace(/\r\n/g, '\n').split('\n');
  let recordsIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^records\s*:\s*$/.test(lines[i])) {
      recordsIdx = i;
      break;
    }
  }
  if (recordsIdx === -1) return null;

  let sectionEnd = lines.length;
  for (let i = recordsIdx + 1; i < lines.length; i += 1) {
    if (lines[i].trim() !== '' && !/^\s/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }

  let matchStart = -1;
  let matchIndent = 2;
  for (let i = recordsIdx + 1; i < sectionEnd; i += 1) {
    const m = /^(\s+)([^:\s][^:]*?)\s*:\s*$/.exec(lines[i]);
    if (!m) continue;
    if (unquoteYamlScalar(m[2]) === recordKey) {
      matchStart = i;
      matchIndent = m[1].length;
      break;
    }
  }
  if (matchStart === -1) return null;

  let token = '';
  let login: string | null = null;
  let isBot: boolean | undefined = undefined;
  for (let i = matchStart + 1; i < sectionEnd; i += 1) {
    if (lines[i].trim() === '') continue;
    const indent = /^(\s*)/.exec(lines[i])?.[1].length ?? 0;
    if (indent <= matchIndent) break;
    const kv = /^\s+(token|access_token|key|login|isBot)\s*:\s*(.+?)\s*$/.exec(lines[i]);
    if (!kv) continue;
    const field = kv[1];
    const val = kv[2];
    if (field === 'token' || field === 'access_token' || field === 'key') {
      if (!token) token = unquoteYamlScalar(val);
    } else if (field === 'login') {
      login = unquoteYamlScalar(val) || null;
    } else if (field === 'isBot') {
      isBot = val === 'true';
    }
  }

  return token ? { token, login, isBot } : null;
}

export function createGitHubAuth(opts: CreateGitHubAuthOptions = {}): GitHubAuthAccessor {
  const {
    ctx,
    credentials,
    authConfig = {},
    execFileImpl = execFileAsync as unknown as ExecFileLike,
    fetchImpl = globalThis.fetch as unknown as AuthFetchLike,
    logger = (typeof ctx?.logger === 'function' ? ctx.logger('connector-github:auth') : ctx?.logger) ?? console,
  } = opts;

  const readProfile = authConfig.readCredentialProfile || 'github-read';
  const actProfile = authConfig.actCredentialProfile || 'github-act';
  const appProfile = authConfig.appCredentialProfile || DEFAULT_APP_PROFILE;
  const fallbackGhCli = authConfig.fallbackGhCli !== false;
  const cacheTtlMs = Math.max(1_000, Number(authConfig.ghCliCacheTtlMs) || DEFAULT_GH_CLI_CACHE_TTL_MS);
  const credentialsFilePath = authConfig.credentialsFilePath || resolveDefaultCredentialsPath();

  let ghCliCache: { token: string | null; fetchedAt: number } | null = null;
  const runtimeOverrides = new Map<string, GitHubCredentialRecord>();
  let runtimeAppOverride: GitHubAppCredentialRecord | null | undefined = undefined;
  const installationCache = new Map<string, number>();
  const inFlightInstallations = new Map<string, Promise<number>>();
  const tokenCache = new Map<string, { token: string; expiresAtMs: number }>();
  const inFlightMints = new Map<string, Promise<{ token: string; expiresAtMs: number }>>();
  let lastAppVerify: {
    verifiedAt: string;
    installationId: number | null;
    permissions?: Record<string, string>;
    lastError: string | null;
  } | null = null;

  function getCredentialStore(): GitHubCredentialStore | null {
    const fromCtx =
      typeof ctx?.get === 'function'
        ? (ctx.get('credentials') as GitHubCredentialStore | undefined)
        : ctx?.credentials;
    return credentials ?? fromCtx ?? null;
  }

  function lookupFromLocalFile(profileId: string): GitHubCredentialRecord | null {
    try {
      if (!fs.existsSync(credentialsFilePath)) return null;
      const content = fs.readFileSync(credentialsFilePath, 'utf8');
      for (const key of buildDshRecordKeys(profileId)) {
        const rec = readYamlGrantRecord(content, key);
        if (rec?.token) return rec;
      }
    } catch {
    }
    return null;
  }

  function lookupAppFromLocalFile(): GitHubAppCredentialRecord | null {
    try {
      if (!fs.existsSync(credentialsFilePath)) return null;
      const content = fs.readFileSync(credentialsFilePath, 'utf8');
      for (const key of buildDshRecordKeys(appProfile)) {
        const rec = readYamlAppRecord(content, key);
        if (rec) return rec;
      }
    } catch {
    }
    return null;
  }

  async function lookupAppCredential(): Promise<GitHubAppCredentialRecord | null> {
    if (runtimeAppOverride !== undefined) {
      return runtimeAppOverride;
    }

    const store = getCredentialStore();
    if (store?.readRecord) {
      try {
        for (const key of buildDshRecordKeys(appProfile)) {
          const rec = extractAppFromDshRecord(await store.readRecord(key));
          if (rec) return rec;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger?.warn?.(`[connector-github] credentials lookup("${appProfile}") failed:`, message);
      }
    }

    if (authConfig.credentialsFilePath || !store) {
      return lookupAppFromLocalFile();
    }
    return null;
  }

  async function persistAppRecord(
    record: GitHubAppCredentialRecord,
  ): Promise<'credentials' | 'file'> {
    const recordKey = buildDshRecordKeys(appProfile)[0] || `connector-github/${appProfile}`;
    const store = getCredentialStore();
    let savedTo: 'credentials' | 'file' = 'file';
    if (store?.writeRecord) {
      await store.writeRecord(recordKey, {
        kind: 'grant',
        payload: {
          appId: record.appId,
          slug: record.slug,
          privateKeyPem: record.privateKeyPem,
          installationId: record.installationId,
          defaultRepo: record.defaultRepo,
        },
      });
      savedTo = 'credentials';
    } else {
      await withFileLock(credentialsFilePath, () => {
        const existing = fs.existsSync(credentialsFilePath)
          ? fs.readFileSync(credentialsFilePath, 'utf8')
          : '';
        const nextText = upsertYamlAppRecord(existing, recordKey, record);
        writeFileAtomic(credentialsFilePath, nextText, 0o600);
      });
      savedTo = 'file';
    }
    runtimeAppOverride = record;
    return savedTo;
  }

  function buildAppJwtHeaders(jwt: string): Record<string, string> {
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${jwt}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'dsh-connector-github/0.1.0',
    };
  }

  async function fetchInstallationIdDeduped(
    cacheKey: string,
    loader: () => Promise<number>,
  ): Promise<number> {
    const cached = installationCache.get(cacheKey);
    if (cached) return cached;
    const existing = inFlightInstallations.get(cacheKey);
    if (existing) return existing;
    const promise = (async () => {
      const id = await loader();
      installationCache.set(cacheKey, id);
      return id;
    })();
    inFlightInstallations.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      if (inFlightInstallations.get(cacheKey) === promise) {
        inFlightInstallations.delete(cacheKey);
      }
    }
  }

  async function resolveInstallationId(
    app: GitHubAppCredentialRecord,
    fingerprint: string,
    jwt: string,
    repo?: string,
    signal?: AbortSignal,
  ): Promise<number> {
    const targetRepo = typeof repo === 'string' && repo.trim() ? repo.trim() : '';
    if (targetRepo) {
      const cacheKey = `${fingerprint}:${targetRepo.toLowerCase()}`;
      return fetchInstallationIdDeduped(cacheKey, async () => {
        const resp = await fetchImpl(`${GITHUB_API}/repos/${targetRepo}/installation`, {
          headers: buildAppJwtHeaders(jwt),
          redirect: 'manual',
          signal,
        });
        if (!resp.ok) {
          throw new Error(`GitHub App installation lookup failed for ${targetRepo}: HTTP ${resp.status}`);
        }
        const data = (await resp.json()) as { id?: unknown };
        const id = Number(data?.id);
        if (!Number.isInteger(id) || id <= 0) {
          throw new Error(`Invalid GitHub App installation id for ${targetRepo}`);
        }
        return id;
      });
    }

    if (app.installationId) {
      return app.installationId;
    }

    if (app.defaultRepo) {
      const cacheKey = `${fingerprint}:${app.defaultRepo.toLowerCase()}`;
      return fetchInstallationIdDeduped(cacheKey, async () => {
        const resp = await fetchImpl(`${GITHUB_API}/repos/${app.defaultRepo}/installation`, {
          headers: buildAppJwtHeaders(jwt),
          redirect: 'manual',
          signal,
        });
        if (!resp.ok) {
          throw new Error(`GitHub App installation lookup failed for ${app.defaultRepo}: HTTP ${resp.status}`);
        }
        const data = (await resp.json()) as { id?: unknown };
        const id = Number(data?.id);
        if (!Number.isInteger(id) || id <= 0) {
          throw new Error(`Invalid GitHub App installation id for ${app.defaultRepo}`);
        }
        return id;
      });
    }

    const fallbackKey = `${fingerprint}:*`;
    return fetchInstallationIdDeduped(fallbackKey, async () => {
      const resp = await fetchImpl(`${GITHUB_API}/app/installations?per_page=1`, {
        headers: buildAppJwtHeaders(jwt),
        redirect: 'manual',
        signal,
      });
      if (!resp.ok) {
        throw new Error(`GitHub App installations lookup failed: HTTP ${resp.status}`);
      }
      const list = (await resp.json()) as Array<{ id?: unknown }>;
      const firstId = Array.isArray(list) && list.length > 0 ? Number(list[0]?.id) : NaN;
      if (!Number.isInteger(firstId) || firstId <= 0) {
        throw new Error('No GitHub App installation found');
      }
      return firstId;
    });
  }

  async function mintInstallationToken(
    app: GitHubAppCredentialRecord,
    readOpts: GitHubAuthReadSlotOptions = {},
  ): Promise<string> {
    const fingerprint = fingerprintAppCredential(app.appId, app.privateKeyPem);
    const jwt = createGitHubAppJwt(app.appId, app.privateKeyPem);
    const installationId = await resolveInstallationId(
      app,
      fingerprint,
      jwt,
      readOpts.repo,
      readOpts.signal,
    );
    const repoTrimmed = typeof readOpts.repo === 'string' ? readOpts.repo.trim() : '';
    const repoName = repoTrimmed.includes('/') ? repoTrimmed.split('/')[1]?.trim() || '' : '';
    const repoScope = repoName ? repoName.toLowerCase() : '*';
    const cacheKey = `${fingerprint}:${installationId}:${repoScope}`;

    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expiresAtMs - APP_TOKEN_REFRESH_BUFFER_MS > Date.now()) {
      return cached.token;
    }

    const existingFlight = inFlightMints.get(cacheKey);
    if (existingFlight) {
      const awaited = await existingFlight;
      return awaited.token;
    }

    const mintPromise = (async (): Promise<{ token: string; expiresAtMs: number }> => {
      const headers = {
        ...buildAppJwtHeaders(jwt),
        'Content-Type': 'application/json',
      };
      const endpoint = `${GITHUB_API}/app/installations/${installationId}/access_tokens`;
      let resp = await fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body: repoName ? JSON.stringify({ repositories: [repoName] }) : undefined,
        redirect: 'manual',
        signal: readOpts.signal,
      });

      if (repoName && resp.status === 422) {
        resp = await fetchImpl(endpoint, {
          method: 'POST',
          headers,
          redirect: 'manual',
          signal: readOpts.signal,
        });
      }

      if (!resp.ok) {
        throw new Error(`GitHub App token mint failed: HTTP ${resp.status}`);
      }

      const data = (await resp.json()) as { token?: unknown; expires_at?: unknown };
      const mintedToken = typeof data?.token === 'string' ? data.token.trim() : '';
      const expiresAtStr = typeof data?.expires_at === 'string' ? data.expires_at.trim() : '';
      const expiresAtMs = Date.parse(expiresAtStr);
      if (!mintedToken || Number.isNaN(expiresAtMs)) {
        throw new Error('GitHub App token mint returned invalid payload');
      }

      const entry = { token: mintedToken, expiresAtMs };
      tokenCache.set(cacheKey, entry);
      return entry;
    })();

    inFlightMints.set(cacheKey, mintPromise);
    try {
      const minted = await mintPromise;
      return minted.token;
    } finally {
      if (inFlightMints.get(cacheKey) === mintPromise) {
        inFlightMints.delete(cacheKey);
      }
    }
  }

  async function lookupCredential(profileId: string): Promise<GitHubCredentialRecord | null> {
    if (!profileId) return null;
    const override = runtimeOverrides.get(profileId);
    if (override?.token) return override;

    const store = getCredentialStore();
    if (store) {
      try {
        if (typeof store.readRecord === 'function') {
          for (const key of buildDshRecordKeys(profileId)) {
            const rec = extractFromDshRecord(await store.readRecord(key));
            if (rec?.token) return rec;
          }
        }
        if (typeof store.resolve === 'function') {
          for (const ref of buildDshRefNames(profileId)) {
            const resolved = await store.resolve(ref);
            const value = typeof resolved?.value === 'string' ? resolved.value.trim() : '';
            if (value) return { token: value, login: null };
          }
        }
        if (typeof store.get === 'function') {
          const prefixed = await store.get(`gh-watch:${profileId}`);
          if (prefixed?.token) return prefixed;
          const direct = await store.get(profileId);
          if (direct?.token) return direct;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger?.warn?.(`[connector-github] credentials lookup("${profileId}") failed:`, message);
      }
    }

    if (authConfig.credentialsFilePath || !store) {
      return lookupFromLocalFile(profileId);
    }
    return null;
  }

  async function readGhCliToken(): Promise<string | null> {
    if (!fallbackGhCli) return null;
    const now = Date.now();
    if (ghCliCache && now - ghCliCache.fetchedAt < cacheTtlMs) {
      return ghCliCache.token;
    }
    try {
      const result = await execFileImpl('gh', ['auth', 'token'], { timeout: 5_000 });
      const token = String(result?.stdout || '').trim() || null;
      ghCliCache = { token, fetchedAt: now };
      return token;
    } catch {
      ghCliCache = { token: null, fetchedAt: now };
      return null;
    }
  }

  async function readSlot(
    slot: GitHubAuthSlot = 'read',
    readOpts: GitHubAuthReadSlotOptions = {},
  ): Promise<GitHubAuthToken | null> {
    if (slot === 'act') {
      const appRecord = await lookupAppCredential();
      if (appRecord) {
        const token = await mintInstallationToken(appRecord, readOpts);
        return {
          token,
          slot: 'act',
          source: 'github-app',
          isBot: true,
          login: appRecord.slug ? `${appRecord.slug}[bot]` : null,
        };
      }

      const actRecord = await lookupCredential(actProfile);
      if (actRecord?.token) {
        return {
          token: String(actRecord.token),
          slot: 'act',
          source: 'credentials',
          isBot: actRecord.isBot !== false,
          login: actRecord.login ?? null,
        };
      }

      const readFallback = await readSlot('read', readOpts);
      if (readFallback?.token) {
        return {
          token: readFallback.token,
          slot: 'read-fallback',
          source: readFallback.source,
          isBot: false,
          login: readFallback.login,
        };
      }
      return null;
    }

    const readRecord = await lookupCredential(readProfile);
    if (readRecord?.token) {
      return {
        token: String(readRecord.token),
        slot: 'read',
        source: 'credentials',
        isBot: Boolean(readRecord.isBot),
        login: readRecord.login ?? null,
      };
    }

    const cliToken = await readGhCliToken();
    if (cliToken) {
      return {
        token: cliToken,
        slot: 'gh-cli',
        source: 'gh-cli',
        isBot: false,
        login: null,
      };
    }

    return null;
  }

  async function hasDedicatedActToken(): Promise<{ configured: boolean; login: string | null }> {
    const actRecord = await lookupCredential(actProfile);
    if (actRecord?.token) {
      return { configured: true, login: actRecord.login ?? null };
    }
    return { configured: false, login: null };
  }

  async function saveToken(input: GitHubSaveTokenInput): Promise<{ savedTo: 'credentials' | 'file' }> {
    const slot: GitHubAuthSlot = input.slot === 'act' ? 'act' : 'read';
    const token = String(input.token || '').trim();
    if (!token) {
      throw new Error('token_required');
    }
    const profileId = slot === 'act' ? actProfile : readProfile;
    const recordKey = buildDshRecordKeys(profileId)[0] || `connector-github/${profileId}`;
    const record: GitHubCredentialRecord = {
      token,
      login: input.login?.trim() || null,
      isBot: slot === 'act' ? input.isBot !== false : Boolean(input.isBot),
    };

    const store = getCredentialStore();
    let savedTo: 'credentials' | 'file' = 'file';
    if (store?.writeRecord) {
      await store.writeRecord(recordKey, {
        kind: 'grant',
        payload: {
          token: record.token,
          login: record.login,
          isBot: record.isBot,
        },
      });
      savedTo = 'credentials';
    } else if (store?.set) {
      await store.set(`gh-watch:${profileId}`, record);
      savedTo = 'credentials';
    } else {
      await withFileLock(credentialsFilePath, () => {
        const existing = fs.existsSync(credentialsFilePath)
          ? fs.readFileSync(credentialsFilePath, 'utf8')
          : '';
        const nextText = upsertYamlGrantRecord(existing, recordKey, record);
        writeFileAtomic(credentialsFilePath, nextText, 0o600);
      });
      savedTo = 'file';
    }

    runtimeOverrides.set(profileId, record);
    ghCliCache = null;
    return { savedTo };
  }

  async function verifyToken(
    token?: string,
    verifyOpts: { signal?: AbortSignal } = {},
  ): Promise<GitHubVerifyTokenResult> {
    let resolvedToken = typeof token === 'string' ? token.trim() : '';
    if (!resolvedToken) {
      const slotAuth = await readSlot('read');
      resolvedToken = slotAuth?.token ?? '';
    }
    if (!resolvedToken) {
      return {
        ok: false,
        login: null,
        scopes: [],
        notificationsScopeMissing: true,
        error: 'missing_token',
      };
    }

    try {
      const resp = await fetchImpl(`${GITHUB_API}/user`, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${resolvedToken}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'dsh-connector-github/0.1.0',
        },
        signal: verifyOpts.signal,
      });
      const rawScopes = readRawHeaderValue(resp.headers, 'x-oauth-scopes');
      const scopes = (rawScopes || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const notificationsScopeMissing = !resp.ok
        ? true
        : rawScopes !== null
          ? !scopes.some((s) => s.toLowerCase() === 'notifications')
          : false;

      if (!resp.ok) {
        return {
          ok: false,
          login: null,
          scopes,
          notificationsScopeMissing,
          status: resp.status,
          error: `GitHub GET /user failed: HTTP ${resp.status}`,
        };
      }

      const data = (await resp.json()) as { login?: unknown };
      const login = typeof data?.login === 'string' ? data.login : null;
      return {
        ok: true,
        login,
        scopes,
        notificationsScopeMissing,
        status: resp.status,
      };
    } catch (err) {
      return {
        ok: false,
        login: null,
        scopes: [],
        notificationsScopeMissing: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async function saveApp(
    input: GitHubAppSaveInput,
  ): Promise<{ savedTo: 'credentials' | 'file'; record: Omit<GitHubAppCredentialRecord, 'privateKeyPem'> }> {
    const appId = Number(input.appId);
    if (!Number.isInteger(appId) || appId <= 0) {
      throw new Error('invalid_app_id');
    }
    const existing = await lookupAppCredential();
    const rawPem = typeof input.privateKeyPem === 'string' ? input.privateKeyPem.replace(/\r\n/g, '\n').trim() : '';
    const privateKeyPem = rawPem || existing?.privateKeyPem || '';
    assertValidRsaPrivateKey(privateKeyPem);

    const slug =
      input.slug !== undefined
        ? (input.slug.trim() || null)
        : (existing?.slug ?? null);

    let installationId: number | null = existing?.installationId ?? null;
    if (input.installationId !== undefined) {
      const parsedInst = Number(input.installationId);
      if (!Number.isInteger(parsedInst) || parsedInst <= 0) {
        throw new Error('invalid_installation_id');
      }
      installationId = parsedInst;
    }

    const defaultRepo =
      input.repo !== undefined
        ? normalizeOptionalRepo(input.repo)
        : (existing?.defaultRepo ?? null);

    const nextRecord: GitHubAppCredentialRecord = {
      appId,
      slug,
      privateKeyPem,
      installationId,
      defaultRepo,
    };

    const savedTo = await persistAppRecord(nextRecord);
    installationCache.clear();
    inFlightInstallations.clear();
    tokenCache.clear();
    inFlightMints.clear();
    lastAppVerify = null;

    return {
      savedTo,
      record: {
        appId: nextRecord.appId,
        slug: nextRecord.slug,
        installationId: nextRecord.installationId,
        defaultRepo: nextRecord.defaultRepo,
      },
    };
  }

  async function verifyApp(
    verifyOpts: { repo?: string; signal?: AbortSignal } = {},
  ): Promise<GitHubAppVerifyResult> {
    const app = await lookupAppCredential();
    if (!app) {
      return { ok: false, error: 'github_app_not_configured' };
    }

    let jwt: string;
    try {
      jwt = createGitHubAppJwt(app.appId, app.privateKeyPem);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'invalid_rsa_private_key';
      lastAppVerify = {
        verifiedAt: new Date().toISOString(),
        installationId: app.installationId,
        lastError: message,
      };
      return {
        ok: false,
        appId: app.appId,
        slug: app.slug,
        botLogin: app.slug ? `${app.slug}[bot]` : null,
        error: message,
      };
    }

    try {
      const appResp = await fetchImpl(`${GITHUB_API}/app`, {
        headers: buildAppJwtHeaders(jwt),
        redirect: 'manual',
        signal: verifyOpts.signal,
      });
      if (!appResp.ok) {
        const error = `GitHub GET /app failed: HTTP ${appResp.status}`;
        lastAppVerify = {
          verifiedAt: new Date().toISOString(),
          installationId: app.installationId,
          lastError: error,
        };
        return {
          ok: false,
          appId: app.appId,
          slug: app.slug,
          botLogin: app.slug ? `${app.slug}[bot]` : null,
          status: appResp.status,
          error,
        };
      }

      const appData = (await appResp.json()) as { id?: unknown; slug?: unknown };
      if (typeof appData?.id === 'number' && appData.id !== app.appId) {
        const error = `app_id_mismatch: expected ${app.appId}, got ${appData.id}`;
        lastAppVerify = {
          verifiedAt: new Date().toISOString(),
          installationId: app.installationId,
          lastError: error,
        };
        return {
          ok: false,
          appId: app.appId,
          slug: app.slug,
          botLogin: app.slug ? `${app.slug}[bot]` : null,
          status: appResp.status,
          error,
        };
      }

      const discoveredSlug =
        typeof appData?.slug === 'string' && appData.slug.trim() ? appData.slug.trim() : app.slug;
      const botLogin = discoveredSlug ? `${discoveredSlug}[bot]` : null;

      const targetRepo =
        typeof verifyOpts.repo === 'string' && verifyOpts.repo.trim()
          ? normalizeOptionalRepo(verifyOpts.repo)
          : app.defaultRepo;

      let discoveredInstallationId: number | null = app.installationId;
      let permissions: Record<string, string> = {};

      if (targetRepo) {
        const instResp = await fetchImpl(`${GITHUB_API}/repos/${targetRepo}/installation`, {
          headers: buildAppJwtHeaders(jwt),
          redirect: 'manual',
          signal: verifyOpts.signal,
        });
        if (!instResp.ok) {
          if (discoveredSlug && discoveredSlug !== app.slug) {
            await persistAppRecord({ ...app, slug: discoveredSlug });
          }
          const error = `GitHub App installation lookup failed for ${targetRepo}: HTTP ${instResp.status}`;
          lastAppVerify = {
            verifiedAt: new Date().toISOString(),
            installationId: app.installationId,
            lastError: error,
          };
          return {
            ok: false,
            appId: app.appId,
            slug: discoveredSlug,
            botLogin,
            repository: targetRepo,
            status: instResp.status,
            error,
          };
        }
        const instData = (await instResp.json()) as { id?: unknown; permissions?: unknown };
        const instId = Number(instData?.id);
        if (Number.isInteger(instId) && instId > 0) {
          discoveredInstallationId = instId;
          installationCache.set(
            `${fingerprintAppCredential(app.appId, app.privateKeyPem)}:${targetRepo.toLowerCase()}`,
            instId,
          );
        }
        permissions = normalizePermissionsMap(instData?.permissions);
      } else {
        const instResp = await fetchImpl(`${GITHUB_API}/app/installations?per_page=5`, {
          headers: buildAppJwtHeaders(jwt),
          redirect: 'manual',
          signal: verifyOpts.signal,
        });
        if (!instResp.ok) {
          if (discoveredSlug && discoveredSlug !== app.slug) {
            await persistAppRecord({ ...app, slug: discoveredSlug });
          }
          const error = `GitHub GET /app/installations failed: HTTP ${instResp.status}`;
          lastAppVerify = {
            verifiedAt: new Date().toISOString(),
            installationId: app.installationId,
            lastError: error,
          };
          return {
            ok: false,
            appId: app.appId,
            slug: discoveredSlug,
            botLogin,
            status: instResp.status,
            error,
          };
        }
        const instList = (await instResp.json()) as Array<{ id?: unknown; permissions?: unknown }>;
        const chosen = Array.isArray(instList)
          ? (instList.find((item) => app.installationId && Number(item?.id) === app.installationId) ?? instList[0])
          : undefined;
        if (chosen) {
          const instId = Number(chosen.id);
          if (Number.isInteger(instId) && instId > 0) {
            discoveredInstallationId = instId;
          }
          permissions = normalizePermissionsMap(chosen.permissions);
        }
      }

      const shouldPersist =
        (discoveredSlug && discoveredSlug !== app.slug) ||
        (discoveredInstallationId && !app.installationId);
      if (shouldPersist) {
        await persistAppRecord({
          ...app,
          slug: discoveredSlug,
          installationId: app.installationId ?? discoveredInstallationId,
        });
      }

      lastAppVerify = {
        verifiedAt: new Date().toISOString(),
        installationId: discoveredInstallationId,
        permissions,
        lastError: null,
      };

      return {
        ok: true,
        appId: app.appId,
        slug: discoveredSlug,
        botLogin,
        installationId: discoveredInstallationId,
        repository: targetRepo ?? null,
        permissions,
        commentsAllowed: permissions.issues === 'write',
        pullRequestsAllowed: permissions.pull_requests === 'write',
        status: 200,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      lastAppVerify = {
        verifiedAt: new Date().toISOString(),
        installationId: app.installationId,
        lastError: error,
      };
      return {
        ok: false,
        appId: app.appId,
        slug: app.slug,
        botLogin: app.slug ? `${app.slug}[bot]` : null,
        error,
      };
    }
  }

  async function deleteApp(): Promise<{ ok: boolean }> {
    const recordKeys = buildDshRecordKeys(appProfile);
    const store = getCredentialStore();

    if (store?.deleteRecord) {
      for (const key of recordKeys) {
        await store.deleteRecord(key);
      }
    } else if (store?.delete) {
      await store.delete(`gh-watch:${appProfile}`);
      await store.delete(appProfile);
    } else if (store?.writeRecord) {
      for (const key of recordKeys) {
        await store.writeRecord(key, { kind: 'grant', payload: {} });
      }
    }

    if ((!store || authConfig.credentialsFilePath) && fs.existsSync(credentialsFilePath)) {
      await withFileLock(credentialsFilePath, () => {
        if (!fs.existsSync(credentialsFilePath)) return;
        const existing = fs.readFileSync(credentialsFilePath, 'utf8');
        let nextText = existing;
        for (const key of recordKeys) {
          nextText = deleteYamlRecord(nextText, key);
        }
        if (nextText !== existing) {
          writeFileAtomic(credentialsFilePath, nextText, 0o600);
        }
      });
    }

    runtimeAppOverride = null;
    installationCache.clear();
    inFlightInstallations.clear();
    tokenCache.clear();
    inFlightMints.clear();
    lastAppVerify = null;
    return { ok: true };
  }

  async function getAppInfo(): Promise<GitHubAppStatusView> {
    const app = await lookupAppCredential();
    if (!app) {
      return {
        configured: false,
        appId: null,
        slug: null,
        defaultRepo: null,
        installationId: null,
        botLogin: null,
        lastVerifiedAt: null,
        lastError: null,
      };
    }
    return {
      configured: true,
      appId: app.appId,
      slug: app.slug,
      defaultRepo: app.defaultRepo,
      installationId: app.installationId ?? lastAppVerify?.installationId ?? null,
      botLogin: app.slug ? `${app.slug}[bot]` : null,
      ...(lastAppVerify?.permissions ? { permissions: { ...lastAppVerify.permissions } } : {}),
      lastVerifiedAt: lastAppVerify?.verifiedAt ?? null,
      lastError: lastAppVerify?.lastError ?? null,
    };
  }

  function clearCache(): void {
    ghCliCache = null;
    installationCache.clear();
    inFlightInstallations.clear();
    tokenCache.clear();
    inFlightMints.clear();
  }

  return {
    readSlot,
    hasDedicatedActToken,
    saveToken,
    verifyToken,
    saveApp,
    verifyApp,
    deleteApp,
    getAppInfo,
    clearCache,
  };
}
