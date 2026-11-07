# bug issue 分析

一次分析由三个 job 串联：`gate` 决定是否分析，`analysis` 产出结论，`finalize` 决定结论
如何公开。三者通过 artifact 交接，不共享凭据，也不共享进程。

## `gate`

### 启用条件

在调用任何模型之前完成筛选，任一条件不满足即写 `verdict.json` 并跳过（是 skip，不是
failure）：

- 全局开关 `BOT_ENABLED` 不为 `false`，且 `config/repos.json` 中该仓库 `enabled` 为真；
- `event` 为 `issues` 或 `issue_comment`；
- 目标仓库可见性不高于本仓库：公开实例拒绝处理私有 issue 仓库；
- issue 存在、打开、不是 PR；
- 标签匹配 `process_only` 的任一 OR-AND 组，当前为 `[["bug"]]`；`needs triage` 只是
  分诊标签，不触发分析；
- 评论触发时，评论属于该 issue、作者协会为 `OWNER`/`MEMBER`/`COLLABORATOR`、正文提及
  该仓库的 bot，且不是 bot 自身评论；
- bot 评论中不存在 `done`/`rejected` 标记，且无在途标记；`requested`/`running` 超过
  `running_stale_minutes` 视为过期；
- 三级配额未耗尽：每 issue 每小时 1 次（统计最近 1 小时内该 issue 上带 `requested` 或
  `running` 的 bot 评论）、每仓库每天 30 次与全局每天 50 次（最近 24 小时，前者统计带
  `requested` 的 bot 评论，后者统计本仓库 orchestrator 的 run 总数）。与当前 `request_id`
  相同的标记不计入。

### 权限边界

- **文件访问**：检出会把本仓库写到工作区；脚本只写 `inputs/` 下的五个文件，而后
  `upload-artifact` 读取同一目录上传。不写 issue，不写代码仓库。
- **容器权限**：平台提供托管 runner；本仓库限定不使用 environment、不需要人工审批、超时
  15 分钟，只用预装的 `git` 与 `python3`。
- **网络访问**：`github.com`（检出本仓库）、`api.github.com`（读 issue、评论、本仓库
  元数据与自身 run 列表）、代码仓库的 `ls-remote`（探测 tag）。
- **Token 权限**：只用 job 内置 `github.token`（`contents: read`、`actions: read`）读取
  本仓库；读取 issue 与评论走匿名请求。不持有 App token，也不持有模型 key。"不能写
  issue、不能调模型"由凭据缺失保证，不靠代码自律。

### 执行流程

1. 读配置与开关：仓库白名单、`enabled`、`BOT_ENABLED`、event 类型。未列出的仓库立即跳过。
2. 可见性检查：先确认本仓库是否私有，再读目标仓库可见性；公开实例加私有 issue 仓库的
   组合直接跳过，避免公开 artifact 泄露私有内容。
3. 读 issue 并做形态校验：PR、已关闭、标签组不符都在此拦下。
4. 评论路径额外校验：评论归属、作者协会、是否提及该仓库的 bot、是否 bot 自身。
5. 幂等与配额：解析 bot 评论中的隐藏标记，按 issue / 仓库 / 全局三级计数。
6. 构建快照：issue 元数据、正文、非 bot 评论、附件 URL、`code_repo`、`code_ref`，并对
   规范化 JSON 取 SHA-256。快照哈希会写入最终评论的隐藏标记，用于事后判断结论基于
   哪份输入。
7. 解析代码 ref：从表单的模组版本字段推导，去前导 `v` 后套 `tag_template`（默认
   `v{version}`）；远端 tag 可用时取首个命中的候选，全部未命中回退 `fallback_ref`；
   远端不可用时直接取首个候选，该 ref 未经校验。
8. 写候选 endpoint 列表：按健康状态过滤，未必都带 key。

顺序有约束：可见性与形态校验必须先于快照，否则不该公开的内容会进入 artifact；配额必须
先于快照，否则超限请求仍会消耗公开 API 额度。

### 最终产出

| 产物 | 内容 | 消费者 | 保留 |
|---|---|---|---|
| `inputs/verdict.json` | `decision`、`reason`；`proceed` 时另含快照哈希、代码来源与 ref | `finalize`、人工复核 | artifact 30 天 |
| `inputs/snapshot.json` | issue 元数据、正文、非 bot 评论、附件 URL、`sha256` | `analysis`、`finalize` | artifact 30 天 |
| `inputs/issue.md` | 标题与正文的可读副本 | 人工复核 | artifact 30 天 |
| `inputs/model.json` | 候选 endpoint 与池名 | supervisor | artifact 30 天 |
| `inputs/model_health.json` | `MODEL_HEALTH` 快照 | supervisor | artifact 30 天 |
| artifact `gate-<run_id>` | 上述 `inputs/` 目录 | `analysis`、`finalize` | 30 天 |

## `analysis`

### 启用条件

- `needs: gate` 且 `gate` 输出 `decision == proceed`；其余情况 job 被 skipped，不产生
  任何产物。
- 声明 `environment: llm`。缺少该 environment 就取不到模型 key，supervisor 会以"无健康
  endpoint"失败，而不是降级到无模型的路径。
- job 内再查一次全局开关与仓库 `enabled`：排队期间被关闭时不再消耗模型调用。

### 权限边界

- **文件访问**：检出会把本仓库写到工作区；可写 `inputs/`（下载 gate artifact、写入 `logs/`
  附件）、`code/`（worktree，含 `code/current` 与 `code/golden`）、`.cache/`（两个 mirror
  缓存）、`.codex/`（CLI 配置）、`outputs/`（全部产物）。`code/` 对 agent 只读是提示词约定，
  不是文件系统强制。
- **容器权限**：平台提供托管 runner；本仓库设定 `approval_policy = never`、
  `sandbox_mode = danger-full-access`、`web_search = disabled`，job 超时 75 分钟，
  supervisor 墙钟预算 60 分钟（从相关性分类之前开始计算）。没有人工审批，也没有沙箱
  兜底——隔离来自凭据缺失，不来自运行时限制。
- **网络访问**：模型 endpoint 的 `base_url`、`api.github.com`（下载 artifact、轮询
  `bot:stop`）、`github.com`（两个 mirror 的克隆与附件下载）、npm registry（安装固定版本
  Codex CLI）、PyPI（安装固定版本的 `pyyaml` 与 `pillow`）。supervisor 还会在 `127.0.0.1`
  的临时端口启动协议桥，仅本机可访问。
- **Token 权限**：持有 `MODEL_KEY_MISTRAL` 与 `MODEL_KEY_CLINEPASS` 两个 key（切换
  endpoint 时无需重新注入），Codex 只通过 `LLM_API_KEY` 使用当前 endpoint 的一个。不持有
  App 私钥、App token 与 `issues: write`；`GITHUB_TOKEN`、`SELF_TOKEN` 被移除，`GH_TOKEN`
  置空，agent 不持有任何 GitHub token。

### 执行流程

1. 下载 `gate-<run_id>` artifact 到 `inputs/`。缺快照即失败，不重新读取 issue。
2. 还原 mirror 缓存，`fetch` 后按 ref 建 worktree，`code/current` 指向主 ref。恢复缓存前
   先清理 worktree 注册，否则路径变化后 fetch 会被拒绝。某个 ref 无效时 worktree 回退
   `master`，此时 `code_ref` 与实际检出不一致。`code/golden` 是另一个仓库：上游原版 GT6
   的固定提交，单独一份 mirror 缓存，解析不到就跳过，不影响主流程。
3. 安装固定版本的 Codex CLI，并装好 `pyyaml` 与 `pillow`：agent 会写脚本自检答案，缺少
   这些包会让它反复尝试而不是给出结论。版本固定，避免同一 issue 在不同时间得出不同结果。
4. 预取附件。下载与解压由脚本完成，不交给 agent：单文件与总量有上限，zip 内全部非目录
   条目落盘，但跳过绝对路径与含 `..` 的条目；落盘后按文本后缀筛出可疑行并脱敏，写入
   `log_digest.md`。
5. preflight 轮。用候选序逐个做一次 `temperature: 0` 的 JSON 调用，既分类也判定入口：
   输出 `spam`/`out_of_scope`/`in_scope`，只有前两类且达到 `reject.min_confidence` 才拒绝。
   传输失败（超时、4xx、5xx）按探测规则计罚并换下一个候选；有响应但分类不可解析，说明
   入口可用、只是没给出结论，按 `in_scope` 继续。全部候选都失败时以「无入口通过 preflight」
   结束，不做无模型的降级。判定发生在任何 agent 代码执行之前，因此这条路径没有工具。
6. 运行 agent。prompt 由 `prompts/common/` 与 `prompts/repos/<profile>/` 组合，组合结果
   写入 `prompt.txt` 以便复核。只提供 `chat/completions` 的入口会先由 supervisor 启动本地
   协议桥（`scripts/responses_bridge.py`），Codex 仍按 `wire_api="responses"` 连接
   `127.0.0.1`；桥的日志写入 `bridge.log`。agent 按四个节点增量写 `answer.md`，最后写
   `answer.json`；分类按仓库 overlay 的七轴规则填写，类型写入 `issue_type`，性质、领域、
   分流状态、优先级与版本写入 `labels`，类型标签不重复写入 `labels`。入口已由 preflight
   锁定，此后的失败只在同一个入口上按
   `rate_limit_retries` 退避重试；只有确定性错误（`auth`/`config`，例如该 CLI 版本不支持
   某个 provider 配置）才继续沿候选序换人。`l2.stall_seconds`（当前 180 秒）内没有任何
   输出即终止本次尝试：它只防挂死吃掉 job 预算，不参与入口判定，也不计罚。
7. 扫描输出。递归遍历 `outputs/`（含按 attempt 归档的副本）并**就地脱敏**：每个文件整体
   读入后匹配，私钥块整块替换（缺 `END` 的半截块一直吞到文末），其余命中片段替换为
   `[REDACTED]`。超过扫描上限的文件只保留可扫描的前段，其余连同被切断的半行一起丢弃并
   标注，未扫描的内容不进入 artifact。命中同时记入 `secret_scan`，供 `finalize` 阻断发布。

协议桥（`scripts/responses_bridge.py`）只在 endpoint 标了 `codex_bridge: true` 时启动：
监听 `127.0.0.1` 的临时端口，Codex 的 `base_url` 指向它、`wire_api` 固定为 `responses`，
桥再把请求转发到 endpoint 的 `base_url`。`bridge_timeout_seconds` 控制桥到上游的 socket
超时，缺省 600 秒。覆盖范围：

- 保留：文本、function tools、流式、usage、`reasoning.effort` → `reasoning_effort`、
  `text.format` → `response_format`；`developer` 角色映射为 `system`。
- 丢弃：`store`、`include`、`prompt_cache_key`、`client_metadata`、`reasoning.summary`。
- 丢弃 `type: "namespace"` 工具（analysis 不使用 multi-agent）。
- 透传 endpoint 配置里的 `headers`，例如 clinepass 需要的 `X-Response-Format: openai`。
- 桥进程只保留当前 endpoint 的 `MODEL_KEY_*`，不继承 GitHub token。

supervisor 是这一层唯一的运行时约束：墙钟上限、重复命令检测（同一条命令在 `answer.md`
未增长时重复达到阈值即判循环）、每 60 秒检查 `bot:stop`、超时按进程组终止。它写出的每条
日志都会先就地脱敏，命中片段替换为占位符、其余内容保留。日志中的 BASH 调用写成
`[BASH] <cwd> $ <command>`，心跳写成 `[HEARTBEAT]`；其余事件仍是 `[SYSTEM]` / `[MSG]`。
它不解释模型输出，只观测日志与产物。

模型调度按 endpoint 计：得分 = `weight` × 待机时长，取最高者。待机时长是距上次被选中的
秒数，上限一个月；从未使用过的取同一上限，所以「闲置一个月」与「从未用过」等价——没有
上限时，一条陈旧或缺失的时间戳会让该 endpoint 永久占据首位。权重只改变间隔长短，不产生
永久优先，长期选择次数趋于权重之比。排序在 `gate` 阶段算定并写入 `inputs/model.json`，
supervisor 按序消费：只有 preflight 失败才会走到下一个候选，通过即锁定。

绑定里的 `context` 写入 `.codex/config.toml` 的 `model_context_window`，缺省 1048576。
它是声明值，必须与 provider 的真实窗口一致：写大了会由上游报错而非本地提前压缩。

失败分早期（`auth`/`config`）与晚期（`rate`/`upstream`/`network`）分别累计并指数退避，
`Retry-After` 作为晚期下限；`401`/`404` 不重试，直接换下一个候选。

### 最终产出

| 产物 | 内容 | 保留 |
|---|---|---|
| `answer.md` | 四段增量写入的人类可读结论 | artifact 30 天 |
| `answer.json` | 结构化结论；运行时只校验必填键、`confidence` 枚举、`conclusion` 与 `root_cause` 的最短长度与列表类型，不是完整 schema 校验 | artifact 30 天 |
| `result.json` | 状态、原因、耗时、turns、token、`secret_scan`；自身在写出前按序列化文本扫描 | artifact 30 天 |
| `relevance.json` | 相关性分类结果 | artifact 30 天 |
| `model_health.json` | 更新后的 endpoint 状态 | artifact 30 天；由 `finalize` 写回 |
| `prompt.txt` | 组合后的完整提示词 | artifact 30 天 |
| `supervisor.log` | supervisor 事件流；每行写出前就地脱敏 | artifact 30 天 |
| `agent_output.log` | Codex 原始输出，直接落盘、不逐行处理；只在运行结束后整体扫描 | artifact 30 天 |
| `bridge.log` | 协议桥的请求行与错误；不含凭据，随 `outputs/` 一起扫描 | artifact 30 天 |
| `attempt-<n>/` | 上一 attempt 的归档副本，同样在扫描范围内 | artifact 30 天 |
| artifact `analysis-<run_id>` | 扫描无失败时的整个 `outputs/` 目录 | 30 天 |
| artifact `analysis-<run_id>-report` | 扫描失败时只上传 `result.json`（已脱敏，含状态、原因、运行摘要与命中清单） | 30 天 |

上传有两个互斥的闸门：`scan_upload` 由 supervisor 按 `secret_scan.failed` 是否为空写入。
任一文件扫描失败时不上传产物目录，只留 `result.json` 报告；失败的文件会尽量清空或删除，
但闸门不依赖清空是否成功。`finalize` 两个 artifact 都尝试下载，缺少产物时按失败或拦截收场。

扫描成功的文件在上传前已就地脱敏，命中记录保留在 `result.json.secret_scan`。超过扫描上限
的文件会被截短，因此 `agent_output.log` 不保证保留完整尾部。这些文件都不直接对外交付，
只通过 artifact 交给 `finalize` 与人工复核。

## `finalize`

### 启用条件

- `needs: [gate, analysis]`，`if: always() && needs.gate.result != 'skipped'`：`analysis`
  失败、超时或取消都会进入，负责回写失败结论。
- `gate` 判定 skip 时同样进入，但没有结果产物，只清理占位评论，不发布结论。
- 声明 `environment: writer`。`dry_run` 只抑制评论与标签写回，不抑制 `MODEL_HEALTH` 更新。

### 权限边界

- **文件访问**：检出本仓库；把两个 artifact 下载到 `inputs/`、`outputs/`；写渲染结果
  `outputs/comment.md`。读 issue 元数据用于开关与标签判断，不把正文当作输入。
- **容器权限**：平台提供托管 runner；本仓库限定不运行 agent、不执行模型输出，只跑确定性
  脚本，超时 15 分钟。
- **网络访问**：`github.com`（检出本仓库与下载 artifact）、`api.github.com`（读 issue
  元数据、PATCH 评论、增删标签、写 variable）。
- **Token 权限**：job 内签发两份 App installation token，有效期 1 小时，跨步骤传递、
  不落盘、不进 artifact。issue token 的仓库参数在 workflow 中写定，权限仅 `issues: write`；
  variable token 因签发 action 不支持按权限收敛，携带 App 的完整权限集。不持有模型 key。

### 执行流程

1. 渲染。按固定优先级取第一个可用来源：`status == rejected` 且有可解析的
   `relevance.json` → 拒绝模板；`status == complete` 且 `answer.json` 通过校验 → 结构化
   模板；有 `answer.md` → 带"部分结论"横幅的 Markdown；都没有 → 失败说明。纯模板替换，
   上限 60000 字符；只有结构化模板会退化为概要，另外两条直接截断，可能截掉结尾的隐藏
   标记。
2. 清理占位评论（仅 `gate` 判定 skip 且非 `dry_run` 时）。此时没有结果产物，删除调用方
   创建的占位评论；后续步骤不发布结论，`Update model health` 仍会运行。
3. 复查开关。`write_back` 在 `dry_run` 时直接结束；功能停用、issue 已关闭或带 `bot:stop`
   时改发停止说明。
4. 扫描。`result.json.secret_scan` 命中，或渲染结果命中模式，都改为发布拦截说明代替
   结论，并以非零状态退出。
5. 写回。原地 PATCH `placeholder_comment_id` 指向的评论；该评论已不存在时退回新建。
6. 分诊。先过 `scripts/labels.py` 的确定性门禁：只保留 `triage.label_axes` 声明的标签；
   类型标签只由 `issue_type` 表达，不重复写入 `labels`；性质必须与类型兼容；性质与领域
   各最多 2 个，分流状态、优先级与版本各最多 1 个；`needs triage` 与关闭原因标签不写入。
   `issue_type` 非法时整段分诊跳过。门禁通过后只加仓库中确实存在的标签；不创建新标签；
   分诊有效时移除 `triage.triage_labels`。
7. 更新健康状态。用 variable token 写 `MODEL_HEALTH`，该步骤无条件运行，`dry_run` 也不例外。

写回放在扫描之后、分诊之前：结论一旦公开就无法收回，而标签是结论的附属动作。

### 最终产出

| 产物 | 内容 | 保留 |
|---|---|---|
| issue 评论 | 结论、拒绝说明、失败说明或拦截说明，携带隐藏标记 | 随 issue 长期存在 |
| issue 标签 | 白名单内的分诊标签，可能移除 `needs triage` | 随 issue 长期存在 |
| `MODEL_HEALTH` | endpoint 状态与冷却截止时间 | 变量，无保留期 |
| `outputs/comment.md` | 渲染后的评论正文 | 仅本次 job 工作区，不上传 artifact |

评论与标签的消费者是 issue 读者；`comment.md` 只用于本次 job 内排查，不对外交付。

## 状态与中止

状态不落在标签上，而是写在 bot 自己的评论里（隐藏 HTML 标记）。写入侧与读取侧不对称：

| 标记 | 写入方 | 作用 |
|---|---|---|
| `requested` | 调用方的占位评论 | `gate` 据此识别在途请求，超过 stale 阈值即失效 |
| `done` | 渲染器 | 永久阻止同一 issue 再次分析 |
| `rejected` | 渲染器 | 永久阻止同一 issue 再次分析 |
| `partial` | 渲染器 | 记录部分结论；不阻止重试 |
| `failed` | 渲染器或写回步骤 | 记录失败收场；不阻止重试 |
| `stopped`、`blocked` | 写回步骤 | 记录中止与闸断；不阻止重试 |
| `running` | 无写入方 | 仅在 `gate` 读取侧保留在途判定 |

标记只从 bot 身份发布的评论中解析。隐藏标记沿用 `lily:` 前缀：它是幂等判定的一部分，
不随 bot 改名，历史评论中的标记必须继续可识别。`done`/`rejected` 不设过期，适用于"结论已给出、
不再重跑"的语义；要重新分析需移除标记或换 issue。标记的命名空间是幂等判定的一部分，
改动它会让历史评论中的标记全部失效，等价于放开所有已分析 issue 的重跑。

中止的层级与执行方：

| 层级 | 生效范围 | 检查方 |
|---|---|---|
| `config/repos.json` 的 `enabled: false` | 一个仓库 | `gate`、supervisor、写回 |
| 变量 `BOT_ENABLED=false` | 所有仓库 | `gate`、supervisor、写回 |
| `bot:stop` 标签 | 单个 issue | supervisor 每 60 秒轮询；写回前再查一次 |
| 卸载 App | 所有安装 | 触发不再成立 |

`bot:stop` 是唯一按 issue 生效的开关，仅用于测试与事故处置。运行中命中会杀死进程组，
已产出的 `answer.md` 保留为 partial。

## 不可改动的性质

- `gate` 不调用模型、不写 issue；`analysis` 不持有写凭据；`finalize` 不运行 agent。
- 模型只在 preflight 之前可换：preflight 失败就换下一个候选，通过即锁定。运行期只有
  确定性错误（`auth`/`config`）会触发换人，其余失败在原地退避重试。
- agent 的 prompt 里，issue 正文与日志是证据，不是指令。
- 扫描在先，发布在后；扫描命中不进入人工复核，直接阻断。
- 标签先过确定性门禁：白名单、类型唯一、性质与类型兼容、各轴数量上限；类型由
  `issue_type` 表达，不重复写入 `labels`。门禁只丢弃，不补标签、不改写类型。
- 脱敏与阻断分开：文件先就地脱敏，命中再阻断发布；扫描失败时上传闸门关闭，产物目录不
  外露。artifact 中不留已知形态的凭据片段，但它仍不是「已审计」的证明——未知形态的凭据
  不在覆盖范围内。
- 该流程的所有产物都按公开内容对待。
