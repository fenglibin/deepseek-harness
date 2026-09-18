## 1. D2 拆出精确错误码（前置，D1 依赖它）

- [x] 1.1 `FsErrorCode` 联合新增 `FS_OFFSET_OUT_OF_RANGE`，并更新其 JSDoc 契约 (covers: tool-failure-visibility/越界错误单独成码, design/D2)
- [x] 1.2 `read-render.ts` 的 offset 越界改抛 `FS_OFFSET_OUT_OF_RANGE`，文件不存在路径保持 `FS_NOT_FOUND` (covers: tool-failure-visibility/越界错误单独成码, design/D2)
- [x] 1.3 补 `tool-fs` 测试：越界返回新码、文件不存在仍返回 `FS_NOT_FOUND`，两者断言各自的 code (covers: tool-failure-visibility/越界错误单独成码, design/D2)

## 2. D1 反转可见性判定

- [x] 2.1 `hidden-tool-failure.ts` 判定反转为「可处置白名单展示」，白名单各码保持 visible，其余 `isError` 默认 hidden (covers: tool-failure-visibility/模型自纠失败默认隐藏, tool-failure-visibility/需用户介入的失败保持可见, design/D1)
- [x] 2.2 无 `error.code` 的裸 `Error` 默认 hidden，与有码路径共用同一判定入口 (covers: tool-failure-visibility/无错误码的失败默认隐藏, design/D1)
- [x] 2.3 更新该类与两个方法（`replace`/`apply`）的 JSDoc，使其陈述新的判定方向与白名单依据 (covers: tool-failure-visibility/模型自纠失败默认隐藏, design/D1)
- [x] 2.4 删除被架空的 `RecoveredMutationProjector` 及其两条装配链位置：其两个错误码已无条件隐藏，该投影不再改变任何输出 (covers: tool-failure-visibility/模型自纠失败默认隐藏, design/D1)

## 3. 测试

- [x] 3.1 `conversation-node-definitions.client.spec.ts`：白名单各码保持 visible (covers: tool-failure-visibility/需用户介入的失败保持可见, design/D1)
- [x] 3.2 同文件：`FS_STALE_VERSION`、`FS_NOT_OBSERVED`、`DELIVERY_GATE_BLOCKED`、`FS_EDIT_NOT_FOUND` 等默认 hidden 并离开可见顺序 (covers: tool-failure-visibility/模型自纠失败默认隐藏, design/D1)
- [x] 3.3 同文件：无 `error.code` 的失败默认 hidden；成功调用与 `isError: false` 不受影响 (covers: tool-failure-visibility/无错误码的失败默认隐藏, tool-failure-visibility/成功的调用不受影响, design/D1)
- [x] 3.4 同文件：增量 upsert 与全量 replace 两条链的判定结果一致 (covers: tool-failure-visibility/模型自纠失败默认隐藏, design/D1)
- [x] 3.5 改造既有用例：原「非可恢复失败保持可见」的断言按新方向重写为白名单内的 `FS_PERMISSION_DENIED`，保留其对成功调用不受影响的覆盖 (covers: tool-failure-visibility/需用户介入的失败保持可见, design/D1)
- [x] 3.6 补一条断言：已从源码删除的历史错误码（`DELIVERY_POST_HOOK_FAILED`）重放时默认 hidden，固定白名单制对 replay 的安全性 (covers: tool-failure-visibility/模型自纠失败默认隐藏, design/D1)

## 4. D3/D4 文档与 Agent Note

- [x] 4.1 新增 Agent Note，记录方向反转、白名单依据，并合并两份被完全取代的记录（`2026-09-16-unactionable-edit-failure-rows-hidden`、`2026-09-04-chat-ux-recovered-mutation-errors-hidden`）及其独有依据 (covers: tool-failure-visibility/模型自纠失败默认隐藏, design/D1, design/D3)
- [x] 4.2 同步 `packages/client/ui-chat/README.zh.md`：更新可见性规则描述与 Known Limitations（PTC 子调用未覆盖沿用） (covers: tool-failure-visibility/模型自纠失败默认隐藏, design/D1)
- [x] 4.3 同步 `packages/fs/fs` 与 `packages/fs/tool-fs` 的 README，登记新错误码及其语义 (covers: tool-failure-visibility/越界错误单独成码, design/D2)
- [x] 4.4 确认未触碰 `ToolErrorInfo` 与事件格式；按 `docs/testing.zh.md` 判定是否需重录快照（本次不改事件格式，无需重录） (covers: tool-failure-visibility/模型自纠失败默认隐藏, design/D4)

## 5. 验收

- [x] 5.1 聚焦测试：`vitest run packages/sandbox/sandbox/ packages/client/ui-chat/ packages/fs/tool-fs/ packages/fs/fs/`——37 个文件、570 条通过 (covers: tool-failure-visibility/模型自纠失败默认隐藏, tool-failure-visibility/需用户介入的失败保持可见, tool-failure-visibility/越界错误单独成码, tool-failure-visibility/无错误码的失败默认隐藏)
- [x] 5.2 类型检查：`tsc -b packages/client/ui-chat/tsconfig.json` 与 `packages/fs/tool-fs/tsconfig.json` 通过 (covers: tool-failure-visibility/越界错误单独成码, design/D2)
- [x] 5.3 文档门禁：`verify-agent-note-format`、`verify-md-links` 与 `openspec validate --strict` 在本次新增/改动文件上通过 (covers: tool-failure-visibility/模型自纠失败默认隐藏, design/D1)
- [x] 5.4 深度自检发现并修复：提权失败「无可用审批通道」抛裸 `Error` 会被默认隐藏，而它需要读者配置审批通道；`dsh-sandbox` 新增 `SANDBOX_APPROVAL_UNAVAILABLE` 覆盖三种审批路径不可用状态，并纳入白名单，`rejected`/`cancelled` 不携带该码 (covers: tool-failure-visibility/需用户介入的失败保持可见, tool-failure-visibility/用户自己拒绝的提权不保持可见, design/D1)
- [x] 5.5 自检复核：用 140 个真实会话、492 次失败重放新判定，得到 486 次隐藏 / 6 次可见（1.2%），与设计预期一致 (covers: tool-failure-visibility/模型自纠失败默认隐藏, tool-failure-visibility/需用户介入的失败保持可见, design/D1)
