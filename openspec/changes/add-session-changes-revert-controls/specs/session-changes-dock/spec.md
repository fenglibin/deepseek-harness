# session-changes-dock 规范增量

## ADDED Requirements

### Requirement: 全部撤销执行前要求确认

「全部撤销」在改动磁盘之前 SHALL 要求读者经过一次显式确认，确认控件 MUST 在读者勾选确认框之前禁用执行按钮。确认内容 SHALL 说明将影响的文件数，并说明会话之外的改动会被保留。

#### Scenario: 未勾选确认框时不能执行

- **WHEN** 读者点击「全部撤销」
- **THEN** 出现确认框，且其中的执行按钮 SHALL 处于禁用状态
- **AND** MUST NOT 向宿主发出任何撤销请求

#### Scenario: 勾选后执行

- **WHEN** 读者在弹出的确认框中勾选确认项并点击执行
- **THEN** 系统 SHALL 发出全部撤销请求

#### Scenario: 取消不做任何事

- **WHEN** 读者在确认框中取消
- **THEN** 确认框 SHALL 关闭，且 MUST NOT 发出任何撤销请求

### Requirement: 单个文件撤销

列表的每一行 SHALL 提供撤销该文件本会话改动的控件，且该控件 SHALL 只在该路径确有宿主修订记录时出现。单个撤销 MUST 复用批量撤销所用的同一宿主动词，只额外指定该路径。

读者一次只能对同一路径发起一个撤销；撤销进行中时该行 MUST NOT 重复发起。一个路径的撤销进行中 MUST NOT 使其它路径的撤销控件失效。

#### Scenario: 行内撤销单个文件

- **GIVEN** 一个路径有宿主修订记录
- **WHEN** 读者点击该行的撤销控件
- **THEN** 系统 SHALL 以该路径为参数发出撤销请求
- **AND** 其它行 SHALL 不受影响

#### Scenario: 没有修订记录的行不提供撤销

- **GIVEN** 一个路径被列入改动列表但宿主没有记录它的修订
- **WHEN** 列表渲染该行
- **THEN** 该行 MUST NOT 出现撤销控件

#### Scenario: 撤销进行中不重复发起

- **WHEN** 一个路径的撤销仍在进行中而读者再次点击该行控件
- **THEN** 系统 MUST NOT 第二次发出该路径的撤销请求

### Requirement: 行内控件的图标与行数呈现

行内的接受、撤销、查看变更三个动作 SHALL 以图标加可访问名称呈现，MUST NOT 只以文字标签呈现。每一行 SHALL 显示该文件本会话累计新增与删除的行数；`origin` 为 `deleted` 的行 SHALL 以「已删除」取代行数。

#### Scenario: 接受与撤销以图标呈现

- **WHEN** 列表渲染一个待处理的行
- **THEN** 接受动作 SHALL 使用勾形图标，撤销动作 SHALL 使用回退箭头图标
- **AND** 两者 SHALL 各自带有可访问名称

#### Scenario: 查看变更以眼睛图标呈现

- **GIVEN** 一个路径有宿主修订记录
- **WHEN** 列表渲染该行
- **THEN** 查看变更动作 SHALL 使用眼睛图标并带有可访问名称

#### Scenario: 行上显示真实增删行数

- **WHEN** 一个路径的修订报告新增 38 行、删除 108 行
- **THEN** 该行 SHALL 显示 `+38` 与 `-108`

#### Scenario: 删除的行显示已删除

- **WHEN** 一个路径的 `origin` 为 `deleted`
- **THEN** 该行 SHALL 显示「已删除」而 MUST NOT 显示增删行数

### Requirement: 撤销的目标会话与条目一致

撤销 SHALL 作用于该列表条目所绑定的会话，MUST NOT 读取视图当前活跃的会话。

#### Scenario: 撤销作用于本条目绑定的会话

- **GIVEN** 列表条目绑定会话 A
- **WHEN** 读者执行撤销
- **THEN** 撤销请求 SHALL 指定会话 A
