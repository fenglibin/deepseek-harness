# typert 生成 schema 改为首次使用时物化

## 为什么

typert 生成器为每个类型边界与每个声明发射一个**立即求值**的 zod schema 常量：

```ts
const ${name} = ${this.typeSchema(boundary.type)}
```

包被加载时，所有这些 schema 都会被构造出来，无论该边界是否真的会被使用。对只用到少数 Remote 方法或少数 schema 的调用方，这是启动期的纯浪费：zod schema 的构造（尤其是递归 `z.lazy` 与对象/联合的组合）在大型 API 面上代价可观。

官方提交 `e459e32637`（`perf(typert): materialize generated schemas on first use`）把生成产物从「立即求值的 schema 值」改为「首次使用时求值的工厂」，注册表在第一次真正需要 schema 时才调用工厂并缓存结果。该提交在官方改动 38 文件、+205/−162。

## 做什么

把 schema 从「值」改为「工厂」，并在注册表侧做一次物化缓存：

- **生成器**（`packages/typert/generator/src/emitter.ts`）：边界与声明的定义从 `const X = <schema>` 改为 `let X$value` + `const X = () => (X$value ??= <schema>)`；递归引用从 `z.lazy(() => X)` 改为 `z.lazy(() => X())`；生成的 `.d.ts` 声明从 `const X: z.ZodType<T>` 改为 `const X: () => z.ZodType<T>`
- **协议**（`packages/typert/protocol/src/types.ts`）：严格编解码的 `readonly schema: TypertSchema` 改为 `readonly create: () => TypertSchema`
- **注册表**（`packages/typert/registry/src/{types,service}.ts`）：贡献面类型由 `TypertSchema` 改为 `TypertSchemaFactory`，新增内部 `TypertSchemaFactoryRecord` 与 `materializeSchema()`，在 `get()` / `resolve()` / `list()` 出口处物化
- **加载器**（`packages/typert/loader/src/index.ts`）：schema 与严格编解码的校验从探测 `_zod` 属性改为 `typeof schema.create !== 'function'`
- **网关**（`packages/api/gateway/src/{index,client/index}.ts`）：严格编解码的解码从 `codec.schema.parse(value)` 改为 `codec.create().parse(value)`

## 不做什么

- 不改 typert 的线协议与方法调用协议：只有进程内 schema 的物化时机改变
- 不改变 schema 的语义：`materializeSchema()` 返回的仍是同一个 zod schema 实例（首次调用后缓存）
- 不改变注册表贡献的原子性：注册与撤回仍整体生效
- 不手工编辑生成产物：`packages/extensions/tool-cordis/src/api-catalog.ts` 由源码 JSDoc 生成，必须经 `pnpm run gen-cordis-catalog` 重新生成
- 不把 `12bef3b577` 或任何 session-projection 相关提交混入本变更

## 影响

- `packages/typert/generator/src/emitter.ts` 与其测试、快照
- `packages/typert/protocol/src/types.ts`
- `packages/typert/registry/src/{types,service}.ts` 与其测试
- `packages/typert/loader/src/index.ts` 与其测试
- `packages/api/gateway/src/{index,client/index}.ts` 与其测试
- `packages/extensions/tool-cordis/src/api-catalog.ts`（手工定点改字符串，原因见下）
- 四个 typert 包的 README.zh.md 与 `docs/subsystems/typert.zh.md`

本地 typert 源文件与分叉点 `0a53fb55be` 一致（仅有 `generator/src/cordis-catalog.ts` 的 8 行文档中文化），移植面干净。但本地与 `e459e32637` 的**父提交**并不一致：官方中间夹了无关提交，`registry/src/service.ts`（17 行）、`loader/src/index.ts`（49 行）与 `protocol/src/types.ts`（42 行）需按语义局部编辑，`emitter.ts` 与 `registry/src/types.ts` 可直接套用补丁。

**前置清理**：本地 `packages/typert/generator/tests/` 下有 49 个 `.generated-*` 临时产物被 git 跟踪，其中 2 个（`.generated-model-O7FJNT/host.mjs` 与 `.generated-model-qwn8sk/host.mjs`）在分叉点时就已存在且与官方一致，**不清理**；实际需 `git rm --cached` 的是 **47 个**。本地 `.gitignore:63` 已有 `packages/typert/generator/tests/.generated-*/` 规则但对已跟踪文件无效。

**生成器当前不可用**：`packages/extensions/tool-cordis/src/api-catalog.ts` 本应经 `pnpm run gen-cordis-catalog` 重新生成，但该命令在本地以退出码 1 失败——`ctx.skillRoots` 与 `ctx.mcpAuthSink` 两个 fork 独有服务未在 `SERVICE_PAGE` / `SERVICE_WALK_EXEMPTIONS` 中登记。因此本次对该文件只能定点修改字符串常量，且绝不可用官方文件整段覆盖（本地已有 +290/−18 的 fork 改动）。恢复生成能力是独立的前置修复，不在本变更范围内。

该变更是跨包的结构契约变更（l2）。
