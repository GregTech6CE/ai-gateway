# GregTech6 仓库规则

## 项目

- 项目：GregTech6CE/GregTech6（GT6CE），Minecraft 1.20.1 Forge 与 1.21.1 NeoForge。
- 代码来源按 issue 的 mod 版本对应 tag（`v{version}`）；找不到时回退 `master`。
- `code/current/` 是主版本，`code/<ref>/` 是额外版本。

## 代码布局

- Java 主代码：`core/src/main/java/...`。
- API：`api/common/src`、`api/minecraft/src`。
- Minecraft/加载器适配：`minecraft/src/main/java/...`、`minecraft/versions/<version>/...`。
- 翻译：`core/src/main/resources/assets/gt6ce/lang/{en_us,zh_cn}.json` 与
  `TranslationKeys.java`。
- 只引用真实存在的文件与行号，格式 `path:line`。

## 日志与类型

- `crash-reports/crash-*.txt`：异常类型、堆栈最顶部的 `gregtech` 帧、涉及的方块/物品/配方。
- `logs/latest.log` / `logs/debug.log`：崩溃前后的 `ERROR` / `Exception` / `Caused by`，
  以及 GregTech 相关的注册、配方、网络包错误。
- `hs_err_pid*.log`：JVM 崩溃时看 `Problematic frame` 与线程栈。
- `crash`：有崩溃报告或 JVM 崩溃；给出触发链路与最小修复点。
- `bug`：可复现的行为错误；给出相关代码路径。
- `parity`：与原版 1.7.10 GT6 行为差异；同时说明原版行为与当前行为。
- `translation`：给出 key、当前译文、建议译文；不需要日志。
- `enhancement` / `question`：按代码现状回答可行性与影响面。

## Markdown 格式

- 在结论、证据、用户建议和修复方案中，类名、方法名、字段、枚举、路径、标签、版本、
  加载器名、日志关键字使用行内 code，例如 `CrucibleFaucetBlock.toolInteraction`、
  `core/src/main/java/.../CrucibleFaucetBlock.java:74-76`、`autoPull`、`FACING`、
  `v1.0.4`、`1.21.1`。
- `ai_fix_hint` 保持纯文本，不使用行内 code；渲染器会把它放入 `text` 代码块。

## 标签

`labels` 只能从以下集合选择：

`bug`、`crash`、`parity`、`translation`、`needs info`、`needs triage`、`1.20.1`、`1.21.1`。
