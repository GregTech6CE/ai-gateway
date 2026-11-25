# 调度

业务仓的触发薄壳通过一次 `workflow_call` 调用组织仓的执行层，全部 job 在同一次 run 内
完成；本仓库只负责发布执行器包。触发与执行之间没有跨仓 dispatch、没有回调、没有共享
文件系统。

## 调用链

| 层 | 位置 | 职责 |
|---|---|---|
| 触发层 | 业务仓的 `.github/workflows/ai-issue-trigger.yml` | 监听事件、防刷过滤、透传参数 |
| 执行层 | `GregTech6CE/.github` 的 `ai-issue-runner.yml` | `gate`、`analysis`、`finalize` |
| 执行器 | 本仓库的 `snapshot` Release | `gt6-ci-*.tgz` 与 `SHASUMS256.txt` |

触发层决定"谁可以唤起分析"，执行层决定"能做什么、能写什么"。两者的权限都写在各自的
workflow 文件里，不通过参数传递。

## 参数契约

执行层的 inputs 全部是字符串：

| input | 用途 | 约束 |
|---|---|---|
| `issue` | issue 编号 | 必填；必须是编号，不是 URL 或标题 |
| `event` | `issues` 或 `issue_comment` | 必填；决定是否校验触发评论 |
| `comment_id` | 触发评论 id | `issue_comment` 时必填，`gate` 用它校验评论归属与作者 |
| `dry_run` | `true` 时抑制评论与标签写回 | `finalize` 仍渲染并更新 `MODEL_HEALTH` |
| `force` | 主动强制 | `true` 时 `gate` 无视 `bot:v1:` 标记与 7 天窗口；仅由维护者的显式操作置位 |
| `gateway_ref` | 执行器仓库的 ref | 默认 `master`；不解析为路径或命令 |

执行层不再接受 `repo` 参数：`github.repository` 就是 issue 所在仓库，`github.run_id`
就是本次请求标识。仓库键仍以 `config/repos.json` 为准，未登记的仓库在 `gate` 跳过。

`force_rebuild` 不存在：执行层只消费 `snapshot` 资产，不从源码现场构建。需要更新执行器
时先让本仓库的发布流水线完成打包。

约束来自 GitHub 平台：单次 `workflow_call` 最多 10 个 input，**inputs 与 run 页面公开
可读**。任何需要保密的内容都不能走 inputs；issue 正文、评论与附件由 `analysis` 通过
公开 API 自行读取。

## 职责划分

| 动作 | 执行方 | 说明 |
|---|---|---|
| 事件过滤与防刷 | 触发层 | 全局开关、Bot 作者、维护者 `@bot` 评论 |
| 执行器包下载与校验 | 执行层 `gate` | 只读；不编译 |
| 校验与快照 | 执行层 `gate` | 只读；不写 issue |
| 分析 | 执行层 `analysis` | 产出 artifact；无写凭据 |
| 渲染、扫描、写回 | 执行层 `finalize` | 唯一写 issue 的位置 |

触发层不创建占位评论，也不轮询结果：结论由 `finalize` 直接以新评论发布。写权限因此只
存在于 `finalize` 的 App token 与触发层的 job 权限上，两者都不接触模型 key。

## run 语义

- 并发组是 `ai-issue-<repo>-<issue>`，`cancel-in-progress: false`：同一 issue 的请求
  串行，不互相取消，避免半途终止留下无法回写的状态。
- `dry_run` 抑制评论与标签写回，`gate`、`analysis` 与渲染照常执行，产物照常上传。
  它不抑制 `MODEL_HEALTH` 的写回：该步骤无条件运行。`dry_run` 时也不签发 issue 写权限的
  App token（`app_health` 仍签发，只用于写 `MODEL_HEALTH`）。
- `finalize` 的条件是 `always() && needs.gate.result != 'skipped'`：`analysis` 失败、
  超时或被取消都会进入 `finalize` 并回写失败结论。`gate` 判定 skip 时也进入，但
  `render` 不产出评论，写回随之跳过，issue 上不会留下任何写入。`gate` 失败时 run 已经
  失败，但 `finalize` 仍会运行：`gate-bundle` 带执行器且没有 skip 判定时，`render`
  渲染失败评论，非 `dry_run` 时写回；否则不产生写入。
- 写回失败不改变 run 的结论：`render`、`write-back` 与 `update-health` 都是
  `continue-on-error: true`，失败只体现在日志与 artifact 里。

## 兼容路径

`apps/ci` 的 `control` 子命令不再参与本链路：跨仓 dispatch 的 `start` 已没有目标工作流，
`finish` 与 `cleanup` 仅作为历史脚本保留。启用它们不会获得写回权，本链路也不依赖它们。
