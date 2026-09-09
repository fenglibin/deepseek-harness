## 1. D1 需求分析标记
- [x] 1.1 `DeliverySnapshot` 增加 `analysisDone: boolean`，`deliveryProjectionSchema` 同步 (covers: delivery-discipline/需求分析完成可追溯, design/D1)
- [x] 1.2 新增 `mark-analyzed` 操作与 `DeliveryMarkAnalyzedChangeMeta`，fold 严格校验 false→true (covers: delivery-discipline/需求分析完成可追溯, design/D1)
- [x] 1.3 `DeliveryService.markAnalyzed` 方法与 `mark_analysis_done` 工具 (covers: delivery-discipline/需求分析完成前拒绝设计文档, design/D1)
- [x] 1.4 `record_design` 前置 gate（analysisDone 检查） (covers: delivery-discipline/需求分析完成前拒绝设计文档, design/D1)
- [x] 1.5 D1 单测：fold 与 service 的 analysisDone 迁移、gate 拦截 (covers: delivery-discipline/需求分析完成可追溯, design/D1)

## 2. D2 任务清单三态
- [x] 2.1 `DeliveryTaskItem.done` 改为 `status` 三态，`delivery-tasks` 投影与 schema 同步 (covers: delivery-discipline/任务项三态状态, design/D2)
- [x] 2.2 `record_tasks` 扩展非 l2：change_id 空值与 status 三态 (covers: delivery-discipline/非 l2 任务清单持久化, design/D2)
- [x] 2.3 `checklistMismatch` 磁盘 checkbox 到三态的映射适配 (covers: delivery-discipline/任务项三态状态, design/D2)
- [x] 2.4 D2 单测：三态投影、非 l2 落盘、checklist 对比 (covers: delivery-discipline/非 l2 任务清单持久化, design/D2)

## 3. D3 进度语义化呈现
- [x] 3.1 `DeliveryFloatCard` 四组语义化重构与默认展开 (covers: delivery-discipline/进度栏语义分组展示, design/D3)
- [x] 3.2 locales 与派生逻辑（analysisDone/designCount/items/phase） (covers: delivery-discipline/进度实时更新默认展开, design/D3)
- [x] 3.3 D3 客户端单测：四组渲染、默认展开、状态派生 (covers: delivery-discipline/进度栏语义分组展示, design/D3)

## 4. D4 验证分级
- [x] 4.1 非 l2 推进 verified 校验清单全部 completed (covers: delivery-discipline/非 l2 验证清单全完成, design/D4)
- [x] 4.2 D4 单测：未完成清单阻挡推进并列出差异 (covers: delivery-discipline/非 l2 验证清单全完成, design/D4)

## 5. D5 文档与快照
- [x] 5.1 更新 delivery 三包 README 与已知限制 (covers: design/D5)
- [x] 5.2 补 Agent Note 记录决策与验证 (covers: design/D5)
- [x] 5.3 交付门禁：本次变更触及 package 单测全通过、typecheck 0 错误 (covers: design/D5)
- [ ] 5.4 刷新录制会话快照（`session/text-turn` 与 `sdk/text-turn` 的 system-prompt 与 tool-schemas）——沙箱下 `dsh` CLI 子进程挂起，待宿主机环境执行 `DSH_SNAPSHOT=refresh pnpm vitest run --config vitest.snapshot.config.ts snapshots/session/headless.snapshot.ts snapshots/sdk/sdk.snapshot.ts` (covers: design/D5)
