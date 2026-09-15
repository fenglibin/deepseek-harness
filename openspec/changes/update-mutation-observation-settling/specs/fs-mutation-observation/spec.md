# fs-mutation-observation

## ADDED Requirements

### Requirement: 变更前结算观察

`write` 与 `edit` SHALL 在策略拒绝未见目标时，于当次工具调用内读取目标、记录该次观察、重新分发意图槽位，并执行同一个变更；该次拒绝 MUST NOT 产生 `tool/result` 事件。

#### Scenario: 未读目标上的 edit 直接成功
- **WHEN** 模型对一个本会话从未读取过的现存文件调用 `edit`，且 `old_string` 匹配
- **THEN** 工具返回 `isError: false`，文件按请求被修改，且该调用不产生任何 `isError` 结果

#### Scenario: 未读目标上的覆盖式 write 直接成功
- **WHEN** 模型对一个本会话从未读取过的现存文件调用 `write`
- **THEN** 工具返回 `isError: false`，文件内容被替换

#### Scenario: 已观察目标不付出额外读取
- **WHEN** 本会话已观察过目标，且模型随后调用 `edit` 或 `write`
- **THEN** 工具不读取文件、不探测 `stat`，直接执行变更

### Requirement: 缺失目标由策略作答

工具 SHALL 在恢复读取发现目标不存在时记录权威的负向观察，并让策略据此作答，而 MUST NOT 自行判定结果。

#### Scenario: edit 缺失目标报告 not found
- **WHEN** 模型对一个不存在的路径调用 `edit`
- **THEN** 结果为 `FS_NOT_FOUND`，而不是 `FS_NOT_OBSERVED`

#### Scenario: write 缺失目标仍创建文件
- **WHEN** 模型对一个不存在的路径调用 `write`
- **THEN** 工具走防护创建路径并成功创建该文件

### Requirement: 陈旧变更仍失败并给出内容

当变更期间文件被外部改写时，工具 SHALL 仍以 `FS_STALE_VERSION` 失败，并在可重新读取目标时把当前内容附在失败消息中。

#### Scenario: 变更期间的外部改写失败并为陈旧
- **WHEN** 目标在工具读取与写入之间被外部改写
- **THEN** 变更失败，错误码为 `FS_STALE_VERSION`，且消息携带该文件的当前内容

#### Scenario: 恢复读取发现删除后下一次 write 可重建
- **WHEN** 已观察的目标被外部删除，且一次变更因其失败
- **THEN** 该次失败的恢复读取记录确认缺失，随后一次 `write` 通过防护创建重建该文件

### Requirement: 提示词不再要求为满足策略而读

`edit` 与 `write` 的系统提示词 SHALL 说明工具自行结算文件观察，并 MUST NOT 指示模型「为满足策略而先读」。提示词 MAY 保留「`edit` 需要内容才能写出匹配的 `old_string`」这一独立忠告。

#### Scenario: 提示词不要求先读
- **WHEN** `dsh-tool-fs` 注册其提示词段落
- **THEN** `edit` 与 `write` 的文本说明工具自行结算观察，且不含「为满足策略而读」的要求

### Requirement: str_replace_editor 遵循同一规则

`str_replace_editor` 的 `str_replace` 与 `insert` SHALL 在分发意图槽位之前读取目标内容并发出 `fs/observed`。

#### Scenario: 未 view 过的 str_replace 直接成功
- **WHEN** 模型对一个本会话从未 `view` 过的文件执行 `str_replace`，且 `old_str` 唯一匹配
- **THEN** 变更成功，且不产生策略拒绝

#### Scenario: 字面量不匹配仍然失败
- **WHEN** 模型执行的 `str_replace` 的 `old_str` 在文件中不存在
- **THEN** 结果为 `FS_EDIT_NOT_FOUND`，文件保持不变