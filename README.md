# lily-chan-bot

集中式 issue 分析 bot 的执行仓库：workflow、脚本、提示词、schema 与多租户配置。

- 设计与威胁模型存放在私有 oversight 仓库 `Tanimodori/bots`。
- **本仓库不存放任何密钥**；所有凭据均由仓库 owner 在 GitHub 设置中配置。
- 本仓库是公开仓库，因此 Actions 日志、运行输入与 artifact 都是公开的；不得打印或上传未脱敏的原始日志包。

## 流水线

```
A（issue 仓库） --workflow_dispatch--> B
                                     |
                        gate：L0 + L1 + 占位评论 + 快照
                                     |
              analysis（environment: llm，阶段一需人工审批）
                  下载附件 -> Codex -> answer.md / answer.json
                                     |
                  write-back：确定性渲染 + 密钥扫描 + 回写评论
```

- **gate**：校验租户、issue、触发者、幂等与配额；运行便宜的 L1 分类器；发占位评论或固定拒绝文案。
- **analysis**：只在审批通过后运行；由脚本下载并解压附件（不交给 agent）；Codex 在 60 分钟 supervisor 下运行，只写本地文件。
- **write-back**：无 LLM；确定性渲染结构化结果，扫描凭据，回写评论并加白名单标签。

## 阶段

| 阶段 | 触发 | LLM | 审批 |
|---|---|---|---|
| L0 | gate | 无 | 无 |
| L1 | gate | 便宜模型 | 无 |
| L2 | analysis | Codex + 主模型 | 阶段一：`environment: llm` |
| L3 | write-back | 无（确定性渲染） | 无 |

## 仓库配置

Secrets：

| 名称 | 使用方 | 用途 |
|---|---|---|
| `LILY_APP_PRIVATE_KEY` | gate、write-back | 个人 App（阶段一） |
| `GT6CE_APP_PRIVATE_KEY` | gate、write-back | 组织 App（阶段二） |
| `MODEL_KEY_MISTRAL` | gate、analysis | 共享模型池 key（所有 tenant 共用） |

Variables：

| 名称 | 示例 | 用途 |
|---|---|---|
| `LILY_APP_CLIENT_ID` | `Iv1.xxx` | 个人 App client id |
| `GT6CE_APP_CLIENT_ID` | `Iv1.yyy` | 组织 App client id |
| `MODEL_HEALTH` | `{}` | endpoint 健康状态 JSON（repo variable，不是 secret） |
| `BOT_ENABLED` | `true` | 全局开关 |

Environment `llm`：阶段一 Required reviewers = owner；阶段二移除审批。
environment 只负责暂停 analysis job；LLM key 仍然是 repo secret。

## 模型池

- `config/models.json` 分两层：`endpoints` 是健康单位（provider + base_url + key + model），
  `roles` 只是绑定（preflight/analysis 选择 endpoint、context、effort、priority）。
- endpoint 被 401/429 打挂时，所有绑定它的 role 都不可用；role 本身不单独记状态。
- 健康状态存在 B 的 repo variable `MODEL_HEALTH`；gate 读取并更新，write-back 合并。
- 重置：`gh variable set MODEL_HEALTH --repo Tanimodori/lily-chan-bot --body '{}'`。

## 配置约定

- `config/*.json` 只放数据：仓库名、模型 id、变量名、角色绑定；不放设计说明、警告或准则。
- 设计准则写在 README、`docs/OPERATIONS.md` 与根目录 `AGENTS.md`。
- `config/budgets.json` 的 `l1` / `l2` 是流水线阶段预算；模型池角色键是 `preflight` / `analysis`。

## 本地配置

`config/tenants.json` 已提交，**不含密钥**（只有仓库名、模型 id 和 secret/env 的**名称**）。
`config/tenants.example.json` 是模板。配置缺失或租户未知时 fail-closed，直接退出。

## 手动运行

```bash
gh workflow run orchestrator.yml \
  --repo Tanimodori/lily-chan-bot \
  -f tenant=gt6ce-fork \
  -f repo=Tanimodori/GregTech6 \
  -f issue=123 \
  -f event=issues
```

- 加 `-f dry_run=true`：跑 gate 与 analysis、上传 artifact，但不发任何评论，用于阶段一验收。
- `rerun.yml` 仅管理员可触发，接受自由 prompt，不经过 L0/L1，A 侧无法调用。
- A 侧触发文件位于 `templates/trigger.yml`；复制到 A 的 `.github/workflows/lily-trigger.yml`。

## 安全不变量

1. agent 步骤不会继承 App 私钥；签发 token 的步骤是 step-scoped，agent 只拿到只读 installation token。
2. agent 没有 `issues: write`，不能发评论。
3. 附件由确定性脚本下载，不由 agent 下载。
4. 回写前会用该租户的 LLM key 扫描渲染结果。
5. `BOT_ENABLED=false`、租户 `enabled=false`、卸载 App 都能停止 bot。
6. `bot:stop` 仅作应急/测试用的兜底 label，不属于常规 label 设计。
7. L1 在审批前的 gate 中运行，只拒绝高置信 spam。
