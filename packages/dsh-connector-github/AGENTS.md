# `@local/dsh-connector-github` (`packages/dsh-connector-github/AGENTS.md`)

Follow the repository-root [`AGENTS.md`](../../AGENTS.md) plus these package rules:

## Ownership & Scope

- Independent GitHub connector plugin (`id: connector-github`) providing `/notifications` + ETag repo polling (`+1` reaction deltas), bounded raw event ring buffer, Issue/PR hybrid topology resolver (`src/graph-resolver.ts`), `git merge-tree` pre-check, persona card binding (`defaultPersonaId` + per-repo `personaId`), outbound sink (`src/sink.ts`), local-owner HTTP routes (`/connector/github/*`), and a dedicated sidebar web panel (`src/client.ts`).
- Lossless credential compatibility: reads `connector-github/<profile>` first and falls back to legacy `watcher-github/<profile>` and `gh-watch/<profile>` records in `$DSH_HOME/.credentials.yaml`.
- Outbound defaults: `autoSendOwners: []` by default (all repos stage drafts in Hub until `autoSendOwners` or per-repo `autoSend: true` is configured; auto-send appends hidden `<!-- dsh-watch-self:... -->` marker and downgrades self-PR `APPROVE` to `COMMENT` under user tokens).

## Strict Standards

1. **100% TypeScript (`.ts`)**: No `.js` source or test files. `tsconfig.json` extends `../../tsconfig.base.json` (`strict: true`, `verbatimModuleSyntax: true`, `module: "nodenext"`, `.js` extensions on relative imports, 2-space indent). `src/client.ts` compiles via `tsconfig.client.json` as a classic IIFE with zero `import`/`export`.
2. **Zero comments in code**: Strictly no `//`, `/* ... */`, or `/** ... */` in any `.ts` file under `src/` or `test/`.
3. **Dependency hygiene**: Zero third-party runtime npm dependencies. `@local/dsh-hub`, `@deepseek-ai/cordis`, `@deepseek-ai/schemastery`, and `@deepseek-ai/dsh-scope` stay in `peerDependencies` (`@local/dsh-hub` is linked via `devDependencies` for compilation/tests).

## Commands

```bash
pnpm --filter @local/dsh-connector-github run build
pnpm --filter @local/dsh-connector-github run test
pnpm run check:comments
```
