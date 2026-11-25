import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  Automation,
  MemoNudgeQueueInput,
  MemoNudgeQueueResult,
  ProactiveDeliveryRow,
  ProactiveSendResult,
  RecentSessionMessagesResult,
} from './automation.js';

const DEFAULT_FALLBACK_ORIGIN = 'http://localhost';
const MAX_BODY_BYTES = 65_536;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export interface WxarcBridgeSendInput {
  chatId?: string;
  session?: string;
  text: string | string[];
  imagePath?: string;
  idempotencyKey: string;
  mode?: 'send' | 'draft';
  reason?: string;
  expectedOwnId?: string;
}

export interface WxarcBridgeRecentParams {
  chatId?: string;
  session?: string;
  limit?: number;
  sinceTs?: number;
}

export interface WxarcBridgeStatus {
  ok: boolean;
  healthy: boolean;
  ownId?: string;
  controllerId?: string;
  queueDepth: number;
  activeDeliveryId: string | null;
  detail: string;
}

export interface WxarcBridgeOptions {
  automation: Automation;
  listener: {
    status(): { healthy: boolean; [key: string]: unknown };
  };
  token?: string | (() => string | null | undefined);
  allowLanHost?: boolean;
}

function constantTimeTokenMatch(expected: string, actual: string): boolean {
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(actual, 'utf8');
  if (expectedBuf.length !== actualBuf.length) {
    return false;
  }
  return timingSafeEqual(expectedBuf, actualBuf);
}

function extractHostname(hostHeader: string | undefined): string {
  if (!hostHeader) {
    return '';
  }
  const trimmed = hostHeader.trim();
  if (trimmed.startsWith('[')) {
    const closeIdx = trimmed.indexOf(']');
    return closeIdx > 0 ? trimmed.slice(0, closeIdx + 1).toLowerCase() : '';
  }
  const colonIdx = trimmed.lastIndexOf(':');
  return (colonIdx >= 0 ? trimmed.slice(0, colonIdx) : trimmed).toLowerCase();
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      const err = new Error('Request payload too large') as Error & { statusCode?: number };
      err.statusCode = 413;
      throw err;
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const err = new Error('JSON body must be an object') as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof Error && 'statusCode' in err) {
      throw err;
    }
    const parseErr = new Error('Invalid JSON body') as Error & { statusCode?: number };
    parseErr.statusCode = 400;
    throw parseErr;
  }
}

export class WxarcBridge {
  private readonly automation: Automation;
  private readonly listener: WxarcBridgeOptions['listener'];
  private readonly tokenProvider?: string | (() => string | null | undefined);
  private readonly allowLanHost: boolean;

  constructor(options: WxarcBridgeOptions) {
    this.automation = options.automation;
    this.listener = options.listener;
    this.tokenProvider = options.token;
    this.allowLanHost = Boolean(options.allowLanHost);
  }

  private resolveToken(): string {
    const raw =
      typeof this.tokenProvider === 'function' ? this.tokenProvider() : this.tokenProvider;
    return typeof raw === 'string' ? raw.trim() : '';
  }

  status(): WxarcBridgeStatus {
    let healthy = false;
    try {
      healthy = Boolean(this.listener.status()?.healthy);
    } catch {
      healthy = false;
    }
    const policy = this.automation.settings().policy;
    const ownId = (policy.ownId || '').trim();
    const controllerId = (policy.controllerId || '').trim();
    const { queueDepth, activeDeliveryId } = this.automation.proactiveStatus();
    return {
      ok: true,
      healthy,
      ownId: ownId || undefined,
      controllerId: controllerId || undefined,
      queueDepth,
      activeDeliveryId,
      detail: healthy ? 'ready' : 'listener_unhealthy',
    };
  }

  listDeliveries(limit = 50): ProactiveDeliveryRow[] {
    return this.automation.proactiveDeliveries(limit);
  }

  async send(input: WxarcBridgeSendInput, signal?: AbortSignal): Promise<ProactiveSendResult> {
    const session = String(input?.chatId || input?.session || '').trim();
    return this.automation.sendProactive(
      {
        session,
        text: input.text,
        imagePath: input.imagePath,
        idempotencyKey: input.idempotencyKey,
        mode: input.mode,
        reason: input.reason,
        expectedOwnId: input.expectedOwnId,
      },
      signal,
    );
  }

  async triggerMemoNudge(
    input: MemoNudgeQueueInput,
    signal?: AbortSignal,
  ): Promise<MemoNudgeQueueResult> {
    return this.automation.queueMemoNudge(input, signal);
  }

  async recentMessages(
    params: WxarcBridgeRecentParams,
    _signal?: AbortSignal,
  ): Promise<RecentSessionMessagesResult> {
    const session = String(params?.chatId || params?.session || '').trim();
    return this.automation.recentSessionMessages({
      session,
      limit: params.limit,
      sinceTs: params.sinceTs,
    });
  }

  async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const parsedUrl = new URL(req.url || '/', DEFAULT_FALLBACK_ORIGIN);
    const pathname = parsedUrl.pathname;
    if (!pathname.startsWith('/wxarc/bridge/')) {
      return false;
    }

    if (!this.allowLanHost) {
      const host = extractHostname(req.headers.host);
      if (host && !LOOPBACK_HOSTS.has(host)) {
        sendJson(res, 403, { error: 'Forbidden: loopback host required' });
        return true;
      }
    }

    const expectedToken = this.resolveToken();
    if (!expectedToken) {
      sendJson(res, 503, { error: 'Bridge Bearer token not configured' });
      return true;
    }

    const authHeader = String(req.headers.authorization || '');
    const prefix = 'Bearer ';
    if (!authHeader.startsWith(prefix)) {
      sendJson(res, 401, { error: 'Unauthorized: missing Bearer token' });
      return true;
    }
    const providedToken = authHeader.slice(prefix.length).trim();
    if (!providedToken || !constantTimeTokenMatch(expectedToken, providedToken)) {
      sendJson(res, 401, { error: 'Unauthorized: invalid Bearer token' });
      return true;
    }

    try {
      if (pathname === '/wxarc/bridge/status' && req.method === 'GET') {
        sendJson(res, 200, this.status());
        return true;
      }

      if (pathname === '/wxarc/bridge/recent' && (req.method === 'GET' || req.method === 'POST')) {
        let chatId = '';
        let limit: number | undefined;
        let sinceTs: number | undefined;
        if (req.method === 'GET') {
          chatId =
            parsedUrl.searchParams.get('chatId') || parsedUrl.searchParams.get('session') || '';
          const limitParam = parsedUrl.searchParams.get('limit');
          const sinceParam = parsedUrl.searchParams.get('sinceTs');
          if (limitParam !== null && limitParam !== '') {
            limit = Number(limitParam);
          }
          if (sinceParam !== null && sinceParam !== '') {
            sinceTs = Number(sinceParam);
          }
        } else {
          const body = await readJsonBody(req);
          chatId = String(body.chatId || body.session || '');
          if (body.limit !== undefined) {
            limit = Number(body.limit);
          }
          if (body.sinceTs !== undefined) {
            sinceTs = Number(body.sinceTs);
          }
        }
        if (!chatId.trim()) {
          sendJson(res, 400, { error: 'Missing chatId' });
          return true;
        }
        const result = await this.recentMessages({ chatId, limit, sinceTs });
        sendJson(res, 200, result);
        return true;
      }

      if (pathname === '/wxarc/bridge/send' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const result = await this.send({
          chatId: String(body.chatId || body.session || ''),
          text: body.text as string | string[],
          imagePath: typeof body.imagePath === 'string' ? body.imagePath : undefined,
          idempotencyKey: String(body.idempotencyKey || ''),
          mode: body.mode === 'draft' ? 'draft' : 'send',
          reason: typeof body.reason === 'string' ? body.reason : undefined,
          expectedOwnId: typeof body.expectedOwnId === 'string' ? body.expectedOwnId : undefined,
        });
        sendJson(res, 200, result);
        return true;
      }

      if (pathname === '/wxarc/bridge/memo-nudge' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const result = await this.triggerMemoNudge({
          memoId: String(body.memoId || ''),
          chatId: String(body.chatId || body.session || ''),
          targetSessionId:
            typeof body.targetSessionId === 'string' ? body.targetSessionId : null,
          title: typeof body.title === 'string' ? body.title : undefined,
          basis: String(body.basis || ''),
          windowStart: typeof body.windowStart === 'string' ? body.windowStart : null,
          windowEnd: typeof body.windowEnd === 'string' ? body.windowEnd : null,
        });
        sendJson(res, 200, result);
        return true;
      }

      sendJson(res, 404, { error: 'Not found' });
      return true;
    } catch (err) {
      const statusCode =
        err instanceof Error && 'statusCode' in err && typeof err.statusCode === 'number'
          ? err.statusCode
          : 500;
      sendJson(res, statusCode, {
        error: err instanceof Error ? err.message : String(err),
      });
      return true;
    }
  }
}

export function createWxarcBridge(options: WxarcBridgeOptions): WxarcBridge {
  return new WxarcBridge(options);
}
