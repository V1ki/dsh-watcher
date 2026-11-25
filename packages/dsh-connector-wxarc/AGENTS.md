# `@local/dsh-connector-wxarc` (`packages/dsh-connector-wxarc/AGENTS.md`)

Follow the repository-root [`AGENTS.md`](../../AGENTS.md) plus these package rules:

## Ownership & Scope

- Private macOS-only (`darwin`) Cordis WeChat connector plugin (`id: connector-wxarc`) merging the full wxarc listener, DSH AI automation, SwiftCUA WeChat reply, `/wxarc/*` Web UI & `/wxarc/bridge/*` Bearer routes with the Hub `DualModeWechatTransport`, `wxarc.send` sink, `wxarc_proactive_send` tool, connector descriptor registration, and GitHub-to-WeChat routing rule.
- Keep the default `stateDir: ~/.dsh/wxarc-listener` compatible with existing local SQLite databases and cursors.

## Strict Standards

1. **100% TypeScript (`.ts`)**: No `.js` source or test files. Node runtime compiles via `tsconfig.json` (`strict: true`, `noImplicitAny: true`, `verbatimModuleSyntax: true`, `module: "nodenext"`, `.js` extensions on relative imports, 2-space indent).
2. **Classic IIFE client entry**: `src/client.ts` compiles via `tsconfig.client.json` (`module: "none"`, `moduleResolution: "classic"`, `moduleDetection: "legacy"`, `verbatimModuleSyntax: false`) with zero `import`/`export` statements so DSH's browser loader registers `@local/dsh-connector-wxarc` cleanly.
3. **Helper assets**: Keep all 6 helper assets under `src/` (`article-parser.py`, `clipboard.jxa`, `contacts.py`, `desktop-layout.jxa`, `image-pixels.py`, `mention-source.py`) intact and copied into `lib/` on build and `lib-test/src/` on test via `scripts/copy-assets.ts`.
4. **Zero comments in code**: Strictly no `//`, `/* ... */`, or `/** ... */` in any `.ts` file under `src/`, `test/`, or `scripts/`.
5. **Single canonical docs (`../../docs/`)**: Any change to wxarc runtime behavior, bridge modes, HTTP endpoints, send verification, or atmosphere checks MUST update `../../docs/` in the same change.
6. **Platform & dependency hygiene**: Keep `"private": true`, `dsh.bundle.platforms: ["darwin"]`, and zero external runtime `dependencies`.

## Commands

```bash
pnpm --filter @local/dsh-connector-wxarc run build
pnpm --filter @local/dsh-connector-wxarc run test
pnpm run check:comments
```
