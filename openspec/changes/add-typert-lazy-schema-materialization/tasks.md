# 实施清单

移植目标为官方提交 `e459e32637`。本地 typert 四个包的源码与分叉点一致（仅 `generator/src/cordis-catalog.ts` 有 8 行文档中文化），但**与 `e459e32637` 的父提交不一致**：`generator/src/emitter.ts` 与 `registry/src/types.ts` 可直接套用补丁，`registry/src/service.ts`（17 行）、`loader/src/index.ts`（49 行）与 `protocol/src/types.ts`（42 行）必须按语义局部编辑，不得整文件覆盖，也不得以官方行号定位。

## 1. 前置清理

- [x] 1.1 用 `git ls-files packages/typert/generator/tests/ | grep '\.generated-'` 列出被跟踪的临时产物清单（当前 49 个文件），并确认其中 2 个在分叉点 `0a53fb55be` 时就已存在且与官方逐字一致 (covers: typert/两个历史遗留保持跟踪, design/D9)
- [x] 1.2 对 **47 个**需清理的目录执行 `git rm --cached -r`（排除 `.generated-model-O7FJNT/host.mjs` 与 `.generated-model-qwn8sk/host.mjs`），保留文件浏览器；确认 `.gitignore:63` 规则此后对新产物生效 (covers: typert/清理后 gitignore 规则生效, typert/清理保留文件浏览器, design/D9)
- [x] 1.3 跑一次 `packages/typert/generator` 测试，确认清理未影响测试通过（产物仍在磁盘上） (covers: typert/清理保留文件浏览器, design/D9)
- [x] 1.4 记录副作用：`consumer.ts` 等产物移出索引后 oxlint 检查面缩小；`tsconfig` 的 `include` 只有 `src`，不影响 `tsc` (covers: design/D9)

## 2. 生成器

- [x] 2.1 在 `packages/typert/generator/src/emitter.ts` 的 `SchemaEmitter.emit()` 中，把边界定义改为 `let ${name}$value` + `const ${name} = () => (${name}$value ??= ${this.typeSchema(boundary.type)})` (covers: typert/边界 schema 在首次调用时才构造, design/D1)
- [x] 2.2 在 `declarationDefinition()` 的非泛型分支应用同一模式 (covers: typert/工厂重复调用返回同一实例, design/D1)
- [x] 2.3 把非泛型声明的递归引用从 `z.lazy(() => ${name})` 改为 `z.lazy(() => ${name}())`；泛型分支保持 `z.lazy(() => ${name}(...))` 不变 (covers: typert/递归 schema 可正常解析, typert/泛型声明的递归引用保持参数化调用, design/D2)
- [x] 2.4 把 `FaceModelEmitter` 发射的 schema 清单项从 `schema: ${schema.exportName}` 改为 `create: ${schema.exportName}` (covers: typert/贡献方提供工厂, design/D5)
- [x] 2.5 把生成的 `.d.ts` 声明从 `export declare const X: z.ZodType<T>` 改为 `export declare const X: () => z.ZodType<T>` (covers: typert/生成的声明与实现一致, design/D3)
- [x] 2.6 把 `strictCodec()` 生成的编解码从 `schema: ${schema}` 改为 `create: ${schema}` (covers: typert/网关经工厂解析输入, design/D4)

## 3. 协议面

- [x] 3.1 在 `packages/typert/protocol/src/types.ts` 的 `TypertCodec` strict 分支把 `readonly schema: TypertSchema` 改为 `readonly create: () => TypertSchema`，并补 JSDoc「首次边界使用时物化并返回进程域 schema」 (covers: typert/网关经工厂解析输入, design/D4)
- [x] 3.2 确认字段改名（而非仅改类型）使所有使用点在编译期暴露；逐个修完前不得依赖运行时测试发现漏改 (covers: typert/客户端经工厂解析输入, design/D4)

## 4. 注册表面

- [x] 4.1 在 `packages/typert/registry/src/types.ts` 把 `TypertSchema` 改造为 `TypertSchemaFactory`（`name` + `create: () => z.ZodType`），`TypertContribution.schemas` 改为 `readonly TypertSchemaFactory[]` (covers: typert/贡献方提供工厂, design/D5)
- [x] 4.2 把 `TypertSchemaRecord` 从 `extends TypertSchema` 改为独立声明 `{ name, schema: z.ZodType, package, face, key }`，不再继承贡献面类型 (covers: typert/读取方获得物化记录, design/D5)
- [x] 4.3 在 `packages/typert/registry/src/service.ts` 新增内部 `TypertSchemaFactoryRecord extends TypertSchemaFactory`，附加 `package` / `face` / `key` 与可变 `value?: z.ZodType`，并把 `schemas` map 的值类型改为它 (covers: typert/同一 schema 的重复读取复用缓存, design/D5)
- [x] 4.4 新增 `materializeSchema(record): TypertSchemaRecord`，以 `record.value ??= record.create()` 物化并拼装记录 (covers: typert/同一 schema 的重复读取复用缓存, design/D6)
- [x] 4.5 `get()` 命中条目时返回 `materializeSchema(record)`，未命中返回 `undefined`；同步更新 JSDoc 返回描述为「含已缓存 schema 的记录」 (covers: typert/同一 schema 的重复读取复用缓存, design/D6)
- [x] 4.6 `resolve()` 命中缓存时返回 `materializeSchema(record)`，未命中走既有惰性注册路径；同步更新 JSDoc (covers: typert/未读取的 schema 不被物化, design/D6)
- [x] 4.7 `list()` 在过滤之后 `.map(materializeSchema)`，确保被过滤掉的条目不被物化 (covers: typert/list 返回物化后的记录, design/D6)
- [x] 4.8 确认包撤回移除注册条目时物化缓存随条目一并消失，无独立失效逻辑；补一条重注册后从工厂重新物化的用例 (covers: typert/包撤回后缓存随之消失, design/D6)
- [x] 4.9 在 `validateSchemas()` 中新增 `typeof schema.create !== 'function'` 的早失败校验，错误信息指明 schema 名 (covers: typert/缺少 create 的 schema 贡献在注册期被拒绝, design/D7)
- [x] 4.10 把 `validateCodec()` 的 `typeof codec.schema.parse !== 'function'` 改为 `typeof codec.create !== 'function'`，错误信息改为「没有 create() 工厂」 (covers: typert/缺少 create 的编解码被拒绝, design/D7)

## 5. 加载器

- [x] 5.1 在 `packages/typert/loader/src/index.ts` 把 schema 条目校验从探测 `_zod` 改为 `typeof schema.create !== 'function'`，错误信息改为「没有 create() 工厂」 (covers: typert/缺少 create 的 schema 贡献在注册期被拒绝, design/D7)
- [x] 5.2 把 `requireStrictCodec()` 的 `_zod` 与 `parse` 探测改为 `typeof codec.create !== 'function'` (covers: typert/缺少 create 的编解码被拒绝, design/D7)
- [x] 5.3 确认加载期校验不调用任何 schema 工厂（校验仅检查契约形状，不物化） (covers: typert/加载期不因校验而物化 schema, design/D7)

## 6. 网关消费方

- [x] 6.1 在 `packages/api/gateway/src/index.ts` 的 `decode()` 把 `codec.schema.parse(value)` 改为 `codec.create().parse(value)` (covers: typert/网关经工厂解析输入, design/D8)
- [x] 6.2 在 `packages/api/gateway/src/client/index.ts` 的 `parseInput()` 做同样改动，保持既有错误包装形态 (covers: typert/客户端经工厂解析输入, design/D8)
- [x] 6.3 确认网关侧不新增任何物化缓存：缓存归属于注册表条目，避免两份互不知晓的缓存 (covers: typert/同一 schema 的重复读取复用缓存, design/D8)

## 7. 测试

- [x] 7.1 更新 `packages/typert/generator/tests/schema-emitter.spec.ts` 与 `type-model.spec.ts`，断言发射结果为工厂形态 (covers: typert/边界 schema 在首次调用时才构造, design/D1)
- [x] 7.2 更新 `packages/typert/generator/tests/__snapshots__/type-model.spec.ts.snap`（快照随生成产物变化，不得手工伪造） (covers: typert/生成的声明与实现一致, design/D3)
- [x] 7.3 更新 `packages/typert/generator/tests/remote-model.spec.ts`，断言严格编解码以 `create` 暴露 (covers: typert/网关经工厂解析输入, design/D4)
- [x] 7.4 新增用例：工厂重复调用返回同一实例，且构造只发生一次 (covers: typert/工厂重复调用返回同一实例, design/D1)
- [x] 7.5 新增用例：递归声明经生成后能解析嵌套值（覆盖 D2 的 `z.lazy(() => X())` 改动） (covers: typert/递归 schema 可正常解析, design/D2)
- [x] 7.6 更新 `packages/typert/registry/tests/typert.spec.ts`：断言未读取的 schema 不被物化、重复读取只物化一次、`list()` 过滤掉的条目不物化、撤回后重注册重新物化 (covers: typert/未读取的 schema 不被物化, typert/list 返回物化后的记录, typert/包撤回后缓存随之消失, design/D6)
- [x] 7.7 复查 `ctx.typert.list()` 的调用方，确认不存在只为读元数据（`key` / `package` / `face`）的调用；若有，记录为后续工作项（另设不物化的枚举入口），并以 `vi.fn` 断言工厂只被调用一次且返回同一实例 (covers: typert/list 返回物化后的记录, design/D6)
- [x] 7.7 新增用例：缺少 `create` 的 schema 贡献在注册期抛错，缺少 `create` 的编解码在校验期抛错 (covers: typert/缺少 create 的 schema 贡献在注册期被拒绝, typert/缺少 create 的编解码被拒绝, design/D7)
- [x] 7.8 更新 `packages/typert/loader/tests/loader.spec.ts`：校验改为工厂契约后，加载期不调用工厂，非法清单仍被拒绝 (covers: typert/加载期不因校验而物化 schema, design/D7)
- [x] 7.9 更新 `packages/api/gateway/tests/` 下 `gateway.host.spec.ts`、`gateway.client.spec.ts` 与 `gateway-stream.host.spec.ts` 的编解码构造方式 (covers: typert/网关经工厂解析输入, typert/客户端经工厂解析输入, design/D8)

## 8. 生成产物与文档

- [x] 8.1 确认 `pnpm run gen-cordis-catalog` 当前因 `ctx.skillRoots`（`packages/skill/skill-filesystem/src/index.ts:129`）与 `ctx.mcpAuthSink`（`packages/mcp/mcp-client/src/connection.ts`）两个未登记服务而失败（实测退出码 1，2 个 partition violation） (covers: typert/生成器不可用被显式记录, design/D10)
- [x] 8.2 定点修改 `packages/extensions/tool-cordis/src/api-catalog.ts` 的字符串常量：`TypertCodec` strict 分支的 `schema` → `create: () => TypertSchema`，新增 `TypertSchemaFactory` 条目，`TypertSchema` 条目改为 `{ parse(value: unknown): Output }` 形态 (covers: typert/类型声明反映工厂契约, design/D10)
- [x] 8.3 定点修改该文件中 `get` / `resolve` / `list` 三处的 `returns` 描述字符串为「含已缓存 schema 的记录」措辞 (covers: typert/类型声明反映工厂契约, design/D10)
- [x] 8.4 逐条比对确认本地 fork 独有内容（如 `delivery` 服务区块等 +290/−18 改动）保持存在，绝不用官方文件整段覆盖 (covers: typert/本地 fork 内容不被覆盖, design/D10)
- [x] 8.5 记录后续工作项：为 `ctx.skillRoots` 与 `ctx.mcpAuthSink` 决定 `SERVICE_PAGE` 映射或加入 `SERVICE_WALK_EXEMPTIONS`，以恢复 `gen-cordis-catalog` 与 `verify-cordis-catalog`；该项属于独立的前置修复，不在本变更范围 (covers: typert/生成器不可用被显式记录, design/D10)
- [x] 8.6 更新 `packages/typert/generator/README.zh.md`、`registry/README.zh.md`、`loader/README.zh.md` 与 `protocol/README.zh.md` 中 schema 形态与校验契约的描述 (covers: typert/贡献方提供工厂, typert/读取方获得物化记录, design/D5)
- [x] 8.7 更新 `docs/subsystems/typert.zh.md` 中 schema 注册与物化时机的描述 (covers: typert/未读取的 schema 不被物化, design/D6)
- [x] 8.8 新增 Agent Note 记录惰性物化决策与 `_zod` 探测改为工厂契约的理由 (covers: design/D1, design/D7)
