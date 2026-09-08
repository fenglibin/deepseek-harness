## 1. D1 规模三层判定
- [x] 1.1 扩展 tool-delivery 策略配置：`designThreshold.descriptionChars` 300→60、`openspecThreshold.descriptionChars` 1200→200，新增强/中/弱信号清单数组与 `maxReviewRounds` (covers: delivery-discipline/阈值可在设置中覆盖, design/D1)
- [x] 1.2 实现信号扫描函数，消费配置中的字符串数组对 objective 做模式匹配并返回命中层级 (covers: delivery-discipline/短需求命中强信号升 l2, design/D1)
- [x] 1.3 重写 `inferLevel` 的判定顺序与分档表（地板 → 强信号 → 中等/弱信号 → l0） (covers: delivery-discipline/长需求直接升 l2, delivery-discipline/短需求命中强信号升 l2, design/D1)
- [x] 1.4 改造 `agent/pre-step` 分流：超阈值自动创建 l2、命中信号即创建、否则注入 rubric 消息 (covers: delivery-discipline/长需求直接升 l2, delivery-discipline/无信号需求自由执行, design/D1)
- [x] 1.5 策略配置注册为设置服务 `delivery` namespace，用 `installSection` 接线并保持无服务时回退 (covers: delivery-discipline/阈值可在设置中覆盖, design/D1)
- [x] 1.6 D1 单测：阈值边界、信号命中与降级、`pre-step` 三条路径、回退行为 (covers: delivery-discipline/长需求直接升 l2, delivery-discipline/无信号需求自由执行, design/D1)

## 2. D2 openspec 四件套
- [x] 2.1 `record_spec` 重构为按 kind 写 proposal/design/tasks/spec 四个文件 (covers: delivery-discipline/l2 任务产出合规 change 目录, design/D2)
- [x] 2.2 change-id 生成（动词开头 kebab-case）与 delivery task id 的映射记录 (covers: delivery-discipline/l2 任务产出合规 change 目录, design/D2)
- [x] 2.3 新增 durable 事件承载任务清单与逐项状态 (covers: delivery-discipline/阶段下展示子任务进度并自动展开, design/D2)
- [x] 2.4 新增独立投影单元，不改动既有 `delivery` 投影的字段白名单 (covers: delivery-discipline/阶段下展示子任务进度并自动展开, design/D2)
- [x] 2.5 D2 单测与集成测试：四件套落盘、映射可查、投影随事件更新 (covers: delivery-discipline/l2 任务产出合规 change 目录, design/D2)

## 3. D3 双进度呈现
- [x] 3.1 悬浮卡片阶段-子任务双进度渲染 (covers: delivery-discipline/阶段下展示子任务进度并自动展开, design/D3)
- [x] 3.2 当前阶段自动展开、已完成阶段折叠为一行摘要 (covers: delivery-discipline/阶段下展示子任务进度并自动展开, design/D3)
- [x] 3.3 D3 客户端单测：双进度渲染、阶段切换展开、无子任务时不渲染计数 (covers: delivery-discipline/阶段下展示子任务进度并自动展开, design/D3)

## 4. D4 单一任务源与 validate 接入
- [x] 4.1 `l2` 下经 `tools/pre-execute` 拦截 `todo_write` 并提示改用 tasks.md (covers: delivery-discipline/l2 下 todo_write 被拦截, design/D4)
- [x] 4.2 `postHooks` 接入 `openspec validate --strict --json`，解析 issues 回注模型 (covers: delivery-discipline/validate 失败阻止验收, design/D4)
- [x] 4.3 推进 `implemented` 时用磁盘 `tasks.md` 实际勾选与上报状态交叉核对 (covers: delivery-discipline/命令失败类不因复核放行, design/D4)
- [x] 4.4 D4 单测：拦截、validate 失败阻止、虚报完成被拒并列出差异 (covers: delivery-discipline/l2 下 todo_write 被拦截, delivery-discipline/validate 失败阻止验收, design/D4)

## 5. D5 逐点验证与坡度
- [x] 5.1 验证点清单程序化提取（capability 经 `openspec show --json`，Scenario 与设计点键解析自 spec/design 标题） (covers: delivery-discipline/未覆盖的验证点被列出并回注, design/D5)
- [x] 5.2 `covers:` 标注解析与枚举校验，取值限定为已提取的验证点集合 (covers: delivery-discipline/未覆盖的验证点被列出并回注, design/D5)
- [x] 5.3 覆盖完整性双向校验：每个验证点有 task 认领、每个 task 认领真实存在的点 (covers: delivery-discipline/未覆盖的验证点被列出并回注, design/D5)
- [x] 5.4 差异回注与复核放行；`validate` 非 0 或验证命令未全绿时不接受复核豁免；轮次上限后硬阻断 (covers: delivery-discipline/未覆盖的验证点被列出并回注, delivery-discipline/命令失败类不因复核放行, design/D5)
- [x] 5.5 D5 单测：未覆盖点被列出、空泛确认被拒、具体确认放行 (covers: delivery-discipline/命令失败类不因复核放行, design/D5)

## 6. D6 文档与快照
- [x] 6.1 更新 `dsh-tool-delivery`/`dsh-delivery`/`dsh-client-ui-delivery` 包 README 与已知限制 (covers: design/D6)
- [x] 6.2 重生成 tool-catalog 与 config-catalog (covers: design/D6)
- [x] 6.3 补 Agent Note 记录本变更的决策与验证 (covers: design/D6)
- [x] 6.4 交付门禁：本次变更触及 package 的单测全通过、typecheck 对本次改动 0 错误、README/cordis 目录门禁通过（快照回放与全仓库 typecheck 因外部 `packages/llm` 并发改动阻塞，见变更记录） (covers: design/D6)
