# 授权

授权分两个方向：谁可以让本仓库运行，以及本仓库可以写什么。两者由不同的凭据和不同的
检查覆盖，不互相替代。

## 入站：谁可以触发

本仓库只接受 `workflow_dispatch`。GitHub 会校验调用方 token 对本仓库具备
`Actions: write`，但**"持有 token"不等于"请求合法"**：任何安装到本仓库的 App 或
本仓库内有写权限的成员都能构造同类请求。因此 `gate` 独立判定有效性，任一项不满足即
跳过，且跳过发生在模型调用之前。

| 检查 | 不满足时的语义 |
|---|---|
| `repo` 键存在于 `config/repos.json` | 未知仓库，跳过 |
| 该键 `enabled` 为真、全局 `BOT_ENABLED` 不为 `false` | 停用，跳过 |
| `event` 为 `issues` 或 `issue_comment` | 未知事件，跳过 |
| 目标仓库可见性不高于本仓库 | 公开本仓库拒绝私有 issue 仓库 |
| issue 存在、打开、不是 PR | 跳过 |
| issue 标签匹配 `process_only` 的任一 OR-AND 组 | 未经分诊，跳过 |
| 评论触发时，评论属于该 issue、作者协会为 `OWNER`/`MEMBER`/`COLLABORATOR`、正文提及该仓库的 bot | 跳过；bot 自身评论一律排除 |
| bot 评论中无 `done`/`rejected` 标记、无在途标记 | 重复请求，跳过 |
| 三级配额未耗尽 | 超限，跳过 |

标记只从 bot 身份发布的评论中解析；普通评论里出现同样的 HTML 注释不参与判定。

标记的判定口径不对称：`done`/`rejected` 一经出现即永久阻止同一 issue 的再次分析，不设
过期；只有 `requested`/`running` 按 `running_stale_minutes` 判定是否仍在途。要重新分析
一个已得出结论的 issue，需要移除对应标记，或换一个 issue。

每仓库的 bot 身份由 `config/repos.json` 的 `bot_login`/`bot_mention` 决定，不依赖单一
全局身份：一个本仓库可以同时服务多个 issue 仓库，且各用各的身份。当前只配置
`GregTech6CE/GregTech6`；新增仓库时 App 安装范围与 `finalize` 的 token 仓库参数必须
同步更新，否则请求会通过授权校验、却在写回时失败。

`gate` 不持有 App token，也不调用模型。它的 job 权限只有 `contents: read` 与
`actions: read`；读取 issue 与评论走匿名公开请求，只有读取本仓库自身信息与统计自身 run
数量时使用 `github.token`。因此 `gate` 阶段的任何结论都不具备写能力，"通过校验"本身
不产生副作用。

## 出站：本仓库可以写什么

写回集中在 `finalize`，它是一个独立 job：`environment: writer`、不运行 agent、不把
issue 正文当作指令、消费 `gate` 与 `analysis` 的结构化产物，另外读取 issue 元数据用于
判断开关与标签状态。

`finalize` 现场签发两份 App installation token：

| token | 范围 | 用途 |
|---|---|---|
| issue token | 签发参数中写定的 issue 仓库，`issues: write` | PATCH 占位评论、增删标签 |
| variable token | 安装范围 | 写本仓库的 `MODEL_HEALTH` |

issue token 的仓库参数在 workflow 中写定，当前为 `GregTech6CE/GregTech6`。新增托管仓库时
必须同步修改该参数，否则写回会因 token 无权限而失败——`config/repos.json` 只决定"是否
处理"，不决定"是否有权写回"。

variable token 不收敛到 `issues: write`：现有签发 action 不支持只授予 variable 权限，
因此该步骤拿到的是 App 的完整权限集。可接受的前提是 `finalize` 不运行 agent、不把外部
文本当作指令，防护来自确定性模板替换与发布前扫描；一旦在该 job 内引入任何执行外部
内容的步骤，这个前提即失效。

安装 token 有效期 1 小时，job 内签发、跨步骤传递，不落盘、不进 artifact。

`analysis` 及其中的 agent 步骤：

- 没有 App 私钥，没有 App token，没有 `issues: write`；
- 环境里的 `GITHUB_TOKEN`、`SELF_TOKEN` 被移除，`GH_TOKEN` 被清空：agent 不持有任何
  GitHub token，对 issue 的读取由 supervisor 的匿名请求完成；
- 进程环境同时含有两个 endpoint 的模型 key（切换候选时不需要重新注入），Codex 通过
  `LLM_API_KEY` 只使用当前 endpoint 的那一个。因此"agent 只看得到一把 key"不成立。

## 凭据作用域

| 凭据 | 作用域 | 可见范围 |
|---|---|---|
| `MODEL_KEY_MISTRAL` / `MODEL_KEY_CLINEPASS` | secret，`llm` environment | 仅声明该 environment 的 job |
| `GT6CE_APP_PRIVATE_KEY` | secret，`writer` environment | 仅 `finalize` 的签发步骤 |
| `GT6CE_APP_CLIENT_ID` | variable | 与私钥配对使用 |
| `MODEL_HEALTH` | variable | `gate` 只读，`finalize` 写 |
| `BOT_ENABLED` | variable | 所有 job 只读 |

`llm` 与 `writer` 不合并到同一 job：合并会让运行 agent 的步骤与签发 App token 的步骤
处于同一凭据域，这是不允许的。environment 的 secret 只在声明该 environment 的 job 内
可见；environment 的其余策略属于仓库设置，本仓库内的文件无法自证，改动时需要在设置页
确认。

## 边界与残余风险

1. 应用层校验依赖 `config/repos.json`；修改该文件等价于修改授权范围。environment 的
   可达性由仓库设置决定，同样属于授权范围，两者都需要评审。
2. App 私钥的持有者可以冒充 bot 发布评论与触发本仓库。这是已知的残余身份风险；它不
   扩大模型 key 的可达范围。
3. `analysis` 的模型 key 确实存在于 agent 进程环境内，且两个 endpoint 的 key 同时可见。
   防线是输出扫描、provider 额度与轮换，而不是沙箱——agent 以 `danger-full-access` 运行
   且无人工审批。
4. 本仓库公开：日志、输入与 artifact 均可被读到。脱敏是尽力而为，因此私有 issue 仓库
   必须由私有实例处理。
5. 配额限制的是运行次数，不是单次成本。单次运行以墙钟时间与 endpoint 冷却为刹车。
