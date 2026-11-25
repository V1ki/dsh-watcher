import type { HubService } from '@local/dsh-hub/contracts';
import {
  MemoStore,
  MemoRoomCapError,
  createMemoStore,
  normalizeUrlKey,
  type CreateMemoInput,
  type DbHandle,
  type ListMemosFilter,
  type MemoSeenUrlRecord,
  type MemoStoreOptions,
  type ProactiveBudgetMode,
  type ProactiveBudgetRecord,
} from './store.js';
import {
  WebScout,
  createWebScout,
  buildSearchQuery,
  extractDomain,
  getKnownFactsCutoffMs,
  isOfficialDomainMatch,
  type NormalizedSearchItem,
  type ScoutCandidate,
  type ScoutOutcome,
  type ScoutRejectedItem,
  type ScoutVerdict,
  type WebScoutOptions,
  type WebSearchClient,
  type WebSearchResponse,
  type WebSearchResultItem,
} from './web-scout.js';
import {
  MemoEngine,
  createMemoEngine,
  normalizeMemoConfig,
  pickRandomFireAt,
  type MemoCheckResult,
  type MemoEngineConfig,
  type MemoEngineOptions,
  type MemoLogger,
  type RawMemoEngineConfig,
} from './scheduler.js';
import {
  registerMemoTools,
  type MemoToolDefinition,
  type MemoToolsContext,
  type ToolExecutionContext,
  type ToolsRegistryLike,
} from './tools.js';

export const name = 'trigger-memo';

export const inject = ['hub'] as const;

export interface MemoPluginContext extends MemoToolsContext {
  hub?: HubService;
  watcher?: HubService;
  web?: WebSearchClient;
  logger?: ((scope: string) => MemoLogger) | MemoLogger;
  on?: (event: string, listener: () => void) => void;
}

function resolveWebClient(ctx: MemoPluginContext): WebSearchClient | undefined {
  const candidate =
    typeof ctx.get === 'function'
      ? (ctx.get('web') as WebSearchClient | undefined)
      : ctx.web;
  if (candidate && typeof candidate.search === 'function') {
    return candidate;
  }
  return undefined;
}

export function apply(ctx: MemoPluginContext, rawConfig: RawMemoEngineConfig = {}) {
  const hub = ctx.hub ?? ctx.watcher;
  if (!hub) {
    throw new TypeError('trigger-memo requires ctx.hub (or ctx.watcher) service');
  }
  const config = normalizeMemoConfig(rawConfig);
  const controller = new AbortController();
  const logger = (typeof ctx.logger === 'function' ? ctx.logger('trigger-memo') : ctx.logger) ?? console;
  const web = resolveWebClient(ctx);

  const store = createMemoStore(hub.db, {
    maxActivePerRoom: config.maxActivePerRoom,
    proactiveBudgetMode: config.proactiveBudgetMode,
    proactiveBudgetHours: config.proactiveBudgetHours,
    proactiveBudgetMaxPerRoom: config.proactiveBudgetMaxPerRoom,
  });

  const engine = createMemoEngine({
    hub,
    store,
    web,
    config,
    logger,
  });

  const runtimeHub = hub as HubService & {
    registerMemoEngine?: (memoEngine: MemoEngine) => () => void;
  };
  let toolDisposers: Array<() => void> = [];
  if (typeof ctx.inject === 'function') {
    ctx.inject(['tools'], (toolCtx) => {
      try {
        const mounted = registerMemoTools(toolCtx, engine);
        toolCtx.effect?.(() => () => {
          for (const dispose of mounted) {
            try {
              dispose();
            } catch {
              void 0;
            }
          }
        });
      } catch {
      }
    });
  } else {
    try {
      toolDisposers = registerMemoTools(ctx, engine);
    } catch {
      toolDisposers = [];
    }
  }
  const watchSource = engine.asWatchSource();
  const disposers = [
    hub.registerSource(watchSource),
    hub.registerConnector?.({
      id: 'memo',
      label: '待惦记便签',
      kind: 'trigger',
      panelId: 'dsh-hub-panel',
      panelLabel: 'Hub 总控台',
      health: () => {
        const status = watchSource.health?.();
        return {
          ok: status?.ok ?? true,
          detail: status?.lastError
            ? `error: ${status.lastError}`
            : status?.nextPollAt
              ? `nextPollAt: ${status.nextPollAt}`
              : 'ready',
        };
      },
    }),
    runtimeHub.registerMemoEngine?.(engine),
    ...toolDisposers,
  ].filter((dispose): dispose is () => void => typeof dispose === 'function');

  engine.start(controller.signal);

  ctx.on?.('dispose', () => {
    controller.abort();
    engine.stop();
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        void 0;
      }
    }
  });

  return { config, store, engine };
}

export {
  MemoStore,
  MemoRoomCapError,
  createMemoStore,
  normalizeUrlKey,
  WebScout,
  createWebScout,
  buildSearchQuery,
  extractDomain,
  getKnownFactsCutoffMs,
  isOfficialDomainMatch,
  MemoEngine,
  createMemoEngine,
  normalizeMemoConfig,
  pickRandomFireAt,
  registerMemoTools,
};

export type {
  CreateMemoInput,
  DbHandle,
  ListMemosFilter,
  MemoSeenUrlRecord,
  MemoStoreOptions,
  ProactiveBudgetMode,
  ProactiveBudgetRecord,
  NormalizedSearchItem,
  ScoutCandidate,
  ScoutOutcome,
  ScoutRejectedItem,
  ScoutVerdict,
  WebScoutOptions,
  WebSearchClient,
  WebSearchResponse,
  WebSearchResultItem,
  MemoCheckResult,
  MemoEngineConfig,
  MemoEngineOptions,
  MemoLogger,
  RawMemoEngineConfig,
  MemoToolDefinition,
  MemoToolsContext,
  ToolExecutionContext,
  ToolsRegistryLike,
};
