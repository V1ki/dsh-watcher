import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { resolveOwnerId } from './admin.js';

export interface ApprovalStoreLike {
  db: DatabaseSync;
}

export interface ApprovalSettingsSnapshot {
  revision?: number;
  policy: {
    controllerId?: string;
    adminIds?: string[];
  };
}

export interface ApprovalAgentLike {
  id: string;
}

export interface ApprovalExecutionLike {
  agent?: ApprovalAgentLike;
  callId: string;
  name: string;
  arguments?: Record<string, unknown>;
}

export interface ApprovalRunLike {
  id: string;
  preview?: number | boolean;
  manual?: number | boolean;
}

export interface ApprovalRequestLike {
  agent: ApprovalAgentLike;
  callId: string;
  toolName?: string;
  signal?: AbortSignal;
  [key: string]: unknown;
}

export interface ApprovalRow {
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

export interface ApprovalConsumeEventLike {
  kind?: string;
  session?: string;
  senderId?: string;
  local_type?: number;
  text?: string;
  ts?: number;
  sourceKey?: string;
}

interface CapturedOperation {
  name: string;
  args: Record<string, unknown> | undefined;
  taskEligible?: boolean;
  approvedRun?: string;
  approvedArgs?: string;
  approvedOwner?: string;
  approvedRevision?: number;
  pendingRun?: string;
  pendingArgs?: string;
  pending?: Promise<string>;
  cancel?: () => void;
}

export interface TaskGrant {
  code: string;
  owner: string;
  session: string;
  revision: number | undefined;
  expires: number;
}

interface LivePendingApproval {
  finish: (outcome: string) => void;
  signal?: AbortSignal;
  owner: string;
  run: ApprovalRunLike;
}

type TableColumnInfo = { name: string };

export class WechatApprovals {
  store: ApprovalStoreLike;
  settings: () => ApprovalSettingsSnapshot;
  forward?: (req: ApprovalRequestLike) => Promise<string>;
  forwarded: WeakSet<object>;
  live: Map<string, LivePendingApproval>;
  executions: Map<string, CapturedOperation>;
  grants: Map<string, TaskGrant>;

  constructor(
    store: ApprovalStoreLike,
    settings: () => ApprovalSettingsSnapshot,
    forward?: (req: ApprovalRequestLike) => Promise<string>,
  ) {
    this.store = store;
    this.settings = settings;
    this.forward = forward;
    this.forwarded = new WeakSet();
    this.live = new Map();
    this.executions = new Map();
    this.grants = new Map();
    store.db.exec(
      `CREATE TABLE IF NOT EXISTS wechat_approvals(code TEXT PRIMARY KEY,run_id TEXT NOT NULL,session_id TEXT NOT NULL,call_id TEXT NOT NULL,tool TEXT NOT NULL,args TEXT NOT NULL,owner_id TEXT NOT NULL,status TEXT NOT NULL,notice_status TEXT NOT NULL DEFAULT 'queued',created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,decision_source TEXT,detail TEXT NOT NULL DEFAULT '');`,
    );
    const columns = store.db.prepare('PRAGMA table_info(wechat_approvals)').all() as unknown as TableColumnInfo[];
    if (!columns.some((c) => c.name === 'notified_at')) {
      store.db.exec('ALTER TABLE wechat_approvals ADD COLUMN notified_at INTEGER');
    }
    for (const [name, type] of [
      ['task_eligible', 'INTEGER NOT NULL DEFAULT 0'],
      ['scope', "TEXT NOT NULL DEFAULT 'once'"],
    ] as const) {
      const latestColumns = store.db
        .prepare('PRAGMA table_info(wechat_approvals)')
        .all() as unknown as TableColumnInfo[];
      if (!latestColumns.some((c) => c.name === name)) {
        store.db.exec(`ALTER TABLE wechat_approvals ADD COLUMN ${name} ${type}`);
      }
    }
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS wechat_task_uses(run_id TEXT NOT NULL,call_id TEXT NOT NULL,session_id TEXT NOT NULL,tool TEXT NOT NULL,grant_code TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(run_id,session_id,call_id))',
    );
    store.db
      .prepare(
        "UPDATE wechat_approvals SET status='cancelled',detail='服务重启，确认码已失效' WHERE status='pending'",
      )
      .run();
  }

  capture(exec: ApprovalExecutionLike): void {
    if (!exec.agent) {
      return;
    }
    const key = `${exec.agent.id}:${exec.callId}`;
    const old = this.executions.get(key);
    if (
      old &&
      old.name === exec.name &&
      JSON.stringify(old.args) === JSON.stringify(exec.arguments)
    ) {
      return;
    }
    old?.cancel?.();
    this.executions.set(key, {
      name: exec.name,
      args: structuredClone(exec.arguments),
    });
  }

  eligible(exec: ApprovalExecutionLike, value: boolean): void {
    if (!exec.agent) {
      return;
    }
    const op = this.executions.get(`${exec.agent.id}:${exec.callId}`);
    if (op) {
      op.taskEligible = value;
    }
  }

  release(exec: ApprovalExecutionLike): void {
    const key = `${exec.agent?.id}:${exec.callId}`;
    this.executions.get(key)?.cancel?.();
    this.executions.delete(key);
  }

  allows(exec: ApprovalExecutionLike, run: ApprovalRunLike): boolean {
    if (!exec.agent) {
      return false;
    }
    const grant = this.grants.get(run.id);
    const settings = this.settings();
    const op = this.executions.get(`${exec.agent.id}:${exec.callId}`);
    if (
      !grant ||
      !op?.taskEligible ||
      run.manual ||
      run.preview ||
      grant.owner !== resolveOwnerId(settings.policy) ||
      grant.revision !== settings.revision ||
      grant.session !== exec.agent.id ||
      grant.expires <= Date.now()
    ) {
      return false;
    }
    this.store.db
      .prepare('INSERT OR IGNORE INTO wechat_task_uses VALUES (?,?,?,?,?,?)')
      .run(run.id, exec.callId, exec.agent.id, exec.name, grant.code, Date.now());
    return true;
  }

  revoke(runId: string): void {
    this.grants.delete(runId);
    const rows = this.store.db
      .prepare("SELECT code FROM wechat_approvals WHERE run_id=? AND status='pending'")
      .all(runId) as unknown as Array<{ code: string }>;
    for (const row of rows) {
      this.live.get(row.code)?.finish('cancelled');
    }
  }

  async request(
    req: ApprovalRequestLike,
    next: () => Promise<string> | string,
    run?: ApprovalRunLike | null,
  ): Promise<string> {
    if (this.forwarded.has(req)) {
      return next();
    }
    const owner = resolveOwnerId(this.settings().policy);
    const operation = this.executions.get(`${req.agent.id}:${req.callId}`);
    if (!owner || !run || run.preview || run.manual || !operation) {
      return next();
    }
    const raw = JSON.stringify(operation.args);
    if (req.signal?.aborted) {
      return 'cancelled';
    }
    if (
      operation.approvedRun === run.id &&
      operation.approvedArgs === raw &&
      operation.approvedOwner === owner &&
      operation.approvedRevision === this.settings().revision
    ) {
      return 'allowed-once';
    }
    if (operation.pending && operation.pendingRun === run.id && operation.pendingArgs === raw) {
      const cancel = (): void => {
        operation.cancel?.();
      };
      req.signal?.addEventListener('abort', cancel, { once: true });
      try {
        return await operation.pending;
      } finally {
        req.signal?.removeEventListener('abort', cancel);
      }
    }
    const bashCommand = typeof operation.args?.command === 'string' ? operation.args.command : '';
    if (
      raw.length > 850 ||
      (operation.name === 'bash' && /\bsudo\b[^|;\n]*?\s-[A-Za-z]*S/.test(bashCommand)) ||
      /api[_-]?key|authorization|bearer|password|passwd|secret|credential|cookie|\btoken\b/i.test(
        raw,
      )
    ) {
      return next();
    }
    const code = randomBytes(4).toString('hex').toUpperCase();
    const created = Date.now();
    this.store.db
      .prepare(
        'INSERT INTO wechat_approvals(code,run_id,session_id,call_id,tool,args,owner_id,status,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        code,
        run.id,
        req.agent.id,
        req.callId,
        operation.name,
        raw,
        owner,
        'pending',
        created,
        created + 15 * 60000,
      );
    this.store.db
      .prepare('UPDATE wechat_approvals SET task_eligible=? WHERE code=?')
      .run(operation.taskEligible ? 1 : 0, code);
    operation.pendingRun = run.id;
    operation.pendingArgs = raw;
    const pending = new Promise<string>((resolve) => {
      let settled = false;
      const uiLifetime = new AbortController();
      const finish = (initialOutcome: string): void => {
        if (settled) {
          return;
        }
        settled = true;
        let outcome = initialOutcome;
        const cfg = this.settings();
        if (
          resolveOwnerId(cfg.policy) !== owner ||
          (outcome === 'allowed-task' && !operation.taskEligible)
        ) {
          outcome = 'cancelled';
        }
        if (outcome === 'allowed-task') {
          this.grants.set(run.id, {
            code,
            owner,
            session: req.agent.id,
            revision: cfg.revision,
            expires: Date.now() + 30 * 60000,
          });
        }
        if (['allowed-once', 'allowed-task'].includes(outcome)) {
          Object.assign(operation, {
            approvedRun: run.id,
            approvedArgs: raw,
            approvedOwner: owner,
            approvedRevision: cfg.revision,
          });
        }
        uiLifetime.abort();
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', abort);
        this.live.delete(code);
        this.store.db
          .prepare(
            "UPDATE wechat_approvals SET status=?,detail=? WHERE code=? AND status='pending'",
          )
          .run(
            outcome,
            outcome === 'allowed-task'
              ? '已批准本轮常规操作，危险操作仍逐项确认'
              : outcome === 'allowed-once'
                ? '已批准此单次调用'
                : '此次操作未获批准',
            code,
          );
        if (['rejected', 'cancelled'].includes(outcome)) {
          this.grants.delete(run.id);
        }
        resolve(outcome === 'allowed-task' ? 'allowed-once' : outcome);
      };
      const abort = (): void => finish('cancelled');
      const timer = setTimeout(() => finish('cancelled'), 15 * 60000);
      operation.cancel = (): void => finish('cancelled');
      this.live.set(code, { finish, signal: req.signal, owner, run });
      req.signal?.addEventListener('abort', abort, { once: true });
      if (req.signal?.aborted) {
        abort();
      }
      const uiRequest: ApprovalRequestLike = {
        ...req,
        signal: AbortSignal.any([uiLifetime.signal, ...(req.signal ? [req.signal] : [])]),
      };
      this.forwarded.add(uiRequest);
      Promise.resolve()
        .then(() => (this.forward ? this.forward(uiRequest) : next()))
        .then(
          (outcome) => {
            if (outcome !== 'unavailable') {
              finish(outcome);
            }
          },
          () => {},
        );
    });
    operation.pending = pending;
    try {
      return await pending;
    } finally {
      if (operation.pending === pending) {
        delete operation.pending;
        delete operation.cancel;
      }
    }
  }

  notices(): ApprovalRow[] {
    return this.store.db
      .prepare(
        "SELECT * FROM wechat_approvals WHERE status='pending' AND notice_status='queued' AND expires_at>? ORDER BY created_at",
      )
      .all(Date.now()) as unknown as ApprovalRow[];
  }

  notice(code: string, state: string, detail = ''): void {
    this.store.db
      .prepare(
        "UPDATE wechat_approvals SET notice_status=?,detail=?,notified_at=CASE WHEN ?='sent' THEN ? ELSE notified_at END WHERE code=?",
      )
      .run(state, detail, state, Date.now(), code);
  }

  message(row: ApprovalRow): string {
    const args = JSON.parse(row.args) as Record<string, unknown>;
    const operation =
      row.tool === 'bash' && typeof args.command === 'string' ? args.command : row.args;
    const reason = typeof args.justification === 'string' ? `\n原因：${args.justification}` : '';
    const task = row.task_eligible
      ? '\n也可回复“批准本轮任务”，本轮后续常规操作沿用授权；删除、安装、系统变更及影响不明的脚本仍单独确认，结束即失效。'
      : '';
    return `DSH 有一项操作需要你确认：\n工具：${row.tool}\n具体操作：${operation}${reason}\n\n回复“确认”只允许这一项，回复“拒绝”则不执行。${task}\n有多项待确认时，请在回复末尾加确认码 ${row.code}；15 分钟内有效。`;
  }

  decide(code: string, outcome: string, source = 'DSH 面板'): void {
    const row = this.store.db
      .prepare('SELECT * FROM wechat_approvals WHERE code=?')
      .get(code) as ApprovalRow | undefined;
    const pending = this.live.get(code);
    if (
      !['allowed-once', 'allowed-task', 'rejected'].includes(outcome) ||
      row?.status !== 'pending' ||
      row.expires_at <= Date.now() ||
      !pending ||
      pending.signal?.aborted
    ) {
      throw new Error('此次操作确认已失效');
    }
    if (row.owner_id !== resolveOwnerId(this.settings().policy)) {
      throw Error('审批人已改变');
    }
    if (outcome === 'allowed-task' && !row.task_eligible) {
      throw Error('此操作必须单次确认，不能批准整轮');
    }
    this.store.db
      .prepare('UPDATE wechat_approvals SET decision_source=?,scope=? WHERE code=?')
      .run(source, outcome === 'allowed-task' ? 'task' : 'once', code);
    pending.finish(outcome);
  }

  hasPending(runId: string): boolean {
    return Boolean(
      this.store.db
        .prepare(
          "SELECT 1 FROM wechat_approvals WHERE run_id=? AND status='pending' AND expires_at>? LIMIT 1",
        )
        .get(runId, Date.now()),
    );
  }

  consume(event: ApprovalConsumeEventLike): boolean {
    const owner = resolveOwnerId(this.settings().policy);
    if (
      !owner ||
      event.kind !== 'text' ||
      event.session !== owner ||
      event.senderId !== owner ||
      (event.local_type ?? 0) % 4294967296 !== 1
    ) {
      return false;
    }
    const match = (event.text || '')
      .trim()
      .match(/^(确认|拒绝|批准本轮任务)(?:\s+([A-Fa-f0-9]{8}))?[。.!！]?$/);
    if (!match) {
      return false;
    }
    if (
      event.sourceKey &&
      this.store.db
        .prepare('SELECT 1 FROM wechat_approvals WHERE decision_source=?')
        .get(event.sourceKey)
    ) {
      return true;
    }
    let code = match[2]?.toUpperCase();
    if (!code) {
      const pendingRows = this.store.db
        .prepare(
          "SELECT code FROM wechat_approvals WHERE owner_id=? AND status='pending' AND expires_at>?",
        )
        .all(owner, Date.now()) as unknown as Array<{ code: string }>;
      if (!pendingRows.length) {
        return false;
      }
      if (pendingRows.length !== 1) {
        return true;
      }
      code = pendingRows[0].code;
    }
    const row = this.store.db
      .prepare('SELECT * FROM wechat_approvals WHERE code=?')
      .get(code) as ApprovalRow | undefined;
    const pending = this.live.get(code);
    if (
      row?.status === 'pending' &&
      row.notice_status === 'sent' &&
      row.owner_id === owner &&
      row.expires_at > Date.now() &&
      (event.ts ?? 0) * 1000 >= (row.notified_at || row.created_at) - 2000 &&
      pending &&
      !pending.signal?.aborted
    ) {
      const outcome =
        match[1] === '批准本轮任务'
          ? 'allowed-task'
          : match[1] === '确认'
            ? 'allowed-once'
            : 'rejected';
      if (outcome !== 'allowed-task' || row.task_eligible) {
        this.decide(code, outcome, event.sourceKey);
      }
    }
    return true;
  }

  close(): void {
    for (const pending of [...this.live.values()]) {
      pending.finish('cancelled');
    }
    this.executions.clear();
    this.grants.clear();
  }
}
