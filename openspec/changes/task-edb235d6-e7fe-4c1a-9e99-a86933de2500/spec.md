- [revision 3] ## 轻量模型路由（lightweight-model）

### 目标
辅助模型调用（会话标题、压缩摘要）默认复用会话自身的模型路由；当该路由无法完成辅助请求时，用户应能从「已配置的模型」中指定一条「轻量模型」路由，供所有轻量任务使用。未指定时行为与今天完全一致。

### 边界：什么叫「轻量任务」
沿用仓库既有定义 —— `GenerateOptions.purpose`，其成员只有 `'compaction'` 与 `'session-title'`。不引入新的任务分类。

### 设置域
- 命名空间 `lightweight-model`，位于新包 `packages/core/lightweight-model`（`@deepseek-ai/dsh-lightweight-model`），服务名 `ctx.lightweightModel`。
- 结构 `{ provider: string, model: string }`，两者默认 `''`；同时为空 = 未启用。
- 只给 provider 或只给 model 的写入由 `installSection` 的 `validate` 钩子在设置边界拒绝。
- 组合配置项可给部署一个基础路由；用户设置层压在它上面。
- 未启用时 `currentSelection()` 返回 `undefined`，消费方无需额外的启用判断。

### 解析顺序（两个消费方一致地把轻量模型插在中间层）
| 调用方 | 顺序 |
|---|---|
| `session-title-llm` | 配置 `provider`+`model` → 轻量模型 → 已记录 `request/header` 路由 |
| `compaction-basic` | `summarizationProvider`+`Model` → 轻量模型 → 最新已路由请求 → `AgentOptions` |

服务为可选，消费方用 `ctx.get('lightweightModel')` 读取，不改动自身 `inject`。

### 标题生成预算
- `packages/bundle/base/cordis.patch.yml`：`maxOutputTokens` 64 → 512（覆盖实测 228 个思考 token 并留余量）。
- `targetCjkCharacters` 10 → 20，匹配「20 字左右」的诉求。

### 客户端
「设置」→「模型」页新增轻量模型卡片：从 `session.modelCatalog()` 的已配置模型中单选或清空；不可写时只读，绝不报告未发生的保存。

### 验收
- 未指定时两个消费方的路由与改动前一致（各一条回归用例）。
- 指定后两者改走该路由；消费方显式覆盖仍优先（各一条用例）。
- 新包单元测试覆盖：空选择、用户层覆盖组合项、清空、半对写入被拒、设置提供方卸载回落、无设置提供方时保持组合项、组合项半对被拒。
- `packages/core/lightweight-model/src` 达到 per-file 100% 覆盖。
