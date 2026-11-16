# bug issue 分析

一次分析由调用方仓库的触发 workflow 与本仓库的 `orchestrator` 共同完成。调用方只创建
占位评论并 dispatch；本仓库的四个 job 依次产出快照、结论与写回。参数契约见
[dispatch](../dispatch.md)，授权判定见 [auth](../auth.md)。

```
build ──> gate ──> analysis ──> finalize
             │                       ▲
             └───── (skip) ──────────┘
```

所有 job 只消费上游 artifact 里的结构化文件，不解析彼此的日志。

## `build`

### 启用条件

每次 `orchestrator` 运行都执行，无额外判定。

### 权限边界

- **文件访问**：读整个检出目录；写 `common/temp/`（Rush 的依赖与链接）与各包的 `dist/`。
- **容器权限**：`ubuntu-latest`，`timeout-minutes: 15`，无提权、无沙箱特例。
- **网络访问**：npm registry（首次安装依赖）。不接触 issue 内容与模型端点。
- **Token 权限**：`contents: read`。

### 执行流程

1. 检出本仓库，安装 Node 22。
2. `rush install` 按 `pnpm-lock.yaml` 安装依赖。
3. `rush build --to @gt6ce/ci`，产出 `apps/ci/dist`（内联 `@gt6ce/*`、AI SDK 与 zod）。
4. 上传 `ci-<run_id>` artifact。

### 最终产出

`ci-<run_id>` artifact，内容是 `apps/ci/dist`。下游三个 job 只下载它，不再安装任何 npm 包。
多入口构建共享 chunk，因此必须整目录上传/下载，不能只取单个 `jobs/*.js`。

## `gate`

### 启用条件

`needs: build`。无论后续判定如何都会运行完毕，并总是写出 `inputs/verdict.json`。

判定顺序（命中即停）：

1. 配置可读、仓库已登记、`repo.enabled` 为真、`BOT_ENABLED` 不为 `false`、事件为
   `issues` 或 `issue_comment`；
2. 可见性：公开的执行仓库不处理私有 issue 仓库；
3. issue 形态：不是 PR、状态为 `open`、命中 `triage.process_only` 的标签组；
4. `issue_comment` 事件：评论属于本 issue、作者不是 bot、正文包含 `bot_mention`、
   作者协会是 `OWNER`/`MEMBER`/`COLLABORATOR`；通过后视为主动强制；
5. `bot:stop` 标签：被动触发跳过，`force` 时记录警告后放行；
6. `bot:v1:` 标记与 7 天超期：由 `shouldSkipPassiveTrigger` 一次判定，`force` 直接放行；
7. 解析版本 ref。

### 权限边界

- **文件访问**：读 `config/`；写 `inputs/`。
- **容器权限**：`ubuntu-latest`，`timeout-minutes: 15`，无提权。
- **网络访问**：`api.github.com`；`git ls-remote` 访问 `github.com` 取 tag 列表。
- **Token 权限**：没有 App token。本仓库用 `github.token`（`contents: read`、
  `actions: read`）；issue 仓库的读取默认走匿名请求，`GH_RO_TOKEN` 存在时使用它。
  不持有 `MODEL_KEY_*`。

### 执行流程

1. 加载 `config/repos.json`、`config/models.json`、`config/budgets.json`，非法即跳过。
2. 读取 `MODEL_HEALTH` 变量，规范化后写入 `inputs/model_health.json`。
3. 校验可见性、issue 形态与触发者权限（见上）。
4. 取 issue 评论（最多 5 页），只保留 bot 自己发的评论作为标记来源。
5. `shouldSkipPassiveTrigger`：`force` → 放行；`stop`/`done` → 跳过；`pending` 未超过
   `requested_stale_minutes` → 跳过；`failed` 不阻断；issue 超过 `max_issue_age_days` → 跳过。
6. `versionBase` 解析 issue 表单里的版本号，`git ls-remote --tags` 取远端 tag，
   按 `tag_template` 解析出 `version_tag`；ref 列表为 `fallback_ref` + 版本 tag +
   `extra_code_refs`。
7. 写快照、issue 正文与候选入口。

### 最终产出

| 文件 | 内容 |
|---|---|
| `inputs/snapshot.json` | issue、评论、附件 URL、版本字段、ref 列表、golden 信息 |
| `inputs/verdict.json` | `decision` 与 `reason`；分析失败时 `finalize` 据此判断是否清理占位评论 |
| `inputs/model.json` | 池名与按健康度排序的候选入口 |
| `inputs/model_health.json` | 本轮开始时的健康状态 |
| `inputs/issue.md` | 标题与正文，便于人工复核 |

`$GITHUB_OUTPUT`：`decision`、`reason`、`code_repo`、`code_ref`、`code_refs`、
`golden_repo`、`golden_commit`、`cache_prefix`、`issue_title`。

## `analysis`

### 启用条件

`needs: [build, gate]`，且 `gate.decision == 'proceed'`。跳过时 `finalize` 仍会运行。

### 权限边界

- **文件访问**：读 `inputs/`、`code/`；写 `outputs/`；`git clone/fetch` 写 `.cache/`；
  `download-artifact` 写 `apps/ci/dist` 与 `inputs/`；`cache/save` 写两个 mirror 目录。
  不写 issue 仓库。
- **容器权限**：`ubuntu-latest`，`timeout-minutes: 75`，无人工审批、无沙箱；隔离由 job
  边界（无写 token、无 App 私钥）、工具路径限制、Zero-Secret bash 与出网白名单共同保证。
- **网络访问**：`deploy/egress-allowlist.txt` 列出的端点，由 harden-runner 的
  `egress-policy: block` 强制执行；改一处必须同步另一处。
- **Token 权限**：只注入 `MODEL_KEY_*`。没有 `GITHUB_TOKEN`、没有 `GH_TOKEN`、没有 App
  凭据；clone 与附件下载都是匿名公开访问。

### 执行流程

1. `harden-runner` 打开出网白名单。
2. 下载 `ci-<run_id>` 与 `gate-<run_id>`，恢复两个 mirror 缓存。
3. 同步 mirror 并创建 worktree：`code/current` 指向主 ref，`code/<slug>` 为其余 ref，
   `code/golden` 为上游固定提交；任一 ref 不可用只跳过该目录。
4. `node dist/jobs/manifest.js`：清点文件，写 `inputs/code_manifest.json`。
5. `node dist/jobs/prefetch.js`：下载并解压 issue 附件，写 `inputs/logs/` 与
   `outputs/log_digest.md`。单个附件失败只记一行说明，不中断其余附件。
6. `node dist/jobs/analysis.js`：
   1. 读 `inputs/model.json` 的候选顺序；缺 key 的入口记 `auth` 失败后跳过。
   2. **preflight**：用一次轻量相关性分类判定入口可用；传输层错误计入健康度并换下一个，
      分类结果不可解析只表示"这次没结论"，不判入口故障。
   3. **拒绝判定**：命中 `reject.only` 且置信度不低于 `reject.min_confidence` 时，
      以 `rejected` 收尾，不再进入代码分析。
   4. **代码分析**：`@gt6ce/agent` 以只读工具（`list_files`/`read_file`/`grep_search`）与
      受控 `run_bash` 读取工作区，最终用 `Output.object({ schema: AnswerSchema })`
      产出结构化结论。`auth`/`config` 错误换下一个入口；`429`/`5xx`/网络错误按
      `model_pool` 配置退避重试，逼近截止时间时直接失败。
   5. **扫描**：递归扫描 `outputs/`，命中的文件就地脱敏；`result.json` 序列化后单独扫描。
   6. **闸门**：任一文件扫描失败时 `scan_upload=false`，只上传 `result.json`。

### 最终产出

| 文件 | 内容 |
|---|---|
| `outputs/answer.json` | `AnswerSchema` 结构化结论（仅 `complete`） |
| `outputs/relevance.json` | 相关性分类（有结论时） |
| `outputs/result.json` | 状态、原因、步数、token 用量、`secret_scan` |
| `outputs/model_health.json` | 本轮更新后的 endpoint 健康状态 |
| `outputs/log_digest.md` | 脱敏后的日志摘要 |

外层 artifact 为 `analysis-<run_id>`（正常）或 `analysis-<run_id>-report`（扫描失败）。

## `finalize`

### 启用条件

`if: always() && needs.gate.result != 'skipped'`。分析失败、超时或取消都进入这里；
`gate` 跳过的 run 也进入，用于清理占位评论。

### 权限边界

- **文件访问**：读检出目录、三个 artifact；写 `outputs/`（`comment.md`、`triage.json`）。
- **容器权限**：`ubuntu-latest`，`timeout-minutes: 15`，不运行 agent。
- **网络访问**：`api.github.com`。
- **Token 权限**：`environment: writer` 提供 `GT6CE_APP_PRIVATE_KEY`；`app_issue` token 只
  授予 issue 仓库的 `issues: write`；`app_health` token 因签发 action 不支持变量权限，
  持有 App 的完整权限集，仅用于写 `MODEL_HEALTH`。

### 执行流程

1. 下载 dist、gate inputs、analysis outputs 与 scan report（缺失时继续）。
2. `render`：gate 跳过则不出评论；`rejected` 用 `reject.md`；`complete`/`partial` 用
   `comment.md` 模板；失败或结论非法时渲染失败评论。尾部写 `bot:v1:done` 或
   `bot:v1:failed`。
3. 占位评论清理：仅当 verdict 判定为跳过且没有 `result.json` 时删除占位评论。
4. `write-back`：`DRY_RUN` 直接返回；`bot:stop`、issue 已关闭、`secret_scan.ok === false`
   都只发一条说明；否则 `scanText` 强制扫描后 PATCH 占位评论（404/410 回退新建），
   再按六轴门禁增删标签。
5. `update-health`：`PATCH` 变量，404 时回退 `POST`。

### 最终产出

issue 评论、标签，以及仓库变量 `MODEL_HEALTH`。评论与标签都经过确定性模板与门禁，
不直接把模型文本当指令。

## 状态与中止

| 开关 | 范围 | 生效点 |
|---|---|---|
| `repo.enabled: false` | 单个仓库 | `gate` 跳过；`write-back` 不发布 |
| 变量 `BOT_ENABLED=false` | 所有仓库 | `gate`、`control.precheck`、`write-back` |
| `bot:stop` 标签 | 单个 issue | `gate` 被动跳过；`write-back` 只发停止说明 |
| issue 已关闭 | 单个 issue | `gate` 跳过；`write-back` 只发停止说明 |
| `bot:v1:stop` / `done` | 单个 issue | 被动跳过；`force` 放行 |
| `bot:v1:pending` 未过期 | 单个 issue | 被动跳过；超过 `requested_stale_minutes` 放行 |
| issue 超过 `max_issue_age_days` | 单个 issue | 被动跳过；`force` 放行 |
| `bot:v1:failed` | 单个 issue | 不阻断重试 |

失败语义：`analysis` 以 `failed` 收尾时仍会产出 `result.json` 与 `model_health.json`，
`finalize` 据此回写失败评论；失败评论带 `bot:v1:failed`，不会阻止下一次被动触发。

## 不可改动的性质

1. `gate` 只读：不写 issue、不发评论、不调用模型。
2. `finalize` 不运行 agent，不把 issue 正文当指令。
3. `force` 只由维护者的显式操作产生（手动触发或 `@bot` 评论）。
4. `run_bash` 的 `env` 每次重建，只保留 `PATH`/`LANG`/`HOME`/`HTTP(S)_PROXY`。
5. 只读工具拒绝工作区外的路径，包括符号链接逃逸。
6. `analysis` 的出网白名单与 `deploy/egress-allowlist.txt` 同步。
7. 写回前必须扫描；扫描失败关闭 artifact 闸门并阻断发布。
