# 技术决策

官方提交 `eb8cc594b3` 展开为 24 个文件（+334/−10）。本文件记录决策编号，供 tasks.md 锚定。

### D1 解析基准由调用方传入，不由本包推断

`createLazyRequire` 接收调用方的 `import.meta.url` 并交给 `createRequire`，因此 specifier 解析发生在**调用方 package** 的解析路径上，而不是本包的。

这条契约是必需的：本包被列入 `DUPLICATE_SAFE_PACKAGES`，npm 可能为不同消费者安装多份副本。若由本包自行解析 specifier，依赖会按本包副本的位置解析，在重复安装下指向错误实例。官方 README 把这一点写成包契约的一部分，而不是实现细节。

### D2 只缓存成功的加载

loader 在首次调用时执行 `require(specifier)`，仅在成功后置位 `loaded`。失败不写缓存，因此同一次进程内重试会再次尝试解析。

理由：原生绑定的加载失败通常来自未完成的安装或缺失的平台二进制，是可以在不重启进程的情况下修复的部署状态。缓存失败会把一次瞬时故障固化成该进程的永久故障。

### D3 依赖门禁用 AST 识别惰性 specifier

`collectRuntimeSourceExportUses()` 新增两步。第一步遍历顶层语句，找出 `moduleSpecifier` 恰为 `@deepseek-ai/dsh-lazy-require` 的 `ImportDeclaration`，从 `namedBindings` 收集具名绑定（`createLazyRequire` 的本地别名）与命名空间绑定。第二步把原来"只认 `import()` 与 `require()`"的 `CallExpression` 分支改为先判断被调用者是否命中收集到的绑定，命中则把 `node.arguments[0]` 记为 `NAMESPACE_RUNTIME_EXPORT`。

不做字符串匹配：具名导入可以重命名（`import { createLazyRequire as lazy }`），命名空间导入可以改前缀（`lazyModule.createLazyRequire`），按名字面匹配会漏判，而漏判的后果是把必需依赖从 `dependencies` 中剔除。

### D4 本包发布空 invariant 伴生件

官方 `packages/util/lazy-require` 不发布 `./invariant` 入口，其 exports 只有 `.`、`./src/*`、`./package.json`，peerDependencies 只有 `@deepseek-ai/cordis`。

本地规则不同：`packages/AGENTS.md:19` 要求每个包拥有 `./invariant` 伴生入口，`scripts/package-invariants.ts` 强制 `exports["./invariant"]` 指向 `./lib/types/invariant.d.ts` 与 `./lib/invariant.js`、`files` 包含 `lib/invariant.js`、并声明 `@deepseek-ai/dsh-invariants` 的 `workspace:^` peer 与 dev。本地同类纯工具包一致采用"空 installer + `No runtime invariant:` 说明"的形态：`packages/util/values/src/invariant.ts`、`packages/util/time/src/invariant.ts`、`packages/util/launch-environment/src/invariant.ts` 三者都是如此，且都把 `../../runtime-diagnostics/invariants` 写进 tsconfig references。

本包的不变式说明：loader 只持有一个按 specifier 记忆化的成功值，没有可独立观测的事件流或可变数据关系，缓存语义由单元测试断言。因此本包照本地规则补空伴生件，而不是为它改规则。

### D5 依赖形状只保留 `@deepseek-ai/cordis` 与本地的 `@deepseek-ai/dsh-invariants`

官方包运行时零依赖，唯一的运行时 import 是 `node:module`。本地追加的 `@deepseek-ai/dsh-invariants` peer/dev 由 D4 决定。

本包**不**是 Cordis 插件：没有默认导出，也没有 `apply`，`src/index.ts` 只导出 `createLazyRequire`。`@deepseek-ai/cordis` 作为每个 harness package 的 peerDependency 保留，符合仓库约定。

### D6 WebWorker 静态打包的限制记入 README

静态打包器不发现仅在 `createLazyRequire()` 调用中命名的依赖。Preview image 使用的 package 必须让该依赖通过受支持的字面量请求保持可达，直到打包器能识别这个 helper。

这条限制写在 `README.zh.md` 的「已知限制与延期工作」，因为消费方改造会真实撞上它：`attachment-local` 的 `sharp` 改造后就不再有任何静态请求指向它。

## 被拒绝的方案

**在本包内自行解析 specifier**（即不接收 `parentURL`）：在重复安装下按本包副本的位置解析，与 D1 冲突。

**缓存失败结果**：把可修复的安装状态固化为永久故障，与 D2 冲突。

**用 `import()` 动态导入代替 `require`**：`import()` 是异步的，会把同步的栅格与原生调用点改成异步；对仅 ESM 的包它也不是解法，那条路径属于确实需要该包、并自行处理缺失的调用方。

**把门禁识别做成对 `createLazyRequire` 名字的字符串匹配**：见 D3 的漏判分析。

**照抄官方包形状（不发布 `./invariant`）**：会让 `verify-package-invariants` 在本地失败，且与本地同类包的处理方式不一致。
