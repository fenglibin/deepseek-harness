# Agent Note: 按调用方解析的惰性加载原语

Status: implemented

## Problem

启动路径上被静态导入的原生依赖会在进程启动时付出初始化成本，即使当次运行从未使用该功能。`packages/attachment/attachment-local` 的静态 `import sharp` 就是这类：只要挂载该插件就加载原生模块，而许多会话从不处理图片。

本记录拥有工具本身与它的成本论证；把这些依赖逐项改为惰性加载所涉及的失败位置契约与适用范围判定，由[原生依赖改为按需加载](2026-09-15-deferred-native-dependency-loading.zh.md)拥有。

把这些依赖改成动态 `import()` 需要调用方自己写异步 factory，并在每个使用点处理 Promise——而真实的加载点是同步的。手工写成 `let cached` 加 `createRequire` 的模板会在每个消费方重复一遍，且容易写错解析基准。

## Decision

新增 `packages/util/lazy-require`，导出 `createLazyRequire<T>(specifier, parentURL)`：返回一个零参数 loader，首次调用执行 `createRequire(parentURL)(specifier)` 并缓存结果，后续调用返回同一实例。

两条契约是它的全部内容：**解析以调用方为基准**（`parentURL` 传调用方的 `import.meta.url`，使发布后仍是 package 局部解析，而不是落到仓库根被提升的 `node_modules`），以及**只缓存成功结果**（加载抛错时不置位，使安装修复后可以重试）。

配套在 `scripts/verify-package-dependencies.ts` 的 `collectRuntimeSourceExportUses` 中增加识别：先扫描该模块的顶层 import 记录 `createLazyRequire` 的本地别名与命名空间绑定，再在调用点识别 `lazy('x', import.meta.url)` 与 `lazyModule.createLazyRequire('x', …)`，把第一个字面量实参登记为 namespace 运行时导出使用。该使用随后被归类到 `dependencies`。

这条识别是整套机制成立的前提：它让「依赖声明位置」与「依赖加载时机」解耦——被 `createLazyRequire` 引用的依赖仍必须声明在 `dependencies`，延迟的只是加载。

## 曾考虑的替代方案

**让每个消费方自己写 `createRequire` 加缓存模板。** 不予采用：模板会在每个消费方重复，且 `createRequire` 的基准参数是最容易写错的一环。

**用动态 `import()` 而不引入本包。** 不予采用：`import()` 是异步的，而实际的加载点是同步的；调用方要在每个使用点引入 Promise，而那正是要消除的复杂度。

**缓存失败结果以避免重复尝试。** 不予采用：失败通常源于安装或环境问题，缓存它会让一次瞬时失败永久化。

**让 loader 接受表达式 specifier 以便动态拼接。** 不予采用：依赖识别依赖字面量，接受表达式会让 `verify-package-dependencies` 无法静态判定该依赖是否存在。

## Consequences

消费方保留 type-only 导入引用依赖类型，把 `createLazyRequire` 声明在模块作用域，并只在真正的操作处调用返回的 loader，从而把初始化成本从启动路径移到首次使用。

代价有三。其一，包的依赖声明必须保留在 `dependencies`——延迟加载不改变必要性判断。其二，WebWorker 的静态 packer 无法发现只在调用中命名的依赖，因此 Preview image 使用的包需要另有一条受支持的字面量请求保持可达；该限制写入包 README 的已知限制。其三，loader 的缓存是每个 loader 闭包一份，因此同一 specifier 在两个模块中各声明一次会各自持有一份缓存；由于 `require` 自身有模块级缓存，这不造成重复初始化。

## Testing

`packages/util/lazy-require/tests/index.spec.ts` 两条用例：首次调用加载 fixture 并通过计数器确认只加载一次、后续调用返回同一对象；对一个不存在的 specifier 连续两次调用都抛错，证明失败未被缓存。

`scripts/verify-package-dependencies.spec.ts` 在既有的运行时导出识别用例中加入具名别名与命名空间两种绑定形态，并断言两者都被识别为运行时依赖。
