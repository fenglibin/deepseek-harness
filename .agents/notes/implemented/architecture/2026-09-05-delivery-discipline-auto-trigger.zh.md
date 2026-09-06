# Agent Note：交付纪律自动触发

状态：已实现

## 问题

交付纪律（批次 B1–B5）已交付任务域、前向状态机、记录工具、产物持久化、后置命令与客户端 UI，但其中每一项都只有在模型自愿调用 `create_delivery_task` 之后才会生效。没有任何程序化机制去检测一个大需求并启动任务，所以模型可以通过干脆不创建任务而绕过整套纪律。一次真实会话证明了这一失效：一个大需求（"图片与文字混合输入"）走到了 `docs/design/` 下手写设计文档，而 delivery 工具调用次数为 0。

## 决策

`@deepseek-ai/dsh-tool-delivery` 现在以两层协同自动启动纪律。

- **Rubric 驱动的模型判定。** `create_delivery_task` 工具描述与 `tool:delivery` 系统提示词段携带一套规模判定 rubric——强信号 S1（结构契约变更）与 S4（非小微 bug 或风险/不可逆变更）分级为 `l2`；强信号 S2（跨端或 ≥3 个包）与 S3（完整功能或大重构）分级为 `l1`；两个及以上弱信号（W1 ≥2 个设计决策、W2 ≥3 个子任务、W3 多角色协同）分级为 `l1`；否则 `l0`。这套 rubric 把"这个需求大不大"翻译成模型可勾选的客观信号。
- **`agent/pre-step` 的机械地板。** 一个 waterfall 监听器兜底模型漏判：当无当前任务、存在直接人类请求、且拼接后的请求文本达到 `designThreshold` 时，用推断的分级与请求文本作为 objective 调用 `ctx.delivery.create()`。监听器幂等（存在任务或文本过短即短路），且永不阻塞步骤——失败只记录警告并落到 `next()`。
- 配置新增 `autoDetect`（默认 `true`）；关闭它即移除监听器。

## 备选方案

**仅强化系统提示词。** 否决：会话证据已证伪——模型忽略了既有指令，且仅靠提示词的起点重新引入了设计所禁止的 LLM 自觉。

**在消息准入处自动创建。** 否决：会话控制器是 API 平面，且一个需求的规模在数条消息到达前不可知。

**在 `agent/turn-stopping` 软提醒。** 否决：提醒不是启动，模型可以像今天忽略提示词一样忽略它。

## 后果

- **获得** 交付纪律的程序化起点：大需求无需模型配合即创建任务，且模型自己的判定由 rubric 驱动而非猜测。
- **代价** 工具包新增一个 `agent/pre-step` 监听器，以及 `@deepseek-ai/dsh-session` peer 依赖（用于 `UserMessage` 类型）。监听器解析一次当前任务即短路，因此每步开销仅一次 map 读取。
- **延后** 默认 `postHooks` 基线与 openspec `tasks.md` checkbox 检查；验收门禁（C2）与自动变更记录（C3）已落入 [acceptance-gate note](2026-09-05-delivery-discipline-acceptance-gate.zh.md)。
