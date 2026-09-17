## Context

现状诊断、四项问题的证据与完整取舍见 `docs/design/delivery-card-usability-rationale.zh.md`。核心事实是「提示词命令」的 payload 是一段发给模型的用户消息文本（`packages/interaction/command-prompt-config/src/index.ts:45-63` 注册为 `kind: 'prompt'`），不是 shell 命令、执行后不产生退出码；而现门禁（`packages/delivery/tool-delivery/src/verification.ts:309-323`）正是按退出码判定的。因此把验收依据换成提示词后，必须为门禁另找一个可机械检查的事实。

## Goals / Non-Goals

**Goals**：卡片可读性与密度改善；信号词表的规则可理解、可操作、无重复计数；验收命令可勾选且门禁仍不可被模型口述绕过；L2 结构校验不丢失。

**Non-Goals**：不保留 `postHooks` 兼容回退；不改交付任务阶段序列与其它门禁；不改 `agent-loop`；不改「提示词命令」页自身的编辑能力；不引入 shell 命令的图形化选择器。

## Decisions

### D1 游离 `)` 直接删除并加断言

`DeliveryCard.tsx:185` 的 `)` 是 JSX 之外的文本节点，删除即可。测试断言卡片容器内不含裸 `)` 文本，锁住这类笔误。

### D2 帮助入口并入描述行

卡片头部整体是展开/收起 `<button>`，帮助链接也是按钮，嵌套按钮是无效 HTML 并破坏可达性。因此保持头部描述不动，改为在展开区首行渲染「描述文案 + 帮助链接」同一行。放弃把链接嵌入头部按钮：那需要把头部降级为非按钮容器并自管键盘可达性，为一个链接付出整块交互重写。

### D3 两列栅格

字段容器改为 `grid-template-columns: repeat(2, minmax(0, 1fr))`；短控件默认占一列，多行文本域与标签编辑器声明 `grid-column: 1 / -1`。窄视口回落单列。放弃「全部字段一律两列」：多行内容被压窄后逐条换行，反而更难读。放弃新增分组小节：本次诉求是密度，不是信息架构重排。

### D4 信号词表改标签式编辑器并补齐规则

新增 `tagField` spec 与 `TagField` 控件：每个值是一个可删除标签，末尾输入框支持回车或按钮添加。值形状与既有 `listField` 一致（`string[]`），因此 Host schema 不变，仅客户端编辑体验升级。三个信号字段改用该控件。locale 补齐匹配规则、可配置取值与新增方式；默认词表**保留** `replac`/`upgrad` 这类刻意词干，并在说明中解释它是刻意写法（一条覆盖整个词族且只计一次）而非拼写错误。实测确认：三个默认词表内都不存在互相包含的条目对，因此词干本身不会重复计数；反过来若把词干替换成整词，`replace` 会漏掉 `replacing`，且一旦与 `replacement` 并存就会重复计数——词干是更稳妥的写法。说明同时提示用户新增条目时避免互相包含。

### D5 验收命令改勾选提示词，硬门禁落在推进操作内

Host `Config` 的 `postHooks` 由 `verificationCommands?: string[]`（提示词命令名，无前导斜杠）取代。门禁判定落在 `advance_delivery_task` 的 `verified` 分支内，符合「门禁在做出决定的那个操作里执行」。若勾选了命令而当前任务尚无验收记录，则阻止推进，并把每条命令的提示词与记录要求写进被抛出的门禁消息——`ToolRunContext.deferContext` 只在成功路径附加（`packages/core/tools/src/index.ts:1569-1578`），抛错时会被丢弃，因此不能靠「抛错同时注入」。模型执行后调用 `record_change` 留下带固定前缀的验收记录，门禁即可放行。这样门禁的确定性来自「是否留下记录」这一可机械检查的事实，而非模型措辞。

### D6 L2 结构校验与提示词验收分属两件事

`openspec validate <changeId> --strict --json` 仍由 Host 在验证阶段以 `ctx.shell.run` 执行并按退出码判定，保持在提示词验收之前。它校验的是本次 OpenSpec 变更的结构合法性，与「用户想额外跑什么验收」无关，因此不随 `postHooks` 一起移除。

### D7 客户端经 settingsScope 读取提示词命令

交付卡片用 `ctx.settingsScope.bind({ namespace: 'prompt-commands' })` 读取命令清单并渲染复选框；勾选结果写入 `delivery` 命名空间的 `verificationCommands`。跨命名空间读取走既有 settings 服务，不新增框架扩展点，也不做跨插件值导入（客户端 bundle 纯度门禁）。

## Risks / Trade-offs

- 提示词验收由模型执行，其结论仍需模型如实记录；门禁只能保证「留下了记录」，不能保证记录为真。这是「用提示词替代退出码」的固有代价，也是用户明确选择的方案。原先靠退出码判定的强保证仅保留给 L2 结构校验。
- 丢弃 `postHooks` 会使既有部署的该字段失效。按预发布立场不做兼容垫片，同步更新测试与快照。
- 标签编辑器在候选很多时比文本域占用更多纵向空间，故信号字段整行占满。
- 勾选清单依赖 Host 同时挂载设置服务与「提示词命令」插件；未挂载时该控件无候选，需给出明确空态文案。

## Migration Plan

无磁盘格式或协议变化。`delivery` 命名空间的 `postHooks` 键被忽略；`verificationCommands` 为新增可选键，缺省即无提示词验收。用户设置文档无需迁移。

## Open Questions

无。
