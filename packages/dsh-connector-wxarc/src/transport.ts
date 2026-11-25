import type {
  WechatAtmosphere,
  WechatMemoNudgeInput,
  WechatMemoNudgeResult,
  WechatMessage,
  WechatSendInput,
  WechatSendResult,
  WechatTransport,
  WechatTransportStatus,
} from '@local/dsh-hub/contracts';

export const DEFAULT_REMOTE_BASE_URL = 'http://127.0.0.1:33080';
export const DEFAULT_BRIDGE_TOKEN_CREDENTIAL = 'wxarc-bridge-token';
const PERSONAL_WXARC_PORT = '8765';
const DEFAULT_RECENT_LIMIT = 20;
const DEFAULT_SINCE_MINUTES = 60;
const DEFAULT_QUIET_THRESHOLD_SECONDS = 600;
const DEFAULT_HTTP_TIMEOUT_MS = 15_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export type WechatTransportMode = 'auto' | 'cordis' | 'http';

export interface BridgeCredentialRecord {
  token?: string;
  secret?: string;
  value?: string;
  key?: string;
  kind?: string;
  payload?: unknown;
}

export interface BridgeCredentialStoreLike {
  get?: (
    key: string,
  ) =>
    | Promise<string | BridgeCredentialRecord | null | undefined>
    | string
    | BridgeCredentialRecord
    | null
    | undefined;
  readRecord?: (
    key: string,
  ) =>
    | Promise<BridgeCredentialRecord | null | undefined>
    | BridgeCredentialRecord
    | null
    | undefined;
  resolve?: (
    ref: string,
  ) =>
    | Promise<{ value?: string; source?: string } | null | undefined>
    | { value?: string; source?: string }
    | null
    | undefined;
}

export interface CordisWxarcBridgeLike {
  send(
    input: WechatSendInput & { expectedOwnId?: string },
    signal?: AbortSignal,
  ): Promise<WechatSendResult>;
  triggerMemoNudge?(
    input: WechatMemoNudgeInput,
    signal?: AbortSignal,
  ): Promise<WechatMemoNudgeResult>;
  recentMessages(
    params: { chatId: string; limit?: number; sinceTs?: number },
    signal?: AbortSignal,
  ): Promise<
    | WechatMessage[]
    | {
        healthy?: boolean;
        paused?: boolean;
        ownId?: string;
        messages: WechatMessage[];
      }
  >;
  status(
    signal?: AbortSignal,
  ):
    | Promise<{
        ok?: boolean;
        healthy?: boolean;
        ownId?: string;
        controllerId?: string;
        detail?: string;
      }>
    | {
        ok?: boolean;
        healthy?: boolean;
        ownId?: string;
        controllerId?: string;
        detail?: string;
      };
}

export interface FetchResponseLike {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
  text?: () => Promise<string>;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<FetchResponseLike>;

export interface TransportContextLike {
  get?: (serviceName: string) => unknown;
  credentials?: BridgeCredentialStoreLike;
}

export interface WechatTransportConfig {
  mode?: WechatTransportMode;
  remoteBaseUrl?: string;
  bridgeTokenCredential?: string;
  bridgeToken?: string;
  allowLanHost?: boolean;
  expectedOwnId?: string;
  httpTimeoutMs?: number;
  defaultQuietSeconds?: number;
}

export interface CreateWechatTransportOptions {
  ctx?: TransportContextLike;
  config?: WechatTransportConfig;
  localBridge?: CordisWxarcBridgeLike | null;
  cordisBridge?: CordisWxarcBridgeLike | null;
  credentials?: BridgeCredentialStoreLike | null;
  fetchImpl?: FetchLike;
  now?: () => number;
}

export interface GetAtmosphereOptions {
  sinceMinutes?: number;
  limit?: number;
  quietThresholdSeconds?: number;
}

export interface GetAtmosphereParams extends GetAtmosphereOptions {
  chatId: string;
}

export interface RichWechatAtmosphere extends WechatAtmosphere {
  ownSpokeRecently: boolean;
  chatPaused: boolean;
  recentLines: string[];
  shouldSkipReason: string | null;
}

export class WxarcBridgeSecurityError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'WxarcBridgeSecurityError';
    this.code = code;
  }
}

export class WxarcBridgeHttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'WxarcBridgeHttpError';
    this.statusCode = statusCode;
  }
}

export function validateBridgeBaseUrl(
  rawUrl: string,
  options: { allowLanHost?: boolean } = {},
): string {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) {
    throw new WxarcBridgeSecurityError('EMPTY_URL', 'Bridge remoteBaseUrl must not be empty');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new WxarcBridgeSecurityError('INVALID_URL', `Invalid bridge remoteBaseUrl: ${trimmed}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new WxarcBridgeSecurityError(
      'INVALID_PROTOCOL',
      `Bridge URL must use HTTP or HTTPS protocol (received ${parsed.protocol})`,
    );
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new WxarcBridgeSecurityError(
      'INVALID_URL_PARTS',
      'Bridge URL must not contain credentials, query string, or hash',
    );
  }

  const host = parsed.hostname.toLowerCase();
  const isLoopback = LOOPBACK_HOSTS.has(host);

  if (isLoopback && parsed.port === PERSONAL_WXARC_PORT) {
    throw new WxarcBridgeSecurityError(
      'PERSONAL_WXARC_FORBIDDEN',
      'Refusing to connect to laptop personal wxarc endpoint on loopback port 8765',
    );
  }

  if (!isLoopback && !options.allowLanHost) {
    throw new WxarcBridgeSecurityError(
      'NON_LOOPBACK_FORBIDDEN',
      `Refusing non-loopback bridge host "${parsed.hostname}" without allowLanHost=true`,
    );
  }

  const cleanPath = parsed.pathname.replace(/\/+$/, '');
  return cleanPath && cleanPath !== '/' ? `${parsed.origin}${cleanPath}` : parsed.origin;
}

function normalizeTimestampMs(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return num < 10_000_000_000 ? Math.floor(num * 1000) : Math.floor(num);
}

function normalizeMessage(raw: unknown, fallbackChatId: string): WechatMessage {
  const rec = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    seq: typeof rec.seq === 'number' ? rec.seq : undefined,
    chatId: typeof rec.chatId === 'string' && rec.chatId ? rec.chatId : fallbackChatId,
    sender: typeof rec.sender === 'string' ? rec.sender : undefined,
    senderId: typeof rec.senderId === 'string' ? rec.senderId : undefined,
    isOwn: rec.isOwn === true,
    text: typeof rec.text === 'string' ? rec.text : '',
    timestamp: normalizeTimestampMs(rec.timestamp ?? rec.ts),
  };
}

function formatRecentLine(msg: WechatMessage): string {
  const speaker = msg.isOwn ? 'me' : msg.sender || msg.senderId || 'unknown';
  return `${speaker}: ${msg.text}`;
}

export function computeAtmosphere(params: {
  chatId: string;
  healthy: boolean;
  paused: boolean;
  messages: WechatMessage[];
  sinceMinutes?: number;
  quietThresholdSeconds?: number;
  nowMs?: number;
}): RichWechatAtmosphere {
  const nowMs = params.nowMs ?? Date.now();
  const sinceMinutes =
    params.sinceMinutes !== undefined && Number.isFinite(params.sinceMinutes)
      ? Math.max(0, params.sinceMinutes)
      : DEFAULT_SINCE_MINUTES;
  const quietThresholdSeconds =
    params.quietThresholdSeconds !== undefined && Number.isFinite(params.quietThresholdSeconds)
      ? Math.max(0, params.quietThresholdSeconds)
      : params.sinceMinutes !== undefined
        ? Math.floor(sinceMinutes * 60)
        : DEFAULT_QUIET_THRESHOLD_SECONDS;

  const windowCutoffMs = nowMs - sinceMinutes * 60_000;
  const recentMessages = params.messages.map((m) => normalizeMessage(m, params.chatId));

  let lastMessageAt: number | null = null;
  let ownSpokeRecently = false;
  for (const msg of recentMessages) {
    if (msg.timestamp > 0 && (lastMessageAt === null || msg.timestamp > lastMessageAt)) {
      lastMessageAt = msg.timestamp;
    }
    if (msg.isOwn && (msg.timestamp === 0 || msg.timestamp >= windowCutoffMs)) {
      ownSpokeRecently = true;
    }
  }

  const secondsSinceLastMessage =
    lastMessageAt !== null ? Math.max(0, Math.floor((nowMs - lastMessageAt) / 1000)) : null;

  let shouldSkipReason: string | null = null;
  if (!params.healthy) {
    shouldSkipReason = 'transport_unhealthy';
  } else if (params.paused) {
    shouldSkipReason = 'chat_paused';
  } else if (ownSpokeRecently) {
    shouldSkipReason = 'own_spoke_recently';
  } else if (
    secondsSinceLastMessage !== null &&
    secondsSinceLastMessage < quietThresholdSeconds
  ) {
    shouldSkipReason = 'recent_activity';
  }

  const quiet = shouldSkipReason === null;

  return {
    chatId: params.chatId,
    healthy: params.healthy,
    paused: params.paused,
    chatPaused: params.paused,
    messageCount: recentMessages.length,
    lastMessageAt,
    secondsSinceLastMessage,
    ownSpokeSince: ownSpokeRecently,
    ownSpokeRecently,
    quiet,
    recentMessages,
    recentLines: recentMessages.map(formatRecentLine),
    shouldSkipReason,
  };
}

const BRIDGE_KEY_SEGMENT_RE = /^[a-z][a-z0-9-]*$/;
const BRIDGE_FULL_KEY_RE = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;
const BRIDGE_REF_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function extractTokenValue(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim();
  if (raw && typeof raw === 'object') {
    const rec = raw as BridgeCredentialRecord;
    if (rec.kind === 'grant' && rec.payload !== undefined) {
      return extractTokenValue(rec.payload);
    }
    const candidate = rec.token ?? rec.secret ?? rec.value ?? rec.key;
    if (typeof candidate === 'string') return candidate.trim();
  }
  return '';
}

function buildBridgeRecordKeys(name: string): string[] {
  const trimmed = name.trim();
  if (!trimmed) return [];
  if (BRIDGE_FULL_KEY_RE.test(trimmed)) return [trimmed];
  if (BRIDGE_KEY_SEGMENT_RE.test(trimmed)) {
    return [
      `connector-wxarc/${trimmed}`,
      `watcher-wxarc/${trimmed}`,
      `watcher-wxarc-bridge/${trimmed}`,
      `wxarc-bridge/${trimmed}`,
    ];
  }
  return [];
}

function buildBridgeRefNames(name: string): string[] {
  const trimmed = name.trim();
  if (!trimmed) return [];
  const refs: string[] = [];
  if (BRIDGE_REF_RE.test(trimmed)) refs.push(trimmed);
  const normalized = trimmed
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (normalized && BRIDGE_REF_RE.test(normalized) && !refs.includes(normalized)) {
    refs.push(normalized);
  }
  return refs;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'aborted' in value &&
      typeof (value as AbortSignal).aborted === 'boolean',
  );
}

export class DualModeWechatTransport implements WechatTransport {
  private readonly ctx?: TransportContextLike;
  private readonly mode: WechatTransportMode;
  private readonly remoteBaseUrlRaw: string;
  private readonly allowLanHost: boolean;
  private readonly bridgeTokenCredential: string;
  private readonly fallbackBridgeToken: string;
  private readonly expectedOwnId: string;
  private readonly httpTimeoutMs: number;
  private readonly defaultQuietSeconds: number;
  private readonly explicitCordisBridge?: CordisWxarcBridgeLike | null;
  private readonly explicitCredentials?: BridgeCredentialStoreLike | null;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;

  constructor(options: CreateWechatTransportOptions = {}) {
    const cfg = options.config ?? {};
    this.ctx = options.ctx;
    this.mode = cfg.mode ?? 'auto';
    this.remoteBaseUrlRaw =
      cfg.remoteBaseUrl !== undefined ? cfg.remoteBaseUrl : DEFAULT_REMOTE_BASE_URL;
    this.allowLanHost = Boolean(cfg.allowLanHost);
    this.bridgeTokenCredential =
      cfg.bridgeTokenCredential || DEFAULT_BRIDGE_TOKEN_CREDENTIAL;
    this.fallbackBridgeToken = typeof cfg.bridgeToken === 'string' ? cfg.bridgeToken.trim() : '';
    this.expectedOwnId = typeof cfg.expectedOwnId === 'string' ? cfg.expectedOwnId.trim() : '';
    this.httpTimeoutMs = Math.max(1_000, Number(cfg.httpTimeoutMs) || DEFAULT_HTTP_TIMEOUT_MS);
    this.defaultQuietSeconds = Math.max(
      0,
      Number(cfg.defaultQuietSeconds) || DEFAULT_QUIET_THRESHOLD_SECONDS,
    );
    this.explicitCordisBridge = options.localBridge ?? options.cordisBridge;
    this.explicitCredentials = options.credentials;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.now = options.now ?? Date.now;
  }

  private resolveCordisBridge(): CordisWxarcBridgeLike | null {
    if (this.explicitCordisBridge) return this.explicitCordisBridge;
    const fromCtx = this.ctx?.get?.('wxarcBridge') as CordisWxarcBridgeLike | undefined;
    if (
      fromCtx &&
      typeof fromCtx.send === 'function' &&
      typeof fromCtx.recentMessages === 'function' &&
      typeof fromCtx.status === 'function'
    ) {
      return fromCtx;
    }
    return null;
  }

  private resolveValidatedHttpBase(): string | null {
    if (!this.remoteBaseUrlRaw.trim()) return null;
    return validateBridgeBaseUrl(this.remoteBaseUrlRaw, {
      allowLanHost: this.allowLanHost,
    });
  }

  getActiveMode(): 'cordis' | 'http' | 'unavailable' {
    const cordis = this.resolveCordisBridge();
    if (this.mode === 'cordis') {
      return cordis ? 'cordis' : 'unavailable';
    }
    if (this.mode === 'http') {
      return this.remoteBaseUrlRaw.trim() ? 'http' : 'unavailable';
    }
    if (cordis) return 'cordis';
    return this.remoteBaseUrlRaw.trim() ? 'http' : 'unavailable';
  }

  private async resolveBearerToken(): Promise<string> {
    const credStore =
      this.explicitCredentials ??
      (typeof this.ctx?.get === 'function'
        ? (this.ctx.get('credentials') as BridgeCredentialStoreLike | undefined)
        : this.ctx?.credentials) ??
      null;

    if (credStore && this.bridgeTokenCredential) {
      try {
        if (typeof credStore.readRecord === 'function') {
          for (const key of buildBridgeRecordKeys(this.bridgeTokenCredential)) {
            const token = extractTokenValue(await credStore.readRecord(key));
            if (token) return token;
          }
        }
        if (typeof credStore.resolve === 'function') {
          for (const ref of buildBridgeRefNames(this.bridgeTokenCredential)) {
            const resolved = await credStore.resolve(ref);
            const token = typeof resolved?.value === 'string' ? resolved.value.trim() : '';
            if (token) return token;
          }
        }
        if (typeof credStore.get === 'function') {
          const record = await credStore.get(this.bridgeTokenCredential);
          const token = extractTokenValue(record);
          if (token) return token;
        }
      } catch {
        void 0;
      }
    }

    return this.fallbackBridgeToken;
  }

  private buildRequestSignal(externalSignal?: AbortSignal): AbortSignal {
    const timeoutSignal = AbortSignal.timeout(this.httpTimeoutMs);
    return externalSignal ? AbortSignal.any([externalSignal, timeoutSignal]) : timeoutSignal;
  }

  private async httpJsonRequest(
    method: 'GET' | 'POST',
    endpointPath: string,
    body: Record<string, unknown> | undefined,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const baseUrl = this.resolveValidatedHttpBase();
    if (!baseUrl) {
      throw new Error('HTTP bridge remoteBaseUrl is not configured');
    }

    const token = await this.resolveBearerToken();
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await this.fetchImpl(`${baseUrl}${endpointPath}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: this.buildRequestSignal(signal),
    });

    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const errJson = (await response.json()) as { error?: string };
        if (errJson?.error) detail = errJson.error;
      } catch {
        if (response.text) {
          const text = await response.text().catch(() => '');
          if (text) detail = text.slice(0, 200);
        }
      }
      throw new WxarcBridgeHttpError(response.status, detail);
    }

    const parsed = (await response.json()) as unknown;
    return (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  }

  async status(signal?: AbortSignal): Promise<WechatTransportStatus> {
    const activeMode = this.getActiveMode();

    if (activeMode === 'cordis') {
      const bridge = this.resolveCordisBridge();
      if (!bridge) {
        return {
          ok: false,
          mode: 'unavailable',
          healthy: false,
          detail: 'Cordis wxarcBridge service not available',
        };
      }
      try {
        const result = await bridge.status(signal);
        return {
          ok: result.ok !== false,
          mode: 'cordis',
          healthy: Boolean(result.healthy),
          ownId: result.ownId,
          controllerId:
            typeof result.controllerId === 'string' && result.controllerId.trim()
              ? result.controllerId.trim()
              : undefined,
          detail: result.detail,
        };
      } catch (err) {
        return {
          ok: false,
          mode: 'cordis',
          healthy: false,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    }

    if (activeMode === 'http') {
      let baseUrl: string;
      try {
        baseUrl = this.resolveValidatedHttpBase() || '';
      } catch (err) {
        return {
          ok: false,
          mode: 'unavailable',
          healthy: false,
          detail: err instanceof Error ? err.message : String(err),
        };
      }

      try {
        const data = await this.httpJsonRequest('GET', '/wxarc/bridge/status', undefined, signal);
        return {
          ok: data.ok !== false,
          mode: 'http',
          healthy: Boolean(data.healthy),
          endpoint: baseUrl,
          ownId: typeof data.ownId === 'string' ? data.ownId : undefined,
          controllerId:
            typeof data.controllerId === 'string' && data.controllerId.trim()
              ? data.controllerId.trim()
              : undefined,
          detail: typeof data.detail === 'string' ? data.detail : undefined,
        };
      } catch (err) {
        return {
          ok: false,
          mode: 'http',
          healthy: false,
          endpoint: baseUrl,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    }

    return {
      ok: false,
      mode: 'unavailable',
      healthy: false,
      detail: 'No wxarc Cordis service or HTTP bridge configured',
    };
  }

  async send(
    input: WechatSendInput & { expectedOwnId?: string },
    signal?: AbortSignal,
  ): Promise<WechatSendResult> {
    const activeMode = this.getActiveMode();
    const expectedOwnId = input.expectedOwnId || this.expectedOwnId || undefined;
    const imagePath =
      typeof input.imagePath === 'string' && input.imagePath.trim()
        ? input.imagePath.trim()
        : undefined;
    const payload = {
      chatId: input.chatId,
      text: input.text,
      idempotencyKey: input.idempotencyKey,
      mode: input.mode ?? 'send',
      reason: input.reason,
      expectedOwnId,
      ...(imagePath ? { imagePath } : {}),
    };

    if (activeMode === 'cordis') {
      const bridge = this.resolveCordisBridge();
      if (!bridge) {
        return { status: 'failed', detail: 'Cordis wxarcBridge service unavailable' };
      }
      return bridge.send(payload, signal);
    }

    if (activeMode === 'http') {
      try {
        this.resolveValidatedHttpBase();
      } catch (err) {
        return {
          status: 'failed',
          detail: err instanceof Error ? err.message : String(err),
        };
      }

      try {
        const data = await this.httpJsonRequest('POST', '/wxarc/bridge/send', payload, signal);
        const status = data.status as WechatSendResult['status'] | undefined;
        return {
          status: status ?? 'uncertain',
          deliveryId: typeof data.deliveryId === 'string' ? data.deliveryId : undefined,
          detail: typeof data.detail === 'string' ? data.detail : undefined,
        };
      } catch (err) {
        if (err instanceof WxarcBridgeHttpError && err.statusCode >= 400 && err.statusCode < 500) {
          return {
            status: 'failed',
            detail: `HTTP ${err.statusCode}: ${err.message}`,
          };
        }
        return {
          status: 'uncertain',
          detail: `HTTP send outcome uncertain (${err instanceof Error ? err.message : String(err)}); never automatically replayed`,
        };
      }
    }

    return {
      status: 'failed',
      detail: 'WeChat transport unavailable',
    };
  }

  async triggerMemoNudge(
    input: WechatMemoNudgeInput,
    signal?: AbortSignal,
  ): Promise<WechatMemoNudgeResult> {
    const activeMode = this.getActiveMode();
    const payload: WechatMemoNudgeInput = {
      memoId: input.memoId,
      chatId: input.chatId,
      targetSessionId: input.targetSessionId ?? null,
      title: input.title,
      basis: input.basis,
      windowStart: input.windowStart ?? null,
      windowEnd: input.windowEnd ?? null,
    };

    if (activeMode === 'cordis') {
      const bridge = this.resolveCordisBridge();
      if (!bridge?.triggerMemoNudge) {
        return { status: 'failed', detail: 'Cordis wxarcBridge triggerMemoNudge unavailable' };
      }
      return bridge.triggerMemoNudge(payload, signal);
    }

    if (activeMode === 'http') {
      try {
        this.resolveValidatedHttpBase();
      } catch (err) {
        return {
          status: 'failed',
          detail: err instanceof Error ? err.message : String(err),
        };
      }

      try {
        const data = await this.httpJsonRequest(
          'POST',
          '/wxarc/bridge/memo-nudge',
          { ...payload },
          signal,
        );
        const status = data.status as WechatMemoNudgeResult['status'] | undefined;
        return {
          status: status === 'queued' || status === 'skipped' ? status : 'failed',
          jobId: typeof data.jobId === 'number' ? data.jobId : undefined,
          sessionId: typeof data.sessionId === 'string' ? data.sessionId : undefined,
          detail: typeof data.detail === 'string' ? data.detail : undefined,
        };
      } catch (err) {
        return {
          status: 'failed',
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    }

    return {
      status: 'failed',
      detail: 'WeChat transport unavailable',
    };
  }

  private async fetchRecentBundle(
    params: { chatId: string; limit?: number; sinceTs?: number },
    signal?: AbortSignal,
  ): Promise<{ healthy: boolean; paused: boolean; messages: WechatMessage[] }> {
    const activeMode = this.getActiveMode();
    const limit = Math.max(1, Math.min(200, Math.floor(params.limit ?? DEFAULT_RECENT_LIMIT)));

    if (activeMode === 'cordis') {
      const bridge = this.resolveCordisBridge();
      if (!bridge) {
        return { healthy: false, paused: false, messages: [] };
      }
      const raw = await bridge.recentMessages(
        { chatId: params.chatId, limit, sinceTs: params.sinceTs },
        signal,
      );
      if (Array.isArray(raw)) {
        const st = await bridge.status(signal);
        return {
          healthy: Boolean(st.healthy),
          paused: false,
          messages: raw.map((m) => normalizeMessage(m, params.chatId)),
        };
      }
      return {
        healthy: raw.healthy !== false,
        paused: Boolean(raw.paused),
        messages: Array.isArray(raw.messages)
          ? raw.messages.map((m) => normalizeMessage(m, params.chatId))
          : [],
      };
    }

    if (activeMode === 'http') {
      const qs = new URLSearchParams();
      qs.set('chatId', params.chatId);
      qs.set('limit', String(limit));
      if (params.sinceTs !== undefined && Number.isFinite(params.sinceTs)) {
        qs.set('sinceTs', String(params.sinceTs));
      }
      const data = await this.httpJsonRequest(
        'GET',
        `/wxarc/bridge/recent?${qs.toString()}`,
        undefined,
        signal,
      );
      const rawMessages = Array.isArray(data.messages) ? data.messages : [];
      return {
        healthy: Boolean(data.healthy),
        paused: Boolean(data.paused),
        messages: rawMessages.map((m) => normalizeMessage(m, params.chatId)),
      };
    }

    return { healthy: false, paused: false, messages: [] };
  }

  async recentMessages(
    params: { chatId: string; limit?: number; sinceTs?: number },
    signal?: AbortSignal,
  ): Promise<WechatMessage[]> {
    const bundle = await this.fetchRecentBundle(params, signal);
    return bundle.messages;
  }

  async getAtmosphere(
    paramsOrChatId: GetAtmosphereParams | string,
    optionsOrSignal?: GetAtmosphereOptions | AbortSignal,
    maybeSignal?: AbortSignal,
  ): Promise<RichWechatAtmosphere> {
    const params: GetAtmosphereParams =
      typeof paramsOrChatId === 'string'
        ? {
            chatId: paramsOrChatId,
            ...(isAbortSignal(optionsOrSignal) ? {} : optionsOrSignal ?? {}),
          }
        : paramsOrChatId;

    const signal = isAbortSignal(optionsOrSignal) ? optionsOrSignal : maybeSignal;
    const limit = params.limit ?? DEFAULT_RECENT_LIMIT;

    try {
      const bundle = await this.fetchRecentBundle({ chatId: params.chatId, limit }, signal);
      return computeAtmosphere({
        chatId: params.chatId,
        healthy: bundle.healthy,
        paused: bundle.paused,
        messages: bundle.messages,
        sinceMinutes: params.sinceMinutes,
        quietThresholdSeconds:
          params.quietThresholdSeconds ??
          (params.sinceMinutes !== undefined
            ? Math.floor(params.sinceMinutes * 60)
            : this.defaultQuietSeconds),
        nowMs: this.now(),
      });
    } catch {
      return computeAtmosphere({
        chatId: params.chatId,
        healthy: false,
        paused: false,
        messages: [],
        sinceMinutes: params.sinceMinutes,
        quietThresholdSeconds: params.quietThresholdSeconds ?? this.defaultQuietSeconds,
        nowMs: this.now(),
      });
    }
  }
}

export function createWechatTransport(
  options: CreateWechatTransportOptions = {},
): DualModeWechatTransport {
  return new DualModeWechatTransport(options);
}
