# `@local/dsh-hub` (`packages/dsh-hub/AGENTS.md`)

Follow the repository-root [`AGENTS.md`](../../AGENTS.md) plus these package-level technical contracts.

## Documentation Split Rule

- **Implementation contracts stay here**: Any change to schema, deterministic routing, `HubVault`, `SessionPrincipal`, `DoorGuard`, extension contracts, tools, or `/local-hub/*` routes MUST update this `AGENTS.md`.
- **Human-facing docs stay plain**: Only when user-visible behavior, routing semantics, or security boundaries change, sync [`../../docs/01-整体长什么样.md`](../../docs/01-整体长什么样.md) and [`../../docs/02-日常消息怎么走.md`](../../docs/02-日常消息怎么走.md) (Vault rules in `../../docs/04-性格衣柜与查资料.md`, safety guardrails in `../../docs/06-安全护栏怎么兜底.md`) per root `AGENTS.md` §3.

## Ownership & Zero-LLM Invariant

- Pure deterministic core Cordis service (`id: hub`), provides `ctx.hub`, legacy `ctx.watcher`, and `ctx.provide('vault', service.vault)`; sidebar panel **「Hub 总控台」** (4 platform-agnostic tabs: 收件箱 / 便签本 / 草稿箱 / 已接入插件).
- **0 LLM calls invariant**: Hub NEVER invokes an LLM directly. `PersonaWardrobe` lives in `@local/dsh-persona` and is resolved dynamically via `getWardrobe()`.
- **Zero third-party runtime dependencies**: Node 24 built-ins only (`node:sqlite`, `node:crypto`, `node:fs`, `node:path`, `node:os`, `node:http`).
- **Build artifact parity**: `src/schema.sql` MUST copy into `lib/schema.sql` on build and `lib-test/src/schema.sql` on test; `src/client.ts` compiles via `tsconfig.client.json` as a classic IIFE (`lib/client.js`, zero `import`/`export`).

## Storage & Schema (`src/db.ts`, `src/schema.sql`)

- **Lossless state path (`resolveStateDir`)**: defaults to `~/.dsh/storages/hub`, but automatically reuses `~/.dsh/storages/watcher/state.sqlite` when `hub/state.sqlite` is absent and `watcher/state.sqlite` exists.
- **16 `STRICT` tables (0 new tables for Vault/Principal)**:
  - Core bus & state: `inbox_items` (ingested events ledger), `workstreams`, `thread_subscriptions`, `staged_drafts`, `runtime_meta`
  - Coordination & reliability: `owner_lease`, `source_cursors`, `entities`, `entity_edges`, `delivery_receipts`, `circuit_breaker_log`
  - Memos & legacy migration tables: `memos`, `memo_seen_urls`, `proactive_budget`, `personas`, `persona_memory`

## Deterministic Routing & Lifecycle (`src/service.ts`, `src/session-bridge.ts`)

1. **Terminal lifecycle detection (`onThreadLifecycle`)**: `ingest()` checks `.closed`/`.merged`, `payload.state === 'closed'`, `payload.merged === true`, or `payload.lifecycleOnly === true` and dispatches `onThreadLifecycle` (`closed` | `merged` | `ended`). When `payload.lifecycleOnly === true`, returns `routedVia: 'lifecycle'` immediately without waking any Worker or invoking `onUnclaimedEvent`.
2. **Fast Path (`thread_subscriptions`)**: active subscription hits route straight to the bound room, bypassing Router. For unsubscribed GitHub PRs, Hub inspects `payload.linkedIssues` (and legacy `payload.linkedFromIssue`) to inherit the linked same-repo Issue's active subscription (`linkedFromThreadKey` recorded in `metadata`). For `owner === 'router'` fast paths with `metadata.decisionId`, wake prompts forward `summary`, `reviewState`, inline `path`/`line`, and `decisionId`.
3. **Unclaimed cold start (`onUnclaimedEvent`)**: dispatches unclaimed events to registered Layer-3 consumers (`@local/dsh-router`).
4. **Room fallback & serialization**: falls back to thread/room mapping with per-room serial queueing; provides `registerAdminWechatHandler` / `dispatchAdminWechatMessage` (forwarding multimodal fields `sourceKey`, `localType`, `imagePath`, `voiceTranscript`, `articleSummary`, `mediaPaths`).

## `HubVault` & Sticky Taint (`src/vault.ts`, `src/service.ts`)

- Exposes `ctx.provide('vault', service.vault)` and global read-only tools:
  - `vault_search`: default limit `10`, max `20`, `snippet ≤ 220` chars. Allows empty `query` for reverse-chronological browsing when paired with at least one filter (`sources`, `roomKey`, `circle`, `person`, `since`, `until`); pure empty query throws `VAULT_INVALID_QUERY`.
  - `vault_context`: default window `5` before/after, max `15`; isolates neighbors strictly within `allowedCircles`.
- Automatically bridges `personaWardrobe.searchVaultKnowledge` as `VaultProvider('persona')`.
- **Double visibility enforcement**: passes `allowedCircles` into every `VaultProvider` AND re-filters aggregated hits in Hub.
- **Sticky Taint & Single-Turn Private Read**: hitting any item with `visibility !== 'external'` immediately marks both the calling session and its `rootSessionId` with:
  - Session-level sticky `tainted` (`markSessionTainted` / `isSessionTainted`, irreversible within the session lifecycle).
  - Single-turn `turnPrivateRead` (`markTurnPrivateRead` / `isTurnPrivateRead` / `clearTurnPrivateRead`, cleared at turn end).

## In-Memory `SessionPrincipal` Registry (`src/contracts.ts`, `src/service.ts`)

- Pure in-memory `sessionPrincipals` and `sessionTurnOverrides` (rehydrated on restart by Router and connectors).
- **Roles**: `owner_session` | `worker` | `external_chat` | `interactive` | `unknown`.
- **Tiers (`SessionVaultTier` 0..3)**: `0 -> []` (throws `VAULT_FORBIDDEN`), `1 -> ['external']`, `2 -> ['external', 'work']`, `3 -> ['external', 'work', 'family', 'owner_private']`.
- **Resolution (`resolveSessionPrincipal(exec)`)**: missing `agent.id` fails closed (`tier: 0`); traces `parentSessionId`/`parentSession`/`rootSessionId`/`agents.get` to root so subagents never escalate and taint propagates upward (missing parent fails closed to `tier: 0`). Sensitive tools require `delegationDepth === 0`.
- **Temporary turn override**: `setSessionTurnOverride(sessionId, tier, ttlMs)` / `clearSessionTurnOverride(sessionId)` with TTL expiration and explicit turn-end/lifecycle cleanup.

## Extension Points & `DoorGuard` (`src/contracts.ts`, `src/guard.ts`)

- **Standard plug-in interfaces**: `WatchSource`, `ActionSink`, `VaultProvider`, `TargetDirectoryProvider` (`registerTargetDirectory`, `resolveTarget`, `listTargets`), `onUnclaimedEvent`, `onThreadLifecycle`.
- **One-way outbound defense (`DoorGuard`)**:
  - Pluggable `beforeEnterRoom` and `beforeSendOut` hooks via `guard.registerGuard(...)` (any `{ allow: false, reason }` blocks and returns `skipped`).
  - Built-in taint lock: whenever `isSessionTainted(sessionId)` is true, `invokeSink` forces `stageOnly: true, tainted: true` into `staged_drafts`. If `targetCircle === 'external'`, attaches `PUBLIC_TAINT_WARNING_TEXT` (`⚠️ 本会话查过内部/私人记录，发送公网前请核对不含敏感信息`) to preview/metadata (stripped upon human approval so only clean body is published).
  - Crash recovery (`recoverOrphanedSinks`): transitions orphaned `executing` receipts to `uncertain`; never auto-replays the same `idempotencyKey`.

## Tools & Dual-Prefix HTTP Routes (`src/posterior.ts`, `src/http-routes.ts`)

- **Tools**: `vault_search`, `vault_context`, `watch_list`, `watch_update`, `watch_cancel`, `watch_stage_draft`.
- **Routes** (mounted under both `/local-hub/*` and legacy `/local-watcher/*`): `/status`, `/connectors`, `/subscriptions` (`GET|POST|DELETE`), `/inbox`, `/workstreams`, `/workstreams/:id/cancel`, `/drafts`, `/drafts/:id/(approve|discard)`, `/memos` (`GET|POST`), `/memos/:id/(cancel|check)`, `/personas/*` proxy, `/sources/:id/poll`.

## Standards & Commands

- 100% strict TypeScript (`.ts`/`.tsx`, `.js` relative ESM imports, 2-space indent); strictly zero comments in `src/` and `test/`.

```bash
pnpm --filter @local/dsh-hub run build
pnpm --filter @local/dsh-hub run test
node ../../scripts/check-no-comments.ts .
```
