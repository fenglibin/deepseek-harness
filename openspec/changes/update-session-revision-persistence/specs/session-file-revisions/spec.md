## ADDED Requirements

### Requirement: 查看变更失败时报自己的错

界面 SHALL 把「查看变更」的失败表达为查看变更的失败，且 MUST NOT 使用撤销的文案描述一次从未发生的撤销。

#### Scenario: 读取差异失败

- **WHEN** 用户点击某文件的「查看变更」而宿主读取差异失败
- **THEN** 面板显示「查看变更失败」及其原因，且不出现「撤销失败」字样

### Requirement: 失败诊断可读

界面 SHALL 按远端错误码给出可读说明，MUST NOT 把远端错误码与英文原文直接作为面向读者的文案。

#### Scenario: 本会话没有该文件的记录

- **WHEN** 宿主以 `session-revisions/unknown-path` 拒绝一次「查看变更」
- **THEN** 面板说明本会话没有记录该文件的改动

#### Scenario: 无法确定会话工作区

- **WHEN** 宿主以 `session-revisions/no-workspace` 拒绝操作
- **THEN** 界面说明无法确定该会话的工作区

#### Scenario: 其它失败保留原始诊断

- **WHEN** 宿主以其它错误失败
- **THEN** 界面显示查看变更失败并附上原始诊断文本

### Requirement: 修订记录跨进程存活

系统 SHALL 把每个会话的文件修订记录持久化到磁盘，使其在一次新的宿主进程读同一会话时仍然可用；记录 MUST 绑定会话身份，身份不符时丢弃。

#### Scenario: 重启后仍能查看变更

- **WHEN** 一次会话改动了文件，宿主进程随后重启，用户再对该文件点击「查看变更」
- **THEN** 面板展示该会话的累积差异，而不是报告没有记录

#### Scenario: 同名会话重建后旧记录不生效

- **WHEN** 一个会话被删除并以同一 id 重建
- **THEN** 重建的会话读不到被删除那次生命周期留下的修订记录

#### Scenario: 记录超过容量上限时不写入

- **WHEN** 一个会话的修订记录超过配置的字节上限
- **THEN** 系统不写入该记录并记录一条说明，且不写入任何被截断的内容

### Requirement: 列表只对可查看的文件提供操作

界面 SHALL 依据宿主记录的修订集合逐行决定是否提供「查看变更」与撤销，MUST NOT 为没有修订记录的文件显示必然失败的操作入口。

#### Scenario: 没有修订记录的文件行

- **WHEN** 某文件出现在变更列表中，但该会话没有它的修订记录
- **THEN** 该行不显示「查看变更」与撤销入口，其余行不受影响

#### Scenario: 有修订记录的文件行

- **WHEN** 某文件同时出现在变更列表与该会话的修订记录中
- **THEN** 该行显示「查看变更」与撤销入口

### Requirement: str_replace_editor 的改动可查看可撤销

`str_replace_editor` 的成功改动 SHALL 与 `write` / `edit` 一样被捕获基线，从而可查看累积差异、可撤销；其模型可见的结果文本 MUST 保持不变。

#### Scenario: 编辑器创建的文件的改动被捕获

- **WHEN** `str_replace_editor` 以 `create` 或 `str_replace` 或 `insert` 成功改动一个文件
- **THEN** 该会话记录了这次改动的前后内容，并可按读到的基线撤销

#### Scenario: 只读命令不产生改动记录

- **WHEN** `str_replace_editor` 以 `view` 命令读取文件或目录
- **THEN** 该会话不因这次调用产生任何变更或修订记录

#### Scenario: 结果文本保持逐字不变

- **WHEN** `str_replace_editor` 的任一命令成功执行
- **THEN** 模型看到的结果文本与本次变更之前逐字相同

### Requirement: 撤销成功后清理记录

系统 SHALL 在一条路径的改动被成功撤销后移除该路径的修订记录，并在撤销未实际发生时保留它。

#### Scenario: 成功撤销后该文件不再出现在修订记录中

- **WHEN** 一条路径的撤销返回 `reverted`
- **THEN** 该会话不再持有该路径的修订记录，界面也不再把它作为可撤销项提供

#### Scenario: 冲突与未变化时保留记录

- **WHEN** 一条路径的撤销返回 `conflict` 或 `missing` 或 `unchanged`
- **THEN** 该会话仍持有该路径的修订记录，读者可以继续处理它
