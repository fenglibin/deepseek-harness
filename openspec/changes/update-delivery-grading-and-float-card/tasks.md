## 1. D1 分级复核范围

- [x] 1.1 `autoDetect` 钩子改为只在 `gradeObjective` 判 `l2` 时自动建任务，`l0`/`l1` 都注入 rubric (covers: delivery-discipline/分级复核覆盖 l0 与 l1, design/D1)
- [x] 1.2 改写 `GRADING_RUBRIC` 文案：说明自动评分未判 `l2`、给出 `l1`/`l2` 判据、明确不值得上流程就不建任务 (covers: delivery-discipline/分级复核覆盖 l0 与 l1, design/D1)
- [x] 1.3 单测：`l1` 请求注入 rubric 且不自动建任务；强信号仍自动建 `l2` (covers: delivery-discipline/分级复核覆盖 l0 与 l1, design/D1)

## 2. D2 设计文档链接

- [x] 2.1 `ui-delivery` 的 `inject` 与 `dsh.client.inject` 增加 `remote`/`remote.session`，注册时经 `inject` 提供 `openFile` (covers: delivery-discipline/设计文档进度可点击打开, design/D2)
- [x] 2.2 `DeliveryFloatCard` 在「设计文档」组已完成时渲染可点击链接，打开失败就地提示 (covers: delivery-discipline/设计文档进度可点击打开, design/D2)
- [x] 2.3 locales 增加打开标签与失败文案 (covers: delivery-discipline/设计文档进度可点击打开, design/D2)
- [x] 2.4 客户端单测：链接渲染、点击调用 `openFile`、失败提示 (covers: delivery-discipline/设计文档进度可点击打开, design/D2)

## 3. D3 默认隐藏与快捷键

- [x] 3.1 新增 `createDeliveryCardStore()`（`defineStore` + `persist: 'dsh.delivery.float-card'`，root 作用域） (covers: delivery-discipline/进度栏默认隐藏且快捷键切换, design/D3)
- [x] 3.2 注册时声明 store 座位，`DeliveryFloatCard` 经 `useStore` 读、`actions.toggle()` 写 (covers: delivery-discipline/进度栏默认隐藏且快捷键切换, design/D3)
- [x] 3.3 组件在 `document` 上监听 `Ctrl+Shift+P` 切换，隐藏时返回 `null` 但保持挂载 (covers: delivery-discipline/进度栏默认隐藏且快捷键切换, design/D3)
- [x] 3.4 客户端单测：默认不渲染、快捷键展示与隐藏、偏好写入 localStorage (covers: delivery-discipline/进度栏默认隐藏且快捷键切换, design/D3)

## 4. D4 任务列表回落

- [x] 4.1 `DeliveryFloatCard` 增加 `useProjection('todos')`，交付清单为空时渲染 todo 项与状态并标注来源 (covers: delivery-discipline/任务列表回落到 todo 投影, design/D4)
- [x] 4.2 客户端单测：清单为空时展示 todos，清单非空时不展示 todos (covers: delivery-discipline/任务列表回落到 todo 投影, design/D4)

## 5. 提示词与文档

- [x] 5.1 `guidance()` 与 `record_tasks` 文案要求非 `l2` 也先确认需求、`mark_analysis_done` 并 `record_tasks` 落盘清单 (covers: delivery-discipline/非 l2 也需确认需求并落盘清单, design/D1)
- [x] 5.2 更新 `packages/client/ui-delivery/README.zh.md` 与 `packages/delivery/tool-delivery/README.zh.md` (covers: design/D1, design/D2, design/D3, design/D4)
- [x] 5.3 补 Agent Note 记录决策与验证 (covers: design/D1, design/D2, design/D3, design/D4)
- [ ] 5.4 刷新受影响的无密钥会话快照（`system-prompt.expected.md`） (covers: design/D1, design/D5)
- [x] 5.5 交付门禁：相关 package 单测与 typecheck 通过 (covers: design/D1, design/D2, design/D3, design/D4)
