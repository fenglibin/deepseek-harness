# 让「模型自身参数写错」的 edit 失败不再出现在对话流上

## 为什么

对话流里会出现这类行：

```
Error: old_string matched 2 times in "/Users/.../tsconfig.client.json";
provide a more specific old_string or set replace_all to true
Error: old_string was not found in "/Users/.../WorkspaceBrowser.tsx"
```

用户读到它做不了任何事：`old_string` 是**模型自己**写的，重写它、换 `replace_all`、重读文件都是模型的动作。用户既没有参与也没有处置权，这段话只制造疑惑，并让一次很快自愈的尝试永久留在时间线上。

实测确认这并非偶发：`~/.dsh/sessions/` 下 43 个会话中有 14 个出现这两个错误码，单个会话最多 71 次。模型通常紧接下一次调用就改对了，但那行失败仍然留着。

同时，模型侧**必须**继续收到这段结果——它正是模型据以修正参数的依据。因此本变更严格限于「页面上不展示」，不触碰工具返回、会话日志或提示词。

## 改什么

1. 新增 Chat 视图投影 `HiddenToolFailureProjector`，在既有 `ReferenceLabelProjector` 与 `RecoveredMutationProjector` 之间接入同样的 `replace` / `apply` 链。
2. 该投影按 `tool/result` 上**已持久化**的 `error.code` 判定，命中白名单的顶层工具调用节点标记为 `visibility: 'hidden'`。
3. 白名单仅含两个错误码：`FS_EDIT_NOT_FOUND`（字面量在文件中找不到，或 `old_string` 为空）与 `FS_AMBIGUOUS_EDIT`（字面量匹配多处且未开 `replace_all`）。二者都精确对应「模型要改的那段文本选错了」。

## 影响

- 改动 `packages/client/ui-chat`：新增 `hidden-tool-failure.ts`，在 `chat-snapshot-builder.ts` 装配，新增单测，README 补充说明。
- 更新 `.agents/notes/implemented/feature/2026-09-04-chat-ux-recovered-mutation-errors-hidden.zh.md` 中与现状矛盾的表述，并新增一条 Agent Note 记录本次决策反转。
- 会话日志格式、会话事件、两个 SDK 期望输出、模型可见文本、工具实现**全部不变**。
- `packages/fs/*`、`packages/core/*` 不改动。

## 不做什么

- 不动 `RecoveredMutationProjector` 的语义与其两个错误码。它处理的是「后续同路径成功已覆盖」的条件式隐藏；本次是无条件隐藏，两者判定互不重叠。
- 不隐藏权限、沙箱、超时、目标不存在等失败——用户可能需要授权或知晓路径问题，必须保持可见。
- **不覆盖 PTC 嵌套子调用。** `tool/code-dispatch` 事件只带 `isError` + `content`，不带 `{ name, code }`，按 code 判定不可用；补齐它需要扩展会话事件格式并牵动快照与 SDK 输出。实测该部署 43 个会话中该事件总数为 0，当前无消费者，故延后。
