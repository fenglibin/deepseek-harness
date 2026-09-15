# 实施清单

前置：本变更依赖 `add-lazy-require-utility` 提供的 `@deepseek-ai/dsh-lazy-require`。

## 1. attachment-local 的 Sharp 延迟加载

- [ ] 1.1 新增 `packages/attachment/attachment-local/src/sharp.ts`：`import type sharp from 'sharp'` 加 `export const requireSharp = createLazyRequire<typeof sharp>('sharp', import.meta.url)` (covers: startup-performance/挂载附件后端不加载 Sharp, design/D1)
- [ ] 1.2 `src/image.ts` 改为 `import type { Sharp } from 'sharp'`，加 `import { requireSharp } from './sharp.ts'`，在 `probeImage` 与 `detectImage` 的 `try` 之前取 `const sharp = requireSharp()` (covers: startup-performance/首次栅格操作加载 Sharp, startup-performance/探测图片时加载失败原样传播, design/D1)
- [ ] 1.3 `src/normalization.ts` 改为 type-only 导入，`preparedPipeline()` 增加首个参数 `sharp: ReturnType<typeof requireSharp>`，在 `normalizeImage` 的 `try` 之前取 `const sharp = requireSharp()` 并传入 (covers: startup-performance/规范化时加载失败原样传播, design/D1)
- [ ] 1.4 `src/request-image.ts` 改为 type-only 导入，在 `sourcePipeline()` 内取 `const sharp = requireSharp()` (covers: startup-performance/首次栅格操作加载 Sharp, design/D2)
- [ ] 1.5 保持 `src/encoding.ts` 的 `import type { Sharp } from 'sharp'` 不变 (covers: startup-performance/挂载附件后端不加载 Sharp, design/D2)
- [ ] 1.6 `package.json` 的 `dependencies` 加入 `@deepseek-ai/dsh-lazy-require`，`sharp` 保留在 `dependencies` (covers: startup-performance/原生依赖留在 dependencies, design/D3)
- [ ] 1.7 `tsconfig.json` 的 references 加入 `../../util/lazy-require` (covers: startup-performance/惰性 specifier 被门禁识别为运行时依赖)
- [ ] 1.8 新增 `tests/lazy-sharp-failure.spec.ts`：用 `vi.mock('../src/sharp.ts', ...)` 让 `requireSharp` 抛出，断言 `probeImage`、`detectImage`、`normalizeImage` 都以 `rejects.toBe` 原样传播该错误 (covers: startup-performance/探测图片时加载失败原样传播, startup-performance/规范化时加载失败原样传播, design/D1)

## 2. win32-process 的 Koffi 延迟加载

- [ ] 2.1 新增 `packages/subprocess/win32-process/src/koffi.ts`：导出 `type Koffi = typeof koffi` 与 `requireKoffi` (covers: startup-performance/加载 Win32 包不加载 Koffi, design/D4)
- [ ] 2.2 `src/ffi.ts` 移除 `import koffi from 'koffi'`，把 `PVOID`/`PPVOID`/`STARTUPINFOW`/`PROCESS_INFORMATION` 收进惰性物化的类型缓存函数，ABI 布局断言随之移入 (covers: startup-performance/首次 Win32 调用物化类型, design/D4)
- [ ] 2.3 `src/ffi.ts` 导出 `startupInfoType()` 与 `processInformationType()` 取代原先直接导出的结构体常量，并把各调用点改为 `requireKoffi().<method>` (covers: startup-performance/首次 Win32 调用物化类型, design/D4)
- [ ] 2.4 `src/process.ts` 移除静态 `koffi` 导入，各调用点改用 `requireKoffi()` (covers: startup-performance/首次 Win32 调用物化类型, design/D4)
- [ ] 2.5 `package.json` 加 `@deepseek-ai/dsh-lazy-require` 依赖、`tsconfig.json` 加 project reference；`koffi` 保留在 `dependencies` (covers: startup-performance/原生依赖留在 dependencies, design/D3)
- [ ] 2.6 更新 `tests/ffi.spec.ts`、`tests/process.spec.ts`、`tests/ordinary-process.spec.ts`、`tests/process-allocation-failure.spec.ts`、`tests/process-failure-paths.spec.ts` 以适配惰性类型访问器 (covers: startup-performance/首次 Win32 调用物化类型)

## 3. sandbox-windows-acl 的 Koffi 延迟加载

- [ ] 3.1 `src/ffi.ts` 移除静态 `koffi` 导入，改为 `type Koffi = typeof import('koffi')['default']` 加 `createLazyRequire<Koffi>('koffi', import.meta.url)`，并把 `PVOID`/`PPVOID` 收进缓存的 `ffiTypes()` (covers: startup-performance/加载 Win32 包不加载 Koffi, design/D4)
- [ ] 3.2 各 `koffi.encode/address/alloc/decode` 调用点改为 `requireKoffi().<method>` (covers: startup-performance/首次 Win32 调用物化类型, design/D4)
- [ ] 3.3 `package.json` 加依赖、`tsconfig.json` 加 reference；`tests/index-failure-paths.spec.ts` 的 `PROCESS_INFORMATION` 引用改为 `processInformationType()` (covers: startup-performance/首次 Win32 调用物化类型)

## 4. subprocess-local 的 Koffi 与 node-pty 延迟加载

- [ ] 4.1 `src/index.ts` 把 `import * as nodePty from 'node-pty'` 改为 `import type * as NodePty`，加 `createLazyRequire<typeof NodePty>('node-pty', import.meta.url)`，PTY 分支改用 `requireNodePty().spawn(...)` (covers: startup-performance/加载 subprocess-local 不加载 node-pty, design/D4)
- [ ] 4.2 `src/windows-inspector.ts` 移除静态 `koffi` 导入，改为惰性 loader，把 `PVOID` 与结构体收进 `win32Structs()` 的缓存返回值 (covers: startup-performance/首次 Win32 调用物化类型, design/D4)
- [ ] 4.3 `package.json` 加依赖、`tsconfig.json` 加 reference；`koffi` 与 `node-pty` 保留在 `dependencies` (covers: startup-performance/原生依赖留在 dependencies, design/D3)
- [ ] 4.4 更新 `tests/local.spec.ts`：把 `vi.doMock('node-pty', ...)` 改为 mock `@deepseek-ai/dsh-lazy-require` 的 `createLazyRequire`，并同步 afterEach 的 `doUnmock` (covers: startup-performance/加载 subprocess-local 不加载 node-pty)
- [ ] 4.5 不引入 `src/linux-execve.ts`：本地该包无此文件，官方该处改动不适用 (covers: design/D4)

## 5. terminal-bash 的 headless 模拟器延迟加载

- [ ] 5.1 `src/session.ts` 移除 `createRequire` 手写加载，改为 `createLazyRequire<typeof import('@xterm/headless')>('@xterm/headless', import.meta.url)`，在 `LocalPtySession` 构造函数内取 `const { Terminal: HeadlessTerminal } = requireHeadless()` (covers: startup-performance/加载 terminal-bash 不加载 headless 模拟器, design/D4)
- [ ] 5.2 `package.json` 加 `@deepseek-ai/dsh-lazy-require` 依赖、`tsconfig.json` 加 reference；`@xterm/headless` 保留在 `dependencies` (covers: startup-performance/原生依赖留在 dependencies, design/D3)
- [ ] 5.3 不移植官方对 `src/index.ts` 启动清理路径的重构：它与延迟加载无关，属独立变更 (covers: design/D6)

## 6. 验证与复核

- [ ] 6.1 逐包运行受影响测试：`attachment-local`、`win32-process`、`sandbox-windows-acl`、`subprocess-local`、`terminal-bash` (covers: startup-performance/探测图片时加载失败原样传播, startup-performance/首次 Win32 调用物化类型)
- [ ] 6.2 运行 `verify-package-dependencies`，确认各包经惰性 specifier 仍保留必需依赖 (covers: startup-performance/惰性 specifier 被门禁识别为运行时依赖, design/D3)
- [ ] 6.3 在重建产物后实测 `transform-corpus-check.ts` 中 `win32-process` 的 `BASELINE_EXEMPT` 条目，按结果保留并更新注释或删除 (covers: startup-performance/koffi 语料豁免按实测决定, design/D6)
- [ ] 6.4 断言启动路径不再加载原生模块：以加载顺序或模块解析断言验证挂载 `attachment-local` 不触发 `sharp` 加载 (covers: startup-performance/挂载附件后端不加载 Sharp)
- [ ] 6.5 确认 `heap-watch.ts`、三个 `heapWatch*` 配置项与 `run.sh` 未被本变更改动 (covers: startup-performance/堆水位配置与 run.sh 不被改动, design/D5)
- [ ] 6.6 同步受影响包的 `README.zh.md` 与 JSDoc 契约，并新增 Agent Note 记录适用性判定与拒绝项 (covers: design/D4, design/D5, design/D6)
