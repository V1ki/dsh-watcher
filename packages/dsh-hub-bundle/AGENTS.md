# AGENTS.md — `@local/dsh-hub-bundle`

Follow the root [AGENTS.md](../../AGENTS.md) rules without exception:

1. **Strict TypeScript only**: All source and test files are `.ts`.
2. **Zero comments**: No `//`, `/* */`, or `/** */` comments in any `.ts` file (`pnpm run check:comments`).
3. **Single canonical docs**: Update `../../docs/` whenever bundle manifests or E2E flows change.
4. **Bundle order**: Keep `persona` -> `hub` -> `connector-github` / `trigger-memo` / `connector-wxarc` so shared services initialize cleanly.
