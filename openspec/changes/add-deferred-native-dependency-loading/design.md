# 技术决策

官方提交 `232ab768a9` 展开为 45 个文件（+375/−147）。本文件记录决策编号，供 tasks.md 锚定；适用性判定见 D4 与「被拒绝的方案」。

### D1 加载失败必须在错误重包装之前发生

`probeImage`、`detectImage`、`normalizeImage` 三个入口各自都有 `catch`，把非 `AttachmentError` 的异常重包装为 `AttachmentError`：

- `probeImage` 抛出 `INVALID_IMAGE`「Unsupported or malformed image data.」
- `detectImage` 在解码失败时走同一分类
- `normalizeImage` 抛出 `ATTACHMENT_WRITE_FAILED`「could not be converted to the normalized 8-bit sRGB form」

改造前 `import sharp` 在模块加载期失败，错误落在插件加载路径，不经过这些 `catch`。改造后失败发生在函数体内，若把 `const sharp = requireSharp()` 放进 `try`，缺失的原生绑定会被报成"图片数据无效"，把用户引向排查图片而不是排查安装。

因此 `requireSharp()` 的调用点落在 `try` **之外**，加载失败原样传播。`normalization.ts` 的 `preparedPipeline()` 额外把 `sharp` 作为参数传入（官方做法），使该函数在取到 loader 结果之后才被调用，调用点同样留在 `try` 之外。

### D2 `encoding.ts` 不动

`packages/attachment/attachment-local/src/encoding.ts:3` 是 `import type { Sharp } from 'sharp'`，type-only 导入不进入运行时模块图，不产生加载代价。改造它没有收益，只会增加改动面。

同理，`normalization.ts` 与 `image.ts` 保留 type-only 的 `Sharp` 导入用于签名标注，只有**值**导入被移除。

### D3 `sharp` 留在 `dependencies`

官方 `package.json` 的 `dependencies` 为 `@deepseek-ai/dsh-lazy-require`、`@deepseek-ai/schemastery`、`sharp: ^0.35.3`——`sharp` 没有被移入 `optionalDependencies`。

延迟加载改变的是**加载时机**，不是**依赖的必要性**。缺了 `sharp`，图片附件功能整体不可用，这是必需依赖缺失，不是可选能力降级。把它标成 optional 会让安装静默成功、故障推迟到运行时，与仓库"错误配置要大声失败"的立场相反。

### D4 适用范围按本地包清单逐项判定

官方该提交触及 7 个包（`api/terminal-controller`、`attachment/attachment-local`、`sandbox/sandbox-windows-acl`、`subprocess/subprocess-local`、`subprocess/win32-process`、`terminal/terminal-bash`，以及 `util/lazy-require` 的文档）与 `benchmarks/`、`docs/module-graph*`、`pnpm-lock.yaml`、`experimental/webworker-runtime` 测试等非包位置。本地判定：

**适用**（本地存在对应静态导入或等价手写逻辑）：

- `packages/attachment/attachment-local`：三处 `sharp` 静态值导入，且该包被 `cordis.patch.yml:164` 默认挂载于启动路径
- `packages/subprocess/win32-process`：`src/ffi.ts:3` 与 `src/process.ts:3` 静态导入 `koffi`；`src/ffi.ts:12-13` 在模块作用域调用 `koffi.pointer()`，改造后需把 `PVOID`/`PPVOID`/`STARTUPINFOW`/`PROCESS_INFORMATION` 收进惰性物化的类型缓存
- `packages/sandbox/sandbox-windows-acl`：`src/ffi.ts:3` 静态导入 `koffi`，`src/ffi.ts:26-27` 同样是模块作用域的 `koffi.pointer()`
- `packages/subprocess/subprocess-local`：`src/index.ts:15` 是 `import * as nodePty from 'node-pty'`；`src/windows-inspector.ts:13` 静态导入 `koffi` 且 `:183` 在模块作用域调用 `koffi.pointer('void')`
- `packages/terminal/terminal-bash`：`src/session.ts:29` 用 `createRequire(import.meta.url)('@xterm/headless')` 手写等价逻辑，改造后换成 `createLazyRequire`

**不适用**：

- `packages/api/terminal-controller`：本地没有该包（本地 `packages/api/` 只有 `gateway`、`remotes`、`session-controller`、`settings-controller`、`workspace-controller`）。官方该文件是把包内手写的 `loadXterm()` 换成 `createLazyRequire`，本地没有对应代码
- `packages/subprocess/subprocess-local/src/linux-execve.ts`：本地没有该文件（本地该包 src 只有 `index.ts`、`invariant.ts`、`process-inspector.ts`、`spawn.ts`、`terminal.ts`、`windows-inspector.ts`）
- `benchmarks/package.json`：本地没有 `benchmarks/` 目录
- `docs/module-graph.md`、`docs/module-graph.i18n.yaml`、`packages/util/lazy-require/README.md`、`packages/util/lazy-require/README.i18n.yaml`：本地是中文单语 fork，没有英文 README 与 `*.i18n.yaml` 配对体系。`docs/module-graph.zh.md` 由 `pnpm run gen-module-graph` 生成，登记新包时重新生成
- `pnpm-lock.yaml`：由 `pnpm install` 重新生成

`packages/experimental/webworker-runtime/tests/compile/transform-corpus-check.ts` 单独说明，见「被拒绝的方案」。

### D5 本地既有启动期堆水位机制保持原样

本地已有一套官方**没有**的启动期可观测性：

- `packages/api/session-controller/src/heap-watch.ts`（156 行）
- 配置项 `heapWatchIntervalMs`、`heapWatchWarnRatio`、`heapWatchSnapshotNearLimit`（`packages/api/session-controller/src/index.ts:96-106`、`:136-138`）
- `run.sh` 中显式设置 `--max-old-space-size=12288` 并说明为何**不**加 `--heapsnapshot-near-heap-limit`

官方全仓的 `max-old-space-size` 只出现在 benchmark 与 ptc-runtime 测试中，没有对应的生产级堆水位机制。本变更只推迟原生模块加载，与堆水位无关，因此这些文件一字不动。

值得注意的是两者方向一致：本地明确拒绝近限快照，理由是"把一次留下 FATAL ERROR 与水位的崩溃，变成既不留错误也不留水位的无界停顿"。延迟加载减少的是启动期的原生初始化开销，同样属于"不制造停顿"这一类。

### D6 只移植与延迟加载直接相关的改动

官方该提交还顺带改了 `packages/terminal/terminal-bash/src/index.ts` 的启动失败清理路径：把 `createSession()` 包进 `try`，失败时先 `terminal.terminate()` 再抛出，并抽出 `rejectAfterStartupCleanup()` 保证未发布资源到达静止后才拒绝。本地该文件是旧版（`spawn` 里直接 `createSession` 然后 `try` startup）。

这项改动与延迟加载无关，它是"启动失败时未发布的 PTY 也要回收"的独立健壮性修复，本地若要引入应作为独立变更评估，理由是它改变的是失败路径的资源所有权，而不是加载时机。本变更不夹带它。

同理，官方新增的 `tests/lazy-sharp-failure.spec.ts` 中 `normalizeImage` 用例传入了 `depth: 'ushort'` 的 PNG 事实，用于触发编码路径。本地 `normalizeImage` 的签名与 `DetectedImage` 字段与官方一致，用例可照搬。

## 被拒绝的方案

**把 `packages/experimental/webworker-runtime/tests/compile/transform-corpus-check.ts` 的 `koffi` 条目一并删除**：官方删除它，是因为改造后 `win32-process` 不再在模块加载期注册 koffi 类型名，第二次加载不再冲突。本地该文件确实有同一行 `['packages/subprocess/win32-process/lib/index.js', 'koffi type-name collision on a second load']`，但**能否删除取决于改造后该冲突是否真的消失**——而该语料检查扫的是构建产物 `lib/`，必须在本变更的源码改造完成、产物重建后实测确认。因此本变更把它列为待验证项：先按 D4 完成改造，再实测该条目是否仍必要，必要则保留并更新注释，不必要才删除。凭官方删了就跟着删，会把一条真实存在的豁免改成静默失效。

**把 `sharp` 移到 `optionalDependencies`**：与 D3 冲突。

**把 `requireSharp()` 放进既有 `try`**：与 D1 冲突，会把环境故障误报为数据故障。

**顺带移植 `terminal-bash` 的启动清理重构**：与 D6 冲突，属于另一个变更。

**覆盖或替换本地 `heap-watch` 与 `run.sh` 的堆策略**：与 D5 冲突。官方没有对应机制，无从"移植"。

**以 benchmark 数字论证收益**：本地没有 `benchmarks/` 基础设施，且该提交的收益来自"启动路径不再加载原生模块"这一加载顺序事实，可在改造后用加载顺序断言验证，不需要引入 benchmark 目录。
