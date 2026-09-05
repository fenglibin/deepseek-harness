# Agent Note: 重试已解决的错误不再留在页面上

Status: implemented

## Problem

当一次模型请求失败、被重试、且重试成功时，transcript 里仍然展示那次已经被恢复的失败。`model-retry` 节点只要 `attempts.length > 0` 就物化，`ModelRetryItem` 把失败详情（`node.failure.message`）放进一个 `<details>`，在 turn 干净关闭后仍留在 transcript 里。已经拿到答案的用户仍然看到那次转瞬即逝、后来再也不是问题的失败所留下的「报错」。

## Decision

在渲染期，于 [`retry.ts`](../../../../packages/client/ui-chat/src/client/conversation-nodes/retry.ts) 里用 owning turn 的终局结果给 `model-retry` 节点设门。`buildViewNode` 现在从 location 读出 turn，并检查它的结尾：

- **turn 以非错误原因关闭**（`completed`、`aborted`、`interrupted`、`max-tokens`……）：重试链没有以终局失败结束，所以节点的失败详情不应渲染。节点以 `visibility: 'hidden'` 返回。
- **turn 以 `reason.kind === 'error'` 关闭**：重试链没有解决失败，节点照常渲染；兄弟 `turn-error` 节点已经承载终局那一行。
- **turn 仍打开，或结尾未知**：中性的「重试中 / 已开始」状态仍渲染，让用户在 turn 尚未证明已恢复时看到正在重试。

### 为什么是 hidden 而不是 null

第一版实现对已恢复的 turn 返回 `null`。对 live 的 turn 这是错的：`model-retry` 节点在 turn 打开时就物化了（「重试中」状态），而 `ConversationNodeAssembler` 禁止一个 Definition 撤回已物化的节点——它会抛 `"… withdrew materialized target \"chat\"; return the same key with hidden visibility instead"`。「存在但不显示」的正确表达是 `visibility: 'hidden'`，`chatNode` 已支持，因此节点留在 timeline 上但绝不进入渲染顺序。

## Alternatives considered

**对已恢复的 turn 返回 `null`。** 否决：在 live 路径（open → closed）上会触发 assembler 的撤回守卫，因为中性的重试状态已经物化过。只有从没经历过 open 状态的完整 replay 才能容忍 `null`。

**改为隐藏 `turn-error` 节点。** 否决：`turn-error` 只在 `reason.kind === 'error'` 时产生，已恢复的 turn 根本没有 `turn-error` 可隐藏。出问题的 surface 是 `model-retry` 链，不是终局那一行。

**恢复时自动 dismiss 输入框的错误 toast。** 否决：toast（`InputBar` 的 `promptError` / `notices`）与重试链是两条独立通道，会掩盖真正的发送失败。超出已确认范围。

## Consequences

从重试中恢复的 turn 现在只展示答案，不再有残留的失败详情；`model-retry` 节点被隐藏，也不存在 `turn-error` 行。仍然失败的 turn 保留可见的 `model-retry` 链和它的 `turn-error` 行。这是渲染期的一处判定，无 schema、无事件改动。

代价是每个已恢复的 turn 都会在 timeline 上保留一个隐藏的 `model-retry` 节点——这正是 assembler「不撤回」契约的要求。它从不渲染，所以用户无感知差异；只是 `value.nodes` 里仍含有 `visibility: 'hidden'` 的节点。

## Testing

- `conversation-node-definitions.client.spec.ts` —— 新增 `hides a retry chain whose turn closed without error (the retry recovered)`，组装完整序列 `turn/start → step/start → llm/retry → llm/retry-started → assistant/message → step/end → turn/end(completed)`，断言 `model-retry` 为 `hidden`、`turn-error` 不存在。
- 既有的重试测试仍通过：耗尽重试链（`turn/end` `reason.kind === 'error'`）渲染可见的 attempts，open-turn 场景渲染中性状态。
- `packages/client/ui-chat` 套件：311 通过，0 失败。
- `tsc -b tsconfig.client.json` 与 lint 通过。

## Deferred

同一 UX 优化的最后一项仍独立提交：带接受/拒绝的修改文件列表。
