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

## 日志

- `crash-reports/crash-*.txt`：异常类型、堆栈最顶部的 `gregtech` 帧、涉及的方块/物品/配方。
- `logs/latest.log` / `logs/debug.log`：崩溃前后的 `ERROR` / `Exception` / `Caused by`，
  以及 GregTech 相关的注册、配方、网络包错误。
- `hs_err_pid*.log`：JVM 崩溃时看 `Problematic frame` 与线程栈。

## 分类

按上游 `docs/development/github-issue-tags.md` 的七轴体系分类。`issue_type` 只写类型轴，
`labels` 写其余轴；类型标签不要重复放进 `labels`。

判定顺序：

1. 先定类型：可复现的行为错误用 `bug`；单个物品、方块、配方或机器的小型改进用
   `enhancement`；跨系统、改变玩法/架构/规范/路线图、需要先讨论的提案用 `rfc`。
2. 再定性质：崩溃用 `crash`；上版本正常当前失效用 `regression`；卡顿、内存、启动或
   注册耗时用 `perf`；当前行为与原版不一致且希望保持一致用 `parity`；翻译用
   `translation`；体验优化用 `qol`；数值、成本或产出用 `balance`；纯内部调整用
   `refactor`。
3. 再定领域：按问题主体和修复面选 1–2 个；问题主体是机器、方块或物品时，除了
   `scope: ui` / `scope: interaction` 外，再加主体所在的 scope。
4. 最后定优先级：崩溃、数据丢失或主要功能不可用用 `priority: high`；一般功能性错误用
   `priority: medium`；有临时方案、外观或文本等次要问题用 `priority: low`。无法判断时，
   体验优化与信息展示按 `low`，一般功能性错误按 `medium`。

### 类型（`issue_type`，必填，恰好一个）

| 值 | 适用 |
|---|---|
| `bug` | 可复现的行为错误、崩溃、回归、性能退化、与原版不一致、翻译错误 |
| `enhancement` | 小型、可直接执行的功能请求或改进 |
| `rfc` | 需要先讨论、后决定的系统、玩法、架构、规范或路线图提案；单个物品、流体、配方、机器的小型新增用 `enhancement` |
| `unknown` | 证据不足，无法判断 |

### 性质（`labels`，0–2 个）

| 标签 | 适用类型 | 判定 |
|---|---|---|
| `crash` | bug | 崩溃、无法启动或卡死 |
| `regression` | bug | 上个版本正常、当前版本失效 |
| `perf` | bug | 卡顿、内存、启动或注册耗时 |
| `parity` | bug / enhancement / rfc | 与 1.7.10 原版 GT6 行为不一致 |
| `translation` | bug / enhancement | 翻译缺失、错误或硬编码 |
| `qol` | enhancement | 信息展示、操作便利、减少重复劳动 |
| `balance` | enhancement | 数值、难度、成本或产出平衡 |
| `refactor` | enhancement | 重构、清理、内部实现调整，不改变对外行为 |

`parity` 只用于“当前行为与原版不一致”的情况：希望保持一致用 `bug` + `parity`；希望改变
行为用 `enhancement` / `rfc` + `parity`。以下情况不要用 `parity`：

- issue 明确说“原版也有同样问题”；
- 当前行为与原版一致，只是希望改变原版行为；
- 原版没有的系统、物品、实体，或只是其他模组/版本有类似功能。

`enhancement` 通常至少带一个性质：体验优化用 `qol`，数值、成本或产出调整用 `balance`，
内部调整用 `refactor`；只有确实没有合适性质时才留空。单个方块或物品的行为调整用
`enhancement`，即使需要改变原版行为，也不要用 `rfc`。

### 领域（`labels`，0–2 个）

| 标签 | 范围 |
|---|---|
| `scope: recipe` | 配方、配方表、砧与模具配方 |
| `scope: machine` | 机器、多方块、坩埚、核与传感器 |
| `scope: interaction` | 通用交互层：右键、放置、破坏、物品使用 |
| `scope: ui` | GUI、tooltip、Jade/EMI/JEI 展示、模型、贴图与渲染 |
| `scope: logistics` | 管道、漏斗、轨道、储物、物流核心与覆盖板 |
| `scope: equipment` | 装备与手持物品：工具、武器、护甲、防护装备、便携容器及其行为 |
| `scope: worldgen` | 矿脉、矿层、地表沉积、结构、群系与维度生成 |
| `scope: material` | 材料注册、ID、形态、成分、统一化与流体属性 |
| `scope: energy` | 电网、电力线缆、锅炉、涡轮、引擎、轴与电池 |
| `scope: redstone` | 红石行为 |
| `scope: hazard` | 危害与伤害机制、伤害类型、伤害免疫与防护 |
| `scope: compat` | 其他模组、加载器、附属与可选集成 |
| `scope: api` | 附属 API、公开契约、SPI 与 API 版本 |
| `scope: build` | Gradle、CI、工具脚本、文档与仓库流程 |

容易混淆的边界：

- `scope: recipe` 管配方是否存在、是否匹配、成本多少；配方执行时的机器 tick 归
  `scope: machine`。
- `scope: equipment` 管装备物品自身的行为与属性；通用交互分发归 `scope: interaction`。
- `scope: hazard` 管伤害、免疫与防护机制；产生危害的机器归 `scope: machine`，材料的
  危害属性归 `scope: material`。
- `scope: redstone` 管红石行为；覆盖板、机器输入输出等非红石行为归各自 scope。电力
  线缆归 `scope: energy`；物品/流体管道归 `scope: logistics`。
- `scope: ui` 管 GUI、tooltip、模型与渲染；世界内的右键、放置、破坏归
  `scope: interaction`。
- 配方输入被拒绝时，配方定义归 `scope: recipe`，执行输入的机器/方块归 `scope: machine`
  或 `scope: logistics`。配方产出或成本差异归 `scope: recipe`；只有机器执行逻辑
  （tick、能量、处理时间）错误才归 `scope: machine`。熔炉等单方块机器的配方产出差异
  归 `scope: recipe`，不要因为执行者是机器就加 `scope: machine`。
- 问题主体所在的方块、机器或物品也要加对应 scope，即使问题表现为 UI；例如筛粉漏斗的
  tooltip 用 `scope: ui` + `scope: logistics`。
- 机器自身的功能或行为，包括用扳手触发的机器功能，归 `scope: machine`；只有交互分发层
  无响应才归 `scope: interaction`。
- 展示工具或装备的材料属性时，数据主体是装备，用 `scope: equipment`；材料注册、属性
  定义本身的问题才用 `scope: material`。
- 地表散落物的外观识别归 `scope: ui`；只有生成位置、数量或分布错误才归
  `scope: worldgen`。
- 材料/岩石变体的统一化与互相转换归 `scope: material` + `scope: recipe`；只有生成位置、
  分布、数量错误才归 `scope: worldgen`。

超过 2 个领域时只保留主领域，并在 `conclusion` 或 `root_cause` 说明其余领域。

### 分流状态（`labels`，0–1 个）

- `needs info`：缺少复现步骤、日志、版本或模组列表，无法继续判断。
- `needs help`：需要社区协助、讨论或维护者决定。

不要输出 `needs triage`；它由触发流程维护。

### 优先级（`labels`，0–1 个）

- `priority: high`：崩溃、数据丢失或主要功能不可用。
- `priority: medium`：一般的功能性错误，影响正常玩法但没有达到崩溃或主要功能不可用。
- `priority: low`：有临时方案、外观或文本等次要问题；掉落率/概率、产量或单条配方的
  产出/成本差异，tooltip 与行为不一致，以及不影响主要玩法的便利性转换配方，也归此类。
  配方输入被拒绝、配方无法执行属于功能性错误，用 `priority: medium`。

### 游戏版本（`labels`，0–1 个）

- `1.20.1`：Minecraft 1.20.1 + Forge 47.x。
- `1.21.1`：Minecraft 1.21.1 + NeoForge 21.1.x。

只写 issue 实际报告的版本；没有写就留空，不要猜。

### 常见组合

- 缺转换配方、掉落率不符、单条配方的产出/成本差异：`bug` + `scope: recipe` +
  `priority: low`。
- 原版有、当前缺失的转换配方：`bug` + `parity` + `scope: recipe` + `priority: low`。
- 改变配方或机器的材料消耗、产出或成本：`enhancement` + `balance` + 对应 scope。
- 工具或装备的掉落率、概率不符：`bug` + `parity` + `scope: equipment` + `priority: low`。
- 电力线缆的渲染/连接问题：`scope: energy` + `scope: ui`；不要用 `scope: logistics`。
- 体验优化、信息展示、减少重复劳动：`enhancement` + `qol` + 对应 scope。
- 新增单个物品、流体、配方或机器：`enhancement` + 对应 scope；跨系统提案才用 `rfc`。
- EMI/JEI/Jade 展示装备属性：`scope: ui` + `scope: equipment`；如果主要工作是集成，
  用 `scope: compat` 替代 `scope: equipment`。

### 不要输出

- 类型标签（`bug`、`enhancement`、`rfc`）不要放进 `labels`，类型只写在 `issue_type`。
- `needs triage`、`duplicate`、`invalid`、`out of scope`、`wontfix`、`bot:stop` 不写入
  `labels`；关闭原因由维护者在关闭时处理。
- 不在上表内的标签一律不写。

## Markdown 格式

- 在结论、证据、用户建议和修复方案中，类名、方法名、字段、枚举、路径、标签、版本、
  加载器名、日志关键字使用行内 code，例如 `CrucibleFaucetBlock.toolInteraction`、
  `core/src/main/java/.../CrucibleFaucetBlock.java:74-76`、`autoPull`、`FACING`、
  `v1.0.4`、`1.21.1`。
- `ai_fix_hint` 保持纯文本，不使用行内 code；渲染器会把它放入 `text` 代码块。
