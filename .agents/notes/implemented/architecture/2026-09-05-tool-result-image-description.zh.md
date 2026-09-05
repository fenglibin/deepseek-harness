# Agent Note：工具结果图片在结果落盘时描述

Status: implemented

## 问题

准入期为网关入口路径（`session/prompt`、`session/updateQueue`）的图片生成描述，但工具在准入之后可能产出图片——截图、渲染出的图表。这类图片承载在 `tool/result` 事件里，从不经过网关 inbox，因此纯文本路由把它投影为 `[image omitted because this model accepts text only; attachment sha256:…]`。工具结果内容本来就流经具体 loop，但在持久化结果落盘之前没有环节去描述它。

## 决策

在 `tool/result` 事件落盘点描述工具结果图片：`packages/core/agent-loop/src/tool-calls.ts` 的 `appendToolResult`。

- **同一个 consumer，新的调用点。** `appendToolResult` 用 `collectImageRefs` 收集 `result.content` 里的图片引用，调用既有的 `describeForRoute(ctx, refs, inputModalities, signal, session.id)`，再在 `createToolResultMessage` 之前用 `attachImageDescriptions` 挂上返回的描述。这两个 `dsh-llm` 辅助函数以与 `replaceImagesForTextModel` 相同的递归形态遍历嵌套的工具结果内容，使被描述的图片在下一次纯文本投影时渲染为 `describedImageText`。
- **调用点持有路由权威。** `executeToolCalls` 新增目标路由的 `inputModalities` 参数；step 循环传入 `preparedCall.inputModalities`——请求正在派发的精确模态。缺失声明意味着未知而非纯文本，于是 loop 不做描述，投影行为与从前完全一致。
- **降级，绝不阻塞结果。** `describeForRoute` 在路由接受图片、未挂载描述器或调用失败时本就返回无描述，因此缺失或损坏的视觉路由只让模型失去描述，绝不让工具结果本身丢失。

本 note 复用的网关准入机制与接缝三角色见[准入期 Agent Note](2026-09-05-image-understanding-at-admission.zh.md)；完整设计见[设计文档](../../../../docs/design/image-understanding-and-inline-images.zh.md)。

## 已考虑并否决的替代方案

**在 `projectImagesForTextModel` 里描述。** 否决：投影是对冻结消息数组的纯函数，不能调用模型。

**在 `agent/pre-step` 里描述。** 否决：pre-step 时工具结果尚不存在，而本步自己的结果内容要到工具结算后的落盘点才可得——正是本 note 选择的时机。

**先落盘结果、再描述并改写。** 否决：落盘后再做 `surfaceOp: replace` 改写会偏离下一请求的前缀并使 provider 前缀缓存失效；描述必须与结果同一次落盘。

## 后果

- **收益**：纯文本路由读到每张工具产出图片的有界描述而非省略占位符，主 agent 与任何经同一 loop 运行工具的 subagent 均覆盖。
- **成本**：结果落盘内每个未缓存的工具结果图片多一次理解调用；调用与准入期受同一 `timeoutMs`、`maxOutputTokens`、`maxDescriptionChars` 约束，并复用按附件的缓存。
- **loop 拥有调用点**：`appendToolResult` 变为异步，有序落盘本就 await 它；描述仍落在同一个 `tool/result` 事件里，模型可见文本始终可从日志重建。

## 验证结论

`dsh-llm` 覆盖 `collectImageRefs` 与 `attachImageDescriptions` 的嵌套顺序、无变化返回与不可变。loop 在真实 runtime 上以脚本化 adapter 与桩描述器覆盖三种情形：纯文本路由挂上描述、图片路由不发起描述调用、缺失描述器时图片保持无描述。

(End of file - total 44 lines)
