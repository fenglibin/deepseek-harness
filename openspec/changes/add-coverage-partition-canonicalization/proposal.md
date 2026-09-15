# 规范化覆盖率分区的位置数据并隔离测试代理环境

## 为什么

本地已使用覆盖率分区模式（`test:coverage:partitioned` → `scripts/run-coverage-partitions.ts`，与官方逐字节相同）。该模式让每个分区写出 blob，再合并为整体覆盖率。

`ast-v8-to-istanbul` 把整行语句的结束列记为 `Infinity`，blob 的 JSON 序列化把它变成 `null`。`istanbul-lib-coverage` 只能通过数值列比对同一语句在不同环境下的写法，`null` 列会让仅存在于 client 拼写的语句残留为幽灵未覆盖语句——该语句实际已被覆盖，却始终计入未覆盖集合。

另一项独立缺陷是代理环境污染：`vitest.config.ts:151` 目前只有 `./scripts/test-invariants.ts` 一个 setupFile。开发机上的 Clash、squid 等代理会通过环境变量静默决定测试结果，尤其是 e2e 与真实 API 测试。

## 做什么

- 新增 `scripts/coverage-canonical-locations.ts`，在 `onCoverage` 钩子把非有限结束列改写为 `Number.MAX_SAFE_INTEGER`
- 新增 `scripts/test-proxy-environment.ts`，作为 setupFile 清除 8 个代理环境变量
- 把两者接入 `vitest.config.ts`

## 不做什么

- 不替换 `scripts/coverage-uncovered-locations.cjs`：它把未覆盖位置打印成可点击的 `path:line:col`，解决的是展示问题，与本次的位置规范化互补
- 不改分区划分或并发度
- 不修改 `ast-v8-to-istanbul` 依赖本身：规范化发生在 reporter 层，升级依赖时无需重做

## 影响

- `scripts/coverage-canonical-locations.ts`：新增 94 行
- `scripts/coverage-canonical-locations.spec.ts`：新增
- `scripts/test-proxy-environment.ts`：新增 63 行
- `vitest.config.ts`：`setupFiles` 增加代理清理，coverage `reporters` 增加规范化 reporter
- `package.json`：无脚本变化（沿用现有 `test:coverage` 与 `test:coverage:partitioned`）

本变更只影响测试基础设施与覆盖率报告，不涉及产品运行时行为，属于 l0。
