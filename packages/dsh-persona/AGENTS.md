# `@local/dsh-persona` (`packages/dsh-persona/AGENTS.md`)

Follow the repository-root [`AGENTS.md`](../../AGENTS.md) plus these package rules:

## Ownership & Scope

- Standalone Cordis service (`id: persona`, provides `personaWardrobe`), dedicated SQLite store (`src/db.ts`, default `~/.dsh/storages/persona/state.sqlite`), lossless first-boot migration from legacy watcher/wxarc SQLite databases, persona wardrobe engine (`src/wardrobe.ts`), local-owner-only HTTP routes under `/local-persona` (`src/http-routes.ts`), and dedicated 「性格衣柜」 Web UI panel (`src/client.ts`).
- Shared TypeScript interfaces live in `src/contracts.ts`.

## Strict Standards

1. **100% TypeScript (`.ts`)**: No `.js` source or test files. `tsconfig.json` extends `../../tsconfig.base.json` (`strict: true`, `verbatimModuleSyntax: true`, `module: "nodenext"`, `.js` extensions on relative imports, 2-space indent).
2. **Zero comments in code**: Strictly no `//`, `/* ... */`, or `/** ... */` in any `.ts` file under `src/` or `test/`.
3. **Single canonical docs (`../../docs/`)**: Any change to persona schema, auto-migration, `/local-persona` routes, `PersonaWardrobe` contracts, or the 「性格衣柜」 UI MUST update the relevant docs in `../../docs/` in the same change.
4. **Classic IIFE Web Client**: `src/client.ts` compiles via `tsconfig.client.json` (`module: "none"`, `moduleDetection: "legacy"`) into a classic IIFE script `lib/client.js` with zero `export`/`import` statements for DSH's `plugins/??` classic `<script>` combiner. Keep runtime dependencies at zero (Node 24 built-ins only; Cordis/Schemastery stay in `peerDependencies`).

## Commands

```bash
pnpm --filter @local/dsh-persona run build
pnpm --filter @local/dsh-persona run test
node ../../scripts/check-no-comments.ts .
```
