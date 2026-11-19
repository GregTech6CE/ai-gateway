# ai-gateway

按 issue 触发、只读校验、模型分析、确定性写回的公开执行网关。

## 托管仓库

| 仓库 | 状态 | 分析身份 | 代码来源 |
|---|---|---|---|
| `GregTech6CE/GregTech6` | 启用 | `gt6ce-bot[bot]` | `GregTech6CE/GregTech6` |

仓库白名单与每仓库参数由 `config/repos.json` 决定；未列出的仓库一律跳过。

## 分析流程

1. 调用方以 `workflow_dispatch` 提交 issue 仓库、编号与事件类型。
2. `build`：优先拉取 `snapshot` Release 中已校验的 `gt6-ci` 包，未命中才安装依赖现场
   构建；后续 job 只下载这一份 artifact。
3. `gate`：只读校验仓库配置、issue 状态、触发者权限、`bot:v1:` 标记与 7 天超期，通过后
   生成快照；显式 `force` 无视标记与时间窗口。
4. `analysis`：按 issue 报告的版本检出代码、预取附件，再做相关性分类，然后由
   `@gt6ce/agent`（Vercel AI SDK + 只读工具 + 受控 bash）产出结构化结论。
5. `finalize`：确定性渲染、凭据扫描，写回占位评论与标签，并更新模型健康状态。

`finalize` 在 `analysis` 失败、超时或取消时仍会运行，负责回写失败结论。agent 步骤
不持有写权限与 App 凭据；`run_bash` 只保留 `PATH`/`LANG`/`HOME`/`HTTP(S)_PROXY`，
模型 key 不会进入子进程。

## QQ 机器人

`apps/qqbot` 是常驻进程，负责官方 WebSocket 接入、命令路由与建单。它只持有 QQ 凭据与
两个 RPC token，**不含** LLM key 与 GitHub App 凭据：

| 命令 | 行为 | 权限 |
|---|---|---|
| `/help` | 列出本会话启用的命令与示例 | 绑定会话即可 |
| `/issue <标题>` | 收集版本/复现/期望，交 `agent-svc` 整理草稿，再由 `github-writer` 建 Issue | `maintainers` |

`/issue` 缺字段时一次只问一个，引用机器人的提问回复即可补充；信息齐备后先回「已受理」，
建单完成再把编号与链接发回群里。群绑定、维护者名单与 `bot:stop` 附加策略见
[docs/qqbot.md](docs/qqbot.md)。

启动：`QQBOT_CONFIG=/path/to/config.json node apps/qqbot/dist/main.js`。

## 内部服务与部署

QQ 侧不直接接触模型与 GitHub：它调用两个内部 REST 服务，各自持有单一域凭据。

| 服务 | 端点 | 持有 | 不持有 |
|---|---|---|---|
| `agent-svc` | `POST /tasks`、`GET /tasks/:id` | `MODEL_KEY_*` | GitHub 凭据 |
| `github-writer` | `POST /issues` | GitHub token 或 App 私钥 | 模型 key |

两个服务都用 Node 22 原生 `node:http`，不外引 Web 框架；鉴权统一
`Authorization: Bearer`，`/healthz` 免鉴权。Docker 侧四个容器（含 Tinyproxy 出网代理）
的网络隔离、凭据矩阵与运维步骤见 [docs/deploy.md](docs/deploy.md)。

## 密钥

本仓库不含任何凭据。凭据只以 environment secret 与 repo variable 形式存在：

- `llm` environment：`MODEL_KEY_MISTRAL`、`MODEL_KEY_CLINEPASS`
- `writer` environment：`GT6CE_APP_PRIVATE_KEY`
- repo variable：`GT6CE_APP_CLIENT_ID`、`BOT_ENABLED`、`MODEL_HEALTH`

**禁止向本仓库提交任何密钥、令牌或私钥**，包括文档、配置、测试数据与提交历史。
本仓库是公开的，运行日志、输入与 artifact 同样公开。

## 文档

- [AGENTS.md](AGENTS.md)：改动本仓库的约束与安全规则
- [docs/AGENTS.md](docs/AGENTS.md)：文档编写要求
- [docs/README.md](docs/README.md)：文档索引
- [docs/auth.md](docs/auth.md)：授权边界
- [docs/dispatch.md](docs/dispatch.md)：调度契约
- [docs/jobs/bug-issue-analysis.md](docs/jobs/bug-issue-analysis.md)：bug issue 分析 job
- [docs/qqbot.md](docs/qqbot.md)：QQ 机器人的凭据边界、命令与绑定配置
- [docs/deploy.md](docs/deploy.md)：四容器隔离部署、出网白名单与运维
- [docs/release.md](docs/release.md)：发布资产结构、`snapshot` 滚动发布与校验
