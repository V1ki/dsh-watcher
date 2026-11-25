# AGENTS.md — `@local/dsh-router`

Follow the root [AGENTS.md](../../AGENTS.md) rules without exception:

1. **Strict TypeScript only**: All source and test files are `.ts`.
2. **Zero comments**: No `//`, `/* */`, or `/** */` comments in any `.ts` file (`pnpm run check:comments`).
3. **Single canonical docs**: Update `../../docs/` whenever Router triage, attention policy, worker dispatch, or HTTP/UI behavior changes.
4. **Hard boundaries over model judgment**: Programmatic rules and Hub's outbound locks always override LLM triage decisions; never silently drop events on model errors (fail-open to notify).
5. **Browser client bundle**: Keep `src/client.ts` compiled via `tsconfig.client.json` as a classic IIFE script with zero `export`/`import` statements, registered as `@local/dsh-router`.
