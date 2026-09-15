# Agent Note: 模型自己写错的 edit 搜索文本失败行不再出现在页面上

Status: implemented

## Problem

对话流里会出现这样的行：

```
Error: old_string matched 2 times in "/Users/.../tsconfig.client.json";
provide a more specific old_string or set replace_all to true
Error: old_string was not found in "/Users/.../WorkspaceBrowser.tsx"
```

读者做不了任何事：`old_string` 是模型自己撰写的，改写它、放宽它、改用 `replace_all` 都是模型的下一步动作。用户既没有参与这次失败，也没有处置它的手段；这段话只制造疑惑，并让一次很快自愈的尝试永久留在时间线上。

实测确认这并非偶发：`~/.dsh/sessions/` 下 43 个会话中有 14 个出现这两个错误码，单会话最多 71 次。模型通常紧接下一次调用就改对了，但那行失败仍然留着。

同时，模型侧必须继续收到这段结果——它正是模型据以修正参数的依据。因此问题严格限于「页面上不展示」，与工具返回、会话日志、提示词都无关。

## Decision

新增 `HiddenToolFailureProjector`（`packages/client/ui-chat/src/client/conversation-nodes/hidden-tool-failure.ts`），一个与 `ReferenceLabelProjector`、`RecoveredMutationProjector` 并列的 Chat 节点投影，装配于 `chat-snapshot-builder.ts` 的 `replace` / `apply` 两条链上。

判定依据是 `tool/result` 事件上**已持久化**的 `error.code`（由核心 `errorInfo()` 对 `HarnessError` 子类投影而来），白名单只含两个码：

- `FS_EDIT_NOT_FOUND` —— 字面量在文件中找不到，或 `old_string` 为空。
- `FS_AMBIGUOUS_EDIT` —— 字面量匹配多处且未开 `replace_all`。

二者都精确对应「模型要改的那段文本选错了」。命中时节点标记为 `visibility: 'hidden'`，因此离开可见顺序，但仍留在存储中——assembler 禁止撤回已物化的节点。

隐藏**无条件**成立，不要求存在任何后续成功的同路径变更。

### 用持久化的 error code，不解析消息文本

同一语义的文案在各文件系统后端措辞不同：`fs-local/src/fsio.ts` 是 `old_string was not found in "<path>"`，`tool-str-replace-editor/src/index.ts` 是 `No replacement was performed, old_str \`...\` did not appear verbatim in <path>.`，`fs-e2b/src/index.ts` 又是第三种。按文本匹配既脆弱，又必然漏掉后端。code 随会话日志持久化、可 replay，且一处白名单覆盖全部三类后端。

### 与条件式隐藏分开，不并入其错误码集合

`RecoveredMutationProjector` 隐藏 `FS_NOT_OBSERVED` / `FS_STALE_VERSION`，但其隐藏是**有条件**的：要求存在锚点更晚的同路径成功变更。把这两个 edit 码加进去是错的——无后续成功时它们仍会显示，而那恰是读者今天看到残留错误的场景（模型常常放弃该路径而不是重试）。故采用独立投影；它不持有任何跨节点状态，因为其判定是单个节点的属性。

### 反转了此前「非临时性失败必须保持可见」的范围

[既有 Note](2026-09-04-chat-ux-recovered-mutation-errors-hidden.zh.md) 曾明确把 `FS_EDIT_NOT_FOUND` 列为「有意义的、必须保持可见」的非临时性失败。本次为其划出一个狭窄例外：由模型自身撰写的搜索文本错误，读者无从处置。权限、沙箱、目标不存在等失败仍然保持可见——那些可能需要用户授权或告知路径问题。

### 不覆盖 PTC 嵌套子调用

`PtcDispatchEventData`（`packages/core/tools/src/types.ts`）只记录 `isError` 与 `content`，不带 `{ name, code }`，Client 侧据此构造的子调用节点因此没有可判定的错误码。补齐需扩展会话事件格式，并牵动 `snapshots/session/ptc-*`、`snapshots/web/ptc-round` 与两个 SDK 的期望输出。实测该部署 43 个会话中 `tool/code-dispatch` 事件总数为 0（native 呈现模式），当前无消费者，故延后并记入包的 Known Limitations。

## Alternatives considered

**并入 `RecoveredMutationProjector` 的错误码集合。** 否决：该投影的隐藏以「后续同路径成功」为条件，而本场景需要无条件隐藏；混入同一集合会让两个码在没有后续成功时仍然可见，与目标相反。

**在 `toolDefinition.buildViewNode` 内隐藏。** 既有 Note 否决它的理由是「覆盖判定需要后续成功，单个 Definition 看不到上下文」。该理由对本次无条件判定并不成立（`chatNode()` 本身支持 `visibility` 选项），但仍选投影层：与既有可见性投影同层，chat 快照的每个消费方拿到同一份结果；把「是否该给用户看」散进各 Definition 会让同类规则出现两处归属。

**在渲染层（`ui-tool`）隐藏。** 否决：可见性判定归属视图投影，因此快照的每个读取方看到同一份结果，无需各自重算。

**扩展 `tool/code-dispatch` 事件以覆盖嵌套子调用。** 延后而非否决：这需要改动会话事件格式与快照、SDK 期望输出，而当前部署产出的该事件数为 0；为一个没有消费者的路径扩展持久化格式不成立。PTC 呈现模式真实启用且需要在页面上隐藏这类子调用失败时应重新评估。

**把所有失败的工具行都隐藏。** 否决：权限与沙箱拒绝可能需要用户授权，目标不存在的路径信息对用户有意义，隐藏它们会让用户失去处置依据。

## Consequences

读者不再看到自己无法处理的 edit 搜索文本失败行。模型侧的 `content` 与 `error` 一字未改，模型照常据以修正。

代价与已知边界：

- 隐藏是渲染期决策，历史会话无需迁移即可获得该行为；反之若要撤销，也只改客户端。
- PTC 嵌套子调用未覆盖，已记入 `packages/client/ui-chat/README.zh.md` 的 Known Limitations。
- 不携带 `error.code` 的同类失败（如裸 `Error` 抛出的 `old_string and new_string must differ`）判不到，仍会显示。把它们改为带稳定 code 的 `HarnessError` 属于 `packages/fs/tool-fs` 的改动，本次未纳入。

## Testing

- `packages/client/ui-chat/tests/conversation-node-definitions.client.spec.ts`：新增四条——两个码在无后续成功时即为 hidden 且离开可见顺序；增量到达的结果同样隐藏；白名单之外的六个错误码保持 visible；成功调用与不带 `error` 的失败保持 visible。既有那条「非可恢复失败即使后续成功也保持可见」的用例改用 `FS_PERMISSION_DENIED`，保留其原意。
- `pnpm vitest run packages/client/ui-chat/`：26 个文件、334 条通过。
- `npx tsc -p tsconfig.client.json --noEmit` 通过。

## Deferred

PTC 嵌套子调用行的覆盖，待该呈现模式真实产出该事件时评估（见上文）。
