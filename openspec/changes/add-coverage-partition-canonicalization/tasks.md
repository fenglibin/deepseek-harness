# 实施清单

## 1. 覆盖率位置规范化

- [ ] 1.1 新增 `scripts/coverage-canonical-locations.ts`：导出 `END_OF_LINE_COLUMN` 常量（`Number.MAX_SAFE_INTEGER`）与 `canonicalizeEndOfLineColumns(coverageMap)` 函数，含说明为何在 `onCoverage` 钩子执行的模块 JSDoc (covers: coverage-reporting/幽灵未覆盖语句不再出现, design/D1)
- [ ] 1.2 实现 `canonicalizeEndOfLineColumns`：遍历 `coverageMap.data` 的每个文件，规范化 `statementMap`、`fnMap`、`branchMap` 的每个条目及其 `decl`/`loc`/`locations`；`FileCoverage` 的映射优先读 `file.data` (covers: coverage-reporting/幽灵未覆盖语句不再出现, design/D1)
- [ ] 1.3 在 `data` 不是记录时抛出错误，使载荷形状变化立即失败 (covers: coverage-reporting/载荷形状变化时失败而非静默, design/D4)
- [ ] 1.4 导出默认 reporter 类，在 `onCoverage` 钩子调用规范化函数 (covers: coverage-reporting/幽灵未覆盖语句不再出现, design/D1)

## 2. 分区命令接线

- [ ] 2.1 在 `scripts/coverage-partitions.ts` 新增 `CANONICAL_LOCATIONS_REPORTER = './scripts/coverage-canonical-locations.ts'` 常量，含说明为何用根相对 POSIX 拼写的 JSDoc (covers: coverage-reporting/规范化只在分区内生效, design/D2)
- [ ] 2.2 在该文件的 `partitionCommand` 中加入 `--reporter=${CANONICAL_LOCATIONS_REPORTER}` 参数 (covers: coverage-reporting/规范化只在分区内生效, design/D2)
- [ ] 2.3 确认 `vitest.config.ts` 未被改动：该 reporter 只经分区命令的 CLI 参数生效，未分区运行不受影响 (covers: coverage-reporting/规范化只在分区内生效, design/D2)

## 3. 未覆盖位置 reporter 同步

- [ ] 3.1 在 `scripts/coverage-uncovered-locations.cjs` 新增 `END_OF_LINE_COLUMN` 常量与 `atLineEnd(column)` 判定函数 (covers: coverage-reporting/与未覆盖位置打印共存, design/D3)
- [ ] 3.2 把该文件 `endSuffix()` 中的 `!Number.isFinite(end.column)` 改为 `atLineEnd(end.column)`，使规范化后的哨兵列仍被读作行尾 (covers: coverage-reporting/与未覆盖位置打印共存, design/D3)
- [ ] 3.3 确认该文件保持 CommonJS 形态（`istanbul-reports` 用裸 `require()` 加载） (covers: coverage-reporting/与未覆盖位置打印共存, design/D3)

## 4. 测试代理环境清理

- [ ] 4.1 新增 `scripts/test-proxy-environment.ts`：从 `packages/util/http-proxy/src/policy.ts` 导入 `PROXY_ENV_NAMES`，清除这 8 个名字加 `NODE_USE_ENV_PROXY` (covers: coverage-reporting/测试进程不受宿主代理影响, design/D5)
- [ ] 4.2 在文件 JSDoc 中说明 `NODE_USE_ENV_PROXY` 无法被 setup 文件解除（Node 在进程启动时采样），需由 shell 预先 unset (covers: coverage-reporting/测试进程不受宿主代理影响, design/D5)
- [ ] 4.3 导出 `TEST_PROXY_SETUP_FILE` 常量与 `vitestConfigFiles()` 发现函数，使配置接线可被测试断言 (covers: coverage-reporting/测试进程不受宿主代理影响, design/D6)
- [ ] 4.4 在 `vitest.config.ts` 的三处 `setupFiles`（根、unit project、process-bound project）前置本文件 (covers: coverage-reporting/测试进程不受宿主代理影响, design/D5)
- [ ] 4.5 在 `vitest.e2e.config.ts`、`vitest.expected.config.ts`、`vitest.snapshot.config.ts` 的 `setupFiles` 前置本文件 (covers: coverage-reporting/测试进程不受宿主代理影响, design/D5)

## 5. 测试

- [ ] 5.1 新增 `scripts/coverage-partitions.spec.ts` 的 canonical 用例：让两条以两种写法表示同一语句的记录经 blob 的 JSON 跳转后再合并，断言规范化后的合并没有未覆盖语句、未规范化时会出现幽灵语句 (covers: coverage-reporting/幽灵未覆盖语句不再出现, design/D1)
- [ ] 5.2 新增用例固定语句、函数与分支位置的规范化，以及每个分区命令都带上该规范化 reporter (covers: coverage-reporting/幽灵未覆盖语句不再出现, coverage-reporting/规范化只在分区内生效, design/D1, design/D2)
- [ ] 5.3 新增用例固定对不含覆盖率数据的载荷的显式拒绝 (covers: coverage-reporting/载荷形状变化时失败而非静默, design/D4)
- [ ] 5.4 新增 `scripts/test-proxy-environment.spec.ts`：覆盖清空全部 9 个名字与大小写变体、只报告实际设置的名字且不碰其他键 (covers: coverage-reporting/测试进程不受宿主代理影响, design/D5)
- [ ] 5.5 在该 spec 中加入发现性守卫：断言声明了 `setupFiles` 的配置精确列表为本地 4 个配置，并逐槽断言都含 `TEST_PROXY_SETUP_FILE` (covers: coverage-reporting/测试进程不受宿主代理影响, design/D6)
- [ ] 5.6 在分区模式下运行一次覆盖率，确认合并后不再出现幽灵未覆盖语句，且未覆盖位置仍以 `path:line:col` 输出 (covers: coverage-reporting/幽灵未覆盖语句不再出现, coverage-reporting/与未覆盖位置打印共存)

## 6. 文档

- [ ] 6.1 更新 `docs/testing.zh.md` 中覆盖率章节，说明位置规范化的存在、它解决的问题与"只在分区模式生效"的边界 (covers: coverage-reporting/幽灵未覆盖语句不再出现, design/D1, design/D2)
- [ ] 6.2 更新 `docs/testing.zh.md` 中测试隔离章节，说明测试进程清除代理环境变量及 `NODE_USE_ENV_PROXY` 的限制 (covers: coverage-reporting/测试进程不受宿主代理影响, design/D5)
- [ ] 6.3 新增 Agent Note 记录跨 Vite 环境的语句映射分歧与规范化决策，含"依赖 Vitest 报告器次序"这一后果 (covers: design/D1, design/D2)
