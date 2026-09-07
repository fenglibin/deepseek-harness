# Agent Note: 往上翻页时 request-prompt 撤回已物化节点导致 event feed 崩溃

Status: implemented

## Problem

`request-prompt` Definition（`packages/client/ui-chat/src/client/conversation-nodes/request-prompt.ts`）为 `chat` target 物化系统提示行。它的 `buildViewNode` 在三类情形下返回 `null`：`state` 未定义、`showsPrompt` 为假、或 `prompt.system` 为空串。conversation assembler 有一条硬不变量：一旦某个 context 在 `chat` target 下物化过一个节点，后续 flush 就不能再对它返回 `null`（必须用同一 key 带 `visibility: 'hidden'` 返回），否则抛出 `conversation Definition "request-prompt" withdrew materialized target "chat"`。

这条不变量在往上翻页（prepend 更早历史）时被打破。`showsPrompt` 依赖 `reader.previous('request-prompt')` 的 predecessor：

```
showsPrompt = previous === undefined
  || reason !== 'change'
  || startsSeries === true
  || change === 'system'
  || change === 'system-and-tools'
```

一个带 `reason: 'change'` 且系统未变的请求头，当它的 predecessor 落在已加载窗口之外（`hasMore` 为真，`previous === undefined`）时，`showsPrompt` 取真，物化出一行提示。随后往上翻页把那段更早的请求头填进来，predecessor 依赖链被重放，同一个 context 的 `previous` 从 undefined 变成真实存在，`reason === 'change'` 且 `change` 既不是 system 也不是 system-and-tools，`showsPrompt` 翻转为假。`buildViewNode` 于是对这个已物化的节点返回 `null`，assembler 抛错，`[session-controller] event feed subscriber failed`，整个订阅链路中断。

`systemless` 案例（`reason: 'initial'` 且 `header.system` 为空）此前也返回 `null`，但它从未物化过节点，因此不会触发撤回。config/tool-only 变更头同理——`showsPrompt` 自始为假，从未物化，返回 `null` 是安全的。

## Decision

`buildViewNode` 采用与 `assistant.ts` 一致的"仅在曾物化过时返回 hidden"模式：

- `state` 未定义 → 返回 `null`（从未物化，安全）。
- `showsPrompt && prompt.system !== ''` → 返回可见节点（原逻辑不变）。
- 其余（`showsPrompt` 为假，或 system 为空）→ 读 `context.current.get('chat')`：若此前已经物化过一个节点，返回带 `visibility: 'hidden'` 的同 key 节点；否则返回 `null`。

这样，只在真正"撤回"一个已物化行时才退化为 hidden，而从未物化的 config/tool-only 头与无 system 头仍然不产生节点，保持节点 store 干净、现有可见性过滤语义不变。

## Alternatives considered

**一律返回 hidden 而不是 null。** 否决：会让从未物化的 config/tool-only 头、无 system 头也往节点 store 塞一个 hidden 节点，破坏现有"无 system prompt 就 `toBeUndefined`"的语义，迫使下游所有可见性过滤处额外处理这类永不出现的节点。

**在 `start` 里冻结 `showsPrompt` 使其不随 predecessor 变化。** 否决：`showsPrompt` 的正确语义就是"相对于前一个已加载请求头是否有可见变化"，prepend 填进 predecessor 后重新判定为同一 series 的 config/tool 变更，本就应该把它藏起来。冻结会让提示行在补全历史后仍错误地显示为一个独立的可见系列起点。

**让 assembler 容忍撤回。** 否决：撤回一个已物化节点会让 timeline 和 location 索引丢掉一条真实行，破坏"模型可见 ⟺ 已记录"的重建保证；hidden 语义正是为"行还存在但要藏起来"设计的。

## Consequences

往上翻页不再崩溃。被 prepend 揭示为同一 series 的 config/tool 变更头，其已物化提示行退化为 hidden，不再参与 `order` 的可见序列，但 key 仍留在节点 store 中；更早的那个真实 series 起点保持可见。无 system 的请求头与 config/tool-only 变更头的可见性行为不变。

`packages/client/ui-chat/tests/conversation-node-definitions.client.spec.ts` 新增一条回归用例：一个带 `hasMore` 的窗口物化 `reason: 'change'` 头，prepend 其同 system 的 predecessor 后 `flush()` 不再抛错，且更早头保持 visible、更晚头退化为 hidden、`order` 里只剩一个 system-prompt。
