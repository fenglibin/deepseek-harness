# 技术决策

移植目标为官方提交 `73edce1ae7`（`perf(agent-loop): reuse proven message freezes per agent`）。该提交在官方只改 `packages/core/agent-loop/src/agent.ts` 15 行（净 +7），另加一条 Agent Note 与一个 234 行的聚焦测试。本文件记录决策编号，供 tasks.md 锚定。

## 移植面基线

本地 `packages/core/agent-loop/src/agent.ts` 相对分叉点 `0a53fb55be` 只有 1 行差异：在 `executeToolCalls(...)` 调用中透传 `preparedCall?.inputModalities`。该差异位于工具调用路径，与本变更触碰的 `buildRequest()` 冻结段互不重叠，因此 `73edce1ae7` 的补丁在本地语义上可直接套用。

`Message` 类型已在本地 `agent.ts:19` 从 `@deepseek-ai/dsh-llm` 导入，无需新增导入。

但本地 `packages/core/agent-loop` 整体相对分叉点已改 9 文件、+136/−222（本地自有改动，含 `tool-calls.ts`、测试与 tsconfig），且本地 `agent.ts` 的字段布局与官方不同：本地无 `assistantStreamRevision`、`assistantAttemptCounter`、`systemPrompt` 三个字段，`requestSurfaceGeneration` 的类型也不同（本地为 `number | undefined`）。因此新增字段**不能照抄官方 `:94` 的位置**，必须放在本地类字段区的合理位置。

本地当前 `buildRequest()` 的冻结点是 `packages/core/agent-loop/src/agent.ts:536`，形态为 `markAgentLoopRequest(deepFreeze({...}))`，与官方父提交一致。

### D1 证明的粒度是「该 agent 实例对该对象完成过完整深冻结」

`frozenMessages` 是 `ReactLoopAgent` 的私有 `WeakSet<Message>`，只在 `deepFreeze(message)` 成功返回后才 `add`。它记录的不是「这个对象已冻结」这一全局事实，而是「本循环亲自遍历过它」这一归属事实。

因此每个新建的循环都要为恢复来的历史重新证明一次。这不是可避免的开销，而是安全性的来源：只有完成遍历才能证明该对象图不可变。

### D2 用对象身份而非 `Object.isFrozen`

`Object.isFrozen` 为真时立即返回是错的。已冻结的**根对象**不能证明其后代已冻结：一个浅冻结的消息仍可能持有可变的 `content` 数组或嵌套的 tool 结果。在共享辅助函数中使用这条捷径会削弱所有调用方，包括恢复与投影路径。

同理，不能用消息 id 判定：替换操作可以保留 id 同时改变对象身份与内容。只有对该精确对象完成一次遍历才能证明请求所要求的不可变性。

### D3 用 `WeakSet` 而非强引用 `Set`

弱引用不增加对已压缩历史的所有权。强引用 `Set` 会延长被替换消息的生命周期，使证明表成为内存泄漏源。官方 Note 的堆样本显示该表的小额成本（约 22.30 MiB → 22.59 MiB），且弱键防止表本身保留已替换消息。

也不使用跨 agent 的全局缓存：那会把所有权扩大到 agent 之外，而对同一循环的重复请求并无必要。

### D4 遍历失败的消息不进入证明表

`deepFreeze` 只在完整遍历成功后返回。若遍历中途抛出（例如遇到不可冻结的宿主对象），该消息不得被 `add`。下一次请求会对它重新尝试冻结。

这条性质由官方聚焦测试 `retries freezing an identity whose previous traversal failed` 覆盖，是「证明」二字的实质含义：表里只有成功的记录。

### D5 拆分冻结面，本地 header 每次请求单独冻结

原来的单次 `deepFreeze({...})` 覆盖了整个请求对象，包括消息数组、消息对象、header 与请求封装。拆分后各面的冻结方式不同：

- **本地规范化 header**：每次请求深冻结。`canonicalHeader` 共享嵌套值，`Session.append` 冻结的是独立快照，两者都不能证明本地 `tools` 数组或 `NO_ADAPTER` 回退路径中的 stop 数组不可变。
- **`boundaryMessages` 中的每条消息**：按证明跳过或深冻结。
- **`boundaryMessages` 数组本身**：`Object.freeze`（浅冻结即可，元素已各自处理）。
- **请求封装对象**：`Object.freeze`，再交给 `markAgentLoopRequest`。
- **`AbortSignal`**：保持可变，实时取消能力不变。

拆分的代价是每个请求仍要扫描消息身份并分配新数组；收益是避免递归遍历已证明的历史。

### D6 消息身份跨请求稳定是前提

本决策成立的前提是 `Session.deriveMessages()` 返回的 `Message` 对象在多次调用间是同一批对象。本地实现持有 `private derived: Message[] = []` 增量缓存，按 surface 节点逐个投影、缓存，并返回 `[...this.derived]`——数组是新的，元素是共享的。本地该实现与官方一致，仅 `replaceGeneration` 与官方 master 的 `contentGeneration` 命名不同。

实施前必须重新确认这一点，并把它写成测试断言。若某条路径会重建消息对象（例如 surface `replace` 触发 `replaceGeneration` 变化后整表重建），那么重建出的对象只是第一次遍历会付出成本，证明表对新身份自然失效，行为仍然正确。

### D7 测试需按本地签名适配，不能整文件套用

官方聚焦测试 `packages/core/agent-loop/tests/request-freeze.spec.ts`（234 行）在本地不存在，需新增。但**不能整文件套用**：本地 `Session.fromRestore` 是三参签名 `(id, seed, header)`（本地 `packages/core/session/src/index.ts:493`），且本地 surface 相关字段名与官方不同。测试须按本地签名与字段名适配后再落地。

### D8 本地 fork 文件不可整文件覆盖

`docs/architecture.zh.md` 与 `packages/core/agent-loop/README.zh.md` 在本地已有 fork 改动（含 image-understanding 段落），移植时只能定点插入段落，绝不可用官方版本整段替换。

## 被拒绝的方案

**`Object.isFrozen` 为真时立即返回**：浅冻结的根对象不能证明后代已冻结，会削弱所有调用方。

**信任所有 Session 消息或按消息 id 缓存**：恢复明确允许独立拥有的未冻结数据；替换可保留 id 而改变对象身份与内容。

**保留强引用 `Set` 或共享全局证明缓存**：强引用延长旧历史生命周期；全局缓存把所有权扩大到 agent 之外。

**移除下游投影冻结**：投影后的文件、图像与回放消息是拥有独立所有权的不同值，其不可变性不能由规范历史已冻结推导出来。

**直接复用官方 `:94` 的字段位置**：本地类字段区与官方不同（缺少三个字段、`requestSurfaceGeneration` 类型不同），照抄位置会与本地布局冲突。位置需按本地上下文决定，语义保持一致。
