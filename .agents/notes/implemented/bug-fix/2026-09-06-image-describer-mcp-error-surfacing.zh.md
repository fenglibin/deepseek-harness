# Agent Note: 让图片描述与 MCP 连接的错误可诊断

Status: implemented

## Problem

两个用户可见的错误都被折叠成了无法据以行动的笼统提示，用户既不知道发生了什么，也拿不到定位线索。

其一，图片发送失败被折叠成 `prompt rejected`。`SessionCommandController.prompt`（`packages/api/session-controller/src/commands.ts`）在 `admit` 闭包内做图片准入：当前路由是纯文本时，它先问 `canDescribeImages()` 是否有一个可用的 describer。该方法直接 `await service.resolveRoute()`，而 `LlmImageUnderstanding.resolveRoute` 在用户显式配置的 describer 无法服务时（provider 已注销、或所选模型不接受图片）会抛错。这个普通 `Error` 既不是 `RemoteError` 也不是 `AttachmentError`，于是落入 `admit` 的兜底分支，被改写为 `session/agent-busy` 的 `prompt rejected`——用户看到的与「图片描述模型配置无效」这一真实原因毫无关联。与之不对称的是，`describeForRoute` 里同一条 `resolveRoute` 抛错会被捕获并降级为「无描述」，唯独预检路径没有兜住。

其二，MCP 服务器连接失败只有一颗红色状态点。`McpManager.list()` 已经在每个服务器的视图里携带了 `error` 诊断文本（来自 mcp-client 监督器上报的 `detail.error`），但 `McpSection`（`packages/client/ui-settings-mcp/src/client/McpSection.tsx`）只渲染了工具数量，从未消费 `view.error`。用户面对一个「连接失败」的圆点，无从判断是命令不存在、凭据错误还是数据库不可达。

## Decision

`canDescribeImages()` 捕获 `resolveRoute` 的拒绝，改写为一个携带诊断 reason 的 `RemoteError`：`session/attachment-invalid`、reason `IMAGE_DESCRIBER_INVALID`、message 拼接原始原因。这样它沿 `admit` 的 `remoteErrorOf` 分支原样上抛，前端 `attachmentErrorText` 按 reason 映射到「图片描述模型配置无效，请在模型设置中检查图片理解模型」这一可行动的文案，而不是 `prompt rejected (session/agent-busy)`。

`McpSection` 在服务器行里，当状态点是 `failed` 且视图携带 `error` 时，渲染一行 `role="alert"` 的诊断文本（`rowError`），把监督器已经上报的原因展示给用户。

## Alternatives considered

**`canDescribeImages` 降级为 `false` 而不是抛错。** 否决：那样用户会看到「当前模型不支持图片」，把真实原因（describer 配置错误）掩盖成另一个误导性的提示，且丢掉了 `resolveRoute` 已经提供的诊断信息。

**在 `admit` 兜底分支里识别 describer 错误并改写。** 否决：识别要靠字符串或引入新的错误类型，侵入 `admit` 的分类逻辑；在 `canDescribeImages` 边界就地改写，错误从它产生的层级就以正确的 `RemoteError` 形态离开，分类逻辑保持简单。

**把两个错误折叠成一条「发送失败」泛化文案。** 否决：这重复了本次要消除的问题——用户拿不到可行动的线索。

## Consequences

图片 describer 配置失效时，用户看到的是 `session/attachment-invalid` + `IMAGE_DESCRIBER_INVALID`，前端给出「检查图片理解模型」的指引；不再出现 `prompt rejected`。MCP 服务器连接失败时，服务器行下方直接显示监督器上报的错误文本，用户能据此修正命令、凭据或数据库地址。后端行为由 `session-models.host.spec.ts` 新增的「misconfigured describer」回归用例锁定，前端文案由 `image-labels.client.spec.ts` 的 reason 映射断言锁定，MCP 错误展示由 `mcp-section.client.spec.tsx` 的三条渲染用例锁定。

`image-labels.client.spec.ts` 里 `enT = makeTranslate(zh, commonZh)` 断言英文「A message can include up to 20 images」的既有失败先于本次变更存在（`66b66c0eef` 删除英文语言时漏改该 fixture），不在本次范围内。
