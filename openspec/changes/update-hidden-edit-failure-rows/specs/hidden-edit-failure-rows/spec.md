# hidden-edit-failure-rows

## ADDED Requirements

### Requirement: 命中白名单的顶层失败行不进入可见流

对话视图 SHALL 把错误码为 `FS_EDIT_NOT_FOUND` 或 `FS_AMBIGUOUS_EDIT` 的顶层工具调用行标记为隐藏，使其不出现在渲染的对话流上。该判定 SHALL 只依据 `tool/result` 事件上持久化的 `error.code`，SHALL NOT 解析结果文本。隐藏 SHALL 无条件成立，SHALL NOT 要求存在任何后续成功的调用。

#### Scenario: 字面量匹配多处

- **GIVEN** 一次 `edit` 调用以 `error.code = 'FS_AMBIGUOUS_EDIT'` 结束
- **WHEN** Chat 快照构建完成
- **THEN** 该调用对应的节点 `visibility` 为 `hidden`，不出现在可见节点顺序中

#### Scenario: 字面量在文件中找不到

- **GIVEN** 一次 `edit` 调用以 `error.code = 'FS_EDIT_NOT_FOUND'` 结束
- **WHEN** Chat 快照构建完成
- **THEN** 该调用对应的节点 `visibility` 为 `hidden`

#### Scenario: 模型不再重试也保持隐藏

- **GIVEN** 一次 `edit` 调用以 `FS_EDIT_NOT_FOUND` 结束，且该会话此后没有任何对同一路径的变更调用
- **WHEN** Chat 快照构建完成
- **THEN** 该失败行仍为 `hidden`

#### Scenario: 增量到达时保持一致

- **GIVEN** 该失败行已先被物化，随后同轮其它节点增量到达
- **WHEN** 投影的增量路径处理这批变更
- **THEN** 该失败行的可见性仍为 `hidden`，与整窗重建的结果一致

#### Scenario: 模型仍收到完整结果

- **GIVEN** 一次 `edit` 调用以 `FS_AMBIGUOUS_EDIT` 失败
- **WHEN** 读取会话日志中该 `tool/result` 事件
- **THEN** `content` 与 `error` 字段与该行是否隐藏无关，模型可见的结果文本与错误码保持原样

### Requirement: 非白名单失败保持可见

对话视图 SHALL 让白名单以外的每一次失败保持可见。权限与沙箱拒绝 SHALL 保持可见，因为用户可能需要授权；目标不存在一类的失败也 SHALL 保持可见，因为路径信息对用户有意义。成功调用与不携带 `error` 的失败 SHALL 保持可见。

#### Scenario: 权限与沙箱拒绝保持可见

- **GIVEN** 一次工具调用以 `error.code = 'FS_PERMISSION_DENIED'` 或 `'FS_SANDBOX_DENIED'` 结束
- **WHEN** Chat 快照构建完成
- **THEN** 该节点 `visibility` 为 `visible`

#### Scenario: 既有条件式投影的错误码不受影响

- **GIVEN** 一次 `edit` 调用以 `error.code = 'FS_STALE_VERSION'` 结束，且没有后续同路径的成功变更
- **WHEN** Chat 快照构建完成
- **THEN** 该节点 `visibility` 为 `visible`，其隐藏条件仍只由「后续同路径成功」决定

#### Scenario: 成功调用与无错误码的失败保持可见

- **GIVEN** 一次成功的 `edit` 调用，以及一次 `isError` 为真但事件上没有 `error` 字段的调用
- **WHEN** Chat 快照构建完成
- **THEN** 两个节点都是 `visible`

### Requirement: 嵌套子调用不在本次范围

子调用行的隐藏 SHALL NOT 由本次判定承担：`tool/code-dispatch` 事件不携带错误码，Client 侧据此构造的节点没有 `error` 字段。该限制 SHALL 记录在包的 Known Limitations 中。

#### Scenario: 子调用失败不因本次判定而隐藏

- **GIVEN** 一次以 `isError` 为真结算的嵌套子调用，其事件上没有任何错误码
- **WHEN** Chat 快照构建完成
- **THEN** 该子调用行不因本白名单判定而被隐藏
