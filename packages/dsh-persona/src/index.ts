import type { LegacyMigrationResult, PersonaDb } from './contracts.js';
import { openPersonaDb, type PersonaDbOptions } from './db.js';
import { mountPersonaHttpRoutes, type PersonaHttpContext } from './http-routes.js';
import {
  createPersonaWardrobe,
  type PersonaWardrobeImpl,
  type PersonaWardrobeLlm,
  type PersonaWardrobeOptions,
} from './wardrobe.js';

export const name = 'persona';

export const inject = [] as const;

export interface PersonaPluginConfig extends PersonaDbOptions {
  autoMigrate?: boolean;
  llm?: PersonaWardrobeLlm;
  wardrobeOptions?: PersonaWardrobeOptions;
}

export interface CordisPersonaContext extends PersonaHttpContext {
  provide?: (key: string, value: unknown) => void;
  set?: (key: string, value: unknown) => void;
  inject?: (deps: readonly string[], callback: (subCtx: CordisPersonaContext) => void) => unknown;
  effect?: (callback: () => (() => void) | void) => unknown;
}

export interface PersonaRuntime {
  db: PersonaDb;
  wardrobe: PersonaWardrobeImpl;
  migration: LegacyMigrationResult;
  dispose: () => void;
}

export function apply(ctx: CordisPersonaContext, config: PersonaPluginConfig = {}): PersonaRuntime {
  const db = openPersonaDb({
    stateDir: config.stateDir,
    inMemory: config.inMemory,
  });
  const wardrobe = createPersonaWardrobe(db, config.llm, config.wardrobeOptions);
  const migration: LegacyMigrationResult =
    config.autoMigrate === false
      ? { migrated: false, personasImported: 0, memoriesImported: 0, sourcePath: null }
      : wardrobe.autoMigrateIfEmpty();

  let unmountHttp: () => void = () => {};
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      const disposeRoute = mountPersonaHttpRoutes(webCtx, wardrobe);
      webCtx.effect?.(() => disposeRoute);
    });
  } else {
    unmountHttp = mountPersonaHttpRoutes(ctx, wardrobe);
  }

  if (typeof ctx.provide === 'function') {
    ctx.provide('personaWardrobe', wardrobe);
  } else {
    ctx.set?.('personaWardrobe', wardrobe);
  }

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    unmountHttp();
    db.close();
  };

  ctx.effect?.(() => dispose);

  return { db, wardrobe, migration, dispose };
}

export * from './contracts.js';
export {
  DEFAULT_LEGACY_WATCHER_DB,
  DEFAULT_LEGACY_WXARC_DB,
  DEFAULT_LEGACY_WXARC_DIR,
  DEFAULT_PERSONA_STATE_DIR,
  PersonaDbImpl,
  expandHome,
  openPersonaDb,
  type PersonaDbOptions,
} from './db.js';
export * from './wardrobe.js';
export * from './http-routes.js';
