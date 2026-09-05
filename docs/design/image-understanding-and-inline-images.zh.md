# 图片输入与图片自动理解设计

[English](image-understanding-and-inline-images.md) | 中文

本文记录两项耦合特性的设计：在会话输入框里内联编辑图片，使其与文字交错排列；以及图片自动理解，让不具备图片输入能力的模型路由仍能收到图片所展示的内容。本文作为实现与验收的依据。每项决策的「为什么」与放弃项见随实现一同提交的 Agent Note。

## 1. 现状

有五个既有机制决定了设计空间。

协议格式本身就承载有序内容。`PromptContentPart` 是文本部分与图片部分的联合类型，`SessionPromptRequest.content` 是它们的数组，`../../packages/api/session-controller/src/commands.ts` 中的 `durablePromptContent()` 按顺序把每个部分映射为一个内容块。主机端因此保留了交错顺序；丢掉它的只有客户端，因为 `../../packages/client/ui-conversation/src/client/service.ts` 里的 `sendSession` 构造的是 `[...images, ...text]`，图片永远排在文字之前。

请求图片压缩已经存在。`../../packages/attachment/attachment/src/index.ts` 中的 `AttachmentStore.readImageRequest()` 接受一个由 `maxPixels` 与 `maxBytes` 组成的 `ImageRequestPolicy`，对已存储的归一化图片做等比缩放，再按质量阶梯重新编码。两个适配器在序列化支持图片的请求之前都会调用它。

纯文本路由已经会做替换。`../../packages/llm/llm/src/index.ts` 中的 `LlmRuntime` 从解析出的模型信息里读取 `inputModalities`，当其中不含 `image` 时，把每个图片块替换为 `../../packages/llm/llm/src/content.ts` 中 `textOnlyImageText()` 生成的固定占位文本。模型只被告知有一张图片被省略，得不到关于这张图片的任何信息。

网关会拒绝发给这类路由的图片输入。会话控制器的 `prompt()` 在准入任何消息之前就抛出 `session/attachment-invalid` 并带上 `MODEL_DOES_NOT_SUPPORT_IMAGES`，用户看到的因此是一条错误，而不是一条已发出的消息。

客户端把图片放在编辑器之外。`../../packages/client/ui-conversation/src/client/contract/input.ts` 中的 `InputState.imageIds` 是文字草稿旁边一个扁平有序数组，缩略图通过 `conversation.input.attachments` slot 渲染在输入框上方的一条图片栏里。

两条仓库不变量约束着本设计。所有模型可见的内容都必须能从会话日志重建；而 `llm/stream` 交给监听方的 loop 构造请求是深度冻结的，其内容纯粹是该日志的函数，监听方只能读、不能改写。

## 2. 需求

1. 用户可以把图片放在草稿里的任意位置：粘贴、拖放或挑选，图片落在光标处、夹在文字之间。
2. 提交时按图片在草稿中出现的顺序发送文字与图片。
3. 不具备图片输入能力的模型路由仍然能以生成的文本收到图片内容，用户看不到错误，也不需要额外操作。
4. 支持图片的路由继续收到它与今天相同的压缩请求图片。
5. 会话日志始终是模型所见的唯一真源。
6. 由哪条视觉路由执行理解，属于配置，而非常量。

## 3. 方案决策

### 3.1 决策 A：一条能力 seam，`ctx.imageUnderstanding`

新包承担能力 seam 的全部三种角色。Service Definition 声明什么是描述、何时没有描述；Service Provider 通过 `ctx.llm` 调用一条配置好的视觉路由；Consumer 按步骤判断哪些图片需要描述。该包放在 `packages/llm/` 下、紧邻它所消费的能力，并作为一条普通的 Cordis 配置项挂载。

### 3.2 决策 B：在提示词准入时做描述，而不是在 `agent/pre-step`，也不是在请求出口

`agent/pre-step` 不合适，因为它运行在 `agent/request` 瀑布解析出实际派发路由之前，那里的监听方无法得知目标路由的输入模态，只能对每条路由的每张图片都做一次描述。请求出口不合适，因为那里的内容是深度冻结且未落盘的。会话控制器里的 `durablePromptContent()` 与 `../../packages/sdk/server/src/server.ts` 里的 SDK 对应实现才是权威落点：它们本就解析目标路由的 `inputModalities` 来准入编码图片，因此带着这些模态与所属 `sessionId` 调用描述器，再把每个结果挂到 loop 随后追加进日志的图片块上。`sessionId` 把每次理解调用绑定到与所属消息相同的已录制会话，使无密钥重放能把调用路由到那里。

### 3.3 决策 C：描述挂在图片块上

`ImageBlock` 增加一个可选的 `description`，承载描述文本以及产出它的路由身份。该块保留自己的 `attachment`，因此适配器、transcript（文本记录）与压缩（compaction）都无需改动，请求投影也仍然是日志的纯函数。改用独立的 `image/described` 事件可以做到每条附件每会话只存一份、而不是每次出现存一份，但它会新增一个 `SessionEventMap` 成员，而所有不认识该类型的构建在读取时都会拒绝整份日志，而且消息组装时还要多一步关联。所选载体每次出现存一份，并靠会话内缓存把视觉调用次数压到每条附件一次。

### 3.4 决策 D：网关的拒绝只在仍然成立时保留

`prompt()` 保留这项检查，但仅当路由缺少 `image` **且**没有可用的描述路由时才拒绝。存在描述路由时，提示词被准入，理解在下一步发生。没有视觉路由的部署保留今天那条明确的 `session/attachment-invalid` 失败，而不是静默降级成占位文本。

### 3.5 决策 E：内联图片变成编辑器节点，有序部分列表取代 `imageIds`

图片以「每条附件一个原子 decorator 节点」的形式进入 Lexical 文档，模型参照 `ReferenceChipNode`，投影则新增对应的段类型。提交货币变成从文档派生的、有序的文本与图片部分列表，取代独立的 `imageIds` 数组。协议格式与主机端为此无需改动。

### 3.6 决策 F：图片栏退役

图片一旦进入草稿，输入框上方那条图片栏就只剩下第二条、且无序的录入通道。`packages/client/ui-attachment` 与 `conversation.input.attachments` slot 一并移除，原先针对图片栏做的限额预检改到粘贴与拖放的处理函数里。

## 4. 主机端设计

### 4.1 Service Definition

`ctx.imageUnderstanding` 暴露当前生效的路由，本次部署无法描述图片时为 `undefined`；另有一个 `describe()` 调用，接受一批有序的持久化引用。它按输入下标对齐返回数组，其中 `undefined` 表示该图片没有描述，调用方据此回退到既有占位文本。静默失败是合法返回值；抛错只留给配置错误的路由。

### 4.2 基于 LLM（大语言模型）的 Service Provider

配置承载 `provider`、`model`、指令文本、输出上限、超时，以及理解调用所用的请求图片策略。`provider` 与 `model` 留空表示自动选择：挑第一条 `inputModalities` 含 `image` 的已注册模型，并把选择记入日志。配置出来的路由在首次使用时校验，必须声明图片输入能力，因此把纯文本路由配在这里会快速失败。调用本身复用请求图片阶梯，用压缩后的图片做描述，然后以新的 `image-understanding` purpose 与所属 `sessionId` 通过 `ctx.llm` 流式发一次请求并取首个文本块，与压缩摘要器驱动辅助调用的方式完全一致。

### 4.3 提示词准入处的 Consumer

`describeForRoute` 仅在解析出的目标路由缺少图片输入时才工作。会话控制器里的 `durablePromptContent()` 与 SDK 对应实现用已准入的编码图片、该路由的 `inputModalities` 与所属 `sessionId` 调用它；它用按路由的缓存逐个解析尚未描述的附件，使每条附件只花一次视觉调用，并按输入下标对齐返回描述或 `undefined`。失败、超时与取消都退化为无描述，只记一条警告，绝不阻断准入。控制器把每个结果挂到它的图片块上，描述因此随消息一起进入日志。

### 4.4 请求投影

`projectImagesForTextModel()` 保持结构不变，只多一个分支：带描述的图片块渲染为该描述并注明其来源路由，没有描述的图片块渲染为既有的省略占位文本。两段文本都是固定的模型可见字符串，都由快照覆盖钉住。

## 5. 客户端设计

### 5.1 图片节点

`ImageChipNode` 是一个内联、不可被键盘选中的 decorator 节点，持有草稿附件 id 以及缩略图所需的展示缓存。退格整体删除它，方向键一步跨过它，与引用 chip 一致。它的文本投影为空，因此持久化的草稿仍然只保存键入的文字——这与浏览器持有的图片字节不会跨刷新存活这一事实相符。

### 5.2 投影

`ComposerSegment.kind` 增加 `image`，布局遍历在检测视图里给每张图片一个原子字符、在剪贴板视图里不给任何字符。`EditorProjection` 在 `occurrences` 之外再增加一个有序的 `images` 列表，shell 因此能按文档顺序派生部分列表，而不必去切分字符串。

### 5.3 提交

`InputState` 发布派生出的部分列表；`addImages` 与 `removeImage` 从数组追加改为在光标处编辑；默认 sink 改为接收部分列表，而不是「文本 + id 数组」；`sendSession` 把部分列表直接映射为 `PromptContentPart`。本地回显接收同一份部分列表，使待发送消息气泡呈现用户所编排的交错顺序。命令 claim 保持今天的语义：文本参数加独立的图片列表。

### 5.4 录入与图片栏

粘贴、拖放与工具栏按钮走同一条路径：插入到当前选区。原先位于图片栏缩略图上的移除与预览操作移到 chip 上，它们所用的本地化文案一并迁移。

## 6. 暂缓范围

工具结果可以包含图片，例如截图工具，而它们不经过网关 inbox。loop 在 `tool/result` 落盘点经同一能力缝为它们生成描述（[Agent Note](../../.agents/notes/implemented/architecture/2026-09-05-tool-result-image-description.zh.md)）。

## 7. 验证

主机端行为由针对该服务、投影分支与 Consumer 的单元测试覆盖，另加一个 REAL-composition 测试：启动一条纯文本路由并替换描述器，断言模型可见的请求文本。一条免密钥的录制会话快照钉住模型可见的占位文本与描述文本。客户端工作补充针对光标处插入、删除与有序提交的组件覆盖，并由 `pnpm run test:gui` 与 `DSH_SNAPSHOT=replay pnpm run test:web` 覆盖组装后的输入框。

## 8. 未决问题

准入时解析的路由是权威的，因此之后改写路由的监听方最多浪费一次描述调用；图片块保留自己的 attachment，所以支持图片的路由仍收到图片，纯文本路由仍收到描述。首步之前多出的几秒延迟是否需要一条非阻塞的输入框提示，属于产品取舍；本设计假定理解进行期间显示一条简短的本地化提示。
