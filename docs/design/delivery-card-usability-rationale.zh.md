# 「设置 → 插件 → 交付纪律」卡片可用性优化方案

> 状态：已实现并深度自检通过
> 目标读者：维护者
> 关联诉求：用户对「设置 → 插件」页提出的四项问题（多余字符、帮助入口位置、配置密度、信号词表规则、验收前置命令）。
> 关联任务：`task-34e93aae-18d4-458e-ba63-e72fdc36da99`

---

## 1. 背景与动机

「设置 → 插件 → 插件配置」页里的**交付纪律**卡片是用户调整交付门禁策略的唯一界面。它当前承载 14 个字段，全部单列纵向排列，且信号词表与验收命令的编辑规则只写在问号提示里。用户在实际使用中提出四项问题，其中第四项（验收前置命令）同时暴露了一个产品语义缺口。

## 2. 四项问题的现状

### 2.1 卡片底部多出一个 `)`

`packages/client/ui-settings-plugins/src/client/DeliveryCard.tsx:185` 在 `</PluginCard>` 之后多写了一个 `)`。它不在任何 JSX 表达式容器内，因此被 React 当作**文本子节点**渲染到卡片下方。对状态机、配置读写、门禁判定均无影响，是一处纯粹的笔误。

### 2.2 帮助入口单起一行

`PluginCard.tsx:88-97` 把帮助链接渲染为 body 内的第一个 `<p className={css.helpRow}>`，位于字段列表之前、单独占一行。而卡片头部已经有一行描述文案 `deliveryDescription`（「需求如何分级，以及每个级别要走完哪些阶段。」）。用户希望把「帮助」放在这行描述后面，让它读起来是这句描述的延伸，而不是一个独立区块。

需要区分的两个位置：
- `PluginCard.module.css` 的 `.description` 是**头部**里的描述（折叠时也可见）。
- `.helpRow` 是**展开后 body** 里的帮助行。

用户诉求是把帮助链接附着到描述文案尾部。由于头部整体是一个 `<button>`（展开/收起），而帮助链接本身也是按钮，把按钮嵌进按钮是无效 HTML 且破坏可达性。因此实现方式为：**展开后 body 的第一行**呈现「描述文案 + 帮助链接」同一行，链接紧随描述文本之后，不再单独占行。

### 2.3 配置密度过高

`fields.module.css` 的 `.field` 是 `display: flex; flex-direction: column`，14 个字段各自占满一行。用户希望每行放 2 个配置。

### 2.4 信号词表的命中规则未说明，且存在不可读词干

**匹配规则**（`packages/delivery/tool-delivery/src/grading.ts:132-139`）：列表逐条做**忽略大小写的子串包含**匹配（`text.includes(needle)`），每条命中计 1 次。因此：

- 词表项是**子串**而非正则，也不要求词边界。
- 大小写不敏感。
- 一条请求若同时包含多条词表项，**每条各计 1 次**；互相包含的词条会**重复计数**。

**计分规则**（`gradeObjective`，`grading.ts:240-247`）：目标文本长度超过 `specChars` → 直接 L2（不再扫描信号）；强信号 ≥1 → L2；中等信号 ≥2 → L2；中等信号 =1 或弱信号 ≥2 → L1；否则 L0。另有附加规则：含 3 条及以上编号项（如 `1、`）的需求额外计 **1 个中等信号**（`scanSignals`，`grading.ts:161`）。

**`replac` 是否正确**：`grading.ts:104` 中的 `'replac'` 是**有意为之的词干**，用于同时命中 `replace`/`replaced`/`replacement`/`replacing`。同表中还有 `deprecat`、`migrat`、`upgrad`、`optimiz` 等同类词干。**它在功能上是正确的**；真正的问题是它在界面上看起来像拼写错误。

关于「重复计数」，实测（对本仓库三个默认词表做两两包含检查）**没有发现任何互相包含的条目对**，因此默认词表不会因词干而重复计数。反过来，若把词干换成整词会更差：`replace` 匹配不到 `replacing`，而 `replace` 与 `replacement` 并存时会各自命中一次（`replace` 是 `replacement` 的子串），那才是真实的重复计数。因此正确做法是**保留词干**并在说明中解释它。新增条目时确实存在互相包含的风险，说明中一并提示。

用户诉求：说明「可以配置什么样的值」「如何增加配置」，并降低理解门槛。

### 2.5 验收前置命令支持什么、能否让用户选择

现状（`verification.ts:239-249` + `runPostHooks`：309-323）：`postHooks` 是**任意 shell 命令字符串**，经 `ctx.shell.run(ctx.shell.resolve({ command, workdir }))` 在会话工作目录执行，按 `exitCode === 0 && !timedOut && !aborted` 判定通过；任一条失败即阻止验证。L2 任务会**自动在列表最前面追加** `openspec validate <changeId> --strict --json`。因此当前支持的不只是 openspec 命令，而是任意 shell 命令（例如 `pnpm run lint`、`npx tsc --noEmit`）。

用户诉求：改为从「提示词命令」页已配置的命令中**勾选**（而非手写输入），因为普通用户不知道该输入什么；并且要保证 L2 的 `openspec validate --strict` 自动校验**不丢失**。

## 3. 关键取舍

### 3.1 「提示词命令」不是可执行命令——门禁语义必须换

这是本次改动最核心的事实。「提示词命令」页（`packages/client/ui-settings-commands`）编辑的是 `prompt-commands` settings 命名空间的 `commands` 列表，每个条目经 `@deepseek-ai/dsh-command-prompt-config` 注册为 `kind: 'prompt'` 的斜杠命令——它的 payload 是一段**提交给模型的用户消息文本**（`CommandDefinition.prompt`），**不是 shell 命令，执行后不产生 exit code**。

因此把验收依据改成「勾选的提示词命令」后，**原门禁赖以判定的「非零退出」不再存在**。原始 `postHooks` 的强承诺是「任何非零退出、超时或中止都会阻止验证，且不因模型确认完成而豁免」。若直接让模型执行提示词并自述完成，这道门禁会退化成一句口头承诺——这正是交付纪律本身要对抗的失败模式。

**已确认的取舍（用户选择「硬门禁」）**：选中提示词后，推进到「已验证」被阻止，并把这些提示词的验收要求注入给模型；模型执行完并**调用 `record_change` 记录验收结果**才放行。门禁的确定性来自「是否留下了验收记录」这一可机械检查的事实，而不是模型的措辞。

一个实现约束：`ToolRunContext.deferContext` 注入的上下文只在**成功路径**上被附加（`packages/core/tools/src/index.ts:1569-1578`；抛错走 catch 分支会丢弃）。所以「注入提示词 + 阻止推进」不能靠「抛错时顺便注入」。实现改为：**阻止推进的同时，把验收要求写进被抛出的门禁消息**（模型必定读到），并要求模型以 `record_change` 留下验收记录。

### 3.2 L2 的 `openspec validate` 保持不变

L2 自动追加的 `openspec validate <changeId> --strict --json` 属于**结构性校验**，与「用户想额外跑什么验收」是两件事。它保持在 Host 侧、仍由 `ctx.shell.run` 确定性执行，与新的提示词勾选互不替代。

### 3.3 字段废弃而非兼容

按仓库「预发布立场：地基优先于影响半径」，`postHooks` 从 `Config` schema 中**移除**，由新字段承载提示词命令名；不保留回退路径，旧值被忽略，同步更新测试与快照。

## 4. 目标行为

1. 卡片底部不再渲染 `)`。
2. 展开后首行为「描述文案 + 帮助链接」同一行，链接紧随描述，不再单起一行。
3. 短控件（枚举、开关、数字阈值）每行 2 个；多行文本域与标签编辑器整行占满。
4. 信号词表改为**可增删的标签式编辑器**（每条一个标签，可单独添加/删除），并补齐：匹配规则（忽略大小写、子串包含、每次命中计 1、编号列表计 1 中等信号）、可配置取值（任意中英文字符串）、如何新增（点添加、输入一条、确认），以及 `replac` 类词干的含义与重复计数风险。
5. 「验收前置命令」改为从提示词命令清单中勾选；Host 侧把选中命令的提示词交给模型执行，并新增「必须留下验收记录」的硬门禁；L2 的 `openspec validate --strict` 校验保留。

字段命名随之改为 `verificationCommands`（取提示词命令名），`postHooks` 按预发布立场直接移除、不做回退。

## 5. 影响面

- Client：`packages/client/ui-settings-plugins`（卡片、控件、locale、CSS）。
- Host：`packages/delivery/tool-delivery`（Config、门禁、验证）。
- 读取提示词命令的途径：Host 侧经 `ctx.settings` 读取 `prompt-commands` 命名空间；Client 侧经 `settingsScope` 读取同一命名空间。
- 文档：两处 package README、Agent Note、本方案。

## 6. 深度自检结论

按用户的四项诉求、本设计与 OpenSpec 拆分的场景逐条复核，并用**真实组合**（真实 settings 服务、真实 `command-prompt-config`、真实 settings mirror）而非仅手写 stub 验证：

- **跨命名空间读取在真实集成下可用。** 用真实 settings provider + 真实提示词命令插件验证：门禁消息确实携带来自 `prompt-commands` 分节的提示词正文，而不是 stub 里的假值；提示词命令插件缺席时门禁说明该命令没有正文，而不是静默放行。
- **客户端真实链路可用。** 客户端不能依赖 Host schema，此前客户端用例只用桩作用域，掩盖了「真实 mirror 下候选能否读出」这一问题。补测确认：真实序列化 schema 能通过 scope 的 `decode` 校验并让状态变为 `ready`，候选的确来自 Host 供应的分节。
- **用户改设置 → 门禁行为改变** 的完整闭环成立：未勾选时验证自由通过；经真实 settings 服务写入选择后立即阻止。
- **门禁不会永久卡死任务。** 已选命令在提示词命令页被删除后，门禁照常阻止并说明原因；模型记录该命令名即可通过。
- **L2 结构校验确实仍在跑**：实测执行 `openspec validate <changeId> --strict --json`，非零退出阻止验证并回注 issues。

自检中修正的缺陷：

1. **错误码名不副实。** `postHooks` 机制已移除，但结构校验失败仍抛 `DELIVERY_POST_HOOK_FAILED`。改名为 `DELIVERY_STRUCTURAL_VALIDATION_FAILED`，并把 `runPostHooks` 及相关消息改为结构校验语义。
2. **同一事实两处归属。** 卡片组件内重新计算了 controller 已算好的「已不在候选中的命令」，改为直接使用 controller 的投影，避免两处漂移。
3. **订阅早于 store 就绪。** 构造顺序改为先建 store 再订阅，防止源在订阅时同步推送而 `this.store` 尚未赋值。
4. **类型比实际值窄。** 候选的真实形状还带 `prompt`（scope 透传整份已校验分节），类型如实补齐。

经评估**不采纳**的一项：把验收命令的说明写进常开的系统提示。默认部署的 `verificationCommands` 为空（opt-in 且默认关闭），而门禁消息已在生效的精确时刻携带提示词正文；写进系统提示要为所有请求付 token 成本并改动 25 个快照，收益不足。

另经实测确认：真实 `command-prompt-config` 在注册期即拒绝空提示词，因此「提示词为空」的分支只能由自行注册 `prompt-commands` 命名空间的实现触发；该分支保留为结构防护。
