# startup-performance 规范增量

## ADDED Requirements

### Requirement: 附件原生栅格依赖按需加载

`@deepseek-ai/dsh-attachment-local` SHALL 经 `createLazyRequire` 在首次栅格操作时加载 `sharp`，MUST NOT 在模块加载期静态导入其值。

`src/encoding.ts` SHALL 保持 type-only 导入不变。

#### Scenario: 挂载附件后端不加载 Sharp

- **WHEN** 一个进程只加载 `@deepseek-ai/dsh-attachment-local` 而不执行任何栅格操作
- **THEN** `sharp` SHALL NOT 被加载
- **AND** 其原生绑定初始化 SHALL NOT 发生

#### Scenario: 首次栅格操作加载 Sharp

- **WHEN** 一次 `probeImage`、`detectImage` 或 `normalizeImage` 调用被执行
- **THEN** `sharp` SHALL 在该操作内被加载
- **AND** 后续操作 SHALL 复用同一模块值

### Requirement: 原生加载失败不被误分类

原生依赖加载失败 SHALL 原样传播给调用方，MUST NOT 被重包装为 `AttachmentError`。

该约束适用于 `probeImage`、`detectImage` 与 `normalizeImage` 三个入口。

#### Scenario: 探测图片时加载失败原样传播

- **WHEN** `requireSharp()` 抛出且 `probeImage` 或 `detectImage` 被调用
- **THEN** 该错误 SHALL 原样传播
- **AND** SHALL NOT 被分类为 `INVALID_IMAGE` 或任何"图片数据无效"错误

#### Scenario: 规范化时加载失败原样传播

- **WHEN** `requireSharp()` 抛出且 `normalizeImage` 被调用
- **THEN** 该错误 SHALL 原样传播
- **AND** SHALL NOT 被分类为 `ATTACHMENT_WRITE_FAILED` 或任何"编码失败"错误

### Requirement: Win32 原生绑定按需加载

`@deepseek-ai/dsh-win32-process`、`@deepseek-ai/dsh-sandbox-windows-acl` 与 `@deepseek-ai/dsh-subprocess-local` SHALL 经 `createLazyRequire` 在首次 Win32 原生操作时加载 `koffi`，MUST NOT 在模块加载期静态导入其值或在模块作用域调用其类型构造。

Koffi 指针与结构体类型 SHALL 在首次使用时物化并缓存。

#### Scenario: 加载 Win32 包不加载 Koffi

- **WHEN** 一个进程只加载 `@deepseek-ai/dsh-win32-process` 而不执行 Win32 调用
- **THEN** `koffi` SHALL NOT 被加载
- **AND** Koffi 的进程级类型名 SHALL NOT 被注册

#### Scenario: 首次 Win32 调用物化类型

- **WHEN** 一次需要原生绑定的 Win32 操作被执行
- **THEN** `koffi` SHALL 被加载
- **AND** 指针与结构体类型 SHALL 被物化并缓存
- **AND** ABI 布局断言 SHALL 仍然生效

### Requirement: 终端原生依赖按需加载

`@deepseek-ai/dsh-subprocess-local` SHALL 经 `createLazyRequire` 在首次 PTY 终端操作时加载 `node-pty`。`@deepseek-ai/dsh-terminal-bash` SHALL 用 `createLazyRequire` 取代 `createRequire` 手写加载 `@xterm/headless`。

#### Scenario: 加载 subprocess-local 不加载 node-pty

- **WHEN** 一个进程只加载 `@deepseek-ai/dsh-subprocess-local` 而不创建 PTY 终端
- **THEN** `node-pty` SHALL NOT 被加载

#### Scenario: 加载 terminal-bash 不加载 headless 模拟器

- **WHEN** 一个进程只加载 `@deepseek-ai/dsh-terminal-bash` 而不构造 `LocalPtySession`
- **THEN** `@xterm/headless` SHALL NOT 被加载

### Requirement: 延迟加载不改依赖必要性

被延迟加载的原生依赖 SHALL 保留在 `dependencies` 中，MUST NOT 移入 `optionalDependencies`。延迟加载只改变加载时机，不改变依赖必要性。

#### Scenario: 原生依赖留在 dependencies

- **WHEN** 检查改造后各包的 `package.json`
- **THEN** `sharp`、`koffi`、`node-pty`、`@xterm/headless` SHALL 仍在 `dependencies`
- **AND** `@deepseek-ai/dsh-lazy-require` SHALL 被声明为 `workspace:^` 依赖

#### Scenario: 惰性 specifier 被门禁识别为运行时依赖

- **WHEN** `verify-package-dependencies` 检查含 `createLazyRequire('sharp', import.meta.url)` 的源文件
- **THEN** 该 specifier SHALL 被识别为运行时依赖
- **AND** 依赖门禁 SHALL 通过

### Requirement: 本地启动期堆水位机制保持原样

本变更 MUST NOT 改动 `packages/api/session-controller/src/heap-watch.ts`、三个 `heapWatch*` 配置项，或 `run.sh` 中的堆上限与近限快照注释。

#### Scenario: 堆水位配置与 run.sh 不被改动

- **WHEN** 本变更实施完成后检查 `packages/api/session-controller` 与 `run.sh`
- **THEN** `heap-watch.ts` SHALL 未被修改
- **AND** `heapWatchIntervalMs`、`heapWatchWarnRatio`、`heapWatchSnapshotNearLimit` SHALL 保持原有语义
- **AND** `run.sh` 中关于不使用 `--heapsnapshot-near-heap-limit` 的说明 SHALL 保留

### Requirement: 语料豁免条目按实测复核

`packages/experimental/webworker-runtime/tests/compile/transform-corpus-check.ts` 中 `packages/subprocess/win32-process/lib/index.js` 的 `BASELINE_EXEMPT` 条目 SHALL 在改造后的构建产物上实测复核。

条目仍必要时 SHALL 保留并更新其注释；不再必要时 SHALL 删除。

#### Scenario: koffi 语料豁免按实测决定

- **WHEN** 本变更的源码改造完成且构建产物重建后运行该语料检查
- **THEN** 该条目的必要性 SHALL 由实测结果决定
- **AND** SHALL NOT 仅因上游删除了该条目而删除
