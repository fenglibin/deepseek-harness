# Agent Note：图片理解在提示词准入时附加

Status: implemented

[English](2026-09-05-image-understanding-at-admission.md) | 中文

## 问题

当所选模型路由声明只接受文本输入时，每张图片都会被替换成 `[image omitted because this model accepts text only; attachment sha256:…]`，因此用户提交的截图、版面或表格对模型完全不可见，唯一的补救办法只有换模型。生成替身文字有两个候选落点，但循环和投影层都无法承担：`agent/pre-step` 在 `agent/request` 瀑布解析出真实路由之前就执行，而 `projectImagesForTextModel` 是作用在消息数组上的纯函数，无法调用模型。

## 决策

新增 `image-understanding` 能力缝，并在构建持久化 `user/message` 的地方附加描述。

- **服务定义** `ImageUnderstanding`（`packages/llm/image-understanding/src/index.ts`）回答两个问题：`resolveRoute()` 返回当前生效的视觉路由（当没有任何已注册模型支持图片时返回 `undefined`），`describe(refs)` 按输入顺序为每个引用返回一条描述或 `undefined`。
- **Provider** `LlmImageUnderstanding` 只解析一次路由 —— 通过 `ctx.llm.resolveModelInfo` 校验显式配置的 `provider`/`model` 组合，或扫描 `listModels` 找到第一个声明支持图片输入的模型 —— 随后按条目从有界缓存取用，或在 `deadline` 超时约束下发一次流式调用。它的请求把图片块和指令放在同一条用户消息里，并带上 `purpose: 'image-understanding'`。
- **Consumer** `src/consumer.ts` 中的 `describeForRoute` 是网关唯一需要的入口。路由支持图片或未挂载本服务时它返回空描述，否则委托给服务，任何失败都退化为没有描述。
- **附加点**：`packages/api/session-controller/src/commands.ts` 中的 `durablePromptContent` 为了准入编码图片已经解析了目标路由的 `inputModalities`，因此它现在用这份模态信息调用 `describeForRoute`，并把每条结果附加到对应的图片块上。`projectImagesForTextModel` 在块带有描述时渲染 `describedImageText`，否则渲染省略提示。
- **准入放宽**：纯文本拒绝只在没有描述器时保留 —— 仅当没有描述器能服务该路由时，`prompt` 才以 `MODEL_DOES_NOT_SUPPORT_IMAGES` 拒绝。

本笔记不涉及的完整能力缝设计（包括内联输入区与覆盖范围决策）见[设计文档](../../../../docs/design/image-understanding-and-inline-images.zh.md)。

## 被否决的方案

**在 `agent/pre-step` 中描述。** 否决：pre-step 在请求瀑布解析路由之前执行，无法得知目标路由的模态；它只能为所有路由描述所有图片，于是每个支持图片的路由都会白白多一次调用。而网关在准入时已经解析出权威路由。

**为描述单独追加一个会话事件。** 否决：描述属于模型在同一轮里读到的内容，而第二个事件必须在回放时重新拼接，还会重复图片块本身已经携带的附件身份。

**在 `projectImagesForTextModel` 内部描述。** 否决：投影是作用在消息数组上的纯函数，历史消息和当前轮都会经过它；它既没有上下文、没有路由，也没有调用模型的权限。

**只保存描述、丢弃图片块。** 否决：同一会话中稍后选中的支持图片的路由仍必须收到图片，因此持久化块同时保留两者。

## 影响

- **得到**：纯文本路由读到的是每张图片有界的文字说明，而不是省略提示；只要有任何已注册模型声明支持图片输入，就无需任何配置。没有任何此类模型的部署，行为与过去完全一致。
- **代价**：准入时为每张未缓存的图片多一次模型调用，受 `maxOutputTokens`、`timeoutMs` 和 `maxDescriptionChars` 约束；描述按附件与路由缓存，且只在挂载服务的生命期内有效。
- **词汇表变更**：`ImageBlock` 增加了可选的 `description`；`dsh-llm` 导出 `attachmentDigest` 和 `describedImageText`；`GenerateOptions.purpose` 增加了 `'image-understanding'`；`GenerateOptions.requestImagePolicy` 允许调用方覆盖该路由的请求图片压缩策略。
- **覆盖范围收窄**：描述在为调用方解析路由处附加 —— 网关入口路径与 loop 的 `tool/result` 落盘点（[工具结果 note](2026-09-05-tool-result-image-description.zh.md)）。直接构造 `user/message` 块的子智能体、ACP 或其他进程内调用方拿到的仍是省略提示；这一缺口记录在该包的 README 中，本次不予解决。

## 验证发现

Provider 与 Consumer 由基于真实 LLM 运行时、配脚本化适配器的单元测试覆盖；投影分支在 `dsh-llm` 中同时覆盖了有描述与无描述两种情况。准入路径通过 Session Controller Remote 覆盖，既断言纯文本路由在有描述器时准入消息并附加描述，也断言支持图片的路由不会发起任何描述调用。

两个门禁否决了第一版实现，并塑造了最终落点。Typert 的 Cordis 目录要求每个服务映射到一个子系统页面、签名中的每个类型都要归类，因此 `scripts/gen-cordis-catalog.ts` 把 `ctx.imageUnderstanding` 映射到 `llm-streaming.md`，并针对该包 README 豁免了这两个包内类型。包不变量门禁只接受空安装器，因为描述是通过准入路径本来就会追加的 `user/message` 事件进入会话日志的，所以本包自身不拥有任何事件或数据关系。
