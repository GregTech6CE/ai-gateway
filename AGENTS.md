# AGENTS.md

本文件约束在本仓库内的一切改动。仓库是公开的：代码、配置、文档、运行日志与 artifact
都按可被任何人读到对待。**只写公开面事实，是这个仓库的第一条硬约束。**

## 1. 公开面边界

允许写入仓库的内容：

- 本仓库自身的代码、配置、模板与文档内容；
- 公开仓库的 `owner/name`、公开 issue 与 PR 的可见内容；
- 本仓库 workflow 中已经出现的 secret / variable 名称。

禁止写入仓库的内容：

- 凭据值：token、PEM、API key、cookie、密码，明文、片段、编码或哈希形式都不允许；
- 仅外部可见的信息：内部设计文档与决策记录、其他私有仓库的路径与状态、运行手册与
  处置记录、审批人或成员身份、内部地址与端口、本地绝对路径、用户名与邮箱。`.github/CODEOWNERS`
  中的 owner handle 是公开协作者标识，不受此限。
- 从运行日志、artifact 或聊天记录抄录的未脱敏数据。

判断标准：若某人只拥有本公开仓库的读权限，无法独立核对这条信息，就不要写进来。
确有必要表达时，用**名称**代替值，用**机制**代替实例。

## 2. 目录职责

| 路径 | 职责 |
|---|---|
| `.github/workflows/` | 只保留发布流水线；issue 分析的执行层在组织仓 `GregTech6CE/.github` |
| `apps/ci/` | 各阶段 CLI：`gate`、`prefetch`、`analysis`、`render`、`write-back`、`control`、`update-health` 与本地只读 MCP 入口 `readonly-mcp` |
| `packages/shared/` | Zod 配置与答案契约、凭据扫描、结构化日志 |
| `packages/github/` | GitHub REST 客户端、`bot:v1` 标记协议、六轴标签、渲染与写回 |
| `packages/agent/` | 模型池、工作区准备、统一 5 只读工具基线、本地 stdio MCP Server 与结构化分析执行器 |
| `packages/qqbot/` | QQ 协议适配层：网关连接、会话持久化、消息切分与序号、错误码记录 |
| `apps/qqbot/` | QQ 机器人常驻进程：命令路由、群会话、RPC 客户端与优雅停机 |
| `apps/agent-svc/` | 内部分析服务：任务队列、模型池调度、结构化草稿（`node:http`） |
| `apps/github-svc/` | 内部写回服务：白名单、凭据扫描、标签清洗、幂等建 Issue（`node:http`） |
| `scripts/` | 发布打包：把 4 个应用打成自包含 `.tgz` 并生成 `SHASUMS256.txt` |
| `config/` | 仓库白名单、预算与模型池；`repos.json` 是授权的事实来源 |
| `prompts/` | `common/` 通用规则，`repos/<profile>/` 仓库覆盖 |
| `templates/` | 评论模板：`comment.md`、`reject.md` |
| `deploy/` | CI 与 Docker 两份出网白名单、Dockerfile、compose 编排与配置示例 |
| `docs/` | 授权、调度、QQ 机器人与部署的设计文档；写法受 `docs/AGENTS.md` 约束 |

workspace 由 Rush + pnpm 管理；运行时新增依赖只允许 `zod`、AI SDK（`ai`、
`@ai-sdk/openai-compatible`）、ACP SDK（`@agentclientprotocol/sdk`，只在
`packages/agent`）与 QQ SDK（`@tencent-connect/qqbot-nodejs`，只在
`packages/qqbot`）。两个内部 HTTP 服务只用 `node:http`，不引 Web 框架。
测试与源码同包，用 vitest，不单独建 `tests/` 目录。

## 3. 安全不变量

以下条件属于设计前提，改动不得破坏；确需变动时同步更新本文件与 `docs/`。

1. `gate` 只读：不写 issue、不发评论、不持有 App token、不调用模型。
2. 最终结论与标签的写回只发生在执行层的 `finalize`：独立 job、确定性代码、不运行模型、
   不把 issue 正文当作指令。业务仓触发层只传参，不创建占位评论。
3. 凭据按 job 与步骤隔离：模型 key 只进入 `analysis` 的 `analysis.js` 步骤；App 私钥
   只进入 `finalize` 的签发步骤；两类凭据不进入同一个 job。
4. 分析步骤没有 issue 写权限，也没有触发任何 workflow 的凭据。
5. 未知仓库、配置缺失或配置非法一律 fail-closed，不得退化为"默认放行"。
6. 触发参数与 issue 文本只当数据：不拼接进 shell 语句，不参与路径构造，不当作指令。
7. 写回前必须经过凭据扫描；命中即阻断发布，只回一条拦截说明。
8. 只读工具基线的外部子进程（`rg`、`git`）统一经有界执行器启动：`shell: false`，每次重建最小
   `env` 仅保留 `PATH` 与 `GIT_TERMINAL_PROMPT=0`；`MODEL_KEY_*` 与其他凭据不得进入子进程。
   多根目录路径校验仅允许 `code/`、`inputs/`、`outputs/`，拒绝 `.git`、`.env` 与符号链接逃逸；
   单次命令 15 秒超时、内存流式上限 64 KB。
9. `analysis` job 的出网域名由 `deploy/egress-allowlist.txt` 与 harden-runner 的
   `allowed-endpoints` 共同约束，两处必须同步。
10. `apps/qqbot` 只依赖 `@gt6ce/qqbot` 与 `@gt6ce/shared`：不得引入 `@gt6ce/agent`、
    `@gt6ce/github`，也不持有 LLM key 与 GitHub App 凭据。它只通过两个带独立
    `RPC_TOKEN` 的 REST 客户端访问后端服务，依赖方向由 `package.json` 与 tsconfig 的
    `paths` 强制，不是约定。
11. `apps/agent-svc` 只依赖 `@gt6ce/agent` 与 `@gt6ce/shared`，不持有任何 GitHub 凭据；
    `apps/github-svc` 只依赖 `@gt6ce/github` 与 `@gt6ce/shared`，不持有任何模型 key。
    两者互不引用，也不引用 `@gt6ce/qqbot`。
12. 内部服务的跨服务认证只接受 `Authorization: Bearer`，比对必须先哈希再
    `timingSafeEqual`；`/healthz` 是唯一的免鉴权路由，且只返回 `{ ok: true }`。

`analysis` 内的 OpenAI 兼容入口与 ACP 入口共享同一套 5 只读工具基线（`list_files`、
`grep_search`、`read_file`、`git_log`、`git_diff`）：前者在进程内直接调用，后者通过本地
stdio MCP（`gt6-readonly`）挂载并在 `session/request_permission` 仅放行只读工具、拒绝写入与
命令执行。两种入口的隔离都来自 job 边界——没有写 token、没有 App 私钥——以及最小环境外部命令
执行与出网白名单，**不是**来自沙箱或审批。不要用"沙箱会拦住"作为安全论证。

## 4. Workflow 修改规则

`.github/workflows/` 是风险最高的位置，每次改动逐条自查：

- **事件**：本仓库只保留发布流水线，事件面限定 `push` 与 `workflow_dispatch`；执行层
  只以 `workflow_call` 暴露在组织仓。禁止 `pull_request_target`、`workflow_run`，以及
  任何会把不可信代码或不可信上下文带入持有凭据 job 的事件。
- **权限**：顶层 `permissions` 保持最小；额外权限只在需要的 job 内声明，并确认该 job
  不运行模型、不接触不可信正文。
- **秘密作用域**：secret 只在对应步骤的 `env:` 中出现，不在 job 级、不在顶层；模型 key
  与 App 私钥不进入同一个 job。
- **传参**：不可信文本（标题、正文、评论、inputs）只能经 `env:` 进入步骤，不得直接
  插值进 `run:`；避免 `${{ ... }}` 出现在 shell 语句内部。
- **回显**：不打印环境变量全量，不用 `set -x`，不对携带凭据的请求用 `curl -v`，不把
  token 写进文件名、日志或 artifact。
- **依赖**：action 与 CLI 版本固定；当前 action 使用主版本标签，新引入的依赖应固定到
  不可变版本或提交 SHA。升级时核对来源与版本号，并同步文档。
- **并发与超时**：保留 `concurrency` 与 `timeout-minutes`；不要让单次运行无限延伸。
- **artifact**：名称带 `run_id`，不跨运行复用；不要假设上一次运行的产物仍可用。

## 5. 常见攻击与对应防线

| 攻击 | 载体 | 现有防线 |
|---|---|---|
| Prompt injection | issue 正文、评论、日志、附件 | 提示词声明这些内容是数据；写回不经过 agent；输出扫描 |
| 脚本注入 | `${{ }}` 直接嵌入 `run:` | 触发器只传标量，脚本内自行校验；不可信文本走 `env:` |
| 凭据外泄 | 评论、日志、artifact | 三层就地脱敏：日志行写出前替换命中片段；`analysis` 递归扫描 `outputs/` 并改写文件（私钥块整体替换，超过上限只保留前段）；`finalize` 再扫渲染结果。扫描失败则关闭 artifact 上传闸门，命中另记 `secret_scan` 并阻断发布 |
| 越权触发 | 伪造仓库名、伪造 bot 评论、非维护者 @ | 仓库键白名单 fail-closed；评论作者协会校验；按仓库匹配 bot 身份 |
| 重复触发 | 高频评论、重复 @ | `bot:v1:` 隐藏标记幂等（stop / pending / done / failed）；被动触发另有 7 天超期兜底；显式 `force` 才放行 |
| 状态伪造 | 手工复制隐藏标记 | 标记只用于被动触发的幂等判定，不作为授权依据；授权仍看仓库配置与作者协会 |
| 供应链投毒 | 第三方 action、全局 npm 包 | 版本固定；权限最小；只在必要时引入 |
| 附件炸弹 | 超大附件、zip 路径穿越 | 单文件与总量上限、条目绝对路径与 `..` 校验、文本后缀才进摘要 |
| 可见性错配 | 公开仓处理私有 issue | 执行层在业务仓自己的 run 内运行，issue 内容不进入公开执行器仓库 |
| 状态伪造 | 手工复制隐藏标记 | 标记只用于幂等判定，不作为授权依据；授权仍看仓库配置与作者协会 |

## 6. 凭据处理

- 凭据只按名称引用：`MODEL_KEY_MISTRAL`、`MODEL_KEY_CLINEPASS`、
  `GT6CE_APP_PRIVATE_KEY`。名称可以出现在文档与 workflow 中，值不可以。
- 本地不得创建 `.env`、私钥或任何凭据副本；`.gitignore` 已覆盖常见形态，不要放宽。
- 调试凭据相关问题时，输出状态码与错误类型，不输出请求头、响应体原文或密钥前缀。
- 任何疑似泄漏按已泄漏处理：先阻断发布，再轮换，最后才排查原因。

## 7. 变更与验证

- 本地校验：
  `node common/scripts/install-run-rush.js typecheck`、
  `node common/scripts/install-run-rush.js test`、
  `node common/scripts/install-run-rush.js rebuild`。三条都要通过。
- 文本文件一律 LF，由 `.gitattributes` 约束；编辑器与脚本不要写出 CRLF，否则会产生整
  文件差异并掩盖真实改动。新增二进制或凭据格式要在 `.gitattributes` 里显式排除。
- 只做只读查询与本地运行；提交、推送、发布、修改 environment 与 secret 需要明确授权。
- 提交信息用中文说明行为变化；不写工具或助手署名。
- 报告中区分「已执行且通过」「已执行但失败」「未执行」，不用本地用例替代线上验证。

## 8. 文字约定

文档写法以 `docs/AGENTS.md` 为准：公开面约束、面向开发者的写法、Job 小节的四段格式都在
那里定义。本节只保留两条硬约束：

- 文档用中文；标识符、路径、API 名与配置键保持英文并使用行内 code。
- 只用公开面事实写作，凭据只写名称；判不准的一律按不可公开处理。
