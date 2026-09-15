# 延迟加载可选原生依赖

## 为什么

本地 `dsh web` 的启动路径上挂着原生模块，而它们的初始化代价被无条件支付：

- `packages/attachment/attachment-local` 被 `packages/bundle/base/cordis.patch.yml:164` 默认挂载。它的 `src/image.ts:3`、`src/normalization.ts:3`、`src/request-image.ts:6` 都是 `import sharp, { type Sharp } from 'sharp'`——静态值导入。`sharp` 是原生模块，于是每次启动都加载原生绑定，即使该进程从不做一次栅格操作。
- 同类问题存在于 `koffi`（`packages/subprocess/win32-process`、`packages/sandbox/sandbox-windows-acl`、`packages/subprocess/subprocess-local`）、`node-pty`（`packages/subprocess/subprocess-local/src/index.ts:15`）与 `@xterm/headless`（`packages/terminal/terminal-bash/src/session.ts:29` 用 `createRequire` 手写等价逻辑）。

官方提交 `232ab768a9`（`perf(runtime): defer optional native dependencies`）把上述加载点改为经 `createLazyRequire` 在首次使用时解析。本变更移植该改造，前置依赖是 `add-lazy-require-utility`。

改造后的失败语义必须被钉住：`sharp` 加载失败是一个**环境故障**，不能与"图片数据无效"或"编码失败"混为一谈。改造前 `import sharp` 在模块加载期失败，错误落在插件加载；改造后失败发生在 `probeImage`/`detectImage`/`normalizeImage` 内部，而这三个函数各自都有把异常重包装为 `AttachmentError` 的 `catch`。若不显式处理，缺失的原生绑定会被误报成"图片损坏"，把用户引向错误方向。

## 做什么

- 新增 `packages/attachment/attachment-local/src/sharp.ts`：`export const requireSharp = createLazyRequire<typeof sharp>('sharp', import.meta.url)`
- 把 `image.ts`、`normalization.ts`、`request-image.ts` 的 `sharp` 静态值导入改为 type-only，并在实际使用原生调用的函数体内取 `requireSharp()`
- 让 `requireSharp()` 的调用点落在既有 `try` **之外**，使加载失败原样传播，不被 `catch` 重包装为 `AttachmentError`
- `encoding.ts` 保持 `import type { Sharp } from 'sharp'` 不变（它只做类型标注）
- 新增 `tests/lazy-sharp-failure.spec.ts`，mock `../src/sharp.ts` 让 `requireSharp` 抛出，断言三个入口都原样传播该错误
- 对 `koffi`、`node-pty`、`@xterm/headless` 做同类改造（详见 design.md 的适用范围判定）
- 一并移植官方对 `terminal-bash` 启动失败清理路径的重构：`createSession()` 抛错时先 `terminal.terminate()` 回收那条尚未被任何会话拥有的 PTY（见 design.md 的 D6）
- `sharp` 保持在 `dependencies`，不移入 `optionalDependencies`：它是必需依赖，只是加载时机被推迟

## 不做什么

- 不改 `packages/api/terminal-controller`：本地没有该包（官方为新增包）
- 不改 `benchmarks/package.json`：本地没有 `benchmarks/` 目录
- `packages/experimental/webworker-runtime/tests/compile/transform-corpus-check.ts` 中 `koffi` 的 `BASELINE_EXEMPT` 条目按其必要性实测复核：改造后构建产物重建，完整 279 文件清扫报 `STALE EXEMPTION`（该条目只在文件仍无法导入时才合法），据此删除该条目及其顺序说明注释（详见 design.md 的 D6 与「被拒绝的方案」）
- 不改 `packages/subprocess/subprocess-local/src/linux-execve.ts`：本地没有该文件（本地该包只有 6 个 src 文件，无 `linux-execve.ts`）
- 不动本地既有的启动期堆水位机制：`packages/api/session-controller/src/heap-watch.ts` 与三个 `heapWatch*` 配置项、`run.sh` 中关于 `--heapsnapshot-near-heap-limit` 的注释都保持原样
- 不改 `tsconfig.host.json` 的 leaf 结构、不改任何包依赖形状（除新增 `@deepseek-ai/dsh-lazy-require`）
- 不引入性能基准：本地无 benchmark 基础设施，收益用既有启动路径的加载顺序论证

## 影响

- `packages/attachment/attachment-local`：新增 `src/sharp.ts` 与 `tests/lazy-sharp-failure.spec.ts`；改 `src/image.ts`、`src/normalization.ts`、`src/request-image.ts`、`package.json`、`tsconfig.json`
- `packages/subprocess/win32-process`：新增 `src/koffi.ts`；改 `src/ffi.ts`、`src/process.ts`、`package.json`、`tsconfig.json` 与 4 个测试
- `packages/subprocess/subprocess-local`：改 `src/index.ts`、`src/windows-inspector.ts`、`package.json`、`tsconfig.json` 与 `tests/local.spec.ts`
- `packages/sandbox/sandbox-windows-acl`：改 `src/ffi.ts`、`package.json`、`tsconfig.json` 与 `tests/index-failure-paths.spec.ts`
- `packages/terminal/terminal-bash`：改 `src/session.ts`（`@xterm/headless` 惰性加载）、`src/index.ts`（启动失败清理）、`package.json`、`tsconfig.json` 与 `tests/index.spec.ts`

原生依赖的加载时机属于启动路径契约变更（l2）。
