# 授权

授权分两个方向：谁可以让执行层运行，以及执行层可以写什么。两者由不同的凭据和不同的
检查覆盖，不互相替代。

## 入站：谁可以触发

执行层只接受 `workflow_call`，由业务仓的触发薄壳调用；本仓库本身不监听 issue 事件。
触发层先做一层防刷过滤（全局开关、Bot 作者、维护者 `@bot` 评论），但它不能替代 `gate`
的独立判定：业务仓内有写权限的成员可以修改触发薄壳或直接手动触发。因此 `gate` 独立
判定有效性，任一项不满足即跳过，且跳过发生在模型调用之前。

| 检查 | 不满足时的语义 |
|---|---|
| `repo` 键存在于 `config/repos.json` | 未知仓库，跳过 |
| 该键 `enabled` 为真、全局 `BOT_ENABLED` 不为 `false` | 停用，跳过 |
| `event` 为 `issues` 或 `issue_comment` | 未知事件，跳过 |
| 可见性与执行上下文一致（同仓执行） | 检查保留；同仓时不会触发跳过 |
| issue 存在、打开、不是 PR | 跳过 |
| issue 标签匹配 `process_only` 的任一 OR-AND 组 | 未经分诊，跳过 |
| 评论触发时，评论属于该 issue、作者协会为 `OWNER`/`MEMBER`/`COLLABORATOR`、正文提及该仓库的 bot | 跳过；bot 自身评论一律排除 |
| bot 评论中无 `done`/`rejected` 标记、无在途标记 | 重复请求，跳过 |

标记只从 bot 身份发布的评论中解析；普通评论里出现同样的 HTML 注释不参与判定。

标记的判定口径不对称：`done`/`rejected` 一经出现即永久阻止同一 issue 的再次分析，不设
过期；只有 `requested` 按 `requested_stale_minutes` 判定是否仍在途。要重新分析
一个已得出结论的 issue，需要移除对应标记，或换一个 issue。

每仓库的 bot 身份由 `config/repos.json` 的 `bot_login`/`bot_mention` 决定，不依赖单一
全局身份：执行层可以同时服务多个 issue 仓库，且各用各的身份。当前只配置
`GregTech6CE/GregTech6`；新增仓库时 App 安装范围、该仓库可用的 secret 与触发薄壳必须
同时覆盖它，否则请求会通过授权校验、却在写回时失败。

`gate` 不持有 App token，也不调用模型。它的 job 权限只有 `contents: read`；读取 issue
与评论走匿名公开请求，只有可见性检查使用 `github.token`。因此 `gate` 阶段的任何结论都
不具备写能力，"通过校验"本身不产生副作用。

## 出站：执行层可以写什么

写回集中在 `finalize`，它是一个独立 job：不运行模型、不把 issue 正文当作指令、消费
`gate` 与 `analysis` 的结构化产物，另外读取 issue 元数据用于判断开关与标签状态。

`finalize` 现场签发两份 App installation token：

| token | 范围 | 用途 |
|---|---|---|
| issue token | 当前仓库，`issues: write` | 新建评论、增删标签 |
| variable token | App 完整权限集 | 写 `MODEL_HEALTH` |

issue token 的仓库范围是 `github.repository`，也就是触发层所在的业务仓。新增托管仓库时
必须让 App 安装范围、该仓库可用的 secret 与触发薄壳三者同时覆盖它，否则
`config/repos.json` 只决定"是否处理"，不决定"是否有权写回"。

variable token 不收敛到 `issues: write`：现有签发 action 不支持只授予 variable 权限，
因此该步骤拿到的是 App 的完整权限集。可接受的前提是 `finalize` 不运行模型、不把外部
文本当作指令，防护来自确定性模板替换与发布前扫描；一旦在该 job 内引入任何执行外部
内容的步骤，这个前提即失效。

安装 token 有效期 1 小时，job 内签发、跨步骤传递，不落盘、不进 artifact。

`analysis` 及其中的模型执行步骤：

- 没有 App 私钥，没有 App token，没有 `issues: write`；
- 只有 `analysis.js` 步骤注入 `MODEL_KEY_*`：没有 `GITHUB_TOKEN`、没有 `GH_TOKEN`，
  模型执行步骤不持有任何 GitHub token；issue 的读取发生在只读的 `gate` job，模型只看到
  `inputs/` 里的快照；
- 进程环境同时含有两个 endpoint 的模型 key（切换候选时不需要重新注入），执行器按当前
  endpoint 的 `api_key_env` 取用其中一把。因此"只拿得到一把 key"不成立；
- 只读工具基线派生的外部子进程（`rg`、`git`）每次重建最小 `env`，仅保留 `PATH` 与
  `GIT_TERMINAL_PROMPT=0`，模型 key 与任何 GitHub token 都不会进入子进程。

## 凭据作用域

| 凭据 | 作用域 | 可见范围 |
|---|---|---|
| `MODEL_KEY_MISTRAL` / `MODEL_KEY_CLINEPASS` | secret，业务仓经 `secrets: inherit` 下发 | 仅 `analysis` 的 `analysis.js` 步骤 |
| `GT6CE_APP_PRIVATE_KEY` | secret，业务仓经 `secrets: inherit` 下发 | 仅 `finalize` 的签发步骤 |
| `GT6CE_APP_CLIENT_ID` | variable | 与私钥配对使用 |
| `MODEL_HEALTH` | variable | `gate` 只读，`finalize` 写 |
| `BOT_ENABLED` | variable | `gate`、`analysis`、`write-back` 只读 |

模型 key 与 App 私钥不进入同一个 job：合并会让模型执行步骤与签发 App token 的步骤
处于同一凭据域，这是不允许的。secret 由业务仓通过 `secrets: inherit` 下发，可见性由
组织与仓库设置决定，本仓库内的文件无法自证，改动时需要在设置页确认。

## 边界与残余风险

1. 应用层校验依赖 `config/repos.json`；修改该文件等价于修改授权范围。secret 的下发
   范围由组织与仓库设置决定，同样属于授权范围，两者都需要评审。
2. App 私钥的持有者可以冒充 bot 发布评论与触发业务仓 workflow。这是已知的残余身份
   风险；它不扩大模型 key 的可达范围。
3. `analysis` 的模型 key 确实存在于模型执行进程环境内，且两个 endpoint 的 key 同时
   可见。防线是输出扫描、最小环境只读工具执行器、出网白名单与轮换，而不是
   沙箱——模型执行步骤直接在宿主 runner 上运行，没有人工审批。
4. 执行发生在业务仓自己的 run 内：issue 内容、日志与 artifact 的可见性跟随业务仓，
   本仓库只发布执行器包。脱敏仍是尽力而为。
5. 单次运行以墙钟时间与 endpoint 冷却为刹车，不再有每 issue / 每仓库 / 全局的运行配额。
