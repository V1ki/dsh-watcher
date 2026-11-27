import { randomBytes } from 'node:crypto';
import type { AdminWechatMessage, HubService } from '@local/dsh-hub/contracts';
import type { RouterDb } from './db.js';

export interface RouterApprovalAgentLike {
  id: string;
}

export interface RouterApprovalExecutionLike {
  agent?: RouterApprovalAgentLike;
  callId: string;
  name: string;
  arguments?: Record<string, unknown>;
}

export interface RouterApprovalRunLike {
  id: string;
  preview?: boolean;
  manual?: boolean;
}

export interface RouterApprovalRequestLike {
  agent?: RouterApprovalAgentLike;
  callId: string;
  toolName?: string;
  arguments?: Record<string, unknown>;
  signal?: AbortSignal;
  [key: string]: unknown;
}

export interface RouterApprovalRow {
  code: string;
  run_id: string;
  session_id: string;
  call_id: string;
  tool: string;
  args: string;
  owner_id: string;
  status: string;
  notice_status: string;
  created_at: number;
  expires_at: number;
  decision_source: string | null;
  detail: string;
  notified_at: number | null;
  task_eligible: number;
  scope: string;
}

export interface RouterTaskGrant {
  code: string;
  owner: string;
  session: string;
  expires: number;
}

export interface RouterApprovalConsumeResult {
  matched: boolean;
  decided?: boolean;
  code?: string;
  outcome?: 'allowed-once' | 'allowed-task' | 'rejected';
  replyText?: string;
}

export interface RouterApprovalsOptions {
  db: RouterDb;
  hub: HubService;
  resolveOwnerId: () => Promise<string>;
  now?: () => number;
  ttlMs?: number;
  taskGrantTtlMs?: number;
}

interface CapturedOperation {
  name: string;
  args: Record<string, unknown> | undefined;
  taskEligible?: boolean;
  approvedRun?: string;
  approvedArgs?: string;
  approvedOwner?: string;
  pendingRun?: string;
  pendingArgs?: string;
  pending?: Promise<string>;
  cancel?: () => void;
}

interface LivePendingApproval {
  finish: (outcome: string) => void;
  signal?: AbortSignal;
  owner: string;
  run: RouterApprovalRunLike;
}

const APPROVAL_COMMAND_RE = /^(确认|拒绝|批准本轮任务)(?:\s+([A-Fa-f0-9]{8}))?[。.!！]?$/;
const SENSITIVE_ARG_RE =
  /api[_-]?key|authorization|bearer|password|passwd|secret|credential|cookie|\btoken\b/i;

function sanitizePreviewValue(value: unknown): unknown {
  if (typeof value === 'string') {
    if (SENSITIVE_ARG_RE.test(value)) {
      return '[已脱敏]';
    }
    return value.length > 320 ? `${value.slice(0, 320)}…` : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 12).map((item) => sanitizePreviewValue(item));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_ARG_RE.test(k) ? '[已脱敏]' : sanitizePreviewValue(v);
    }
    return out;
  }
  return value;
}

function formatOperationPreview(tool: string, rawArgs: string): { operation: string; reason: string } {
  let parsed: Record<string, unknown> = {};
  try {
    const candidate = JSON.parse(rawArgs);
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      parsed = candidate as Record<string, unknown>;
    }
  } catch {
  }
  const sanitized = sanitizePreviewValue(parsed) as Record<string, unknown>;
  let operation =
    tool === 'bash' && typeof sanitized.command === 'string'
      ? sanitized.command
      : JSON.stringify(sanitized);
  if (operation.length > 480) {
    operation = `${operation.slice(0, 480)}…`;
  }
  const reason =
    typeof sanitized.justification === 'string' && sanitized.justification.trim()
      ? `\n原因：${sanitized.justification.trim()}`
      : '';
  return { operation, reason };
}

export class RouterApprovals {
  private readonly routerDb: RouterDb;
  private readonly hub: HubService;
  private readonly resolveOwnerId: () => Promise<string>;
  private readonly nowFn: () => number;
  private readonly ttlMs: number;
  private readonly taskGrantTtlMs: number;
  private readonly forwarded = new WeakSet<object>();
  private readonly live = new Map<string, LivePendingApproval>();
  private readonly executions = new Map<string, CapturedOperation>();
  private readonly grants = new Map<string, RouterTaskGrant>();

  constructor(options: RouterApprovalsOptions) {
    this.routerDb = options.db;
    this.hub = options.hub;
    this.resolveOwnerId = options.resolveOwnerId;
    this.nowFn = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? 15 * 60_000;
    this.taskGrantTtlMs = options.taskGrantTtlMs ?? 30 * 60_000;
  }

  capture(exec: RouterApprovalExecutionLike): void {
    const agentId = exec.agent?.id?.trim();
    if (!agentId) return;
    const key = `${agentId}:${exec.callId}`;
    const old = this.executions.get(key);
    const nextArgs = exec.arguments === undefined ? {} : structuredClone(exec.arguments);
    if (
      old &&
      old.name === exec.name &&
      JSON.stringify(old.args) === JSON.stringify(nextArgs)
    ) {
      return;
    }
    old?.cancel?.();
    this.executions.set(key, {
      name: exec.name,
      args: nextArgs,
    });
  }

  eligible(exec: RouterApprovalExecutionLike, value: boolean): void {
    const agentId = exec.agent?.id?.trim();
    if (!agentId) return;
    const op = this.executions.get(`${agentId}:${exec.callId}`);
    if (op) {
      op.taskEligible = value;
    }
  }

  release(exec: RouterApprovalExecutionLike): void {
    const agentId = exec.agent?.id?.trim();
    if (!agentId) return;
    const key = `${agentId}:${exec.callId}`;
    this.executions.get(key)?.cancel?.();
    this.executions.delete(key);
  }

  allows(exec: RouterApprovalExecutionLike, run: RouterApprovalRunLike): boolean {
    const agentId = exec.agent?.id?.trim();
    if (!agentId) return false;
    const grant = this.grants.get(run.id);
    const op = this.executions.get(`${agentId}:${exec.callId}`);
    if (
      !grant ||
      !op?.taskEligible ||
      run.manual ||
      run.preview ||
      grant.session !== agentId ||
      grant.expires <= this.nowFn()
    ) {
      return false;
    }
    this.routerDb.db
      .prepare('INSERT OR IGNORE INTO router_task_uses VALUES (?, ?, ?, ?, ?, ?)')
      .run(run.id, exec.callId, agentId, exec.name, grant.code, this.nowFn());
    return true;
  }

  revoke(runId: string): void {
    this.grants.delete(runId);
    const rows = this.routerDb.db
      .prepare("SELECT code FROM router_approvals WHERE run_id = ? AND status = 'pending'")
      .all(runId) as Array<{ code: string }>;
    for (const row of rows) {
      this.live.get(row.code)?.finish('cancelled');
    }
  }

  message(row: RouterApprovalRow): string {
    const { operation, reason } = formatOperationPreview(row.tool, row.args);
    const task = row.task_eligible
      ? '\n也可回复“批准本轮任务”，本轮后续常规操作沿用授权；危险操作仍逐项确认。'
      : '';
    return [
      'DSH 有一项操作需要你确认：',
      `工具：${row.tool}`,
      `具体操作：${operation}${reason}`,
      '',
      `回复“确认”只允许这一项，回复“拒绝”则不执行。${task}`,
      `有多项待确认时，请在回复末尾加确认码 ${row.code}；15 分钟内有效。`,
    ].join('\n');
  }

  listPending(ownerId?: string): RouterApprovalRow[] {
    const now = this.nowFn();
    if (ownerId) {
      return this.routerDb.db
        .prepare(
          "SELECT * FROM router_approvals WHERE owner_id = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at ASC",
        )
        .all(ownerId, now) as unknown as RouterApprovalRow[];
    }
    return this.routerDb.db
      .prepare(
        "SELECT * FROM router_approvals WHERE status = 'pending' AND expires_at > ? ORDER BY created_at ASC",
      )
      .all(now) as unknown as RouterApprovalRow[];
  }

  listRecent(limit = 50): RouterApprovalRow[] {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit) || 50));
    return this.routerDb.db
      .prepare('SELECT * FROM router_approvals ORDER BY created_at DESC LIMIT ?')
      .all(safeLimit) as unknown as RouterApprovalRow[];
  }

  async request(
    req: RouterApprovalRequestLike,
    next: () => Promise<string> | string,
    run?: RouterApprovalRunLike | null,
  ): Promise<string> {
    if (this.forwarded.has(req)) {
      return next();
    }
    const agentId = req.agent?.id?.trim();
    if (!agentId || !run || run.preview || run.manual) {
      return next();
    }

    const owner = (await this.resolveOwnerId()).trim();
    if (!owner) {
      return next();
    }

    const opKey = `${agentId}:${req.callId}`;
    let operation = this.executions.get(opKey);
    if (!operation) {
      operation = {
        name: req.toolName?.trim() || 'unknown',
        args: req.arguments === undefined ? {} : structuredClone(req.arguments),
        taskEligible: false,
      };
      this.executions.set(opKey, operation);
    }

    const raw = JSON.stringify(operation.args ?? {});
    if (req.signal?.aborted) {
      return 'cancelled';
    }
    if (
      operation.approvedRun === run.id &&
      operation.approvedArgs === raw &&
      operation.approvedOwner === owner
    ) {
      return 'allowed-once';
    }
    if (operation.pending && operation.pendingRun === run.id && operation.pendingArgs === raw) {
      const cancel = (): void => {
        operation?.cancel?.();
      };
      req.signal?.addEventListener('abort', cancel, { once: true });
      try {
        return await operation.pending;
      } finally {
        req.signal?.removeEventListener('abort', cancel);
      }
    }

    const code = randomBytes(4).toString('hex').toUpperCase();
    const created = this.nowFn();
    const expires = created + this.ttlMs;
    const taskEligibleInt = operation.taskEligible ? 1 : 0;

    this.routerDb.db
      .prepare(
        `INSERT INTO router_approvals (
           code, run_id, session_id, call_id, tool, args, owner_id, status,
           notice_status, created_at, expires_at, decision_source, detail, notified_at,
           task_eligible, scope
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'queued', ?, ?, NULL, '', NULL, ?, 'once')`,
      )
      .run(
        code,
        run.id,
        agentId,
        req.callId,
        operation.name,
        raw,
        owner,
        created,
        expires,
        taskEligibleInt,
      );

    const insertedRow = this.routerDb.db
      .prepare('SELECT * FROM router_approvals WHERE code = ?')
      .get(code) as unknown as RouterApprovalRow;

    operation.pendingRun = run.id;
    operation.pendingArgs = raw;

    const pending = new Promise<string>((resolvePromise) => {
      let settled = false;
      const uiLifetime = new AbortController();
      const finish = (initialOutcome: string): void => {
        if (settled) return;
        settled = true;
        let outcome = initialOutcome;
        if (outcome === 'allowed-task' && !operation?.taskEligible) {
          outcome = 'cancelled';
        }
        if (outcome === 'allowed-task') {
          this.grants.set(run.id, {
            code,
            owner,
            session: agentId,
            expires: this.nowFn() + this.taskGrantTtlMs,
          });
        }
        if (outcome === 'allowed-once' || outcome === 'allowed-task') {
          Object.assign(operation!, {
            approvedRun: run.id,
            approvedArgs: raw,
            approvedOwner: owner,
          });
        }
        uiLifetime.abort();
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', onAbort);
        this.live.delete(code);
        this.routerDb.db
          .prepare("UPDATE router_approvals SET status = ?, detail = ? WHERE code = ? AND status = 'pending'")
          .run(
            outcome,
            outcome === 'allowed-task'
              ? '已批准本轮常规操作，危险操作仍逐项确认'
              : outcome === 'allowed-once'
                ? '已批准此单次调用'
                : '此次操作未获批准',
            code,
          );
        if (outcome === 'rejected' || outcome === 'cancelled') {
          this.grants.delete(run.id);
        }
        resolvePromise(outcome === 'allowed-task' ? 'allowed-once' : outcome);
      };

      const onAbort = (): void => finish('cancelled');
      const timer = setTimeout(() => finish('cancelled'), this.ttlMs);
      timer.unref?.();
      operation!.cancel = (): void => finish('cancelled');
      this.live.set(code, { finish, signal: req.signal, owner, run });
      req.signal?.addEventListener('abort', onAbort, { once: true });
      if (req.signal?.aborted) {
        onAbort();
        return;
      }

      const uiRequest: RouterApprovalRequestLike = {
        ...req,
        signal: AbortSignal.any([uiLifetime.signal, ...(req.signal ? [req.signal] : [])]),
      };
      this.forwarded.add(uiRequest);
      Promise.resolve()
        .then(() => next())
        .then(
          (outcome) => {
            if (typeof outcome === 'string' && outcome !== 'unavailable') {
              finish(outcome);
            }
          },
          () => {},
        );
    });

    operation.pending = pending;
    await this.dispatchWechatNotice(insertedRow);

    try {
      return await pending;
    } finally {
      if (operation.pending === pending) {
        delete operation.pending;
        delete operation.cancel;
      }
    }
  }

  private async dispatchWechatNotice(row: RouterApprovalRow): Promise<void> {
    const transport = this.hub.getWechatTransport?.();
    if (!transport) {
      this.updateNoticeStatus(row.code, 'failed', 'wechat_transport_unavailable');
      return;
    }
    try {
      const res = await transport.send({
        chatId: row.owner_id,
        text: this.message(row),
        idempotencyKey: `router-approval:${row.code}`,
        mode: 'send',
        reason: 'router_approval_request',
      });
      if (res.status === 'sent' || res.status === 'staged') {
        this.updateNoticeStatus(row.code, 'sent', '');
      } else {
        this.updateNoticeStatus(row.code, 'failed', res.detail ?? res.status);
      }
    } catch (err) {
      this.updateNoticeStatus(row.code, 'failed', err instanceof Error ? err.message : String(err));
    }
  }

  private updateNoticeStatus(code: string, state: string, detail: string): void {
    this.routerDb.db
      .prepare(
        "UPDATE router_approvals SET notice_status = ?, detail = CASE WHEN ? != '' THEN ? ELSE detail END, notified_at = CASE WHEN ? = 'sent' THEN ? ELSE notified_at END WHERE code = ?",
      )
      .run(state, detail, detail, state, this.nowFn(), code);
  }

  decide(
    code: string,
    outcome: 'allowed-once' | 'allowed-task' | 'rejected',
    source = 'wechat',
  ): void {
    const normalizedCode = code.trim().toUpperCase();
    const row = this.routerDb.db
      .prepare('SELECT * FROM router_approvals WHERE code = ?')
      .get(normalizedCode) as unknown as RouterApprovalRow | undefined;
    const pending = this.live.get(normalizedCode);
    if (
      !row ||
      row.status !== 'pending' ||
      row.expires_at <= this.nowFn() ||
      !pending ||
      pending.signal?.aborted
    ) {
      throw new Error('此次操作确认已失效');
    }
    if (outcome === 'allowed-task' && !row.task_eligible) {
      throw new Error('此操作必须单次确认，不能批准整轮');
    }
    this.routerDb.db
      .prepare('UPDATE router_approvals SET decision_source = ?, scope = ? WHERE code = ?')
      .run(source, outcome === 'allowed-task' ? 'task' : 'once', normalizedCode);
    pending.finish(outcome);
  }

  consume(msg: AdminWechatMessage): RouterApprovalConsumeResult {
    const text = (msg.text ?? '').trim();
    const match = APPROVAL_COMMAND_RE.exec(text);
    if (!match) {
      return { matched: false };
    }

    const actionWord = match[1];
    const explicitCode = match[2]?.toUpperCase();
    if (
      msg.sourceKey &&
      this.routerDb.db
        .prepare('SELECT 1 FROM router_approvals WHERE decision_source = ?')
        .get(msg.sourceKey)
    ) {
      return { matched: true };
    }

    const now = this.nowFn();
    let code = explicitCode;
    if (!code) {
      const pendingRows = this.routerDb.db
        .prepare(
          "SELECT code, tool FROM router_approvals WHERE status = 'pending' AND expires_at > ? ORDER BY created_at ASC",
        )
        .all(now) as Array<{ code: string; tool: string }>;
      if (pendingRows.length === 0) {
        return { matched: false };
      }
      if (pendingRows.length > 1) {
        const list = pendingRows.map((r) => `- ${r.code} (${r.tool})`).join('\n');
        return {
          matched: true,
          decided: false,
          replyText: `当前有 ${pendingRows.length} 项待确认操作，请附带 8 位确认码回复（例如：确认 ${pendingRows[0]!.code}）：\n${list}`,
        };
      }
      code = pendingRows[0]!.code;
    }

    const row = this.routerDb.db
      .prepare('SELECT * FROM router_approvals WHERE code = ?')
      .get(code) as unknown as RouterApprovalRow | undefined;
    const pending = this.live.get(code);

    if (
      !row ||
      row.status !== 'pending' ||
      row.expires_at <= now ||
      !pending ||
      pending.signal?.aborted
    ) {
      return {
        matched: true,
        decided: false,
        code,
        replyText: `确认码 ${code} 已失效或不存在。`,
      };
    }

    if (
      msg.senderId &&
      row.owner_id &&
      row.owner_id !== 'filehelper' &&
      msg.senderId !== row.owner_id &&
      msg.session !== row.owner_id
    ) {
      return {
        matched: true,
        decided: false,
        code,
        replyText: `确认码 ${code} 与当前审批人不匹配。`,
      };
    }

    const outcome: 'allowed-once' | 'allowed-task' | 'rejected' =
      actionWord === '批准本轮任务'
        ? 'allowed-task'
        : actionWord === '确认'
          ? 'allowed-once'
          : 'rejected';

    if (outcome === 'allowed-task' && !row.task_eligible) {
      return {
        matched: true,
        decided: false,
        code,
        replyText: `操作 ${code}（${row.tool}）必须单次确认，不能批准整轮；请回复“确认 ${code}”或“拒绝 ${code}”。`,
      };
    }

    this.decide(code, outcome, msg.sourceKey || `wechat:${msg.senderId || msg.session || 'owner'}`);
    const label =
      outcome === 'allowed-task'
        ? `已批准本轮常规操作（${code}）。`
        : outcome === 'allowed-once'
          ? `已确认执行（${code} · ${row.tool}）。`
          : `已拒绝该操作（${code} · ${row.tool}）。`;

    return {
      matched: true,
      decided: true,
      code,
      outcome,
      replyText: label,
    };
  }

  close(): void {
    for (const pending of [...this.live.values()]) {
      pending.finish('cancelled');
    }
    this.live.clear();
    this.executions.clear();
    this.grants.clear();
  }
}
