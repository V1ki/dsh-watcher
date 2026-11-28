# `@local/dsh-persona` (`packages/dsh-persona/AGENTS.md`)

Follow the repository-root [`AGENTS.md`](../../AGENTS.md) plus these package-level technical contracts.

## Documentation Split Rule

- **Implementation contracts stay here**: Any change to SQLite schema, migration sources, circle resolution, learning/recall algorithms, exports, or `/local-persona/*` routes MUST update this `AGENTS.md`.
- **Human-facing docs stay plain**: Only when user-visible behavior, interaction, or privacy boundaries change, sync the primary human doc [`../../docs/04-性格衣柜与查资料.md`](../../docs/04-性格衣柜与查资料.md) following root `AGENTS.md` §3.

## Ownership & Cordis Service

- Cordis plugin `id: persona` (`inject: []`), sidebar panel **「性格衣柜」**, provides `ctx.provide('personaWardrobe')`.
- Sole editing/learning entry point for persona cards across WeChat, GitHub, and Router; connectors only render a compact selector + jump button.
- Zero external runtime npm dependencies (Node 24 built-ins only; Cordis/Schemastery stay in `peerDependencies`).
- Classic IIFE Web UI: `src/client.ts` compiles via `tsconfig.client.json` (`module: "none"`, `moduleDetection: "legacy"`, `verbatimModuleSyntax: false`) into `lib/client.js` with zero `import`/`export` statements.

## Storage & Lossless Migration (`src/db.ts`)

- Dedicated SQLite database: `~/.dsh/storages/persona/state.sqlite` (WAL, `STRICT` tables, `0600`).
- **Core tables**:
  - `personas`, `persona_memory` (schema-upgraded via `persona_memory_v2`), `persona_meta`
  - `chat_circle`, `foundation_imports`
  - `media_asset`, `visual_observation`, `event_fact`, `reference_card`, `memory_evidence`
  - FTS5 virtual tables: `reference_card_fts`, `event_fact_fts`
- **First-boot auto-migration sources**: losslessly migrates legacy persona/memory records from `~/.dsh/storages/watcher/state.sqlite` and `~/.dsh/wxarc-listener/events.sqlite`.

## Circle Visibility & `wardrobe` / `persona` `VaultProvider` (`src/wardrobe-policy.ts`, `src/wardrobe-vault.ts`)

- **4 visibility tiers**: `external` | `work` | `family` | `owner_private`.
- **Multi-connector `chat_circle` keys**: supports bare WeChat `chatId` and prefixed keys (`wxarc:<id>`, `dingtalk:<cid>`, `github:<owner/repo>`). Lookup prefers exact match with bidirectional fallback between `wxarc:<id>` and bare `<id>`.
- **Ceiling resolution**:
  - `resolveChatCircle(roomKey)` / `resolveVaultVisibility(roomKey)`: unlabeled (`labeled === false`) records ALWAYS resolve to `'owner_private'`.
  - `foundation` knowledge is ALWAYS `'owner_private'`.
- **Read-only Vault bridge**: exposes `searchVaultKnowledge` (`snippet ≤ 220` chars) and `getVaultKnowledgeContext` (never leaks cross-circle neighbors), automatically registered by `@local/dsh-hub` as `VaultProvider('persona')` (wardrobe source).

## Learning Engines & Multimodal Recall (`src/wardrobe.ts`, `src/foundation.ts`, `src/multimodal.ts`, `src/wardrobe-recall.ts`)

| Capability | Contract & Boundary |
|---|---|
| Owner style extraction | `learn-style` distills sentence length, wording, and tone from owner message samples; prompts carry only the distilled profile, never raw samples. |
| 24 / 16 quote-evidenced preferences | Scoped per `(persona, room/scope)` with verbatim quote evidence; retains at most **24** entries, injects latest **16** per turn; editable/revocable/clearable; Moments (`sns:*`) and preview chats (`preview`) NEVER auto-write. |
| Owner-private `foundation` retrieval | Pure TypeScript CJK 2-gram relevance recall over `foundation_imports`; strictly gated by server-computed `includeOwnerMemory` (forced `false` for group chats, non-owner DMs, and `memoTrigger`). |
| Two-step multimodal recall (`recallMultimodal`) | Attaches 1–2 curated `reference_card` images + confirmed `event_fact` only in permitted circles (**zero attachments** for `external` or unlabeled groups); applies 4-signal weighting + quality veto cap + 3-tier anti-awkwardness phrasing; pure visual observations land only as `candidate` drafts and never fabricate ownership/gifting facts from pixels. |

## Public Exports & `/local-persona/*` Routes

- **Exports (`src/index.ts`)**: `apply`, `name`, `inject`, `contracts.ts`, `db.ts`, `wardrobe.ts` (`createPersonaWardrobe`, `PersonaWardrobeImpl` / `PersonaWardrobeStore`), `http-routes.ts`, `foundation.ts`, `multimodal.ts`.
- **Local-owner HTTP routes (`src/http-routes.ts`, `src/http-routes-ext.ts`)**:
  - UI & meta: `GET /local-persona`, `GET /local-persona/version`, `GET /local-persona/sample-info`
  - Personas & learning: `GET|POST /local-persona/personas`, `POST /local-persona/personas/import-foundation`, `POST /local-persona/personas/import-wxarc`, `GET|PUT|DELETE /local-persona/personas/:id`, `POST /local-persona/personas/:id/learn-style`, `POST /local-persona/personas/:id/preview`
  - Memories: `GET|DELETE /local-persona/personas/:id/memories`, `PUT|DELETE /local-persona/personas/:id/memories/:memId`, `POST /local-persona/personas/:id/memories/:memId/revoke`
  - Circles & multimodal: `GET /local-persona/circles`, `GET|PUT|DELETE /local-persona/circles/:chatId`, `GET|POST /local-persona/reference-cards`, `DELETE /local-persona/reference-cards/:cardId`, `GET /local-persona/media-assets`, `GET|POST /local-persona/observations`, `POST /local-persona/observations/:obsId/(promote|reject)`, `GET /local-persona/event-facts`, `DELETE /local-persona/event-facts/:factId`, `POST /local-persona/recall`

## Standards & Commands

- 100% strict TypeScript (`.ts`, `.js` relative ESM imports, 2-space indent); strictly zero comments in `src/` and `test/`.

```bash
pnpm --filter @local/dsh-persona run build
pnpm --filter @local/dsh-persona run test
node ../../scripts/check-no-comments.ts .
```
