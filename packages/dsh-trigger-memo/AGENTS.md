# `@local/dsh-trigger-memo` (`packages/dsh-trigger-memo/AGENTS.md`)

Follow the repository-root [`AGENTS.md`](../../AGENTS.md) plus these package rules:

## Ownership & Scope

- Cordis plugin (`id: trigger-memo`) implementing the 3 proactive memo trigger engines (`time_nudge`, `news_followup`, `long_watch`), web scout (`src/web-scout.ts`), scheduler (`src/scheduler.ts`), and room tools (`src/tools.ts`: `memo_add`, `memo_list`, `memo_cancel`), registering its trigger descriptor on `@local/dsh-hub`.

## Strict Standards

1. **100% TypeScript (`.ts`)**: No `.js` source or test files. `tsconfig.json` extends `../../tsconfig.base.json` (`strict: true`, `verbatimModuleSyntax: true`, `module: "nodenext"`, `.js` extensions on relative imports, 2-space indent).
2. **Zero comments in code**: Strictly no `//`, `/* ... */`, or `/** ... */` in any `.ts` file under `src/` or `test/`.
3. **Single canonical docs (`../../docs/`)**: Any change to memo modes, scheduling windows, atmosphere checks, or room tools MUST update `../../docs/01-整体框架图.md`, `../../docs/02-消息流转全过程.md`, and/or `../../docs/03-怎么拆分与落地步骤.md` in the same change.
4. **Dependency hygiene**: Zero external runtime npm dependencies. `@local/dsh-hub`, `@deepseek-ai/cordis`, `@deepseek-ai/schemastery`, and `@deepseek-ai/dsh-scope` stay in `peerDependencies`.

## Commands

```bash
pnpm --filter @local/dsh-trigger-memo run build
pnpm --filter @local/dsh-trigger-memo run test
pnpm run check:comments
```
