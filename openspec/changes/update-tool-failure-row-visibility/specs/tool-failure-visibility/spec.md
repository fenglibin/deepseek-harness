## ADDED Requirements

### Requirement: 失败行的可见性判定

会话页面 SHALL 只展示用户能够处置的工具失败行。判定 SHALL 依据 `tool/result` 事件上已持久化的 `error.code`，MUST NOT 解析结果消息文本，因为同一语义在各文件系统后端措辞不同。判定 SHALL 采用白名单制：白名单之外的失败码与不携带错误码的失败 SHALL 默认标记为隐藏。

#### Scenario: 模型自纠失败默认隐藏

- **WHEN** 一个已结算的顶层工具调用以 `isError` 结束，且其 `error.code` 不在可处置白名单内（例如 `FS_STALE_VERSION`、`FS_NOT_OBSERVED`、`FS_OFFSET_OUT_OF_RANGE`、`DELIVERY_GATE_BLOCKED`、`FS_EDIT_NOT_FOUND`）
- **THEN** 该节点 SHALL 被标记为 `visibility: 'hidden'` 并离开可见渲染顺序
- **AND** 模型侧收到的 `content` 与 `error` SHALL 保持不变

#### Scenario: 无错误码的失败默认隐藏

- **WHEN** 一个已结算的顶层工具调用以 `isError` 结束，但事件不携带 `error.code`
- **THEN** 该节点 SHALL 默认被标记为隐藏，与携带未知错误码的失败走同一判定入口

#### Scenario: 需用户介入的失败保持可见

- **WHEN** 工具调用以 `isError` 结束，且其 `error.code` 属于 `FS_SANDBOX_DENIED`、`FS_PERMISSION_DENIED`、`SANDBOX_APPROVAL_UNAVAILABLE`、`NO_PROVIDER`、`GOAL_TOOL_AUTHORITY_REQUIRED`、`SEARCH_FAILED` 之一
- **THEN** 该节点 SHALL 保持 `visibility: 'visible'` 并出现在渲染顺序中

#### Scenario: 用户自己拒绝的提权不保持可见

- **WHEN** 一次沙箱提权因用户拒绝或取消而失败，或一次批量审批被拒绝
- **THEN** 该失败 SHALL NOT 携带 `SANDBOX_APPROVAL_UNAVAILABLE`
- **AND** 该失败行 SHALL 默认被隐藏，因为那是用户对单次询问的答复而非需要读者处置的配置问题

#### Scenario: 成功的调用不受影响

- **WHEN** 工具调用以 `isError: false` 结算
- **THEN** 该节点 SHALL 保持可见，判定 SHALL NOT 改变其可见性

### Requirement: 越界错误单独成码

`dsh-fs` 的错误码词汇表 SHALL 区分「请求的读取位置超出文件范围」与「目标路径不存在」，使页面可按可处置性分别判定这两类失败。

#### Scenario: 越界错误单独成码

- **WHEN** `read` 请求的 `offset` 超出目标文件的实际行数
- **THEN** 抛出的 `FsError` SHALL 携带 `FS_OFFSET_OUT_OF_RANGE`
- **AND** 目标路径不存在时抛出的 `FsError` SHALL 继续携带 `FS_NOT_FOUND`
