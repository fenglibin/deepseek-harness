- [revision 4] # P3 工具结果图片理解 —— 实现规格

## 1. 范围
在 agent-loop 的 appendToolResult 里，按目标路由 inputModalities 描述 tool-result 内容里的 image 块，把描述挂到 image 块随 tool/result 落盘。主 agent 与 subagent 均覆盖；无 describer、图片路由或描述失败时降级为既有省略占位符。

## 2. dsh-llm 改动（packages/llm/llm/src/content.ts）
- 新增 `collectImageRefs(blocks): ImageAttachmentRef[]`：按出现顺序递归收集 image 引用（走 tool-result 嵌套），与 attachImageDescriptions 配对。
- 新增 `attachImageDescriptions(blocks, descriptions): ContentBlock[]`：按出现顺序把描述挂到 image 块，`undefined` 保留无描述，无变化时返回原列表，不 mutate 持久化块。
- 两者与 replaceImagesForTextModel 同一递归形态；index.ts 已 `export * from './content.ts'`，自动 re-export。

## 3. agent-loop 改动（packages/core/agent-loop）
- src/tool-calls.ts：`appendToolResult` 变 async，新增 ctx + inputModalities + signal 入参；在 createToolResultMessage 之前 collectImageRefs → describeForRoute(ctx, refs, inputModalities, signal, session.id) → attachImageDescriptions。`executeToolCalls` 新增 inputModalities 参数并贯穿 runGroup；`appendSkippedToolCall` 变 async 并传新参数。
- src/agent.ts：executeToolCalls 调用处传 `preparedCall?.inputModalities`。
- package.json：image-understanding 加入 peerDependencies + devDependencies（照 dsh-llm 先例）。
- tsconfig.json：references 增加 llm/image-understanding。

## 4. 测试
- dsh-llm content.spec：collectImageRefs 嵌套顺序/空列表；attachImageDescriptions 按序挂载、undefined 跳过、不 mutate、无变化返回原列表。
- agent-loop tool-calls.spec：纯文本路由 + 桩描述器 → tool/result 的 image 块带 description；图片路由 → 不发起描述调用；无 describer → image 块无 description。
- mock-adapter.ts：MockAdapter 增加可选 inputModalities 参数，resolveModel 透传。

## 5. 文档
- 新增 full Agent Note（architecture/2026-09-05-tool-result-image-description 三语）。
- image-understanding README：Known Limitations 与 Dev Note 更新（工具结果已覆盖，user/message 直构仍是 gap）；KV Cache 更新为「归属事件落盘时固定」。
- agent-loop README：Turn and step flow 加一句工具结果图片描述。
- docs/architecture + design doc 第 6 节：同步指向实现。
- P1 准入 note 的 Narrowed coverage 改写为反映工具结果已覆盖。
