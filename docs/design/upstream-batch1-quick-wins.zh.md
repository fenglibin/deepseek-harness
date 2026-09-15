---
description: "第一批上游能力移植方案：默认工具集收敛（移除 str_replace_editor、默认开启 web_fetch）、网络代理支持与裸 dispatcher 门禁、覆盖率分区规范化、实验包发布策略统一。"
kind: "design-draft"
---

# 第一批：快速收益移植方案

本批次移植官方仓库中成本低、确定性高的 5 项改动。基线见[上游差异扫描分析](upstream-diff-analysis.zh.md)。所有官方提交 hash 均指官方仓库 `0a53fb55be..master` 区间。

## 1. 范围

| 项 | 官方证据 | 本地现状 | 改动量 |
|---|---|---|---|
| 移除 `str_replace_editor` 默认启用 | `36a4665144`、`965adbb5cf`、`63795eaa5c` | `packages/bundle/base/cordis.patch.yml:493-497` 仍启用；`packages/bundle/web-app/cordis.patch.yml:379-381` 有对应 `disabled` 覆盖 | 删 8 行配置 + 1 行依赖 + 更新快照 |
| 默认开启 `web_fetch` | `0a0f9e59ff`、`cf7b0bd5a4`、`ca723d9273` | 同文件 `:531-536` 为 `fetch: false` | 改 1 行 + 注释重写 + 更新测试与快照 |
| 网络代理支持 | `545e2ad914`（`@deepseek-ai/dsh-http-proxy`）、`03d2c54db1` | 完全缺失：无 `http-proxy` 包，无 `HOME_LAYER_PROXY_NAMES`，无任何代理环境变量读取 | 新增包（681 行）+ app-boot 与 CLI 接线 |
| `verify-no-bare-dispatcher` 门禁 | `545e2ad914` → `e6dbf85f6c` → `8470ddef1d`（226 行 AST 版） | 无该脚本；但 `web-fetch-http/src/network.ts:179-190` 已有门禁要拒绝的形态 | 新增脚本 226 行 + spec 143 行 + 3 处豁免标记 |
| 覆盖率分区位置规范化 | `c171a7a9a2` | 无该 reporter，但已用分区模式；`coverage-partitions.ts` 与官方逐字节相同 | 新增 94 行 + 9 行接线 + 17 行既有 reporter 改动 |
| 测试代理环境污染清理 | `03d2c54db1` | 无 | 新增 63 行 + 4 处 setupFiles 接线 |
| 实验包发布策略统一 | `63187de80f` | 策略内联在 `check-workspace-constraints.ts` 与 `publish-npm-baseline.ts` | 新增 16 行 + 3 处接线 |

## 2. 关键设计决策

### D1 默认工具集收敛的依据是接口重叠，不是包退役

本地 `packages/fs/tool-fs` 已提供 `read`、`write`、`edit` 三个文件编辑工具，`packages/fs/tool-str-replace-editor` 提供第四套重叠接口。官方决策记录 `.agents/notes/implemented/simplification/2026-09-05-base-default-file-editor.zh.md` 说明共享 base 同时选择两套接口会让模型在等价工具间选择，同时增加每请求的 schema token 开销。

重叠映射是 `view`↔`read`、`create`↔`write`、`str_replace`↔`edit`。该工具的 `insert`（按行插入）与 `view` 的目录列举在 `tool-fs` 中没有对应物，这是它仍被保留而非退役的原因。

本方案只从 base 组合包移除该条目，**保留包本身**：显式插入该条目的自定义组合仍可使用它。官方 `packages/fs/tool-str-replace-editor` 在官方仓库仍存在，只是不再被 base 选择。

**移除必须与 web-app 的覆盖同批**：本地 `packages/bundle/web-app/cordis.patch.yml:379-381` 有 `- id: tool-str-replace-editor` 加 `disabled: true` 的覆盖行，它引用的是 base 中的条目。base 行删除后该覆盖指向不存在的 id，会触发 Cordis 配置校验失败。官方三个提交的顺序（先 `965adbb5cf` 在 sdk-app 加 disable、再 `36a4665144` 从 base 移除并同步删除各应用覆盖）证明悬空 id 不可接受。

显式启用该工具的组合需要改用 `insert` 形式：只写 `disabled: false` 的 patch 需要已有配置项才能生效，无法创建配置项。该约束需在 base 的 README 中说明。

**本地该包有官方已删除的 `src/invariant.ts` 伴生入口**与对应的 `"./invariant"` 导出。本批次不动它，但需确认该伴生插件在包未被挂载时不报错。

**不要同时移植 minimal profile 的移除**：官方把「base 移除」（`36a4665144`）与「minimal 移除」（`63795eaa5c`）拆成两个提交。本地若只做前者，则 minimal preset 仍保留 `str_replace_editor`，`apps/cli/tests/web-agent-presets.e2e.ts` 与 `apps/web/tests/minimal-preset.snapshot.ts` 的断言**应保持原样**。

### D2 web_fetch 默认开启，安全约束由 provider 承担

`packages/web/tool-web` 的 `Config.fetch` schema 默认值已是 `true`（`packages/web/tool-web/src/index.ts:40`），本地 base 的 `fetch: false` 是唯一的关闭点。移除该覆盖后，模型默认获得联网读取能力。

安全边界不在本层：`packages/web/web-fetch-http` 只接受不含内嵌凭据且不超过 2,048 字符的 `http:` 与 `https:` URL；它只解析一次主机名，只要结果中有任何非公共单播地址就拒绝整个结果，并把连接固定到已校验的地址集合；每次同源重定向重复解析与固定，跨源重定向失败并要求重新调用。

**该约束是 SSRF 防护，不是出网白名单**。官方决策记录明确写道：「公开目的地址校验不会阻止向公网发送数据。需要不同网络策略的产品应在后续组合包或 profile patch 中覆盖完整的 `tool-web` 配置。」

**对本地内网环境的两点影响需先确认**：

1. `web_fetch` 会**拒绝访问内网地址**（`127.0.0.0/8`、私网段、非公开 IPv6 均被拒绝）。若本地部署依赖模型抓取内网文档，开启后这些请求会失败。
2. 本地若需要经代理出网，必须有 D3 的代理支持；否则 `web_fetch` 会直连，在有强制代理的内网环境中不可用。

需要关闭的部署在 profile patch 中覆盖 `tool-web` 的 `fetch: false`。patch 替换整个 config，因此必须重述想保留的键（如 `searchTimeoutMs`）。

### D3 网络代理支持是本批次优先级最高的一项

本地当前**完全没有**代理支持：`packages/util/` 下无 `http-proxy`，`packages/boot/app-boot/src/index.ts` 无 `HOME_LAYER_PROXY_NAMES`，CLI 启动路径不安装任何 dispatcher。而 Node 的 `fetch` 默认忽略 `HTTP_PROXY`/`HTTPS_PROXY` 环境变量。

后果是本地所有出站请求（DeepSeek 适配器 `packages/llm/llm-deepseek/src/adapter.ts:643` 的 `fetch`、内网模型插件、MCP HTTP 传输、web 工具）都直连目标，代理环境变量只对子进程生效。对部署在内网或需要经代理出网的场景，这是功能性缺口。

官方 `packages/util/http-proxy` 共 681 行，分三个文件：`index.ts`（23 行，导出面）、`install.ts`（315 行，把策略装为 undici 全局 dispatcher）、`policy.ts`（343 行，从启动环境快照解析代理策略）。CLI 在**第一个插件挂载之前**调用 `installProxyFromEnvironment(options.environment, warn)`（`apps/cli/src/profile-boot.ts:299`），并且从启动器快照而非 `process.env` 解析，这样 `.env` 层声明的代理也能生效。

本地需要同步补齐 `app-boot` 的 `HOME_LAYER_PROXY_NAMES` 豁免：代理决定每个请求的路由，因此 Harness home 的 `.env`（用户自己的文件）允许声明代理名，而克隆自带的调用目录 `.env` 继续拒绝。CA 与 TLS 相关名字在任何层都保持拒绝，因为它们改变信任对象而非路由。

### D4 裸 dispatcher 门禁必须与代理支持同批落地

`verify-no-bare-dispatcher` 禁止包自建 undici agent 或给 `fetch` 显式传 `dispatcher`。理由是显式 dispatcher 会**覆盖**全局 dispatcher，从而静默绕过 D3 安装的代理策略。两者是同一个契约的两面。

**本地已存在门禁要拒绝的形态**：`packages/web/web-fetch-http/src/network.ts:179-190` 的 `requestPinned()` 无条件执行 `const { Agent, fetch } = await import('undici')`、`new Agent({...})` 与 `fetch(url, { ..., dispatcher })`。这正是官方注释里描述的「proxy support 之前 `web-fetch-http` 携带的确切缺陷，其 DNS 钉扎 agent 静默绕过了每一个代理」。

因此门禁与代理实现必须同批：只落地门禁会让本地 CI 立即红，而只落地代理会让该绕过路径继续存在。落地时对这三处标注 `proxy-exempt: <理由>`，说明它确实拥有进程级 dispatcher 无法承载的按请求状态。

门禁的移植基准是官方 master 的 226 行版本，**不是**初版 `545e2ad914` 的 91 行正则版：官方在 `e6dbf85f6c` 才把逐行正则改为语法感知的 AST 发现，正则版会漏掉 `{ dispatcher }` 简写与 `import { Agent as X }` 重命名。

门禁的性能处理值得照搬：官方 `4623c68e70` 加了「源码既不含 `undici` 也不含 `dispatcher` 就跳过解析」的两词预过滤，使通过过滤的文件从 1597 个降到 21 个。该模式可复用到任何 AST 门禁。

例外机制为 `proxy-exempt: <理由>` 标记，判定范围是违规行本身或其正上一行。

### D5 覆盖率位置规范化解决分区合并的幽灵未覆盖语句

本地已使用覆盖率分区模式（`test:coverage:partitioned` → `scripts/run-coverage-partitions.ts`，与官方逐字节相同）。该模式下每个分区写出 blob 后再合并。

`ast-v8-to-istanbul` 把整行语句的结束列记为 `Infinity`，blob 的 JSON 序列化把它变成 `null`。`istanbul-lib-coverage` 只能通过数值列比对同一语句在不同环境下的写法，`null` 列会让仅存在于 client 拼写的语句残留为幽灵未覆盖语句。

`scripts/coverage-canonical-locations.ts` 在 `onCoverage` 钩子（blob reporter 序列化之前）把非有限结束列改写为 `Number.MAX_SAFE_INTEGER`，保留行尾语义并让每个 blob 的键一致。

本地 `scripts/coverage-partitions.ts` 与官方**逐字节相同**，只差两处：`CANONICAL_LOCATIONS_REPORTER` 常量（8 行）与分区命令中的 `--reporter=` 参数（1 行）。这是本批次最干净的移植点。

该 reporter 只在分区模式下生效（经 CLI 参数传入），未分区运行完全不受影响。

**必须同步修改 `scripts/coverage-uncovered-locations.cjs`**：它把同一列读作行尾。若不改，规范化后的 `Number.MAX_SAFE_INTEGER` 会在未覆盖位置报告中被打印成荒谬的列号。官方新增 `END_OF_LINE_COLUMN` 常量与 `atLineEnd()` 判定，把原来的 `!Number.isFinite(end.column)` 改为 `atLineEnd(end.column)`。

注意本地已有的 `scripts/coverage-uncovered-locations.cjs` 解决的是另一个问题（把未覆盖位置打印成可点击的 `path:line:col`），两者互补而非替代，都需保留。

### D6 测试代理环境清理需要内联代理名清单

`test-proxy-environment.ts` 作为 Vitest `setupFiles` 在每个测试进程启动时清除代理环境变量。没有它，开发机上的 Clash、squid 等代理会静默决定测试结果（尤其是 e2e 与真实 API 测试）。本地 `vitest.config.ts:151` 目前只有 `./scripts/test-invariants.ts` 一个 setupFile。

官方该文件从 `packages/util/http-proxy/src/policy.ts` 导入 `PROXY_ENV_NAMES`。本地若同批引入 `http-proxy` 包则可直接导入；否则需要内联 8 个名字（`http_proxy`、`HTTP_PROXY`、`https_proxy`、`HTTPS_PROXY`、`no_proxy`、`NO_PROXY`、`all_proxy`、`ALL_PROXY`）加 `NODE_USE_ENV_PROXY`。

本批次已包含 `http-proxy` 包，因此采用导入形式。同时需把官方 spec 中「声明了 setupFiles 的配置清单」断言改为本地实际的 4 个配置（本地无 `vitest.bench.config.ts`）。

`NODE_USE_ENV_PROXY` 需要在清除清单中但无法真正解除：Node 在进程启动时采样代理环境，setup 文件删除该变量不能解绑它已配置的内置 `fetch`。该限制需在文件 JSDoc 中说明。

### D7 实验包发布策略统一为单一真相源，但不采用官方的默认公开

本地当前用**两套独立机制**表达实验包发布策略：

- `scripts/check-workspace-constraints.ts:54` 的 `experimentalPackageNamePrefix = '@deepseek-ai/dsh-experimental-'`（要求实验包名字带前缀），以及 `:258-269` 的 `checkExperimentalManifest` **无条件**要求 `private === true` 且拒绝 `publishConfig`
- `scripts/check-workspace-constraints.ts:56` 的 `releaseMemberDirectory = /^(?:packages\/(?!experimental\/)[^/]+\/[^/]+|apps\/[^/]+|vendor\/[^/]+)$/`（用负向前瞻把实验包排除在 release member 之外），以及 `scripts/publish-npm-baseline.ts:25-29` 的 `'packages/!(experimental)/*/package.json'`（用 glob 负向模式排除）

官方把它收敛为 `scripts/experimental-package-policy.ts` 的 16 行单一真相源。但官方该文件的 `PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES` 是**空数组**，语义是「默认公开 + 显式私有例外列表」，与本地「全部私有」**相反**。

若照抄官方实现，本地 8 个实验包会立即产生 16 条约束错误（每个包要求 `private !== true` 与 `publishConfig.access === 'public'`）。因此本方案**只引入策略函数与单一真相源**，把本地现状（8 个实验包全部私有）表达为清单内容：

- 判定函数保留官方的 `isPublicExperimentalPackageDirectory(directory, privateDirectories)` 形状，但本地清单非空
- `checkExperimentalManifest` 改为按判定函数分支，公开支与私密支的字段要求沿用官方
- `releaseMemberDirectory` 的负向前瞻与 `publish-npm-baseline.ts` 的 glob 负向模式改为经判定函数表达

注意本地**没有** `scripts/npm-baseline-packages.ts`（官方为拆分出的独立模块），相关逻辑在 `publish-npm-baseline.ts` 内联。本方案不为此重构该文件，只替换其目录判断。

## 3. 被拒绝的方案

**照搬官方「全部实验包公开」**：官方 `42c5b65643` 把黑名单清空并逐个摘掉 `private: true`。本地实验包包含 `webworker-packer`（`package.json` 中有 `bin` 与 `lib/repository-*.js`）等尚未完成产品化验证的包，公开会引入发布责任。本方案保持私有，只统一机制。

**为 `str_replace_editor` 保留兼容开关**：不采用。两套接口并存正是本次要消除的状态；需要它的组合可以直接在 patch 中插入条目。

**在 `tool-web` 层强制 `fetch` 默认关闭**：不采用。关闭点属于部署组合（profile patch），不属于工具包契约；工具包 schema 默认 `true` 已是官方既定形态。

## 4. 影响面

- `packages/bundle/base/cordis.patch.yml`：删 `tool-str-replace-editor` 条目（`:493-497`），改 `tool-web` 的 `fetch`（`:534`），重写 `tool-web` 上方注释（`:507-516`）
- `packages/bundle/web-app/cordis.patch.yml`：删 `:379-381` 的 `disabled` 覆盖（**必须与上一项同批**）
- `packages/bundle/base/package.json:118`：删 `@deepseek-ai/dsh-tool-str-replace-editor` 依赖
- `packages/bundle/base/tests/base.spec.ts:46`：`fetch: false` 断言改为 `true`；新增用例断言 base 行集合不含该工具
- `packages/bundle/base/README.zh.md`：`:48` 工具集描述补联网抓取，`:52` 后新增显式启用编辑器的 `insert` 示例
- `apps/cli/composition.md`：重跑生成器，预期 −3 行
- `snapshots/`：本地 35 个文件引用 `str_replace_editor`、10 个引用 `web_fetch`，按生成方式刷新
- `packages/util/http-proxy/`：新增包（`index.ts` 导出面、`install.ts` dispatcher 安装、`policy.ts` 策略解析）
- `packages/boot/app-boot/src/index.ts`：新增 `HOME_LAYER_PROXY_NAMES` 常量与 `isBootstrapOnly` 的分层判定
- `apps/cli/src/profile-boot.ts`：新增 `installProxyFromEnvironment` 调用与 disposer 接线
- `apps/cli/package.json`：新增 `@deepseek-ai/dsh-http-proxy` 依赖
- `packages/web/web-fetch-http/src/network.ts`：改用 `proxyRouteFor` 路由，并在自有传输处标注 `proxy-exempt: <理由>`（3 处）
- `scripts/`：新增 `verify-no-bare-dispatcher.ts` 与 `.spec.ts`、`coverage-canonical-locations.ts`、`test-proxy-environment.ts` 与 `.spec.ts`、`experimental-package-policy.ts` 与 `.spec.ts`
- `scripts/coverage-partitions.ts`：新增 `CANONICAL_LOCATIONS_REPORTER` 常量与分区命令参数（9 行）
- `scripts/coverage-uncovered-locations.cjs`：新增 `END_OF_LINE_COLUMN` 与 `atLineEnd()`，改用后者判定行尾
- `scripts/check-workspace-constraints.ts` 与 `scripts/publish-npm-baseline.ts`：目录判断改从策略函数读取
- `vitest.config.ts`、`vitest.e2e.config.ts`、`vitest.expected.config.ts`、`vitest.snapshot.config.ts`：`setupFiles` 增加代理清理
- `scripts/run-gates.ts`：`ciSharedStaticGates` 与 `hygieneLeafGates` 各新增一个 gate
- `tsconfig.base.json`：新增 `http-proxy` 的 paths 映射

**本地 fork 特有、不可被整体文件替换覆盖的内容**：`packages/bundle/base/cordis.patch.yml:551-559` 的 `response-language`/`language: zh`、`base.spec.ts:47-50` 的对应断言、`packages/fs/tool-str-replace-editor` 的 `invariant.ts` 与 `"./invariant"` 导出、`tsconfig.base.json:571` 的 invariant paths、`packages/client/ui-agent-preset/src/client/locales.ts:35` 的中文 preset 描述、`packages/web/tool-web/README.zh.md` 与 `web-fetch-http/README.zh.md` 的本地措辞。**逐条编辑，不要整文件覆盖。**

## 5. 验证方式

- `packages/bundle/base` 行为测试断言 base 行集合不含 `tool-str-replace-editor`、`tool-web.fetch` 为 `true`，且显式 `insert` 该条目的组合仍注册该工具
- `packages/bundle/web-app` 配置校验通过（无悬空 id）
- 快照刷新后 `pnpm run test:snapshot` 通过；`apps/cli/tests/web-agent-presets.e2e.ts` 与 `apps/web/tests/minimal-preset.snapshot.ts` 保持原样（本批次不含 minimal 移除）
- 代理：设 `HTTPS_PROXY` 指向本地记录服务器，断言出站请求经该服务器；无代理时行为不变；`NO_PROXY` 命中目标时直连
- 代理：home 层 `.env` 声明 `HTTP_PROXY` 被接受、声明 `SSL_CERT_FILE` 被拒绝；调用目录 `.env` 声明 `HTTP_PROXY` 被拒绝
- `verify-no-bare-dispatcher` 对含 `dispatcher` 的样本拒绝、对 `proxy-exempt` 标记放行、对不含两个关键词的文件跳过解析；`scanRepository()` 在本地树上返回空
- 覆盖率：分区模式下不再出现幽灵未覆盖语句，且未覆盖位置仍以可点击的 `path:line:col` 输出
- 测试隔离：宿主机设置代理变量时测试结果不变
- 实验包：`check-workspace-constraints` 与 `publish-npm-baseline` 均从同一策略函数读取，发布成员集合与变更前一致，8 个实验包的 `private` 字段不变
