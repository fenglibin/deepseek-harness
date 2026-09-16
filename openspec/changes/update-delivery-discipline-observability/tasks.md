## 1. D1 分级规则修正

- [x] 1.1 `scanSignals` 将编号列表命中由 strong 改为计入 medium，使「可拆分」不再等价于 `l2` (covers: delivery-discipline/编号列表需求判定为 l1, delivery-discipline/编号列表叠加中等信号升 l2, design/D1)
- [x] 1.2 收窄强信号词表中的高频日常词（重构/迁移/优化/替换/升级等），移出 strong 到 medium (covers: delivery-discipline/编号列表需求判定为 l1, design/D1)
- [x] 1.3 `grading.ts` 单测：编号列表各条数边界、叠加中等信号升 l2、26 字符三条编号文本判定为 l1 (covers: delivery-discipline/编号列表需求判定为 l1, delivery-discipline/编号列表叠加中等信号升 l2, delivery-discipline/长需求直接升 l2, design/D1)

## 2. D2 l1 自动创建

- [x] 2.1 `agent/pre-step` 的 autoDetect 扩展：判定为 `l1` 时同样创建任务，`l0` 保持不创建 (covers: delivery-discipline/l1 自动创建任务, delivery-discipline/l0 不创建任务, design/D2)
- [x] 2.2 单测覆盖 autoDetect 三条路径：l2 自动创建、l1 自动创建、l0 注入 rubric (covers: delivery-discipline/l1 自动创建任务, delivery-discipline/l0 不创建任务, design/D2)

## 3. D3 单一任务源

- [x] 3.1 `delivery-tasks` 投影自身 fold `todo/write`，在 l1 任务存续期间镜像清单（`changeId` 为空串）；镜像不写日志，故不受 `Session.append` 重入约束 (covers: delivery-discipline/l1 的 todo 写入同步为持久清单, design/D3)
- [x] 3.2 投影状态自持 `level`/`phase`（自 `delivery/change` 跟踪），使镜像判定不依赖其他投影且跨轮保持 (covers: delivery-discipline/l1 的 todo 写入同步为持久清单, design/D3)
- [x] 3.3 `DeliveryFloatCard` 移除 `items.length === 0 ? todos ?? [] : []` 双源择一逻辑，只读 `delivery-tasks` (covers: delivery-discipline/进度面板只读持久清单, design/D3)
- [x] 3.4 测试：真实组装（带 SessionStore）验证 l1 镜像、整体替换、l0/l2 不镜像、已记录 l2 清单不被覆盖、清除后不再镜像 (covers: delivery-discipline/l1 的 todo 写入同步为持久清单, delivery-discipline/进度面板只读持久清单, design/D3)

## 4. D4 实现验证重建

- [x] 4.1 清单完整性检查：权威源（l2 磁盘 `tasks.md`，l0/l1 `delivery-tasks`）全部项须为 `completed`；l1 未记录清单不再静默放行，l0 因无清单义务而豁免 (covers: delivery-discipline/清单未完成阻止验证, design/D4)
- [x] 4.2 覆盖性检查扩展至 l1：原始需求要点（`req/<n>`）与 `### D<n>` 设计决策须被已完成项的 `covers:` 覆盖 (covers: delivery-discipline/需求与设计点未覆盖被列出, design/D4)
- [x] 4.3 `postHooks` 与 `openspec validate <change_id> --strict --json` 由 `accepted` 前移至 `verified`，`accepted` 只做最终确认 (covers: delivery-discipline/命令核验失败阻止验证, design/D4)
- [x] 4.4 覆盖以 `covers:` 注解承载，取代 ≥20 字自由文本放行；键名格式写入 guidance 与工具描述使模型可发现 (covers: delivery-discipline/逐条对账取代自由文本, design/D4)
- [x] 4.5 测试：四道检查各自的阻断与放行路径，含 l1 镜像路径与 l2 scenario 覆盖路径（不依赖 `openspec show`） (covers: delivery-discipline/清单未完成阻止验证, delivery-discipline/命令核验失败阻止验证, delivery-discipline/逐条对账取代自由文本, design/D4)

## 5. D5 复核轮次持久化

- [x] 5.1 `reviewRounds` 由模块级 `Map` 改为从会话日志按当前任务 id 计数，按任务独立生效 (covers: delivery-discipline/轮次上限按任务独立生效, design/D5)
- [x] 5.2 测试：同进程两会话互不影响；同一会话新任务不继承已清除任务的已用轮次 (covers: delivery-discipline/轮次上限按任务独立生效, design/D5)

## 6. D6 设置控件扩展与 delivery 卡片

- [x] 6.1 `card-form.ts` 新增布尔控件与枚举控件，基于既有 `FieldWrite` 的 `set`/`clear` 抽象 (covers: delivery-discipline/布尔与枚举项可在设置界面编辑, design/D6)
- [x] 6.2 新增列表控件（每行一条），并为嵌套字段路径提供 `mutate` 读写与 override 检测 (covers: delivery-discipline/布尔与枚举项可在设置界面编辑, delivery-discipline/阈值可在设置中覆盖, design/D6)
- [x] 6.3 新增 delivery 卡片注册 `settings.plugin.item` 中 `key: 'delivery'`，覆盖全部 14 个可配置字段 (covers: delivery-discipline/阈值可在设置中覆盖, delivery-discipline/布尔与枚举项可在设置界面编辑, design/D6, design/D7)
- [x] 6.4 客户端单测：控件读写、嵌套路径走 mutate、覆盖标记、非法输入阻止保存、端到端卡片派发 (covers: delivery-discipline/布尔与枚举项可在设置界面编辑, design/D6)

## 7. D7 分层与 D9 enforcement 一致性

- [x] 7.1 在 `tool-delivery` 内分层：验证逻辑抽为 `src/verification.ts`（385 行），入口由 1529 降至 1213 行，导出面与工具契约不变 (covers: delivery-discipline/阈值可在设置中覆盖, design/D7)
- [x] 7.2 修正 `enforcement: off` 的加载期判定与运行期设置不一致：门禁执行点按当前策略短路 (covers: delivery-discipline/enforcement 关闭在运行期生效, design/D9)
- [x] 7.3 测试：composition 为 stateful 而设置为 off 时门禁放行 (covers: delivery-discipline/enforcement 关闭在运行期生效, design/D9)

## 8. D8 进度呈现与阶段表护栏

- [x] 8.1 `DeliveryFloatCard` 任务组改读 `delivery-tasks.progress`，按阶段分组显示 `done/total` 并标明权威源 (covers: delivery-discipline/按阶段分组展示完成度, design/D8)
- [x] 8.2 进度面板提供常驻入口，不再仅依赖 Ctrl+Shift+P 唤出 (covers: delivery-discipline/进度面板具有常驻入口, design/D8)
- [x] 8.3 记录并展示分级命中依据（explainGrading + 写入 .dsh/changes），使分级可跟踪 (covers: delivery-discipline/分级依据可跟踪, design/D8)
- [x] 8.4 `LEVEL_PHASES` 保留 host 与 client 两份定义（客户端无法值导入纯类型出口），加漂移护栏测试使其不能静默分叉 (covers: delivery-discipline/按阶段分组展示完成度, design/D8)
- [x] 8.5 客户端单测：按阶段分组渲染、来源标记、可见性三态、阶段表漂移护栏 (covers: delivery-discipline/按阶段分组展示完成度, delivery-discipline/进度面板具有常驻入口, delivery-discipline/分级依据可跟踪, design/D8)

## 9. 文档与验证

- [x] 9.1 更新 `tool-delivery` README 的配置表与默认值说明，消除与实现的偏差 (covers: delivery-discipline/阈值可在设置中覆盖, design/D1)
- [x] 9.2 更新 `docs/subsystems/delivery.zh.md` 与受影响的包 README (covers: delivery-discipline/按阶段分组展示完成度, design/D8)
- [x] 9.3 补 Agent Note 记录分级语义变更、验证重建与 D3 机制修订 (covers: delivery-discipline/编号列表需求判定为 l1, delivery-discipline/逐条对账取代自由文本, design/D1)
- [x] 9.4 运行受影响包的测试与类型检查 (covers: delivery-discipline/清单未完成阻止验证, delivery-discipline/按阶段分组展示完成度, delivery-discipline/无信号需求自由执行, design/D4)
- [x] 9.5 `openspec validate update-delivery-discipline-observability --strict --json` 通过 (covers: delivery-discipline/阈值可在设置中覆盖, design/D7)
