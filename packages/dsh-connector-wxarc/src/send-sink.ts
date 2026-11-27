import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  ActionSink,
  HubService,
  SinkInvokeInput,
  SinkInvokeResult,
  WatcherDb,
  WatcherService,
  WechatSendResult,
  WechatTransport,
} from '@local/dsh-hub/contracts';
import { MAX_PROACTIVE_SEGMENTS, normalizeProactiveParts } from './automation.js';

export const WXARC_SEND_SINK_ID = 'wxarc.send';
export const WXARC_PROACTIVE_SEND_TOOL = 'wxarc_proactive_send';

export interface WechatSendSinkConfig {
  ownId?: string;
  blockedOwnIds?: string[];
  defaultNotifyTarget?: string;
  allowedTargets?: string[];
  requireApprovalByDefault?: boolean;
}

export type DbHandle = WatcherDb | DatabaseSync | null | undefined;

export interface CreateWechatSendSinkOptions {
  transport: WechatTransport;
  config?: WechatSendSinkConfig;
  db?: DbHandle;
}

export interface ExtendedWechatSinkInput extends SinkInvokeInput {
  workstreamId?: string;
  previewText?: string;
  approved?: boolean;
}

export interface ToolExecutionContext {
  agent?: {
    id?: string;
    session?: {
      header?: {
        cwd?: string;
        delegationDepth?: number;
        origin?: string;
      };
    };
  };
}

export interface WechatToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (
    args: Record<string, unknown>,
    exec?: ToolExecutionContext,
  ) => Promise<SinkInvokeResult>;
}

export interface ToolsRegistryLike {
  register?: (def: WechatToolDefinition) => (() => void) | void;
}

export interface WechatToolContextLike {
  hub?: Pick<HubService, 'invokeSink'>;
  watcher?: Pick<WatcherService, 'invokeSink'>;
  get?: (serviceName: string) => unknown;
  tools?: ToolsRegistryLike;
}

function resolveSqlite(db: DbHandle): DatabaseSync | null {
  if (!db) return null;
  if ('prepare' in db && typeof db.prepare === 'function') return db;
  if ('db' in db && db.db && typeof db.db.prepare === 'function') return db.db;
  return null;
}

function normalizeSegments(
  payload: Record<string, unknown>,
): { ok: true; segments: string[] } | { ok: false; error: string } {
  const raw = payload.segments ?? payload.messages ?? payload.text;
  if (typeof raw !== 'string' && !Array.isArray(raw)) {
    return {
      ok: false,
      error: `WeChat message must contain between 1 and ${MAX_PROACTIVE_SEGMENTS} non-empty segments`,
    };
  }
  const normalized = normalizeProactiveParts(raw as string | string[], false);
  if (!normalized.ok) {
    return normalized;
  }
  return { ok: true, segments: normalized.parts };
}

function isTargetAllowed(chatId: string, allowedTargets?: string[]): boolean {
  if (!Array.isArray(allowedTargets) || allowedTargets.length === 0) return true;
  if (allowedTargets.includes('*')) return true;
  return allowedTargets.includes(chatId);
}

function getDraftStatusInDb(sqlite: DatabaseSync | null, idempotencyKey: string): string | null {
  if (!sqlite || !idempotencyKey) return null;
  try {
    const row = sqlite
      .prepare('SELECT status FROM staged_drafts WHERE idempotency_key = ?')
      .get(idempotencyKey) as { status?: string } | undefined;
    return row?.status ?? null;
  } catch {
    return null;
  }
}

function persistWechatDraft(
  sqlite: DatabaseSync | null,
  params: {
    sinkId: string;
    input: ExtendedWechatSinkInput;
    chatId: string;
    segments: string[];
  },
): { draftId: string; previewText: string } {
  const { sinkId, input, chatId, segments } = params;
  const draftId = `drf_${randomUUID()}`;
  const idempotencyKey =
    input.idempotencyKey || `wxarc-draft:${chatId}:${draftId}`;
  const previewText =
    input.previewText ||
    `[WeChat -> ${chatId}] ${segments.join(' / ').slice(0, 140)}`;

  if (!sqlite) {
    return { draftId: idempotencyKey, previewText };
  }

  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO staged_drafts (
         id, sink_id, sink_kind, action, workstream_id, session_id,
         target_json, payload_json, preview_text, idempotency_key, status, created_at, updated_at
       ) VALUES (?, ?, 'irreversible-gui', ?, ?, ?, ?, ?, ?, ?, 'pending_approval', ?, ?)`,
    )
    .run(
      draftId,
      sinkId,
      String(input.action || 'send'),
      input.workstreamId ?? null,
      input.sessionId ?? null,
      JSON.stringify(input.target ?? { chatId }),
      JSON.stringify({ ...input.payload, text: segments }),
      previewText,
      idempotencyKey,
      now,
      now,
    );

  const existing = sqlite
    .prepare('SELECT id FROM staged_drafts WHERE idempotency_key = ?')
    .get(idempotencyKey) as { id?: string } | undefined;
  return { draftId: existing?.id || draftId, previewText };
}

function markDraftStatus(
  sqlite: DatabaseSync | null,
  idempotencyKey: string,
  status: 'executed' | 'uncertain',
  receipt: Record<string, unknown>,
): void {
  if (!sqlite || !idempotencyKey) return;
  try {
    sqlite
      .prepare(
        'UPDATE staged_drafts SET status = ?, receipt_json = ?, updated_at = ? WHERE idempotency_key = ?',
      )
      .run(status, JSON.stringify(receipt), new Date().toISOString(), idempotencyKey);
  } catch {
    void 0;
  }
}

function mapTransportResult(result: WechatSendResult): SinkInvokeResult {
  if (result.status === 'sent') {
    return {
      status: 'executed',
      receiptId: result.deliveryId,
      detail: result.detail,
    };
  }
  if (result.status === 'staged') {
    return {
      status: 'staged',
      draftId: result.deliveryId,
      detail: result.detail,
    };
  }
  if (result.status === 'uncertain') {
    return {
      status: 'uncertain',
      receiptId: result.deliveryId,
      detail: result.detail || 'Delivery outcome uncertain; never automatically replayed',
    };
  }
  if (result.status === 'skipped') {
    return {
      status: 'skipped',
      receiptId: result.deliveryId,
      detail: result.detail,
    };
  }
  return {
    status: 'failed',
    receiptId: result.deliveryId,
    detail: result.detail || 'WeChat delivery failed',
  };
}

export function createWechatSendSink(options: CreateWechatSendSinkOptions): ActionSink {
  const { transport, config = {}, db = null } = options;
  const sqlite = resolveSqlite(db);
  const blockedOwnIds = new Set(
    (config.blockedOwnIds ?? []).map((id) => String(id || '').trim()).filter(Boolean),
  );
  const uncertainKeys = new Map<string, SinkInvokeResult>();
  const executedKeys = new Map<string, SinkInvokeResult>();
  let serialTail: Promise<void> = Promise.resolve();

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = serialTail.then(fn);
    serialTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  return {
    id: WXARC_SEND_SINK_ID,
    label: 'WeChat Proactive Send Sink (macOS wxarc)',
    kind: 'irreversible-gui',
    requiresApproval: config.requireApprovalByDefault !== false,

    async invoke(rawInput: SinkInvokeInput, signal?: AbortSignal): Promise<SinkInvokeResult> {
      const input = rawInput as ExtendedWechatSinkInput;
      const chatId = String(
        input?.target?.chatId || input?.target?.session || config.defaultNotifyTarget || '',
      ).trim();

      if (!chatId) {
        return { status: 'failed', detail: 'Missing target.chatId for wxarc.send' };
      }

      if (!isTargetAllowed(chatId, config.allowedTargets)) {
        return {
          status: 'skipped',
          detail: `Target chat "${chatId}" is not in allowedTargets`,
        };
      }

      const normalized = normalizeSegments(input.payload ?? {});
      if (!normalized.ok) {
        return { status: 'failed', detail: normalized.error };
      }

      const idempotencyKey = String(input.idempotencyKey || '').trim();
      if (!idempotencyKey) {
        return { status: 'failed', detail: 'Missing idempotencyKey for wxarc.send' };
      }

      const priorUncertain = uncertainKeys.get(idempotencyKey);
      if (priorUncertain) {
        return priorUncertain;
      }

      const priorExecuted = executedKeys.get(idempotencyKey);
      if (priorExecuted) {
        return priorExecuted;
      }

      const dbStatus = getDraftStatusInDb(sqlite, idempotencyKey);
      if (dbStatus === 'uncertain') {
        const result: SinkInvokeResult = {
          status: 'uncertain',
          detail: 'Prior delivery is uncertain in durable state; refusing automatic replay',
        };
        uncertainKeys.set(idempotencyKey, result);
        return result;
      }

      const approvedInDb = dbStatus === 'approved' || dbStatus === 'executing';
      const mustStage =
        input.stageOnly === true ||
        (config.requireApprovalByDefault === true && input.approved !== true && !approvedInDb);

      if (mustStage) {
        const { draftId } = persistWechatDraft(sqlite, {
          sinkId: WXARC_SEND_SINK_ID,
          input,
          chatId,
          segments: normalized.segments,
        });
        return {
          status: 'staged',
          draftId,
          detail: `Staged WeChat draft (${normalized.segments.length} segment(s)) for ${chatId}`,
        };
      }

      return enqueue(async () => {
        const expectedOwnId = String(
          input?.target?.expectedOwnId || config.ownId || '',
        ).trim();

        if (expectedOwnId || blockedOwnIds.size > 0) {
          const st = await transport.status(signal);
          const actualOwnId = String(st.ownId || '').trim();

          if (actualOwnId && blockedOwnIds.has(actualOwnId)) {
            return {
              status: 'failed',
              detail: `Blocked send from forbidden personal WeChat account "${actualOwnId}"`,
            };
          }

          if (expectedOwnId) {
            if (!actualOwnId) {
              return {
                status: 'failed',
                detail: `Cannot verify WeChat ownId: transport did not report ownId (expected "${expectedOwnId}")`,
              };
            }
            if (actualOwnId !== expectedOwnId) {
              return {
                status: 'failed',
                detail: `WeChat ownId mismatch: expected "${expectedOwnId}", got "${actualOwnId}"`,
              };
            }
          }
        }

        const reason =
          typeof input.payload?.reason === 'string' ? input.payload.reason : undefined;

        try {
          const transportSend = transport.send as (
            req: {
              chatId: string;
              text: string | string[];
              idempotencyKey: string;
              mode?: 'send' | 'draft';
              reason?: string;
              expectedOwnId?: string;
            },
            sig?: AbortSignal,
          ) => Promise<WechatSendResult>;

          const sendResult = await transportSend.call(
            transport,
            {
              chatId,
              text: normalized.segments.length === 1 ? normalized.segments[0] : normalized.segments,
              idempotencyKey,
              mode: 'send',
              reason,
              expectedOwnId: expectedOwnId || undefined,
            },
            signal,
          );

          const mapped = mapTransportResult(sendResult);
          if (mapped.status === 'uncertain') {
            uncertainKeys.set(idempotencyKey, mapped);
            markDraftStatus(sqlite, idempotencyKey, 'uncertain', { ...mapped });
          } else if (mapped.status === 'executed') {
            executedKeys.set(idempotencyKey, mapped);
            markDraftStatus(sqlite, idempotencyKey, 'executed', { ...mapped });
          }
          return mapped;
        } catch (err) {
          const uncertainResult: SinkInvokeResult = {
            status: 'uncertain',
            detail: `Mid-send error (${err instanceof Error ? err.message : String(err)}); marked uncertain and never automatically replayed`,
          };
          uncertainKeys.set(idempotencyKey, uncertainResult);
          markDraftStatus(sqlite, idempotencyKey, 'uncertain', { ...uncertainResult });
          return uncertainResult;
        }
      });
    },
  };
}

function assertRootSessionCaller(exec?: ToolExecutionContext): { sessionId: string } {
  const sessionId = exec?.agent?.id;
  const header = exec?.agent?.session?.header;
  if (!sessionId) {
    throw new Error(
      'wxarc_proactive_send requires an active DSH root session context (exec.agent.id).',
    );
  }
  if (header && ((header.delegationDepth ?? 0) > 0 || header.origin === 'subagent')) {
    throw new Error('Subagents are not permitted to invoke wxarc_proactive_send.');
  }
  return { sessionId };
}

export function registerWechatSendTool(
  ctx: WechatToolContextLike,
  options: { config?: WechatSendSinkConfig; sinkId?: string } = {},
): Array<() => void> {
  const { config = {}, sinkId = WXARC_SEND_SINK_ID } = options;
  const tools =
    typeof ctx.get === 'function'
      ? (ctx.get('tools') as ToolsRegistryLike | undefined)
      : ctx.tools;
  if (!tools?.register) return [];

  const dispose = tools.register({
    name: WXARC_PROACTIVE_SEND_TOOL,
    description:
      'Send a proactive WeChat message (1-6 segments, auto-splitting long text up to 6000 chars) or stage a draft via wxarc.send with ownId safety verification and crash-safe uncertain reporting.',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        chatId: {
          type: 'string',
          description: 'Target WeChat chat/session ID (defaults to configured defaultNotifyTarget)',
        },
        text: {
          oneOf: [
            { type: 'string' },
            {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              maxItems: MAX_PROACTIVE_SEGMENTS,
            },
          ],
          description: `Single message string or array of 1 to ${MAX_PROACTIVE_SEGMENTS} message segments`,
        },
        reason: {
          type: 'string',
          description: 'Short audit reason explaining why this proactive message is being sent',
        },
        stageOnly: {
          type: 'boolean',
          description: 'Force staging as a draft for user approval instead of sending immediately',
        },
        idempotencyKey: {
          type: 'string',
          description: 'Optional deterministic idempotency key to prevent duplicate sends',
        },
      },
    },
    execute: async (args, exec) => {
      const { sessionId } = assertRootSessionCaller(exec);
      const chatId = String(args.chatId || config.defaultNotifyTarget || '').trim();
      const text = args.text as string | string[];
      const reason = typeof args.reason === 'string' ? args.reason : undefined;
      const stageOnly = args.stageOnly === true ? true : undefined;
      const idempotencyKey =
        typeof args.idempotencyKey === 'string' && args.idempotencyKey.trim()
          ? args.idempotencyKey.trim()
          : `wxarc-proactive:${chatId}:${randomUUID()}`;

      const previewBody = Array.isArray(text) ? text.join(' / ') : String(text || '');
      const invokeInput: ExtendedWechatSinkInput = {
        action: 'send',
        target: { chatId },
        payload: { text, reason },
        previewText: `[WeChat -> ${chatId}] ${previewBody.slice(0, 120)}`,
        idempotencyKey,
        sessionId,
        stageOnly,
      };
      const service = ctx.hub ?? ctx.watcher;
      if (!service) {
        return { status: 'failed', detail: 'Hub service unavailable for wxarc.send' };
      }
      return service.invokeSink(sinkId, invokeInput);
    },
  });

  return typeof dispose === 'function' ? [dispose] : [];
}
