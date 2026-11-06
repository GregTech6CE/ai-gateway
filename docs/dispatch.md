# 调度

调用方是 issue 所在仓库的 workflow，本仓库是被调用方。两者之间只有一次
`workflow_dispatch`，没有回调、没有共享文件系统。设计路径不做轮询：结论由本仓库的
`finalize` 直接写回；`scripts/control.py` 的 `finish` 子命令保留轮询能力，但它是兼容
路径，见文末。

## 参数契约

`orchestrator.yml` 的 inputs 全部是字符串，除 `repo`、`issue`、`event` 外都可省略。

| input | 用途 | 约束 |
|---|---|---|
| `repo` | issue 仓库，`config/repos.json` 的键 | 必填；大小写不敏感匹配；未知即跳过 |
| `issue` | issue 编号 | 必填；必须是编号，不是 URL 或标题 |
| `event` | `issues` 或 `issue_comment` | 必填；决定是否校验触发评论 |
| `comment_id` | 触发评论 id | `issue_comment` 时必填，`gate` 用它校验评论归属与作者 |
| `placeholder_comment_id` | 调用方创建的占位评论 id | 供 `finalize` 原地 PATCH |
| `request_id` | 调用方 run id | 用于把"本次请求"从历史标记中排除 |
| `issue_title` | 仅用于 run 名称 | 不参与判定；不得用于构造路径或命令 |
| `dry_run` | `true` 时抑制评论与标签写回 | `finalize` 仍会渲染并更新 `MODEL_HEALTH` |

约束来自 GitHub 平台，不来自本仓库的设计选择：`ref` 只接受分支或 tag 名而非提交 SHA，
本仓库固定 `master`；单次 dispatch 最多 10 个 input；**inputs 是公开的**，因为本仓库
公开且 run 页面可读。

推论：任何需要保密的内容都不能走 inputs。issue 正文、评论与附件由 `analysis` 通过
公开 API 自行读取，不通过 dispatch 传递。

## 职责划分

| 动作 | 执行方 | 说明 |
|---|---|---|
| 创建占位评论 | 调用方 | 在 dispatch 之前，回传 `placeholder_comment_id` |
| 校验与快照 | 本仓库 `gate` | 只读；不写 issue |
| 分析 | 本仓库 `analysis` | 产出 artifact |
| 渲染、扫描、写回 | 本仓库 `finalize` | 唯一写 issue 的位置 |

占位评论由调用方创建的原因：写权限只存在于调用方与本仓库 `finalize` 两处，而
`finalize` 需要一条已存在的评论作为 PATCH 目标。占位评论同时承载 `requested` 标记，
使 `gate` 能在并发窗口内识别在途请求。

`request_id` 解决的是同一个 issue 被重复触发时"把自己刚产生的标记误判为历史标记"的
问题：与当前 `request_id` 相同的标记不计入幂等与配额判断。

## run 语义

- run 名称是 `<repo>#<issue> · <title>`，因此在 Actions 列表里可以直接区分来源。
- 并发组按 `repo` 与 `issue` 划分，`cancel-in-progress: false`：同一 issue 的请求串行，
  不互相取消，避免半途终止留下无法回写的状态。
- `dry_run` 抑制评论与标签写回，`gate`、`analysis` 与渲染照常执行，产物照常上传，用于
  评估改动。它不抑制 `MODEL_HEALTH` 的写回：该步骤无条件运行。关闭全局开关也不会跳过
  `finalize`，已创建的占位评论仍会被清理；要避免任何运行，只能不发起 dispatch。
- `finalize` 的条件是 `always() && needs.gate.result != 'skipped'`：`analysis` 失败、超时
  或被取消都会进入 `finalize` 并回写失败结论。`gate` 判定 skip 时同样进入 `finalize`，
  但此时没有结果产物，只做占位评论清理，不发布结论。

## 失败判定

调用方拿到 2xx 但响应里没有 `workflow_run_id` 时，视为未入队：workflow 可能被禁用，
或 API 版本不返回 run 详情。此时应删除已创建的占位评论，避免留下永久"正在分析"。

`404` 表示该 ref 上没有该 workflow，或 token 无权访问本仓库；`422` 表示 inputs 缺失或
非法。`401`/`403` 与 App 私钥和 App 安装状态有关，属于凭据问题，不重试。

dispatch 成功后，调用方的职责在写回层面结束：结论只能由本仓库的 `finalize` 发布。
`scripts/control.py` 保留两个未在触发模板中启用的子命令：`finish` 轮询 run、下载 artifact、
在结果缺失时写 fallback `result.json`；`cleanup` 删除占位评论。当前模板只调用 `start`，
这两个子命令是兼容路径，启用它们不会获得写回权。
