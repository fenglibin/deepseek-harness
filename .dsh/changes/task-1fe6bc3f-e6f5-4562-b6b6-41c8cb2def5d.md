- [revision 5] 实现完成。改动面两个包（Host 的 tool-delivery、Client 的 ui-settings-plugins），外加文档与 Agent Note。

D1/D2 l0 纳入与替换：pre-step 监听器的建任务条件由「level 为 l1/l2」改为「一律建」，判为 l0 时仍注入一次 GRADING_RUBRIC（每 turn 至多一次），使模型能提高分级。新增 createReplacingL0(ctx, agent, objective, level)：当前任务是 l0 时先 ctx.delivery.clear 再 create，非 l0 时抛 DELIVERY_TOOL_TASK_EXISTS 并说明只有 l0 可被替换。pre-step 与 create_delivery_task 共用它，因此模型显式提高分级与自动路径行为一致。

过程中自查并修复了初稿里的一处真实缺陷：我最初只改了 pre-step，并在 rubric 相关注释里声称「模型可以替换 l0 任务来提高分级」——但 create_delivery_task 当时仍直接调 ctx.delivery.create，对任何非 accepted 当前任务都抛错，该说法不成立。抽出 createReplacingL0 并接到 create_delivery_task 才让注释与行为一致。

另修掉一处我自己引入的不可达分支（else if (current === undefined) 位于 current === undefined || replaceable 之后）与一次误删接口首行的编辑事故。

D3 l0 豁免：checklistGap 与 requirementCoverageGap 未改动，l0 仍只经「验收命令」这一道。

D4 顺序门禁：verification.ts 的 acceptanceGap 返回类型由 readonly string[] 改为 AcceptanceGap | undefined（{ name, position, total }），只返回配置顺序中最早未记录的那条；acceptanceRequirementMessage 相应重写，消息写明「acceptance command N of M」、剩余条数与那一条的提示词正文。调用点由 missingAcceptance.length > 0 改为 acceptance !== undefined。

D5 客户端：DeliveryCardState 新增 verificationSelected；verificationCandidates 改为只含未选中命令；DeliveryCardFace 新增 moveVerificationCommand(name, to)（越界 clamp、原地或未选中即忽略，因此无操作不会把卡片标脏）。DeliveryCard 的 VerificationCommands 重写为「已选顺序列表（序号 + 拖动 + 键盘上移/下移 + 移除）+ 候选勾选（勾选即追加末尾）」，新增 12 个 locale 键与一组 CSS 类。使用仓库已有的 IconChevronUp/Down/Close 与 IconQuestionOutline14，未新增图标。Host 的 delivery 命名空间 schema 未改（仍是 string[]）。

顺带修正三处随行为失效的用户可见文案：deliveryHelpAutoDetect（原写「判定为 L1 或 L2 时自动创建任务」）、deliveryHelpTierL0（原写「判定为 L0 时不会创建交付任务，请求直接自由执行」）、deliveryHelpVerificationCommands（补上顺序语义）。

测试：packages/delivery/tool-delivery 141 通过、packages/client/ui-settings-plugins 169 通过、packages/delivery 全量 433 通过。新增覆盖：l0 建任务、l0 任务被下一条请求替换、rubric 在 l0 下仍注入；「只提示第几条/共几条」「为第二条先记录仍被阻止」「按顺序逐条推进最终放行」；控制器侧候选剔除已选项、追加到末尾、上移/下移/clamp/忽略未选中/无操作不写；卡片侧顺序渲染、键盘按钮移动、首条禁用上移、移除、只读禁用重排。三个原本断言「l0 不建任务」的既有测试按其描述的行为改写。两个编译器面均通过（tsc -p tsconfig.host.json / tsconfig.client.json 无错）。

文档：packages/delivery/tool-delivery/README.zh.md（autoDetect 语义、l0 替换与尽力而为的自检、顺序门禁、l0 豁免说明、已知限制新增一条）、packages/client/ui-settings-plugins/README.zh.md（新控件形态与两条交互路径共用一个动作）、docs/design/delivery-l0-selfcheck-and-command-ordering.zh.md、Agent Note .agents/notes/implemented/architecture/2026-09-17-l0-selfcheck-and-ordered-acceptance-commands.zh.md，并交叉更新了两条被取代的既有 Note。verify-agent-note-format 未点名本 Note，verify-doc-budgets 8 项在限内，verify-client-ui-i18n 与 verify-md-wrap 对本变更文件无违规。
- [revision 8] acceptance: deep-selfcheck 深度自检完成。逐条回答三个问题，证据均为实际执行的命令或其输出。

一、需求完整性
req/1（l0 纳入自检）：pre-step 建任务条件改为「current === undefined || current.level === 'l0'」（packages/delivery/tool-delivery/src/index.ts:965），l0 因此走完 created → implemented → verified → accepted，验收命令门禁对其生效。端到端证据：既有验收门禁用例组的辅助函数 advanceToImplemented 本就以 level: 'l0' 建任务，21 个该组用例全部通过——即「l0 任务在未留 acceptance 记录时被阻止、留下后放行」是真实跑通的，不只是读码。
req/2（拖动排序）：控制器新增 moveVerificationCommand（delivery-card-controller.ts:265 起），卡片已选区逐行渲染序号并提供拖动与上移/下移按钮。
req/3（按顺序执行）：acceptanceGap 返回最早未记录项及其位置与总数（verification.ts:304），门禁消息写明「acceptance command N of M」。

二、实现正确性（真实触发，非只看代码不报错）
1. 顺序语义真实生效：用例「holds the second command back until the first has a record」只为第二条（docs）留记录，推进仍被阻止且消息含 /smoke；用例「names only the next command and its position in the configured order」确证消息含「acceptance command 1 of 2」且不含「/docs:」；用例「advances through the configured order one command at a time」按序记录后最终放行。三条均实跑通过。
2. l0 替换真实生效：新增用例「replaces an unfinished l0 task with the next request」连续两次 preStep，断言第二个任务 id 与 objective 都已更新——直接验证「未完成的 l0 不堵塞后续请求」这一关键修复。
3. 客户端排序：控制器用例覆盖上移、下移、越界 clamp（99 与 -5）、忽略未选中名、忽略原地移动（以快照同一性断言「无操作不写」避免把卡片标脏），以及保存后数组顺序即为重排后顺序；卡片用例覆盖顺序渲染、键盘按钮、首条禁用上移、移除、只读禁用重排。
4. 两个编译器面均通过：tsc -p tsconfig.host.json 与 tsc -p tsconfig.client.json 均无错误。
5. 全量测试：packages/delivery 与 packages/client/ui-settings-plugins 合计 433 通过。

三、业务正确性（站在使用者角度）
1. 「能跑通但行为不对」——已排查并修掉一处真实缺陷：初稿只改 pre-step，却在注释中声称模型可替换 l0 任务提高分级，而 create_delivery_task 当时仍直接调 ctx.delivery.create（对任何非 accepted 当前任务抛错），该说法不成立。抽出 createReplacingL0 并接到 create_delivery_task 后，注释与行为才一致。
2. 「只改了表面」——用户可见文案随行为同步修正了三处：deliveryHelpAutoDetect 原写「判定为 L1 或 L2 时自动创建任务」、deliveryHelpTierL0 原写「判定为 L0 时不会创建交付任务，请求直接自由执行」，均已按新行为改写；否则界面会与真实行为矛盾。
3. 「测试通过但语义错误」——设计初衷是「l0 纳入的是验收命令这一道，不是全部四道」，已通过保持 checklistGap 与 requirementCoverageGap 的 l0 豁免落实，并在 README 已知限制中显式写出「l0 自检是尽力而为的」这一取舍，避免使用者高估保护强度。

四、剩余风险（如实记录）
1. l0 自检是尽力而为的：同一 turn 内未走完 verified 的任务会被下一条请求替换，其验收门禁不执行。这是让 l0 保持轻量的取舍，l1/l2 不受影响。
2. 替换行为只覆盖 l0。若将来 l1/l2 也需要放弃任务的路径（目前无任何工具暴露 clear），应单独评估。
3. 生产代码尚无 l0 替换的宿主级测试（现有覆盖为 tool-delivery 的单元/集成层），如需 REAL-composition 覆盖应另行补充。
4. 既有未决问题：record_spec(kind: "tasks") 经 renderTasksMarkdown 只按内容匹配更新行、保留旧行，连续整体改写清单会累加并触发 checklistMismatch（我在上一个任务中实际踩到）。本次未修，属独立问题，已写入 Agent Note 的「未决」段。
- [revision 10] coverage confirmation: 本任务记录的两条设计与五项决策全部已实现：D1（l0 自动建任务，index.ts:965）、D2（createReplacingL0 在 l0 未完成时先 clear 再建，pre-step 与 create_delivery_task 共用，非 l0 抛 DELIVERY_TOOL_TASK_EXISTS）、D3（保留 l0 对 checklistGap 与 requirementCoverageGap 的豁免，两函数未改动）、D4（acceptanceGap 返回最早未记录项及 position/total，门禁消息写明第几条共几条）、D5（客户端拆成已选顺序列表与候选勾选，拖动与方向键共用 moveVerificationCommand，Host schema 不变）。原始需求三项（req/1 l0 纳入自检、req/2 拖动排序、req/3 按顺序执行）均已落地并有测试覆盖：packages/delivery 与 packages/client/ui-settings-plugins 合计 433 个测试通过，两个编译器面无错误。设计文档 docs/design/delivery-l0-selfcheck-and-command-ordering.zh.md 与 Agent Note 2026-09-17-l0-selfcheck-and-ordered-acceptance-commands.zh.md 已按实际交付内容同步。
