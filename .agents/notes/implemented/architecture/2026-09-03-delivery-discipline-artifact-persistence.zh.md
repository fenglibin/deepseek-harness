# Agent Note：交付纪律产物持久化

Status: implemented

## 问题

B1–B3 仅把变更/设计/spec 记录作为 durable 的 `delivery/change` 会话事件，设计文档「每个任务在项目工作目录留下变更记录」的目标（§2、§6.2）未达成，因为没有任何东西写 `.dsh/changes/` 与 `.dsh/design/` 文件。`record_change`/`record_design`/`record_spec` 工具因此从未在磁盘上产出用户可读的产物。

## 决策

让三个 record 工具在提交 durable 事件后，把记录追加到每个任务的 `.dsh` 产物文件，使用文件系统 capability seam。

- `@deepseek-ai/dsh-tool-delivery` 在 `inject` 中新增 `fs`，每个 record 工具根据调用 agent 的会话 `header.cwd` 解析 `.dsh/changes/<task-id>.md`（`record_change`）或 `.dsh/design/<task-id>.md`（`record_design`/`record_spec`），然后追加 `- [revision N] <text>`（首次记录时创建文件）。
- 工具包声明 `@deepseek-ai/dsh-fs` 为 peer 依赖、`@deepseek-ai/dsh-fs-local`/`@deepseek-ai/dsh-sandbox` 为测试依赖，新增 `fs`/`sandbox` 工程引用，并让目录生成器在 boot smoke 中挂载 `LocalFileSystem`。

这是[交付纪律设计](../../../../docs/design/delivery-discipline-rationale.zh.md)的 B3a 批次：`.dsh/changes/` / `.dsh/design/` 产物持久化。真实 `openspec` CLI 集成（写 `openspec/` 文件并运行 `openspec validate`）与 `artifact-written` 投影仍是后续批次。

## 备选方案

**保持记录仅以 durable 事件存在。** 否决：设计的 §2 目标明确要把产物「落到项目工作目录」；会话日志不是用户可读的 `.dsh/` 文件。

**让模型用 `write` 工具写文件。** 否决：依赖模型单独调用 `write` 会重新打开「不能依赖 LLM 自觉」的风险（这正是交付纪律要关闭的）；record 工具自身负责写入。

## 后果

- **获得** 每个任务的磁盘产物 `.dsh/changes/<task-id>.md` 与 `.dsh/design/<task-id>.md`，端到端满足 B1「记录变更」的验收标志（96 条单测，100% 覆盖率）。
- **代价** 工具包增加 `fs` 服务依赖（peer + bundle 解析的 provider），以及每次记录先读旧文件再写入的追加逻辑。
- **延期（不变）** 完整的 openspec change 布局（proposal/design/tasks/specs）与 `openspec validate` CLI，以及 `delivery/artifact-written` 会话事件投影。`record_spec` 已把 spec 落到 `openspec/changes/<task-id>/spec.md` 作为过渡。
