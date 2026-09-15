---
description: "第三批上游能力移植方案：caller-relative 惰性加载原语及其依赖识别、原生依赖的延迟加载，以及本地 invariant 伴生规则带来的适配。"
kind: "design-draft"
---

# 第三批：启动性能移植方案

本批次移植官方仓库中 `lazy-require` 原语与原生依赖延迟加载。基线见[上游差异扫描分析](upstream-diff-analysis.zh.md)。所有官方提交 hash 均指官方仓库 `0a53fb55be..master` 区间。

## 1. 范围

| 项 | 官方证据 | 本地现状 | 改动量 |
|---|---|---|---|
| `lazy-require` 原包 | `eb8cc594b3` | `packages/util/` 下无该包 | 新增包（24 行实现 + 测试 + README） |
| 依赖识别增强 | `eb8cc594b3` | `scripts/verify-package-dependencies.ts` 只识别 `import()` 与 `require()` | 约 27 行 |
| 延迟 sharp | `232ab768a9` | `attachment-local` 三处静态值导入 | 约 70 行 |
| 延迟 koffi | 同上 | `win32-process`、`sandbox-windows-acl`、`subprocess-local` 模块作用域求值 | 约 190 行 |
| 延迟 node-pty | 同上 | `subprocess-local/src/index.ts` 静态导入 | 约 10 行 |
| 延迟 @xterm/headless | 同上 | `terminal-bash/src/session.ts` 用 `createRequire` 但模块作用域立即求值 | 约 60 行 |

## 2. 关键设计决策

### D1 惰性加载器只缓存成功结果

`createLazyRequire<T>(specifier, parentURL)` 返回零参数 loader：首次调用执行 `require` 并缓存，后续返回同一实例；**加载失败不缓存**，使安装修复后可重试。

`parentURL` 必须是调用方的 `import.meta.url`，使 `createRequire` 以调用方 package 为解析基准，保证发布后仍是 package 局部解析而非落到仓库根的提升 `node_modules`。

`specifier` 必须是字面量：依赖识别依赖它做静态判定。

### D2 依赖识别必须覆盖两种调用形态

`scripts/verify-package-dependencies.ts` 的 `collectRuntimeSourceExportUses()` 需要两处增强。

**函数头预扫描**：只认 specifier 恰为 `@deepseek-ai/dsh-lazy-require` 的顶层 import，同时记录两种绑定——命名导入的本地别名（`import { createLazyRequire as lazy }` 记录 `lazy`）与命名空间导入的名字（`import * as lazyModule` 记录 `lazyModule`）。

**CallExpression 分支**：识别 `lazy('x', import.meta.url)` 与 `lazyModule.createLazyRequire('x', …)`，把第一个实参登记为 namespace 运行时导出使用。该使用随后被归类到 `dependencies`。

**这是本批次的技术核心**：识别逻辑使被 `createLazyRequire` 引用的依赖继续留在 `dependencies`，从而**在不改变依赖声明位置的前提下**消除启动期的原生初始化。`sharp` 因此仍留在 `dependencies`，而不是移到 `optionalDependencies`。

### D3 本地 invariant 伴生规则是最大适配点

本地 `scripts/package-invariants.ts` 与官方策略不同：官方允许包省略伴生入口（靠 README 中一句被正则解析的理由），本地**无条件要求**每个包有 `src/invariant.ts`、`./invariant` 导出、`files` 条目、`@deepseek-ai/dsh-invariants` 的 peer 与 dev 依赖，以及 tsconfig 对 `runtime-diagnostics/invariants` 的引用。

本地全部 12 个 util 包都有伴生入口，本地 `util/launch-environment` 有该导出而官方同包没有，印证两侧策略确实不同。

**因此不能照抄官方的 `lazy-require/package.json`**，必须补齐伴生入口与其全部接线。这是本地与官方在本批次的主要分叉。

### D4 `requireSharp()` 必须在 `try` 之外

`packages/attachment/attachment-local` 的三处调用点（`image.ts` 的 `probeImage`/`detectImage`、`normalization.ts` 的 `normalizeImage`）都必须把 `const sharp = requireSharp()` 放在 **`try` 块之外**。

理由是错误分类：若放在 `try` 内，`require` 抛出的原生绑定错误会被 `catch` 吞掉并重新包装成 `AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE')`，把"sharp 装不上"误报成"图片损坏"。

`normalization.ts` 的 `preparedPipeline` 新增首个参数 `sharp: ReturnType<typeof requireSharp>`，把 loader 结果显式传入而非在函数体内调用——同样因为它被 `try` 块内的代码调用。同时 `requireSharp()` 放在 `canPassThroughNormalization` 早返回**之后**，使直通路径完全不需要 sharp。

官方新增的 `tests/lazy-sharp-failure.spec.ts` 是这一位置契约的唯一守护者：它把 `requireSharp` mock 成无条件抛错，断言三条路径都原样透传该错误。**移植时不能省略该测试。**

### D5 win32-process 的导出常量改为函数是破坏性变更

官方把 `packages/subprocess/win32-process/src/ffi.ts` 的导出常量 `STARTUPINFOW` 与 `PROCESS_INFORMATION` 替换为 `startupInfoType()` 与 `processInformationType()` 函数，因为 koffi 的 `struct()` 调用必须推迟到首次原生操作。

本地有 7 个文件引用这两个常量（`src/ffi.ts`、`src/process.ts` 与 5 个测试文件）。这是编译期错误而非运行时静默错误，`tsc -b` 会全部抓出。

本地仓库的预发布立场明确允许自由重命名，因此照官方做破坏性变更并一次性改完所有引用点，而不是保留兼容导出。

### D6 本地 subprocess-local 架构比官方旧一代

官方 `subprocess-local/src/` 有 15 个文件，本地只有 6 个。因此：

- 官方的 `linux-execve.ts`（koffi 延迟）**无法移植**——本地无此文件，本地 Linux 路径不走 koffi execve
- 官方 `tests/linux-execve.spec.ts` **无法移植**
- 本地 `src/index.ts` 的 `nodePty.spawn` 调用行号与参数与官方不同，不能照抄 diff
- 本地 `windows-inspector.ts` 已有"惰性 koffi 绑定表"设计，移植时只需把 koffi 的**加载**也延迟，保留原有的类型注册惰性

### D7 本地无 api/terminal-controller，xterm 收益减半

官方两处 xterm 延迟加载分别落在 `api/terminal-controller`（`@xterm/headless` + `@xterm/addon-serialize`）与 `terminal-bash`（`@xterm/headless`）。本地只有后者，因此只做 `terminal-bash/src/session.ts` 一处。

`terminal-bash/src/index.ts` 还包含本批次唯一的非延迟加载改动：`createSession` 现在会调用 `requireHeadless()` 因而可能抛错，改前的代码在该路径抛错时不回收 PTY 句柄，会泄漏一个活着的子进程。官方新增 `rejectAfterStartupCleanup` 辅助函数补上该路径。

### D8 依赖识别逻辑必须移植，尽管 5 个消费者不受管辖

本地的 5 个原生依赖消费者（`attachment-local`、`terminal-bash`、`subprocess-local`、`win32-process`、`sandbox-windows-acl`）**都不受** `verify-package-dependencies` 管辖（该 gate 只覆盖声明 `dsh.client` 或位于 `packages/client/` 的包，以及配置的 host 包）。

因此给它们加 `lazy-require` 依赖不会被 gate 校验。但识别逻辑仍须移植，理由有二：它是官方 spec 的用例契约，不移植会让该 spec 的官方版本无法通过（未来 rebase 的冲突源）；一旦将来某个受管辖包使用 `createLazyRequire`，缺这段逻辑会误报"依赖未声明"。

### D9 WebWorker 打包器无法发现惰性加载的依赖

本地 `packages/experimental/webworker-runtime/src/compile/transform.ts` 有专门的 `createRequire` 识别逻辑，识别的是 `node:module` 的 `createRequire(import.meta.url)`。改用 `createLazyRequire` 后，静态 packer 不再能发现仅在调用中命名的依赖。

官方把这记录为已知限制（要求 Preview 场景保持字面量请求可达），本地应在 `lazy-require` 的 README 中同样记录。

### D10 本地既有启动优化不可被覆盖

本地有官方没有的堆水位机制：`packages/api/session-controller/src/heap-watch.ts`（156 行）与三个配置项 `heapWatchIntervalMs`、`heapWatchWarnRatio`、`heapWatchSnapshotNearLimit`，以及 `run.sh` 中的 `--max-old-space-size=12288` 与关于 `--heapsnapshot-near-heap-limit` 为何被禁的注释。

官方全仓无生产级堆水位机制（`max-old-space-size` 只出现在 benchmark 与 PTC 子进程配置中），`session-controller/src/` 也无 `heap-watch.ts`。本批次与该机制零重叠。

本地提交 `55520dc9fe` 对 `skill-catalog.ts` 的改动（`resolveHeader` 从 live agent 取 header、`agentPresetFor` 优先读投影检查点）消除了冷 Session 的日志重放，而**官方 master 至今仍是 `observeSession` 旧写法**。这是本地领先项，rebase 时需手工保留。

## 3. 被拒绝的方案

**把 `sharp` 移到 `optionalDependencies`**：不采用。`sharp` 是图片功能的必需依赖，移到 optional 会让缺失时的失败语义从"启动期明确报错"变成"运行期降级"。依赖识别逻辑也强制它留在 `dependencies`。

**在 `try` 块内调用 `requireSharp()`**：不采用。会把原生绑定缺失误报为图片数据损坏。

**为 `STARTUPINFOW` 与 `PROCESS_INFORMATION` 保留兼容常量**：不采用。常量是立即求值，无法惰性化；保留它们等于保留模块作用域的 koffi 调用，优化失效。

**照抄官方的 `lazy-require/package.json`**：不采用。本地强制 invariant 伴生入口，照抄会导致 `verify-package-invariants` 失败。

**只延迟加载不改依赖识别**：不采用。识别逻辑是官方 spec 契约，且是"依赖留在 `dependencies`"这一保证的来源。

## 4. 影响面

- `packages/util/lazy-require/`：新增包（`src/index.ts`、`src/invariant.ts`、`tests/`、README.zh.md、package.json、tsconfig.json）
- `scripts/verify-package-dependencies.ts` 与 `.spec.ts`：AST 识别增强
- `scripts/package-dependency-policy.ts`：新增 duplicate-safe 条目
- `scripts/doc-standard.spec.ts`、`scripts/verify-package-readme-model-experience.ts`：新增包登记
- `packages/attachment/attachment-local/`：新增 `src/sharp.ts`，三处导入改 type-only，新增 `tests/lazy-sharp-failure.spec.ts`
- `packages/subprocess/win32-process/`：新增 `src/koffi.ts`，`src/ffi.ts` 常量改函数，`src/process.ts` 改调用，5 个测试文件改引用
- `packages/sandbox/sandbox-windows-acl/`：`src/ffi.ts` 内联惰性加载
- `packages/subprocess/subprocess-local/`：`src/index.ts` 延迟 node-pty，`src/windows-inspector.ts` 延迟 koffi，`tests/local.spec.ts` 改 mock 目标
- `packages/terminal/terminal-bash/`：`src/session.ts` 延迟 xterm，`src/index.ts` 补启动失败清理
- `packages/experimental/webworker-runtime/tests/compile/transform-corpus-check.ts`：删除 koffi 豁免条目
- `tsconfig.base.json`、`tsconfig.host.json`、各消费者 tsconfig：登记新包
- `packages/util/README.zh.md`、`docs/module-graph.zh.md`、`docs/config-catalog.zh.md`：包清单与生成物
- `pnpm-lock.yaml`：刷新

本批次不涉及模型可见行为变化，因此无需更新会话快照。

## 5. 验证方式

- `lazy-require`：单测覆盖首次加载、成功缓存、失败不缓存且可重试、caller-relative 解析
- 依赖识别：spec 覆盖命名导入、命名空间导入、别名、以及 `import()`/`require()` 既有形态不回归
- sharp：`lazy-sharp-failure.spec.ts` 断言三条路径原样透传加载错误；正常路径的图片检测与规范化行为不变
- win32-process：全部引用点改完后 `tsc -b` 通过；既有测试通过
- terminal-bash：新增用例断言 `createSession` 抛错时 PTY 句柄被终止且 spawn 承诺在清理完成前不落定
- webworker：`transform-corpus-check` 在删除豁免条目后通过
- 启动：对比改动前后 `import attachment-local` 与 `import subprocess-local` 的耗时
