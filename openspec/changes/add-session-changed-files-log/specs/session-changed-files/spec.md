# session-changed-files

## ADDED Requirements

### Requirement: 变更事实从完整会话日志折叠
`changedFiles` 投影单元 SHALL 折叠完整的持久会话日志，而不是客户端已加载的事件窗口，因此客户端分页了多少历史都不影响结果。

#### Scenario: 变更位于已加载窗口之外
- **GIVEN** 一个会话的日志远超客户端首页窗口，较早的轮次改过文件
- **WHEN** 客户端只加载了尾部窗口
- **THEN** `changedFiles` 仍列出那些较早轮次改过的文件

### Requirement: 只计入成功完成的第一方变更调用
该单元 SHALL 只计入成功完成的 `write`、`edit` 与 `str_replace_editor` 变更调用；失败的结果、只读命令、不受支持的工具与不完整的参数 SHALL 不贡献任何条目。

#### Scenario: 失败的变更调用不计入
- **WHEN** 一次 `edit` 调用以 `isError` 结果结束，且此后没有对同一路径的成功变更
- **THEN** 该路径不出现在 `changedFiles` 中

#### Scenario: 三种变更工具都被计入
- **WHEN** 会话分别成功调用了 `write`、`edit` 与 `str_replace_editor`
- **THEN** 三者改动的路径都出现在 `changedFiles` 中

#### Scenario: 只读命令不计入
- **WHEN** 会话调用了 `str_replace_editor` 的 `view` 命令
- **THEN** 该路径不出现在 `changedFiles` 中

### Requirement: 条目按规范化路径去重并携带最后一次变更的 seq
每个条目 SHALL 携带规范化后的绝对路径、用户可见的操作类型、首次变更的 seq 与最后一次变更的 seq。同一文件被多次变更 SHALL 只占一条；操作类型 SHALL 取最早一次，`lastSeq` SHALL 取最后一次。

#### Scenario: 同一文件多次变更只占一条
- **GIVEN** 会话先 `write` 后 `edit` 同一个文件
- **WHEN** 读取 `changedFiles`
- **THEN** 该路径只有一条，操作类型为 `write`，`lastSeq` 是那次 `edit` 的 seq

#### Scenario: 两种拼写收敛为一条
- **GIVEN** 会话工作区根为 `/proj`，一次变更记为 `src/a.ts`，另一次记为 `/proj/src/a.ts`
- **THEN** `changedFiles` 中只有一条 `/proj/src/a.ts`

### Requirement: 折叠状态不随事件增长
该单元的状态 SHALL 按被改过的不同路径收敛，并且 SHALL 只保留尚未结算的变更调用；`turn/end` SHALL 丢弃该轮未结算的调用，因此状态规模不随日志事件数增长。

#### Scenario: 被打断的轮次不留残留
- **GIVEN** 一个轮次发出了变更调用但其结果在该轮结束后才到达
- **WHEN** 该轮 `turn/end` 之后读取状态
- **THEN** 该调用不再挂起，且不贡献任何条目

### Requirement: 「修改的文件」dock 展示整个会话的变更
输入框上方的 dock SHALL 展示整个会话的变更文件，其标题 SHALL 为「修改的文件」。dock SHALL 优先读取 `changedFiles` 投影；该投影缺席时 SHALL 回退到客户端窗口折叠，两条路径 SHALL 产出同一形状的记录。

#### Scenario: 长会话中列表不随分页缩短
- **GIVEN** 一个会话的早期轮次改过文件，且客户端只加载了尾部窗口
- **WHEN** 用户查看 dock
- **THEN** 列表包含那些早期轮次改过的文件

#### Scenario: 投影缺席时回退
- **GIVEN** `changedFiles` 投影键缺席
- **WHEN** 用户查看 dock
- **THEN** 列表仍按已加载窗口列出变更

### Requirement: 接受按 (路径, 最后一次变更) 生效
接受一个文件 SHALL 把它从列表中隐藏，直到该文件出现一次更新的成功变更调用；该文件此后任何一次成功变更 SHALL 使它重新出现在列表中。「全部接受」SHALL 隐藏当前全部待处理文件，此后有变更的文件同样重新出现。接受 SHALL 不改变磁盘内容。

#### Scenario: 接受后同一文件再次变更则重现
- **GIVEN** 列表显示 `a.txt`，用户点击了它的「接受」
- **WHEN** agent 此后成功变更 `a.txt` 一次
- **THEN** `a.txt` 重新出现在列表中

#### Scenario: 接受后无新变更则保持隐藏
- **GIVEN** 列表显示 `a.txt` 与 `b.txt`，用户接受了 `a.txt`
- **WHEN** 会话新增的变更只涉及 `b.txt` 与 `c.txt`
- **THEN** 列表显示 `b.txt` 与 `c.txt`，`a.txt` 保持隐藏

#### Scenario: 全部接受后仅新变更重现
- **GIVEN** 列表显示两个文件，用户点击「全部接受」
- **WHEN** agent 此后成功变更其中任意一个
- **THEN** 列表只显示那个被重新变更的文件

#### Scenario: 接受不动磁盘
- **WHEN** 用户接受 `a.txt`
- **THEN** 磁盘上的 `a.txt` 逐字节不变，列表不再显示它

### Requirement: 接受状态不跨页面刷新保留
接受集 SHALL 是组件本地状态；页面刷新后 SHALL 重新显示全部变更文件。

#### Scenario: 刷新后列表重建
- **GIVEN** 用户接受了若干文件
- **WHEN** 页面重新加载
- **THEN** 这些文件重新出现在列表中
