## MODIFIED Requirements

### Requirement: 提示词验收留下记录才放行

勾选了验收命令的交付任务 SHALL NOT 在未留下该任务验收记录时推进到「已验证」。阻止推进时，门禁消息 SHALL 包含每条勾选命令的提示词文本，并要求模型执行后以 `record_change` 记录验收结果。留下验收记录后 SHALL 放行。验收命令 SHALL 以命令名（不含前导斜杠）而非提示词正文承载于 `delivery` 命名空间的 `verificationCommands`，其正文 SHALL 从 `prompt-commands` 命名空间现读，使调整正文无需重新勾选。

#### Scenario: 未留下验收记录时阻止推进
- **WHEN** 任务已勾选验收命令，模型在未留下验收记录时推进到「已验证」
- **THEN** 系统 SHALL 阻止推进，且门禁消息 SHALL 含所勾选命令的提示词与「执行后调用 record_change 记录验收结果」的要求

#### Scenario: 留下验收记录后放行
- **WHEN** 任务已勾选验收命令，模型已为该任务留下带 `acceptance: <命令名> ` 前缀的 `record_change` 记录
- **THEN** 该任务的验收检查 SHALL 通过

#### Scenario: 调整提示词正文无需重新勾选
- **WHEN** 用户只修改「提示词命令」页中某条已勾选命令的正文，不改变其名称或勾选状态
- **THEN** 后续门禁消息 SHALL 使用修改后的正文

### Requirement: 深度自检命令正文陈述执行方式

交付纪律的 `deep-selfcheck` 验收命令正文 SHALL 陈述四件事：自检依据（按任务级别指明读取哪些设计文档与任务清单）、必须逐条回答并给出可观察证据的三个问题（需求完整性、实现正确性、业务正确性）、修复发现的问题、以及收尾顺序。收尾顺序 SHALL 包含把 `covers` 注解补到已完成清单项、以 `acceptance: <命令名> ` 前缀调用 `record_change` 记录结果、并在推进前重新读取最新 revision。

#### Scenario: 正文按级别指明自检依据
- **WHEN** 模型读到 `deep-selfcheck` 正文
- **THEN** 正文 SHALL 分别指明 L2 任务读 `openspec/changes/<change_id>/` 下的设计文档与任务清单、L1 任务读 `.dsh/design/<task_id>.md` 与 `todo_write` 清单

#### Scenario: 正文要求逐条回答并给出证据
- **WHEN** 模型读到 `deep-selfcheck` 正文
- **THEN** 正文 SHALL 列出需求完整性、实现正确性、业务正确性三个问题，并要求每条给出可观察证据而非「应该没问题」这类判断

#### Scenario: 正文给出收尾顺序与记录格式
- **WHEN** 模型读到 `deep-selfcheck` 正文
- **THEN** 正文 SHALL 指明 `record_change` 的记录文本需以 `acceptance: deep-selfcheck ` 开头，且 SHALL 提醒 `record_change` 会使 revision 加 1、推进前需重新调用 `get_delivery_task`
