# dsh-watcher

面向 DSH 的纯 TypeScript 多通道协作插件套件（基于 Node 24 内置能力，零第三方运行时依赖），提供 **6 个独立运行时插件 + 1 个聚合组合包**，帮你统一看管 GitHub 仓库、微信消息、待惦记便签、分身性格与隐私安全边界。

## 快速入口

- **人类说明书（大白话，看懂怎么用）**：[`docs/README.md`](./docs/README.md)
- **开发与 AI 规范（代码铁律、文档门禁与架构边界）**：[`AGENTS.md`](./AGENTS.md)
- **安装部署与 Mac mini 一键更新**：[`docs/08-安装部署与日常维护.md`](./docs/08-安装部署与日常维护.md)

## 模块一览

| 包名 | 侧边栏面板 | 一句话职责 | 技术契约 |
|---|---|---|---|
| `@local/dsh-persona` | 性格衣柜 | 管理分身人设、说话风格、圈层标签与多模态记忆 | [AGENTS.md](./packages/dsh-persona/AGENTS.md) |
| `@local/dsh-hub` | Hub 总控台 | 纯确定性事件总线（0 大模型调用）、统一资料库与草稿箱门禁 | [AGENTS.md](./packages/dsh-hub/AGENTS.md) |
| `@local/dsh-router` | Router | 智能分诊大脑、作息注意力通知、主人私聊协作与高危确认码 | [AGENTS.md](./packages/dsh-router/AGENTS.md) |
| `@local/dsh-connector-github` | GitHub | 双向 GitHub 仓库轮询、Issue/PR 合住与外发评论审查 | [AGENTS.md](./packages/dsh-connector-github/AGENTS.md) |
| `@local/dsh-trigger-memo` | *(并入总控台)* | 定时轻提醒、追新闻后续与长期蹲守 3 模式主动便签 | [AGENTS.md](./packages/dsh-trigger-memo/AGENTS.md) |
| `@local/dsh-connector-wxarc` | 微信消息 | 可选 macOS 本地微信连接器：轮询、多模态转写与串行安全发送 | [AGENTS.md](./packages/dsh-connector-wxarc/AGENTS.md) |
| `@local/dsh-hub-bundle` | *(聚合组合包)* | 按依赖顺序一键装齐 6 个运行时插件，并承载跨包端到端测试 | [AGENTS.md](./packages/dsh-hub-bundle/AGENTS.md) |

## 设计亮点

- **按需组合**：除 `@local/dsh-connector-wxarc` 仅支持 macOS 外，其余 5 个插件可在任意 Node 24 的 macOS 或 Linux 宿主机独立组合运行。
- **双层文档**：日常用法全部用大白话写在 [`docs/`](./docs/README.md)；代码接口、数据表与阈值契约统一沉淀在各包 `AGENTS.md`。
- **机械门禁**：零注释校验与大白话文档门禁均纳入常规验证流程，防止代码与文档腐化。

## 常用命令

```bash
pnpm install
pnpm run check:comments
pnpm run check:docs
pnpm run build
pnpm test
```

## 远程部署到 Mac mini

复制模板文件填写目标主机后，可一键完成全量校验、打包、上传与重启探活（支持 `--dry-run` 演练）：

```bash
cp .env.deploy.example .env.deploy
pnpm run deploy:macmini
```
