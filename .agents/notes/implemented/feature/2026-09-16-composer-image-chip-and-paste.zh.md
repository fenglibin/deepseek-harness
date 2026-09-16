# Agent Note: 输入框图片芯片去掉删除按钮、与消息内同尺寸、粘贴兜底

Status: implemented

## Problem

输入框里的每张拖入图片都渲染一个带「×」的删除按钮。用户认为该控件多余：删除一张草稿图片用退格键即可，芯片上多一个控件既挤占缩略图空间，也让芯片比它展示的图片还宽。

第二个问题是尺寸跳变：同一张图在输入框里是 20px 缩略图，发送进消息后变成 40px 缩略图。用户在一条消息里看到图片「变大」，与刚才在输入框里看到的不一致。

第三个问题是粘贴。系统截图进入剪贴板时浏览器给出的是文件项，现有 `PASTE_COMMAND` 处理器已经能接住；但「右键复制图片」在部分浏览器里只给出 `text/html` 片段，图片以 `data:` 内联，`clipboardData.items` 里没有任何文件项，于是粘贴看起来「不支持」。此外，粘贴落在输入框卡片而焦点不在可编辑区时，没有任何监听器接管——拖拽早就由卡片兜底（`onCardDrop`），粘贴却没有对称的兜底。

## Decision

芯片只保留缩略图本身：删除按钮连同它的 `removeLabel` 文案、`ImageChipLabels.removeLabel`、`SessionInputDeps.imageLabels.remove`、`image.remove` 文案一起移除。`ImageChipNode` 不再持有 `__onRemove`，`$createImageChipNode` 只剩 `insert` 与 `labels` 两个参数。删除手势落在 Lexical 已有的向后删除上，由 `input-bar.client.spec.tsx` 的「drops a whole chip with the backward-delete gesture」锁定：一次 `deleteCharacter(true)` 拿走整枚芯片，而不是芯片的一部分。

消息内缩略图与芯片同一尺寸：`InlineMessageImage.module.css` 的 `.frame` 从 40×40 改为 22×22 且 `box-sizing: border-box`，1px 边框之内正好是 20×20 的图像，与 `ImageChip.module.css` 的 `.chip`（22px 高）和 `.img`（20×20）配对。jsdom 没有布局，因此两侧各用一条 CSS 文本断言锁住自己那一半，并在注释里互相指向。

粘贴走两条路。一是 `paste-images.ts` 的 `clipboardImageFiles`：优先取剪贴板文件项，一个都没有时再从 `text/html` 片段里解析内联 `data:` 图像（`embeddedImageFiles`），解码为命名文件后交给同一条 `intakeImages` 通道，因此与拖入的后续处理完全一致。二是 `InputBar` 新增 `onCardPaste`，与既有 `onCardDrop` 对称：卡片（而非内部可编辑区）拥有粘贴手势，编辑器已经 `preventDefault` 的粘贴不会重复受理。

远程 `http(s)` 内联图像**不**受理：取回它需要发一次网络请求，那已经不是粘贴了。

## Alternatives considered

**保留删除按钮、只改样式。** 修掉拥挤感，但用户明确要求「去掉该删除标识仅展示图片」，且保留它就还要保留一条只服务该按钮的 locale 文案。

**把消息内尺寸放大到与芯片容器一致（22px 外框）而不是缩小芯片。** 用户诉求是「图片展示的大小和消息发送框的大小保持一致」，方向是让消息向输入框看齐；放大消息侧会让用户抱怨的「变大」更严重。

**在组件内直接解析 HTML 字符串（正则）。** 省一个文件，但 `data:` URL 的字符集与边界靠正则维护很脆；用 `DOMParser` 只取 `img[src]` 更安全，也不执行片段里的任何内容。

**为远程内联图像补一次 `fetch`。** 能覆盖 Firefox 复制图片的情形，但引入跨域失败、额外时延和隐私外发，收益不确定；明确不做，等有真实需求再评估。

**删掉既有的 64px `MessageImage` gallery。** 它已无生产调用方（只有测试引用），但清理属于另一项 simplification，不在本次范围内。

## Consequences

输入框每张图少一个控件、窄约 22px；删除只剩键盘手势，纯鼠标用户需要先把光标移到芯片旁。消息里的图片变小（40px → 20px 图像），与草稿一致，但缩略图细节更少——查看原图仍走既有的 hover 预览与点击 lightbox。

`paste-images.ts` 是新增模块；`DataTransfer` 在 jsdom 测试里以最小结构桩替代，因此该模块的测试覆盖的是提取逻辑，不是浏览器真实的剪贴板行为。是否真的接住了某个浏览器的「右键复制图片」，仍需在本机实测确认。
