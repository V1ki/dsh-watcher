# `@local/dsh-connector-wxarc` (`packages/dsh-connector-wxarc/AGENTS.md`)

Follow the repository-root [`AGENTS.md`](../../AGENTS.md) plus these package-level technical contracts.

## Documentation Split Rule

- **Implementation contracts stay here**: Any change to wxarc polling, `controllerId` bridge, group single-turn cross-read, `WechatVaultProvider`/`NasVaultProvider`, `nas-search.ts`, SwiftCUA OCR/draft cleanup, tools, or `/wxarc/*` routes MUST update this `AGENTS.md`.
- **Human-facing docs stay plain**: Only when user-visible behavior, WeChat UX, or safety boundaries change, sync [`../../docs/07-消息怎么发出去.md`](../../docs/07-消息怎么发出去.md) (WeChat commands in `../../docs/03-微信上怎么指挥它.md`, safety in `../../docs/06-安全护栏怎么兜底.md`) per root `AGENTS.md` §3.

## Platform, State, Helper Assets & Security Hard Blocks

- Private macOS-only (`"private": true`, `dsh.bundle.platforms: ["darwin"]`) Cordis plugin `id: connector-wxarc`, sidebar **「微信消息」**, classic IIFE `lib/client.js` (`tsconfig.client.json`), zero external runtime dependencies.
- Default `stateDir: ~/.dsh/wxarc-listener` (SQLite + cursors); `pollMs: 3000` (3s polling); 6 helper assets under `src/` (`article-parser.py`, `clipboard.jxa`, `contacts.py`, `desktop-layout.jxa`, `image-pixels.py`, `mention-source.py`) copied into `lib/` and `lib-test/src/` via `scripts/copy-assets.ts`.
- **Hard security blocks**:
  - Port `8765` is hard-blocked in both `transport.ts` and `nas-search.ts` (never connects to personal laptop wxarc on `127.0.0.1:8765`).
  - `DEFAULT_NAS_ARCHIVE_URL = ''` (zero hardcoded LAN IPs; configured explicitly only). Non-loopback bridge URLs rejected by default; enforces bot `ownId` and `blockedOwnIds`.

## Single-Owner `controllerId`, `owner-dm` Bridge & Group Isolation (`src/admin.ts`, `src/automation.ts`, `src/agent.ts`)

- `resolveOwnerId(policy)` enforces a single owner `controllerId` (`validatePolicy` rejects multi-admin configs, falling back to legacy `adminIds[0]` only when `controllerId` is unset). Dual-mode `WechatTransport` (`mode: 'cordis' | 'http'`, HTTP via `/wxarc/bridge/*` with constant-time Bearer auth) exposes `controllerId` and `imagePath` in both modes.
- **Focus-lock-free `owner-dm` passthrough**: when Hub mounts `adminWechatHandler` (Router active), retires `wxarc_admin_sessions` (downgrades legacy rows to `workspace-write` on boot while keeping `~/DSH-WeChat/<hash>` read-only on disk) and stops local `WechatApprovals` from consuming owner approval codes. `Automation.collect()` routes owner text/quotes directly to `hub.dispatchAdminWechatMessage`, while media (`3` image / `34` voice / `43` video / `49` non-quote article) immediately advances the cursor and runs non-blocking async preprocessing (`imagePath`, `voiceTranscript`, `articleSummary`, `mediaPaths`) before forwarding.
- **Default group isolation**: all non-admin `dsh_conversations` register as Hub `SessionPrincipal` with `role: 'external_chat', tier: 0, trustLevel: 'untrusted', boundRoomKey: chatId`. System prompts inject current group name + ID each turn, dynamically pull `@local/dsh-persona` (`includeOwnerMemory` forced `false` in groups), apply 35s thumbnail grace (`WXARC_IMAGE_PENDING`), and run `MediaPreprocessor` + `recallMultimodal`.

## Owner Group `@` Single-Turn Cross-Read (`src/agent.ts`, `src/index.ts`)

- Triggered strictly by `isOwnerGroupAtMentionTurn`: verified `senderId === controllerId` AND explicit `@bot` (verified native `mentions`, structured `atMe`, or text `@<botName>[\u2005\s]`) in a non-preview, non-`memoTrigger`, top-level session.
- Before `prompt`, calls `hub.setSessionTurnOverride(sessionId, 3, 5 * 60_000)` (`OWNER_GROUP_CROSS_READ_TTL_MS`); unconditionally calls `clearSessionTurnOverride` on turn end (completion, failure, cancel, takeover, or plugin stop).
- Whitelists ONLY **5 read-only tools** without confirmation (`vault_search`, `vault_context`, `wxarc_nas_search`, `wxarc_messages`, `wxarc_targets`); `wxarc_status`, file writes, `bash`, proactive sends, and cross-room memo mutations remain blocked. Once cross-read runs or session is tainted, `web_fetch`/`web_search` are hard-blocked for that turn.

## Vault Providers, `TargetDirectoryProvider` & `nas-search.ts`

- Registers `WechatVaultProvider` (`events.sqlite`, `snippet ≤ 200` chars, supports `roomKey` filter and empty `query` chronological browse), `NasVaultProvider` (unlabeled chats default to `'owner_private'`), and `TargetDirectoryProvider` (unique group/contact resolver).
- **`nas-search.ts`**: caches `/api/sessions` for **60s** (`NAS_SESSIONS_CACHE_TTL_MS = 60_000`); resolves group names by whitespace-stripped lowercase matching (exact first, then substring, up to 3 sessions; **unmatched target returns empty — never falls back to other chats**); supports empty `query` + `since`/`until`/`session`/`sender` with `next` -> `before` pagination up to **5 pages × 50 items** (`MAX_NAS_PAGES = 5`, `NAS_PAGE_SIZE = 50`, max 4MB response, 12s timeout).

## SwiftCUA Serial Send, Quote OCR & Draft Protection (`src/cua.ts`, `src/sender.ts`, `src/send-sink.ts`)

- Global serial queue (`enqueueSerialized`/`proactiveQueue`); `openChat` falls back to `Cmd+f` search on `OBSTRUCTED` after re-checking empty draft; `SwiftCua.state()` retries only read-only `getAppState` transient failures up to 2 times (`150ms`, `300ms`) — never retries side-effect clicks/sends or locked-screen/permission errors.
- **Proactive text & image (`normalizeProactiveParts`, `loadLocalImage`)**: hard per-part limit `1500` chars, auto-splits `> 1200` chars (blank line -> newline -> sentence punctuation -> UTF-16 surrogate-safe split), max `6` parts, total cap **6000 chars**; images validate absolute path, `.png`/`.jpg`/`.jpeg`, `≤ 8MB`, and binary magic header. Pre-send retries (max 2: `2s`, `5s`) allowed only when `sentSteps === 0`; once `sending`/`uncertain`, NEVER replays.
- **Native quote OCR & 4-step cleanup (`prepareQuote`, `selectMention`, `cleanupOwnedDraft`)**: raises main window (`AXRaise`) before right-click; two-phase full OCR (`250ms` -> `250ms` -> optional single re-right-click `300ms`) clustering menu neighbors (`复制`/`转发`/`收藏`/`多选`/`搜一搜`/`翻译`/`删除`) within `±60px` X to handle 1x dark-mode prefix misreads and `≤ 44px` line height; pre-right-click failures drop quote cleanly, post-right-click failures run 4-step safe cleanup (`Escape` -> verify `input.value === ''` -> remove misattached `删除引用消息` only if clicked -> click input focus) before fallback send. `selectMention` scans up to 3 read-only OCR rounds (`200ms`/`250ms`); `cleanupOwnedDraft()` fails closed to never delete user-typed drafts.

## Tools, Routes & Commands

- **Tools**: `wxarc_status`, `wxarc_messages`, `wxarc_targets`, `wxarc_nas_search`, `wxarc_sticker_search`, `wxarc_proactive_send`. All except `wxarc_sticker_search` enforce `hub.resolveSessionPrincipal(exec)` (`tier === 3`, `delegationDepth === 0`, `!isSubagent`); `wxarc_proactive_send` also passes `DoorGuard` (tainted or group/cross-group sends force `stageOnly: true`).
- **Routes**: `/wxarc/*` (Web UI) and `/wxarc/bridge/*` (`/status`, `/recent`, `/send`).
- **Standards**: 100% strict TypeScript, strictly zero comments in `src/`, `test/`, and `scripts/`.

```bash
pnpm --filter @local/dsh-connector-wxarc run build
pnpm --filter @local/dsh-connector-wxarc run test
pnpm run check:comments
```
