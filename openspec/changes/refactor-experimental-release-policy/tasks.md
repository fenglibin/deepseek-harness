# 实施清单

## 1. 策略模块

- [x] 1.1 新增 `scripts/experimental-package-policy.ts`，导出 `PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES` 常量，内容为本地 8 个实验包目录（`agent-team`、`agent-team-profile`、`agent-team-web-profile`、`client-ui-agent-team`、`inspector`、`tool-agent-team`、`webworker-packer`、`webworker-runtime`） (covers: experimental-release/私有实验包不进入发布成员, design/D1, design/D2)
- [x] 1.2 实现并导出 `isPublicExperimentalPackageDirectory(directory, privateDirectories = PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES)`：用 `/^packages\/experimental\/[^/]+$/` 判定实验包目录，非实验包目录返回 `false`，私有清单中的目录返回 `false` (covers: experimental-release/非实验包目录一律不公开, experimental-release/调用方可以注入自己的清单, design/D1, design/D4)

## 2. 调用方接线

- [x] 2.1 修改 `scripts/release/families.ts:323` 的 `patterns` 或其后处理，使发布成员发现改从 `isPublicExperimentalPackageDirectory` 读取，而不再用 `packages/!(experimental)/*/package.json` 的目录排除 (covers: experimental-release/私有实验包不进入发布成员, design/D1)
- [x] 2.2 修改 `scripts/check-workspace-constraints.ts`，使实验包私有性判断改从策略函数读取，同时保留 `:54` 的 `experimentalPackageNamePrefix` 前缀校验不动 (covers: experimental-release/缺少前缀的实验包仍被拒绝, design/D3)
- [x] 2.3 检查 npm baseline 相关脚本（`npm-baseline-packages.ts` 或本地等价物）是否存在实验包目录判断，如有则接入策略函数 (covers: experimental-release/实验包发布策略有单一真相源, design/D1)

## 3. 测试

- [x] 3.1 新增 `scripts/experimental-package-policy.spec.ts`：覆盖非实验包目录返回 `false`、私有清单中的实验包返回 `false`、注入自定义清单时按该清单判定 (covers: experimental-release/非实验包目录一律不公开, experimental-release/调用方可以注入自己的清单, design/D1, design/D4)
- [x] 3.2 更新 `scripts/release/families.spec.ts:45-49` 既有「excludes private experimental packages」用例，改为经策略函数表达，并断言成员集合与本变更前一致 (covers: experimental-release/私有实验包不进入发布成员, experimental-release/发布成员集合保持不变, design/D2)
- [x] 3.3 新增用例断言 `packages/experimental/*/package.json` 的 `private` 字段全部仍为 `true` (covers: experimental-release/实验包的 private 字段不变, design/D2)
- [x] 3.4 新增或保留用例断言带前缀校验仍独立生效：构造一个 `packages/experimental/*` 但 `name` 无前缀的样本，断言工作区约束报错 (covers: experimental-release/缺少前缀的实验包仍被拒绝, design/D3)

## 4. 文档

- [x] 4.1 更新 `docs/development.zh.md` 中发布相关章节，说明实验包发布策略的单一真相源位置 (covers: experimental-release/实验包发布策略有单一真相源, design/D1)
- [x] 4.2 在 `packages/experimental/README.zh.md`（或本地等价说明文件）记录实验包默认私有的决策与理由 (covers: experimental-release/实验包的 private 字段不变, design/D2)
- [x] 4.3 新增 Agent Note 记录"命名约定与发布策略正交"以及"本地保持全部私有"两项决策 (covers: design/D2, design/D3)
