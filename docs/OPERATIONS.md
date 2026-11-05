# 运维手册

## 一次性配置（阶段一）

1. 在 `Tanimodori/GregTech6`（fork）的 Settings → Features 中启用 Issues。
2. 生成 `lily-chan-bot` App 私钥，存为 `LILY_APP_PRIVATE_KEY`。
3. 把 App client id 存为变量 `LILY_APP_CLIENT_ID`。
4. 创建 fine-grained PAT（仅本仓库 `Actions: write`），存为 fork 的 `LILY_DISPATCH_TOKEN`。
   这是 A 侧唯一的凭据。
5. 存 `LLM_KEY_GT6CE_FORK`；设置 `LLM_BASE_URL`。
6. 检查已提交的 `config/tenants.json`：只允许修改仓库名、模型 id 和 secret/env
   名称；**禁止填写任何值**。
7. 创建 `llm` environment，Required reviewers = owner。
8. 设置 `BOT_ENABLED=true`。
9. 在 fork 重建上游 label：`crash`、`parity`、`translation`、`needs info`、
   `needs triage`、`1.20.1`、`1.21.1`。
10. 把 `templates/trigger.yml` 复制到 fork 的 `.github/workflows/lily-trigger.yml`。
11. 在 fork 设置以下变量（都不是秘密）：
    - `LILY_TENANT=gt6ce-fork`
    - `LILY_BOT_MENTION=@lily-chan-bot`（可省略，模板有默认值）
    - `LILY_BOT_DISPATCH_URL`（可省略，模板有默认值）

## 阶段二

- 在 org 下创建私有 `gt6ce-bot` App，仅安装到 `GregTech6CE/GregTech6`。
- 配置 `GT6CE_APP_PRIVATE_KEY`、`GT6CE_APP_CLIENT_ID`、`LLM_KEY_GT6CE_ORG`。
- 在 org 仓库添加触发 workflow 与 `LILY_DISPATCH_TOKEN`。
- 将 `gt6ce-org.enabled` 设为 `true`，`gt6ce-fork.enabled` 设为 `false`。
- 需要全自动时，移除 `environment: llm` 的 Required reviewers（或整行）。

## 停止

1. 单仓库：把 `config/tenants.json` 里的 `enabled` 设为 `false`（配置缺失时 fail-closed）。
2. 全局：把变量 `BOT_ENABLED` 设为 `false`。
3. 身份层：卸载 App（org owner 可执行）。
4. 应急/测试：添加 `bot:stop` label，supervisor 每 60 秒检查一次。

## 排障

| 现象 | 检查 |
|---|---|
| issue 创建后没有 run | A 的触发 workflow、PAT 是否过期、fork 的 Actions 是否启用 |
| gate 报 `installation check failed` | App 安装范围、token 权限 |
| analysis 一直等待 | `environment: llm` 的 Required reviewers |
| 评论没有更新 | write-back job、App 的 `issues: write`、`bot:stop` |
| 评论显示 blocked | `scan_out` 命中；查看 analysis artifact |
| 超时/partial | `outputs/result.json`；partial 是预期行为 |

## 限额

- L2：60 分钟，不设回合/token 上限；context 1M。按租户 key 观察 provider 用量。
- L1：200k context，low effort；仅在置信度 ≥ 0.9 时拒绝 `spam`。
- 附件：单文件 20 MB，总 60 MB；artifact 保留 30 天。
