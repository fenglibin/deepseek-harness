# 实施清单

## 1. 原语实现

- [ ] 1.1 新增 `packages/util/lazy-require/src/index.ts`，导出 `createLazyRequire<T>(specifier, parentURL)`，用 `createRequire(parentURL)` 建立调用方相对的解析基准 (covers: lazy-loading/解析基准来自调用方, design/D1)
- [ ] 1.2 loader 实现为闭包：首次调用才执行 `require(specifier)`，返回零参数函数 (covers: lazy-loading/首次调用才加载, design/D1)
- [ ] 1.3 只置位成功标志：成功后复用同一模块值，失败不写缓存，错误原样传播 (covers: lazy-loading/成功结果被复用, lazy-loading/失败的加载不被缓存, design/D2)
- [ ] 1.4 补 JSDoc（含 `@param`/`@returns`）与 `@typescript-eslint/no-unnecessary-type-parameters` 的窄例外注释，说明泛型参数用于保留调用方模块类型 (covers: lazy-loading/首次调用才加载, design/D1)

## 2. 单元测试

- [ ] 2.1 测试：构造 loader 时不加载依赖，首次调用加载并返回期望值，第二次调用返回同一对象且只加载一次 (covers: lazy-loading/首次调用才加载, lazy-loading/成功结果被复用)
- [ ] 2.2 测试：对缺失模块连续两次调用都抛出，且第二次仍是加载失败而非缓存失败 (covers: lazy-loading/失败的加载不被缓存)
- [ ] 2.3 补 `tests/fixtures/` 下的 CommonJS fixture，用全局计数证明加载次数 (covers: lazy-loading/成功结果被复用)

## 3. 依赖门禁

- [ ] 3.1 在 `collectRuntimeSourceExportUses()` 中遍历顶层 `ImportDeclaration`，收集 `@deepseek-ai/dsh-lazy-require` 的具名绑定与命名空间绑定 (covers: lazy-loading/具名绑定被识别为运行时依赖, lazy-loading/命名空间绑定被识别为运行时依赖, design/D3)
- [ ] 3.2 改写 `CallExpression` 分支：命中具名绑定或命名空间成员时把 `node.arguments[0]` 记为 `NAMESPACE_RUNTIME_EXPORT`，并保持 `import()`/`require()` 的既有行为不变 (covers: lazy-loading/具名绑定被识别为运行时依赖, lazy-loading/非惰性调用不被误判, design/D3)
- [ ] 3.3 扩展 `scripts/verify-package-dependencies.spec.ts` 的分类用例，覆盖重命名具名导入、命名空间导入与不相关调用三种输入 (covers: lazy-loading/命名空间绑定被识别为运行时依赖, lazy-loading/非惰性调用不被误判, design/D3)
- [ ] 3.4 把本包加入 `scripts/package-dependency-policy.ts` 的 `DUPLICATE_SAFE_PACKAGES`，并同步 spec 中的期望列表 (covers: lazy-loading/解析基准来自调用方, design/D1)

## 4. 包登记

- [ ] 4.1 新增 `package.json`：`@deepseek-ai/dsh-lazy-require`、ESM、`./src/*` 与 `./package.json` 导出、`@deepseek-ai/cordis` peer (covers: lazy-loading/包入口可在 workspace 内解析, design/D5)
- [ ] 4.2 新增 `tsconfig.json`：extends `tsconfig.base.json`，`rootDir: src`、`outDir: lib/types`，references 含 `../../runtime-diagnostics/invariants` (covers: lazy-loading/包入口可在 workspace 内解析, design/D4)
- [ ] 4.3 在 `tsconfig.base.json` 的 `paths` 加入 `@deepseek-ai/dsh-lazy-require`，在 `tsconfig.host.json` 的 references 加入该包 (covers: lazy-loading/包入口可在 workspace 内解析, design/D5)
- [ ] 4.4 在 `packages/util/README.zh.md` 的包表与 `docs/config-catalog.zh.md` 的库包索引加入本包 (covers: lazy-loading/包入口可在 workspace 内解析)

## 5. invariant 伴生件

- [ ] 5.1 新增 `src/invariant.ts`：空 installer + `No runtime invariant:` 说明（loader 无可独立观测的事件流或可变数据关系，缓存语义由单元测试断言） (covers: lazy-loading/空 invariant 伴生件带说明, design/D4)
- [ ] 5.2 在 `package.json` 声明 `./invariant` 导出、`files` 含 `lib/invariant.js`，并把 `@deepseek-ai/dsh-invariants` 声明为 `workspace:^` 的 peer 与 dev (covers: lazy-loading/空 invariant 伴生件带说明, design/D4)
- [ ] 5.3 运行 `verify-package-invariants` 确认本包通过 (covers: lazy-loading/空 invariant 伴生件带说明, design/D4)

## 6. 文档与清单

- [ ] 6.1 新增 `README.zh.md`：概述、用法、契约（caller-relative、只缓存成功）、「已知限制与延期工作」记录静态打包限制与仅限 CommonJS 依赖 (covers: lazy-loading/README 记录打包限制, design/D6)
- [ ] 6.2 在 `scripts/doc-standard.spec.ts` 的 `PACKAGE_LIBRARIES` 与 `scripts/verify-package-readme-model-experience.ts` 的 `SENTENCE_MODEL_EXPERIENCE` 加入本包条目 (covers: lazy-loading/README 记录打包限制)
- [ ] 6.3 重新生成 `docs/module-graph.zh.md`，把本包纳入 util 分组 (covers: lazy-loading/包入口可在 workspace 内解析)
- [ ] 6.4 在 `.agents/notes/implemented/process/2026-08-10-npm-release-sequences.zh.md` 补充惰性加载的适用边界与门禁识别关系 (covers: design/D3, design/D6)
