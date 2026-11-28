# `@local/dsh-router` (`packages/dsh-router/AGENTS.md`)

Follow the repository-root [`AGENTS.md`](../../AGENTS.md) plus these package-level technical contracts.

## Documentation Split Rule

- **Implementation contracts stay here**: Any change to router tables, triage guardrails, `OwnerSessionBridge`, `RouterApprovals`, `tools/pre-execute`, attention policy, worker dispatch, tools, or `/local-router/*` routes MUST update this `AGENTS.md`.
- **Human-facing docs stay plain**: Only when user-visible behavior, WeChat command UX, or safety boundaries change, sync [`../../docs/03-微信上怎么指挥它.md`](../../docs/03-微信上怎么指挥它.md) (and [`../../docs/06-安全护栏怎么兜底.md`](../../docs/06-安全护栏怎么兜底.md) for safety changes) per root `AGENTS.md` §3.

## Ownership & Storage (`src/db.ts`, `src/index.ts`)

- Layer-3 Super-agent brain (`id: router`, `inject: ['hub']`), sidebar **「Router」** (order `10`, 4 tabs: 待处理与分诊 / 提醒队列 / 注意力与作息 / 效果统计与快车道); `src/client.ts` compiles via `tsconfig.client.json` as classic IIFE `lib/client.js`.
- Dedicated SQLite database: `~/.dsh/storages/router/state.sqlite` (WAL, `STRICT` tables, `0600`).
- **5 tables**: `router_meta`, `router_decisions`, `router_notifications`, `router_approvals`, `router_task_uses` (first boot read-only migrates legacy `wxarc` `wechat_approvals`, marking orphaned `pending` rows `cancelled`).
- Subscribes ONLY to `hub.onUnclaimedEvent(...)`, `hub.onThreadLifecycle(...)`, `hub.registerAdminWechatHandler(...)`, and Worker `router_report_result`; already-subscribed threads bypass Router via Hub Fast Path.

## `OwnerSessionBridge` (`src/owner-session.ts`)

- Persists unique `router_meta['owner_session_id']` in isolated empty workspace `~/.dsh/workspaces/router-owner` with `workspace-write` preset; startup pre-warms `owner_session` (`tier: 3`) and all historical Worker principals.
- **One-time history seeding**: keyed by `router_meta['owner_session_history_seeded']`; on initial session creation/recovery silently injects up to **~25** recent chronological owner DM messages (filtering out `DSH 有一项操作需要你确认：` approval noise) and immediately clears `turnPrivateRead`.
- Uses `unwrapResolvedAgent` for DSH agent compatibility, `AbortSignal` combining lifecycle abort + **30s** prompt timeout (`OWNER_PROMPT_TIMEOUT_MS = 30_000`), and **1500ms** burst-merge debounce (`DEFAULT_OWNER_DEBOUNCE_MS = 1500`).
- Every pushed notification or batch summary silently calls `agent.inject()` with a 1-line receipt (`[已推送给主人] [#<shortId>] ...`); turn completion replies via idempotent `router-owner-reply:<turnId>` and clears `turnPrivateRead`.

## 4-Level Triage & Hard Guardrails (`src/triage.ts`)

- Levels: `ignore` | `inform` | `prepare` | `act`. LLM default `maxTokens: 2400`; on invalid JSON retries once with strict JSON-only instruction; persistent failure logs bounded (`≤ 200` chars) warning and enters **fail-open** (open non-bot `github.issue.updated`/`github.pr.updated` escalates to `prepare`; closed/merged stays `inform`).
- **Programmatic guardrails always override LLM**:
  - `actor.isBot === true` -> `ignore` (restorable via 1-click 「仍然通知」 `POST /local-router/decisions/:id/restore`).
  - Urgent events are NEVER ignored.
  - `untrusted` trust level is capped at `prepare`.

## `RouterApprovals` & `tools/pre-execute` Guardrails (`src/approvals.ts`, `src/task-permissions.ts`, `src/service.ts`)

- **8-hex-char confirmation code**, default **15-minute TTL** (`15 * 60_000`): supports `确认 <8位码>` (single use), `批准本轮任务 <8位码>` (scoped task reuse), and `拒绝 <8位码>`.
- **High-risk-only confirmation principle for `owner_session`**:
  - **`OWNER_SAFE_READ_TOOLS` (32 tools, pass without confirmation)**: `read`, `read_file`, `read_image`, `grep`, `glob`, `find`, `ls`, `list_dir`, `vault_search`, `vault_context`, `router_tasks`, `router_send_to_task`, `watch_list`, `watch_update`, `watch_cancel`, `watch_stage_draft`, `github_stage_reply`, `github_stage_review`, `wxarc_status`, `wxarc_messages`, `wxarc_targets`, `wxarc_nas_search`, `wxarc_sticker_search`, `watcher_memo_add`, `watcher_memo_list`, `watcher_memo_cancel`, `web_search`, `ask_user_question`, `job_output`, `todoread`, `todowrite`, `skill`.
  - **`isReadOnlyBash`**: allows `SAFE_COMMANDS` and read-only `git` subcommands (`status`, `log`, `diff`, `show`, `branch`, `rev-parse`, `ls-files`, `describe`, `tag`, rejecting write flags and `--ext-diff`/`--output`).
  - **4 mandatory confirmation triggers**: (1) destructive/install/privilege/system-changing `bash` (`needsOperationConfirmation` or `require_escalated`); (2) file write/edit outside `~/.dsh/workspaces/router-owner`; (3) `wxarc_proactive_send`; (4) `web_fetch` while `hub.isTurnPrivateRead(sessionId)` is true.
- **Tainted Worker exfiltration block**: `tools/pre-execute` hard-denies `web_fetch`, `web_search`, and `sandbox_permissions === 'require_escalated'` for any tainted Worker (and its subagents).

## Attention Policy, 0-LLM Dispatch & Lifecycle (`src/policy.ts`, `src/worker-dispatcher.ts`, `src/service.ts`)

- **Focus-lock-free schedule routing**: periods `work` / `off_hours` / `weekend`, presence `auto` (`WEB_ACTIVE_TTL_MS = 2min`) / `present` / `away`, urgent override, 「情境预演」 (`POST /local-router/preview`). Default/empty `wechatTarget` (`filehelper`) auto-aligns to wxarc `controllerId`.
- **60s idempotent deferred queue (`tickDeferred`)**: when `≥ 3` WeChat reminders are queued (`BATCH_SUMMARY_THRESHOLD = 3`), merges them into 1 lock-free summary card; failed delivery remains `deferred` with `wechat_delivery_failed` appended. Public tainted drafts prepend `PUBLIC_TAINT_WARNING_TEXT`.
- **0-LLM owner DM triage order**: (1) 8-char approval command -> `RouterApprovals`; (2) list command (`列表`/`还有啥`/`在忙啥`/`任务`/`list`); (3) `#编号` prefix (exact `shortId` first, then UUID prefix) or quoted `[#编号]` -> direct to target Worker with optional single-turn `setSessionTurnOverride(tier=3, 15min)` cleared on turn end; (4) 1500ms merged prompt -> `owner_session`.
- **Worker sandboxing & terminal cleanup**: Workers register `SessionPrincipal` by source tier (1 stranger / 2 work-private / 3 owner, parsing `github:owner/repo#N` into `boundRepo`), attach network-isolated sandboxes (`prepare -> read-only`, `act -> workspace-write`), and register `thread_subscriptions`. On `hub.onThreadLifecycle` (`closed`/`merged`/`ended`), automatically resolves open decisions, marks deferred notifications `read`, and clears `sessionTurnOverride`.

## Tools & `/local-router/*` Routes (`src/worker-dispatcher.ts`, `src/http-routes.ts`)

- **Tools (all require `delegationDepth === 0`)**:
  - `router_report_result`: bound top-level Worker report (`conclusion ≤ 200` chars, never appends `changes`, optional `imagePath` PNG/JPEG ≤ 8MB, `draftText`, `blindspot`, `mode`; unique suffix `report:<ts>:<rand>`).
  - `router_tasks`, `router_send_to_task`: top-level `owner_session`/`interactive` inspection and cross-task dispatch.
- **Routes**: `GET /local-router`, `GET /local-router/status`, `GET /local-router/decisions`, `POST /local-router/decisions/:id/(restore|dispatch|answer)`, `GET /local-router/notifications`, `POST /local-router/notifications/:id/read`, `GET|PUT /local-router/policy`, `POST /local-router/preview`, `GET /local-router/stats`, `GET|DELETE /local-router/subscriptions`, `POST /local-router/simulate-event`.

## Standards & Commands

- 100% strict TypeScript, strictly zero comments (`pnpm run check:comments`), zero external runtime npm dependencies.

```bash
pnpm --filter @local/dsh-router run build
pnpm --filter @local/dsh-router run test
node ../../scripts/check-no-comments.ts .
```
