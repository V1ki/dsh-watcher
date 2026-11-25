# `@local/dsh-hub` (`packages/dsh-hub/AGENTS.md`)

Follow the repository-root [`AGENTS.md`](../../AGENTS.md) plus these package rules:

## Ownership & Scope

- Pure deterministic core Cordis service (`id: hub`, provides both `ctx.hub` and legacy `ctx.watcher`), SQLite state (`src/db.ts`, `src/schema.sql`), fast-path `thread_subscriptions` router + `onUnclaimedEvent` hook, 2-hook passthrough `DoorGuard` (`src/guard.ts`), session bridge (`src/session-bridge.ts`), posterior pipeline (`src/posterior.ts`), dual-prefix HTTP routes (`/local-hub/*` and `/local-watcher/*`, `src/http-routes.ts`), service runtime (`src/service.ts`, `src/index.ts`), and 4-tab platform-agnostic Web UI (`src/client.ts`).
- Shared TypeScript interfaces live in `src/contracts.ts`.
- **Zero LLM calls**: Hub NEVER invokes an LLM directly. `PersonaWardrobe` lives in `@local/dsh-persona` and is resolved dynamically via `getWardrobe()`.
- **Lossless state migration**: When `stateDir` is omitted, `resolveStateDir()` uses `~/.dsh/storages/hub` unless `~/.dsh/storages/hub/state.sqlite` is absent and `~/.dsh/storages/watcher/state.sqlite` exists, in which case it automatically reuses `~/.dsh/storages/watcher`.

## Strict Standards

1. **100% TypeScript (`.ts` / `.tsx`)**: No `.js` source or test files. `tsconfig.json` extends `../../tsconfig.base.json` (`strict: true`, `verbatimModuleSyntax: true`, `module: "nodenext"`, `.js` extensions on relative imports, 2-space indent).
2. **Zero comments in code**: Strictly no `//`, `/* ... */`, or `/** ... */` in any `.ts`/`.tsx` file under `src/` or `test/`.
3. **Zero third-party runtime dependencies**: Node 24 built-ins only (`node:sqlite`, `node:crypto`, `node:fs`, `node:path`, `node:os`, `node:http`). Cordis/Schemastery stay in `peerDependencies`.
4. **Single canonical docs (`../../docs/`)**: Any change to schema, routing, subscriptions, session bridging, `DoorGuard`, or UI MUST update the relevant docs in `../../docs/` in the same change.
5. **Build artifact parity**: `src/schema.sql` must be copied into `lib/schema.sql` on build and `lib-test/src/schema.sql` on test. `src/client.ts` compiles via `tsconfig.client.json` (`module: "none"`, `moduleDetection: "legacy"`) into a classic IIFE script `lib/client.js` with zero `export`/`import` statements.

## Commands

```bash
pnpm --filter @local/dsh-hub run build
pnpm --filter @local/dsh-hub run test
node ../../scripts/check-no-comments.ts .
```
