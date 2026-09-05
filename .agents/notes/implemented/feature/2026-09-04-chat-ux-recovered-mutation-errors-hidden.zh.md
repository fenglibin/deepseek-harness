# Agent Note: 被后续同文件成功覆盖的 mutation 失败不再停留在页面上

Status: implemented

## Problem

一次受防护的 `edit` / `write` / `str_replace_editor` 调用以可恢复错误码（`FS_NOT_OBSERVED` / `FS_STALE_VERSION`）失败后，即使后续对同一文件的 mutation 已成功，transcript 里仍保留那次失败的错误行。model-retry 投影已经按 turn 终局隐藏了已恢复的请求重试链，但 tool-call 表面没有对应的机制：`edit requires reading … first — read the file, then retry` 这种失败在模型重新读取文件、重试成功后仍然可见——包括失败与成功之间夹了一次 `read` 的情况。

## Decision

新增 `RecoveredMutationProjector`（位于 `recovered-mutation.ts`），这是 Chat snapshot builder 在 `ReferenceLabelProjector` 旁边运行的一个节点投影。它在一处后续同路径的 mutation 成功后隐藏之前的可恢复失败，与 `ReferenceLabelProjector` 采用相同的 `replace` / `apply` 形态：

- `replace` 对整个窗口重建：收集每个路径的最新成功 mutation 锚点，然后隐藏锚点早于它的任何可恢复失败。
- `apply` 增量更新：一处新到达的成功会通过重新评估它登记过的失败，把该路径早先的可恢复失败重新隐藏。

只有 `FS_NOT_OBSERVED` 与 `FS_STALE_VERSION` 会被隐藏——这是两个补救指令本身即为「read the file, then retry」的受防护 mutation 错误码。其他所有失败（如 `FS_EDIT_NOT_FOUND`、`FS_PERMISSION_DENIED`）保持可见，因为它们按契约并非临时性错误。

### 为什么是 hidden 而不是移除

该行在调用结算时即物化，而 assembler 禁止撤回已物化的节点，因此投影将其标记为 `visibility: 'hidden'`（与 model-retry 投影相同的机制），而不是丢弃节点。

## Alternatives considered

**在 `toolDefinition.buildViewNode` 内隐藏。** 否决：覆盖判定需要「后续成功」，而单个 tool-call Definition 看不到——它的上下文只含自己的 `tool/call` 与 `tool/result` 事件。

**在渲染层（`ui-tool`）隐藏。** 否决：可见性判定应归属视图投影，这样 chat 快照的每个消费方看到的都是同一份已恢复状态，其他读取方无需各自重算。

**隐藏所有失败的 mutation，而非仅可恢复错误码。** 否决：非临时性失败（无匹配、权限拒绝）是有意义的，必须保持可见。

## Consequences

`FS_NOT_OBSERVED` / `FS_STALE_VERSION` 的 mutation 失败在后续同文件 mutation 成功后不再留下陈旧错误行，包括失败与成功之间夹了一次 `read` 的情况。判定只在渲染期进行——无 schema、无会话事件改动。

## Testing

- `conversation-node-definitions.client.spec.ts` —— 新增四条：可恢复失败在后续成功（夹了一次 read）后被隐藏；无后续成功时保持可见；非可恢复错误码（`FS_EDIT_NOT_FOUND`）保持可见；后续成功晚于失败增量到达时重新隐藏。该套件 48 条通过。

## Deferred

无。
