# QQ 机器人

`apps/qqbot` 是常驻进程：接入 QQ 官方 WebSocket、按群路由命令、收集信息并调用两个后端
服务建 Issue。协议细节在 `packages/qqbot`，业务在 `apps/qqbot`。

## 凭据边界

机器人只持有三类凭据：QQ `AppID`/`AppSecret`、`agentToken`、`githubWriterToken`。
它**不持有**模型 key，也不持有 GitHub App 私钥：分析与写回分别由 `agent-svc` 与
`github-writer` 完成，机器人只发 HTTP 请求。

依赖方向由 `apps/qqbot/package.json` 与 `tsconfig.json` 的 `paths` 固定为
`apps/qqbot → @gt6ce/qqbot | @gt6ce/shared`。引入 `@gt6ce/agent` 或 `@gt6ce/github`
会在类型检查阶段失败，不靠评审提醒。

## 命令

| 命令 | 行为 | 权限 |
|---|---|---|
| `/help` | 列出本会话启用的命令、绑定仓库与示例 | 绑定会话即可 |
| `/issue <标题>` | 收集版本/复现步骤/期望结果，交 `agent-svc` 整理草稿，再由 `github-writer` 建 Issue | `maintainers` 名单内 |

`/issue` 缺字段时**一次只问一个**，用户引用机器人的提问消息回复即可补充。引用关系靠
平台返回的 `ext_info.ref_idx` 关联：机器人发送提问时记录该序号，入站消息的 `refMsgIdx`
命中即接回同一会话。

也可以一次写全，或用「标签：值」改写单个字段：

```text
/issue 合成器崩溃
版本：1.21.1
复现：启动游戏并打开合成器
期望：正常显示配方
```

标签支持 `标题` / `版本` / `复现` / `期望` / `实际`（英文 `title` / `version` /
`steps` / `expected` / `actual` 等价）。

## 绑定配置

机器人配置是一份 JSON，由 `QQBOT_CONFIG` 指向，模块内不读其他环境变量。字段：

| 字段 | 作用 |
|---|---|
| `appId` / `appSecret` | QQ 开放平台凭据 |
| `sandbox` | 沙箱标记，仅用于启动日志 |
| `stateDir` | session 与 last seq 的落盘目录，默认 `./state` |
| `agentEndpoint` / `agentToken` | 分析服务地址与 RPC token |
| `githubWriterEndpoint` / `githubWriterToken` | 写回服务地址与 RPC token |
| `bindings` | 会话 → 仓库绑定 |
| `pollIntervalMs` / `taskTimeoutMs` | 轮询分析任务的间隔与总超时 |
| `sessionTtlMs` | 等待引用回复的会话保留时长 |

`bindings[]` 的字段：

| 字段 | 作用 |
|---|---|
| `scope` | `group:<group_openid>` 或 `c2c:<user_openid>`；只写 openid 时按群处理 |
| `repo` | `owner/name` |
| `maintainers` | 允许执行写操作命令的成员 openid；为空表示没有人可以写入 |
| `allowedCommands` | 该会话启用的命令；`/help` 始终可用 |
| `attachBotStop` | 建 Issue 时是否在正文末尾追加 `<!-- bot:v1:stop -->` |

配置校验失败会直接拒绝启动（`ConfigError` 列出每个字段的问题），不会退化为默认放行。

## 协议适配要点

- **切分**：单条上限 4500 字。先按块解析（围栏代码块 / 表格 / 普通文本）再装箱；拆分
  代码块时补全开启与闭合围栏，拆分表格时重复表头。
- **降级**：平台返回 `304036` / `304014` / `50056` 时，把当前分片改纯文本重发一次，
  同一轮回复的后续分片也走纯文本。其他错误码不降级，直接失败并记录。
- **序号**：按 `msg_id` 维护从 1 开始的单调 `msg_seq`，带 TTL 与容量上限，取代 SDK 的
  随机公式。
- **关闭码**：`4001` / `4002` / `4010`–`4014` 视为不可恢复，命中即停止重连并通知上层退出，
  避免反复 Identify 耗尽配额；其余关闭码交给 SDK 退避重连。
- **持久化**：`stateDir` 存在时用 SDK 的 `FileKVStore` + `kvSessionPersistence` 落盘
  session id 与 last seq；停机前 `flush`。
- **去重**：按 `message_id` 去重，窗口 10 分钟；平台重投不会建出两个 Issue。

## 启动与停机

```bash
node apps/qqbot/dist/main.js   # QQBOT_CONFIG 必须指向配置文件
```

`SIGINT` / `SIGTERM` 触发优雅停机：先等后台建单任务收尾（上限 10 秒），再停止网关并
落盘会话。网关出现不可恢复关闭时以退出码 1 结束，交由容器编排重启或人工介入。

## 扩展命令

`apps/qqbot/src/handlers/registry.ts` 是唯一注册点：

1. 实现 `CommandHandler`（`handlers/types.ts`），需要写权限时把 `requiresMaintainer`
   设为 `true`；
2. 在 `CommandRegistration` 里写清 `name` / `summary` / `usage`，`/help` 会自动展示；
3. 在 `createDefaultRegistry()` 注册；
4. 需要多轮交互时复用 `SessionStore`，并用 `bindSession` 把机器人消息绑定到会话。

后续的「原版行为问答」「群内投票」「PR/RFC 提醒」都走同一条路径，不需要改路由器。
