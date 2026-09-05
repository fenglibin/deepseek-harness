# Agent Note：内联图片 composer（rail 退役）

Status: implemented

[English](2026-09-05-inline-image-composer.md) | 中文

## 问题

草稿图片此前位于 Lexical 编辑器之外，是 input facade 持有的扁平 `imageIds: DraftAttachmentId[]` 数组，由独立附件 rail（`conversation.input.attachments`）渲染。文字与图片是两套互相独立的货币，于是 `sendSession` 把 prompt 组装成 `[...serializedImages, ...text]`——图片永远排在文字之前，丢弃用户在 composer 中摆放的交错顺序。rail 本身也是独立的滚动表面，草稿无法用一条有序流程同时呈现文字与图片。

## 决策

让内联图片成为 composer 文档里的原子 decorator 节点，并让有序 `DraftPart[]` 成为唯一的提交货币。

### ImageChipNode（editor/image-node.tsx）

`ImageChipNode` 仿照 `ReferenceChipNode`：`DecoratorNode`，`isInline()` 为 true、`isKeyboardSelectable()` 为 false，`getTextContent()` 返回 `''`（持久化草稿只保留 typed text；浏览器图片字节本就不跨 reload），detect 投影为一个 U+FFFC。其 decorate 渲染缩略图、行内移除按钮与点击预览灯箱；移除回调与插入时的显示缓存（`previewUrl`/`name`/`width`/`height`）挂在节点上，不进入序列化状态。

### 投影（editor/projection.ts）

`ComposerSegment.kind` 增加 `'image'`；`$composerLayout` 把图片叶子记为 `pushLeaf('image', kid, ATOMIC_CHAR, '')`（clipboard 长度为零），`$projectComposer` 在 `occurrences` 之外返回有序 `images: DraftImage[]`（`attachmentId` + clipboard `offset`）。

### InputState 用 parts 取代 imageIds（contract/input.ts）

`DraftPart = {type:'text';text} | {type:'image';attachmentId}`；`InputState.parts` 按文档顺序派生，`draft` 仍是 clipboard 投影。`SessionInput.addImages(inserts: DraftImageInsert[])` 在 caret 插入 chip，`removeImage(id)` 移除节点并经新增的 `releaseImage` 依赖释放 registry object。`pruneImages` 删除：rail 退役后每次 registry 释放都伴随 chip 移除，不存在失效节点残留可清。

### 有序提交（service.ts sendSession + hub/facade defaultSink）

`defaultSink` 从 `(text, imageIds, mode, signal)` 改为 `(parts, mode, signal)`；`sendSession` 按文档顺序把 parts 映射为 `PromptContentPart[]`（text → `{type:'text'}`，image → 序列化 base64 → `{type:'image'}`），取代 `[...images, ...text]`。本地提交回显（`beginSubmission`）按同一 parts 顺序渲染。失败发送把图片 chip 恢复到记录下来的 offset。

### rail 退役

移除 `conversation.input.attachments` slot 与 ui-attachment 的 `ComposerAttachments`/`DropOverlay`/`AttachmentRail`；`MessageImages`（transcript 渲染）保留。移除/预览交互迁到 chip decorator，文档级文件拖放与摄入限额预检迁到 composer 的 paste/drop 处理器（`intakeFiles`）。总大小预检离开 composer：由 host 在提交时 enforce，拒绝经 `session/attachment-invalid` notice 落在既有的 reason-copy 映射上。被退役的 rail 记录于[附件展示对齐 Note](2026-08-11-web-attachment-display-alignment.zh.md)，其 slot 记录于[动态渲染与附件归属 Note](../architecture/2026-08-17-dynamic-client-render-and-attachment-ownership.zh.md)；两者因其 transcript 图片与 slot 组合决策而保持 active。

### 命令提交保持不变

`CommandClaim.submit` 仍收 text 参数加独立 `images` 列表，故 `serializeDraftImages` 与 command-images 通道原样保留。

## 备选方案

### 为什么用内联 chip 而不是保留 rail？

独立 rail 无法表达交错——提交路径没有坐标把文字与图片重新拼回，这正是它总是把图片前置的原因。内联节点让交错有了唯一来源（文档顺序），持久化与提交都从它读取。

### 为什么用零宽 clipboard 投影而不是 draft 占位符？

图片字节归浏览器所有、永不持久化，因此持久化草稿应保持纯 typed text。零宽投影让 `draft` 对持久化保持不变，同时仍能通过段遍历在 `parts` 里给图片排序；占位 token 会泄漏进持久化草稿与每条模型可见文本路径。

## 后果

`InputState.parts` 现在是 composer 的公开提交货币；读取 `imageIds` 的消费方改读 `parts`。`removeImage` 拥有 registry object 释放（`releaseImage`），hub 不再在移除时单独释放草稿图片。detached 失败恢复按记录 offset 重建图片 chip。composer 摄入预检保留格式、数量与单文件大小，总大小交给 host 的提交时拒绝。
