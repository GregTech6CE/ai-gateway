# 文档

面向维护本仓库的开发者。目标是让改动者在不读实现的情况下，判断一次改动的授权影响、
调度影响与产物影响。

## 索引

| 文件 | 回答的问题 |
|---|---|
| [AGENTS.md](AGENTS.md) | 文档怎么写：公开面约束、面向开发者的写法、Job 小节格式 |
| [auth.md](auth.md) | 谁可以触发、触发被如何校验、本仓库可以写什么 |
| [dispatch.md](dispatch.md) | 调用方与本仓库之间的参数契约、run 语义与失败判定 |
| [jobs/bug-issue-analysis.md](jobs/bug-issue-analysis.md) | 一次 bug issue 分析经过哪些 job、产出什么、如何中止 |
| [knowledge-base/codex.md](knowledge-base/codex.md) | Codex CLI 的调用形态、事件流、会话续接与配置覆盖 |

根 `AGENTS.md` 是改动约束与安全规则的入口，本目录的 `AGENTS.md` 只管文档写法。

## 文档边界

一份设计事实只写在一处：授权写在 `auth.md`，参数与 run 语义写在 `dispatch.md`，
job 内部步骤写在各 job 文档。其余文档只引用，不复述。

`knowledge-base/` 记录外部工具自身的事实（版本、命令、协议），不描述本仓库设计；引用它
的文档应给出结论，而不是让读者自己去翻。

写入前确认：这条信息能否只凭本公开仓库核对。不能核对的，用名称或机制表述，或删除。

## 写作约定

写法以本目录的 `AGENTS.md` 为准，此处不重复。索引层面另有两条要求：

- 新增文档必须同时加入上面的索引，并说明它回答什么问题。
- 文档标题与文件名保持稳定；改主题时新建文件，不挪用旧文件名。

## 扩展点

新增托管仓库：

1. 在 `config/repos.json` 增加 `owner/name` 键（小写，大小写不敏感匹配），声明
   `enabled`、bot 身份、代码来源与标签白名单；未列出的仓库 fail-closed。
2. 视需要新增 `prompts/repos/<profile>/` 覆盖，并把 `prompt_profile` 指向它；
   profile 名只允许 `[a-z0-9_-]`。
3. 在调用方仓库放置触发 workflow，参数以 `templates/trigger.yml` 为准。
4. 收敛写回权限：`finalize` 里的 App token 签发参数、App 安装范围与仓库可见性三者必须
   同时覆盖新仓库，否则 `config/repos.json` 放行但写回 403。
5. 确认该仓库公开：公开本仓库拒绝处理私有 issue 仓库。

新增模型 endpoint：

1. 在 `config/models.json` 的 `endpoints` 增加条目，写清 `base_url`、`api_key_env`、
   `model` 与 `wire_api`。
2. 在 `roles.analysis` 增加绑定，给出 `context`、`effort` 与 `weight`；`weight` 决定相对
   调用频次（之比即长期选择次数之比），缺省为 1；待机时长按一个月封顶。
3. 在 `llm` environment 补齐同名 secret；缺 key 时该 endpoint 被记为失败并跳过。

两者的共同要求：不要为了接入方便放宽任何 fail-closed 分支，不要在配置里写凭据值。
