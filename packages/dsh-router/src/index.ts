import type { HubService } from '@local/dsh-hub/contracts';
import type { AttentionPolicy } from './contracts.js';
import { openRouterDb, type RouterDbOptions } from './db.js';
import { mountRouterHttpRoutes, type RouterHttpContext } from './http-routes.js';
import { createRouterRuntime, type RouterRuntime, type RouterServiceContext } from './service.js';
import type { TriageLlmLike } from './triage.js';

export const name = 'router';

export const inject = ['hub'] as const;

export interface RouterPluginConfig extends RouterDbOptions {
  tickIntervalMs?: number;
  initialPolicy?: Partial<AttentionPolicy>;
  llm?: TriageLlmLike | null;
  now?: () => Date;
}

export interface CordisRouterContext extends RouterServiceContext, RouterHttpContext {
  hub?: HubService;
  watcher?: HubService;
  provide?: (key: string, value: unknown) => void;
  set?: (key: string, value: unknown) => void;
  inject?: (deps: readonly string[], callback: (subCtx: CordisRouterContext) => void) => unknown;
  effect?: (callback: () => (() => void) | void) => unknown;
  on?: (event: string, listener: () => void) => unknown;
}

export function apply(ctx: CordisRouterContext, config: RouterPluginConfig = {}): RouterRuntime {
  const hub = (
    ctx.hub ??
    (typeof ctx.get === 'function' ? ctx.get('hub') ?? ctx.get('watcher') : ctx.watcher)
  ) as HubService | undefined;
  if (!hub) {
    throw new TypeError('router plugin requires hub service (ctx.hub)');
  }

  const db = openRouterDb({
    stateDir: config.stateDir,
    homeDir: config.homeDir,
    inMemory: config.inMemory,
  });

  const service = createRouterRuntime({
    hub,
    db,
    ctx,
    llm: config.llm,
    now: config.now,
    homeDir: config.homeDir,
    initialPolicy: config.initialPolicy,
  });

  let unmountHttp: () => void = () => {};
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      const disposeRoute = mountRouterHttpRoutes(webCtx, service);
      webCtx.effect?.(() => disposeRoute);
    });
  } else {
    unmountHttp = mountRouterHttpRoutes(ctx, service);
  }

  const tickMs = config.tickIntervalMs ?? 60_000;
  const timer = tickMs > 0 ? setInterval(() => void service.tickDeferred().catch(() => {}), tickMs) : null;
  timer?.unref?.();

  if (typeof ctx.provide === 'function') {
    ctx.provide('router', service);
  } else {
    ctx.set?.('router', service);
  }

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    if (timer) clearInterval(timer);
    unmountHttp();
    service.dispose();
    db.close();
  };

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => cleanup);
  } else if (typeof ctx.on === 'function') {
    ctx.on('dispose', cleanup);
  }

  return service;
}

export * from './contracts.js';
export {
  RouterDb,
  openRouterDb,
  resolveRouterStateDir,
  type ListDecisionsFilter,
  type ListNotificationsFilter,
  type RouterDbOptions,
} from './db.js';
export * from './policy.js';
export * from './triage.js';
export * from './worker-dispatcher.js';
export * from './service.js';
export * from './http-routes.js';
