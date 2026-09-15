# 技术决策

设计草案见 [docs/design/upstream-batch1-quick-wins.zh.md](../../../docs/design/upstream-batch1-quick-wins.zh.md)。本文件记录决策编号，供 tasks.md 锚定。

### D1 策略函数与私有清单分离

`scripts/experimental-package-policy.ts` 导出两个东西：私有实验包目录清单 `PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES`，以及判定函数 `isPublicExperimentalPackageDirectory(directory, privateDirectories)`。

判定函数的第二个参数带默认值，使调用方可以直接使用清单，也可以在测试中注入自己的清单。官方采用同一形状，使同一函数既服务生产路径也服务用例。

### D2 本地清单保持全部私有

官方 `42c5b65643` 把黑名单清空为 `[]` 并逐个摘掉 `private: true`，使全部实验包公开。本地不跟随。

本地 8 个实验包（`agent-team`、`agent-team-profile`、`agent-team-web-profile`、`client-ui-agent-team`、`inspector`、`tool-agent-team`、`webworker-packer`、`webworker-runtime`）当前全部私有，其中 `webworker-packer` 的 `package.json` 声明了 `bin` 与 `lib/repository-*.js`。公开它们会引入发布责任与语义化版本承诺。

本变更只统一机制，把本地现状表达为清单内容，因此**发布成员集合在变更前后完全一致**。

### D3 命名前缀校验与发布策略保持正交

`scripts/check-workspace-constraints.ts:54` 的 `experimentalPackageNamePrefix = '@deepseek-ai/dsh-experimental-'` 要求实验包的 `name` 带该前缀，这是命名约定。发布策略回答的是"哪些实验包对外发布"，这是两个不同契约。

本变更不移除前缀校验，只让两处发布相关判断改从策略函数读取。

### D4 判定函数的输入是仓库相对目录

`isPublicExperimentalPackageDirectory` 接受形如 `packages/experimental/agent-team` 的仓库相对目录，用 `/^packages\/experimental\/[^/]+$/` 判定它是否为实验包目录，再检查它是否在私有清单中。

这样调用方无需先判断目录类别：非实验包目录一律返回 `false`，而调用方各自的过滤逻辑保持不变。

## 被拒绝的方案

**照搬官方的空黑名单**：不采用。本地实验包的产品化程度低于官方，公开会引入尚未准备好的发布承诺。

**把命名前缀校验并入策略函数**：不采用。命名约定与发布策略是两个契约，合并会让"改发布范围"与"改命名规则"互相牵连。

**在策略函数中读取 package.json 的 `private` 字段**：不采用。`private` 是 npm 的字段，而发布成员发现发生在读取清单之前；以目录清单为唯一输入使判定保持纯函数且无需文件系统访问。
