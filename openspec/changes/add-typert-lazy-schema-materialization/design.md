# 技术决策

移植目标为官方提交 `e459e32637`（`perf(typert): materialize generated schemas on first use`）。本文件记录决策编号，供 tasks.md 锚定。

## 移植面基线

本地 typert 源文件与分叉点 `0a53fb55be` 一致：

```
git diff --stat 0a53fb55be..HEAD -- \
  packages/typert/generator/src/ packages/typert/registry/src/ \
  packages/typert/loader/src/ packages/typert/protocol/src/
```

只显示 `packages/typert/generator/src/cordis-catalog.ts` 的 8 行文档中文化。`packages/api/gateway/src/` 相对分叉点无差异。

**但本地与 `e459e32637` 的父提交并不一致**：官方在分叉点到该提交之间夹了若干无关提交，五个源文件中有三个已漂移。实测 `git diff --stat 0a53fb55be e459e32637^ --`：

| 文件 | 中间提交数 | 与父提交的差异 | 移植方式 |
|---|---:|---|---|
| `generator/src/emitter.ts` | 0 | 无 | 可直接套用补丁 |
| `registry/src/types.ts` | 0 | 无 | 可直接套用补丁 |
| `registry/src/service.ts` | 1 | 17 行 | 按语义局部编辑 |
| `loader/src/index.ts` | 2 | 49 行 | 按语义局部编辑 |
| `protocol/src/types.ts` | 2 | 42 行 | 按语义局部编辑 |

因此本变更是「三个文件局部编辑 + 两个文件套用补丁」，不是整文件覆盖。局部编辑时以 D4–D7 的语义为准，不以官方行号为准。

测试与快照文件与父提交一致，可直接套用。

### D1 生成器发射工厂而非立即求值的 schema

边界与声明定义从：

```ts
const ${name} = ${this.typeSchema(boundary.type)}
```

改为：

```ts
let ${name}$value
const ${name} = () => (${name}$value ??= ${this.typeSchema(boundary.type)})
```

`??=` 使工厂天然幂等：首次调用构造并缓存，后续调用直接返回缓存值。同一模式同时应用于 `boundaryDefinition` 与 `declarationDefinition` 两条路径。

不引入显式的「已物化」布尔量或 `undefined` 检查：`??=` 在保持生成代码最短的同时给出了完全相同的语义，且不依赖被物化值永不为 `undefined`。

### D2 递归引用必须改为调用工厂

`z.lazy(() => ${name})` 改为 `z.lazy(() => ${name}())`。

这是 D1 的直接后果，也是容易漏掉的一处：`z.lazy` 的回调在**解析时**才执行，因此它拿到的是工厂函数本身而不是 schema。若漏改，递归 schema 会在解析时抛「不是 schema」类错误，而类型检查不会发现——`z.lazy` 的返回类型在生成代码里通常是宽松的。

非泛型声明走 `z.lazy(() => ${name}())`；泛型声明继续走 `z.lazy(() => ${name}(${arguments_.join(', ')}))`，因为泛型路径本来就是函数调用。

### D3 生成的 `.d.ts` 声明同步改为函数类型

```ts
export declare const ${schema.exportName}: () => z.ZodType<${schema.exportName}$source>
```

声明与实现必须一致，否则消费方按值使用生成模块时会编译失败。这一条也决定了消费方（网关）必须改为调用工厂。

### D4 协议面：严格编解码的 `schema` 字段改为 `create` 工厂

`TypertCodec` 的 strict 分支：

```ts
readonly schema: TypertSchema
```

改为：

```ts
/** Materialize and return the process-realm schema on first boundary use. */
readonly create: () => TypertSchema
```

字段名从 `schema` 改为 `create` 而非保留 `schema` 但改类型，是为了让所有使用点在编译期暴露出来——保留字段名会让 `codec.schema.parse(value)` 这类用法静默地变成「在函数对象上找 parse」的运行时错误。改名使漏改成为编译错误。

### D5 注册表面：贡献用工厂，记录用物化后的 schema

注册表侧的拆分是本变更的核心：

- `TypertSchema` 重命名并改造为 `TypertSchemaFactory`：`{ readonly name: string; readonly create: () => z.ZodType }`，这是**贡献面**的类型
- `TypertSchemaRecord` 不再 `extends TypertSchema`，改为独立声明 `{ name, schema: z.ZodType, package, face, key }`，这是**读取面**的类型，承载物化后的实例
- 新增内部 `TypertSchemaFactoryRecord extends TypertSchemaFactory`，附加 `package` / `face` / `key` 与可变的 `value?: z.ZodType`，是注册表内部存储的形态
- 新增 `materializeSchema(record)`：`const schema = record.value ??= record.create()`，返回拼装好的 `TypertSchemaRecord`

分工的理由：贡献方提供的是「怎么造」，读取方要的是「造好的」。把两者分开后，物化时机完全由注册表掌握，贡献方无法观察到物化发生与否，也无法影响缓存策略。

### D6 物化发生在读取出口，且只发生一次

`get()`、`resolve()`、`list()` 三个出口各自调用 `materializeSchema`：

- `get()`：`const record = this.schemas.get(key); return record === undefined ? undefined : materializeSchema(record)`
- `resolve()`：命中缓存时 `return materializeSchema(record)`；未命中则走既有的惰性注册路径
- `list()`：`.filter(...).map(materializeSchema)`

`value ??= record.create()` 保证每个注册表条目至多物化一次。物化结果缓存在 `TypertSchemaFactoryRecord.value` 上，其生命周期与注册表条目相同——条目在包撤回时整体移除，缓存随之消失，无需额外的失效逻辑。

**已知代价**：`list()` 会对每一个通过过滤的记录调用 `create()`。若存在只为读元数据（`key`、`package`、`face`）的 `list()` 调用，其收益会被抵消。本地 `ctx.typert.list()` 的调用方目前只有 typert 自身的测试，尚未发现只读元数据的生产调用方；实施时须复查一遍，并以 `vi.fn` 断言工厂只被调用一次且返回同一实例。若将来出现元数据型调用方，应为其单独提供一个不物化的枚举入口，而不是让 `list()` 变得有条件。

### D7 加载器与注册表的校验从探测 `_zod` 改为探测工厂

`packages/typert/loader/src/index.ts` 有两处校验，`packages/typert/registry/src/service.ts` 有两处：

| 位置 | 原校验 | 新校验 |
|---|---|---|
| loader schema 条目 | `typeof schema.schema !== 'object' \|\| schema.schema === null \|\| !('_zod' in schema.schema)` | `typeof schema.create !== 'function'` |
| loader 严格编解码 | `typeof codec.schema !== 'object' \|\| ... \|\| typeof codec.schema.parse !== 'function'` | `typeof codec.create !== 'function'` |
| registry `validateSchemas` | （无） | 新增 `typeof schema.create !== 'function'` 即抛 |
| registry `validateCodec` | `typeof codec.schema.parse !== 'function'` | `typeof codec.create !== 'function'` |

改动的实质：原来的校验探测的是「这看起来像一个 zod v4 实例」（`_zod` 是 zod v4 的内部标记），新校验探测的是「这满足工厂契约」。前者在惰性化之后不再可能——加载期根本没有实例可探测，而且探测实例会强制物化，与本次优化直接冲突。后者同时更准确：边界校验本就该校验契约形状，而不是第三方库的内部标记。

registry 的 `validateSchemas` 新增一条早失败校验，使缺少 `create` 的贡献在注册期而非首次读取时报错，符合「错误配置要大声失败」的既有约定。

### D8 网关按需物化

`packages/api/gateway/src/index.ts` 的 `decode()`：

```ts
value = codec.schema.parse(value)
```

改为：

```ts
value = codec.create().parse(value)
```

`packages/api/gateway/src/client/index.ts` 的 `parseInput()` 同理。两处都是每次调用工厂再 `parse`，依赖 D6 的缓存保证实际只物化一次。这是有意为之：网关不持有缓存，缓存归属于注册表，避免出现两份互不知晓的缓存。

### D9 前置清理被跟踪的测试生成产物，但保留两个历史遗留

本地 `packages/typert/generator/tests/` 下有 49 个 `.generated-*` 文件被 git 跟踪。其中 **2 个在分叉点 `0a53fb55be` 时就已被跟踪**，且与官方逐字一致：

- `packages/typert/generator/tests/.generated-model-O7FJNT/host.mjs`
- `packages/typert/generator/tests/.generated-model-qwn8sk/host.mjs`

这两个是历史遗留，MUST NOT 清理——它们与官方保持一致，清理会产生无谓的移植噪声。因此实际需清理的是 **47 个**，而非 49 个。

本地 `.gitignore:63` 已包含 `packages/typert/generator/tests/.generated-*/` 规则，但对已跟踪文件无效。清理方式（先列清单再逐目录 `--cached`）：

```
git ls-files packages/typert/generator/tests/ | grep '\.generated-' \
  | grep -v '\.generated-model-O7FJNT/host\.mjs' \
  | grep -v '\.generated-model-qwn8sk/host\.mjs'
```

使用 `--cached` 而非删除：这些是测试运行期产物，磁盘上保留不影响后续测试。清理后 `.gitignore` 规则自然生效。

副作用需记录：产物中的 `.generated-model-*/consumer.ts` 等真实 TypeScript 文件当前正被 oxlint 检查（其 `overrides` 覆盖 `packages/*/*/tests/**/*.ts`），移出索引后 lint 面缩小。`tsconfig` 的 `include` 只有 `src`，因此不影响 `tsc`。

该清理可以单独一个 chore 提交，不阻塞其余移植。

### D10 生成产物当前无法经生成器刷新，只能定点改字符串

`packages/extensions/tool-cordis/src/api-catalog.ts` 是生成产物，生成命令为：

```
pnpm run gen-cordis-catalog      # 生成
pnpm run verify-cordis-catalog   # 校验（--check）
```

**但本地生成器当前跑不通**。实测 `pnpm run verify-cordis-catalog` 报两个 partition violation 并以退出码 1 失败：

- `service ctx.skillRoots`（`packages/skill/skill-filesystem/src/index.ts:129`）没有 `SERVICE_PAGE` 条目
- `ctx.mcpAuthSink`（`packages/mcp/mcp-client/src/connection.ts`）在 Context merge 中声明但对渲染投影不可见

两者都是本地 fork 独有的服务，未在 `SERVICE_PAGE` 或 `SERVICE_WALK_EXEMPTIONS` 中登记。

因此本变更对该文件只能**手工编辑字符串常量**，且 MUST NOT 用官方文件整段覆盖——本地该文件已有 +290/−18 的 fork 改动（含 `delivery` 服务区块等）。需改的是两处：`TypertSchema` / `TypertSchemaFactory` / `TypertCodec` 的类型声明字符串，以及 `get` / `resolve` / `list` 的 `returns` 描述字符串。

恢复生成能力需先为这两个服务决定 `SERVICE_PAGE` 映射，属于独立的文档基础设施修复，不在本变更范围内。本变更只在 tasks 中记录该限制，并在实施后以人工比对代替 `verify-cordis-catalog` 校验。

## 被拒绝的方案

**保留 `schema` 字段名，只把类型改成工厂**：所有 `codec.schema.parse(value)` 使用点会静默变成运行时错误而非编译错误。改名为 `create` 使漏改成为编译失败。

**在加载期物化一次并缓存到模块级变量**：那正是本次优化要消除的成本，惰性化失去意义。

**让贡献方自己提供已物化的 schema 加一个懒加载包装**：把缓存策略推给每个生成模块，产生 N 份互不知晓的实现，且注册表无法统一控制失效时机。

**保留 `_zod` 探测作为兼容路径**：惰性化之后加载期不存在实例，探测必然失败或强制物化。保留它等于保留一个必须物化才能通过的校验。

**网关侧自行缓存物化结果**：会产生两份缓存，且包撤回时网关侧缓存无法感知。缓存归属于注册表条目。

**手工合并 `api-catalog.ts`**：该文件是生成产物，手工编辑会被下一次 `verify-cordis-catalog` 判定为漂移。但本地生成器当前因两个 fork 独有服务未登记而失败，因此本变更对该文件只能定点改字符串，并把恢复生成能力列为独立前置修复。

**顺带修复 api-catalog 生成器**：需要为 `ctx.skillRoots` 与 `ctx.mcpAuthSink` 决定 `SERVICE_PAGE` 映射，属于独立的文档基础设施修复；混入会让本变更的范围失焦。

**把 typert 的 schema 改为按需 `import()` 而非惰性求值**：模块加载本身是启动期成本，惰性求值解决的是同一模块内 schema 构造的成本，两者针对不同瓶颈。
