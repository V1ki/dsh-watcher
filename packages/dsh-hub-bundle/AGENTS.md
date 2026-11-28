# `@local/dsh-hub-bundle` (`packages/dsh-hub-bundle/AGENTS.md`)

Follow the repository-root [`AGENTS.md`](../../AGENTS.md) plus these package-level technical contracts.

## Documentation Split Rule

- **Implementation contracts stay here**: Any change to `cordis.patch.yml`, plugin load order, package dependency topology, or cross-package E2E test suites MUST update this `AGENTS.md`.
- **Human-facing docs stay plain**: Only when user-visible installation, packaging, deployment, or maintenance procedures change, sync [`../../docs/08-安装部署与日常维护.md`](../../docs/08-安装部署与日常维护.md) per root `AGENTS.md` §3.

## Ownership & Plugin Load Order (`cordis.patch.yml`)

- Meta-bundle `@local/dsh-hub-bundle` (`dsh.bundle.patch: ./cordis.patch.yml`) wiring all **6 runtime plugins** in deterministic dependency order:
  1. `persona` (`@local/dsh-persona`) — initializes `personaWardrobe` first.
  2. `hub` (`@local/dsh-hub`) — initializes `hub`, `vault` (bridging `persona`), `SessionPrincipal`, and `DoorGuard`.
  3. `router` (`@local/dsh-router`) — attaches Layer-3 brain (`onUnclaimedEvent`, `onThreadLifecycle`, `owner_session`, `RouterApprovals`).
  4. `connector-github` (`@local/dsh-connector-github`) — GitHub `WatchSource` + `ActionSink` + `VaultProvider('github')`.
  5. `trigger-memo` (`@local/dsh-trigger-memo`) — 3-mode memo `WatchSource` + `VaultProvider('memo')`.
  6. `connector-wxarc` (`@local/dsh-connector-wxarc`, listed in `optionalDependencies`) — macOS-only WeChat `WatchSource` + `ActionSink` + `VaultProvider('wechat'/'nas')` + `TargetDirectoryProvider`; non-`darwin` hosts automatically skip it via `dsh.bundle.platforms: ["darwin"]`.
- Runtime packages are packed into 6 `.tgz` archives via `pnpm pack` (or repo-root `pnpm run deploy:macmini` using `.env.deploy`, zero hardcoded hosts).

## Cross-Package E2E Test Suite (`test/`)

| Test File | Coverage Scope |
|---|---|
| `test/e2e.test.ts` | End-to-end 6-plugin lifecycle: WeChat/GitHub/Memo event ingestion, Hub `thread_subscriptions` fast path, Router 4-level triage & Worker dispatch, draft approval & anti-loop outbound flow, cross-package Cordis wiring. |
| `test/vault-e2e.test.ts` | Unified `HubVault` (`vault_search`/`vault_context`, 4-tier visibility isolation, empty-`query` filtered browsing), Sticky Taint + `DoorGuard` forced `stageOnly` & public warning, `onThreadLifecycle` (`lifecycleOnly`) terminal auto-resolution, focus-lock-free owner DM routing & `RouterApprovals` guardrails. |

## Packaging & Deployment Contract

| Target | Artifact / Behavior |
|---|---|
| 6 runtime `.tgz` archives | Packed via `pnpm pack --pack-destination dist-tgz` and installed via `dsh plugin --profile web add <6 .tgz>` (remove before re-adding same version to bypass pnpm local cache). |
| Platform filtering | `@local/dsh-connector-wxarc` declares `dsh.bundle.platforms: ["darwin"]` and stays in `optionalDependencies`; non-macOS hosts skip it automatically. |
| Automated deploy | Repo-root `pnpm run deploy:macmini` reads `.env.deploy` (zero hardcoded hosts), validates clean tree / comments / build / tests, deploys, restarts DSH, and writes `~/.dsh/dsh-watcher.deployed-rev`. |

## Strict Standards & Commands

- 100% strict TypeScript (`.ts`, `.js` relative ESM imports, 2-space indent); strictly zero comments in `src/` and `test/`.
- Keep Cordis/Schemastery/`@deepseek-ai/dsh-scope` in `peerDependencies` and `@local/dsh-connector-wxarc` in `optionalDependencies`.

```bash
pnpm --filter @local/dsh-hub-bundle run build
pnpm --filter @local/dsh-hub-bundle run test
pnpm run check:comments
```

Full workspace verification from repo root:

```bash
pnpm run check:comments && pnpm run build && pnpm test
```
