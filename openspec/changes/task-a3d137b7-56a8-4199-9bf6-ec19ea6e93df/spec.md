- [revision 4] # P2 客户端内联图片 — 行为规格

## 目标

图片成为 Lexical 草稿文档里的内联节点，提交时文字与图片按用户在草稿中放置的顺序发送，附件 rail 退役。

## 需求

1. **内联放置**：用户可粘贴、拖拽或通过工具栏按钮选择图片，图片落在当前 caret 处、与文字交错；每张图片是文档里一个原子、不可键盘选中的 decorator 节点（`ImageChipNode`）。
2. **有序提交**：提交时 `session.prompt` 收到的 `PromptContentPart` 数组按草稿文档顺序排列——text 段 → `{type:'text',text}`，image 段 → 序列化 base64 的 `{type:'image',...}`；不再 `[...images, ...text]` 强制图片前置。
3. **本地回显交错**：本地提交回显（beginSubmission）按同一 parts 顺序渲染，pending 气泡显示用户组合的交错。
4. **chip 交互**：chip 显示缩略图；Backspace/Delete 整块移除；点击预览原图（轻量 lightbox）；chip 上提供移除按钮（rail 移除交互的迁移）。
5. **rail 退役**：`conversation.input.attachments` slot 与 ui-attachment 的 ComposerAttachments 消费移除；`MessageImages`（transcript 图片渲染）保留。
6. **拖拽/限额**：文档级拖拽覆盖层与图片限额预检迁到 composer 的 paste/drop 处理器。
7. **持久化 draft**：图片的文本投影为空，持久化 draft 只保留 typed text（浏览器图片字节本就不跨 reload）。
8. **命令提交不变**：`CommandClaim.submit(args, actx, images)` 仍收 text 参数 + 独立图片列表；`serializeDraftImages` 通道保留。

## 验收

- `InputState.parts`（有序 DraftPart）取代 `imageIds`；`draft` 仍是 clipboard 投影。
- 一张图片夹在两段文字之间提交时，Host 收到的 content 顺序为 [text, image, text]（REAL-composition 或组件测试断言，配 snapshot/回放覆盖交错顺序）。
- 移除图片后提交不再包含该图片；失败恢复把图片 chip 恢复到原文档位置。
- `test:gui` 全绿；`verify-client-ui-i18n` 全绿（chip 文案走 typed locale 字典）；改动触及可见 UI 时 `DSH_SNAPSHOT=replay pnpm run test:web` 通过。
