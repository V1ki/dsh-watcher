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
- Express intent through clear names, strict TypeScript types, and small focused functions. Put human-facing explanations in `docs/` and developer/agent contracts in `packages/*/AGENTS.md`.
- Verify mechanically before finishing any change:
  ```bash
  pnpm run check:comments
  ```

## 3. Plain-Language Canonical Docs (`docs/`) & Contract Layering

`docs/` at the repository root is the **only** human-facing documentation directory. Do not create competing human doc folders elsewhere.

### Layering: Human Docs vs. Agent/Developer Contracts
- **`docs/*.md` (for humans — plain Chinese)**: Explain only **what it does, how it works in daily scenarios (with concrete examples), and what the rules/safety boundaries are**. Never dump code-level internals here.
- **`packages/*/AGENTS.md` (for developers & AI agents — technical contracts)**: Own all package internals: exported TypeScript contracts, tool names & parameters, SQLite table/column names, HTTP routes, legacy migration fallbacks, and numeric tuning thresholds (e.g. ms/px/retry constants).

### Plain-Language Writing Red Lines (`docs/*.md`)
1. **True one-liner header**: Each doc opens with a `>` summary of **≤ 60 chars and 0 inline code backticks** (mechanical gate: ≤ 80 chars, 0 backticks).
2. **Scenarios first, zero internal code symbols**: Explain behavior using everyday scenes first. Prose and list items MUST NOT contain function signatures (`foo(...)`), regexes, operators (`===`, `!==`, `=>`), internal flags/table names, or `.ts` file paths. User-typed commands or config keys (e.g. `#编号`, `autoSendOwners`) belong in clean summary tables.
3. **Strict density limits (applies equally to paragraphs AND list items)**: Target **≤ 180 chars** and **≤ 2 inline code spans** per paragraph/list item (mechanical gate: ≤ 240 chars, ≤ 3 inline code spans). No nested parentheses; keep any parenthetical note ≤ 20 chars.
4. **Present behavior only (no changelog tombstones)**: Describe how the system works *today*. Do not write "removed legacy X", "no longer uses Y", or migration history in user-facing prose (put migration notes in `packages/*/AGENTS.md` or the deployment doc).
5. **Single Home per Concept**: Explain each feature/rule thoroughly in **one** primary doc; other docs may mention it in at most one plain sentence + a relative link.
6. **Lightweight Mermaid**: Keep diagrams to **≤ 10 nodes**, node labels **≤ 18 chars**, with no code paths or method signatures.
7. **Rewrite-on-Touch**: When code changes affect user-facing behavior, **rewrite the affected subsection cleanly as a whole**—never append bracketed patches onto old sentences.

### Dynamic Doc Growth & Splitting Rules
- **Naming**: `docs/NN-大白话短标题.md` (two-digit prefix `01`, `02`, ...; clear Chinese title, no temporary qualifiers like 「以后再加」).
- **Length budget**: Aim for **80–220 lines** per doc. **Split or add a new doc** whenever a single doc exceeds **220 lines** (hard gate: 260 lines) or accumulates two distinct topics. Merge fragments under 60 lines into an adjacent doc.
- **Index sync**: Every add/split/rename MUST update `docs/README.md`, keeping each index summary **≤ 40 chars of plain Chinese**, and mapping each package to **1 primary doc** (update `01` only when top-level architecture boundaries change).

### Anti-Rot Verification
Run mechanically before finishing any doc or behavior change:
```bash
pnpm run check:docs
```
Manual self-check before committing: (1) Can a non-coder understand every paragraph in one read? (2) Did any function/table/field name leak into prose or list items? (3) Is each rule explained in only one doc?

## 4. Build, Verification & Package Boundaries

- Package manager: `pnpm` (`pnpm-workspace.yaml` with `packages/*`).
- Runtime package layout (**6 runtime plugins + 1 meta-bundle**; see each package's `AGENTS.md` for technical contracts):
  - `packages/dsh-persona` (`@local/dsh-persona`, Cordis ID `persona`, sidebar **「性格衣柜」**): Standalone persona asset store, owner style extraction, chat preference learning, and owner-private knowledge retrieval (`packages/dsh-persona/AGENTS.md`).
  - `packages/dsh-hub` (`@local/dsh-hub`, Cordis ID `hub`, sidebar **「Hub 总控台」**): 100% deterministic event bus (0 LLM calls), unified inbox, fast-path thread routing, Vault knowledge bus, session principals, and draft-box `DoorGuard` (`packages/dsh-hub/AGENTS.md`).
  - `packages/dsh-router` (`@local/dsh-router`, Cordis ID `router`, sidebar **「Router」**): Layer-3 super-agent brain handling unclaimed-event triage, attention/schedule routing, owner WeChat collaboration, Worker orchestration, and high-risk tool approvals (`packages/dsh-router/AGENTS.md`).
  - `packages/dsh-connector-github` (`@local/dsh-connector-github`, Cordis ID `connector-github`, sidebar **「GitHub」**): Bidirectional GitHub connector for repo/Issue/PR polling, hybrid thread topology, merge pre-checks, and outbound comments/reviews (`packages/dsh-connector-github/AGENTS.md`).
  - `packages/dsh-connector-wxarc` (`@local/dsh-connector-wxarc`, Cordis ID `connector-wxarc`, sidebar **「微信消息」**, `darwin`-only): Bidirectional macOS WeChat connector for local polling, multimodal preprocessing, DSH reply orchestration, and serialized GUI sending (`packages/dsh-connector-wxarc/AGENTS.md`).
  - `packages/dsh-trigger-memo` (`@local/dsh-trigger-memo`, Cordis ID `trigger-memo`): 3-mode proactive memo engine (`time_nudge`, `news_followup`, `long_watch`) scheduling timely follow-ups through Hub (`packages/dsh-trigger-memo/AGENTS.md`).
  - `packages/dsh-hub-bundle` (`@local/dsh-hub-bundle`, meta-bundle): Installs the 6 runtime plugins in dependency order via `cordis.patch.yml` and hosts cross-package E2E integration tests (`packages/dsh-hub-bundle/AGENTS.md`).
- Zero external runtime npm dependencies in plugin packages (Node 24 built-ins only; `@deepseek-ai/cordis`, `@deepseek-ai/schemastery`, and `@deepseek-ai/dsh-scope` remain in `peerDependencies`, never `dependencies`).
- Standard verification commands from repo root:
  ```bash
  pnpm run check:comments
  pnpm run check:docs
  pnpm run build
  pnpm test
  ```
- Each package under `packages/*/` has its own `AGENTS.md` detailing package ownership, public exports, and package-scoped commands. Follow both this root `AGENTS.md` and the package's `AGENTS.md`.
