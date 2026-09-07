<!-- 由 scripts/gen-doc-graphs.ts 生成——请勿手工编辑。
     运行 `pnpm run gen-doc-graphs` 重新生成。 -->

# 文档图索引

这些图展示生成目录未包含的关系。可以用它们查找包之间的关系、能力 seam、事件流、面向模型的工具、应用组合和运行时生命周期路径。精确签名和类型定义仍以[子系统页面](subsystems/core.zh.md)（类型和生成的 `cordis-surface` 区域）及[工具目录](tool-catalog.zh.md)为准。

本索引背后的流程决策记录在[文档图 Agent Note](../.agents/notes/archived/process/2026-07-03-documentation-graph-atlas.zh.md)中。

| 图 | 模式 |
| --- | --- |
| [模块依赖图](module-graph.zh.md) | `generated` |
| [工具 schema 目录与包映射](tool-catalog.zh.md) | `generated` |
| [能力 seam 与核心服务](capability-seams.zh.md) | `hybrid generated` |
| [dsh 共享基础组合](../apps/cli/composition.md) | `hybrid generated` |
| [事件生产方／消费方矩阵](event-producer-consumer.zh.md) | `hybrid generated` |
| [agent（智能体）轮次与步骤生命周期](agent-lifecycle.zh.md) | `curated` |
| [工具执行流水线](tool-execution-pipeline.zh.md) | `curated` |

运行 `pnpm run gen-doc-graphs` 重新生成；运行 `pnpm run verify-doc-graphs` 验证新鲜度。

维护模式：混合。每个链接页面声明其模式为生成、混合或人工维护。。
