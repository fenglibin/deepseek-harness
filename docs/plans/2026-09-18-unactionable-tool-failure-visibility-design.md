# 会话页面失败行可见性反转设计

## 问题

会话页面上频繁出现用户无法处置的工具失败行，例如：

```
Error: cannot edit ".../git-restore.ts": file changed since it was read — its current content follows; retry now.
Error: cannot write ".../line-counts.spec.ts": file no longer exists — re-read the file, then retry
Error: offset 670 is out of range for ".../SessionChangesDock.tsx" (655 lines)
Error: delivery verification blocked: acceptance command 1 of 1 has no recorded run: - /deep-selfcheck: ...
```

这些失败的原因全部出在**模型自己撰写的参数**上：陈旧版本、offset 越界、未按交付流程留记录。用户既未参与该失败，也没有处置手段；模型收到同一段结果后自行纠正即可。这段话只制造疑惑，并让一次很快自愈的尝试永久留在时间线上。

## 实测证据

对 `~/.dsh/sessions/` 下本项目 140 个会话、29,038 次 `tool/result` 做全量统计，其中 492 次失败（1.7%）：

| 错误码 | 次数 | 占比 | 处置方 |
|---|---|---|---|
| `FS_NOT_OBSERVED` | 153 | 31% | 模型（先读后改） |
| `FS_STALE_VERSION` | 118 | 24% | 模型（重读后重试） |
| `DELIVERY_GATE_BLOCKED` | 43 | 9% | 模型（走交付流程） |
| `FS_EDIT_NOT_FOUND` | 27 | 5% | 模型（改搜索文本） |
| `DELIVERY_ALREADY_EXISTS` | 21 | 4% | 模型（复用已有任务） |
| `FS_NOT_FOUND` | 12 | 2% | 混合，见下 |
| `FS_AMBIGUOUS_EDIT` | 10 | 2% | 模型（放宽或 replace_all） |
| `DELIVERY_STALE_REVISION` | 10 | 2% | 模型（重新读取） |
| `INVALID_ARGS` | 8 | 2% | 模型（改参数） |
| `UNKNOWN_TOOL` | 7 | 1% | 模型（改用正确工具名） |
| 其余长尾 12 类 | 31 | 6% | — |
| **无 `error.code`（裸 `Error`）** | **52** | **11%** | 模型（多为参数错误） |

需要用户介入的失败实测共 6 次（`FS_SANDBOX_DENIED` 2、`NO_PROVIDER` 2、`GOAL_TOOL_AUTHORITY_REQUIRED` 1、`SEARCH_FAILED` 1），占全部失败的 1.2%。

`FS_NOT_FOUND` 的 12 次经消息文本归一分摊：10 次是 `cannot read/... : not found`，2 次是 `offset N is out of range`。同一个码承载了可处置性相反的两类语义。

## 关键设计约束

**约束一：判定必须按 code，不能解析消息文本。** 同一语义在 `fs-local`、`fs-e2b`、`tool-str-replace-editor` 三个后端措辞各不相同；`error.code` 随会话日志持久化、可 replay，一处判定覆盖全部后端。这是既有 Note 已确立的正确决策，本次沿用。

**约束二：判定方向必须是白名单制。** `DELIVERY_POST_HOOK_FAILED` 实测出现 7 次，但该码在当前源码中已不存在（`advance_delivery_task` 的 post-hooks 机制在 `c78e5ae256` 中被移除），现存记录来自历史会话 replay。黑名单制会让每个已删除的码在 replay 时重新变成可见噪音；白名单制（未知码默认隐藏）天然安全。

**约束三：`turn-error` 兜底已存在，无需额外机制。** `conversation-nodes/turn-error.ts` 在 `turn/end` 的 `reason.kind === 'error'` 时渲染独立的失败行，因此纯静默隐藏不会让「agent 彻底失败」对用户失明。过程噪音被隐藏，最终结果仍可见。

**约束四：提权审批有独立 UI 通道。** `packages/client/ui-approval` 的 `ApprovalPanel` 是 composer 接管，不依赖工具错误行。因此「需要用户参与」的场景本身就有专门通道承担展示职责，不需要错误行兜底。用户拒绝提权产生的 `the user rejected escalating...` 反而应当隐藏——把用户刚做的决定再回显为红色错误属于噪音。

**约束五：模型侧一字不改。** 隐藏是纯渲染期决策，`tool/result` 事件的 `content` 与 `error` 字段不变，模型照常据以纠正。历史会话无需迁移即可获得新行为。

## 方案

### D1 反转可见性判定

`packages/client/ui-chat/src/client/conversation-nodes/hidden-tool-failure.ts` 现为「黑名单隐藏」，白名单仅含 `FS_EDIT_NOT_FOUND`、`FS_AMBIGUOUS_EDIT` 两码。改为「**可处置白名单展示**」：命中原有白名单的失败行保持 `visibility: 'visible'`，其余 `isError` 行标记 `visibility: 'hidden'`。

需展示的白名单（需要用户介入）：

- `FS_SANDBOX_DENIED` —— 沙箱拒绝，可能需要用户放宽策略
- `FS_PERMISSION_DENIED` —— 真实权限问题
- `NO_PROVIDER` —— 无可用提供方，属环境配置
- `GOAL_TOOL_AUTHORITY_REQUIRED` —— 需用户授予权限
- `SEARCH_FAILED` —— 搜索工具本身不可用

不在白名单且**无 `error.code`** 的裸 `Error` 一并隐藏：实测 52 次，文本如 `old_string and new_string must differ`、`change_id must be verb-led kebab-case`，全部是模型自身的参数错误。

`RecoveredMutationProjector` 保持独立，不做合并：它处理的是「后续同路径成功后才隐藏」的条件式判定，与本投影的无条件默认隐藏职责不重叠。两者都标记 `visibility`，而非 `null`——assembler 禁止撤回已物化的节点。

### D2 拆出精确码

`packages/fs/tool-fs/src/read-render.ts:97` 的 offset 越界当前抛 `FS_NOT_FOUND`，与「文件真的不存在」共用一码。在 `packages/fs/fs/src/types.ts` 的 `FsErrorCode` 联合中新增 `FS_OFFSET_OUT_OF_RANGE`，使越界单独成码。

这是 D1 的必要前提：不拆码，默认隐藏会把「文件不存在」——对用户有信息量、且可能反映真实路径问题——一起吞掉。

### D3 文档与 Agent Note

- 新增 Agent Note 记录方向反转，并明确它取代 `2026-09-16-unactionable-edit-failure-rows-hidden.zh.md` 中「列为白名单的两码被隐藏」的表述。
- 同步 `packages/client/ui-chat/README.zh.md` 与 `packages/fs/fs`、`packages/fs/tool-fs` 的 README 与 JSDoc 契约。
- `FS_PERMISSION_DENIED` 白名单纳入理由记录为「语义上与沙箱拒绝同类，一旦出现即需用户处理；实测 0 次，纳入代价极低」。

## 边界与已知限制

- **PTC 嵌套子调用不覆盖**：`tool/code-dispatch` 事件只记录 `isError` 与 `content`，不带 `{ name, code }`，Client 侧构造的子调用节点无可判定的错误码。实测该事件在本部署中为 0 次。沿用既有 Note 的延后结论，记入 `ui-chat` README 的 Known Limitations。
- **不做阈值汇总提示**：不引入「同一 turn 内同类隐藏失败超过 N 次则汇总」的机制。依据是约束三与约束四——最终失败有 `turn-error`，需用户参与有审批面板，中间过程无需页面信号。
- **不改持久化格式**：`ToolErrorInfo`（`packages/core/tools/src/index.ts:468`）结构不变，因此不牵动两个 SDK 的期望输出与 `snapshots/` 会话快照。

## 验收方式

- `packages/client/ui-chat/tests/conversation-node-definitions.client.spec.ts`：白名单五码保持 visible；`FS_STALE_VERSION`、`FS_NOT_OBSERVED`、`DELIVERY_GATE_BLOCKED`、`FS_EDIT_NOT_FOUND` 等默认 hidden；无 `error.code` 的失败默认 hidden；成功调用不受影响；增量 upsert 与全量 replace 两条链一致。
- `packages/fs/tool-fs` 与 `packages/fs/fs`：越界返回 `FS_OFFSET_OUT_OF_RANGE`，文件不存在仍返回 `FS_NOT_FOUND`。
- 按 `docs/testing.zh.md#何时需要快照测试` 判定是否需重录快照（本次不改事件格式，预期不需要）。
