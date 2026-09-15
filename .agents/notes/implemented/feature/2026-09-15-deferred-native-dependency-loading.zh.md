# Agent Note: 原生依赖改为按需加载

Status: implemented

## Problem

启动路径上挂着的原生模块把初始化成本无条件付掉，即使当次运行从不使用该能力：`packages/attachment/attachment-local` 被 `cordis.patch.yml` 默认挂载，它的 `image.ts`、`normalization.ts`、`request-image.ts` 都在模块求值期静态导入 `sharp` 的值；同类问题存在于 `koffi`（`subprocess/win32-process`、`sandbox/sandbox-windows-acl`、`subprocess/subprocess-local`）、`node-pty`（`subprocess-local`）与 `@xterm/headless`（`terminal/terminal-bash`，此处更糟——它是手写的 `createRequire` 模板，把加载基准与缓存各写了一遍）。

[按调用方解析的惰性加载原语](2026-09-15-caller-relative-lazy-require.zh.md)提供了工具与成本论证；本记录拥有的是把它落到这些具体依赖上的决策：失败位置契约、Koffi 类型注册的惰性化、以及本地适用范围的逐项判定。

## Decision

用 `@deepseek-ai/dsh-lazy-require` 的 `createLazyRequire` 把这些**值**导入改为首次使用时的加载，依赖声明位置与必要性判断都不动。

一项决策不能只靠代码本身表达，因此单独记下来：

**加载失败必须发生在错误重包装之前。** `probeImage`、`detectImage`、`normalizeImage` 三个入口各自都有 `catch`，把非 `AttachmentError` 的异常重包装为 `AttachmentError`。改造前 `import sharp` 在模块加载期失败，错误落在插件加载路径，不经过这些 `catch`；改造后失败发生在函数体内，若把 `requireSharp()` 写进 `try`，缺失的原生绑定会被报成 `INVALID_IMAGE`「图片数据无效」，把用户引向排查图片而不是排查安装——一个环境故障被伪装成数据故障。因此三处调用点都落在 `try` 之外，`normalization.ts` 的 `preparedPipeline()` 额外把 loader 结果作为首个参数传入，使取值发生在调用它之前；该取值又放在 `canPassThroughNormalization()` 早返回之后，因为直通路径不需要原生栅格能力。

**Koffi 的类型注册必须惰性化，而不只是绑定惰性化。** `win32-process` 与 `sandbox-windows-acl` 原先在模块作用域调用 `koffi.pointer()` / `koffi.struct()`。Koffi 的类型注册表是进程级全局的，因此模块作用域注册会产生第二个后果：测试运行器或语料清扫重复求值该模块时，第二次注册同名类型会失败。类型与绑定一起收进带缓存的 `win32Types()` / `ffiTypes()`，两者都在首次原生操作时才物化。

## 曾考虑的替代方案

**把 `sharp`、`koffi`、`node-pty` 移入 `optionalDependencies`。** 不予采用：延迟加载改变的是加载时机，不是必要性。缺了 `sharp`，图片附件功能整体不可用，那是必需依赖缺失，不是可选能力降级。标成 optional 会让安装静默成功、故障推迟到运行时，与「错误配置要大声失败」相反。

**逐个消费方自己写 `createRequire` 加缓存模板。** 不予采用：`@xterm/headless` 那处手写模板正是反面样本，且基准参数最容易写错。

**保留 `win32-process` 导出的 `STARTUPINFOW` / `PROCESS_INFORMATION` 常量。** 不予采用：它们必须在首次原生操作时才存在，因此改为 `startupInfoType()` / `processInformationType()` 访问器。这是破坏性导出变更，全部引用点在同一次改动中更新。

**只做延迟加载，不顺带修 `terminal-bash` 的启动失败清理。** 最终一并移植了：`createSession()` 抛错时那条已经创建的 PTY 没有任何所有者回收它，会一直泄漏到进程退出；抽出 `rejectAfterStartupCleanup()` 后，两条失败路径统一在未发布资源到达静止后才拒绝，并保留 `TerminalBackendCleanupError` 聚合语义。它与延迟加载分属两个关注点，但落在同一文件与同一条启动路径上。

## Consequences

导入这些包不再加载对应的原生模块：实测模块图中 `sharp`、`koffi`、`node-pty`、`@xterm/headless` 均不再出现，各模块相应的原生初始化成本从启动路径移到首次使用。

代价有三。其一，依赖声明必须留在 `dependencies`，`verify-package-dependencies` 会把 `createLazyRequire('x', …)` 的第一个字面量实参识别为运行时依赖边。其二，`win32-process` 的 `STARTUPINFOW` / `PROCESS_INFORMATION` 由常量变为函数，属破坏性导出变更。其三，加载失败从加载期推迟到首次使用，因此错误必须原样传播而不是被分类重写——这正是上面那条决策要钉住的契约。

本地不适用上游的两处改动：`subprocess-local/src/linux-execve.ts` 与 `api/terminal-controller` 在本 fork 中不存在。

## Testing

`packages/attachment/attachment-local/tests/lazy-sharp-failure.spec.ts` 是位置契约的唯一守护者：mock `../src/sharp.ts` 让 `requireSharp` 抛出，断言 `probeImage`、`detectImage`、`normalizeImage` 三个入口都以 `rejects.toBe` 原样传播该错误——把调用点移进 `try` 会让这三条用例失败。

`terminal-bash/tests/index.spec.ts` 新增用例覆盖 `createSession()` 抛错时 `terminal.terminate()` 被调用，且拒绝发生在清理到达静止之后。

`utils/lazy-require` 与其余五个包的既有套件覆盖正常加载路径；`subprocess-local/tests/local.spec.ts` 的 node-pty 桩改 mock 惰性 helper，对未预期的惰性 specifier 直接抛错，避免测试静默拿到真实依赖。

`experimental/webworker-runtime/tests/compile/transform-corpus-check.ts` 的 `win32-process` 语料豁免条目按实测删除：改造后的构建产物在完整 279 文件语料清扫中可正常导入，条目触发 STALE EXEMPTION。
