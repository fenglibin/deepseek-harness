# 任务

## 实现

- [x] 新增 `packages/client/ui-chat/src/client/conversation-nodes/hidden-tool-failure.ts`：`HiddenToolFailureProjector`，含 `HIDDEN_CODES` 白名单、`replace` / `apply` 两个方法，JSDoc 说明为什么无条件隐藏、为什么排除权限类失败 (covers: hidden-edit-failure-rows/命中白名单的顶层失败行不进入可见流, design/D1, design/D2, design/D4)
- [x] 在 `chat-snapshot-builder.ts` 装配该投影：`replace` 与 `apply` 两条链各接一层，紧随 `RecoveredMutationProjector` (covers: hidden-edit-failure-rows/命中白名单的顶层失败行不进入可见流, design/D3)
- [x] 确认 `childResult()` 不携带 `error` 的现状，在投影中只读 `node.data.root`（顶层），不高估覆盖范围 (covers: hidden-edit-failure-rows/嵌套子调用不在本次范围, design/D5)

## 测试

- [x] 新增单测：`FS_EDIT_NOT_FOUND` 与 `FS_AMBIGUOUS_EDIT` 的顶层失败行 `visibility` 为 `hidden`，且无需任何后续成功 (covers: hidden-edit-failure-rows/命中白名单的顶层失败行不进入可见流)
- [x] 新增单测：非白名单错误码（`FS_PERMISSION_DENIED`、`FS_SANDBOX_DENIED`、`FS_STALE_VERSION`、`FS_NOT_FOUND`、`FS_NOT_REGULAR_FILE`、`failed`）保持 `visible`；成功调用保持 `visible`；无 `error` 的失败保持 `visible` (covers: hidden-edit-failure-rows/非白名单失败保持可见)
- [x] 改写既有断言 `keeps a non-recoverable mutation failure visible even when a later mutation succeeds`：把 `FS_EDIT_NOT_FOUND` 换成 `FS_PERMISSION_DENIED`，保留其原意（条件式投影不隐藏非可恢复码） (covers: hidden-edit-failure-rows/非白名单失败保持可见, design/D6)
- [x] 验证增量路径：失败的 edit 先物化、随后结果到达时 `apply` 使其保持隐藏；运行中的调用在此之前保持 `visible` (covers: hidden-edit-failure-rows/命中白名单的顶层失败行不进入可见流)

## 文档

- [x] 更新 `packages/client/ui-chat/README.zh.md`：新增「不可操作的工具失败行」章节说明判定依据与白名单，把 PTC 子调用未覆盖写入「已知限制与暂缓事项」 (covers: hidden-edit-failure-rows/嵌套子调用不在本次范围, design/D5)
- [x] 新增 Agent Note `2026-09-16-unactionable-edit-failure-rows-hidden.zh.md` 记录本次决策反转并交叉链接旧 Note；就地更新旧 Note 中与现状矛盾的表述（Alts 中「非临时性失败必须保持可见」的范围、`buildViewNode` 那条否决理由的适用范围） (covers: hidden-edit-failure-rows/非白名单失败保持可见, design/D6)

## 验证

- [x] `pnpm vitest run packages/client/ui-chat/`：26 个文件、334 条通过；`npx tsc -p tsconfig.client.json --noEmit` 通过
- [x] 门禁：`verify-agent-note-classification`、`verify-doc-budgets`、`verify-package-readme-limitations`、`verify-client-ui-i18n` 通过；`verify-agent-note-format`、`verify-md-links`、`verify-md-wrap`、`verify-export-jsdoc` 报出的违规全部位于本次未触碰的既有文件
- [x] 确认无需重建会话日志或快照（本次不改会话事件格式，纯客户端渲染期判定）
- [x] 在真实会话上确认：从 `session-91d195b6` 解压出用户截图所示两条失败调用的**原始事件**，经 `ConversationNodeAssembler` + Chat 快照运行后两者 `visibility` 均为 `hidden` 且不在可见顺序中；`tool/result` 的 `content` 与 `error` 未被改动（临时校验用例已删除）
- [x] 在真实会话上确认：含这两个错误码的历史会话刷新后不再显示那些失败行，且模型后续调用与结果不受影响
