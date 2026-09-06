# Agent Note: 图片拖放落点与图片理解模型的能力声明

Status: implemented

## Problem

两个用户可见的图片缺陷同源不同支：一条是浏览器默认行为没有被接管，一条是部署没有地方陈述一个只能由它陈述的事实。

其一，把图片拖到对话框上松手，有时会在新标签页里打开这张图片，刷新几次之后又能正常拖入。拖放只被 Lexical 注册在 contenteditable 根节点上，而 contenteditable 只是对话框胶囊的一部分：胶囊的内边距、占位条所在层、底部工具行都不在它的范围内。落在这些区域的 `drop` 触不到任何监听器，浏览器就用它自己的默认回答——导航到这个文件，当前草稿随之丢失。是否落在 contenteditable 之内取决于松手那一刻的像素位置和草稿高度，所以表现为时好时坏。

其二，在「设置 → 模型」的「图片理解模型」里选了视觉模型，发送带图片的消息仍然被拒为「图片描述模型配置无效」。用户的提供方是 `llm-pi-ai` 下的手写路由（`venus-deepseek`），其 `models` 条目只有 `id` 和 `name`。`resolveRouteModels` 的取值链是 `entry.input ?? base?.input ?? route.defaultInput`，三级都没有答案时落到 `defaultInput`，而 `DEFAULT_INPUT` 是 `['text']`。于是这个模型向目录声明自己只接受文本，`LlmImageUnderstanding.validateRoute` 据此拒绝它。系统里没有任何环节会去询问端点它到底接受什么，`PiAiModelProfile.input` 的文档已经写明这是部署自己的陈述；缺的是让部署把这句话说出来的界面。

## Decision

**拖放由胶囊整体接管。** `InputBar` 在 `[data-composer-card]` 上注册 `dragover` 与 `drop`：`dragover` 见到 `Files` 就 `preventDefault`，让浏览器允许放下；`drop` 先跳过 `defaultPrevented` 的事件——那是编辑器已经在 contenteditable 内处理过的同一个拖放——再把 `dataTransfer.files` 交给既有的 `intakeFiles`。落在胶囊任意位置的图片都进入同一条校验与插入路径，浏览器不再有机会导航。

**模型行可以声明图片输入。** `ModelListEditor`（pi-ai，字段 `input`）与 `DeepSeekModelsEditor`（DeepSeek，字段 `inputModalities`）在每行的高级折叠里各多一个「支持图片输入」勾选框，勾选写入 `['text', 'image']`，取消则删除该字段让行回落到路由默认，而不是钉死一个 `['text']`。两个家族共用 `DeepSeekModelsEditor` 导出的 `acceptsImages(model, key)` 与 `IMAGE_INPUT`。

**失败文案指向真正可行动作。** `image.describerInvalid` 从「请在模型设置中检查图片理解模型」改为「请在「模型」设置中确认该模型支持图片输入」。

**发送失败不再依赖已被剪除的缓存。** `SessionInputShell` 的 `DetachedDraft` 多带一份 `inserts`，在乐观提交之前与 `images` 一起快照下来；`restoreFailedDrafts` 从这份快照重建图片 chip，并把条目写回 `imageCache`。

## Alternatives considered

**在 `document` 或 `window` 上拦截文件拖放。** 否决：编辑器之外的整页都不是拖放目标，拦截它会改变页面其余部分的行为，而问题只出在对话框胶囊内；把落点收敛到胶囊才是问题的边界。

**保持严格校验，让用户在 `settings.yaml` 里手写 `input: [text, image]`。** 否决：这就是缺陷本身——「设置」页已经能编辑同一个 `models` 数组的 id、名称和容量，唯独能力字段要离开界面才能写，而目录里没有任何提示说明这一行为什么不算视觉模型。

**放宽 `validateRoute`，把用户的显式选择当作能力声明。** 否决：`LlmImageUnderstanding` 的既有决策是「未声明表示未知而非具备」，并有 `index.spec.ts` 中「configured route cannot accept images」一条锁定；为此推翻它，等于把「模型不接受图片」这一类真实误配置也一并放过。让部署声明能力既保留了这条判据，又让目录与准入看到同一个事实。

**只修文案不修界面。** 否决：文案只能告诉用户去哪里，而那里现在没有可操作的控件。

## Consequences

拖到胶囊任意位置的图片都会被接管，落点在编辑器内时仍只收取一次；浏览器不再因为一次松手就导航离开并丢弃草稿。

手写的视觉模型在勾选「支持图片输入」并保存后会出现在「图片理解模型」的候选里——候选列表按 `inputModalities` 过滤——并通过 `validateRoute`，此前被拒的路由随即生效。未勾选的模型行为不变：目录把它当作纯文本路由，准入按既有规则拒绝或降级。

失败发送恢复的代价是 `DetachedDraft` 多持有一份 `DraftImageInsert` 引用，随 detached 记录一起在 scope 销毁或提交后释放。收益是恢复不再依赖 `commitDraft` 之后的状态：`commitDraft` 会 `pruneImageCache()`，而点击「发送」按钮触发的提交不在 Lexical 的按键更新之内，`pruneImageCache` 此时读到的是已清空的文件树，缓存条目已被剪除——`input-bar.client.spec.tsx` 中「restores text and images together when a mixed send fails」用点按发送的路径钉住这条回归（用 Enter 键触发时提交嵌套在 Lexical 更新里，缓存恰好还在，同一缺陷看不出来）。

新增一方能力字段意味着两个目录编辑器各多一个控件，pi-ai 与 DeepSeek 通过共用 helper 保持字段语义一致；取消勾选走「删除字段」而不是写 `['text']`，以免一次勾选往返把行从「未声明」改成「显式纯文本」。
