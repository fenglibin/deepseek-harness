## Why

会话页面上频繁出现用户无法处置的工具失败行——陈旧版本、offset 越界、未按交付流程留记录等。这些失败的原因全部出在模型自己撰写的参数上：用户既未参与该失败，也没有处置手段，而模型收到同一段结果后就能自行纠正。当前呈现在时间线上只制造疑惑。

判定方向此前是「黑名单隐藏」：`HiddenToolFailureProjector` 只列 `FS_EDIT_NOT_FOUND`、`FS_AMBIGUOUS_EDIT` 两码，其余失败一律可见。本项目 140 个会话、29,038 次 `tool/result` 的全量统计显示 492 次失败，其中需要用户介入的仅 6 次（1.2%），而两类模型自纠失败占 55%。黑名单制只能覆盖作者事先想到的码，长尾 12 类失败与 52 次无错误码的裸 `Error` 全部漏掉。

`DELIVERY_POST_HOOK_FAILED` 的 7 次出现独立印证了方向问题：该码在当前源码中已不存在（`c78e5ae256` 删除了 `advance_delivery_task` 的 post-hooks 机制），现存记录来自历史会话 replay。黑名单制会让每个已删除的码在 replay 时重新变成可见噪音。

## What Changes

- `HiddenToolFailureProjector` 从「黑名单隐藏」反转为「可处置白名单展示」：白名单五码保持可见，其余 `isError` 行默认隐藏，含无 `error.code` 的裸 `Error`。
- 白名单为 `FS_SANDBOX_DENIED`、`FS_PERMISSION_DENIED`、`NO_PROVIDER`、`GOAL_TOOL_AUTHORITY_REQUIRED`、`SEARCH_FAILED`，全部是需要用户介入的环境、权限或配置问题。
- `FsErrorCode` 新增 `FS_OFFSET_OUT_OF_RANGE`，`tool-fs` 的 read 越界改抛该码，使「模型 offset 传错」与「文件真的不存在」可分别判定。
- 同步 `ui-chat`、`fs`、`tool-fs` 的 README 与 JSDoc 契约，并新增 Agent Note 记录方向反转。

## Impact

- 被改动的 capability：`tool-failure-visibility`（新增）。
- 模型侧一字不改：`tool/result` 事件的 `content` 与 `error` 字段不变，模型照常据以纠正。
- 不改持久化格式：`ToolErrorInfo`（`packages/core/tools/src/index.ts`）结构不变，因此不牵动两个 SDK 的期望输出与 `snapshots/` 会话快照。
- 历史会话无需迁移即可获得新行为，因为隐藏是纯渲染期决策。
- 不覆盖 PTC 嵌套子调用：`tool/code-dispatch` 事件不带 `{ name, code }`，Client 侧构造的子调用节点无可判定的错误码；实测该事件在本部署中为 0 次。