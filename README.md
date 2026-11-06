# ai-gateway

按 issue 触发、只读校验、模型分析、确定性写回的公开执行网关。

## 托管仓库

| 仓库 | 状态 | 分析身份 | 代码来源 |
|---|---|---|---|
| `GregTech6CE/GregTech6` | 启用 | `gt6ce-bot[bot]` | `GregTech6CE/GregTech6` |

仓库白名单与每仓库参数由 `config/repos.json` 决定；未列出的仓库一律跳过。

## 分析流程

1. 调用方以 `workflow_dispatch` 提交 issue 仓库、编号与事件类型。
2. `gate`：只读校验仓库配置、issue 状态、触发者权限、幂等标记与配额，通过后生成快照。
3. `analysis`：按 issue 报告的版本检出代码、预取附件，再做相关性分类，然后由固定版本
   的 Codex CLI 在 supervisor 下产出结构化结论。
4. `finalize`：确定性渲染、凭据扫描，写回占位评论与标签，并更新模型健康状态。

`finalize` 在 `analysis` 失败、超时或取消时仍会运行，负责回写失败结论。agent 步骤
不持有写权限与 App 凭据。

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
