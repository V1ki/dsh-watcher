# dsh-watcher 文档目录（唯一权威文档）

> 本目录（`dsh-watcher/docs/`）是整个代码库的**唯一权威文档**。
> 凡是涉及架构、消息流转、配置默认值、工具接口、安全门禁或外发行为的代码改动，**必须在同一次改动中同步更新本目录对应文档**。

## 文档索引

| 编号 | 文档 | 核心内容 |
|---|---|---|
| 01 | [01-整体框架图.md](./01-整体框架图.md) | 整体结构：独立性格衣柜（`dsh-persona`）、纯确定性 Hub 总控台（`dsh-hub`，0 LLM + 统一 `Vault` 知识检索 + `SessionPrincipal` + `TargetDirectoryProvider` + `onThreadLifecycle`）、Layer-3 Super-agent 大脑（`dsh-router`）、多连接器标准三件套（`WatchSource` + `ActionSink` + `VaultProvider`）、待惦记便签与 DSH 房间 |
| 02 | [02-消息流转全过程.md](./02-消息流转全过程.md) | 4 条日常消息路线 + Router 冷启动 4 级分诊、无焦点锁微信双向协作（0-LLM 顶层分拣 / 薄 `owner_session` 桥接 / 积压 `≥3` 合并汇总卡 / PR 与 Issue 合并关闭 `lifecycleOnly` 自动销账）、Worker 实物/截图回报与 `thread_subscriptions` 快车道直达的完整走法 |
| 03 | [03-怎么拆分与落地步骤.md](./03-怎么拆分与落地步骤.md) | 6 个运行时插件 + 1 个聚合包的真实目录结构、独立「Router」「性格衣柜」「GitHub」面板、无损迁移、`dsh-connector-wxarc` 瘦身（单主人 `controllerId`、退役 `wxarc_admin_sessions`、多模态旁路异步预处理）与常用命令 |
| 04 | [04-以后再加的安全门禁.md](./04-以后再加的安全门禁.md) | 安全与隐私护栏：内存 `SessionPrincipal` 与四档 Vault 可见性（`0/1/2/3`）、粘性污点锁（Sticky Taint）与 `DoorGuard` 公网草稿污点警告、Router `RouterApprovals` + `tools/pre-execute` 护栏、Worker 无网沙箱，以及 `DoorGuard` 可插拔钩子 |
| 05 | [05-消息怎么真正发出去.md](./05-消息怎么真正发出去.md) | 微信 GUI 外发（含文字+截图串行发送、双模式桥接、`controllerId` 透出与统一 Hub 鉴权/污点草稿箱）与 GitHub API 外发（独立「GitHub」面板、原生 GitHub App 机器人、默认草稿箱、主体鉴权 + 污点公网草稿警告、防回环与不重发） |

## 常用验证命令

```bash
pnpm install
pnpm run build
pnpm test
pnpm run check:comments
```

## 同步更新清单

修改代码时，按影响范围更新对应文档：

- 改动独立性格衣柜、风格提炼、24/16 偏好记忆、`foundation` 2-gram 检索、多连接器 `chat_circle` 圈层前缀或只读 `Vault` 知识查询（`packages/dsh-persona`）→ 更新 `01`、`03`、`04`
- 改动纯确定性事件总线、统一 `Vault`（`vault_search` / `vault_context` / `ctx.provide('vault')`）、`SessionPrincipal` 与粘性污点锁、`TargetDirectoryProvider`、`onThreadLifecycle`、`thread_subscriptions` / `onUnclaimedEvent` / 管理员微信分发总线或 Hub 4 标签页 UI（`packages/dsh-hub`）→ 更新 `01`、`02`、`03`、`04`
- 改动 Layer-3 Super-agent 路由器、4 级分诊与硬护栏、作息与积压 `≥3` 合并汇总卡、终态自动销账、薄 `owner_session` 桥接与 0-LLM 顶层分拣、`RouterApprovals` / `tools/pre-execute` 护栏、Worker 派发/`router_report_result`、效果统计或 Router 4 标签页 UI（`packages/dsh-router`）→ 更新 `01`、`02`、`03`、`04`
- 改动 `DoorGuard`、污点草稿警告或安全拦截逻辑（`packages/dsh-hub/src/guard.ts`）→ 更新 `04`、`05`
- 改动 GitHub 轮询、`lifecycleOnly` 终态补发、`VaultProvider('github')`、原始事件流、图谱、合并预检、性格卡绑定、原生 GitHub App 认证或独立「GitHub」面板（`packages/dsh-connector-github`）→ 更新 `02`、`03`、`05`
- 改动待惦记便签调度、`VaultProvider('memo')`、Hub 主体/目标目录鉴权或房间工具（`packages/dsh-trigger-memo`）→ 更新 `01`、`02`、`03`、`04`
- 改动双向微信连接器瘦身（单一 `controllerId`、退役 `wxarc_admin_sessions`、主人多模态旁路预处理、`VaultProvider('wechat'/'nas')`、`TargetDirectoryProvider`、统一 Hub 鉴权、`nasArchiveUrl` 无硬编码默认 IP、SwiftCUA 发送与双模式桥接）（`packages/dsh-connector-wxarc`）→ 更新 `02`、`03`、`04`、`05`
- 改动聚合清单或端到端集成测试（`packages/dsh-hub-bundle`）→ 更新 `03` 与根目录 `README.md`
