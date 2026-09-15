# Agent Note: 生成的 Typert schema 改为首次使用时物化

Status: implemented

## Problem

Typert 的生成产物原先直接构造并导出 zod schema：

```ts
const Payload = z.object({ /* … */ })
```

启动期 Loader 会 `import()` 每个注册了 `./typert` 的包，因此**全部** schema 的 zod 构造成本都落在启动路径上，而绝大多数 schema 在进程生命周期内从未被消费。构造量随注册包数量线性增长，与实际的类型边界使用量无关。

## Decision

生成的 schema 改为惰性工厂，只在首次被读取时物化，且只缓存成功的构造：

```ts
let Payload$value
const Payload = () => (Payload$value ??= z.object({ /* … */ }))
```

配套改动覆盖四处：

- `packages/typert/generator/src/emitter.ts`：贡献清单发射 `{ name, create }`，`.d.ts` 声明改为 `() => z.ZodType<T>`，边界与声明的 schema 定义改为 `??=` 形式，递归引用改为 `z.lazy(() => name())`。
- `packages/typert/protocol/src/types.ts`：strict codec 的 `readonly schema: TypertSchema` 改为 `readonly create: () => TypertSchema`。
- `packages/typert/registry/src/types.ts`：`TypertSchema` 更名为 `TypertSchemaFactory`（`name` + `create`）；`TypertContribution.schemas` 改为工厂数组；`TypertSchemaRecord` 不再继承它，而是内联 `name` 与已物化的 `schema`。
- `packages/typert/registry/src/service.ts`：`get`、`resolve`、`list` 三个读出口经 `materializeSchema` 物化，该方法用 `record.value ??= record.create()` 缓存成功结果；`validateSchemas` 与 `validateCodec` 的校验从探测 zod 内部标记 `_zod` 改为探测 `typeof create === 'function'`。
- `packages/typert/loader/src/index.ts`：两处 manifest 校验同样改为探测 `create`。
- `packages/api/gateway/src/index.ts` 与其 `client/index.ts`：消费点改为 `codec.create().parse(value)`。

`??=` 只在 `create()` 成功返回时写入，抛错时保持未物化使下次读取重试。这与同一批次另外两项优化遵循同一条纪律：只把已成功的证明记录下来。`list()` 会对每个匹配记录调用 `create()`，因此它仍会物化全部匹配项——这一点在 README 中说明。

## 曾考虑的替代方案

**按需动态 `import()` 生成模块。** 不予采用：模块加载本身是启动期成本，而本问题出在同一模块内 schema 构造的成本，两者针对不同瓶颈。

**在注册时立即物化并缓存。** 不予采用：那正是要消除的启动期成本。

**缓存失败结果。** 不予采用：`create()` 失败通常源于依赖或环境问题，缓存它会让一次瞬时失败永久化。

**保留 `_zod` 探测而不改用 `create`。** 不予采用：`_zod` 是 zod 的内部标记，而 manifest 现在携带的是工厂；继续探测内部标记会让校验与实际契约脱节。

## Consequences

启动期不再为未被消费的 schema 付构造成本。代价是每次 schema 读取都要经过一次 `materializeSchema` 调用，且首次读取有一个构造延迟——该延迟落在真正使用类型的边界上，而不是启动路径上。

`TypertSchema` 这个类型名在 registry 包内被 `TypertSchemaFactory` 顶替，protocol 包的同名类型（只声明 `parse()`）保持不变。两个包的消费方需要区分它们。

schema 的读取出口语义从"返回已存记录"变为"返回物化后的记录"，因此 `get`、`resolve`、`list` 的 JSDoc 返回值描述同步改写。

## Testing

`packages/typert/registry/tests/typert.spec.ts` 用 `vi.fn` 包裹 factory，断言注册后**未被调用**、首次 `resolve` 后恰好调用一次、再次 `resolve` 复用同一 schema 实例（不新增调用）。

`packages/typert/loader/tests/loader.spec.ts` 与 `packages/typert/generator/tests/` 的 fixture 与断言改为工厂形态，并把两处错误信息断言从 `not a zod v4 schema instance`、`is not backed by a zod v4 schema` 改为 `has no create() factory`、`has no create() factory`。

`packages/typert/generator/tests/__snapshots__/type-model.spec.ts.snap` 同步更新：`const X = z.object(...)` 变为 `let X$value` + `const X = () => (X$value ??= z.object(...))`，贡献清单的 `schema:` 变为 `create:`。

生成器自身的 `cordis-catalog.spec.ts` 在本仓库有 2 个预先存在的失败（生成器报 `ctx.skillRoots` 与 `ctx.mcpAuthSink` 未登记到 `SERVICE_PAGE`），与本次改动无关，已用 stash 对照确认。
