# 实施清单

移植目标为官方提交 `73edce1ae7`。本地 `agent.ts` 相对分叉点只有 1 行差异（`inputModalities` 透传，位于工具调用路径），与 `buildRequest()` 冻结段不重叠。

## 1. 前提确认

- [ ] 1.1 确认 `packages/core/session/src/index.ts` 的 `deriveMessages()` 在多次调用间共享同一批 `Message` 对象（`derived` 缓存 + `[...this.derived]` 快照语义），并补一条断言该性质的测试 (covers: agent-loop/连续两次派生返回同一批消息对象, design/D6)
- [ ] 1.2 确认本地 `agent.ts` 类字段布局（相对官方缺 `assistantStreamRevision`、`assistantAttemptCounter`、`systemPrompt`），据此决定新字段位置，不得照抄官方行号 (covers: design/D1)

## 2. 证明集合

- [ ] 2.1 在 `ReactLoopAgent` 上新增 `private readonly frozenMessages = new WeakSet<Message>()`，JSDoc 写明「本循环已完整冻结的身份；弱引用不保留被替换的历史」 (covers: agent-loop/首次出现的消息被深冻结, design/D1)
- [ ] 2.2 确认 `Message` 类型在本地 `packages/core/agent-loop/src/agent.ts:19` 已从 `@deepseek-ai/dsh-llm` 导入，无需新增导入或官方后续的修复提交 (covers: design/D1)

## 3. buildRequest 的冻结拆分

- [ ] 3.1 在 `packages/core/agent-loop/src/agent.ts` 的 `buildRequest()` 中，把 `markAgentLoopRequest(deepFreeze({...}))` 拆开：先对本地规范化 header 执行一次 `deepFreeze(header)`，并加注释说明 `canonicalHeader` 是浅共享、`append` 记录的是独立快照 (covers: agent-loop/本地 header 每次请求都被冻结, design/D5)
- [ ] 3.2 遍历 `boundaryMessages`：命中证明集合则 `continue`，否则 `deepFreeze(message)` 后加入集合；遍历失败的消息不得进入集合 (covers: agent-loop/重复请求不重复遍历已证明的历史, agent-loop/遍历失败的身份被重试, design/D4)
- [ ] 3.3 对 `boundaryMessages` 数组本身执行 `Object.freeze`，再以 `Object.freeze({...})` 组装请求并交给 `markAgentLoopRequest` (covers: agent-loop/请求标记保留, design/D5)
- [ ] 3.4 确认 `signal` 未进入任何冻结面，实时取消能力不变 (covers: agent-loop/实时取消在分发后仍可观察, design/D5)
- [ ] 3.5 更新 `buildRequest()` 的 JSDoc：说明消息身份保留首次成功的深冻结，本地 header 每次重新冻结，信号保持实时 (covers: design/D5)

## 4. 聚焦测试

- [ ] 4.1 新增 `packages/core/agent-loop/tests/request-freeze.spec.ts`（本地当前不存在该文件，官方版 234 行），并按本地 `Session.fromRestore(id, seed, header)` 三参签名与本地 surface 字段名适配（不得整文件套用官方版本）：用例：恢复得到的浅冻结根对象被接管，嵌套消息在分发时被冻结，外围事件包装对象保持可变 (covers: agent-loop/浅冻结的恢复根对象不被当作已证明, design/D2, design/D7)
- [ ] 4.2 用例：首次遍历失败的身份在下一次请求被重新尝试冻结 (covers: agent-loop/遍历失败的身份被重试, design/D4)
- [ ] 4.3 用例：实时请求信号保持可变，且分发后仍能观察取消 (covers: agent-loop/实时取消在分发后仍可观察, design/D5)
- [ ] 4.4 用例：同一循环的重复请求不重新遍历已证明的消息（以冻结调用计数或对象身份断言） (covers: agent-loop/重复请求不重复遍历已证明的历史, design/D1)
- [ ] 4.5 用例：id 相同但对象身份不同的替换消息被重新冻结 (covers: agent-loop/保留 id 的替换不被误判为同一对象, design/D2)
- [ ] 4.6 用例：新建循环为恢复历史重新证明，不复用其他实例的证明 (covers: agent-loop/新循环为恢复的历史重新证明, design/D1)
- [ ] 4.7 用例：本地 header 的 `tools` 数组与 `NO_ADAPTER` 回退路径的 stop 数组不可变 (covers: agent-loop/本地 header 每次请求都被冻结, design/D5)
- [ ] 4.8 用例：请求仍携带 `markAgentLoopRequest` 标记；持有的旧请求快照不受后续请求影响 (covers: agent-loop/请求标记保留, design/D5)
- [ ] 4.9 用例：surface `replace` 重建派生缓存后，新消息对象在首次进入请求时被冻结 (covers: agent-loop/surface 重写后新对象获得新证明, design/D6)

## 5. 回归与文档

- [ ] 5.1 跑 `packages/core/agent-loop` 与 LLM 相关测试集，确认重建与取消测试集不回归 (covers: agent-loop/实时取消在分发后仍可观察, design/D5)
- [ ] 5.2 确认无密钥 SDK 快照（TypeScript bash-tool 与 multi-turn）无需修改期望输出 (covers: agent-loop/请求标记保留, design/D5)
- [ ] 5.3 更新 `packages/core/agent-loop/README.zh.md`：在请求 header 与适配器默认值章节后补一段，说明每个派生消息对象首次进入请求时深冻结、仅在同一 agent 内复用该证明、恢复消息保留对象身份、请求构造不冻结包含消息的事件包装对象、每个请求冻结本地 header 与请求封装而保留信号可变；**定点插入，不得整文件覆盖**（本地已有 image-understanding 段落） (covers: agent-loop/重复请求不重复遍历已证明的历史, design/D5, design/D8)
- [ ] 5.4 更新 `docs/architecture.zh.md`：在 agent 生命周期章节补一句「循环发送不可变请求，同时保留实时取消能力；只有已由该循环完整冻结的消息对象身份才能复用冻结证明」；**定点插入，不得整文件覆盖**（本地已有 image-understanding 段落） (covers: design/D5, design/D8)
- [ ] 5.5 新增 Agent Note `.agents/notes/implemented/simplification/2026-09-06-agent-request-freeze-provenance.zh.md`，含问题、决策、测量证据（246.131 ms → 67.293 ms）、考虑过的替代方案与影响 (covers: design/D1, design/D2, design/D3)
