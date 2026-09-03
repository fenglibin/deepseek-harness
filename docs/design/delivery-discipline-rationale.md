# 交付纪律子系统（Delivery Discipline）方案

> 状态：决策已对齐，待最终确认（编码暂缓）
> 目标读者：维护者与决策者
> 关联诉求：为每个执行的任务引入「变更记录 + 设计方案 + openspec 任务拆分 + 验证验收 + 后置自检 + 程序化门禁 + 页面呈现 + 配置化」的强制工程流程。

---

## 1. 背景与动机

DeepSeek Harness 是一个纯插件化的 Cordis agent harness。模型（LLM）在默认情况下对任务的执行是**自由且无约束**的：它可以直接改代码、直接声称"完成"，而不产生任何设计、拆分、变更记录或验证证据。这带来三类风险：

1. **不可追溯**：任务做完了，但"为什么这么做、改了什么、是否覆盖了需求"没有留痕。
2. **不可验证**：LLM 会偷懒——只保证"代码没报错"，不保证"功能在业务/需求层面真的正确"。纯 prompt 约束（"请自检"）不可靠，因为 LLM 可以口头应承而不实际执行。
3. **不可控**：大改动和小修复走同一条自由路径，没有按规模分级的强制流程，也没有可配置的开关让 token 充裕/匮乏的用户各取所需。

本方案在 harness 之上引入一套**工程交付纪律（delivery discipline）子系统**，用「程序性验证 + 可配置门禁 + 可视化呈现」对抗 LLM 偷懒，强制任务按 `设计 → 拆分 → 实现 → 验证 → 验收 → 后置自检` 闭环执行。核心原则是：**流程约束不能只依赖 LLM 自觉，必须由程序（状态机 + 校验脚本 + 外部工具）强制执行。**

---

## 2. 目标

- 为每个执行的任务建立可追溯的产物（变更记录 / 设计 / 拆分），落到项目工作目录下。
- 用**程序性门禁**保证任务不能跳过必需阶段、不能被错误地标记为"完成/验收"。
- 支持**任务完成后执行后置命令**，驱动更多验证动作（如深度自检、全量回归、openspec validate）。
- 全部能力**可配置**：阈值（多大任务写设计/拆分）、开关（是否强制 openspec）、后置命令列表，适配不同 token 预算的用户。
- 全流程**可视化**：不同阶段在页面上有对应呈现，用户能感知进度与门禁状态。
- 复用成熟生态（真实 openspec），不重复造轮子。

## 3. 非目标

- 不改变 agent-loop 本身（遵循"Plugins, not loop changes"）。
- 不重新实现一套 spec/任务拆分格式——复用 openspec。
- 不提供跨会话/跨项目的任务数据库——任务与产物以项目工作目录为单位，会话内状态走 session log。
- 不负责 token/货币/时间的精确预算（那是独立策略层，与 goal 的 round cap 同类）。
- 第一阶段不做强制拦截子代理（subagent/workflow 子任务）的门禁，默认只约束根 agent 的任务。

---

## 4. 现状分析

### 4.1 既有可复用能力

| 能力 | 包 | 与本方案的关系 |
|---|---|---|
| 持久化单目标 | `dsh-goal` + `dsh-goal-round-driver` | 任务生命周期参照物；round cap 续跑语义与"后置命令"重叠，需厘清边界 |
| 计划模式 | `dsh-plan-mode` | "guidance not enforcement"，是设计态的软参照，非强制门禁 |
| 任务清单 | `dsh-tool-todo` | whole-list replace、单 owner，粒度太粗，不适合做 openspec 拆分 |
| 工作流编排 | `dsh-workflow` | 子代理 fan-out，可用于"后置验证"的多路并行 |
| 用户设置 | `dsh-settings` + `dsh-settings-file` | 门禁阈值/开关的运行时配置载体 |
| 会话投影 | `dsh-session-projection` | 严格 replay，是页面呈现的载体 |
| 运行时断言 | `ctx.invariants` | 程序性验证的强地基 |
| 工作区 | `dsh-workspace` | host-only 项目分组，不面向模型，不作为产物落盘依据 |

### 4.2 关键架构约束（决定方案骨架）

1. **模型可见 ⟺ 已记录**：任何进入模型请求的内容必须能从 session log 重建。变更/设计/拆分是模型通过 `fs` 工具写到磁盘的，**磁盘文件不是 session log**，必须设计"磁盘产物如何投影进 log"。
2. **enforcement 哲学偏软**：`plan-mode` 是 guidance，`guard/*` 是 advisory，真正 enforce 靠 sandbox + approval。本方案要的"程序性强制门禁"是**新范式**，但 `tools/post-execute` 的 `PostToolDecision` 已支持 blocking，`agent/turn-stopping`、`agent/pre-step`、`ctx.invariants` 均可作为强制点。
3. **harness home 是 `~/.dsh`**（`dsh-home-paths`，可 `$DSH_HOME` 覆盖）。与"项目工作目录下的 `.dsh`"同名不同位，需显式区分。
4. **capability seam 三角色**：Service Definition / Provider / Consumer 必须齐全。

### 4.3 真实 openspec 的调研结论

- 目录固定为**项目根下的 `openspec/`**，不支持自定义根目录（无 `spec-dir`/`root` 配置）。
- 结构：`openspec/specs/<capability>/spec.md`（正式规格）+ `openspec/changes/<name>/`（活跃变更）+ `openspec/changes/archive/`（归档）。
- 一个 change 目录**天然四位一体**：`proposal.md`（变更意图）+ `design.md`（技术方案）+ `tasks.md`（checkbox 任务清单）+ `specs/`（delta spec，`ADDED/MODIFIED/REMOVED/RENAMED Requirements`，`### Requirement` + `#### Scenario` + `SHALL/MUST`）。
- CLI：`openspec init` / `list` / `validate [--strict]` / `archive` / `show` / `config` 等。
- 配置：`openspec/config.yaml`（`schema` / `context` / `rules` / `operations`）。

**结论**：引入真实 openspec 后，用户诉求里的"变更记录、设计方案、任务拆分"在 L2 大任务场景已被 openspec 的一个 change 目录统一承载，`.dsh/` 目录只需承载 openspec 之外的轻量产物。这正是"复用成熟能力"的红利。

---

## 5. 方案对比与选型

### 方案 A：独立「交付纪律」capability seam（选定）

新增包族 `packages/delivery/`，严格遵循三角色：
- **Service Definition**：交付门禁接口 + 阶段状态机 + 配置 schema + `delivery/*` 事件。
- **Provider**：默认实现，读 `.dsh/` 与 `openspec/` 产物做程序性验证 + 基于 session log 的严格 replay 状态机。
- **Consumer**：模型工具（记变更/写设计/写拆分/提交验收）+ 门禁拦截（`turn-stopping` 软 + `pre-execute` 硬）+ client UI（projection + conversation node）。

### 方案 B：组合既有能力 + 薄门禁层（否决）

复用 goal（任务）+ plan-mode（设计）+ tool-todo（拆分）+ workflow（验证），只新增 guard 插件。否决理由：`tool-todo` 是 whole-list replace 不适合 openspec 拆分；`plan-mode` 是 guidance 无法强制；强行扭曲三者的语义会制造大量兼容债务。

### 方案 C：MVP 最小层先行（否决）

只做「变更记录 + 后置命令 + 自检脚本」。否决理由：无 domain 模型，后续补设计/拆分必然重构，成本更高。

**选型结论**：方案 A + 分阶段实施。架构上先立好 seam 与 domain 模型，功能按批次增量落地。

---

## 6. 推荐方案详解

### 6.1 领域模型：交付任务（Delivery Task）与规模分级

引入一个轻量的 **DeliveryTask** 工作单元（锚定用户所说的"每个执行的任务"），而非复用 goal：

- **唯一 id**（`Branded`），会话内归属。
- **规模分级**（由程序化度量 + 配置阈值决定，见 6.4）：

| 级别 | 判定 | 必经阶段 | 产物 |
|---|---|---|---|
| L0 小微修复 | 低于 design 阈值 | `created → implemented → verified → accepted` | `.dsh/changes/` 一条变更记录 |
| L1 稍大需求 | ≥ design 阈值，< openspec 阈值 | `created → designed → implemented → verified → accepted` | `.dsh/design/` 设计 + `.dsh/changes/` 变更 |
| L2 大需求/非小微 bug | ≥ openspec 阈值，或强制 bug 修复 | `created → designed → specified → implemented → verified → accepted` | openspec change（proposal+design+tasks+specs）+ `.dsh/changes/` 变更 |

- **阶段状态机**（可扩展，merge-extensible 默认分支走 `assertNever` 的闭集）：

```text
created → designed → specified → implemented → verified → accepted
```

状态迁移是 **compare-and-set（CAS）** 的：迁移到某阶段前，程序校验前置产物存在且有效，不满足则拒绝写入。

### 6.2 目录布局（含 openspec 原生目录的协调）

```text
<project>/                        # 项目工作目录（模型 fs 工具的 cwd）
├── openspec/                     # 真实 openspec（L2 任务），用原生目录
│   ├── config.yaml
│   ├── specs/
│   └── changes/
│       ├── <change-name>/
│       │   ├── proposal.md
│       │   ├── design.md
│       │   ├── tasks.md
│       │   └── specs/
│       └── archive/
└── .dsh/                         # dsh 自身交付产物（L0/L1 任务）
    ├── design/                   # L1 设计方案
    └── changes/                  # 全部任务的变更记录（含 L2 的索引）

~/.dsh/                           # harness home（通用设置，已存在）
```

**协调说明（已确认）**：真实 openspec 固定项目根 `openspec/` 目录，不支持自定义根。故 L2 任务使用项目根原生 `openspec/`，`.dsh/` 承载 openspec 之外的轻量产物，并在 `.dsh/changes/` 里为每个 L2 任务留一条指向对应 openspec change 的索引记录，保证"每个任务都有变更记录"不落空。符号链接 `.dsh/openspec` 方案已否决（跨平台与 git 友好性差）。

### 6.3 程序性验证机制（双保险）

1. **运行时状态机守门（主闸）**：
   - 用 `ctx.invariants` 断言状态迁移的合法性（前置产物存在、阶段顺序不跳步）。
   - 用 `agent/pre-step` / `agent/turn-stopping` 做**软提醒**：任务处于某阶段但缺前置产物时，注入提醒上下文，不 veto 模型探索。
   - 用 `tools/pre-execute` 的 `PostToolDecision` blocking 做**硬拦截**：仅拦截"把任务标记为 completed/accepted"这一类收尾动作（不拦截探索性工具调用，避免误伤）。
2. **后置命令（后置闸）**：任务完成后执行配置的验证命令（如 `openspec validate --strict`、自定义深度自检脚本、全量回归），全绿才允许进入 `accepted`。后置命令失败则任务停留在 `verified` 并回注修复指令。

### 6.4 配置 schema（可配置阈值/开关）

通过 `dsh-settings` 命名空间 + cordis `config` 双载（composition base + 运行时可改）：

```yaml
- name: '@deepseek-ai/dsh-delivery'
  config:
    enabled: true                    # 总开关
    designThreshold:                 # 触发 L1 的规模度量（程序化 proxy）
      todoCount: 5                   #   todo 项数
      descriptionChars: 300          #   任务描述字符数
      touchedFiles: 3                #   预估改动文件数
    openspecThreshold:               # 触发 L2 的规模度量
      todoCount: 15
      descriptionChars: 1200
    requireOpenspecForBugs: true     # 非小微 bug 修复是否强制 L2
    postHooks:                       # 后置命令
      - 'openspec validate --strict'
      - 'pnpm run test'              # 可替换为自定义深度自检
    enforcement: 'stateful'          # 'stateful' | 'advisory' | 'off'
```

- **规模 proxy 说明**：任务开始前"规模"无可靠信号，故用程序化可度量的 proxy（todo 数、描述长度、改动文件数）做**启发式分级**，并在任务进行中可被显式升/降级（模型或用户手动手动覆盖），避免"误判简单任务为复杂流程"。
- **`enforcement` 分档**：`off` 纯自由；`advisory` 只提醒不拦；`stateful` 状态机硬约束 + 边界软提醒（默认，已确认）。
- **后置命令可覆盖**：`postHooks` 来自配置基线，任务运行时允许用户追加/覆盖命令；最终以任务级配置为准。

### 6.5 事件与 session log 投影

- 新增 `delivery/task-created`、`delivery/task-phase-changed`、`delivery/artifact-written` 等 durable session event（声明合并进 `SessionEventMap`）。
- **"磁盘产物如何进 log"**：模型写 `.dsh/` 或 `openspec/` 文件时，通过监听 `fs/*` 事件（或 `tools/post-execute` 识别写文件工具调用）投影出 `delivery/artifact-written` 事件，使门禁状态机在 session log 内可重建，满足"模型可见 ⟺ 已记录"。
- 注册 `delivery` session projection 单元，client view 暴露当前任务的分级、阶段、产物清单、门禁状态。

### 6.6 页面呈现（分阶段可视化）

- 新增 `delivery` projection → client 消费：
  - **会话侧边栏/卡片**：当前任务的 L0/L1/L2 分级徽标 + 阶段进度条（created → … → accepted）。
  - **Conversation node**：任务创建、阶段迁移、门禁通过/失败、后置命令结果作为可折叠节点呈现。
  - **产物视图**：`.dsh/` 与 `openspec/` 产物的只读预览。
- 复用 `dsh-plan-mode` 的 reviewed-exit 呈现模式，门禁"提交验收"走类似 review 交互。

### 6.7 与既有能力的边界

- 与 `goal`：goal 是"同一会话单一长期目标 + 自动续跑"；DeliveryTask 是"单次任务的交付纪律 + 门禁"。两者可并存：一个 goal 下可串行产生多个 DeliveryTask。后置命令触发的"深度自检"是**一次有界验证**，不是 goal 的无限续跑轮次。
- 与 `workflow`：后置命令若需多路并行验证（如并行 review 多个文件），可用 workflow 编排，但默认是串行命令列表。

---

## 7. 分阶段实施批次

每批独立可验证、可回滚，配置开关控制启用。

| 批次 | 内容 | 产物 | 验收标志 |
|---|---|---|---|
| B1 | 包族骨架 + DeliveryTask domain + 状态机 + `delivery/*` 事件 + 配置 schema + `.dsh/changes` 变更记录工具 + 门禁（stateful/advisory 两档） | 变更记录闭环 | L0 任务能强制落变更记录，状态机拒绝跳步 |
| B2 | `.dsh/design` 设计方案工具 + 规模分级（proxy + 手动覆盖）+ designThreshold 门禁 | L1 设计闭环 | 稍大任务强制写设计 |
| B3 | 真实 openspec 集成（change 创建/校验/归档）+ openspecThreshold 门禁 + `openspec validate` 接入后置命令 | L2 拆分闭环 | 大任务走 openspec 全流程，validate 全绿才 accepted |
| B4 | 后置命令框架（postHooks 执行 + 失败回注）+ 深度自检驱动 | 后置自检闭环 | 任务完成后自动跑配置命令并据此验收 |
| B5 | session projection + client UI（分级徽标/阶段进度/产物预览/门禁节点）+ 配置设置卡片 | 可视化闭环 | 页面能完整呈现各阶段与门禁状态 |

---

## 8. 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| 强制门禁误伤简单任务 | 简单修复被迫走复杂流程 | 规模分级 proxy + 手动覆盖 + `enforcement` 分档 |
| "磁盘产物投影进 log"破坏 session log 纯度 | 违反架构约束 | 用 `fs/*` 事件投影为 durable event，而非门禁直接读磁盘做运行时判断 |
| 硬门禁违背"guidance/enforcement 分离"哲学 | 被核心维护者质疑 | 默认 `stateful` 只拦"收尾动作"，不 veto 探索；方案文档正面论证 |
| openspec 目录与 `.dsh/` 冲突 | 用户心智混淆 | 6.2 协调说明 + UI 明确区分两目录 |
| token 成本显著增加 | 设计/拆分/验证成倍耗 token | 配置开关 + 分级阈值，L0 最小化开销 |
| 规模 proxy 不可靠 | 分级误判 | 手动升降级覆盖 + 分阶段演进 proxy 精度 |
| openspec CLI 外部依赖 | 环境缺 CLI 则 L2 不可用 | `openspecThreshold` 开关 + 缺 CLI 时 fail loud 提示 |

**回滚**：每批独立，`enabled: false` 即整体关闭；包族独立挂载，卸载即移除能力，不改 agent-loop，不污染既有 session 事件格式（新增 `delivery/*` 事件带 `ignorable: true` 语义，旧构建可忽略）。

---

## 9. 已确认决策（Decision Log）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | openspec 目录位置 | 项目根原生 `openspec/`（非 `.dsh/` 下），`.dsh/changes/` 为每个 L2 任务留索引指向对应 change |
| 2 | 任务锚点 | 新增 `DeliveryTask` domain，不复用 `goal` |
| 3 | 门禁强度默认值 | `stateful`（状态机硬约束 + 边界软提醒） |
| 4 | 后置命令执行权 | 任务完成后由门禁框架自动执行 postHooks 并据结果验收；允许用户在运行时追加/覆盖命令 |

---

> 本文档待确认后进入实施；实施中的每批变更将另落 `.agents/notes/` Agent Note 与测试，遵循仓库现有约定。
