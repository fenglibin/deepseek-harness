---
description: "第二批上游能力移植方案：会话投影的双槽身份闸门、agent loop 的消息冻结复用、typert 生成 schema 的惰性物化与误跟踪产物清理。"
kind: "design-draft"
---

# 第二批：运行时性能移植方案

本批次移植官方仓库中三项运行时性能改动。基线见[上游差异扫描分析](upstream-diff-analysis.zh.md)。所有官方提交 hash 均指官方仓库 `0a53fb55be..master` 区间。

## 1. 范围

| 项 | 官方证据 | 本地现状 | 改动量 |
|---|---|---|---|
| 会话投影双槽身份闸门 | `6f0daff1dd` | `packages/session/session-projection/src/index.ts` 与分叉点仅 1 行注释差异 | 1 个源文件约 40 行 |
| agent loop 消息冻结复用 | `73edce1ae7` | `packages/core/agent-loop/src/agent.ts:536` 为 `markAgentLoopRequest(deepFreeze({...}))` | 1 个源文件净 +7 行 |
| typert 生成 schema 惰性物化 | `e459e32637` | typert 源文件与分叉点一致（仅 `cordis-catalog.ts` 有 8 行文档中文化） | 6 个源文件约 150 行 |
| 清理 typert 误跟踪产物 | — | 本地 `packages/typert/generator/tests/` 有 49 个 `.generated-*` 被跟踪 | `git rm --cached` |

## 2. 关键设计决策

### D1 会话投影用双槽比较，不用 WeakMap 记忆化

官方在 `packages/session/session-projection/src/index.ts` 的单元状态上新增 `readonly views: [unknown, unknown]`，语义是"上一份与当前的原始 view 结果；槽位为 undefined 表示没有可比较的缓存"。

`drive()` 中的闸门分两层：

1. `apply()` 返回的 state 引用未变（`Object.is`）时，把 `views[1]` 移入 `views[0]` 并清空 `views[1]`，不产生任何下游工作
2. state 变化且该单元声明了 `wire` 时，若**存在 listener** 才调用 `wire.view(next)` 写入 `views[1]`；随后只在 `!Object.is(views[0], views[1])` 时经 `viewSchema.parse` 校验并通知 listener

**无 listener 时根本不调用 `view`**，这是零分配的安静路径。`advanceCell()` 的折叠循环里也有同样的槽位推移——冷推进跨过若干事件折叠历史时，若不同步作废 `views[1]`，`drive` 会拿到一个已被折叠掉的状态的 view，产生误抑制。`views` 字段在三处初始化：`session/created`、`restore()` 写回、`buildCell()`。

**不使用 WeakMap 记忆化的理由**：`6f0daff1dd` 的父提交 `12bef3b577` 曾引入 `Registration.viewMemo: WeakMap<object, unknown>` 与 `viewOf()`，但被 `6f0daff1dd` **完整删除**。WeakMap 方案要同时为 previous 与 next 各查一次表，且 `view(previous)` 依赖"该状态当时被算过"这一隐式前提；而 `drive` 手上同时握着 previous 和 next，双槽缓存只需把上一次算出的原始 view 挪到 `views[0]`，无需任何记忆化契约。

### D1b 移植基准是 `6f0daff1dd` 版本，不是 master

必须使用 `6f0daff1dd` 提交时的文件版本。master 版本依赖三个本地尚未移植的能力：

- **品牌类型**：master 的 `observedSeq` 是 `SessionSeqCursor`，`advanceCell` 用 `SessionSeq()` 与 `cursorBefore()`。本地 `packages/core/session` 无 `SessionSeq`/`SessionLogOffset`/`SessionSeqCursor`，`6f0daff1dd` 版本仍用裸 `number`
- **`init(header, inheritedEventCount)` 二参签名**：`6f0daff1dd` 版本仍是 `init(header)`
- **`snapshotEvents()` 与 `eventAt()`**：本地无这两个方法，`session.events` getter 仍在（`packages/core/session/src/index.ts:557`），而 `6f0daff1dd` 版本正好用 `session.events.slice(0, event.seq)`

官方从分叉点到 `6f0daff1dd` 之间该文件经历 8 个提交，但净效果是 `+39/−17`，因此直接移植净 diff 而非逐个重放。

### D1c 一并移植穷举测试

`6f0daff1dd` 的子提交 `9ba9a35c72 test(session-projection): cover view transition matrix` 给 `registry.spec.ts` 增加约 170 行穷举测试：15 条状态转移序列 × view 身份序列 × `baselineKnown` 两值 × `listenerMask` 八值 = 960 个场景，断言 `computedViews` 的对象身份序列与通知 seq 序列完全匹配。

这是该闸门最强的正确性证据，应与实现同批移植。

### D2 agent loop 按对象身份复用冻结证明

官方在 `packages/core/agent-loop/src/agent.ts` 新增 `private readonly frozenMessages = new WeakSet<Message>()`，在构造请求时跳过已证明冻结的消息：

```ts
for (const message of boundaryMessages) {
  if (this.frozenMessages.has(message)) continue
  deepFreeze(message)
  this.frozenMessages.add(message)
}
Object.freeze(boundaryMessages)
```

替换原先对**整个请求对象**的一次 `deepFreeze`。header 仍每次重新冻结（`deepFreeze(header)`），信号保持可变。

**为什么快**：`deepFreeze` 是迭代式全图遍历（显式 `pending` 栈 + `WeakSet seen` 去重）。长工具对话里历史消息线性增长，原实现每次构造请求都对整段历史做一次 O(全部节点) 遍历；`frozenMessages` 让后续请求只遍历新增消息。

**必须按对象身份而非 `Object.isFrozen`**：浅冻结的根对象不能证明其后代已冻结（测试中就有 `Object.freeze(userEvent.data)` 但 `content` 仍可变的场景）；`Session.fromRestore` 走的是递归 `freezeRestoredObject`，而 `append` 走 `deepFreeze`；缓存 message id 也不安全——替换操作可保留 id 同时改变对象身份与内容。用 `WeakSet` 而非 `Set` 避免钉住已被压缩的旧历史。

**本地前提已验证成立**：`packages/core/session/src/index.ts` 的 `deriveMessages()` 返回**新数组但共享同一批 Message 对象**（`deriveEventMessage` 逐字透传 `event.data` 或 `event.data.message`），因此对象身份跨请求稳定，命中率接近 100%，只在 surface 替换换代时失效。本地该文件的 `derived` 增量缓存与官方 master 一致（仅 `replaceGeneration` 与 master 的 `contentGeneration` 命名不同）。

**本地 `buildRequest` 与 `73edce1ae7` 的父提交逐字一致**，因此该提交的补丁可直接应用。`Message` 类型在本地 `agent.ts:19` 已导入，无需官方后续的修复提交。

### D3 typert 的 schema 改为首次使用时物化

官方把生成的 schema 从立即构造改为惰性工厂。

`packages/typert/generator/src/emitter.ts` 的生成模板改为：

```ts
let <name>$value
const <name> = () => (<name>$value ??= <typeSchema(boundary.type)>)
```

配套的协议与注册表改动：

- `packages/typert/protocol/src/types.ts` 的 strict codec 分支 `readonly schema: TypertSchema` 改为 `readonly create: () => TypertSchema`
- `packages/typert/registry/src/types.ts` 的 `TypertSchema` 改名为 `TypertSchemaFactory`（`name` + `create`），`TypertContribution.schemas` 改为 `readonly TypertSchemaFactory[]`，`TypertSchemaRecord` 去掉 `extends` 并内联 `name` 与 `schema`
- `packages/typert/registry/src/service.ts` 的 `get()`、`resolve()`、`list()` 三个读方法经新增的 `materializeSchema()` 物化，该方法用 `record.value ??= record.create()` 只缓存成功结果
- `packages/typert/loader/src/index.ts` 的两处校验从探测 `_zod` 改为 `typeof schema.create !== 'function'`
- `packages/api/gateway` 的两处消费点从 `codec.schema.parse(value)` 改为 `codec.create().parse(value)`

**为什么快**：启动期 loader 会 `import()` 每个注册包的产物，原本为**全部** schema 付 zod 构造成本，而绝大多数在进程生命周期内从未被消费。改动后成本从"全部 schema"降到"实际用到的 schema"。

**只缓存成功结果**：`??=` 只在 `create()` 成功返回时写入，抛错时保持 `undefined` 使下次读重试。这与 D1、D2 的"仅成功才记证明"是同一种纪律。

**需要复查的一点**：`list()` 会对**每一个**匹配记录调用 `create()`。若存在只为读元数据的 `list()` 调用，收益会被抵消。实现时需确认调用方，并用 `vi.fn` 断言 `create` 只被调用一次且返回同一实例。

### D4 三个 typert 源文件必须按语义局部编辑

本地 typert 源文件与分叉点一致，但**与 `e459e32637` 的父提交不一致**——官方中间夹了 `ebce3a5f04`（runtime identity 适配器）与 `6aa2e4633c`（boot 重构）等提交。

| 文件 | 与父提交的差异 | 移植方式 |
|---|---|---|
| `generator/src/emitter.ts` | 无 | 可直接套用 |
| `registry/src/types.ts` | 无 | 可直接套用 |
| `registry/src/service.ts` | 20 行 | 按语义局部编辑 |
| `loader/src/index.ts` | 67 行 | 按语义局部编辑 |
| `protocol/src/types.ts` | 51 行 | 按语义局部编辑 |

测试与快照文件全部与父提交一致，可直接套用。

### D5 清理误跟踪产物，但保留两个历史遗留

本地 `packages/typert/generator/tests/` 下有 **47 个** `.generated-*` 产物需要 `git rm --cached`（总跟踪数 49，其中 `.generated-model-O7FJNT` 与 `.generated-model-qwn8sk` 两个在分叉点时就已存在且与官方逐字一致，**不删**）。

本地 `.gitignore:63` **已有** `packages/typert/generator/tests/.generated-*/` 规则且匹配生效，但对已跟踪文件 ignore 不生效——这正是需要 `git rm --cached` 的原因。规则本身由本地提交 `39efc524fc` 引入，晚于产生产物的两个提交 `4ec7363c6d`（5 个）与 `ee05849fb6`（42 个）。

清理的副作用：产物中的 `.generated-model-*/consumer.ts` 等真实 TypeScript 文件当前正在被 oxlint 检查（其 `overrides` 覆盖 `packages/*/*/tests/**/*.ts`），移除后 lint 面缩小。`tsconfig` 的 `include` 只有 `src`，因此不影响 `tsc`。

该清理可以单独一个 chore 提交，不阻塞其他三项。

### D6 生成产物在本地当前无法刷新

`packages/extensions/tool-cordis/src/api-catalog.ts` 由 `pnpm run gen-cordis-api` 生成（实现在 `scripts/gen-cordis-catalog.ts`）。

**但本地生成器当前跑不通**：它报两个 partition violation——`ctx.skillRoots`（`packages/skill/skill-filesystem/src/index.ts`）与 `ctx.mcpAuthSink`（`packages/mcp/mcp-client/src/connection.ts`）是本地 fork 独有的服务，未在 `SERVICE_PAGE` 或 `SERVICE_WALK_EXEMPTIONS` 中登记。

因此本批次对该文件的改动只能**手工编辑字符串常量**。该文件已含 308 行 fork 改动（如 `delivery` 服务区块），**绝不可用官方文件整段覆盖**。

恢复生成能力需先在 `SERVICE_PAGE` 或 `SERVICE_WALK_EXEMPTIONS` 中补上这两个服务的映射，那是一个独立的、与本次移植无关的前置修复。本批次不处理它，但需在 tasks 中记录该限制。

## 3. 被拒绝的方案

**用 WeakMap 记忆化 view 结果**：不采用。官方已在同一文件内以双槽方案替换（`12bef3b577` 的 `viewMemo` 与 `viewOf()` 在 master 上已不存在），且双槽方案同时表达"上次发布值"语义。

**用 `Object.isFrozen` 判断消息是否已冻结**：不采用。浅冻结不能证明后代已冻结，restore 会接管未冻结对象图，替换操作可保留 id 却改变对象身份。

**照抄 master 版本的三个源文件**：不采用。master 依赖本地未移植的品牌类型、二参与五参签名、以及 `snapshotEvents()`，会编译失败。

**把 typert 的 schema 改为按需 `import()` 而非惰性求值**：不采用。模块加载本身是启动期成本，惰性求值解决的是同一模块内 schema 构造的成本，两者针对不同瓶颈。

**只清理产物不改生成器**：不采用。清理后下次测试会重新生成旧形态文件，问题复现。

**在本批次顺手修复 api-catalog 生成器**：不采用。需要为两个 fork 独有服务决定 `SERVICE_PAGE` 映射，属于独立的文档基础设施修复，混入会让本批次的范围失焦。本批次只手工编辑该文件的两处字符串。

## 4. 影响面

- `packages/session/session-projection/src/index.ts`：新增 `views` 字段与其三处初始化，`drive()` 与 `advanceCell()` 加闸门
- `packages/session/session-projection/src/invariant.ts`：更新闸门描述
- `packages/session/session-projection/README.zh.md`、`docs/subsystems/session-projection.zh.md`：同步契约描述
- `packages/session/session-projection/tests/registry.spec.ts`：替换两个旧用例并新增三个闸门用例，另加穷举转移矩阵
- `packages/api/session-controller/tests/session-projections.host.spec.ts`：改测试名与一处注释（**不要整文件覆盖**，本地该文件已有 36 行 fork 改动）
- `packages/core/agent-loop/src/agent.ts`：新增 `frozenMessages` 字段与构造请求时的跳过分支
- `packages/core/agent-loop/tests/request-freeze.spec.ts`：新增（需按本地 `fromRestore` 三参与 `surfaceOp` 字段名适配）
- `packages/core/agent-loop/README.zh.md`、`docs/architecture.zh.md`：各加一段
- `packages/typert/{protocol,registry,loader,generator}/src/`：factory 化改造
- `packages/api/gateway/src/{index,client/index}.ts`：两处 `codec.create().parse`
- `packages/typert/**/README.zh.md`、`docs/subsystems/typert.zh.md`：同步措辞
- `packages/typert/generator/tests/`：`git rm --cached` 清理 47 个产物；测试与快照按官方更新
- `packages/extensions/tool-cordis/src/api-catalog.ts`：手工改字符串（生成器当前不可用）

三项都触及运行时契约（投影发布语义、请求冻结归属、typert 协议类型），因此各需独立 Agent Note。

**本地 fork 特有、不可被整体文件覆盖的内容**：`packages/session/session-projection/README.zh.md` 已删英文切换行；`docs/subsystems/session-projection.zh.md` 已含 `session-projection-cache.remove(id)` 条目；`docs/architecture.zh.md` 与 `packages/core/agent-loop/README.zh.md` 已有 image-understanding 段落；`api-catalog.ts` 有 308 行 fork 改动；`session-projections.host.spec.ts` 有 36 行 modelSelection 测试。

## 5. 验证方式

- 会话投影：新增用例覆盖 state 引用未变时不调用 `view`、view 引用未变时不通知 listener、无 listener 时不分配、listener 断层后重订阅仍发布首帧；穷举转移矩阵断言 view 身份序列与通知 seq 序列匹配
- agent loop：新增用例断言同一消息在多次请求间只深冻结一次、替换后对象身份变化的同 id 消息会重新冻结、请求内容与冻结前一致
- typert：启动期不构造未被使用的 schema；首次使用时构造并缓存同一实例；`list()` 路径的物化行为有显式断言；loader 对缺少 `create` 的贡献报错
- 全量：`pnpm run test` 与受影响包的 `tsc -b`
- 产物清理：`git ls-files packages/typert/generator/tests/` 不再含 `.generated-*`（两个历史遗留除外），且测试后工作区干净
