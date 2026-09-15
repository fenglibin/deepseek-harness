# 在每个 agent 内复用已证明的消息深冻结

## 为什么

`ReactLoopAgent.buildRequest()` 每次构造请求都对整个消息历史做一次 `deepFreeze`。当前实现是：

```ts
const request = markAgentLoopRequest(deepFreeze({
  ...header.config,
  messages: boundaryMessages,
  // ...
}))
```

`deepFreeze` 会递归遍历 `boundaryMessages` 中的每个消息对象及其全部后代。长工具对话下，这份历史绝大部分在上一轮请求中已经被冻结过，但每次构造请求都会重新遍历一遍。

官方 Agent Note（`.agents/notes/implemented/simplification/2026-09-06-agent-request-freeze-provenance.zh.md`）记录的实测：同一 800 轮历史负载下，请求历史中位数从 **246.131 ms** 降至 **67.293 ms**，复测为 **66.694 ms**。该 Note 同时给出保留堆预算 22.59 MiB（低于不变的 28.75 MiB 上限），并说明弱键防止证明表本身保留已替换的消息。

跳过已冻结根对象并不安全：恢复操作会接管独立拥有的对象图而不冻结它们，浅冻结的消息根对象仍可能包含可变后代。因此需要一份**该循环亲自完成过完整遍历**的身份证明。

## 做什么

在 `ReactLoopAgent` 上增加一个私有的 `WeakSet<Message>`，只记录本实例中完整 `deepFreeze` 调用成功的消息对象身份，并在构造请求时按对象身份跳过已证明的消息：

- 新增 `private readonly frozenMessages = new WeakSet<Message>()`
- `buildRequest()` 拆开原来的单次 `deepFreeze({...})`：先深冻结本地规范化 header，再逐条按证明跳过或冻结 `boundaryMessages`，然后 `Object.freeze(boundaryMessages)`，最后以 `Object.freeze({...})` 组装请求并交给 `markAgentLoopRequest`
- 遍历失败的消息不进入证明表，因此下次请求会重试冻结
- `AbortSignal` 保持可变，实时取消能力不变

## 不做什么

- 不把 `Object.isFrozen` 当作证明：已冻结的根对象不能证明其后代已冻结
- 不信任所有 Session 消息、也不按消息 id 判定：恢复允许独立拥有的未冻结数据，替换操作可保留 id 同时改变对象身份
- 不使用强引用 `Set` 或跨 agent 的全局证明缓存：强引用会延长旧历史的生命周期，全局缓存把所有权扩大到 agent 之外
- 不改 `Session.deriveMessages()` 与 `fromRestore` 的既有语义
- 不移除下游 LLM 文件、图像与回放投影各自的冻结：它们新生成的值没有循环本地证明
- 不改变消息值、请求标记、先前请求快照、取消行为与 SDK 序列化输出

## 影响

- `packages/core/agent-loop/src/agent.ts`：新增字段与 `buildRequest()` 的冻结拆分
- `packages/core/agent-loop/README.zh.md`：请求构造与冻结所有权段落
- `docs/architecture.zh.md`：请求不可变性与实时取消段落
- `packages/core/agent-loop/tests/request-freeze.spec.ts`：新增聚焦测试（本地当前不存在该文件）
- `.agents/notes/implemented/simplification/2026-09-06-agent-request-freeze-provenance.zh.md`：新增 Agent Note

前提是消息对象身份跨请求稳定。本地 `packages/core/session/src/index.ts` 的 `deriveMessages()` 持有 `private derived: Message[] = []` 增量缓存，按 surface 节点逐个投影并返回 `[...this.derived]`，消息对象本身被共享而非重建——这一点是本变更成立的基础，需在实施前重新确认。该行为契约变更属于结构契约变更（l2）。
