# Agent Note: 实验包发布策略收敛为单一真相源，并保持本地全部私有

Status: implemented

## Problem

实验包是否对外发布，此前由两套互不相干的机制表达。`scripts/check-workspace-constraints.ts` 用 `releaseMemberDirectory` 的负向前瞻 `(?!experimental\/)` 把整个实验目录排除在发布成员之外，并用 `checkExperimentalManifest` 无条件要求实验包 `private: true`、拒绝 `publishConfig`；`scripts/publish-npm-baseline.ts` 与 `scripts/release/families.ts` 各自用一个 `packages/!(experimental)/*/package.json` 负向 glob 做同样的排除；`scripts/verify-package-dependencies.ts` 还有第三份拷贝。

四条规则从不同维度描述同一件事，没有任何共同来源。「哪些实验包有意私有」这一事实没有地方显式记录：新增一个实验包时，它是否公开只取决于目录前缀，读者无法从一处得知这是有意决定还是巧合。

## Decision

`scripts/experimental-package-policy.ts` 是实验包发布策略的唯一来源。它导出私有实验包目录清单 `PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES` 与判定函数 `isPublicExperimentalPackageDirectory(directory, privateDirectories = PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES)`；调用方按需注入自己的清单。三个发布工具脚本与工作区约束都从它读取，`scripts/` 下不再保留 `!(experimental)` 负向 glob。

清单列出 `packages/experimental/` 下的全部 8 个包——`agent-team`、`agent-team-profile`、`agent-team-web-profile`、`client-ui-agent-team`、`inspector`、`tool-agent-team`、`webworker-packer`、`webworker-runtime`——因此它们当前都不发布。清单非空是本地与上游的实质差异：上游该清单为空，语义是「默认公开 + 显式私有例外」，本地则是「默认私有 + 显式公开例外」。从清单摘除一个目录就把它交给默认公开策略，无需改动任何调用方。

`checkExperimentalManifest` 按判定函数分支。公开支要求 `private !== true` 且 `publishConfig.access === 'public'`；私密支要求 `private === true` 且无 `publishConfig`。发布成员的判定是 `standardReleaseMemberDirectory.test(dir) || isPublicExperimentalPackageDirectory(dir)` 的并集，因此把一个实验包移出清单即让它连带上发布成员的清单要求。

命名与发布是两个正交契约。`@deepseek-ai/dsh-experimental-` 前缀校验继续由工作区约束独立强制，不进入策略函数：改发布范围与改命名规则互不牵连，一个包可以保留前缀而保持私有。

## Alternatives considered

**照搬上游的空清单（全部实验包公开）** —— 落选。上游 `42c5b65643` 清空黑名单并逐个摘掉 `private: true`。本地实验包的产品化程度低于上游，其中 `webworker-packer` 的 `package.json` 声明了 `bin` 与 `lib/repository-*.js`；公开它们等于给出语义化版本与发布责任承诺，而这些包尚未完成产品化验证。照抄会让工作区约束立即报出 16 条错误。

**把命名前缀校验并入策略函数** —— 落选。命名约定与发布策略是两个契约。合并后「改发布范围」与「改命名规则」会互相牵连，而它们的变更节奏并不相同。

**在策略函数中读取 `package.json` 的 `private` 字段** —— 落选。`private` 是 npm 的字段，而发布成员发现发生在读取清单之前；以目录清单为唯一输入使判定保持纯函数，无需文件系统访问，也让判定函数可以在测试中直接注入清单。

**用「默认公开、清单记录私有」的方向表达本地现状** —— 落选，这正是上游的形状。本地 8 个实验包全部私有，该方向会让清单承担「几乎全部包」的内容，而每新增一个实验包都要记得补一条；默认私有的方向下，忘记登记只会让新包保持私有，代价是一条需要显式做出的公开决定，而不是一次意外发布。

## Consequences

- 发布成员集合在本次重构前后逐元素相同：`dsh` 家族 264 个成员、npm baseline 273 个清单、依赖校验 262 个 release 清单，四项判据的新旧实现对比全部相等，实验包在四者中出现次数均为 0。
- 没有 `packages/experimental/*/package.json` 的 `private` 字段被改动；`scripts/experimental-package-policy.spec.ts` 逐包断言 `private === true` 且无 `publishConfig`。
- `scripts/release/families.ts` 的 `DshFamily` 覆盖 `members()`，先按 `packages/*/*/package.json` 发现再按策略过滤，因此它读到的实验包判定与其余三处一致。
- `scripts/verify-package-dependencies.ts` 的 release 清单集合同样经策略过滤，而不是经独立的负向 glob。
- 新增一个实验包时，把它列入 `PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES` 是唯一需要的发布侧动作。
