# `@local/dsh-connector-github` (`packages/dsh-connector-github/AGENTS.md`)

Follow the repository-root [`AGENTS.md`](../../AGENTS.md) plus these package-level technical contracts.

## Documentation Split Rule

- **Implementation contracts stay here**: Any change to GitHub App auth, credential fallback, poller/snapshot logic, `linkedIssues`, `merge-tree`, `VaultProvider('github')`, sink guards, tools, or `/connector/github/*` routes MUST update this `AGENTS.md`.
- **Human-facing docs stay plain**: Only when user-visible behavior, panel workflow, or outbound policy changes, sync [`../../docs/07-消息怎么发出去.md`](../../docs/07-消息怎么发出去.md) (and [`../../docs/02-日常消息怎么走.md`](../../docs/02-日常消息怎么走.md) for flow changes) per root `AGENTS.md` §3.

## Ownership & Architecture

- Independent bidirectional GitHub connector (`id: connector-github`), sidebar panel **「GitHub」** (3 tabs: 事件箱 / 仓库与盯防 / 账号与高级设置), implements Hub standard trio: `WatchSource` + `ActionSink` (`github.draft`) + `VaultProvider('github')`.
- Runtime config persists in Hub `runtime_meta['github_config']` and hot-reloads poller, graph resolver, and sink without restart.
- Classic IIFE client: `src/client.ts` compiles via `tsconfig.client.json` (`module: "none"`, `moduleDetection: "legacy"`) with zero `import`/`export`. Zero external runtime npm dependencies.

## Auth & Credential Fallback (`src/auth.ts`)

- **Read Token & Native GitHub App RS256 JWT**:
  - Uses Node 24 `node:crypto` to sign RS256 JWTs and exchanges `GET /repos/{owner}/{repo}/installation` for 1-hour Installation Access Tokens (cached and refreshed 5 min prior to expiry), publishing as `<slug>[bot]`.
  - Reads `$DSH_HOME/.credentials.yaml` (`0600`, atomic write, PEM/Token never echoed by API/UI) in fallback order: `connector-github/*` (`github-app`, `github-read`, `github-act`) -> legacy `watcher-github/*` -> legacy `gh-watch/*` -> local `gh auth token`.

## Polling, Hybrid Topology & Lifecycle (`src/poller.ts`, `src/graph-resolver.ts`)

- **Polling**: default `60s` (`30s` for pinned items); `/notifications` + ETag repo polling + `+1` reaction deltas; snapshots persisted in Hub `source_cursors`; maintains bounded raw event stream (`GET /connector/github/events`).
- **Comments, Reviews & Bot-PR Coverage**:
  - Incrementally fetches `/issues/{number}/comments`, `/pulls/{number}/reviews` (skipping `PENDING` and empty-body `COMMENTED`), and inline `/pulls/{number}/comments` (with `[path:line]`).
  - Even when a PR/Issue was created by a `[bot]` or self account (suppressing head-item updates), the poller still maintains its snapshot and pulls human comments, PR reviews, and inline comments (full initial catch-up without `baselineMs` cutoff on open bot PRs; rolls back snapshot on transient API failure).
- **Terminal lifecycle events (`lifecycleOnly`)**: when `prev.state === 'open' && item.state === 'closed'` and normal head emission is skipped (`skipHeadEvent === true`), emits `github.pr.merged` / `github.pr.closed` / `github.issue.closed` with `payload.state = 'closed'`, `payload.merged`, and `payload.lifecycleOnly = true` so Hub `onThreadLifecycle` resolves Router state without waking Workers.
- **Hybrid Issue/PR topology & `git merge-tree`**:
  - `extractLinkedIssues` parses `Fixes`/`Closes`/`Resolves #N` (and same-repo `owner/repo#N`, ignoring HTML comments and cross-repo refs) into `payload.linkedIssues` on head/comment/review events so Hub inherits the linked Issue's active Worker; casual references attach cross-thread edges.
  - Runs `git merge-tree` conflict pre-check prior to PR review (conflicts short-circuit with `CONFLICT_OR_STALE`).

## `VaultProvider('github')` & Persona Binding (`src/vault-provider.ts`)

- Registers read-only `VaultProvider('github')` over `source_cursors` (`state:repo_issues:*`) and recent Hub GitHub events; supports thread context expansion by `github:<repo>#<number>` or `event:<id>`.
- Visibility resolves via `personaWardrobe` explicit label on `github:<owner/repo>` first; unlabeled public repos default to `'external'`, private/unknown repos default to `'work'`.
- Persona selection supports global `defaultPersonaId` + per-repo `personaId` (fetched via `/connector/github/personas` with 1-click jump to 「性格衣柜」).

## Outbound Sink, Guardrails & Tools (`src/sink.ts`)

- **Tools**: `gh_stage_reply` and `gh_stage_review` (Sink ID `github.draft`).
- **Principal & Taint enforcement**: both tools call `hub.resolveSessionPrincipal(exec)` — permitting only top-level `owner_session`/`interactive` (`delegationDepth === 0`) or top-level `worker` with `boundRepo === repo`, denying `external_chat`, subagents, cross-repo Workers, and missing context.
- **Draft-first defaults**: `autoSendOwners: []` by default (all repos stage to Hub `pending_approval` unless matched by `autoSendOwners` or per-repo `autoSend: true`). Any tainted session is forced to `stageOnly: true` by `DoorGuard`, attaching `PUBLIC_TAINT_WARNING_TEXT` on public repos (stripped when approved to send).
- **Anti-loop & self-PR review**: appends hidden `<!-- dsh-watch-self:<idempotencyKey> -->`, records `selfPublishedIds`, and skips `[bot]`/`botLogin`. Native GitHub App preserves `APPROVE`/`REQUEST_CHANGES` on owner PRs; user-token fallback downgrades self-PR reviews to `COMMENT`.

## `/connector/github/*` Routes & Commands

- Routes (`src/http-routes.ts`): `GET /connector/github`, `GET|POST /connector/github/config`, `POST /connector/github/token`, `POST|DELETE /connector/github/app`, `POST /connector/github/app/verify`, `POST /connector/github/poll`, `GET /connector/github/events`, `GET /connector/github/personas`.
- Standards: 100% strict TypeScript, zero comments, zero third-party runtime dependencies (`@local/dsh-hub`, Cordis, Schemastery, `dsh-scope` in `peerDependencies`).

```bash
pnpm --filter @local/dsh-connector-github run build
pnpm --filter @local/dsh-connector-github run test
pnpm run check:comments
```
