# Codex CLI

面向长期维护的参考：调用形态、参数语义、事件流与失效模式。基线版本 `0.166.0`（`analysis`
里固定的版本），参数取自 CLI 源码中的 clap 定义，不以文档页面为准——后者改版频繁且不覆盖
全部开关。升级版本时按本文的"升级核对"逐项复核。

## 版本与固定

- 安装：`npm install -g @openai/codex@<version>`。版本是行为的一部分，不随环境漂移。
- `codex doctor` 可诊断安装、配置、auth 与运行时状态；升级前先在本地跑一次。
- 升级核对：`exec` 的参数集合、`--json` 的事件名、配置键名、`wire_api` 支持范围。这四项
  任一变化都会改变本仓库的调用契约。

## 入口形态

| 形态 | 命令 | 说明 |
|---|---|---|
| 单次非交互 | `codex exec [OPTIONS] <PROMPT>` | 一次会话跑完即退出 |
| 续接 | `codex exec resume <SESSION_ID> <PROMPT>` | 在同一会话里追加一轮 |
| 分叉 | `codex exec fork <SESSION_ID> <PROMPT>` | 复制历史后开新会话 |
| 常驻控制面 | `codex app-server --listen stdio://` | 实验接口，JSON-RPC，供需要长会话的调用方 |

`exec` 默认把会话写入磁盘；`--ephemeral` 关闭持久化，关闭后 `resume` 无从引用。`resume`
另有 `--last`（取最近一条）与 `--all`（取消 cwd 过滤）。

## prompt 的传递

- 位置参数直接给；省略或写 `-` 时从 stdin 读取。
- 同时给了 prompt 又接了管道时，stdin 内容作为 `<stdin>` 块拼在 prompt 之后。
- argv 受平台单参数上限约束（Linux `MAX_ARG_STRLEN`，128 KiB）。可能超长的 prompt（含日志
  摘要、附件摘录）走 stdin，不拼进命令行。

## 事件流

`--json`（旧名 `--experimental-json`）按行输出 JSONL，每行一个对象：

| `type` | 关键字段 | 用途 |
|---|---|---|
| `thread.started` | `thread_id` | 会话标识，`resume` 的唯一来源 |
| `turn.started` | — | 一轮开始，表示请求已被接受 |
| `item.started` / `item.updated` / `item.completed` | `item` | 消息、命令执行、文件改动的粒度 |
| `turn.completed` | `usage` | 该轮 token 用量 |
| `turn.failed` | `error` | 该轮失败及原因 |
| `error` | `message` | 事件流级别的不可恢复错误 |

判读顺序：`thread.started` 缺失说明会话未建立（多为配置或凭据问题）；`turn.failed` 或
`error` 出现说明请求被拒，`error` 里带上游原文。渲染后的人类可读文本（回合标题、`tokens
used` 之类）属于展示层，不应当作结构化判断依据。

## 结构化输出

- `--output-last-message <FILE>`（`-o`）：只写最后一轮的自然语言结果，不含过程日志。
- `--output-schema <FILE>`：给最终回复一个 JSON Schema，由 CLI 侧约束作答形状。

两者都在进程之外产出，不必从 stdout 截取，也不依赖 stdout 是否被重定向。适合把"结论"与
"过程"分成两个文件。

## 配置

- `$CODEX_HOME/config.toml` 承载 `model`、`model_provider`、`model_context_window`、
  `model_reasoning_effort`、`approval_policy`、`sandbox_mode`、`web_search`；provider 段写
  `base_url`、`env_key`、`wire_api`、`requires_openai_auth`。
- `-c key=value` 覆盖任意配置项，`--profile <name>` 叠加 `$CODEX_HOME/<name>.config.toml`。
- `--ignore-user-config` 跳过 `config.toml`，auth 仍读 `CODEX_HOME`；`--strict-config` 让
  未知配置键直接报错，适合在固定版本的环境里尽早暴露字段漂移。
- 模型 key 由 provider 段的 `env_key` 指向的环境变量提供，不写进配置文件。

### wire_api 的兼容性

`wire_api = "chat"` 自 `0.95.0` 起不再被接受（`0.94.0` 是最后一个支持版本），配置加载
阶段即失败：

```
Error loading config.toml: `wire_api = "chat"` is no longer supported.
How to fix: set `wire_api = "responses"` in your provider config.
More info: https://github.com/openai/codex/discussions/7782
```

这个失败发生在会话建立之前，事件流里没有任何输出，进程以 `1` 退出；未被选中的 provider
条目也会触发。部分子命令（如 `codex features list`）还会附带
`in model_providers.<alias>.wire_api`。使用 OpenAI 兼容的中转端点时，必须先确认该端点
实现了 Responses 协议。

只提供 `chat/completions` 的端点不能直接驱动当前版本；本仓库的转换方式见
`docs/jobs/bug-issue-analysis.md` 的「执行流程」。

## 沙箱与工作目录

- `-s/--sandbox` 选策略；`--dangerously-bypass-approvals-and-sandbox` 同时取消审批与沙箱。
- `-C/--cd` 指定工作根，`--add-dir` 追加可写目录，`--skip-git-repo-check` 允许在非 git
  目录运行（CI 里用不到，检出已是 git 仓库）。
- 全放开只应出现在外部已隔离的环境：CLI 不再兜底，隔离必须来自容器边界与凭据缺失。

## 会话续接及其边界

`--json` 取 `thread_id` 后，`exec resume <thread_id> <prompt>` 可在同一会话追加一轮。前提是
两次调用共享 `CODEX_HOME` 且首轮未用 `--ephemeral`：同一进程组内成立，跨步骤则需要把会话
文件一起保留。`codex app-server` 提供同一能力的常驻形态，`thread/start` 后多次
`turn/start`，省掉重复启动，但属实验接口。

把"判定"与"干活"放进同一会话时要注意两点：会话内的每一轮都带着工具与沙箱策略，不存在
"这一轮只做判断、没有工具"的档位；上一轮的结论也留在上下文里，会成为后续推理的前提。

## 失效模式对照

| 现象 | 常见原因 | 判断依据 |
|---|---|---|
| 启动即退出，无任何输出 | 配置键不再支持、provider 段缺字段 | stderr 的 `Error loading config.toml` |
| `thread.started` 缺失 | 凭据无效、base_url 不可达 | `error` 事件或进程 stderr |
| 有回合但迅速 `turn.failed` | 上游 4xx、模型名不存在 | `turn.failed.error` |
| 长时间无输出 | 上游挂起 | `stream_idle_timeout_ms`（默认 300000ms）之外仍需外部墙钟 |
| 反复执行同一命令 | 模型陷入自检循环 | 事件流里的重复 `item`；需外部判环 |

最后两行是外部责任：CLI 的 `stream_idle_timeout_ms` 只覆盖流空闲，不覆盖工具执行或无进展；
循环检测仍需调用方自己设墙钟并在重复调用时终止进程组。

## 来源

- `openai/codex` 源码：`codex-rs/cli/src/main.rs`（子命令）、`codex-rs/exec/src/cli.rs`
  （`exec` 参数）、`codex-rs/exec/src/exec_events.rs`（JSONL 事件）、
  `codex-rs/utils/cli/src/shared_options.rs`（共享参数）。
- `wire_api="chat"` 的移除：上游 discussion 7782；最后支持版本 `0.94.0`，首个拒绝版本
  `0.95.0`（PR #10157）。
