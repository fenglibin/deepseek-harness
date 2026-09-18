# 消息回显与识别解耦

## 问题

发送一条消息后，会话页面要等到图片识别与任务级别识别都完成，消息才在消息流里稳定出现。用户按下 Enter 到看见自己的消息之间，存在数秒空窗。

### 实测证据

同机真实会话日志（`~/.dsh/sessions/--Users-fenglibin-data-code-opensource-deepseek-harness--/session-4194cc9a-e3b2-4d9e-a177-651771b7b151/session.jsonl.zstd`）：

| seq | 事件 | 时间戳 | 间隔 |
|---|---|---|---|
| 3 | `agent/inbox/spliced` | 1789632234143 | — |
| 4 | `turn/start` | 1789632234143 | — |
| 5 | `agent/inbox/spliced`（`removedCount: 1`） | 1789632234143 | — |
| 6 | `delivery/grading-request` | 1789632234151 | +8ms |
| 7 | `delivery/change` | 1789632241059 | **+6908ms** |
| 9 | `user/message` | 1789632241074 | +15ms |

另一条带图会话采样到同类 3.85s 空窗。分级判定的耗时几乎全部转化为「消息不可见」的时长。

### 机制

客户端已经有本地提交回显（`.agents/notes/implemented/architecture/2026-08-26-local-submission-echoes.zh.md`）：`service.ts` 的 `sendSession` 在序列化任何字节之前同步调用 `session.beginSubmission()`，把 `{requestId, text, parts}` 写入 `SessionSnapshot.pendingSubmissions`，`ChatView` 渲染 `PendingSubmissionBubble`。回显本身是当帧的。

问题出在随后两个环节。

**其一：回显在消息流里被队列帧过滤掉。** 消息进入 host inbox 时，`control.ts` 的 `onSessionEvent` 在 `agent/inbox/spliced` 上广播 queue 帧，`ChatView.tsx` 的 `observedRpcIds` 随即把该 rpcId 的回显排除在消息流之外（消息改由输入框上方的 `QueueDock` 承载）。此后 durable `user/message` 尚未落盘，消息流为空。

**其二：claim 之后消息在界面上彻底不存在。** `preStep` 先执行 `inbox.claim(target, turn)`（`core/agent-loop/src/agent.ts:240`）再触发 `agent/pre-step`。claim 让消息离开队列投影，消息流里的回显又被 queue 帧过滤，于是从 claim 到 `user/message` 落盘之间，这条消息**在任何一个界面位置都无法呈现**。日志 seq 5 → seq 9 即此窗口。

窗口长度由挂在 `agent/pre-step` 上同步 await 的插件决定。当前是交付分级判定：

```ts
// packages/delivery/tool-delivery/src/index.ts:1093
ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
  ...
  const outcome = floored === undefined
    ? await gradeWithModel(ctx, agent, objective, policy().gradingPrompt, signal)
    : { ... }
```

而 `session.append('user/message', ...)` 发生在 pre-step 返回之后（`core/agent-loop/src/agent.ts:293-295`）。判定期间的等待因此完全落在「消息不可见」上。

对纯文本消息同样成立：任何挂在 `agent/pre-step` 上同步 await 的插件都会制造这个窗口。

图片识别的情形不同：它在 prompt 准入的 `durablePromptContent()` 内 `await describeForRoute(...)`（`api/session-controller/src/commands.ts:416`），位于 `agent.followup(message)` 之前。消息此时还没进 inbox，也就没有 queue 帧，回显照常显示在消息流里。所以图片描述期间消息是可见的，它是被**回显**遮住的，不是空窗。

## 决定

**「消息可见」不再依赖任何识别完成，识别一律移出消息可见性的关键路径。**

### D1 分级判定不再阻塞 `agent/pre-step`

`agent/pre-step` 立即 `next()`；判定改为后台任务，完成后创建任务并补记 rationale。

判定产物只用于建交付任务，不进入模型可见内容（该内容由 `tool:delivery` 的静态 guidance 提供，任务状态经 `get_delivery_task` 读取），因此没有理由让它决定消息何时可见。

**理由**：这是实测 6.9s 空窗的直接成因，也是本次改动收益的主体。

### D2 回显在消息流中持续到 durable 节点渲染

`ChatView` 不再因队列帧而隐藏回显：只要该 rpcId 的 durable `user/message` 尚未渲染于消息流，回显就继续显示。

队列帧表达的是「这条消息在 host 待处理」，不是「这条消息已经可见于消息流」。`QueueDock` 继续承载可操作的队列行——它提供编辑、删除、steer 等操作，与消息流中的只读回显职责不同，两者并存不重复。

**理由**：这是 claim 窗口的成因，与 D1 共同覆盖整个不可见区间。

### D3 客户端补齐两条被抑制的回显路径

- 草稿含 `@` 引用时，`facade.ts:869` 把 `defaultSink`（连同回显发布）推迟到所有引用序列化完成之后。改为先发布回显、再执行引用序列化。
- subagent 会话（`service.ts:210`）完全不走 `beginSubmission` 路径。补上回显注册。

### D4 识别进行中在回显上可见

回显气泡在 durable 节点尚未渲染时显示进行中的状态，让「已发送、正在处理」与「已完成」在视觉上可区分。

## 图片描述为何不在本次改动范围内

最初判断图片描述也必须移出准入路径。核对后确认**不需要**：

1. 描述发生在 `agent.followup(message)` 之前，消息尚未进入 inbox，因此没有 queue 帧，回显不被过滤——图片描述期间消息本来就是可见的。
2. 用户已确认模型请求仍应等待描述就绪。既然请求本就要等，把描述的生成位置从准入挪到请求组装只会改变等待发生在哪一侧，端到端首次 token 时间不变。
3. 移出准入需要新的 session 事件承载描述（「Model-visible ⟺ logged」要求任何进入请求的内容可从日志重建），并同步 TypeScript 与 Python SDK 投影——成本高而收益接近零。

该路径的真正缺陷是 `serializeImageAdmission` 让同会话的多条带图消息互相排队（`api/session-controller/src/agent.ts:493`）。它与消息可见性无关（每条消息的回显都立即显示），属于吞吐优化，因此不并入本变更。

## 备选方案

**只做客户端（D2/D3/D4）。** 改动小、风险低，但 claim 窗口只是被回显遮住，`user/message` 与 turn 仍要等判定，日志里那 6.9s 一分不减。判定越慢，回显停留越久，用户仍会感到「一直在转」。

**并行化提速（放宽 `serializeImageAdmission`、判定与描述并发）。** 压缩总时长但不改变「先完成才落盘」的因果，换更慢的模型或更长提示词即复发。

**给 `agent/pre-step` 加超时。** 判定超时后放弃。会静默降级分级质量，且未解决「pre-step 不该承载非阻塞工作」的结构问题。

**把回显作为合成节点走 assembler。** 已在 2026-08-26 的 Note 中被否决：assembler 只由 durable session event 驱动，客户端专属节点会扩进每个 target 的 `assertNever`。

## 待定

1. **后台判定与模型自建任务的竞态。** 判定期间模型可能自己调用 `create_delivery_task`；后台判定完成时若发现已有任务，应放弃而不是替换。
2. **后台判定的取消与生命周期。** turn 被取消或会话销毁时，后台判定应随之取消，且失败只记日志不影响 turn（沿用现有的 `warn` + `next()` 处置）。
3. **D4 的呈现措辞。** 进行中状态用什么文案，以及它是否需要区分「等待判定」与「等待模型」。

## 影响面

- `packages/delivery/tool-delivery`：pre-step 监听改为非阻塞 + 后台判定。
- `packages/client/ui-chat`：`ChatView` 的回显过滤规则。
- `packages/client/ui-conversation`：`facade.ts` 引用序列化路径；`service.ts` 的 subagent 回显；回显气泡的进行中状态。
- `docs/subsystems/` 中登记 `agent/pre-step` 契约的页面。

## 验证

- Host：`user/message` 落盘不再等待分级判定；判定仍在后台完成并把 rationale 记入既有产物。
- Client：队列帧不再隐藏消息流中的回显；带 `@` 引用与 subagent 会话下回显当帧出现。
- 快照：录制会话快照覆盖「消息落盘早于判定完成」的顺序。
