# dsh-watcher 文档目录（唯一权威文档）

> 本目录（`dsh-watcher/docs/`）是整个代码库的**唯一权威文档**。
> 凡是涉及架构、消息流转、配置默认值、工具接口、安全门禁或外发行为的代码改动，**必须在同一次改动中同步更新本目录对应文档**。

## 文档索引

| 编号 | 文档 | 核心内容 |
|---|---|---|
| 01 | [01-整体框架图.md](./01-整体框架图.md) | 整体结构：独立性格衣柜（`dsh-persona`）、纯确定性 Hub 总控台（`dsh-hub`，0 LLM）、Layer-3 Super-agent 大脑（`dsh-router`）、独立 GitHub / 微信双向连接器、待惦记便签与 DSH 房间 |
| 02 | [02-消息流转全过程.md](./02-消息流转全过程.md) | 4 条日常消息路线 + Router 冷启动 4 级分诊、作息与单焦点微信双向协作、Worker 实物/截图回报与 `thread_subscriptions` 快车道直达的完整走法 |
| 03 | [03-怎么拆分与落地步骤.md](./03-怎么拆分与落地步骤.md) | 6 个运行时插件 + 1 个聚合包的真实目录结构、独立「Router」「性格衣柜」「GitHub」面板、无损迁移、`dsh-connector-wxarc` 双模式连接与常用命令 |
| 04 | [04-以后再加的安全门禁.md](./04-以后再加的安全门禁.md) | 门口小保安 `DoorGuard` 当前预留的两个默认放行钩子（`beforeEnterRoom` / `beforeSendOut`）与后续加装方式 |
| 05 | [05-消息怎么真正发出去.md](./05-消息怎么真正发出去.md) | 微信 GUI 外发（含文字+截图串行发送、双模式桥接与 `controllerId` 透出）与 GitHub API 外发（独立「GitHub」面板、原生 GitHub App 机器人、默认草稿箱与按 Owner/仓库开启自动直发、防回环与不重发） |

## 常用验证命令

```bash
pnpm install
pnpm run build
pnpm test
pnpm run check:comments
```

## 同步更新清单

修改代码时，按影响范围更新对应文档：

- 改动独立性格衣柜、风格提炼、24/16 偏好记忆、`foundation` 2-gram 检索或无损迁移（`packages/dsh-persona`）→ 更新 `01`、`03`
- 改动纯确定性事件总线、状态表、`thread_subscriptions` / `onUnclaimedEvent` / 管理员微信分发总线、房间会话或 Hub 4 标签页 UI（`packages/dsh-hub`）→ 更新 `01`、`02`、`03`
- 改动 Layer-3 Super-agent 路由器、4 级分诊与硬护栏、作息与注意力策略、单焦点管理员微信双向协作、Worker 派发/`router_report_result`（含截图与草稿回传）、效果统计或 Router 4 标签页 UI（`packages/dsh-router`）→ 更新 `01`、`02`、`03`
- 改动 `DoorGuard` 或安全拦截逻辑（`packages/dsh-hub/src/guard.ts`）→ 更新 `04`
- 改动 GitHub 轮询、原始事件流、图谱、合并预检、性格卡绑定、原生 GitHub App 认证或独立「GitHub」面板（`packages/dsh-connector-github`）→ 更新 `02`、`03`、`05`
- 改动待惦记便签调度、检索或房间工具（`packages/dsh-trigger-memo`）→ 更新 `01`、`02`、`03`
- 改动双向微信连接器、SwiftCUA 文字/截图发送、双模式桥接（含 `controllerId` 透出与管理员私聊分发）、气氛检查或外发管子（`packages/dsh-connector-wxarc`）→ 更新 `03`、`05`
- 改动聚合清单或端到端集成测试（`packages/dsh-hub-bundle`）→ 更新 `03` 与根目录 `README.md`
