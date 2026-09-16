# 交付纪律 openspec 拆分与双进度

## 决策

交付纪律子系统补齐 openspec 拆分链路，把任务拆分、执行、验证、呈现统一到 openspec 的 change 布局上。

- **规模三层判定**：`tool-delivery` 把请求分级改为三层——字符地板（objective 长度超过 `openspecThreshold.descriptionChars`，默认 200，直接 `l2`）、强/中/弱信号扫描、模型 rubric。阈值与信号词表不硬编码，注册为设置服务 `delivery` namespace，经 `installSection` 接线并在无设置服务时回退到组合配置。
- **openspec 四件套**：`record_spec` 按 `kind` 覆盖写入 `openspec/changes/<change-id>/` 下的 proposal/design/tasks/specs 四件套，`change_id` 校验为动词开头的 kebab-case。`record_tasks` 把实施清单写入 durable `delivery/tasks` 事件，由独立投影 `delivery-tasks` fold 出分阶段完成计数。
- **双进度呈现**：悬浮卡片在每个阶段旁标注该阶段子任务完成数，阶段推进时自动展开；OpenSpec 产物路径只在清单指明 change id 后列出。
- **单一任务源**：`l2` 下经 `tools/pre-execute` 拒绝 `todo_write`，清单统一落在 `tasks.md`。
- **逐点验证与坡度**：验证点由解析 spec 的 `#### Scenario:` 标题与 design 的二级标题得到；`verified` 阶段校验覆盖完整性（每个验证点有 task 认领、每个 task 指向存在的点），有 gap 时回注模型并要求具体确认，确认放行被记录，空泛确认或超 `maxReviewRounds` 轮次硬阻断；`openspec validate` 非 0 不接受复核豁免。

## 砍掉的

- 用 `openspec show --json` 作验证点来源——其 scenario 条目只有 `rawText` 而无标题，无法作为 `covers:` 引用键。**部分被取代**：该命令随后被证实会拒绝 proposal.md 使用非英文标题的 change（中文部署写 `## 为什么`），而非零退出被当作「无需检查」，使 `l2` 的 scenario 点静默消失；capability 现改为直接枚举 `openspec/changes/<id>/specs/`，见[交付纪律的分级语义、任务源与实现验证](2026-09-16-delivery-discipline-grading-mirror-and-verification.zh.md)。
- 历史 `task-<uuid>/spec.md` 产物迁移——不合规也不符合 openspec 布局，保持原状；validate 按 change id 定向校验而不使用 `--all`。

## 验证

`packages/delivery` 与 `packages/client/ui-delivery` 单测 189 通过；`tsc` 对本次改动 0 错误；oxlint 0 错误；`openspec validate --strict` 通过；README 门禁与 cordis 目录新鲜度通过。
