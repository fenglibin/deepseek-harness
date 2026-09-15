# Agent Note: 在 blob 合并前规范化分区覆盖率位置，并清除测试进程的环境代理

Status: implemented

## 问题

**位置规范化。** 覆盖率门禁把 [packages/util/home-paths/src/index.ts](../../../../packages/util/home-paths/src/index.ts) 报为语句 96.96%，并在 `48:22` 标出 1 条未覆盖语句，而分支、函数与行都保持 100%，同一批测试在非分区运行中把该文件报为 100%。第 48 行只有 1 条语句，因此合并报告计入了源码中并不存在的第 2 条未命中语句。

一个源文件在每个 Vite 环境中各有一份语句映射并据此进入合并报告，而序列化后的分区 blob 抹掉了 istanbul-lib-coverage 用来调和这些映射的位置数据。因此在两个环境中执行过的文件可能在每条语句都跑到的情况下仍未通过逐文件 100% 门禁，且该失败跟随测试环境与分区数量，而不跟随文件本身。

**测试进程的环境代理。** 开发机上的 Clash 与 CI runner 上的 squid 都会导出 `HTTP_PROXY` 及其同族变量。在 harness 遵循它们之后，环境值会静默决定测试结果：本应发往本地 fixture 服务器的请求被送到无法解析该主机名的代理，而代理的错误页被记录为期望输出。

## 决策

[scripts/coverage-partitions.ts](../../../../scripts/coverage-partitions.ts) 为每个分区传入 `--reporter=./scripts/coverage-canonical-locations.ts`；该报告器的 `onCoverage` 钩子把当次运行覆盖率映射中所有非有限的结束列改写为 `Number.MAX_SAFE_INTEGER`。该列保留"位置结束于所在行行尾"的含义，序列化后仍是数字，并且在每个 blob 中生成相同的键，因此合并命令会像进程内合并那样调和各环境特有的写法。逐文件 100% 门禁对 `coverage.include` 命中的每个文件保持完整强度：规范化只会通过 istanbul 的包含规则增加命中，绝不会把语句移出报告。载荷若不含 istanbul 的 `data` 记录，分区会直接失败，而不是让所有位置保持未规范化。

[scripts/coverage-uncovered-locations.cjs](../../../../scripts/coverage-uncovered-locations.cjs) 把同一列读作行尾，因此无论是否经过规范化，未覆盖记录打印的 `path:line:col` 都相同。[单 job 分区覆盖率](../process/2026-08-18-in-job-partitioned-coverage.zh.md)协调器拥有该报告器所加入的分区与合并命令，并保留其唯一一次合并判定。

[scripts/test-proxy-environment.ts](../../../../scripts/test-proxy-environment.ts) 作为 Vitest `setupFiles` 在每个测试进程启动时删除 `PROXY_ENV_NAMES` 的 8 个名字与 `NODE_USE_ENV_PROXY`。每个套件因此从一个已知的起始环境运行，需要代理的测试显式设置它要考察的名字。

### 跨 Vite 环境的语句映射分歧

节点侧套件把源文件映射到 `ssr` 环境，`@vitest-environment jsdom` 套件把它映射到 `client` 环境。基于 AST 的 V8 重映射器按它在转换后代码中找到的节点定位语句，因此同一条声明会以两种写法进入合并映射：ssr 转换给出其声明标识符的位置，client 转换给出其嵌套调用表达式的位置。istanbul-lib-coverage 会把最窄包含范围的命中计入其他记录都未命名的条目，从而覆盖 client 记录引入的那种写法。

该调和只作用于 `getLoc()` 接受的位置，这要求行列值都是数字。ast-v8-to-istanbul 把整行语句的结束列标为 `Infinity`；分区 blob 会把 `Infinity` 序列化为 `null`，于是合并命令拿到无法比较的位置，并把仅存在于 client 的写法保留为额外的未命中语句。同样的记录在单个进程内合并时 `Infinity` 得以保留，因此不会报出该语句。

### 一个名字无法被清除

`NODE_USE_ENV_PROXY` 在进程启动时被 Node 采样，因此 setup 文件删除该变量无法解绑它已配置的内置 `fetch`。导出了它的 shell 必须在运行套件前自行 unset。代理应用与企业 profile 实际导出的那 8 个名字可被完全处理，因为只有本仓库自己的 resolver 读取它们，而它在此之后运行。

## 验证

[scripts/coverage-partitions.spec.ts](../../../../scripts/coverage-partitions.spec.ts) 让两条以两种写法表示同一语句的记录经过 blob 实际执行的 JSON 跳转后再合并，断言规范化后的合并没有未覆盖语句，而未经规范化的合并会报出该幻影语句。第二个用例固定语句、函数与分支位置的规范化，第三个用例固定每个分区命令都带上该规范化报告器，第四个用例固定对不含覆盖率数据的载荷的显式拒绝。

[scripts/test-proxy-environment.spec.ts](../../../../scripts/test-proxy-environment.spec.ts) 固定清空全部 9 个名字与大小写变体、只报告实际设置的名字且不碰其他键，并用发现性守卫断言本地声明了 `setupFiles` 的 4 个配置的每个槽都接入本文件——`vitest.bench.config.ts` 在本地不存在，因此该列表与官方的 5 项不同。

在 `HTTP_PROXY` 与 `HTTPS_PROXY` 指向不可解析主机的环境下运行套件，结果与未设置时一致，证明清理在真实进程中生效。

## 曾考虑的替代方案

**在分区中丢弃未测试文件映射。** 不予采用，因为这些映射正是让没有任何测试执行的文件失败的依据；去掉它们等于用真实的覆盖率缺口换取该幻影语句。

**在合并命令中按行调和语句。** 不予采用，因为同一行可以承载多条语句，按行合并会掩盖真正未覆盖的代码。

**禁止 jsdom 套件加载仅节点侧模块。** 不予采用，因为归因不能取决于套件恰好把模块加载到哪个环境，而且此后任何跨环境加载都会让该缺陷重现。

**在报告阶段修复合并后的映射。** 不予采用，因为此时各记录已经融合，补回命中无法区分幻影写法与真正未命中的嵌套语句。

**豁免该文件或放宽逐文件门禁。** 不予采用，因为该文件确有覆盖，门禁本身正确，错的是归因。

**在每个测试文件内逐个清除代理变量。** 不予采用，因为需要每个文件重复，且新增测试容易遗漏。

## 后果

分区运行对跨环境文件给出与单进程相同的归因，因此门禁在不豁免任何文件的前提下保持逐文件 100%。规范化只在分区内部运行，未分区运行及其报告保持原样。blob 在行尾位置携带一个有限哨兵列，分区报告器与未覆盖位置报告器都把该哨兵命名为行尾约定。该规范化还依赖 Vitest 的报告器次序：blob 报告器在自己的 `onCoverage` 中保存该映射，在 `onTestRunEnd` 中序列化它，因此升级 Vitest 后若次序改变，最先表现为幻影语句复现。

测试进程不再受宿主代理影响，代价是显式依赖宿主机代理的测试必须自己设置变量；真实 `dsh` 子进程仍由各自套件清除环境，因为它们必须在 setup 是否运行都成立。
