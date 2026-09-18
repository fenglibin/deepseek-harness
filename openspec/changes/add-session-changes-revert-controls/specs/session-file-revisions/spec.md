# session-file-revisions 规范增量

## ADDED Requirements

### Requirement: 报告会话期间被删除的文件

系统 SHALL 通过查询会话工作区的 git 状态识别被删除的文件，MUST NOT 通过解析 bash 命令文本来识别。识别出的路径 SHALL 以 `origin: 'deleted'` 进入该会话的修订记录，其 `baseline` SHALL 保存该路径的原始内容。

系统 MUST 只报告「本会话期间变为已删除」的路径：会话内首次查询时记录一份删除基线，之后只报告相对该基线的增量，因此会话开始前已删除、或会话外删除的路径 MUST NOT 出现在列表中。

#### Scenario: 会话期间被删除的文件进入列表

- **GIVEN** 会话工作区是一个 git 仓库，且 `src/a.txt` 在会话开始时存在
- **WHEN** 会话期间该文件被删除
- **THEN** 列表中 SHALL 出现 `src/a.txt`，其 `origin` SHALL 为 `deleted`

#### Scenario: 脚本与间接删除同样被识别

- **WHEN** 会话期间一个文件经 `python -c "os.remove(...)"` 或 `find . -delete` 而非 `rm` 删除
- **THEN** 该路径 SHALL 同样以 `origin: 'deleted'` 进入列表

#### Scenario: 会话开始前已删除的文件不列入

- **GIVEN** `src/gone.txt` 在会话开始前就已被删除
- **WHEN** 本会话查询被删除的文件
- **THEN** `src/gone.txt` MUST NOT 出现在列表中

#### Scenario: 工作区不是 git 仓库

- **GIVEN** 会话工作区不是一个 git 仓库
- **WHEN** 查询被删除的文件
- **THEN** 系统 SHALL 报告无法识别而 MUST NOT 使列表查询失败

#### Scenario: 工作区是仓库的子目录

- **GIVEN** 会话工作区是某个 git 仓库的子目录
- **WHEN** 该工作区内的一个文件被删除
- **THEN** 列表 SHALL 报告该文件的绝对路径
- **AND** MUST NOT 把仓库根的前缀重复一遍

#### Scenario: 删除发生在会话工作区之外

- **GIVEN** 会话工作区是某个 git 仓库的子目录
- **WHEN** 该仓库中工作区之外的一个文件被删除
- **THEN** 列表 MUST NOT 报告该路径，因为它不是这次会话工作区的改动

### Requirement: 恢复会话删除的文件

恢复一个 `origin: 'deleted'` 的路径时，系统 SHALL 从 git 取得内容并写回工作区，MUST NOT 依赖会话自身保存的内容。取用顺序 SHALL 为先从 `HEAD` 恢复，失败时再尝试从 index 取回内容（针对尚未提交的新文件）。

恢复成功后该路径的修订记录 SHALL 被退役，使其不再出现在列表中。

#### Scenario: 恢复已提交的文件

- **GIVEN** `src/a.txt` 在会话开始时是已提交状态，会话期间被删除
- **WHEN** 读者对该行执行恢复
- **THEN** `src/a.txt` SHALL 以其 `HEAD` 版本的内容重新出现在工作区
- **AND** 该路径的修订记录 SHALL 被退役

#### Scenario: 恢复尚未提交的新文件

- **GIVEN** `src/new.txt` 是会话新建并已 `git add` 但未提交的文件，会话期间被删除
- **WHEN** 读者对该行执行恢复
- **THEN** `src/new.txt` SHALL 以 index 中的内容重新出现在工作区

#### Scenario: 文件未加入 git 时报告不可恢复

- **GIVEN** 一个从未加入 git 的文件在会话期间被删除
- **WHEN** 读者对该行执行恢复
- **THEN** 系统 SHALL 报告该文件未加入 git 因而不可能恢复
- **AND** MUST NOT 在磁盘上创建任何内容

#### Scenario: 工作区不是 git 仓库时报告不可恢复

- **GIVEN** 会话工作区不是一个 git 仓库
- **WHEN** 读者对一个被删除的路径执行恢复
- **THEN** 系统 SHALL 报告工作区不是 git 仓库因而不可能恢复

#### Scenario: 工作区是仓库的子目录时恢复

- **GIVEN** 会话工作区是某个 git 仓库的子目录，且该工作区内的一个已提交文件在会话期间被删除
- **WHEN** 读者对该行执行恢复
- **THEN** 该文件 SHALL 以 `HEAD` 版本的内容重新出现在工作区

## MODIFIED Requirements

### Requirement: 列出会话改动的文件行数

列表报告的 `added` 与 `removed` SHALL 是会话累计变更中真正新增与删除的行数，MUST NOT 是两侧文件的总行数。

无基线可比时（`origin` 为 `unknown`）两侧 SHALL 均为 0，因为从无基线的内容推断增删会声称一个捕获无法支持的整文件新增。

#### Scenario: 整体替换的内容

- **WHEN** 一个文件从 `old\n` 变为 `new\nlonger\n`
- **THEN** 该行 SHALL 报告 `added` 为 2、`removed` 为 1

#### Scenario: 只改一行的内容

- **WHEN** 一个文件从 `a\nb\nc\n` 变为 `a\nB\nc\n`
- **THEN** 该行 SHALL 报告 `added` 为 1、`removed` 为 1
- **AND** MUST NOT 报告为 3 与 3

#### Scenario: 无基线的文件

- **WHEN** 一个文件的 `origin` 为 `unknown`
- **THEN** 该行 SHALL 报告 `added` 为 0、`removed` 为 0

#### Scenario: 会话新建的文件

- **WHEN** 一个文件由会话新建，内容为 `a\nb\n`
- **THEN** 该行 SHALL 报告 `added` 为 2、`removed` 为 0
