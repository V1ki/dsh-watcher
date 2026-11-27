import type { PersonaWardrobe } from './contracts.js';
import { openHubDb, type HubDbOptions } from './db.js';
import { createDoorGuard } from './guard.js';
import { mountHttpRoutes, type HubHttpContext } from './http-routes.js';
import { createPosteriorLayer, type PosteriorContext } from './posterior.js';
import { createHubService, type HubContextLike, type HubRuntime } from './service.js';
import { createSessionBridge, type SessionBridgeContext } from './session-bridge.js';
import { createPersonaVaultProvider, mountVaultTools } from './vault.js';

export const name = 'hub';

export const inject = [] as const;

export interface HubPluginConfig extends HubDbOptions {
  defaultTtlHours?: number;
  maxAutoSessionsPerHour?: number;
  tickIntervalMs?: number;
}

export type WatcherPluginConfig = HubPluginConfig;

export interface CordisPluginContext
  extends HubContextLike,
    HubHttpContext,
    PosteriorContext,
    SessionBridgeContext {
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

  let disposeVaultTools: () => void = () => {};
  let disposePersonaVault: () => void = () => {};
  let unmountHttp: () => void = () => {};
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      const disposeRoute = mountHttpRoutes(webCtx, service);
      webCtx.effect?.(() => disposeRoute);
    });
    ctx.inject(['tools'], (toolsCtx) => {
      const disposeTools = mountVaultTools(toolsCtx, service.vault);
      toolsCtx.effect?.(() => disposeTools);
    });
    ctx.inject(['personaWardrobe'], (personaCtx) => {
      const wardrobe =
        typeof personaCtx.get === 'function'
          ? (personaCtx.get('personaWardrobe') as PersonaWardrobe | undefined)
          : personaCtx.personaWardrobe;
      if (wardrobe?.searchVaultKnowledge) {
        const disposeProvider = service.vault.registerProvider(
          createPersonaVaultProvider(() => service.getWardrobe()),
        );
        personaCtx.effect?.(() => disposeProvider);
      }
    });
  } else {
    unmountHttp = mountHttpRoutes(ctx, service);
    disposeVaultTools = mountVaultTools(ctx, service.vault);
    if (service.getWardrobe()?.searchVaultKnowledge) {
      disposePersonaVault = service.vault.registerProvider(
        createPersonaVaultProvider(() => service.getWardrobe()),
      );
    }
  }

  const tickMs = config.tickIntervalMs ?? 60_000;
  const timer = tickMs > 0 ? setInterval(() => void service.tick().catch(() => {}), tickMs) : null;
  timer?.unref?.();

  if (typeof ctx.provide === 'function') {
    ctx.provide('hub', service);
    ctx.provide('watcher', service);
    ctx.provide('vault', service.vault);
  } else {
    ctx.set?.('hub', service);
    ctx.set?.('watcher', service);
    ctx.set?.('vault', service.vault);
  }

  ctx.effect?.(() => () => {
    if (timer) clearInterval(timer);
    disposePersonaVault();
    disposeVaultTools();
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
export {
  DoorGuard,
  PUBLIC_TAINT_WARNING_TEXT,
  createDoorGuard,
  type DoorGuardOptions,
} from './guard.js';
export * from './vault.js';
export * from './session-bridge.js';
export * from './posterior.js';
export * from './http-routes.js';
export * from './service.js';
