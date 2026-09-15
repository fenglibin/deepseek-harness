# 统一实验包发布策略为单一真相源

## 为什么

本地当前用两套互不相干的机制表达实验包的发布策略：

- `scripts/check-workspace-constraints.ts:54` 定义 `experimentalPackageNamePrefix = '@deepseek-ai/dsh-experimental-'`，要求实验包的 `name` 带该前缀
- `scripts/release/families.ts:323` 定义 `patterns = ['packages/!(experimental)/*/package.json', 'apps/*/package.json']`，在发布成员发现时排除 `packages/experimental/` 目录

两条规则从不同维度描述同一件事（哪些实验包对外发布），但没有任何共同来源。新增一个实验包时，是否公开取决于它是否同时满足名字前缀与目录位置，而"哪些实验包有意私有"这一事实没有任何地方显式记录。

官方把它收敛为 `scripts/experimental-package-policy.ts` 的 16 行单一真相源，被 `npm-baseline-packages.ts`、`publish-npm-baseline.ts`、`check-workspace-constraints.ts` 与 `release/families.ts` 共同 import。

## 做什么

- 新增 `scripts/experimental-package-policy.ts`，导出私有实验包目录清单与 `isPublicExperimentalPackageDirectory(directory, privateDirectories)` 判定函数
- 让发布成员发现、工作区约束校验与 npm baseline 三处都从该函数读取
- 把本地现状（8 个实验包全部私有）表达为清单内容，保持发布行为不变

## 不做什么

- 不照搬官方"全部实验包公开"：官方 `42c5b65643` 把黑名单清空并逐个摘掉 `private: true`。本地实验包包含 `webworker-packer`（`package.json` 中有 `bin` 与 `lib/repository-*.js`）等尚未完成产品化验证的包
- 不移除 `experimentalPackageNamePrefix` 校验：命名约定与发布策略是两个正交契约，前者继续由 `check-workspace-constraints.ts` 强制
- 不改变任何 `packages/experimental/*/package.json` 的 `private` 字段

## 影响

- `scripts/experimental-package-policy.ts`：新增 16 行
- `scripts/experimental-package-policy.spec.ts`：新增
- `scripts/check-workspace-constraints.ts`：从策略函数读取私有清单
- `scripts/release/families.ts`：发布成员发现改为按策略函数过滤
- `scripts/release/families.spec.ts`：既有"排除私有实验包"用例改为覆盖策略函数
- npm baseline 相关脚本：按需接入

本变更只改发布工具链的内部结构，不改变实际发布的包集合，属于 l1。
