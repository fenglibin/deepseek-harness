# 技术决策

设计草案见 [docs/design/upstream-batch1-quick-wins.zh.md](../../../docs/design/upstream-batch1-quick-wins.zh.md)。本文件记录决策编号，供 tasks.md 锚定。

### D1 在 onCoverage 钩子规范化，而不是改写依赖

Vitest 让每个 reporter 的 `onCoverage` 收到本次运行完成的覆盖率 map，而 blob reporter 在之后的 `onTestRunEnd` 才序列化同一份 map。因此 reporter 在 `onCoverage` 中看到的位置仍是数值，这是唯一的规范化窗口。

规范化把每个非有限的结束列替换为 `Number.MAX_SAFE_INTEGER`（`END_OF_LINE_COLUMN`）。该值保留"跨到行尾"的语义，同时让同一语句在每个 blob 中拥有相同的键，合并因而把覆盖归到本该归的那个进程。

替代方案是修改 `ast-v8-to-istanbul` 依赖或打补丁。不采用：规范化属于报告层职责，且升级依赖时无需重做。

### D2 reporter 只在分区模式下生效

该 reporter 经 `scripts/coverage-partitions.ts` 的分区命令以 `--reporter=` 参数传入，**不出现在 `vitest.config.ts` 中**。因此未分区运行完全不受影响。

本地 `scripts/coverage-partitions.ts` 与官方逐字节相同，只差两处：`CANONICAL_LOCATIONS_REPORTER` 常量（8 行，含 JSDoc 说明为何用根相对 POSIX 拼写）与分区命令中的 `--reporter=` 行（1 行）。

### D3 必须同步修改未覆盖位置 reporter

`scripts/coverage-uncovered-locations.cjs` 把同一列读作行尾。若不改，规范化后的 `Number.MAX_SAFE_INTEGER` 会被打印成荒谬的列号（如 `(to 5:9007199254740992)`）。

官方新增 `END_OF_LINE_COLUMN` 常量与 `atLineEnd(column)` 判定（`!Number.isFinite(column) || column >= END_OF_LINE_COLUMN`），把原来 `endSuffix()` 中的 `!Number.isFinite(end.column)` 改为 `atLineEnd(end.column)`。

该文件必须保持 CommonJS：`istanbul-reports` 用裸 `require()` 加载自定义 reporter，不在 tsx/ESM 管线内。这与本次新增的 TypeScript reporter 加载方式不同，是既有事实而非不一致。

### D4 载荷形状不符时抛错，而不是静默跳过

`canonicalizeEndOfLineColumns` 在 `coverageMap.data` 不是记录时抛错。理由是静默跳过会让 Vitest 的一次改动（不再向 reporter 传递该 map）表现为"覆盖率正常"，而实际上每个位置都未规范化。

这是 fail-loud 选择：分区因此失败并指出契约变化，而不是留下一个看不见的错误。

### D5 代理清理独立于覆盖率修复

清除代理环境变量与覆盖率规范化没有技术关联，放在同一变更只因两者都是低成本的测试基础设施修复，且都改测试配置。

清除的清单是 `PROXY_ENV_NAMES`（`http_proxy`、`HTTP_PROXY`、`https_proxy`、`HTTPS_PROXY`、`no_proxy`、`NO_PROXY`、`all_proxy`、`ALL_PROXY`）加 `NODE_USE_ENV_PROXY`，共 9 个。清理发生在每个测试进程启动时，因此不受宿主机 shell 配置影响。

`NODE_USE_ENV_PROXY` 无法真正解除：Node 在进程启动时采样代理环境，setup 文件删除该变量不能解绑它已配置的内置 `fetch`。该限制需在文件 JSDoc 中说明。

与[出站网络代理支持](../add-http-proxy-support/proposal.md)的关系：那条变更让产品运行时遵循代理环境，本变更让测试进程不受宿主代理影响，两者作用对象不同，因此需从同一策略模块导入清单以保持单一真相源。

### D6 setupFiles 清单断言需按本地配置调整

官方 `test-proxy-environment.spec.ts` 有一个发现性守卫：它枚举 `vitest*.ts`，过滤出声明了 `setupFiles` 的配置，断言精确列表并逐槽断言都含本文件。

本地**没有** `vitest.bench.config.ts`（官方有），因此本地该断言应列出 4 个配置：`vitest.config.ts`、`vitest.e2e.config.ts`、`vitest.expected.config.ts`、`vitest.snapshot.config.ts`。

## 被拒绝的方案

**在测试内逐个清除代理变量**：不采用。需要每个测试文件重复，且新增测试容易遗漏。

**只规范化 blob 输出而不动 map**：不采用。合并在 map 层进行，输出阶段规范化已经太晚。

**在分区中丢弃未测试文件映射**：不采用。这些映射正是让没有任何测试执行的文件失败的依据；去掉它们等于用真实的覆盖率缺口换取幽灵语句。

**在合并命令中按行调和语句**：不采用。同一行可以承载多条语句，按行合并会掩盖真正未覆盖的代码。

**豁免该文件或放宽逐文件门禁**：不采用。该文件确有覆盖，门禁本身正确，错的是归因。
