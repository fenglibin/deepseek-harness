# 增加 caller-relative 惰性加载原语

## 为什么

本地启动路径上挂着若干兼容 CommonJS 的原生 Host 依赖：`sharp`、`koffi`、`node-pty`、`@xterm/headless`。它们目前都以静态值导入进入模块图，因此只要加载所属插件就付原生绑定初始化代价，即使该进程从不执行对应的栅格、终端或 Win32 操作。

官方提交 `eb8cc594b3`（`feat(util): add caller-relative lazy require`）新增 `packages/util/lazy-require`，把这种加载推迟到首次使用。本变更移植该原语本身；消费方改造见变更 `add-deferred-native-dependency-loading`。

本地 `packages/util/` 下没有该包。更关键的是本地 `scripts/verify-package-dependencies.ts` 的 `collectRuntimeSourceExportUses()` 只把 `import`、`export`、`import()` 与 `require()` 视为运行时依赖来源，`createLazyRequire('sharp', import.meta.url)` 的字面量实参不在其中。缺了这一步识别，延迟加载会被门禁判成"该依赖未被使用"，从而把必需的 Host 依赖从 `dependencies` 里剔除——所以门禁增强必须先于消费方改造落地。

## 做什么

新增 `packages/util/lazy-require`，导出 `createLazyRequire<T>(specifier, parentURL)`：

- 用 `node:module` 的 `createRequire(parentURL)` 建立调用方相对的解析基准
- 返回零参数 loader，首次调用才执行 `require(specifier)`
- 只缓存成功结果；失败的加载不缓存，安装修复后同进程内可重试
- 增强 `scripts/verify-package-dependencies.ts`：从 `@deepseek-ai/dsh-lazy-require` 的 import 声明收集具名绑定与命名空间绑定，在 `CallExpression` 分支命中时把首个实参记为 `NAMESPACE_RUNTIME_EXPORT`
- 完成包登记：`tsconfig.base.json` 的 paths、`tsconfig.host.json` 的 references、`packages/util/README.zh.md` 的包表、`docs/config-catalog.zh.md` 的库包索引，以及 `doc-standard` 与 `verify-package-readme-model-experience` 的清单
- 按本地规则发布 `./invariant` 伴生入口（空 installer + `No runtime invariant:` 说明）
- 本包列入 `scripts/package-dependency-policy.ts` 的 `DUPLICATE_SAFE_PACKAGES`

## 不做什么

- 不做异步加载：只支持兼容 CommonJS 的依赖；仅 ESM 的 package 需要由调用方拥有的异步 factory
- 不做失败回退：加载失败原样抛出，不静默降级，也不把失败写进缓存
- 不改 `packages/util/` 下的其他包
- 不改 WebWorker 静态打包器：仅在 `createLazyRequire()` 调用中命名的依赖仍不被静态发现，这条限制记入包 README 的「已知限制与延期工作」
- 不引入英文 `README.md` 与 `README.i18n.yaml`：本地 fork 只有 `README.zh.md` 单语页，也没有 `*.i18n.yaml` 配对体系
- 不改 `packages/AGENTS.md` 的 invariant 规则：本包按现有规则补空伴生件，而不是为它开例外

## 影响

- 新增包 `packages/util/lazy-require`：`package.json`、`tsconfig.json`、`src/index.ts`、`src/invariant.ts`、`tests/`、`README.zh.md`
- `tsconfig.base.json`、`tsconfig.host.json`：新增 path 与 project reference
- `scripts/verify-package-dependencies.ts` 及其 spec：新增 AST 识别与期望值
- `scripts/package-dependency-policy.ts`：本包列入 `DUPLICATE_SAFE_PACKAGES`
- `scripts/doc-standard.spec.ts`、`scripts/verify-package-readme-model-experience.ts`：新增清单条目
- `packages/util/README.zh.md`、`docs/config-catalog.zh.md`、`docs/module-graph.zh.md`：新增包登记
- `.agents/notes/implemented/process/2026-08-10-npm-release-sequences.zh.md`：补充惰性加载的适用边界

新增包入口与依赖门禁的 AST 识别属于结构契约变更（l2）。
