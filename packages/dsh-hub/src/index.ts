import { openHubDb, type HubDbOptions } from './db.js';
import { createDoorGuard } from './guard.js';
import { mountHttpRoutes, type HubHttpContext } from './http-routes.js';
import { createPosteriorLayer, type PosteriorContext } from './posterior.js';
import { createHubService, type HubContextLike, type HubRuntime } from './service.js';
import { createSessionBridge, type SessionBridgeContext } from './session-bridge.js';

export const name = 'hub';

export const inject = [] as const;

export interface HubPluginConfig extends HubDbOptions {
  defaultTtlHours?: number;
  maxAutoSessionsPerHour?: number;
  tickIntervalMs?: number;
}

export type WatcherPluginConfig = HubPluginConfig;

export interface CordisPluginContext extends HubContextLike, HubHttpContext, PosteriorContext, SessionBridgeContext {
  provide?: (key: string, value: unknown) => void;
  set?: (key: string, value: unknown) => void;
  inject?: (deps: readonly string[], callback: (subCtx: CordisPluginContext) => void) => unknown;
}

export function apply(ctx: CordisPluginContext, config: HubPluginConfig = {}): HubRuntime {
  const db = openHubDb({
    stateDir: config.stateDir,
    homeDir: config.homeDir,
    inMemory: config.inMemory,
    acquireLease: config.acquireLease,
    leaseName: config.leaseName,
    holderId: config.holderId,
  });
  const guard = createDoorGuard();
  const sessionBridge = createSessionBridge(ctx, db, null);
  sessionBridge.mount();
  void sessionBridge.recoverOutstandingDeliveries().catch(() => {});

  const service = createHubService(ctx, {
    db,
    guard,
    sessionBridge,
    defaultTtlHours: config.defaultTtlHours,
    maxAutoSessionsPerHour: config.maxAutoSessionsPerHour,
  });

  const posterior = createPosteriorLayer(ctx, service);
  posterior.mount();

  let unmountHttp: () => void = () => {};
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      const disposeRoute = mountHttpRoutes(webCtx, service);
      webCtx.effect?.(() => disposeRoute);
    });
  } else {
    unmountHttp = mountHttpRoutes(ctx, service);
  }

  const tickMs = config.tickIntervalMs ?? 60_000;
  const timer = tickMs > 0 ? setInterval(() => void service.tick().catch(() => {}), tickMs) : null;
  timer?.unref?.();

  if (typeof ctx.provide === 'function') {
    ctx.provide('hub', service);
    ctx.provide('watcher', service);
  } else {
    ctx.set?.('hub', service);
    ctx.set?.('watcher', service);
  }

  ctx.effect?.(() => () => {
    if (timer) clearInterval(timer);
    unmountHttp();
    posterior.dispose();
    sessionBridge.dispose();
    db.close();
  });

  return service;
}

export * from './contracts.js';
export {
  HubDb,
  HubLeaseError,
  SCHEMA_PATH,
  WatcherDb,
  WatcherLeaseError,
  expandHome,
  openHubDb,
  openWatcherDb,
  resolveStateDir,
  type HubDbOptions,
  type WatcherDbOptions,
} from './db.js';
export { DoorGuard, createDoorGuard } from './guard.js';
export * from './session-bridge.js';
export * from './posterior.js';
export * from './http-routes.js';
export * from './service.js';
