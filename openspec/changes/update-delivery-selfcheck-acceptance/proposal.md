## Why

交付纪律的验收门禁只能保证「模型留下了 `acceptance:` 记录」，而这条记录的指令来自「提示词命令」页里 `deep-selfcheck` 的正文。现有正文是一句被插入语打断的长句，只陈述目标（深度自检、校验完整性与正确性、自动修复），不含做法，也没有交代它实际是在门禁阻止推进时被模型读到、必须留下记录才能放行、以及 `record_change` 会让 revision 加 1 这三个关键约束。正文还说「L0、L1 级别的任务可能没有设计文档」，与事实不符：l1 必然要求至少一条设计记录，l0 根本不创建任务。

同时用户希望这条自检命令成为交付纪律的验收命令，使每个任务在推进到「已验证」前都被强制自检。

## What Changes

- `deep-selfcheck` 正文改写为四段：自检依据（按级别指明读哪些设计文档与任务清单）、必须逐条回答并给出可观察证据的三个问题（需求完整性、实现正确性、业务正确性）、直接修复发现的问题、收尾顺序与 `acceptance:` 记录格式。
- 正文按级别写实，删除「L0、L1 可能没有设计文档」这处与机制不符的描述。
- 正文补上两处原文本缺失的硬约束：门禁只认 `acceptance: deep-selfcheck ` 前缀的 `record_change` 记录；`record_change` 会让 revision 加 1，推进前必须重新 `get_delivery_task` 取最新 revision。
- `delivery` 命名空间的 `verificationCommands` 配置为 `deep-selfcheck`，使每个交付任务在推进到「已验证」前必须执行该自检并留下记录。
- 该配置写入用户层 `~/.dsh/settings.yaml`，与正文改动同时生效；`settings-file` 默认 `watch: true`，无需重启 GUI。
