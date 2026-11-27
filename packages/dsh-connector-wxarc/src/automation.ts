import { randomUUID } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as pause } from 'node:timers/promises';
import type {
  AdminWechatHandleResult,
  AdminWechatHandler,
  AdminWechatMessage,
} from '@local/dsh-hub/contracts';
import { workspaceKey } from './admin.js';
import { decide } from './ai.js';
import type { WechatApprovals } from './approvals.js';
import type { AgentBridge } from './agent.js';
import { ChatBatches, messagesOf } from './batch.js';
import { messageBody } from './core.js';
import {
  loadLocalImage,
  outgoingImage,
  pixelDigest,
  prepareImage,
  type OutgoingImageData,
} from './outgoing-image.js';
import { replyTarget } from './reply-target.js';
import { archiveHistory, matchHistory, OBSTRUCTED, retryableDetail } from './resend.js';
import { sourceMessage, validateAccount } from './source.js';

export interface PolicyRule {
  kind: 'text' | 'sns';
  sourceId: string;
  title: string;
  search: string;
  wechatId: string;
  testPrefix?: string;
  uniqueTitle?: boolean;
  route?: string;
}

export interface AutomationPolicy {
  enabled: boolean;
  mode: 'draft' | 'send';
  provider: string;
  model: string;
  ownId: string;
  instructions: string;
  personaId: string;
  controllerId: string;
  adminIds: string[];
  allChats: boolean;
  moments: 'off' | 'draft' | 'send';
  momentsNotBefore: number;
  rules: PolicyRule[];
  maxAgeSeconds: number;
  debounceMs: number;
  debounceMaxMessages: number;
}

export interface AutomationSettings {
  revision: number;
  policy: AutomationPolicy;
  cursor: number;
}

export interface DeliveryPartRow {
  job_id: number;
  part_index: number;
  text: string;
  status: string;
  detail: string;
  updated_at: number;
  clicked_at: number | null;
}

export interface AutomationJobRow {
  id: number;
  event_seq: number;
  source_key: string;
  revision: number;
  event: string;
  rule: string;
  status: string;
  decision: string | null;
  detail: string;
  created_at: number;
  updated_at: number;
  attempted_at?: number | null;
  batch_parent?: number | null;
}

export interface AutomationJob extends Omit<AutomationJobRow, 'event' | 'rule' | 'decision'> {
  deliveries: DeliveryPartRow[];
  event: Record<string, any>;
  rule: Record<string, any>;
  decision: Record<string, any> | null;
}

export type ProactiveDeliveryStatus = 'sent' | 'staged' | 'uncertain' | 'skipped' | 'failed';

export interface ProactiveSendInput {
  idempotencyKey: string;
  session: string;
  text: string | string[];
  imagePath?: string;
  mode?: 'send' | 'draft';
  reason?: string;
  expectedOwnId?: string;
}

export interface ProactiveSendResult {
  status: ProactiveDeliveryStatus;
  deliveryId?: string;
  detail?: string;
}

export interface ProactiveDeliveryRow {
  id: string;
  idempotency_key: string;
  session: string;
  parts_json: string;
  mode: string;
  status: string;
  detail: string;
  reason: string;
  clicked_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface SessionMessageSummary {
  seq: number;
  chatId: string;
  sender?: string;
  senderId?: string;
  isOwn: boolean;
  text: string;
  timestamp: number;
}

export interface RecentSessionMessagesParams {
  session: string;
  limit?: number;
  sinceTs?: number;
}

export interface RecentSessionMessagesResult {
  session: string;
  chatId: string;
  healthy: boolean;
  paused: boolean;
  chatPaused: boolean;
  ownId?: string;
  messages: SessionMessageSummary[];
  lastMessageAt: number | null;
  secondsSinceLastMessage: number | null;
  ownSpokeSince: boolean;
}

export interface MemoNudgeQueueInput {
  memoId: string;
  chatId: string;
  targetSessionId?: string | null;
  title?: string;
  basis: string;
  windowStart?: string | null;
  windowEnd?: string | null;
}

export interface MemoNudgeQueueResult {
  status: 'queued' | 'skipped' | 'failed';
  jobId?: number;
  sessionId?: string;
  detail?: string;
}

export interface AutomationOptions {
  store: { dir: string; db: DatabaseSync };
  listener: {
    status(): { healthy: boolean; [key: string]: unknown };
    wechatRoot?: string;
    tick?: () => Promise<void>;
    enrichQuote?: (event: any) => Promise<any>;
  };
  llm?: any;
  cua: any;
  wxarcHome: string;
  resolveSource?: (home: string, event: any) => any;
  resolveTarget?: (event: any, root: string | undefined, signal?: AbortSignal) => Promise<any>;
  personas?: any;
  enrich?: (event: any, rule: any, signal?: AbortSignal) => Promise<any>;
  identify?: (event: any, signal?: AbortSignal) => Promise<any>;
  prepareOutgoingImage?: typeof prepareImage;
  logger?: { warn?: (...args: unknown[]) => void; info?: (...args: unknown[]) => void };
  now?: () => number;
  proactiveRetryDelaysMs?: readonly number[];
}

const DEFAULT: AutomationPolicy = {
  enabled: false,
  mode: 'draft',
  provider: '',
  model: '',
  ownId: '',
  instructions: '',
  personaId: '',
  controllerId: '',
  adminIds: [],
  allChats: false,
  moments: 'off',
  momentsNotBefore: 0,
  rules: [],
  maxAgeSeconds: 300,
  debounceMs: 10000,
  debounceMaxMessages: 10,
};

export const MAX_PROACTIVE_SEGMENTS = 6;
export const MAX_PROACTIVE_SEGMENT_CHARS = 1500;
export const PROACTIVE_AUTO_SPLIT_TARGET_CHARS = 1200;
export const MAX_PROACTIVE_TOTAL_CHARS = 6000;
const DEFAULT_RECENT_LIMIT = 20;
const MAX_RECENT_LIMIT = 200;
const DEFAULT_PROACTIVE_RETRY_DELAYS_MS: readonly number[] = [2000, 5000];
const BLANK_LINE_RE = /\r?\n[ \t]*\r?\n/g;
const SENTENCE_END_RE = /[。！？.!?;；]/;

function isRetryableProactivePrepareError(msg: string): boolean {
  return (
    msg === OBSTRUCTED ||
    /OBSTRUCTED|微信会话列表被遮挡/.test(msg) ||
    retryableDetail(msg)
  );
}

function policyDefaults(input: Record<string, any>): AutomationPolicy {
  const { debounceMaxMs: _removed, maxPerHour: _removedHourlyCap, ...current } = input;
  return { ...DEFAULT, ...current };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function safeHardCutIndex(text: string, maxChars: number, minIndex: number): number {
  let cut = Math.min(maxChars, text.length);
  if (
    cut > minIndex &&
    cut < text.length &&
    isHighSurrogate(text.charCodeAt(cut - 1)) &&
    isLowSurrogate(text.charCodeAt(cut))
  ) {
    cut -= 1;
  }
  return cut;
}

function findBoundaryCut(
  text: string,
  minCut: number,
  maxChars: number,
): { headEnd: number; nextStart: number } | null {
  let blankMatch: { headEnd: number; nextStart: number } | null = null;
  BLANK_LINE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BLANK_LINE_RE.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (start > maxChars) {
      break;
    }
    if (start >= minCut && text.slice(0, start).trim().length > 0) {
      blankMatch = { headEnd: start, nextStart: end };
    }
  }
  if (blankMatch) {
    return blankMatch;
  }

  for (let i = Math.min(maxChars, text.length - 1); i >= minCut; i--) {
    if (text.charCodeAt(i) === 10) {
      const headEnd = i > 0 && text.charCodeAt(i - 1) === 13 ? i - 1 : i;
      if (headEnd > 0 && text.slice(0, headEnd).trim().length > 0) {
        return { headEnd, nextStart: i + 1 };
      }
    }
  }

  for (let i = Math.min(maxChars, text.length) - 1; i >= minCut - 1 && i >= 0; i--) {
    if (SENTENCE_END_RE.test(text[i])) {
      const cut = i + 1;
      if (cut >= minCut && cut <= maxChars) {
        return { headEnd: cut, nextStart: cut };
      }
    }
  }

  return null;
}

function splitProactiveSegment(
  text: string,
  maxChars: number,
  maxSegments?: number,
): string[] {
  const parts: string[] = [];
  let remaining = text.trim();
  const minPreferredBase = Math.max(1, Math.floor(maxChars * 0.3));

  while (remaining.length > maxChars) {
    const remainingBudget =
      maxSegments !== undefined ? Math.max(1, maxSegments - parts.length) : undefined;
    if (remainingBudget === 1) {
      break;
    }
    const minRequired =
      remainingBudget !== undefined
        ? Math.max(1, remaining.length - (remainingBudget - 1) * maxChars)
        : 1;
    const minPreferred = Math.max(minRequired, Math.min(maxChars, minPreferredBase));

    const boundary =
      findBoundaryCut(remaining, minPreferred, maxChars) ??
      (minRequired < minPreferred ? findBoundaryCut(remaining, minRequired, maxChars) : null);

    let head: string;
    let tail: string;
    if (boundary) {
      head = remaining.slice(0, boundary.headEnd).trim();
      tail = remaining.slice(boundary.nextStart).trim();
    } else {
      const cut = safeHardCutIndex(remaining, maxChars, minRequired);
      head = remaining.slice(0, cut).trim();
      tail = remaining.slice(cut).trim();
    }

    if (!head || !tail) {
      const cut = safeHardCutIndex(remaining, maxChars, 1);
      head = remaining.slice(0, cut).trim();
      tail = remaining.slice(cut).trim();
      if (!head || !tail) {
        break;
      }
    }

    parts.push(head);
    remaining = tail;
  }

  if (remaining) {
    parts.push(remaining);
  }
  return parts;
}

export function normalizeProactiveParts(
  text: string | string[] | undefined,
  allowEmpty = false,
): { ok: true; parts: string[] } | { ok: false; error: string } {
  if (allowEmpty) {
    if (text === undefined || text === null) {
      return { ok: true, parts: [] };
    }
    if (typeof text === 'string' && !text.trim()) {
      return { ok: true, parts: [] };
    }
    if (Array.isArray(text) && text.length === 0) {
      return { ok: true, parts: [] };
    }
  }
  const rawList = Array.isArray(text) ? text : [text];
  if (rawList.length < 1 || rawList.length > MAX_PROACTIVE_SEGMENTS) {
    return {
      ok: false,
      error: `Message must contain between 1 and ${MAX_PROACTIVE_SEGMENTS} segments`,
    };
  }
  const trimmedList: string[] = [];
  let totalChars = 0;
  for (const item of rawList) {
    if (typeof item !== 'string') {
      return { ok: false, error: 'Each message segment must be a string' };
    }
    const trimmed = item.trim();
    if (!trimmed) {
      return { ok: false, error: 'Message segments must not be empty' };
    }
    totalChars += trimmed.length;
    if (totalChars > MAX_PROACTIVE_TOTAL_CHARS) {
      return {
        ok: false,
        error: `Total message length exceeds ${MAX_PROACTIVE_TOTAL_CHARS} characters`,
      };
    }
    trimmedList.push(trimmed);
  }

  const targetParts: string[] = [];
  for (const segment of trimmedList) {
    if (segment.length <= PROACTIVE_AUTO_SPLIT_TARGET_CHARS) {
      targetParts.push(segment);
    } else {
      targetParts.push(...splitProactiveSegment(segment, PROACTIVE_AUTO_SPLIT_TARGET_CHARS));
    }
  }
  if (
    targetParts.length <= MAX_PROACTIVE_SEGMENTS &&
    targetParts.every((part) => part.length <= MAX_PROACTIVE_SEGMENT_CHARS)
  ) {
    return { ok: true, parts: targetParts };
  }

  const minSegmentsPerItem = trimmedList.map((segment) =>
    Math.max(1, Math.ceil(segment.length / MAX_PROACTIVE_SEGMENT_CHARS)),
  );
  const totalMinSegments = minSegmentsPerItem.reduce((sum, count) => sum + count, 0);
  if (totalMinSegments > MAX_PROACTIVE_SEGMENTS) {
    return {
      ok: false,
      error: `Message exceeds maximum of ${MAX_PROACTIVE_SEGMENTS} segments after splitting (requires at least ${totalMinSegments} segments)`,
    };
  }

  let extraBudget = MAX_PROACTIVE_SEGMENTS - totalMinSegments;
  const packedParts: string[] = [];
  for (let i = 0; i < trimmedList.length; i++) {
    const segment = trimmedList[i];
    if (segment.length <= MAX_PROACTIVE_SEGMENT_CHARS) {
      packedParts.push(segment);
      continue;
    }
    const minSegs = minSegmentsPerItem[i];
    const budget = minSegs + extraBudget;
    const chunks = splitProactiveSegment(segment, MAX_PROACTIVE_SEGMENT_CHARS, budget);
    extraBudget = Math.max(0, extraBudget - (chunks.length - minSegs));
    packedParts.push(...chunks);
  }

  if (
    packedParts.length > MAX_PROACTIVE_SEGMENTS ||
    packedParts.some((part) => part.length > MAX_PROACTIVE_SEGMENT_CHARS)
  ) {
    return {
      ok: false,
      error: `Message exceeds maximum of ${MAX_PROACTIVE_SEGMENTS} segments (max ${MAX_PROACTIVE_SEGMENT_CHARS} characters per segment)`,
    };
  }

  return { ok: true, parts: packedParts };
}

function normalizeTimestampMs(rawTs: unknown): number {
  const num = Number(rawTs);
  if (!Number.isFinite(num) || num <= 0) {
    return 0;
  }
  return num < 10_000_000_000 ? Math.floor(num * 1000) : Math.floor(num);
}

export function validatePolicy(input: unknown): AutomationPolicy {
  if (!input || typeof input !== 'object') {
    throw new Error('自动回复设置无效');
  }
  const p = policyDefaults(input as Record<string, any>);
  if (
    Object.keys(p).some((k) => !(k in DEFAULT)) ||
    typeof p.enabled !== 'boolean' ||
    typeof p.allChats !== 'boolean' ||
    !['off', 'draft', 'send'].includes(p.moments) ||
    !['draft', 'send'].includes(p.mode)
  ) {
    throw new Error('自动回复设置字段无效');
  }
  if (
    !Array.isArray(p.adminIds) ||
    p.adminIds.length > 32 ||
    p.adminIds.some((x) => typeof x !== 'string' || !/^wxid_[a-zA-Z0-9_-]{1,100}$/.test(x)) ||
    new Set(p.adminIds).size !== p.adminIds.length
  ) {
    throw Error('管理员需填写不重复的微信内部 ID（wxid_ 开头，最多 32 个）');
  }
  for (const key of [
    'provider',
    'model',
    'ownId',
    'instructions',
    'personaId',
    'controllerId',
  ] as const) {
    if (typeof p[key] !== 'string' || p[key].length > (key === 'instructions' ? 6000 : 200)) {
      throw new Error('模型或身份设置无效');
    }
  }
  if (!Number.isInteger(p.maxAgeSeconds) || p.maxAgeSeconds < 30 || p.maxAgeSeconds > 3600) {
    throw new Error('消息时效设置无效');
  }
  if (
    !Number.isInteger(p.debounceMs) ||
    p.debounceMs < 0 ||
    p.debounceMs > 60000 ||
    !Number.isInteger(p.debounceMaxMessages) ||
    p.debounceMaxMessages < 1 ||
    p.debounceMaxMessages > 24
  ) {
    throw Error('消息合并等待时间或条数无效');
  }
  if (
    !Number.isSafeInteger(p.momentsNotBefore) ||
    p.momentsNotBefore < 0 ||
    p.momentsNotBefore > 8640000000000000
  ) {
    throw new Error('朋友圈生效时间无效');
  }
  if (!Array.isArray(p.rules) || p.rules.length > 100) {
    throw new Error('联系人规则无效');
  }
  const seen = new Set<string>();
  p.rules = p.rules.map((r: any) => {
    if (
      !r ||
      !['text', 'sns'].includes(r.kind) ||
      !['sourceId', 'title', 'search', 'wechatId'].every(
        (k) => typeof r[k] === 'string' && r[k].length <= 200,
      ) ||
      !r.sourceId ||
      !r.title ||
      !r.search
    ) {
      throw new Error('每个规则都需要准确的来源、显示名和微信搜索信息');
    }
    if (
      Object.keys(r).some(
        (k) => !['kind', 'sourceId', 'title', 'search', 'wechatId', 'testPrefix'].includes(k),
      )
    ) {
      throw new Error('联系人规则含有未支持字段');
    }
    if (r.kind === 'text' && r.sourceId !== 'filehelper' && !r.wechatId) {
      throw new Error('聊天收件人需要配置微信号，用于发送前核对');
    }
    if (
      r.testPrefix !== undefined &&
      (r.sourceId !== 'filehelper' ||
        typeof r.testPrefix !== 'string' ||
        r.testPrefix.length < 4 ||
        r.testPrefix.length > 40)
    ) {
      throw new Error('本人消息测试仅允许文件传输助手并使用明确前缀');
    }
    const key = `${r.kind}:${r.sourceId}`;
    if (seen.has(key)) {
      throw new Error('规则重复');
    }
    seen.add(key);
    return { ...r } as PolicyRule;
  });
  if (
    p.enabled &&
    (!p.provider ||
      !p.model ||
      !p.ownId ||
      !p.instructions.trim() ||
      (!p.rules.length && !p.allChats && p.moments === 'off'))
  ) {
    throw new Error('开启前请配置模型、本人微信 ID、回复规则和处理对象');
  }
  return p;
}

export class Automation {
  store: AutomationOptions['store'];
  listener: AutomationOptions['listener'];
  llm: any;
  cua: any;
  wxarcHome: string;
  resolveSource: (home: string, event: any) => any;
  resolveTarget?: (event: any, root: string | undefined, signal?: AbortSignal) => Promise<any>;
  personas: any;
  enrich: (event: any, rule: any, signal?: AbortSignal) => Promise<any>;
  identify: (event: any, signal?: AbortSignal) => Promise<any>;
  now: () => number;
  lease: DatabaseSync | null;
  stopped: boolean;
  active: AbortController | null;
  lastError: string | null;
  controller: AbortController;
  archiveHistory: typeof archiveHistory;
  batches: ChatBatches;
  outgoingPython?: string;
  approvals?: WechatApprovals;
  agentBridge?: AgentBridge;
  stickers?: any;
  adminWechatHandler?: AdminWechatHandler;
  prepareOutgoingImage: typeof prepareImage;
  logger?: { warn?: (...args: unknown[]) => void; info?: (...args: unknown[]) => void };
  proactiveRetryDelaysMs: readonly number[];
  manual?: Promise<unknown>;
  nextReceiptCheck = 0;
  private proactiveQueue: Promise<void>;
  private proactiveQueueDepth: number;
  private activeProactiveId: string | null;
  private readonly inFlightProactive: Map<string, Promise<ProactiveSendResult>>;

  constructor({
    store,
    listener,
    llm,
    cua,
    wxarcHome,
    resolveSource = sourceMessage,
    resolveTarget,
    personas,
    enrich = async (event: any) => event,
    identify = async (event: any) => event,
    prepareOutgoingImage = prepareImage,
    logger,
    now = Date.now,
    proactiveRetryDelaysMs = DEFAULT_PROACTIVE_RETRY_DELAYS_MS,
  }: AutomationOptions) {
    this.store = store;
    this.listener = listener;
    this.llm = llm;
    this.cua = cua;
    this.wxarcHome = wxarcHome;
    this.resolveSource = resolveSource;
    this.resolveTarget = resolveTarget;
    this.personas = personas;
    this.enrich = enrich;
    this.identify = identify;
    this.prepareOutgoingImage = prepareOutgoingImage;
    this.logger = logger;
    this.now = now;
    this.proactiveRetryDelaysMs = proactiveRetryDelaysMs;
    const leasePath = join(store.dir, 'automation-owner.sqlite');
    this.lease = new DatabaseSync(leasePath);
    chmodSync(leasePath, 0o600);
    try {
      this.lease.exec(
        'PRAGMA locking_mode=EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (id INTEGER); BEGIN EXCLUSIVE;',
      );
    } catch (e) {
      this.lease.close();
      throw new Error('已有自动处理实例使用此目录，请勿同时启动多个实例', { cause: e });
    }
    this.stopped = false;
    this.active = null;
    this.lastError = null;
    this.controller = new AbortController();
    this.proactiveQueue = Promise.resolve();
    this.proactiveQueueDepth = 0;
    this.activeProactiveId = null;
    this.inFlightProactive = new Map();
    store.db.exec(`CREATE TABLE IF NOT EXISTS automation_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_seq INTEGER NOT NULL UNIQUE, source_key TEXT NOT NULL UNIQUE,
      revision INTEGER NOT NULL, event TEXT NOT NULL, rule TEXT NOT NULL, status TEXT NOT NULL,
      decision TEXT, detail TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS automation_config (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, policy TEXT NOT NULL, cursor INTEGER NOT NULL);`);
    const jobColumns = store.db
      .prepare('PRAGMA table_info(automation_jobs)')
      .all() as unknown as Array<{ name: string }>;
    if (!jobColumns.some((c) => c.name === 'attempted_at')) {
      store.db.exec('ALTER TABLE automation_jobs ADD COLUMN attempted_at INTEGER');
    }
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS automation_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT,job_id INTEGER NOT NULL,at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS automation_attempt_time ON automation_attempts(at)',
    );
    store.db.exec(
      'INSERT INTO automation_attempts(job_id,at) SELECT id,attempted_at FROM automation_jobs WHERE attempted_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM automation_attempts a WHERE a.job_id=automation_jobs.id)',
    );
    store.db
      .prepare('INSERT OR IGNORE INTO automation_config VALUES (1,0,?,?)')
      .run(JSON.stringify(DEFAULT), this.tail());
    store.db
      .prepare(
        "UPDATE automation_jobs SET status='uncertain',detail='服务在发送过程中停止，请核对微信后处理；不会自动重发',updated_at=? WHERE status='sending'",
      )
      .run(now());
    store.db
      .prepare(
        "UPDATE automation_jobs SET status='failed',detail='服务在处理过程中停止；本次未自动重试',updated_at=? WHERE status IN ('processing','preparing')",
      )
      .run(now());
    store.db.exec(`CREATE TABLE IF NOT EXISTS automation_deliveries (
      job_id INTEGER NOT NULL,part_index INTEGER NOT NULL,text TEXT NOT NULL,status TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '',updated_at INTEGER NOT NULL,
      PRIMARY KEY(job_id,part_index));`);
    store.db
      .prepare(
        "UPDATE automation_deliveries SET status='uncertain',detail='发送中重启，未自动重放',updated_at=? WHERE status='sending'",
      )
      .run(now());
    store.db
      .prepare(
        "UPDATE automation_jobs SET status='uncertain',detail='分条发送结果待核实；不会自动重放' WHERE id IN (SELECT job_id FROM automation_deliveries WHERE status='uncertain') AND status NOT IN ('sent','uncertain')",
      )
      .run();
    store.db
      .prepare(
        "UPDATE automation_jobs SET status='partial',detail='服务停止，部分消息已发送；其余未自动重放' WHERE status='failed' AND id IN (SELECT job_id FROM automation_deliveries WHERE status='sent')",
      )
      .run();
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS wxarc_retries(job_id INTEGER PRIMARY KEY,part INTEGER NOT NULL,attempt INTEGER NOT NULL,due INTEGER NOT NULL)',
    );
    const deliveryColumns = store.db
      .prepare('PRAGMA table_info(automation_deliveries)')
      .all() as unknown as Array<{ name: string }>;
    if (!deliveryColumns.some((c) => c.name === 'clicked_at')) {
      store.db.exec('alter table automation_deliveries add column clicked_at INTEGER');
    }
    store.db.exec(`CREATE TABLE IF NOT EXISTS proactive_deliveries (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      session TEXT NOT NULL,
      parts_json TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',
      clicked_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    store.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_proactive_deliveries_session_created ON proactive_deliveries (session, created_at DESC)',
    );
    store.db
      .prepare(
        "UPDATE proactive_deliveries SET status='uncertain',detail='Interrupted during active send before restart; never automatically replayed',updated_at=? WHERE status='sending'",
      )
      .run(now());
    this.archiveHistory = archiveHistory;
    this.batches = new ChatBatches(this as any);
  }

  tail(): number {
    const row = this.store.db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM events').get() as {
      n: number;
    };
    return row.n;
  }

  settings(): AutomationSettings {
    const r = this.store.db.prepare('SELECT * FROM automation_config WHERE id=1').get() as {
      revision: number;
      policy: string;
      cursor: number;
    };
    return {
      revision: r.revision,
      policy: policyDefaults(JSON.parse(r.policy) as Record<string, any>),
      cursor: r.cursor,
    };
  }

  save(policy: unknown, revision: number): AutomationSettings {
    const next = validatePolicy(policy);
    const current = this.settings();
    if (next.personaId) {
      this.personas?.ready(next.personaId);
    }
    if (revision !== current.revision) {
      throw new Error('设置已更新，请刷新后重试');
    }
    const changed = this.store.db
      .prepare('UPDATE automation_config SET revision=revision+1,policy=?,cursor=? WHERE id=1 AND revision=?')
      .run(JSON.stringify(next), this.tail(), revision);
    if (!changed.changes) {
      throw new Error('设置已更新，请刷新后重试');
    }
    this.active?.abort();
    this.agentBridge?.cancelAll('设置已改变，请在 DSH 查看已执行的操作');
    this.store.db
      .prepare(
        "UPDATE automation_jobs SET status='cancelled',detail='设置已改变',updated_at=? WHERE status IN ('queued','draft','agent_running','agent_waiting','retry_wait')",
      )
      .run(this.now());
    this.agentBridge?.refreshLoadedAdmins?.();
    return this.settings();
  }

  jobs(limit = 50): AutomationJob[] {
    const rows = this.store.db
      .prepare('SELECT * FROM automation_jobs ORDER BY id DESC LIMIT ?')
      .all(limit) as unknown as AutomationJobRow[];
    return rows.map((r) => ({
      ...r,
      deliveries: this.deliveryParts(r.id),
      event: JSON.parse(r.event) as Record<string, any>,
      rule: JSON.parse(r.rule) as Record<string, any>,
      decision: r.decision ? (JSON.parse(r.decision) as Record<string, any>) : null,
    }));
  }

  job(id: number): AutomationJob {
    const row = this.store.db
      .prepare('SELECT * FROM automation_jobs WHERE id=?')
      .get(id) as AutomationJobRow | undefined;
    if (!row) {
      throw new Error('处理记录不存在');
    }
    return {
      ...row,
      deliveries: this.deliveryParts(row.id),
      event: JSON.parse(row.event) as Record<string, any>,
      rule: JSON.parse(row.rule) as Record<string, any>,
      decision: row.decision ? (JSON.parse(row.decision) as Record<string, any>) : null,
    };
  }

  deliveryParts(id: number): DeliveryPartRow[] {
    return this.store.db
      .prepare('SELECT * FROM automation_deliveries WHERE job_id=? ORDER BY part_index')
      .all(id) as unknown as DeliveryPartRow[];
  }

  state(id: number, status: string, detail = '', decision?: unknown): void {
    this.store.db
      .prepare(
        'UPDATE automation_jobs SET status=?,detail=?,decision=COALESCE(?,decision),updated_at=? WHERE id=?',
      )
      .run(status, detail, decision ? JSON.stringify(decision) : null, this.now(), id);
  }

  status(): Record<string, unknown> {
    const { policy, revision } = this.settings();
    const countRows = this.store.db
      .prepare('SELECT status,COUNT(*) AS n FROM automation_jobs GROUP BY status')
      .all() as unknown as Array<{ status: string; n: number }>;
    return {
      enabled: policy.enabled,
      mode: policy.mode,
      revision,
      configured: Boolean(
        policy.provider &&
          policy.model &&
          policy.ownId &&
          (policy.rules.length || policy.allChats || policy.moments !== 'off') &&
          policy.instructions,
      ),
      active: Boolean(this.active),
      lastError: this.lastError,
      momentsNotBefore: policy.momentsNotBefore,
      momentsWaiting: policy.moments === 'send' && this.now() < policy.momentsNotBefore,
      counts: Object.fromEntries(countRows.map((r) => [r.status, r.n])),
    };
  }

  setAdminWechatHandler(handler?: AdminWechatHandler): void {
    this.adminWechatHandler = handler;
  }

  async collect(
    selectedRows?: Array<{ seq: number; payload: string }>,
    manualAt = 0,
  ): Promise<void> {
    const { policy, revision, cursor } = this.settings();
    if (!policy.enabled || !this.listener.status().healthy) {
      return;
    }
    const rows =
      selectedRows ||
      (this.store.db
        .prepare('SELECT seq,payload FROM events WHERE seq>? ORDER BY seq LIMIT 200')
        .all(cursor) as unknown as Array<{ seq: number; payload: string }>);
    for (const raw of rows) {
      const event: Record<string, any> = {
        ...(JSON.parse(raw.payload) as Record<string, any>),
        seq: raw.seq,
      };
      let rule: any = policy.rules.find(
        (r) => r.kind === event.kind && r.sourceId === (event.kind === 'sns' ? event.user_name : event.session),
      );
      const broad =
        event.kind === 'text'
          ? policy.allChats && event.session !== 'filehelper' && !event.session?.startsWith('gh_')
          : event.kind === 'sns' && policy.moments !== 'off';
      const inPolicyScope = Boolean(rule || broad);
      const isAdminSession = Boolean(
        this.adminWechatHandler &&
          event.kind === 'text' &&
          policy.controllerId &&
          event.session === policy.controllerId,
      );
      let source: any;
      let problem: string | undefined;
      let pendingAdminReply: { replyText?: string; imagePath?: string } | null = null;
      const baseLocalType =
        typeof event.local_type === 'number' ? event.local_type % 4294967296 : 0;
      const isSupportedTextType = [1, 3, 34, 43, 47, 49].includes(baseLocalType);
      const hasContent = Boolean(event.text) || baseLocalType === 34 || baseLocalType === 43;
      if (
        (inPolicyScope || isAdminSession) &&
        hasContent &&
        (event.kind === 'sns' || isSupportedTextType) &&
        (manualAt || this.now() / 1000 - event.ts <= policy.maxAgeSeconds) &&
        event.ts <= this.now() / 1000 + 30
      ) {
        try {
          source = this.resolveSource(this.wxarcHome, event);
          validateAccount(source, policy.ownId, this.listener.wechatRoot as string);
          delete source.account;
          if (this.approvals?.consume(source)) {
            source = null;
          }
          if (
            source?.senderId === policy.ownId &&
            !(rule?.testPrefix && event.text.startsWith(rule.testPrefix))
          ) {
            source = null;
          }
          if (
            source &&
            this.store.db
              .prepare(
                "SELECT 1 FROM automation_jobs WHERE json_extract(event,'$.session')=? AND json_extract(decision,'$.text')=? AND status IN ('sending','sent','uncertain') LIMIT 1",
              )
              .get(event.session || '', event.text)
          ) {
            source = null;
          }
          if (
            this.adminWechatHandler &&
            source &&
            event.kind === 'text' &&
            policy.controllerId &&
            source.session === policy.controllerId &&
            source.senderId === policy.controllerId
          ) {
            let enrichedSource = source;
            if (typeof this.listener.enrichQuote === 'function' && !source.quote?.text) {
              try {
                enrichedSource = (await this.listener.enrichQuote(source)) || source;
              } catch {
                enrichedSource = source;
              }
            }
            const quote = enrichedSource.quote ?? event.quote;
            const quotedText =
              typeof quote?.text === 'string' && quote.text ? quote.text : undefined;
            const extractedText =
              typeof quote?.body === 'string' && quote.body
                ? quote.body
                : messageBody(enrichedSource) || String(source.text ?? event.text ?? '');
            const adminMsg: AdminWechatMessage = {
              session: source.session,
              senderId: source.senderId,
              text: extractedText,
              quotedText,
              seq: event.seq,
              timestamp: event.ts,
            };
            try {
              const res = (await this.adminWechatHandler(adminMsg)) as
                | AdminWechatHandleResult
                | void;
              if (res?.handled === true) {
                source = null;
                if (res.replyText || res.imagePath) {
                  pendingAdminReply = {
                    replyText: res.replyText,
                    imagePath: res.imagePath,
                  };
                }
              }
            } catch (err) {
              this.logger?.warn?.(
                '管理员微信消息处理失败：' + (err instanceof Error ? err.message : String(err)),
              );
            }
          }
          if (!inPolicyScope) {
            source = null;
          }
          if (source && !rule && this.resolveTarget) {
            rule = await this.resolveTarget(event, this.listener.wechatRoot, this.controller.signal);
          }
          if (this.stopped || this.settings().revision !== revision) {
            return;
          }
        } catch {
          if (inPolicyScope) {
            problem = '消息来源、本人身份或通讯录目标无法核实，未调用 AI';
          }
          source = null;
        }
        if (this.stopped || this.settings().revision !== revision) {
          return;
        }
        rule ||= {
          kind: event.kind,
          sourceId: event.session || event.user_name,
          title: event.session_name || event.user_name || event.session,
        };
      }
      this.store.db.exec('BEGIN IMMEDIATE');
      try {
        if (source || problem) {
          this.store.db
            .prepare(
              'INSERT OR IGNORE INTO automation_jobs(event_seq,source_key,revision,event,rule,status,detail,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
            )
            .run(
              event.seq,
              source?.sourceKey || `${event.kind}:${event.id}`,
              revision,
              JSON.stringify(
                source
                  ? {
                      ...source,
                      personaId: policy.personaId,
                      ...(manualAt ? { manualRequestedAt: manualAt } : {}),
                    }
                  : event,
              ),
              JSON.stringify(rule),
              problem ? 'blocked' : 'queued',
              problem || '',
              this.now(),
              this.now(),
            );
        }
        this.store.db
          .prepare('UPDATE automation_config SET cursor=MAX(cursor,?) WHERE id=1 AND revision=?')
          .run(event.seq, revision);
        this.store.db.exec('COMMIT');
      } catch (e) {
        this.store.db.exec('ROLLBACK');
        throw e;
      }
      if (pendingAdminReply) {
        const replySession = policy.controllerId;
        const replyKey = 'admin-wechat-reply:' + event.seq;
        const replyText = pendingAdminReply.replyText || '';
        const replyImagePath = pendingAdminReply.imagePath;
        void (async () => {
          const result = await this.sendProactive({
            session: replySession,
            text: replyText,
            imagePath: replyImagePath,
            idempotencyKey: replyKey,
            mode: 'send',
            reason: 'admin_wechat_handler',
          });
          if (result.status !== 'sent' && result.status !== 'staged') {
            this.logger?.warn?.(
              `管理员微信自动回复未送达（session=${replySession}, key=${replyKey}, status=${result.status}）：${result.detail || '未知原因'}`,
            );
            if (result.status === 'failed' && replyImagePath && replyText.trim()) {
              const fallbackResult = await this.sendProactive({
                session: replySession,
                text: replyText,
                idempotencyKey: replyKey + ':text-fallback',
                mode: 'send',
                reason: 'admin_wechat_handler_text_fallback',
              });
              if (fallbackResult.status !== 'sent' && fallbackResult.status !== 'staged') {
                this.logger?.warn?.(
                  `管理员微信纯文字降级回复未送达（session=${replySession}, key=${replyKey}:text-fallback, status=${fallbackResult.status}）：${fallbackResult.detail || '未知原因'}`,
                );
              }
            }
          }
        })().catch((err) => {
          this.logger?.warn?.(
            '管理员微信自动回复发送失败：' + (err instanceof Error ? err.message : String(err)),
          );
        });
      }
    }
  }

  async queueEvent(seq: number, revision: number, allowHistorical = false): Promise<AutomationJob> {
    const current = this.settings();
    if (revision !== current.revision || !current.policy.enabled) {
      throw new Error('请先开启自动处理并刷新设置');
    }
    const raw = this.store.db
      .prepare('SELECT seq,payload FROM events WHERE seq=?')
      .get(seq) as { seq: number; payload: string } | undefined;
    if (!raw) {
      throw new Error('消息不存在');
    }
    const selected = JSON.parse(raw.payload) as Record<string, any>;
    const p = current.policy;
    const rule = p.rules.find(
      (r) => r.kind === selected.kind && r.sourceId === (selected.session || selected.user_name),
    );
    const scope =
      rule ||
      (selected.kind === 'sns'
        ? p.moments !== 'off'
        : p.allChats && selected.session !== 'filehelper' && !selected.session?.startsWith('gh_'));
    const selectedBaseType =
      typeof selected.local_type === 'number' ? selected.local_type % 4294967296 : 0;
    const selectedHasContent =
      Boolean(selected.text) || selectedBaseType === 34 || selectedBaseType === 43;
    if (
      !scope ||
      !selectedHasContent ||
      (selected.kind !== 'sns' && ![1, 3, 34, 43, 47, 49].includes(selectedBaseType)) ||
      (!allowHistorical && this.now() / 1000 - selected.ts > p.maxAgeSeconds)
    ) {
      throw new Error('这条消息不在当前范围或时效内');
    }
    const source = this.resolveSource(this.wxarcHome, selected);
    validateAccount(source, p.ownId, this.listener.wechatRoot as string);
    if (
      source.senderId === p.ownId &&
      !(rule?.testPrefix && selected.text.startsWith(rule.testPrefix))
    ) {
      throw new Error('跳过本人发送的消息');
    }
    await this.collect([raw], allowHistorical ? this.now() : 0);
    if (this.stopped) {
      throw new Error('服务正在停止');
    }
    const result = this.store.db
      .prepare('SELECT id FROM automation_jobs WHERE event_seq=?')
      .get(seq) as { id: number } | undefined;
    if (!result) {
      throw new Error('该消息超时、来自本人、类型或对象不在处理范围内');
    }
    const job = this.job(result.id);
    if (job.event.dshRunId) {
      throw new Error('此消息已交给 DSH，请打开原会话继续，避免重复执行工具');
    }
    if (
      ['failed', 'cancelled'].includes(job.status) ||
      (job.status === 'ignored' && job.revision !== revision)
    ) {
      const event = JSON.parse(raw.payload) as Record<string, any>;
      if (!allowHistorical && this.now() / 1000 - event.ts > current.policy.maxAgeSeconds) {
        throw new Error('消息已过自动处理时效');
      }
      this.store.db
        .prepare(
          "UPDATE automation_jobs SET status='queued',revision=?,detail='用户重新处理此消息',updated_at=? WHERE id=? AND status IN ('failed','cancelled','ignored')",
        )
        .run(revision, this.now(), job.id);
    }
    if (allowHistorical && ['queued'].includes(this.job(result.id).status)) {
      const fresh = this.job(result.id);
      this.store.db
        .prepare('UPDATE automation_jobs SET event=? WHERE id=?')
        .run(JSON.stringify({ ...fresh.event, manualRequestedAt: this.now() }), fresh.id);
    }
    return this.job(result.id);
  }

  previewArticle(seq: number, revision: number): Promise<Record<string, any>> {
    if (this.active || this.stopped) {
      return Promise.reject(new Error('当前已有任务正在处理或服务正在停止'));
    }
    const promise = this._previewArticle(seq, revision);
    this.manual = promise;
    return promise;
  }

  async _previewArticle(seq: number, revision: number): Promise<Record<string, any>> {
    const { policy, revision: currentRevision } = this.settings();
    if (revision !== currentRevision || !policy.enabled || !this.listener.status().healthy) {
      throw new Error('设置已改变或采集未就绪');
    }
    const raw = this.store.db
      .prepare('SELECT payload FROM events WHERE seq=?')
      .get(seq) as { payload: string } | undefined;
    if (!raw) {
      throw new Error('消息不存在');
    }
    const selected: Record<string, any> = {
      ...(JSON.parse(raw.payload) as Record<string, any>),
      seq,
    };
    if (
      selected.kind !== 'text' ||
      selected.local_type % 4294967296 !== 49 ||
      !selected.text.startsWith('[链接]')
    ) {
      throw new Error('仅支持公众号文章');
    }
    let rule: any = policy.rules.find((r) => r.kind === 'text' && r.sourceId === selected.session);
    if (
      !rule &&
      (!policy.allChats || selected.session === 'filehelper' || selected.session.startsWith('gh_'))
    ) {
      throw new Error('消息不在当前处理范围');
    }
    const source = this.resolveSource(this.wxarcHome, selected);
    validateAccount(source, policy.ownId, this.listener.wechatRoot as string);
    if (source.senderId === policy.ownId) {
      throw new Error('跳过本人发送的消息');
    }
    delete source.account;
    const abort = (this.active = new AbortController());
    const signal = AbortSignal.any([
      abort.signal,
      this.controller.signal,
      AbortSignal.timeout(120000),
    ]);
    try {
      if (!rule && this.resolveTarget) {
        rule = await this.resolveTarget(source, this.listener.wechatRoot, signal);
      }
      const event = await this.enrich(source, rule, signal);
      signal.throwIfAborted();
      if (this.settings().revision !== revision) {
        throw new Error('设置已改变');
      }
      if (event.article?.status !== 'read') {
        throw new Error('未读到公众号正文');
      }
      if (this.agentBridge) {
        const run = await this.agentBridge.start({ event, rule, policy, preview: true }, signal);
        return { event, rule, run, sent: false };
      }
      this.store.db
        .prepare('INSERT INTO automation_attempts(job_id,at) VALUES (?,?)')
        .run(0, this.now());
      const decision = await decide(
        this.llm,
        policy as any,
        event,
        this.recent(event),
        signal,
        this.personas?.context(policy.personaId, event, policy),
      );
      signal.throwIfAborted();
      if (this.settings().revision !== revision) {
        throw new Error('设置已改变');
      }
      return {
        event,
        rule,
        decision,
        persona: policy.personaId
          ? { id: policy.personaId, name: this.personas?.get(policy.personaId).name }
          : null,
        model: { provider: policy.provider, model: policy.model },
        sent: false,
      };
    } finally {
      this.active = null;
    }
  }

  recent(event: Record<string, any>): Array<{ sender: unknown; text: string; time: unknown }> {
    if (event.kind !== 'text') {
      return [];
    }
    const rows = this.store.db
      .prepare(
        "SELECT payload FROM events WHERE kind='text' AND seq<? AND json_extract(payload,'$.session')=? ORDER BY seq DESC LIMIT 12",
      )
      .all(event.seq, event.session) as unknown as Array<{ payload: string }>;
    return rows.reverse().map((r) => {
      const e = JSON.parse(r.payload) as Record<string, any>;
      return { sender: e.sender, text: (e.text || '').slice(0, 1500), time: e.ts };
    });
  }

  assertCurrent(job: AutomationJob, signal: AbortSignal): AutomationPolicy {
    signal.throwIfAborted();
    const current = this.settings();
    if (current.revision !== job.revision) {
      throw new Error('设置已改变');
    }
    if (!this.listener.status().healthy) {
      throw new Error('wxarc 采集不健康，暂停发送');
    }
    const acceptedAt = job.event.dshAcceptedAt || job.event.manualRequestedAt;
    const age = acceptedAt ? (this.now() - acceptedAt) / 1000 : this.now() / 1000 - job.event.ts;
    if (age > (acceptedAt ? 1800 : current.policy.maxAgeSeconds)) {
      throw new Error('消息已过自动回复时效');
    }
    if (job.event.dshRunId && this.agentBridge) {
      const run = this.agentBridge.run(job.event.dshRunId);
      if (run?.manual || run?.status === 'manual') {
        throw new Error('用户已在 DSH 接管，停止自动发送');
      }
    }
    return current.policy;
  }

  async process(): Promise<void> {
    if (this.agentBridge) {
      return this.processNative();
    }
    if (this.active || !this.settings().policy.enabled) {
      return;
    }
    const raw = this.store.db
      .prepare("SELECT id FROM automation_jobs WHERE status='queued' ORDER BY id LIMIT 1")
      .get() as { id: number } | undefined;
    if (!raw) {
      return;
    }
    const job = this.job(raw.id);
    const { policy } = this.settings();
    const abort = (this.active = new AbortController());
    const signal = AbortSignal.any([
      abort.signal,
      this.controller.signal,
      AbortSignal.timeout(120000),
    ]);
    try {
      this.assertCurrent(job, signal);
      this.state(job.id, 'processing');
      try {
        job.event = await this.enrich(job.event, job.rule, signal);
      } catch (e) {
        this.state(
          job.id,
          'blocked',
          signal.aborted ? '读取文章已取消或超时' : e instanceof Error ? e.message : String(e),
        );
        return;
      }
      this.assertCurrent(job, signal);
      if (policy.personaId && this.personas) {
        const person = this.personas.get(policy.personaId);
        job.event = {
          ...job.event,
          personaId: person.id,
          personaName: person.name,
          personaRevision: person.revision,
        };
      }
      this.store.db
        .prepare('UPDATE automation_jobs SET event=? WHERE id=?')
        .run(JSON.stringify(job.event), job.id);
      this.store.db
        .prepare('UPDATE automation_jobs SET attempted_at=? WHERE id=?')
        .run(this.now(), job.id);
      this.store.db
        .prepare('INSERT INTO automation_attempts(job_id,at) VALUES (?,?)')
        .run(job.id, this.now());
      if ([3, 43, 47].includes(job.event.local_type % 4294967296)) {
        throw new Error('图片或视频消息需要 DSH 原生 Agent');
      }
      const decision = await decide(
        this.llm,
        policy as any,
        job.event as any,
        this.recent(job.event),
        signal,
        this.personas?.context(policy.personaId, job.event, policy),
      );
      this.assertCurrent(job, signal);
      this.personas?.remember(policy.personaId, job.event, decision);
      this.state(
        job.id,
        decision.action === 'ignore' ? 'ignored' : 'draft',
        decision.reason,
        decision,
      );
      if (
        decision.action !== 'ignore' &&
        policy.mode === 'send' &&
        (job.event.kind !== 'sns' ||
          (policy.moments === 'send' &&
            this.now() >= policy.momentsNotBefore &&
            job.event.ts * 1000 >= policy.momentsNotBefore))
      ) {
        await this.deliver(this.job(job.id), signal);
      }
    } catch (e) {
      const state = this.job(job.id).status;
      const msg = e instanceof Error ? e.message : String(e);
      if (state === 'sending') {
        this.state(
          job.id,
          'uncertain',
          `${msg}。已尝试发送但未能确认结果，请核对微信；不会自动重发`,
        );
      } else if (!['sent', 'uncertain', 'partial'].includes(state)) {
        this.state(
          job.id,
          'failed',
          signal.aborted
            ? '处理已取消或超时，未确认发送'
            : state === 'preparing'
              ? `${msg}。请检查微信中是否留下未发送草稿。`
              : '处理未完成，请检查模型和配置',
        );
      }
      this.lastError = '有处理记录需要检查';
    } finally {
      this.active = null;
    }
  }

  async isSessionBusy(
    event: Record<string, any>,
    policy: AutomationPolicy,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (!this.agentBridge) {
      return false;
    }
    const existing =
      typeof this.agentBridge.findConversation === 'function'
        ? this.agentBridge.findConversation(event, policy)
        : undefined;
    const key = existing?.id || workspaceKey(event, policy);
    if (this.agentBridge.creation?.has(key)) {
      return true;
    }
    const startKey = JSON.stringify([
      policy.ownId,
      event.kind,
      event.session || event.user_name,
      policy.personaId,
    ]);
    if (this.agentBridge.starting?.has(startKey)) {
      return true;
    }
    const row =
      existing ??
      (this.store.db
        .prepare('SELECT session_id FROM dsh_conversations WHERE id=?')
        .get(key) as { session_id: string } | undefined);
    if (!row) {
      return false;
    }
    if (this.agentBridge.active?.(row.session_id)) {
      return true;
    }
    if (this.agentBridge.ctx?.sessionController?.state) {
      const state = await this.agentBridge.ctx.sessionController.state(
        { sessionId: row.session_id },
        signal,
      );
      if (
        state &&
        (state.running ||
          state.pendingInput?.length ||
          state.queue?.some((item) => item?.placement !== 'context'))
      ) {
        return true;
      }
    }
    return false;
  }

  async processNative(): Promise<void> {
    if (this.active || !this.settings().policy.enabled || !this.agentBridge) {
      return;
    }
    const abort = (this.active = new AbortController());
    const signal = AbortSignal.any([
      abort.signal,
      this.controller.signal,
      AbortSignal.timeout(120000),
    ]);
    try {
      await this.stickers?.reconcile(signal);
      if (!this.stickers?.lease) {
        await this.sendApprovalNotices(signal);
      }
      const previewRuns = this.store.db
        .prepare("SELECT id FROM dsh_runs WHERE preview=1 AND status IN ('admitting','running','waiting')")
        .all() as unknown as Array<{ id: string }>;
      for (const row of previewRuns) {
        await this.agentBridge.poll(row.id, signal);
      }
      const activeJobs = this.store.db
        .prepare("SELECT id FROM automation_jobs WHERE status IN ('agent_running','agent_waiting') ORDER BY id")
        .all() as unknown as Array<{ id: number }>;
      for (const row of activeJobs) {
        const job = this.job(row.id);
        try {
          if (await this.batches.cancelRequested(job as any)) {
            continue;
          }
          const run = await this.agentBridge.poll(job.event.dshRunId, signal);
          if (!run) {
            throw new Error('DSH 任务记录不存在');
          }
          if (['running', 'admitting', 'waiting'].includes(run.status)) {
            this.state(job.id, run.status === 'waiting' ? 'agent_waiting' : 'agent_running', run.detail);
            continue;
          }
          if (run.status !== 'ready') {
            this.state(job.id, run.status === 'manual' ? 'manual' : 'failed', run.detail || 'DSH 任务未完成');
            continue;
          }
          if (await this.batches.supersede(job as any)) {
            continue;
          }
          if (this.stickers?.lease && this.stickers.lease.runId !== run.id) {
            continue;
          }
          const policy = this.assertCurrent(job, signal);
          const decision = run.decision!;
          if (decision.action !== 'sticker') {
            await this.stickers?.release(signal);
          }
          if (!job.event.memoTrigger) {
            if (job.event.batch) {
              for (const memory of (decision.memory || []) as Array<{ quote: string; note: string }>) {
                const matching = messagesOf(job.event as any).filter((e: Record<string, any>) =>
                  e.text.includes(memory.quote),
                );
                if (matching.length === 1) {
                  this.personas?.remember(policy.personaId, matching[0], { memory: [memory] });
                }
              }
            } else {
              this.personas?.remember(policy.personaId, job.event, decision);
            }
          }
          this.state(
            job.id,
            decision.action === 'ignore' ? 'ignored' : 'draft',
            decision.reason,
            decision,
          );
          if (
            decision.action !== 'ignore' &&
            policy.mode === 'send' &&
            (job.event.kind !== 'sns' ||
              (policy.moments === 'send' &&
                this.now() >= policy.momentsNotBefore &&
                job.event.ts * 1000 >= policy.momentsNotBefore))
          ) {
            await this.deliver(this.job(job.id), signal);
          }
          if (['sent', 'ignored'].includes(this.job(job.id).status)) {
            this.agentBridge.update(run.id, { status: 'completed' });
          }
        } catch (e) {
          const status = this.job(job.id).status;
          const msg = e instanceof Error ? e.message : String(e);
          if (!['sent', 'uncertain', 'partial', 'cancelled', 'superseded'].includes(status)) {
            this.state(
              job.id,
              status === 'sending' ? 'uncertain' : 'failed',
              status === 'sending' ? '已尝试发送但结果未确认，不会重发' : msg,
            );
          }
        }
      }
      if (this.stickers?.lease) {
        return;
      }
      await this.checkReceipts(signal);
      const retry = this.store.db
        .prepare(
          "select r.* from wxarc_retries r join automation_jobs j on j.id=r.job_id where j.status='retry_wait' and r.due<=? order by r.due limit 1",
        )
        .get(this.now()) as { job_id: number; part: number } | undefined;
      if (retry) {
        await this.retryReply(this.job(retry.job_id), retry.part, signal);
      }
      const openRuns = (): number =>
        (
          this.store.db
            .prepare("SELECT COUNT(*) n FROM dsh_runs WHERE status IN ('admitting','running','waiting')")
            .get() as { n: number }
        ).n;
      if (openRuns() >= 3) {
        return;
      }
      const queuedRows = this.store.db
        .prepare(
          "SELECT MIN(id) id FROM automation_jobs WHERE status='queued' GROUP BY json_extract(event,'$.kind'),COALESCE(json_extract(event,'$.session'),json_extract(event,'$.user_name')) ORDER BY id LIMIT 30",
        )
        .all() as unknown as Array<{ id: number }>;
      for (const row of queuedRows) {
        if (openRuns() >= 3) {
          break;
        }
        let job = this.job(row.id);
        if (job.status !== 'queued') {
          continue;
        }
        try {
          if (!this.batches.plan(job as any).ready) {
            continue;
          }
          if (await this.isSessionBusy(job.event, this.settings().policy, signal)) {
            continue;
          }
          const preparedJob = (await this.batches.prepare(job as any, signal)) as AutomationJob | null;
          if (!preparedJob) {
            continue;
          }
          job = preparedJob;
          const policy = this.assertCurrent(job, signal);
          if (openRuns() >= 3) {
            break;
          }
          await this.agentBridge.ensure(job.event, job.rule, policy, signal);
          this.state(job.id, 'processing');
          if (job.event.batch) {
            const messages: Array<Record<string, any>> = [];
            for (const e of job.event.batch.messages) {
              messages.push(await this.enrich(e, job.rule, signal));
            }
            job.event = { ...messages.at(-1), batch: { ...job.event.batch, messages } };
          } else {
            job.event = await this.enrich(job.event, job.rule, signal);
          }
          this.assertCurrent(job, signal);
          if (policy.personaId && this.personas) {
            const p = this.personas.get(policy.personaId);
            job.event = {
              ...job.event,
              personaId: p.id,
              personaName: p.name,
              personaRevision: p.revision,
            };
          }
          const run = await this.agentBridge.start(
            { jobId: job.id, event: job.event, rule: job.rule, policy },
            signal,
          );
          job.event = {
            ...job.event,
            dshRunId: run.id,
            dshSessionId: run.session_id,
            dshAcceptedAt: this.now(),
          };
          this.store.db
            .prepare('UPDATE automation_jobs SET event=?,attempted_at=? WHERE id=?')
            .run(JSON.stringify(job.event), this.now(), job.id);
          this.batches.admitted(job.event as any);
          this.state(job.id, 'agent_running', '已交给 DSH Agent');
          return;
        } catch (e) {
          const err = e as Error & { code?: string };
          if (err.code === 'WXARC_BUSY') {
            continue;
          }
          if (err.code === 'WXARC_IMAGE_PENDING') {
            this.state(job.id, 'queued', err.message);
            continue;
          }
          if (this.job(job.id).status !== 'cancelled') {
            this.state(job.id, 'failed', err.message);
          }
          return;
        }
      }
    } finally {
      this.active = null;
    }
  }

  async resumeJob(id: number, revision: number): Promise<AutomationJob> {
    if (this.active || this.stopped) {
      throw new Error('当前正在处理任务，请稍后');
    }
    const job = this.job(id);
    const current = this.settings();
    if (
      !current.policy.enabled ||
      current.revision !== revision ||
      !job.event.dshRunId ||
      !['failed', 'cancelled', 'manual'].includes(job.status)
    ) {
      throw new Error('仅可继续已停止的 DSH 任务');
    }
    const source = this.resolveSource(this.wxarcHome, job.event);
    validateAccount(source, current.policy.ownId, this.listener.wechatRoot as string);
    const allowed =
      current.policy.rules.some(
        (r) => r.kind === source.kind && r.sourceId === (source.session || source.user_name),
      ) ||
      (source.kind === 'text' &&
        current.policy.allChats &&
        source.session !== 'filehelper' &&
        !source.session?.startsWith('gh_'));
    if (
      !allowed ||
      source.sourceKey !== job.source_key ||
      source.senderId !== job.event.senderId ||
      source.senderId === current.policy.ownId
    ) {
      throw new Error('任务来源或当前处理范围已改变，不能继续');
    }
    const abort = (this.active = new AbortController());
    const signal = AbortSignal.any([
      abort.signal,
      this.controller.signal,
      AbortSignal.timeout(60000),
    ]);
    try {
      const event = { ...job.event, manualRequestedAt: this.now() };
      const run = await this.agentBridge!.start(
        {
          jobId: job.id,
          event,
          rule: job.rule,
          policy: current.policy,
          resumeFrom: job.event.dshRunId,
        },
        signal,
      );
      this.store.db
        .prepare('UPDATE automation_jobs SET event=?,revision=? WHERE id=?')
        .run(
          JSON.stringify({
            ...event,
            dshRunId: run.id,
            dshSessionId: run.session_id,
            dshAcceptedAt: this.now(),
          }),
          revision,
          id,
        );
      this.state(id, 'agent_running', '已从原 DSH 会话继续，先核对已有执行结果');
      return this.job(id);
    } finally {
      this.active = null;
    }
  }

  async sendApprovalNotices(signal: AbortSignal): Promise<void> {
    for (const notice of this.approvals?.notices() || []) {
      const current = this.settings();
      const originRun = this.agentBridge!.run(notice.run_id)!;
      const origin = this.job(originRun.job_id!);
      try {
        if (!this.listener.status().healthy || current.policy.controllerId !== notice.owner_id) {
          throw new Error('采集状态或控制者身份发生变化');
        }
        let source: Record<string, any> | undefined;
        const rows = this.store.db
          .prepare(
            "SELECT seq,payload FROM events WHERE kind='text' AND json_extract(payload,'$.session')=? ORDER BY seq DESC LIMIT 30",
          )
          .all(notice.owner_id) as unknown as Array<{ seq: number; payload: string }>;
        for (const row of rows) {
          const event: Record<string, any> = {
            ...(JSON.parse(row.payload) as Record<string, any>),
            seq: row.seq,
          };
          if (![1, 49].includes(event.local_type % 4294967296)) {
            continue;
          }
          try {
            const value = this.resolveSource(this.wxarcHome, event);
            validateAccount(value, current.policy.ownId, this.listener.wechatRoot as string);
            if (value.senderId === notice.owner_id) {
              delete value.account;
              source = value;
              break;
            }
          } catch {}
        }
        if (!source) {
          throw new Error('未找到可核对的本人私聊，保留 DSH 审批');
        }
        const rule = await this.resolveTarget!(source, this.listener.wechatRoot, signal);
        const text = this.approvals!.message(notice);
        const commit = await this.cua.prepare(
          { event: source, rule, decision: { action: 'reply', text } },
          signal,
        );
        if (current.revision !== this.settings().revision || !this.approvals!.live.has(notice.code)) {
          throw new Error('审批已结束或设置已改变');
        }
        this.approvals!.notice(notice.code, 'sending');
        const receipt = await commit(signal);
        if (!receipt.confirmed) {
          throw new Error('微信通知发送结果未确认');
        }
        this.approvals!.notice(notice.code, 'sent', '确认请求已发到本人微信');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const row = this.store.db
          .prepare('SELECT notice_status FROM wechat_approvals WHERE code=?')
          .get(notice.code) as { notice_status: string };
        this.approvals!.notice(
          notice.code,
          row.notice_status === 'sending' ? 'uncertain' : 'failed',
          msg,
        );
        this.state(origin.id, 'agent_waiting', `${msg}；仍可在 DSH 审批`);
      }
    }
  }

  approvalAnchor(job: AutomationJob): Record<string, any> | null {
    const owner = this.settings().policy.controllerId;
    if (
      !this.approvals ||
      !owner ||
      job.event.kind !== 'text' ||
      job.event.session !== owner ||
      job.event.senderId !== owner ||
      !job.event.dshRunId
    ) {
      return null;
    }
    const grants = this.store.db
      .prepare(
        "SELECT decision_source FROM wechat_approvals WHERE run_id=? AND owner_id=? AND status IN ('allowed-once','allowed-task') AND notice_status='sent'",
      )
      .all(job.event.dshRunId, owner) as unknown as Array<{ decision_source: string | null }>;
    const keys = new Set(grants.map((g) => g.decision_source).filter(Boolean));
    const rows = this.store.db
      .prepare(
        "SELECT seq,payload FROM events WHERE kind='text' AND seq>? AND json_extract(payload,'$.session')=? ORDER BY seq DESC LIMIT 30",
      )
      .all(job.event.seq, owner) as unknown as Array<{ seq: number; payload: string }>;
    for (const row of rows) {
      try {
        const source = this.resolveSource(this.wxarcHome, {
          ...(JSON.parse(row.payload) as Record<string, any>),
          seq: row.seq,
        });
        validateAccount(source, this.settings().policy.ownId, this.listener.wechatRoot as string);
        if (source.session === owner && source.senderId === owner && keys.has(source.sourceKey)) {
          delete source.account;
          return source;
        }
      } catch {}
    }
    return null;
  }

  retryFresh(job: AutomationJob): boolean {
    const p = this.settings().policy;
    return this.now() <= job.event.ts * 1000 + Math.min(p.maxAgeSeconds, 300) * 1000;
  }

  history(job: AutomationJob, part: number): {
    rows: Array<Record<string, any>>;
    matches: Array<Record<string, any>>;
    parts: string[];
    own: string;
  } {
    const own = this.settings().policy.ownId;
    const parts = [job.decision!.text].flat() as string[];
    const storedMentions =
      part === 0 && Array.isArray(job.event.deliveryMentions)
        ? (job.event.deliveryMentions as Array<{
            name?: string;
            uiName?: string;
            nickname?: string;
            groupNickname?: string;
          }>)
        : null;
    let nameGroups: string[] | string[][] = [];
    if (storedMentions && storedMentions.length > 0) {
      nameGroups = storedMentions.map((m) =>
        [m.uiName || m.name, m.nickname, m.groupNickname].filter((n): n is string => Boolean(n)),
      );
    } else {
      const target = part === 0 ? replyTarget(job.event as any, job.decision as any, own) : null;
      const identity = target?.mention ? (target.event as Record<string, any>).senderIdentity : null;
      if (target?.mention && !identity?.uiName) {
        throw Error('无法核对被 @ 成员的名字');
      }
      nameGroups = identity ? [identity.uiName, identity.nickname, identity.groupNickname] : [];
    }
    const rows = this.archiveHistory(
      this.wxarcHome,
      job.event as any,
      own,
      this.listener.wechatRoot as string,
    ) as Array<Record<string, any>>;
    return { rows, matches: matchHistory(rows as any, own, parts[part], nameGroups), parts, own };
  }

  async retryReply(job: AutomationJob, part: number, signal: AbortSignal): Promise<void> {
    try {
      if (!this.retryFresh(job)) {
        this.state(job.id, part ? 'partial' : 'expired', '原消息已过补发时限，不再发送');
        return;
      }
      this.assertCurrent(job, signal);
      if (
        job.decision?.action !== 'reply' ||
        this.agentBridge?.run(job.event.dshRunId)?.status !== 'ready'
      ) {
        throw Error('原回复已不适合补发');
      }
      const existing = this.deliveryParts(job.id);
      if (
        existing.length !== part ||
        existing.some((p, i) => p.status !== 'sent' || p.part_index !== i)
      ) {
        throw Error('已有发送尝试或分条记录不一致，未重发');
      }
      const { rows, matches, parts, own } = this.history(job, part);
      const remaining = [...rows];
      for (let i = 0; i < part; i++) {
        const r = remaining[0];
        if (!r || !this.historyMatchPart(job, i, r, own)) {
          throw Error('wxarc 尚不能唯一核对前面已发的分条');
        }
        remaining.shift();
      }
      const hits = matches.filter((m) => remaining.some((r) => r.id === m.id));
      if (remaining.length === 1 && hits.length === 1 && part === parts.length - 1) {
        const detail = 'wxarc 已有本人发出的相同回复（消息 ' + hits[0].id + '），不重复发送';
        this.store.db
          .prepare(
            "insert into automation_deliveries(job_id,part_index,text,status,detail,updated_at) values(?,?,?,'sent',?,?)",
          )
          .run(job.id, part, parts[part], detail, this.now());
        this.state(job.id, 'sent', detail);
        this.agentBridge!.update(job.event.dshRunId, { status: 'completed' });
        return;
      }
      if (remaining.length) {
        throw Error('wxarc 中会话已有新消息或相同内容，停止补发');
      }
      await this.deliver(job, signal, part, { part, rows });
      if (this.job(job.id).status === 'sent') {
        this.agentBridge!.update(job.event.dshRunId, { status: 'completed' });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (
        !['partial', 'uncertain', 'sent', 'superseded', 'cancelled', 'expired'].includes(
          this.job(job.id).status,
        )
      ) {
        this.state(job.id, part ? 'partial' : 'failed', msg);
      }
    }
  }

  historyMatchPart(job: AutomationJob, i: number, row: Record<string, any>, own: string): boolean {
    const storedMentions =
      i === 0 && Array.isArray(job.event.deliveryMentions)
        ? (job.event.deliveryMentions as Array<{
            name?: string;
            uiName?: string;
            nickname?: string;
            groupNickname?: string;
          }>)
        : null;
    let nameGroups: string[] | string[][] = [];
    if (storedMentions && storedMentions.length > 0) {
      nameGroups = storedMentions.map((m) =>
        [m.uiName || m.name, m.nickname, m.groupNickname].filter((n): n is string => Boolean(n)),
      );
    } else {
      const t = i === 0 ? replyTarget(job.event as any, job.decision as any, own) : null;
      const v = t?.mention ? (t.event as Record<string, any>).senderIdentity : null;
      nameGroups = v ? [v.uiName, v.nickname, v.groupNickname] : [];
    }
    const flatText = [job.decision!.text].flat() as string[];
    return matchHistory([row] as any, own, flatText[i], nameGroups).length === 1;
  }

  async checkReceipts(signal: AbortSignal): Promise<void> {
    if (this.nextReceiptCheck > this.now()) {
      return;
    }
    this.nextReceiptCheck = this.now() + 5000;
    const uncertainParts = this.store.db
      .prepare(
        "select d.* from automation_deliveries d join automation_jobs j on d.job_id=j.id where j.status='uncertain' and d.status='uncertain' and d.clicked_at>=? and json_extract(j.event,'$.kind')='text' and json_extract(j.decision,'$.action')='reply' order by d.updated_at desc limit 20",
      )
      .all(this.now() - 300000) as unknown as DeliveryPartRow[];
    for (const p of uncertainParts) {
      signal.throwIfAborted();
      const j = this.job(p.job_id);
      try {
        const { rows, matches, parts, own } = this.history(j, p.part_index);
        if (
          rows[p.part_index]?.id !== matches[0]?.id ||
          rows.slice(0, p.part_index).some((r, i) => !this.historyMatchPart(j, i, r, own))
        ) {
          continue;
        }
        if (
          matches.length !== 1 ||
          parts.slice(0, p.part_index).includes(p.text) ||
          matches[0].ts < Math.floor((p.clicked_at ?? 0) / 1000)
        ) {
          continue;
        }
        const detail = 'wxarc 已核对本人出站消息 ' + matches[0].id;
        this.store.db
          .prepare(
            "update automation_deliveries set status='sent',detail=? where job_id=? and part_index=? and status='uncertain'",
          )
          .run(detail, j.id, p.part_index);
        const complete =
          this.deliveryParts(j.id).filter((d) => d.status === 'sent').length === parts.length;
        this.state(j.id, complete ? 'sent' : 'partial', detail + (complete ? '' : '；其余未自动补发'));
        if (complete && j.event.dshRunId) {
          this.agentBridge!.update(j.event.dshRunId, { status: 'completed' });
        }
      } catch {}
    }
  }

  async deliver(
    job: AutomationJob,
    signal: AbortSignal,
    startPart = 0,
    retrying: false | { part: number; rows: Array<Record<string, any>> } = false,
  ): Promise<void> {
    const isImage = job.decision!.action === 'image';
    let img: any;
    if (isImage) {
      const bridge = this.agentBridge;
      const run = bridge?.run(job.event.dshRunId);
      const row = run && bridge?.conversation(run.session_id);
      if (
        !row ||
        run.job_id !== job.id ||
        run.session_id !== job.event.dshSessionId ||
        run.manual ||
        run.preview ||
        run.event?.session !== job.event.session
      ) {
        throw Error('无法核对图片所属会话');
      }
      img = outgoingImage(bridge!.root, row.cwd, job.decision!.image);
      if (img.hash !== job.decision!.imageHash) {
        throw Error('图片自生成回复后已修改，未发送');
      }
      await pixelDigest(this.outgoingPython as string, img.bytes, signal);
    }
    const needsMention =
      isImage &&
      (Boolean(
        replyTarget(
          job.event as any,
          { action: 'reply', replyTo: job.decision!.replyTo } as any,
          this.settings().policy.ownId,
        ),
      ) ||
        Boolean(
          job.event.session?.endsWith('@chatroom') &&
            Array.isArray(job.decision!.mentions) &&
            job.decision!.mentions.length > 0,
        ));
    const parts: string[] = isImage
      ? [
          ...(job.decision!.text || needsMention
            ? [job.decision!.text || '图片在下面。']
            : []),
          '[图片]',
        ]
      : Array.isArray(job.decision!.text)
        ? job.decision!.text
        : [job.decision!.text];
    if (
      this.deliveryParts(job.id).some(
        (p) => p.part_index >= startPart && ['sent', 'sending', 'uncertain'].includes(p.status),
      )
    ) {
      throw Error('此任务已有发送记录，禁止整组重放');
    }
    let index = startPart;
    try {
      for (; index < parts.length; index++) {
        const { replyTo: _replyTo, mentions: _mentions, ...decision } = job.decision!;
        const piece: Record<string, any> = {
          ...job,
          event: this.job(job.id).event,
          decision:
            index === 0
              ? { ...job.decision!, text: parts[index] }
              : { ...decision, text: parts[index] },
        };
        if (isImage) {
          if (index === parts.length - 1) {
            piece.imageBytes = img;
            piece.decision = { ...decision, text: '[图片]' };
          } else {
            piece.decision = {
              action: 'reply',
              text: parts[index],
              replyTo: job.decision!.replyTo,
              ...(job.decision!.mentions ? { mentions: job.decision!.mentions } : {}),
            };
          }
        }
        const sent = await this.deliverOne({ ...piece, retrying } as any, signal, index, parts.length);
        if (!sent) {
          return;
        }
        if (index < parts.length - 1) {
          await pause(350, undefined, { signal });
        }
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const rows = this.deliveryParts(job.id);
      const sent = rows.filter((p) => p.status === 'sent').length;
      const uncertain = rows.some((p) => p.status === 'sending' || p.status === 'uncertain');
      if (
        !uncertain &&
        errMsg === OBSTRUCTED &&
        job.event.kind === 'text' &&
        job.decision!.action === 'reply' &&
        job.event.dshRunId &&
        this.settings().policy.mode === 'send'
      ) {
        const existingAttempt = this.store.db
          .prepare('select attempt from wxarc_retries where job_id=?')
          .get(job.id) as { attempt?: number } | undefined;
        const attempt = (existingAttempt?.attempt || 0) + 1;
        if (!this.retryFresh(job)) {
          this.state(job.id, sent ? 'partial' : 'expired', '原消息已过补发时限，不再发送');
          return;
        }
        if (attempt <= 2) {
          const delay = attempt === 1 ? 5000 : 20000;
          this.store.db
            .prepare('insert or replace into wxarc_retries values(?,?,?,?)')
            .run(job.id, index, attempt, this.now() + delay);
          this.state(job.id, 'retry_wait', '会话被遮挡，未点击发送；等待核对 wxarc 后重试');
          return;
        }
      }
      if (uncertain) {
        this.store.db
          .prepare(
            "UPDATE automation_deliveries SET status='uncertain',detail=?,updated_at=? WHERE job_id=? AND status='sending'",
          )
          .run(errMsg, this.now(), job.id);
        this.state(
          job.id,
          'uncertain',
          `已确认 ${sent}/${parts.length} 条；第 ${index + 1} 条结果待核实，其余停止，不会自动重发`,
        );
      } else if (sent) {
        if (!['partial', 'cancelled', 'superseded'].includes(this.job(job.id).status)) {
          this.state(
            job.id,
            'partial',
            `已发送 ${sent}/${parts.length} 条，其余停止：${errMsg}`,
          );
        }
      }
      throw error;
    }
  }

  async deliverOne(
    jobInput: AutomationJob & {
      imageBytes?: any;
      retrying?: false | { part: number; rows: Array<Record<string, any>> };
      quoteEvent?: Record<string, any>;
      mention?: {
        id: string;
        name: string;
        nickname?: string;
        groupNickname?: string;
        uniqueUiName?: boolean;
      } | null;
      mentions?: Array<{
        id: string;
        name: string;
        nickname?: string;
        groupNickname?: string;
        uniqueUiName?: boolean;
      }>;
      deliveryDetail?: string;
    },
    signal: AbortSignal,
    partIndex = 0,
    total = 1,
  ): Promise<boolean | undefined> {
    let job = jobInput;
    const currentPolicy = this.assertCurrent(job, signal);
    if (this.batches.enabled(job.event as any)) {
      await this.collect();
      if (
        (await this.batches.cancelRequested(job as any)) ||
        (await this.batches.supersede(job as any))
      ) {
        return;
      }
    }
    if (job.event.kind === 'sns' && this.now() < currentPolicy.momentsNotBefore) {
      throw new Error('尚未到朋友圈自动评论的生效时间');
    }
    this.state(job.id, 'preparing');
    if (job.rule.route && this.resolveTarget) {
      const fresh = await this.resolveTarget(job.event, this.listener.wechatRoot, signal);
      if (['sourceId', 'title', 'wechatId', 'uniqueTitle'].some((k) => fresh[k] !== job.rule[k])) {
        throw new Error('发送前通讯录目标发生变化');
      }
    }
    if (
      messagesOf(job.event as any).some(
        (e: Record<string, any>) => e.mentions?.status === 'unavailable',
      )
    ) {
      throw Error('群消息的原生 @ 来源暂不可核对，未降级为普通回复');
    }
    const target =
      partIndex === 0 ? replyTarget(job.event as any, job.decision as any, currentPolicy.ownId) : null;
    const requestedMentions =
      partIndex === 0 &&
      job.event.session?.endsWith('@chatroom') &&
      Array.isArray(job.decision?.mentions)
        ? (job.decision!.mentions as string[]).slice(0, 3)
        : [];
    if (target || requestedMentions.length > 0) {
      type ResolvedMention = {
        id: string;
        name: string;
        nickname?: string;
        groupNickname?: string;
        uniqueUiName: boolean;
      };
      const resolvedMentions: ResolvedMention[] = [];
      const seenMentionIds = new Set<string>();
      const detailPartsInit: string[] = [];
      let freshEvent: Record<string, any> | undefined;
      const appendExtraMentions = (
        members: Array<{
          id: string;
          nickname?: string;
          groupNickname?: string;
          uiName: string;
          uniqueUiName: boolean;
        }>,
      ): void => {
        const byId = new Map(members.map((m) => [m.id, m]));
        for (const uid of requestedMentions) {
          if (resolvedMentions.length >= 3) break;
          if (!uid || seenMentionIds.has(uid) || uid === currentPolicy.ownId) continue;
          const member = byId.get(uid);
          if (!member) {
            detailPartsInit.push(`群成员 ${uid} 不在当前群列表中，已跳过原生 @`);
            continue;
          }
          if (!member.uiName || !member.uniqueUiName) {
            detailPartsInit.push(`群成员「${member.uiName || uid}」存在重名，已跳过原生 @`);
            continue;
          }
          seenMentionIds.add(member.id);
          resolvedMentions.push({
            id: member.id,
            name: member.uiName,
            nickname: member.nickname,
            groupNickname: member.groupNickname,
            uniqueUiName: true,
          });
        }
      };
      if (target) {
        const verified = this.resolveSource(this.wxarcHome, target.event);
        validateAccount(verified, currentPolicy.ownId, this.listener.wechatRoot as string);
        if (
          verified.sourceKey !== target.event.sourceKey ||
          verified.senderId !== target.event.senderId ||
          verified.session !== job.event.session
        ) {
          throw Error('发送前引用消息身份发生变化');
        }
        const fresh = await this.identify(target.event, signal);
        freshEvent = fresh;
        let useQuote = target.quote;
        if (useQuote && fresh.mentions?.quoteUnique === false) {
          useQuote = false;
          detailPartsInit.unshift('原文在本会话重复，已取消引用并直接回复');
        }
        const canMentionSender = Boolean(
          target.mention && fresh.senderIdentity?.uiName && fresh.senderIdentity.uniqueUiName,
        );
        if (target.mention && canMentionSender) {
          seenMentionIds.add(fresh.senderId);
          resolvedMentions.push({
            id: fresh.senderId,
            name: fresh.senderIdentity.uiName,
            nickname: fresh.senderIdentity.nickname,
            groupNickname: fresh.senderIdentity.groupNickname,
            uniqueUiName: true,
          });
        } else if (target.mention && !canMentionSender) {
          detailPartsInit.push('群内存在重名显示名，已取消原生 @ 并改为引用/直接回复');
        }
        if (!target.quote) {
          detailPartsInit.unshift('本轮有多条原生 @ 消息，按规则不引用原消息');
        }
        if (requestedMentions.length > 0) {
          const members =
            (Array.isArray(fresh.groupMembers) && fresh.groupMembers.length
              ? fresh.groupMembers
              : job.event.groupMembers) || [];
          appendExtraMentions(members);
        }
        const { replyTo: _replyTo, mentions: _mentions, ...decision } = job.decision!;
        const baseDetail = detailPartsInit.filter(Boolean).join('；');
        job = {
          ...job,
          quoteEvent: fresh,
          mention: resolvedMentions[0] ?? null,
          mentions: resolvedMentions,
          decision: { ...decision, action: 'reply', ...(useQuote ? { replyTo: 'current' } : {}) },
          ...(baseDetail ? { deliveryDetail: baseDetail } : {}),
        };
        job.event = {
          ...job.event,
          deliveryReplyTarget: {
            id: fresh.id,
            sourceKey: fresh.sourceKey,
            senderId: fresh.senderId,
            mention: resolvedMentions.length > 0,
            quote: useQuote,
          },
          ...(resolvedMentions.length
            ? {
                deliveryMentions: resolvedMentions.map((m) => ({
                  id: m.id,
                  uiName: m.name,
                  nickname: m.nickname,
                  groupNickname: m.groupNickname,
                })),
              }
            : {}),
        };
        this.store.db
          .prepare('UPDATE automation_jobs SET event=? WHERE id=?')
          .run(JSON.stringify(job.event), job.id);
      } else {
        freshEvent = await this.identify(job.event, signal);
        const members =
          (Array.isArray(freshEvent?.groupMembers) && freshEvent.groupMembers.length
            ? freshEvent.groupMembers
            : job.event.groupMembers) || [];
        appendExtraMentions(members);
        const { mentions: _mentions, ...decision } = job.decision!;
        const baseDetail = detailPartsInit.filter(Boolean).join('；');
        job = {
          ...job,
          mention: resolvedMentions[0] ?? null,
          mentions: resolvedMentions,
          decision,
          ...(baseDetail ? { deliveryDetail: baseDetail } : {}),
        };
        if (resolvedMentions.length > 0) {
          job.event = {
            ...job.event,
            deliveryMentions: resolvedMentions.map((m) => ({
              id: m.id,
              uiName: m.name,
              nickname: m.nickname,
              groupNickname: m.groupNickname,
            })),
          };
          this.store.db
            .prepare('UPDATE automation_jobs SET event=? WHERE id=?')
            .run(JSON.stringify(job.event), job.id);
        }
      }
      if (resolvedMentions.length > 0) {
        await this.stickers?.release(signal);
      }
    }
    let commit: any;
    if (job.decision!.action === 'image') {
      commit = await prepareImage(this as any, job as any, job.imageBytes, signal);
    }
    if (job.decision!.action === 'sticker') {
      try {
        commit = await this.stickers.prepare(job, signal);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await this.stickers?.release(signal);
        this.assertCurrent(job, signal);
        const fallback = {
          action: 'reply',
          text: job.decision!.text,
          reason: '表情未发送，改用文字：' + msg,
        };
        this.state(job.id, 'preparing', fallback.reason, fallback);
        job = { ...job, decision: fallback };
      }
    }
    if (!commit) {
      while (!commit) {
        try {
          commit = await this.cua.prepare({ ...job, deliveryAnchor: this.approvalAnchor(job) }, signal);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const failedId = (err as { mentionId?: string } | null)?.mentionId;
          const currentMentions = job.mentions?.length
            ? job.mentions
            : job.mention
              ? [job.mention]
              : [];
          if (
            currentMentions.length > 0 &&
            msg.includes('无法唯一核对微信 @ 成员菜单') &&
            msg.includes('已清理本次未发送的 @ 查询和引用')
          ) {
            const remaining = failedId
              ? currentMentions.filter((m) => m.id !== failedId)
              : [];
            const skipped = failedId
              ? currentMentions.find((m) => m.id === failedId)
              : currentMentions[0];
            const cleanedMsg = msg.replace(/；已清理本次未发送的 @ 查询和引用$/, '');
            const fallbackNote =
              remaining.length > 0 && skipped
                ? `${cleanedMsg}，已跳过成员「${skipped.name}」的原生 @`
                : `${cleanedMsg}，已取消原生 @ 并直接回复`;
            const mergedDetail = [job.deliveryDetail, fallbackNote].filter(Boolean).join('；');
            const updatedEvent = { ...job.event };
            if (remaining.length > 0) {
              updatedEvent.deliveryMentions = remaining.map((m) => ({
                id: m.id,
                uiName: m.name,
                nickname: m.nickname,
                groupNickname: m.groupNickname,
              }));
            } else {
              delete updatedEvent.deliveryMentions;
            }
            if (updatedEvent.deliveryReplyTarget) {
              updatedEvent.deliveryReplyTarget = {
                ...updatedEvent.deliveryReplyTarget,
                mention: remaining.length > 0,
              };
            }
            job = {
              ...job,
              event: updatedEvent,
              mentions: remaining,
              mention: remaining[0] ?? null,
              deliveryDetail: mergedDetail,
            };
            this.store.db
              .prepare('UPDATE automation_jobs SET event=? WHERE id=?')
              .run(JSON.stringify(job.event), job.id);
          } else {
            throw err;
          }
        }
      }
    }
    this.assertCurrent(job, signal);
    if (this.batches.enabled(job.event as any)) {
      await this.collect();
      if (this.batches.pending(job as any).length) {
        if (job.decision!.action === 'sticker') {
          await this.stickers?.release(signal);
        } else if (commit.discard) {
          await commit.discard(signal);
        } else {
          throw Error('收到新补充；旧草稿未发送，请核对并清理微信输入框');
        }
        if (!(await this.batches.cancelRequested(job as any))) {
          await this.batches.supersede(job as any);
        }
        return;
      }
    }
    if (job.retrying) {
      try {
        if (!this.retryFresh(job)) {
          throw Error('原消息已过补发时限，不再发送');
        }
        if (partIndex === job.retrying.part) {
          const rows = this.archiveHistory(
            this.wxarcHome,
            job.event as any,
            currentPolicy.ownId,
            this.listener.wechatRoot as string,
          ) as Array<Record<string, any>>;
          if (
            rows.length !== job.retrying.rows.length ||
            rows.some((row, i) => row.id !== (job.retrying as any).rows[i].id)
          ) {
            throw Error('准备发送期间 wxarc 出现新消息，停止补发');
          }
        }
      } catch (error) {
        if (commit.discard) {
          await commit.discard(signal);
        }
        throw error;
      }
    }
    this.assertCurrent(job, signal);
    this.store.db
      .prepare(
        "INSERT INTO automation_deliveries(job_id,part_index,text,status,detail,updated_at,clicked_at) VALUES (?,?,?,'sending',?,?,?)",
      )
      .run(job.id, partIndex, job.decision!.text, commit.deliveryDetail || '', this.now(), this.now());
    this.state(
      job.id,
      'sending',
      total > 1 ? `正在发送 ${partIndex + 1}/${total} 条` : commit.deliveryDetail || '',
    );
    const receipt = await commit(signal);
    if (!receipt.confirmed) {
      throw new Error(receipt.detail || '发送结果未确认');
    }
    this.store.db
      .prepare(
        "UPDATE automation_deliveries SET status='sent',detail=?,updated_at=? WHERE job_id=? AND part_index=?",
      )
      .run(receipt.detail || '已核对微信界面结果', this.now(), job.id, partIndex);
    const detailParts: string[] = [];
    if (job.deliveryDetail) detailParts.push(job.deliveryDetail);
    if (receipt.detail) {
      if (detailParts.length === 1 && receipt.detail.includes(detailParts[0])) {
        detailParts[0] = receipt.detail;
      } else if (!detailParts.some((d) => d.includes(receipt.detail!))) {
        detailParts.push(receipt.detail);
      }
    }
    const extraDetail = detailParts.join('；');
    this.state(
      job.id,
      partIndex === total - 1 ? 'sent' : 'preparing',
      (total > 1 ? `已发送并核对 ${partIndex + 1}/${total} 条` : '已通过 SwiftCUA 操作并核对界面结果') +
        (extraDetail ? '；' + extraDetail : ''),
    );
    this.batches.sent(job.event as any);
    return true;
  }

  sendDraft(id: number): Promise<AutomationJob> {
    if (this.active) {
      return Promise.reject(new Error('当前已有任务正在处理'));
    }
    const promise = this._sendDraft(id);
    this.manual = promise;
    return promise;
  }

  async _sendDraft(id: number): Promise<AutomationJob> {
    if (this.active) {
      throw new Error('当前已有任务正在处理');
    }
    const job = this.job(id);
    const retryableBeforeInput =
      job.status === 'failed' &&
      retryableDetail(job.detail) &&
      job.decision?.action === 'reply' &&
      job.event.dshRunId &&
      this.agentBridge?.run(job.event.dshRunId)?.status === 'ready';
    if (job.status !== 'draft' && !retryableBeforeInput) {
      throw new Error('仅可发送尚未发送的草稿，或在输入前因原消息或引用位置无法定位而失败的结果');
    }
    if (job.event.kind === 'sns' && this.now() < this.settings().policy.momentsNotBefore) {
      throw new Error('尚未到朋友圈自动评论的生效时间');
    }
    const abort = (this.active = new AbortController());
    try {
      const s = AbortSignal.any([
        abort.signal,
        this.controller.signal,
        AbortSignal.timeout(60000),
      ]);
      if (retryableBeforeInput) {
        await this.retryReply(job, 0, s);
      } else {
        await this.deliver(job, s);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (['partial', 'uncertain', 'cancelled', 'superseded'].includes(this.job(id).status)) {
        return this.job(id);
      }
      const sending = this.job(id).status === 'sending';
      this.state(
        id,
        sending ? 'uncertain' : 'failed',
        sending ? '未能确认发送，请核对微信；不会自动重发' : `${msg}。请检查微信中是否留下未发送草稿。`,
      );
    } finally {
      this.active = null;
    }
    return this.job(id);
  }

  proactiveStatus(): { queueDepth: number; activeDeliveryId: string | null } {
    return {
      queueDepth: this.proactiveQueueDepth,
      activeDeliveryId: this.activeProactiveId,
    };
  }

  proactiveDeliveries(limit = 50): ProactiveDeliveryRow[] {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    return this.store.db
      .prepare('SELECT * FROM proactive_deliveries ORDER BY created_at DESC LIMIT ?')
      .all(safeLimit) as unknown as ProactiveDeliveryRow[];
  }

  private isChatPaused(session: string): boolean {
    const tableRow = this.store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'wxarc_chat_state'")
      .get() as { name?: string } | undefined;
    if (!tableRow?.name) {
      return false;
    }
    const { policy } = this.settings();
    const ownId = (policy.ownId || '').trim();
    const personaId = (policy.personaId || '').trim();
    if (ownId) {
      const exactScope = JSON.stringify([ownId, personaId, session]);
      const exactRow = this.store.db
        .prepare('SELECT paused FROM wxarc_chat_state WHERE scope = ?')
        .get(exactScope) as { paused?: number } | undefined;
      if (exactRow !== undefined) {
        return Number(exactRow.paused) === 1;
      }
    }
    const fallbackRow = this.store.db
      .prepare(
        "SELECT MAX(paused) AS paused FROM wxarc_chat_state WHERE json_extract(scope, '$[2]') = ?",
      )
      .get(session) as { paused?: number | null } | undefined;
    return Number(fallbackRow?.paused ?? 0) === 1;
  }

  async recentSessionMessages(
    params: RecentSessionMessagesParams,
  ): Promise<RecentSessionMessagesResult> {
    const session = String(params?.session || '').trim();
    if (!session) {
      throw new Error('session is required');
    }
    const limit = Math.max(
      1,
      Math.min(MAX_RECENT_LIMIT, Math.floor(Number(params.limit) || DEFAULT_RECENT_LIMIT)),
    );
    const sinceTsMs =
      params.sinceTs !== undefined && Number.isFinite(Number(params.sinceTs))
        ? normalizeTimestampMs(params.sinceTs)
        : 0;
    if (!this.listener.status().healthy && typeof this.listener.tick === 'function') {
      try {
        await this.listener.tick();
      } catch {}
    }
    const healthy = Boolean(this.listener.status()?.healthy);
    const paused = this.isChatPaused(session);
    const ownId = (this.settings().policy.ownId || '').trim();
    const messages: SessionMessageSummary[] = [];
    const rows = this.store.db
      .prepare(
        `SELECT seq, payload
         FROM events
         WHERE kind = 'text' AND json_extract(payload, '$.session') = ?
         ORDER BY seq DESC
         LIMIT ?`,
      )
      .all(session, limit) as unknown as Array<{ seq: number; payload: string }>;
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.payload) as Record<string, unknown>;
        const tsMs = normalizeTimestampMs(parsed.ts ?? parsed.timestamp);
        if (sinceTsMs > 0 && tsMs > 0 && tsMs < sinceTsMs) {
          continue;
        }
        const senderId =
          typeof parsed.senderId === 'string'
            ? parsed.senderId
            : typeof parsed.sender_id === 'string'
              ? parsed.sender_id
              : undefined;
        const sender = typeof parsed.sender === 'string' ? parsed.sender : undefined;
        const isOwn =
          parsed.isOwn === true ||
          parsed.is_own === true ||
          (Boolean(ownId) && (senderId === ownId || sender === ownId));
        const text = typeof parsed.text === 'string' ? parsed.text : '';
        messages.push({
          seq: row.seq,
          chatId: session,
          sender,
          senderId,
          isOwn,
          text,
          timestamp: tsMs,
        });
      } catch {}
    }
    messages.reverse();
    let lastMessageAt: number | null = null;
    let ownSpokeSince = false;
    for (const msg of messages) {
      if (msg.timestamp > 0 && (lastMessageAt === null || msg.timestamp > lastMessageAt)) {
        lastMessageAt = msg.timestamp;
      }
      if (msg.isOwn && (sinceTsMs === 0 || msg.timestamp >= sinceTsMs)) {
        ownSpokeSince = true;
      }
    }
    const nowMs = this.now();
    const secondsSinceLastMessage =
      lastMessageAt !== null ? Math.max(0, Math.floor((nowMs - lastMessageAt) / 1000)) : null;
    return {
      session,
      chatId: session,
      healthy,
      paused,
      chatPaused: paused,
      ownId: ownId || undefined,
      messages,
      lastMessageAt,
      secondsSinceLastMessage,
      ownSpokeSince,
    };
  }

  private upsertProactiveDelivery(params: {
    id: string;
    idempotencyKey: string;
    session: string;
    parts: string[];
    mode: string;
    status: string;
    detail: string;
    reason: string;
    clickedAt: number | null;
    nowMs: number;
  }): void {
    this.store.db
      .prepare(
        `INSERT INTO proactive_deliveries (
           id, idempotency_key, session, parts_json, mode, status, detail, reason,
           clicked_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(idempotency_key) DO UPDATE SET
           parts_json = excluded.parts_json,
           mode = excluded.mode,
           status = excluded.status,
           detail = excluded.detail,
           reason = excluded.reason,
           updated_at = excluded.updated_at`,
      )
      .run(
        params.id,
        params.idempotencyKey,
        params.session,
        JSON.stringify(params.parts),
        params.mode,
        params.status,
        params.detail,
        params.reason,
        params.clickedAt,
        params.nowMs,
        params.nowMs,
      );
  }

  private updateProactiveStatus(id: string, status: string, detail: string): void {
    this.store.db
      .prepare('UPDATE proactive_deliveries SET status = ?, detail = ?, updated_at = ? WHERE id = ?')
      .run(status, detail, this.now(), id);
  }

  private enqueueProactive<T>(task: () => Promise<T>): Promise<T> {
    this.proactiveQueueDepth += 1;
    const run = this.proactiveQueue.then(async () => {
      try {
        return await task();
      } finally {
        this.proactiveQueueDepth = Math.max(0, this.proactiveQueueDepth - 1);
      }
    });
    this.proactiveQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async queueMemoNudge(
    input: MemoNudgeQueueInput,
    signal?: AbortSignal,
  ): Promise<MemoNudgeQueueResult> {
    const memoId = typeof input?.memoId === 'string' ? input.memoId.trim() : '';
    const chatId = typeof input?.chatId === 'string' ? input.chatId.trim() : '';
    const basis = typeof input?.basis === 'string' ? input.basis.trim() : '';
    const title = typeof input?.title === 'string' ? input.title.trim() : '';
    const targetSessionId =
      typeof input?.targetSessionId === 'string' && input.targetSessionId.trim()
        ? input.targetSessionId.trim()
        : null;

    if (!memoId || !chatId || !basis) {
      return { status: 'failed', detail: 'memoId, chatId, and basis are required' };
    }
    if (this.stopped || !this.agentBridge) {
      return { status: 'failed', detail: 'wxarc native agent bridge unavailable' };
    }
    if (!this.listener.status().healthy) {
      return { status: 'failed', detail: 'wxarc listener unhealthy' };
    }
    const { revision, policy } = this.settings();
    if (!policy.enabled || !policy.provider || !policy.model) {
      return { status: 'failed', detail: 'wxarc automation disabled or model unconfigured' };
    }

    const sourceKey = `memo:${memoId}`;
    const existingJob = this.store.db
      .prepare('SELECT id, event FROM automation_jobs WHERE source_key = ?')
      .get(sourceKey) as { id: number; event: string } | undefined;
    if (existingJob) {
      let existingSessionId: string | undefined;
      try {
        const parsed = JSON.parse(existingJob.event) as {
          dshSessionId?: string;
          memoTrigger?: { targetSessionId?: string | null };
        };
        existingSessionId = parsed.dshSessionId || parsed.memoTrigger?.targetSessionId || undefined;
      } catch {}
      return {
        status: 'queued',
        jobId: existingJob.id,
        sessionId: existingSessionId ?? targetSessionId ?? undefined,
        detail: 'already_queued',
      };
    }

    const nowMs = this.now();
    const probeEvent = {
      kind: 'text',
      session: chatId,
      text: title ? `${title}\n${basis}` : basis,
      ts: Math.floor(nowMs / 1000),
      local_type: 1,
    };
    let rule: any = policy.rules.find((r) => r.kind === 'text' && r.sourceId === chatId);
    if (this.resolveTarget) {
      try {
        rule = await this.resolveTarget(probeEvent, this.listener.wechatRoot, signal);
      } catch (err) {
        if (!rule) {
          return {
            status: 'failed',
            detail: `Target verification failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }
    }
    if (!rule) {
      return { status: 'failed', detail: `Target verification failed: unknown session "${chatId}"` };
    }

    const minSeqRow = this.store.db
      .prepare('SELECT COALESCE(MIN(event_seq), 0) AS minSeq FROM automation_jobs')
      .get() as { minSeq?: number } | undefined;
    const syntheticSeq = Math.min(0, Number(minSeqRow?.minSeq ?? 0)) - 1;

    const syntheticEvent: Record<string, any> = {
      id: 0,
      seq: syntheticSeq,
      kind: 'text',
      session: chatId,
      session_name: rule.title || chatId,
      sender: '待惦记便签',
      senderId: (policy.ownId || '').trim() || 'system:memo',
      sourceId: chatId,
      sourceKey,
      text: title ? `${title}\n${basis}` : basis,
      ts: Math.floor(nowMs / 1000),
      local_type: 1,
      personaId: policy.personaId,
      manualRequestedAt: nowMs,
      memoTrigger: {
        memoId,
        targetSessionId,
        title,
        basis,
        windowStart: input.windowStart ?? null,
        windowEnd: input.windowEnd ?? null,
      },
    };

    const existingConv =
      typeof this.agentBridge.findConversation === 'function'
        ? this.agentBridge.findConversation(syntheticEvent, policy)
        : undefined;
    const resolvedSessionId = existingConv?.session_id ?? targetSessionId ?? undefined;

    const inserted = this.store.db
      .prepare(
        "INSERT INTO automation_jobs(event_seq,source_key,revision,event,rule,status,detail,created_at,updated_at) VALUES (?,?,?,?,?,'queued','便签到点，等待进入原微信会话生成提醒',?,?)",
      )
      .run(
        syntheticSeq,
        sourceKey,
        revision,
        JSON.stringify(syntheticEvent),
        JSON.stringify(rule),
        nowMs,
        nowMs,
      );

    return {
      status: 'queued',
      jobId: Number(inserted.lastInsertRowid),
      sessionId: resolvedSessionId,
      detail: 'Queued for WeChat DSH conversation',
    };
  }

  async sendProactive(
    input: ProactiveSendInput,
    signal?: AbortSignal,
  ): Promise<ProactiveSendResult> {
    const session = String(input?.session || '').trim();
    const idempotencyKey = String(input?.idempotencyKey || '').trim();
    const mode: 'send' | 'draft' = input?.mode === 'draft' ? 'draft' : 'send';
    const reason = typeof input?.reason === 'string' ? input.reason.slice(0, 300) : '';
    const warnOutcome = (
      status: 'failed' | 'uncertain' | 'skipped',
      detail: string,
      deliveryId?: string,
    ): ProactiveSendResult => {
      this.logger?.warn?.(
        `[wxarc] sendProactive ${status} (session=${session || '-'}, key=${idempotencyKey || '-'}, reason=${reason || '-'}): ${detail}`,
      );
      return deliveryId ? { status, deliveryId, detail } : { status, detail };
    };
    if (!session) {
      return warnOutcome('failed', 'Missing session');
    }
    if (!idempotencyKey) {
      return warnOutcome('failed', 'Missing idempotencyKey');
    }
    if (input.imagePath !== undefined && typeof input.imagePath !== 'string') {
      return warnOutcome('failed', 'Invalid imagePath');
    }
    const imagePath = typeof input.imagePath === 'string' ? input.imagePath.trim() : '';
    let imageData: OutgoingImageData | null = null;
    if (imagePath) {
      try {
        imageData = loadLocalImage(imagePath);
      } catch (err) {
        return warnOutcome('failed', err instanceof Error ? err.message : String(err));
      }
    }
    const normalized = normalizeProactiveParts(input.text, Boolean(imageData));
    if (!normalized.ok) {
      return warnOutcome('failed', normalized.error);
    }
    const currentOwnId = (this.settings().policy.ownId || '').trim();
    const expectedOwnId =
      typeof input.expectedOwnId === 'string' ? input.expectedOwnId.trim() : '';
    if (expectedOwnId && currentOwnId && expectedOwnId !== currentOwnId) {
      return warnOutcome(
        'failed',
        `Account ownId mismatch: expected "${expectedOwnId}", bridge bound to "${currentOwnId}"`,
      );
    }
    if (expectedOwnId && !currentOwnId) {
      return warnOutcome(
        'failed',
        `Account ownId verification failed: bridge has no configured ownId (expected "${expectedOwnId}")`,
      );
    }
    const inFlight = this.inFlightProactive.get(idempotencyKey);
    if (inFlight) {
      return inFlight;
    }
    const existing = this.store.db
      .prepare('SELECT * FROM proactive_deliveries WHERE idempotency_key = ?')
      .get(idempotencyKey) as ProactiveDeliveryRow | undefined;
    if (existing) {
      if (existing.status === 'sent') {
        return {
          status: 'sent',
          deliveryId: existing.id,
          detail: 'Idempotent replay: already sent',
        };
      }
      if (existing.status === 'uncertain' || existing.status === 'sending') {
        return {
          status: 'uncertain',
          deliveryId: existing.id,
          detail: existing.detail || 'Previous delivery uncertain; never automatically replayed',
        };
      }
      if (existing.status === 'staged' && mode === 'draft') {
        return {
          status: 'staged',
          deliveryId: existing.id,
          detail: existing.detail || 'Draft already staged',
        };
      }
    }
    const nowMs = this.now();
    const deliveryId = existing?.id ?? `wxp_${randomUUID()}`;
    const storedParts = imageData
      ? [...normalized.parts, `[image:${imagePath}]`]
      : normalized.parts;
    if (mode === 'draft') {
      this.upsertProactiveDelivery({
        id: deliveryId,
        idempotencyKey,
        session,
        parts: storedParts,
        mode,
        status: 'staged',
        detail: 'Staged as proactive draft',
        reason,
        clickedAt: null,
        nowMs,
      });
      return {
        status: 'staged',
        deliveryId,
        detail: imageData
          ? `Staged ${normalized.parts.length} segment(s) and 1 image for ${session}`
          : `Staged ${normalized.parts.length} segment(s) for ${session}`,
      };
    }
    this.upsertProactiveDelivery({
      id: deliveryId,
      idempotencyKey,
      session,
      parts: storedParts,
      mode,
      status: 'queued',
      detail: 'Queued for serialized GUI delivery',
      reason,
      clickedAt: null,
      nowMs,
    });
    const taskPromise = this.enqueueProactive(async (): Promise<ProactiveSendResult> => {
      this.activeProactiveId = deliveryId;
      let abort: AbortController | null = null;
      try {
        const currentRow = this.store.db
          .prepare('SELECT id, status, detail FROM proactive_deliveries WHERE idempotency_key = ?')
          .get(idempotencyKey) as { id: string; status: string; detail: string } | undefined;
        if (currentRow?.status === 'sent') {
          return {
            status: 'sent',
            deliveryId: currentRow.id,
            detail: 'Idempotent replay: already sent',
          };
        }
        if (currentRow?.status === 'uncertain' || currentRow?.status === 'sending') {
          return {
            status: 'uncertain',
            deliveryId: currentRow.id,
            detail:
              currentRow.detail || 'Previous delivery uncertain; never automatically replayed',
          };
        }
        for (let i = 0; this.active && i < 200; i++) {
          if (this.stopped || signal?.aborted || this.controller.signal.aborted) {
            const detail = 'Aborted while waiting for GUI slot';
            this.updateProactiveStatus(deliveryId, 'failed', detail);
            return warnOutcome('failed', detail, deliveryId);
          }
          await pause(50, undefined, {
            signal: signal
              ? AbortSignal.any([signal, this.controller.signal])
              : this.controller.signal,
          }).catch(() => {});
        }
        if (this.stopped || signal?.aborted || this.controller.signal.aborted) {
          const detail = 'Aborted before send started';
          this.updateProactiveStatus(deliveryId, 'failed', detail);
          return warnOutcome('failed', detail, deliveryId);
        }
        if (this.active) {
          const detail = 'Automation GUI busy; skipped proactive send';
          this.updateProactiveStatus(deliveryId, 'skipped', detail);
          return warnOutcome('skipped', detail, deliveryId);
        }
        if (this.stickers?.lease) {
          const detail = 'Sticker panel lease active; skipped GUI conflict';
          this.updateProactiveStatus(deliveryId, 'skipped', detail);
          return warnOutcome('skipped', detail, deliveryId);
        }
        if (!this.listener.status().healthy) {
          const detail = 'wxarc listener unhealthy';
          this.updateProactiveStatus(deliveryId, 'failed', detail);
          return warnOutcome('failed', detail, deliveryId);
        }
        abort = this.active = new AbortController();
        const combinedSignal = AbortSignal.any([
          abort.signal,
          this.controller.signal,
          ...(signal ? [signal] : []),
          AbortSignal.timeout(120000),
        ]);
        const policy = this.settings().policy;
        const syntheticEvent = {
          kind: 'text',
          session,
          text: normalized.parts[0] || '[图片]',
          ts: Math.floor(this.now() / 1000),
          local_type: 1,
        };
        let rule: any = policy.rules.find((r) => r.kind === 'text' && r.sourceId === session);
        if (this.resolveTarget) {
          try {
            rule = await this.resolveTarget(syntheticEvent, this.listener.wechatRoot, combinedSignal);
          } catch (err) {
            const detail = `Target verification failed: ${err instanceof Error ? err.message : String(err)}`;
            this.updateProactiveStatus(deliveryId, 'failed', detail);
            return warnOutcome('failed', detail, deliveryId);
          }
        }
        if (!rule) {
          const detail = `Target verification failed: unknown session "${session}"`;
          this.updateProactiveStatus(deliveryId, 'failed', detail);
          return warnOutcome('failed', detail, deliveryId);
        }
        const totalSteps = normalized.parts.length + (imageData ? 1 : 0);
        let sentSteps = 0;
        const prepareWithRetry = async <T>(prepareFn: () => Promise<T>): Promise<T> => {
          const delays = this.proactiveRetryDelaysMs.slice(0, 2);
          for (let attempt = 0; ; attempt++) {
            try {
              if (this.stickers?.lease) {
                throw new Error('Sticker panel lease active');
              }
              return await prepareFn();
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              const rowState = this.store.db
                .prepare('SELECT status, clicked_at FROM proactive_deliveries WHERE id = ?')
                .get(deliveryId) as { status: string; clicked_at: number | null } | undefined;
              const canRetry =
                sentSteps === 0 &&
                rowState?.status === 'queued' &&
                rowState.clicked_at === null &&
                attempt < delays.length &&
                !this.stopped &&
                !combinedSignal.aborted &&
                isRetryableProactivePrepareError(msg);
              if (!canRetry) {
                throw err;
              }
              const waitMs = Math.max(0, delays[attempt]);
              await pause(waitMs, undefined, { signal: combinedSignal });
            }
          }
        };
        for (let i = 0; i < normalized.parts.length; i++) {
          const partText = normalized.parts[i];
          let commit: any;
          try {
            commit = await prepareWithRetry(() =>
              this.cua.prepare(
                {
                  event: {
                    kind: 'text',
                    session,
                    text: '',
                    ts: Math.floor(this.now() / 1000),
                    local_type: 1,
                  },
                  rule,
                  decision: { action: 'reply', text: partText },
                },
                combinedSignal,
              ),
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (sentSteps > 0) {
              const detail = `Pre-send prepare failed after ${sentSteps} segment(s) sent (${msg}); marked uncertain`;
              this.updateProactiveStatus(deliveryId, 'uncertain', detail);
              return warnOutcome('uncertain', detail, deliveryId);
            }
            const detail = `Pre-send prepare failed: ${msg}`;
            this.updateProactiveStatus(deliveryId, 'failed', detail);
            return warnOutcome('failed', detail, deliveryId);
          }
          const clickedAt = this.now();
          this.store.db
            .prepare(
              `UPDATE proactive_deliveries
               SET status = 'sending',
                   detail = ?,
                   clicked_at = ?,
                   updated_at = ?
               WHERE id = ?`,
            )
            .run(`Commit in progress (${sentSteps + 1}/${totalSteps})`, clickedAt, clickedAt, deliveryId);
          try {
            const receipt = await commit(combinedSignal);
            if (!receipt?.confirmed) {
              const detail = receipt?.detail || 'Send confirmation missing; marked uncertain and never automatically replayed';
              this.updateProactiveStatus(deliveryId, 'uncertain', detail);
              return warnOutcome('uncertain', detail, deliveryId);
            }
          } catch (err) {
            const detail = `Mid-send failure (${err instanceof Error ? err.message : String(err)}); marked uncertain and never automatically replayed`;
            this.updateProactiveStatus(deliveryId, 'uncertain', detail);
            return warnOutcome('uncertain', detail, deliveryId);
          }
          sentSteps += 1;
          if (sentSteps < totalSteps) {
            try {
              await pause(350, undefined, { signal: combinedSignal });
            } catch (err) {
              const detail = `Interrupted between segments (${err instanceof Error ? err.message : String(err)}); marked uncertain`;
              this.updateProactiveStatus(deliveryId, 'uncertain', detail);
              return warnOutcome('uncertain', detail, deliveryId);
            }
          }
        }
        if (imageData) {
          let imageCommit: any;
          try {
            imageCommit = await prepareWithRetry(() =>
              this.prepareOutgoingImage(
                this as any,
                {
                  rule,
                  event: {
                    session,
                  },
                  decision: {
                    image: basename(imagePath),
                  },
                },
                imageData,
                combinedSignal,
              ),
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (sentSteps > 0) {
              const detail = `Pre-send image prepare failed after ${sentSteps} segment(s) sent (${msg}); marked uncertain`;
              this.updateProactiveStatus(deliveryId, 'uncertain', detail);
              return warnOutcome('uncertain', detail, deliveryId);
            }
            const detail = `Pre-send image prepare failed: ${msg}`;
            this.updateProactiveStatus(deliveryId, 'failed', detail);
            return warnOutcome('failed', detail, deliveryId);
          }
          const clickedAt = this.now();
          this.store.db
            .prepare(
              `UPDATE proactive_deliveries
               SET status = 'sending',
                   detail = ?,
                   clicked_at = ?,
                   updated_at = ?
               WHERE id = ?`,
            )
            .run(`Commit in progress (${sentSteps + 1}/${totalSteps})`, clickedAt, clickedAt, deliveryId);
          try {
            const receipt = await imageCommit(combinedSignal);
            if (!receipt?.confirmed) {
              const detail =
                receipt?.detail || 'Image send confirmation missing; marked uncertain and never automatically replayed';
              this.updateProactiveStatus(deliveryId, 'uncertain', detail);
              return warnOutcome('uncertain', detail, deliveryId);
            }
          } catch (err) {
            const detail = `Mid-send image failure (${err instanceof Error ? err.message : String(err)}); marked uncertain and never automatically replayed`;
            this.updateProactiveStatus(deliveryId, 'uncertain', detail);
            return warnOutcome('uncertain', detail, deliveryId);
          }
          sentSteps += 1;
        }
        const detail = imageData
          ? normalized.parts.length > 0
            ? `Delivered ${normalized.parts.length} segment(s) and 1 image to ${session}`
            : `Delivered 1 image to ${session}`
          : `Delivered ${normalized.parts.length} segment(s) to ${session}`;
        this.updateProactiveStatus(deliveryId, 'sent', detail);
        return { status: 'sent', deliveryId, detail };
      } finally {
        if (abort && this.active === abort) {
          this.active = null;
        }
        this.activeProactiveId = null;
      }
    }).finally(() => {
      this.inFlightProactive.delete(idempotencyKey);
    });
    this.inFlightProactive.set(idempotencyKey, taskPromise);
    return taskPromise;
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.collect();
        await this.process();
      } catch {
        this.lastError = '自动处理暂不可用，请检查配置和 wxarc 数据来源';
      }
      if (!this.stopped) {
        await new Promise<void>((resolve) => {
          const done = (): void => {
            clearTimeout(timer);
            this.controller.signal.removeEventListener('abort', done);
            resolve();
          };
          const timer = setTimeout(done, 2000);
          this.controller.signal.addEventListener('abort', done, { once: true });
        });
      }
    }
  }

  stop(): void {
    this.agentBridge?.cancelAll('监听插件停止，任务不会自动重放');
    this.stopped = true;
    this.controller.abort();
    this.active?.abort();
  }

  async close(): Promise<void> {
    this.stop();
    await this.manual?.catch(() => {});
    await this.proactiveQueue.catch(() => {});
    if (this.lease) {
      this.lease.close();
      this.lease = null;
    }
  }
}
