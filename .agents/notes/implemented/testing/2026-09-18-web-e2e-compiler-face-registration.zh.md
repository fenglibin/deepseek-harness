# Agent Note: web e2e 测试文件的编译面登记门禁

Status: implemented

## Problem

`apps/web/tests` 下的 TypeScript 源分属两个互斥的编译面，而归属只能靠两份手工清单表达。两个程序不能合并：它们在同一组键下合并 cordis Context 却注入不同 service，一个程序无法同时看到两侧（`apps/web/tsconfig.json` 与 `tsconfig.client.json` 的注释都记录了这一点）。因此 `apps/web/tests` 里属于 Host 面的 web e2e lane（`scaffold.ts` 及其启动真实 host spine 的用例）必须逐个文件写进 `apps/web/tsconfig.json` 的 `exclude`，同时逐个文件写进根 `tsconfig.host.json` 的 `include`；只有真正与两面无关的叶子（`support.ts`，仅依赖 `node:*` 与 `playwright`）可以同时被两面加载。

清单是纯手工的，缺少一行的后果不是"少检查一个文件"，而是把 Host 面的文件搬进 Client 程序：它在 Client 面里的 workspace 相对导入会把整个 Host 包图（`dsh-agent`、`dsh-loader-smoke`、`dsh-session-snapshot` 等）拖进一个绝不能容纳它们的程序，`tsc` 随即以 `TS6059`/`TS6307` 报出一大片与真正改动无关的错误。2026-09-18 的 `fdae72876d`（"优化文件浏览，MD/HTML/HTM 打开时默认进入预览状态"）新增 `apps/web/tests/file-browser-default-preview.e2e.ts` 时正是如此：`./build.sh` 全量构建在 Client lane 崩溃，报错文件全在 `packages/` 下，根因却是一个 13 行的新测试文件没有登记。同一份清单还留着一条更早的漂移产物——`conversation-column-overflow.e2e.ts` 在 `66d0bbd5b5` 被删除，两份清单里的条目至今仍在。

既有门禁都没覆盖这条接缝：`scripts/project-reference-faces.ts` 校验的是 tsconfig `references` 的 Host/Client leaf 归属，`scripts/client-tsconfig.spec.ts` 校验的是 Client 聚合是否加载包的 CSS 声明，两者都不看 `apps/web/tests` 的文件归属，也没有任何脚本读取过 `apps/web/tsconfig.json`。

## Decision

新增闸门 [`scripts/web-test-faces.ts`](../../../../scripts/web-test-faces.ts)（`pnpm run verify-web-test-faces`，接入 `ci-static` 所在的共享静态 lane 与 `hygiene`），它用 TypeScript 自己的配置解析器重新推导两个程序，而不是相信清单本身，然后执行四条规则：

1. **无归属**：`apps/web/tests` 下存在、但两个程序都不加载的源被拒绝（漏掉两处登记的一半）。
2. **跨面相对导入**：Client 面文件导入 Host 专属文件（或反过来）被拒绝，报错指出该文件应登记到哪一面。这一条才是本次事故的因果链——第 1 条规则抓不住它，因为漏登记的 Host 文件当时正"完整地"待在 Client 面里。
3. **跨面相对导入（对称）**：Host 面文件导入 Client 专属文件同样被拒绝。
4. **死条目**：两份清单里指向不存在文件的字面条目被拒绝，同时清掉了 `conversation-column-overflow.e2e.ts` 的两条残留。

相对导入由 `ts.preProcessFile` 提取、`ts.resolveModuleName` 解析，失败时回退到仓库约定的书写方式（显式 `.ts` 后缀，其次 index 文件），因此不会因某个面禁用 `allowImportingTsExtensions` 而放行。

## Alternatives considered

**把 `apps/web/tests` 改成单一通配 include、让一个程序容纳两面。** 被否决：这正是两个编译面存在的原因。两侧在同一组 Context 键下注入不同 service，合并不是删几行 `exclude`，而是要重新设计 cordis 的声明合并接缝。

**在 `apps/web/tsconfig.json` 的注释里写清登记规则，靠评审兜住。** 这就是事发前的现状：注释已经解释了 web e2e lane 属于 Host 面，但它没有、也不可能阻止漏登记。注释能解释意图，不能阻止构建崩溃。

**用一份共享清单文件驱动两个 tsconfig（如 `tsconfig` 的 `extends` + 变量替换）。** 被否决：TypeScript 配置文件没有可复用的列表变量，唯一可行的形式是把文件改成生成产物，而这会让两份被 gate 校验的配置变成不可直接阅读的派生物——代价高于这次要防的错误。

**同时把规则写成 vitest spec（`scripts/web-test-faces.spec.ts`）而不新增闸门脚本。** 部分采纳：spec 作为回归锁定已加入（fixture 覆盖四条规则 + 真实仓库零违规断言），但闸门还需要独立的退出码与可读诊断，才能进 `ci-static` 与 `hygiene`，所以主体仍是 verify 脚本。

**只做死条目检查，或只做无归属检查。** 被否决：两者都拦不住本次事故（文件确实登记在某一面，只是错了一面），而且都会给出"清单没有明显问题"的假安全感。

**用一次完整的 `tsc -b` 程序构建代替配置解析。** 被否决：程序的构成本身就是被检查对象，用编译器报错当诊断意味着错误信息指向 `packages/` 里的无辜文件（正如事故现场），而且成本从亚秒级涨到分钟级。

## Consequences

收益：新增 web e2e 文件忘记登记，会在静态 lane 立刻失败，并在错误信息里指出应把文件登记到哪一面——把一次"报错文件全在 `packages/` 下的全量构建崩溃"缩短为一行可执行的提示。相对导入这一条同时给出了登记契约的因果解释：文件归属由它依赖的邻居决定，而不是由作者回忆决定。

代价与边界：两份清单从"隐式约定"变成被闸门校验的契约，今后删除或改名测试文件必须同步清理两份清单；闸门只覆盖 `apps/web/tests`，而 bare import 跨越编译面时仍由 `tsc` 自己报错，本闸门不重复实现它；`support.ts` 这类双面叶子不在拒绝之列，但它的双面资格由第 2、3 条规则隐式约束——一旦它导入任何一面专属的文件，就会被判为跨面导入。

## Testing

`scripts/web-test-faces.spec.ts` 用临时工作区覆盖四条规则（含不带后缀的 specifier 解析）并断言真实仓库零违规；`scripts/run-gates.spec.ts` 锁定闸门在 `ci-primary`、`ci-static`、`check-all`、`hygiene` 四个聚合里的存在与顺序。闸门本身在合入前做过负向实验：临时移除 `file-browser-default-preview.e2e.ts` 的登记后，它以 `apps/web/tsconfig.json loads this file, but it imports apps/web/tests/scaffold.ts, which only the other face loads` 失败，恢复登记后通过。
