# `@local/dsh-trigger-memo` (`packages/dsh-trigger-memo/AGENTS.md`)

Follow the repository-root [`AGENTS.md`](../../AGENTS.md) plus these package-level technical contracts.

## Documentation Split Rule

- **Implementation contracts stay here**: Any change to memo modes, scheduling budgets, `idempotencyKey` rules, `SessionPrincipal`/`TargetDirectory` authorization, `VaultProvider('memo')`, or room tools MUST update this `AGENTS.md`.
- **Human-facing docs stay plain**: Only when user-visible behavior, memo scheduling expectations, or safety boundaries change, sync [`../../docs/05-待惦记便签怎么主动开口.md`](../../docs/05-待惦记便签怎么主动开口.md) per root `AGENTS.md` §3.

## Ownership & 3 Proactive Modes (`src/scheduler.ts`, `src/web-scout.ts`, `src/store.ts`)

- Cordis plugin (`id: trigger-memo`) implementing proactive memo triggers on Hub (`WatchSource` + trigger descriptor + read-only `VaultProvider('memo')`). Zero external runtime npm dependencies (`@local/dsh-hub`, Cordis, Schemastery, `dsh-scope` stay in `peerDependencies`).
- **3 trigger modes**:
  - `time_nudge`: one-shot randomized pick within a time window; WeChat nudges route preferentially back to the originating WeChat session via `triggerMemoNudge` (native `@` + Hub inbox audit trail without spawning a duplicate Router Worker); expired windows are discarded without backfill.
  - `news_followup`: periodic (`6–12h`, up to `3d`) keyword search comparing against known baseline facts and deduplicating via `memo_seen_urls`; speaks once on genuinely new facts if chat atmosphere permits.
  - `long_watch`: low-frequency (`3–7d`, open-ended, e.g. Issue #223) official-source-whitelist watch (official announcements/docs/releases only); notifies the original thread and optional verified owner WeChat DM upon confirmation.
- **Proactive budget (`proactive_budget`)**: defaults to `proactiveBudgetMode: 'calendar_day'` (1/room/day; rolling mode defaults to `18h`). If budget is exhausted while the window is still open, defers to budget recovery time; otherwise expires cleanly.

## Authorization & Cross-Room Owner Management (`src/tools.ts`)

- Authenticates via `hub.resolveSessionPrincipal(exec)` and resolves target rooms uniquely via `hub.resolveTarget(...)` (`TargetDirectoryProvider`, keeping legacy `wxarcTargetDirectory` fallback). Missing or ambiguous targets are rejected (never silently falls back to DM). The legacy `currentRoomKey === null` bypass is permanently removed.
- **Strict role/tier locks**:
  - Subagents (`delegationDepth > 0`, `origin === 'subagent'`, `isSubagent`) and `unknown`/unauthenticated callers are always denied.
  - `external_chat` (group / non-owner DM) is hard-pinned to `boundRoomKey` (forcibly overrides `roomKey`/`targetChatId`; denies `allRooms: true` and cross-room reads/writes).
  - Trusted `worker` may operate only on its own `boundThreadKey`, with `notifyWechatChatId` restricted to empty or verified owner `controllerId` (group IDs rejected); `untrusted` Workers cannot add or cancel memos.
  - Only top-level `tier === 3` (`owner_session` / local `interactive`) may manage memos across rooms via `TargetDirectoryProvider` or pass `allRooms: true`.
- `watcher_memo_cancel` validates `id + room_key` atomically inside a SQLite transaction, returning a uniform non-leaking error with zero mutations on mismatch.

## `idempotencyKey` & `VaultProvider('memo')` (`src/store.ts`, `src/vault-provider.ts`)

- **Idempotency**: `watcher_memo_add` accepts optional `idempotencyKey`, persisted and strictly bound to its initial `room_key` (cross-room reuse throws a conflict error). Scheduled firings emit deterministic `memo-nudge:<memo.id>` and `memo-ping:<memo.id>:<notifyChatId>` keys.
- **Read-only Vault**: registers `VaultProvider('memo')` exposing active/recent memo search (`snippet ≤ 220` chars) and same-room context expansion; visibility resolves via `personaWardrobe?.resolveVaultVisibility(roomKey)`, defaulting unlabeled or `session:` memos to `'owner_private'`.

## Tools & Role Matrix (`src/tools.ts`)

| Tool | Permitted Callers | Key Enforcement |
|---|---|---|
| `watcher_memo_add` | `owner_session`/`interactive` (`tier=3`), `external_chat` (own room), trusted `worker` (own `boundThreadKey`) | Optional `idempotencyKey` locked to initial `room_key`; cross-room requires `tier=3` + unique `TargetDirectory` match. |
| `watcher_memo_list` | `owner_session`/`interactive` (`tier=3`), `external_chat` (own room), `worker` (own room) | `allRooms: true` restricted strictly to top-level `tier === 3`; subagents and `unknown` denied. |
| `watcher_memo_cancel` | `owner_session`/`interactive` (`tier=3`), `external_chat` (own room), trusted `worker` (own room) | Atomic SQLite transaction validating `id + room_key`; returns uniform non-leaking error on mismatch. |

## Standards & Commands
- **Standards**: 100% strict TypeScript (`.ts`, `.js` relative ESM imports, 2-space indent); strictly zero comments in `src/` and `test/`.

```bash
pnpm --filter @local/dsh-trigger-memo run build
pnpm --filter @local/dsh-trigger-memo run test
pnpm run check:comments
```
