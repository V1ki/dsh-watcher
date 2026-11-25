# dsh-watcher

100% TypeScript strict-mode ESM monorepo（只依赖 Node 24 内置模块，零第三方运行时 npm 依赖），为 DSH `>=0.2.2-rc.1 <0.3.0` 提供 **6 个运行时插件 + 1 个聚合包** 的模块化架构：独立性格衣柜、纯确定性 Hub 总控台、Super-agent 智能路由器（Router）、双向 GitHub 连接器、主动待惦记便签引擎，以及可选的双向 macOS 微信连接器。

## 唯一权威文档

所有整体框架、消息流转、分包边界、安全门禁与外发细节都在 [`docs/`](./docs/README.md) 目录中维护，代码变动与文档同步更新。

## 独立使用与可选连接器说明

- **核心能力均可独立安装使用**：`@local/dsh-persona`、`@local/dsh-hub`、`@local/dsh-router`、`@local/dsh-connector-github` 与 `@local/dsh-trigger-memo` 均不强依赖微信，可在任意支持 Node 24 的 macOS / Linux 环境按需组合启用（例如仅运行「性格衣柜 + Hub + Router + GitHub 连接器 + 便签引擎」）。
- **微信连接器为可选 macOS 组件**：`@local/dsh-connector-wxarc` 仅支持 `darwin` 平台，需配合本机微信客户端、macOS 辅助功能权限及本地 `wxarc` 监听服务使用；未安装或非 macOS 宿主机时，其余插件照常完整运行。

## 6 个运行时插件 + 1 个聚合包

| 包名 | Cordis ID | 侧边栏面板 | 职责 |
|---|---|---|---|
| `@local/dsh-persona` | `persona` | **「性格衣柜」** | 独立 `PersonaWardrobe` 性格资产库（`~/.dsh/storages/persona/state.sqlite`，首次启动自动无损迁移旧 `watcher/state.sqlite` 与 `wxarc-listener/events.sqlite`）；完整保留 3 项学习能力（本人历史发言风格提炼、带原话依据的 24 留 / 16 注入聊天偏好记忆、仅本人私用的 `foundation` CJK 2-gram 检索）；提供 `/local-persona/*` 路由与 `ctx.provide('personaWardrobe')` |
| `@local/dsh-hub` | `hub` | **「Hub 总控台」** | 100% 纯确定性事件总线（**0 次 LLM 调用**）；管理已接入插件总览、统一收件箱、`thread_subscriptions` 快速直达路由表、面向 `@local/dsh-router` 的 `onUnclaimedEvent` 钩子、管理员微信分发总线、便签本与草稿箱硬门禁（`DoorGuard`）、`/local-hub/*` + `/local-watcher/*` 双前缀路由，自动复用 `~/.dsh/storages/watcher/state.sqlite` |
| `@local/dsh-router` | `router` | **「Router」** *(order 10)* | Layer-3 Super-agent 智能大脑（`~/.dsh/storages/router/state.sqlite`）；仅订阅 `hub.onUnclaimedEvent(...)` 处理冷启动未认领事件与 Worker 经 `router_report_result` 回报的结论（已订阅线索走 Hub `thread_subscriptions` 快车道直达，零经过 Router）；提供 4 级分诊（`ignore`/`inform`/`prepare`/`act`）+ 程序硬护栏（`actor.isBot -> ignore`、紧急永不忽略、`untrusted` 封顶 `prepare`、模型异常 fail-open、一键「仍然通知」恢复）、作息与注意力路由（`work`/`off_hours`/`weekend`、`auto`/`present`/`away`、单焦点排队、紧急直达、「情境预演」、60 秒幂等延迟投递 Web/微信）、7d/30d 效果统计、`/local-router/*` 路由与 4 标签页 Web UI |
| `@local/dsh-connector-github` | `connector-github` | **「GitHub」** | 独立双向 GitHub 连接器：`/notifications` + ETag 轮询（含 👍 增量与 Issue/PR 增量评论拉取）、Read Token 与原生 GitHub App RS256 JWT（优先读 `connector-github/*`，自动回退旧 `watcher-github/*`）、默认 + 按仓库性格卡绑定（支持一键跳转「性格衣柜」）、监听仓库 / 重点盯防与自动发评配置、原始事件流（`/connector/github/events`）、Issue/PR 合住图谱、`git merge-tree` 冲突预检与外发评论/审查 |
| `@local/dsh-trigger-memo` | `trigger-memo` | *(并入 Hub 便签本)* | 3 模式主动待惦记便签引擎（`time_nudge`、`news_followup`、`long_watch` #223）、联网核查防噪与房间工具（`memo_add`、`memo_list`、`memo_cancel`），向 `@local/dsh-hub` 注册触发器 |
| `@local/dsh-connector-wxarc` *(可选 · macOS)* | `connector-wxarc` | **「微信消息」** | 可选 macOS（`darwin`-only）双向微信连接器：需配合本地 `wxarc` 监听服务，提供 3 秒轮询、收图高清宽限等待、DSH AI 回复、SwiftCUA 串行文字/图片发送与核对、6 个 `.py`/`.jxa` 辅助脚本、默认复用 `stateDir: ~/.dsh/wxarc-listener`、精简版人物选择器（一键跳转「性格衣柜」）、Cordis / HTTP SSH 隧道双模式桥接与 `127.0.0.1:8765` / 个人 `ownId` 硬拦截、`wxarc.send` 出口、`wxarc_proactive_send` 与 `githubToWechatRule` |
| `@local/dsh-hub-bundle` | *(meta-bundle)* | — | 通过 `cordis.patch.yml` 按 `persona → hub → router → connector-github / trigger-memo / connector-wxarc` 顺序一键汇总安装以上 6 个运行时插件（适配 DSH `autoInstallPeers: false`，非 macOS 宿主机自动忽略 `connector-wxarc`），并承载跨包端到端集成测试 |

## 默认行为

- **纯确定性总控 + Super-agent 智能路由 + 独立性格衣柜**：`@local/dsh-hub` 自身永不调用大模型（0 LLM calls），只负责按 `thread_subscriptions` 快速直达、收件箱/草稿箱/便签管理与出口门禁；冷启动未认领事件统一经 `onUnclaimedEvent` 交给 Layer-3 大脑 `@local/dsh-router`（「Router」，order 10）做 4 级分诊（程序硬护栏高于 LLM，异常 fail-open 绝不静默丢消息）、Worker 派发与作息/在席注意力路由，Worker 认领线索并注册 `thread_subscriptions` 后，后续追问直接走 Hub 快车道绕过 Router。性格设定卡、风格提炼、偏好记忆与 `foundation` 检索全部独立沉淀在 `@local/dsh-persona`（「性格衣柜」），供微信、GitHub 与 Router 共用。
- **GitHub 身份、面板与外发策略**：独立侧边栏 **「GitHub」** 面板（`/connector/github/*`）集中管理 Read Token、原生 **GitHub App 机器人（`<slug>[bot]`）**（存入 `~/.dsh/.credentials.yaml` 的 `connector-github/github-app`，兼容回退旧 `watcher-github/*`，`0600` 权限、PEM 私钥永不回显）、默认及按仓库绑定的性格卡、监听仓库/重点盯防条目与原始事件流。执行发评/审查（`act`）时优先用 App 按仓库自动换取 1 小时临时安装令牌，**保留对本人 PR 的 `APPROVE` / `REQUEST_CHANGES`**。默认 `autoSendOwners: []`（所有仓库一律先入 Hub 草稿箱等待人工确认）；在「GitHub」面板配置 `autoSendOwners` 或单仓库 `autoSend: true` 后可开启自动直发，直发时自动附加隐形 `<!-- dsh-watch-self:... -->` 防回环标记。
- **可选双向微信连接器与双模式连接**：`@local/dsh-connector-wxarc` 默认复用 `~/.dsh/wxarc-listener` 状态目录，直接承担微信 3 秒轮询、AI 回复、SwiftCUA 串行发送与 Hub 桥接。同宿主机走 Cordis 进程内直连；远端开发机可经 `127.0.0.1:33080` SSH 隧道调 `/wxarc/bridge/*`（Bearer Token 校验），硬拦截本机个人微信 `127.0.0.1:8765` 与非小号 `ownId`。
- **安全门禁（`DoorGuard`）**：在 `packages/dsh-hub/src/guard.ts` 预留 `beforeEnterRoom` 与 `beforeSendOut` 两个默认放行（`{ allow: true }`）钩子；后续随时通过 `guard.registerGuard(...)` 扣上自定义检查，无需改动核心流程。
- **无损迁移与重启恢复**：`@local/dsh-persona` 首次启动自动从旧 `watcher/state.sqlite` / `wxarc-listener/events.sqlite` 无损迁移到 `~/.dsh/storages/persona/state.sqlite`；`@local/dsh-hub` 未指定 `stateDir` 时自动复用已有的 `~/.dsh/storages/watcher/state.sqlite`（WAL + `STRICT` 表 + `0600` 权限，配 `automation-owner.sqlite` 独占租约）；重启时将残留的 `executing` / `sending` 记录自动转为 `uncertain`，绝不盲目重发。

## 本地验证

```bash
pnpm install
pnpm run check:comments
pnpm run build
pnpm test
```

## 基于 `.env.deploy` 的远程宿主机部署

仓库内置纯 TypeScript 部署脚本 [`scripts/deploy-macmini.ts`](./scripts/deploy-macmini.ts)，不含任何硬编码主机地址或密钥。首次部署前复制模板并填写真实目标（`.env.deploy` 已被 `.gitignore` 忽略）：

```bash
cp .env.deploy.example .env.deploy
```

`.env.deploy` 字段说明：

| 变量 | 说明 |
|---|---|
| `DSH_DEPLOY_HOST` | SSH 目标主机（如 `user@your-host`） |
| `DSH_DEPLOY_REMOTE_DIR` | 远端存放插件 `.tgz` 的目录（如 `/path/to/plugins`） |
| `DSH_DEPLOY_SERVICE` | 可选，远端 `launchctl kickstart -k` 服务名（如 `gui/501/local.dsh-web`） |
| `DSH_DEPLOY_SSH_OPTS` | 可选，附加给 `ssh`/`scp` 的参数（如 `-p 2222 -i ~/.ssh/id_ed25519`） |
| `DSH_DEPLOY_HEALTH_URL` | 可选，重启后通过 `curl -fsS` 探活的本地接口（如 `http://127.0.0.1:33080/local-router/status`） |

确认工作区已提交干净后执行一键验证、打包、上传、重装与重启：

```bash
pnpm run deploy:macmini
```

脚本会依次执行：校验 `git status --porcelain` 干净 → 跑 `check:comments` / `build` / `test` → 将 6 个运行时插件打包到 `dist-tgz/` → 通过 `scp` 上传并调用 `dsh plugin --profile web remove/add` → 写入 `~/.dsh/dsh-watcher.deployed-rev` → 重启服务并探活（支持 `--dry-run` 演练）。
