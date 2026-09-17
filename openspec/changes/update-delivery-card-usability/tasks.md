## 1. D1 修掉游离字符

- [x] 删除 `DeliveryCard.tsx` 中 `</PluginCard>` 之后的游离 `)` (covers: delivery-discipline/交付纪律卡片不再渲染游离字符, design/D1)
- [x] 客户端单测：卡片容器文本不含裸 `)` (covers: delivery-discipline/交付纪律卡片不再渲染游离字符, design/D1)

## 2. D2 帮助入口并入描述行

- [x] 展开区首行渲染「描述文案 + 帮助链接」同一行，移除独占行的 `helpRow` 布局 (covers: delivery-discipline/帮助入口紧随卡片描述, design/D2)
- [x] 客户端单测：描述与帮助链接在同一行且链接仍能打开参考对话框 (covers: delivery-discipline/帮助入口紧随卡片描述, design/D2)

## 3. D3 两列栅格

- [x] `fields.module.css` 新增两列 grid 容器，短控件占一列 (covers: delivery-discipline/交付纪律字段分两列排布, design/D3)
- [x] 多行文本域与标签编辑器整行占满，窄视口回落单列 (covers: delivery-discipline/交付纪律字段分两列排布, design/D3)
- [x] 客户端单测：两列栅格类名与整行声明生效 (covers: delivery-discipline/交付纪律字段分两列排布, design/D3)

## 4. D4 信号词表标签式编辑器与规则说明

- [x] `card-form.ts` 新增 `tagField` spec（值形状仍为 `string[]`，Host schema 不变） (covers: delivery-discipline/信号词表的命中判定对用户可见, design/D4)
- [x] `fields.tsx` 新增 `TagField`：逐条渲染标签、支持删除、输入框回车或按钮新增、拒绝空值与重复值 (covers: delivery-discipline/信号词表的命中判定对用户可见, design/D4)
- [x] 强/中/弱三个信号字段改用 `TagField` 整行渲染 (covers: delivery-discipline/信号词表的命中判定对用户可见, design/D4)
- [x] locale 说明补齐匹配规则（忽略大小写、子串包含、每条计 1 次、编号列表额外计 1 中等信号）、可填取值与新增方式 (covers: delivery-discipline/信号词表的命中判定对用户可见, design/D4)
- [x] 核实 `replac`/`upgrad` 是刻意词干（实测三个默认词表无互相包含条目对），保留并在说明中解释 (covers: delivery-discipline/信号词表的命中判定对用户可见, design/D4)
- [x] 单测：标签增删与去重；`grading.spec.ts`/`stores.client.spec.ts` 覆盖词表边界 (covers: delivery-discipline/信号词表的命中判定对用户可见, design/D4)

## 5. D5 验收命令改勾选提示词 + 硬门禁

- [x] Host `Config` 移除 `postHooks`，新增 `verificationCommands?: string[]`，并更新 `resolveConfig` 校验 (covers: delivery-discipline/验收命令从提示词命令中勾选, delivery-discipline/提示词验收留下记录才放行, design/D5)
- [x] Host 经 `ctx.settings` 读取 `prompt-commands` 命名空间，按名取出提示词文本；未挂载或未配置时得空集合 (covers: delivery-discipline/验收命令从提示词命令中勾选, design/D5)
- [x] 新增验收记录门禁：`advance_delivery_task` 推进到 `verified` 时，若有勾选命令且尚无该任务的验收记录，则阻止推进，门禁消息含各命令提示词与 `record_change` 记录要求 (covers: delivery-discipline/提示词验收留下记录才放行, design/D5)
- [x] 移除 `postHooks` 的 shell 执行路径；`openspec validate <changeId> --strict --json` 保留为 Host shell 校验并按退出码判定 (covers: delivery-discipline/L2 结构校验不随验收命令变更而丢失, design/D6)
- [x] Host 测试：未留验收记录被阻止、留下记录后放行、逐命令计数、未勾选命令时 `l2` 仍执行结构校验、结构校验非零退出阻止验证 (covers: delivery-discipline/提示词验收留下记录才放行, delivery-discipline/L2 结构校验不随验收命令变更而丢失, design/D5, design/D6)

## 6. D7 客户端勾选交互

- [x] 交付卡片控制器经 `settingsScope` 绑定 `prompt-commands` 读取命令清单，并暴露 `verificationCommands` 字段 (covers: delivery-discipline/验收命令从提示词命令中勾选, design/D7)
- [x] 卡片渲染命令复选框列表；无候选时展示引导到「提示词命令」页的空态且不阻塞其它字段保存 (covers: delivery-discipline/验收命令从提示词命令中勾选, design/D7)
- [x] 客户端单测：勾选写入字段、空态文案、只读态禁用、已消失命令仍可取消 (covers: delivery-discipline/验收命令从提示词命令中勾选, design/D7)

## 7. 文档与收尾

- [x] 更新 `packages/client/ui-settings-plugins/README.zh.md` 与 `packages/delivery/tool-delivery/README.zh.md` (covers: design/D1, design/D2, design/D3, design/D4, design/D5, design/D6, design/D7)
- [x] 重新生成 `docs/config-catalog.zh.md` 并补 Agent Note (covers: design/D5, design/D6)
- [x] 跑受影响范围的测试与验证脚本 (covers: design/D1, design/D2, design/D3, design/D4, design/D5, design/D6, design/D7)
