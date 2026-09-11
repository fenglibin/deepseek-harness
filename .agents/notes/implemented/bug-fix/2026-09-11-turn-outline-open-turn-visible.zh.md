# Agent Note: 用户消息抽屉立刻列出刚发出的提问，而不是等回合结束

Status: implemented

## Problem

聊天右侧的"我的对话"抽屉读 [`turnOutline` 投影](../../../../packages/session/session-stats/src/turn-outline.ts)，它把每个以自身 `user/message` 开头的回合折成一行 `{ turn, prompt }`。折叠在 `user/message` 落地时就记下了起始提问，但 wire 视图只导出 `state.turns`，而这个数组只在 `turn/end` 时追加当前回合。

结果是读者发出一条消息、聊天区已经回显、模型已经开始回答，抽屉里却找不到这一行：要等本轮需求整个跑完（`turn/end` 落地）它才出现。抽屉是读者用来"翻我之前提过什么"的入口，一条刚发出的提问缺席会让读者以为消息没送出去，或去手动翻页找它；badge 计数在同一段时间里也少一。

## Decision

`turnOutline` 的 wire 视图把打开中的回合一并导出：`wire.view` 在 `state.turns` 之后追加 [`openTurnEntry(state)`](../../../../packages/session/session-stats/src/turn-outline.ts) —— 当 `currentTurn !== null` 且该回合已是用户回合时返回 `{ turn: currentTurn, prompt: currentPrompt }`，否则不追加。

判定"是不是用户回合"抽成模块内 `isUserTurn(state)`（`currentPrompt !== '' || currentIsUserTurn`），`turn/end` 的保留判定与 wire 视图共用同一个谓词，因此"哪一回合会进列表"只有一个归属，两侧不可能漂移。

折叠状态与 `stateVersion` 保持为 1：`apply` 的转移语义没有变化，持久化缓存行仍可继续播种，旧会话重新挂载后由同一份状态算出新视图。`turn/end` 只把该回合从"打开中"移入"已定稿"，行的 `turn` 号不变，客户端的 React key 因此复用同一行，不闪烁、不重复。

## Alternatives considered

**在客户端把 `pendingSubmissions` 之类的本地回显合并进抽屉。** 否决：投影 seam 的契约是客户端从不折叠领域事件，抽屉的每一行都必须来自 host 计算好的全量值；本地拼接会引入第二条真相源，且 `turn/end` 之后还要处理去重。

**让 `turn/start` 就产出一行占位（`prompt: ''`）。** 否决：`turn/start` 也会为注入上下文、压缩条目等没有用户提问的回合打开槽位，占位行会让抽屉出现读者从未发出的条目；真正的信号是 `user/message`。

**给视图新增独立字段（如 `open: TurnOutlineEntry | null`），由客户端合并。** 否决：这会把"列表 = 已定稿 + 打开中"的合并逻辑复制到每个消费者（当前是抽屉，未来还会有别的），并把时序语义留在客户端；放在视图里则一处定义、所有消费者一致。

**在 `user/message` 上让 `apply` 直接把回合推进 `turns`，`turn/end` 只做收尾。** 否决：`turns` 是已定稿的日志顺序列表，提前推进会让 `turn/end` 需要识别并改写最后一项，且回合中途被丢弃的判定（注入-only 回合）会失去唯一落点。

## Consequences

读者发出消息的那一刻，抽屉的 badge 计数加一、列表末尾出现该行；`turn/end` 到达后该行原地定稿，不闪、不重、不换位置。仅图或空 content 的提问同样立刻出现，预览沿用既有的「（无文本，仅附件）」兜底（[依据](2026-09-07-user-turn-panel-empty-prompt-and-load-aligned.zh.md)）。跨会话重进（历史尾页基线或冷读 checkpoint）看到的是同一份状态算出的同一份列表，包括那个尚未闭合的回合。

代价是视图不再等于折叠状态里的 `turns` 数组：`TurnOutlineProjection` 的语义变为"含打开中回合的时间线列表"，`types.ts`、包 README 与抽屉组件的模块 JSDoc 已同步。打开中的回合每个 `user/message` 都会让状态引用变化，因此变更流可能为该回合多发一帧内容相同的视图——帧的内容仍由同一谓词决定，与 `turn/end` 之后完全一致。

[`turn-outline.spec.ts`](../../../../packages/session/session-stats/tests/turn-outline.spec.ts) 新增五条用例：打开中的回合在 `turn/end` 之前即可见且定稿后仍只有一行；起始提问落地时变更流推送该视图；注入消息打开回合时不产生行、用户提问到达后才产生；仅图提问的打开中回合以空预览出现；回合中途的 steering 消息不替换已定稿的起始提问。

这条时序此前没有任何一层测试钉住：既有投影用例只在 `turn/end` 之后断言列表，抽屉的客户端用例又直接向 `outlineStore` 注入 `turns`，因此"打开中的回合是否出现在视图里"既不在 host 折叠的断言范围内，也不在客户端的断言范围内。新增用例同时覆盖回合进行中与已定稿两个时点，堵住这个盲区。
