# ai-gateway

按 issue 触发、只读校验、模型分析、确定性写回的公开执行网关。

## 托管仓库

| 仓库 | 状态 | 分析身份 | 代码来源 |
|---|---|---|---|
| `GregTech6CE/GregTech6` | 启用 | `gt6ce-bot[bot]` | `GregTech6CE/GregTech6` |

仓库白名单与每仓库参数由 `config/repos.json` 决定；未列出的仓库一律跳过。

## 分析流程

执行器不在本仓库的 Actions 内运行。本仓只负责打包与发布，一次分析由两处组成：

1. 业务仓的触发薄壳（`GregTech6CE/GregTech6` 的 `.github/workflows/ai-issue-trigger.yml`）
   监听 issue 与评论事件，做防刷过滤后调用组织级执行层。
2. 组织仓 `GregTech6CE/.github` 的 `ai-issue-runner.yml` 以 `workflow_call` 执行三个 job：
   - `gate`：检出本仓库的 `config/`、`prompts/`、`templates/`，从 `snapshot` Release
     下载 `gt6-ci-*` 包并校验 `SHASUMS256.txt`；然后只读校验仓库配置、issue 状态、
     触发者权限、`bot:v1:` 标记与 7 天超期，通过后生成快照；显式 `force` 无视标记与
     时间窗口。产物供下游复用，不编译。
   - `analysis`：按 issue 报告的版本检出代码、预取附件，再做相关性分类，然后通过
     `@gt6ce/agent` 提供的统一 5 只读工具基线（`list_files`、`grep_search`、`read_file`、
     `git_log`、`git_diff`）产出结构化结论。
   - `finalize`：确定性渲染、凭据扫描，以 `gt6ce-bot[bot]` 身份新建评论与标签，并更新
     模型健康状态。

`finalize` 在 `analysis` 失败、超时或取消时仍会运行，负责回写失败结论。分析步骤
不持有写权限与 App 凭据；只读工具派生的外部子进程仅保留 `PATH` 与 `GIT_TERMINAL_PROMPT=0`，
模型 key 不会进入子进程。

本仓库的流水线只保留 `release-snapshot.yml`：`master` 每次构建把 4 个应用打成
`.tgz` 并滚动覆盖 `snapshot` Release，供执行层下载。

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

本仓库不含任何凭据。执行层运行时由业务仓以 `secrets: inherit` 传入，且只在对应步骤的
`env:` 里出现：

- secret：`MODEL_KEY_MISTRAL`、`MODEL_KEY_CLINEPASS`，只进入 `analysis.js` 步骤
- secret：`GT6CE_APP_PRIVATE_KEY`，只进入 `finalize` 的 App 签发步骤
- variable：`GT6CE_APP_CLIENT_ID`、`BOT_ENABLED`、`MODEL_HEALTH`，由 `gate` 与
  `finalize` 读取

**禁止向本仓库提交任何密钥、令牌或私钥**，包括文档、配置、测试数据与提交历史。
本仓库是公开的；运行发生在业务仓自己的 Actions 内，日志、输入与 artifact 的可见性
跟随业务仓。

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
