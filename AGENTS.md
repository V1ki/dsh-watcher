# dsh-watcher Engineering Rules (`AGENTS.md`)

All contributors and agents working anywhere in `dsh-watcher` MUST follow these 4 non-negotiable standards:

## 1. 100% TypeScript (`.ts`)

- All source (`src/`), test (`test/`), and tooling (`scripts/`) code MUST be written in TypeScript (`.ts` / `.tsx`). Do not add `.js` source or test files.
- Every package compiles with `tsconfig.json` extending `../../tsconfig.base.json` (`target: "es2024"`, `module: "nodenext"`, `moduleResolution: "nodenext"`, `strict: true`, `verbatimModuleSyntax: true`, `declaration: true`, `removeComments: true`).
- Use explicit `.js` extensions on all relative ESM imports in `.ts` files (for example `import { openHubDb } from './db.js';` and `import type { HubDb } from './contracts.js';`).
- Use `import type` for type-only imports (`verbatimModuleSyntax: true`).
- Format code cleanly and consistently with **2-space indentation**, single quotes, trailing commas in multiline literals, and semicolons.

## 2. Zero Comments in Code

- **Strictly zero comments** in ANY `.ts` or `.tsx` file (`src/`, `test/`, `scripts/`):
  - No single-line comments (`// ...`)
  - No block comments (`/* ... */`)
  - No JSDoc comments (`/** ... */`)
- Express intent through clear names, strict TypeScript types, and small focused functions. Put prose explanations in `docs/`.
- Verify mechanically before finishing any change:
  ```bash
  pnpm run check:comments
  ```

## 3. Single Canonical Documentation (`docs/`)

- `docs/` at the repository root is the **only** canonical documentation directory for this codebase.
- Do not create competing or duplicate doc folders elsewhere.
- **Every code change that adds, modifies, or removes architecture, message flows, config options, defaults, tools, sinks, guards, or user-facing behavior MUST update the relevant document(s) in `docs/` in the same change.**
- See [`docs/README.md`](./docs/README.md) for the index of all 5 canonical docs (`01` through `05`).

## 4. Build, Verification & Package Boundaries

- Package manager: `pnpm` (`pnpm-workspace.yaml` with `packages/*`).
- Runtime package layout (**6 runtime plugins + 1 meta-bundle**):
  - `packages/dsh-persona` (`@local/dsh-persona`, Cordis ID `persona`, sidebar **「性格衣柜」**): standalone `PersonaWardrobe` SQLite asset store (`~/.dsh/storages/persona/state.sqlite` with lossless first-boot auto-migration from legacy `watcher/state.sqlite` / `wxarc-listener/events.sqlite`), owner style extraction, quote-evidenced 24/16 chat preference learning, owner-private `foundation` CJK 2-gram retrieval, `/local-persona/*` routes, and `ctx.provide('personaWardrobe')`.
  - `packages/dsh-hub` (`@local/dsh-hub`, Cordis ID `hub`, sidebar **「Hub 总控台」**): 100% pure-deterministic event bus (**0 LLM calls**), connector overview, unified inbox, `thread_subscriptions` fast-path routing table, `onUnclaimedEvent` hook (consumed by `@local/dsh-router`), memos tab, draft-box hard guard (`DoorGuard`), dual `/local-hub/*` + `/local-watcher/*` routes, auto-reusing `~/.dsh/storages/watcher/state.sqlite`.
  - `packages/dsh-router` (`@local/dsh-router`, Cordis ID `router`, sidebar **「Router」**, order `10`): Layer-3 Super-agent brain (`~/.dsh/storages/router/state.sqlite`) subscribing ONLY to `hub.onUnclaimedEvent(...)` (cold-start unclaimed events + Worker conclusion reports via `router_report_result`; already-subscribed threads bypass Router via Hub's `thread_subscriptions` Fast Path); 4-level triage (`ignore`/`inform`/`prepare`/`act`) with programmatic hard guardrails overriding LLM (`actor.isBot -> ignore`, urgent never ignored, `untrusted` capped at `prepare`, fail-open on model error, 1-click 「仍然通知」 restore); Attention Policy & Schedule Router (`work`/`off_hours`/`weekend`, `auto`/`present`/`away`, urgent override, 「情境预演」 preview simulator, 60s idempotent deferred Web/WeChat tick); 7d/30d effectiveness stats, `/local-router/*` routes, and 4-tab classic-IIFE Web UI (待处理 & 分诊 / 网页提醒 / 注意力与作息 / 效果统计 & 快车道).
  - `packages/dsh-connector-github` (`@local/dsh-connector-github`, Cordis ID `connector-github`, sidebar **「GitHub」**): independent bidirectional GitHub connector with Read Token + native GitHub App RS256 JWT (`connector-github/*` with automatic fallback to `watcher-github/*`), default + per-repo persona card selector (with 1-click jump to 「性格衣柜」), repo/pinned watch & auto-send config, raw recent event stream (`/connector/github/events`), Issue/PR hybrid topology, `git merge-tree` pre-check, and outbound comments/reviews.
  - `packages/dsh-connector-wxarc` (`@local/dsh-connector-wxarc`, Cordis ID `connector-wxarc`, sidebar **「微信消息」**, `darwin`-only): bidirectional macOS WeChat connector with 3s polling, DSH AI reply, SwiftCUA serial send, 6 `.py`/`.jxa` helper assets copied on build/test, `stateDir: ~/.dsh/wxarc-listener`, streamlined persona selector with 1-click jump to 「性格衣柜」, Cordis/HTTP bridge & `8765` hard block.
  - `packages/dsh-trigger-memo` (`@local/dsh-trigger-memo`, Cordis ID `trigger-memo`): 3-mode proactive memo engine (`time_nudge`, `news_followup`, `long_watch` #223) registering into Hub.
  - `packages/dsh-hub-bundle` (`@local/dsh-hub-bundle`, meta-bundle): installs the 6 runtime plugins in order (`persona → hub → router → connector-github / trigger-memo / connector-wxarc`) via `cordis.patch.yml` and hosts cross-package E2E integration tests.
- Zero external runtime npm dependencies in plugin packages (Node 24 built-ins only; `@deepseek-ai/cordis`, `@deepseek-ai/schemastery`, and `@deepseek-ai/dsh-scope` remain in `peerDependencies`, never `dependencies`).
- Standard verification commands from repo root:
  ```bash
  pnpm run check:comments
  pnpm run build
  pnpm test
  ```
- Each package under `packages/*/` has its own `AGENTS.md` detailing package ownership, public exports, and package-scoped commands. Follow both this root `AGENTS.md` and the package's `AGENTS.md`.
