# 内联图片与图片理解缺陷修复方案

本文记录 [图片输入与图片自动理解设计](../design/image-understanding-and-inline-images.zh.md) 落地后暴露的四类缺陷的根因与修复方案。根因结合用户报告与一份真实会话日志（`~/Downloads/dsh-session-session-d11205c1-d733-49fa-bf8f-4129a5eb7ad5/session.jsonl`）定位。本文是实施依据，不包含实现代码。

## 1. 问题清单

用户报告的四个问题：

1. 输入框中的图片太小，鼠标悬停不显示预览图。
2. 消息发送后，页面上消息与图片换行展示，而非一条内联消息；期望消息与输入框一致，图片以图标展示、悬停显示预览。
3. 在不支持图片的模型中发送带图片的消息，模型回复"不支持图片"——说明发给模型的消息里图片信息不符合要求。
4. 设置页的「模型」中没有图片理解模型的配置项。

## 2. 根因分析

### 2.1 问题 1：输入框图片太小、悬停无预览

定位文件：

- `packages/client/ui-conversation/src/client/input/editor/ImageChip.module.css`
- `packages/client/ui-conversation/src/client/input/editor/ImageChip.tsx`

根因：

- `.chip` 高度固定为 `22px`，`.img` 的 `max-height` 为 `20px`、`max-width` 为 `120px`，缩略图被压到几乎不可见。
- 预览由 `ImageChip` 的 `onClick` 打开全屏 lightbox 触发，而非悬停触发。需求要求「鼠标放到图片上展示预览图」，与当前交互不符。

### 2.2 问题 2：消息气泡图片换行展示

定位文件：

- `packages/client/ui-chat/src/client/chat/MessageItem.tsx`
- `packages/client/ui-attachment/src/MessageImage.tsx`
- `packages/client/ui-attachment/src/client/MessageImages.tsx`

根因：

- `MessageItem.tsx` 的 `contentRuns()` 把有序的用户消息内容折叠为 `BubbleRun[]`，每个 run 只属于 `text` 或 `images` 之一。
- `UserStyleBubble` 渲染 run 时，`text` run 渲染为独立的 `<div class="bubble">`，`images` run 渲染为 `renderMessageImages`，后者经 slot `conversation.message.images` 落到 `MessageImages` → `ImageGallery`，把图片渲染成独立的 240px 单图或 64px 方块图块。
- 这些块在 `userStack` 中纵向堆叠，图片因此成为独立的换行大图，而非穿插在文字流中的内联图标。消息历史侧沿用了旧的 `ImageGallery` 大图展示，未实现设计文档 5.2、5.3 要求的「图片作为内联图标与文字交错」。
- `PendingSteeringBubble` 与 `PendingSubmissionBubble` 复用同一个 `UserStyleBubble`，因此待发回显与历史回显呈现同一问题。

### 2.3 问题 3：不支持图片的模型返回"不支持图片"

定位文件：

- `packages/llm/image-understanding/src/index.ts`
- `packages/llm/image-understanding/src/consumer.ts`
- `packages/api/session-controller/src/commands.ts`
- `packages/llm/llm/src/content.ts`
- `packages/llm/llm-deepseek/src/index.ts`

会话日志证据：

- 用户当前模型为 `tencent-tokenplan` 提供方的 `deepseek/deepseek-v4-flash-0731`，是纯文本模型。
- 最终 `user/message` 事件的图片块只有 `attachment`、没有 `description` 字段，且事件流中没有任何图片理解调用痕迹。
- 助手回复的 reasoning 原文为「image omitted because this model accepts text only」，即模型收到的是 `textOnlyImageText()` 生成的省略占位文本，而非图片描述。

根因链：

1. 目标路由 `inputModalities` 不含 `image`，`routeExcludesImages()` 为真，走描述路径。
2. `canDescribeImages()` 调用 `resolveRoute()`，后者经 `discoverRoute()` 自动寻找第一个 `inputModalities` 含 `image` 的模型。DeepSeek 官方提供方默认注册了 `deepseek-v4-flash-vision-exp`，因此 `canDescribeImages()` 返回真，`prompt()` 不抛出 `MODEL_DOES_NOT_SUPPORT_IMAGES`，消息被放行。
3. `describe()` 调用 `describeOne()` 实际请求该视觉模型时失败——视觉模型属于 `deepseek-official` 提供方，而用户凭据配置在 `tencent-tokenplan`，缺少凭据或端点不可达，或实验性模型不可用。
4. `describeOne()` 的 `catch` 只记 warning 并静默返回 `undefined`，图片块不带 `description`。
5. `projectImagesForTextModel()` 把无描述的图片块替换为 `textOnlyImageText()` 占位文本，模型只能回复"我看不到图片"。

本质是图片理解 seam 的视觉路由没有被正确配置或调用成功，且失败路径被静默降级，用户既得不到描述也看不到明确的配置错误。

### 2.4 问题 4：设置缺少图片理解模型配置

定位文件：

- `packages/bundle/base/cordis.patch.yml`
- `packages/llm/image-understanding/src/index.ts`
- `packages/client/ui-settings-models/src/client/`

根因：

- `cordis.patch.yml` 中 `image-understanding` 的挂载为空，没有 `config`。
- `LlmImageUnderstanding.Config` 声明了 `provider`、`model`、`instruction`、`maxOutputTokens` 等字段，但仅在 cordis.yml 可配，客户端没有入口。
- `ui-settings-models` 只处理普通提供方与模型目录，没有为图片理解暴露视觉模型选择。
- 设计文档需求 6 要求「由哪条视觉路由执行理解属于配置，而非常量」，实现只做了自动发现，缺少配置界面，导致自定义提供方场景下用户无法指定视觉模型。

## 3. 修复方案

### 3.1 修复 A：输入框 chip 尺寸与悬停预览（问题 1）

- 调整 `ImageChip.module.css`，增大缩略图尺寸，使 chip 不再受 22px 行高束缚，改用固定的内联缩略图尺寸（例如 36–48px 方形缩略图）。
- 将预览从点击打开 lightbox 扩展为悬停触发浮层预览：`ImageChip.tsx` 增加 `onMouseEnter`/`onMouseLeave` 及定位浮层，悬停显示原图，点击仍打开 lightbox。

### 3.2 修复 B：消息气泡内联图片渲染（问题 2）

- 新增「消息内联图片图标」组件，视觉与输入框 chip 一致，悬停显示预览、点击打开 lightbox。
- 修改 `MessageItem.tsx` 的 `UserStyleBubble`：`images` run 不再渲染 `ImageGallery` 大图块，改为把每张图片渲染成内联图标，穿插在 `projectUserText` 输出的文本流中。
- `PendingSteeringBubble` 与 `PendingSubmissionBubble` 复用同一 `UserStyleBubble`，改一处即让待发回显与历史回显一致。

### 3.3 修复 C：图片理解配置界面（问题 4，问题 3 的前提）

- 在 `ui-settings-models` 中为图片理解暴露提供方与模型选择，复用 `remote.llm` 的提供方目录与模型列表，可选暴露 `instruction`、`maxOutputTokens`。
- 主机端把该配置落到 `cordis.yml` 的 `image-understanding` `config`，或经 settings schema 持久化，与 `LlmImageUnderstanding.Config` 对齐。

### 3.4 修复 D：图片理解失败反馈（问题 3）

- 视觉路由配置正确后，图片块带 `description`，投影为 `describedImageText()`，模型收到真实描述。
- 为 `describeOne()` 的失败与「理解进行中」补充非阻塞的本地化提示，避免消息已发送而模型看不到图的困惑（设计文档 §8 亦提出该提示）。
- 保留 `MODEL_DOES_NOT_SUPPORT_IMAGES` 的明确拒绝语义，确保自动发现找不到视觉路由时仍按决策 D 明确失败，而非静默降级。

## 4. 实施顺序与依赖

1. 修复 C 与修复 D 是主机端与设置 UI 的协同改造，且 C 是 D 真正生效的前提，作为同一批实施。
2. 修复 A 与修复 B 是纯客户端 UI，相互独立，可与 1 并行或随后实施。
3. 改动涉及客户端 UI、cordis 配置与新增 locale 文案，须同步补充单元测试、快照与 Agent Note。

## 5. 验证计划

- 主机端：针对服务、投影分支与消费者补充单元测试；新增一条 REAL-composition 测试验证纯文本路由经描述器后模型可见的请求文本；免密钥录制会话快照钉住描述文本与省略占位文本。
- 客户端：针对光标处插入、删除、有序提交及消息内联渲染补充组件测试，由 `pnpm run test:gui` 与 `DSH_SNAPSHOT=replay pnpm run test:web` 覆盖组装后的输入框与消息气泡。
- 配置界面：为图片理解模型选择的读写链路补充设置页组件测试与快照。
