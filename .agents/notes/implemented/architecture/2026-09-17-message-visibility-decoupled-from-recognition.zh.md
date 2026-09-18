# Agent Note: 消息可见性与识别解耦

Status: implemented

## 问题

发送消息后，消息要等到图片识别与分级判定都完成才在 transcript 上稳定出现。实测本机会话日志（`session-4194cc9a-e3b2-4d9e-a177-651771b7b151`）：

```
seq 3  agent/inbox/spliced      1789632234143   消息进 inbox
seq 4  turn/start               1789632234143
seq 5  agent/inbox/spliced      1789632234143   removedCount:1 ← claim，消息离开队列
seq 6  delivery/grading-request 1789632234151
seq 7  delivery/change          1789632241059   ← 6908ms
seq 9  user/message             1789632241074   ← 此时才恢复可见
```

两个机制叠加制造了这段空窗。

**claim 之后消息在界面上彻底不存在。**`preStep` 先执行 `inbox.claim(target, turn)`（`core/agent-loop/src/agent.ts`）再触发 `agent/pre-step`。claim 让消息离开队列投影，而 `ChatView` 的渲染期去重又把消息流里的本地提交回显排除掉（该 rpcId 出现在 queue 帧中）。于是从 claim 到 `user/message` 落盘之间，这条消息在任何一个界面位置都无法呈现。

**窗口长度由挂在 `agent/pre-step` 上同步 await 的插件决定。**当时是交付分级判定：判定在 pre-step 内 `await`，而 `session.append('user/message', ...)` 发生在 pre-step waterfall 解析之后。判定期间的全部等待因此落在「消息不可见」上。对纯文本消息同样成立——任何在 pre-step 里同步 await 的插件都会制造这个窗口。

图片识别不在这条病因上：它在 prompt 准入的 `durablePromptContent()` 内 `await describeForRoute(...)`，位于 `agent.followup(message)` 之前，消息尚未进入 inbox、也就没有 queue 帧，回显照常显示。

## 决策

### 分级判定移出 pre-step 关键路径

`agent/pre-step` 同步 `next()`，判定作为后台 pass 推进，落地后才建任务并补记依据。判定产物只用于建交付任务，既不进入模型可见内容也不影响请求组装，因此没有理由让它决定消息何时可见。

每个 agent 至多一个 pass 在跑。冲突的第二次请求被**记为待续**而非丢弃：两个 pass 会争抢同一个任务槽，而丢下它会让连续发送的第二次请求逃过纪律——`create` 拒绝在存在非 `accepted` 当前任务时新建，且没有任何工具可以清空任务，所以那条请求会既不建任务也不被替换。pass 落地时重新读取当前任务，模型在此期间自建的任务不会被覆盖；signal 或插件 lifetime 已中止则不提交任务。

### 回显在消息流中持续到 durable 节点渲染

队列 occurrence 说的是「消息在 Host 待处理」，不是「消息已可见于 transcript」。因此 occurrence 不再退休回显，撤回了[本地提交回显](2026-08-26-local-submission-echoes.zh.md)原先按 occurrence 退休的规则。

区别按渲染位置划分：`queued` 行渲染在 composer 上方的 `QueueDock`，与消息流是不同表面，回显继续在消息流中代表该消息；`steering` 行渲染在消息流尾部、与回显同一位置，因此仍由它隐藏回显，否则同一内容会双渲染。

用户移除队列项是唯一没有 durable 对端的丢弃动作，由 `updateQueue` 自行结算其回显。rpcId 在 RPC **之前**读取：移除会触发 Host 广播丢掉该行的 queue 帧，该帧可能先于 RPC 回复到达，事后读取投影会找不到行而让回显永久停留。

### subagent 续接注册回显

该 transport 把调用方的 rpcId 原样写入子会话消息的 user source，因此续接发送可以走与普通发送相同的观察退休路径。客户端 `Session.prompt` 的 subagent 分支原先无条件重新生成 requestId，使回显身份永远无法与其 durable 消息关联；现在转发调用方的身份。原 Note 记的「transport 会分配另一个 RPC id」与实现不符。

### 回显在长时间等待时说明自己

回显跨越了 turn 自身的开局，因此等待超过 400ms 时显示「已发送，等待处理…」。阈值延迟是必要的：普通发送在一两帧内就被 durable 节点替换，一闪而过的提示读起来像缺陷。

## 考虑过的替代方案

**只改客户端，不动 Host。** 改动小、风险低，但 claim 窗口只是被回显遮住，`user/message` 与 turn 仍要等判定，实测那 6.9 秒一分不减；判定越慢回显停留越久，用户仍会感到「一直在转」。

**把图片描述也移出准入路径。** 否决：描述发生在 `agent.followup()` 之前，消息尚未进入 inbox，回显本就可见，因此它不参与这个窗口。且模型请求仍应等待描述就绪（否则纯文本路由会退化为「图片被省略」），挪动生成位置只改变等待发生在哪一侧，端到端首次 token 时间不变。移出准入还需要新的 session 事件承载描述并同步 TypeScript 与 Python SDK 投影，成本高而收益接近零。

**放宽 `serializeImageAdmission` 的串行化。** 它让同会话多条带图消息互相排队，属于吞吐问题而非可见性问题（每条消息的回显都立即显示），不并入本变更。

**给 pre-step 加超时。** 判定超时后放弃：会静默降级分级质量，且未解决「pre-step 不该承载非阻塞工作」的结构问题。

**在 pre-step 里 fire-and-forget 判定，不记录待续请求。** 即本决策的第一个实现。跨包并发测试暴露了缺陷：in-flight 期间到达的请求被直接跳过，连续两次发送中第二次永远不会被分级。改为排队续接。

## 后果

- **获得** 消息一按下就在 transcript 上可见并持续可见，贯穿 turn 开局、分级判定与图片描述。实测那 6.9 秒空窗消失。
- **获得** 交付分级不再推迟 `user/message`，任务的出现晚于消息本身，而这对任务语义无害——它只是一条纪律记录。
- **代价** 预取的分级判定与"模型自建任务"之间存在真实竞态，由落地时重读当前任务处置。
- **代价** 回显的生命周期被拉长到 durable 落盘，因此它需要自己解释等待（等待提示），也需要显式的移除结算路径。
- **未决** `facade.ts` 的 `sinkSerialized` 在 `@` 引用序列化完成后才调用 `defaultSink`，从而推迟回显发布。当前唯一提供 codec 的 `ui-reference` 是同步的（`serialize: ref => Promise.resolve(ref)`），故不产生可观测延迟；未来引入异步 codec 的引用源会重现该延迟。

## 验证

`tool-delivery` spec 用挂在 LLM stub 上的 `beforeResolve` 闸门证明判定挂起时 pre-step waterfall 已返回且此时无任务，并覆盖「模型在挂起期间自建任务不被覆盖」与「in-flight 期间的请求仍被分级」。session-controller spec 覆盖队列 occurrence 不退休回显、移除队列项退休回显、queue 帧先于 RPC 回复的竞态，以及 subagent 会话回显的身份透传。ChatView spec 覆盖 queued 下回显保留、steering 下回显让位、以及等待提示的阈值时机。受影响的四个包共 1345 条测试通过。
