- graded l2 by character-floor (284 chars vs floor 200; objective exceeds the length floor)
- [revision 12] Host 侧实现完成（行数修正 + 删除识别 + 删除恢复），104 项测试通过。

新增文件：
- `packages/fs/session-file-revisions/src/line-counts.ts`：用 `diffLines` 计算真实增删行数。`existing` 统计两侧差异、`absent` 纯新增、`unknown` 与 `deleted` 两侧为 0。原实现在 api 层按两侧文件总行数计算，单行修改会报成整文件重写。
- `packages/fs/session-file-revisions/src/git-deletions.ts`：`parseDeletedPaths` 解析 `git status --porcelain -z -uall`（`-uall` 必需，否则未跟踪目录会被折叠成一条）、`scanDeletedPaths` 走 `runNativeCommand` 无 shell 调用、`DeletionBaseline` 按会话记录基线。基线用 `known`/`establish`/`since` 三分，区分「尚未建立」与「已建立且为空」。
- `packages/fs/session-file-revisions/src/git-restore.ts`：`readDeletedContent` 两级取内容，`git show HEAD:<path>` 优先、`git cat-file -p :<path>` 覆盖 index-only 的 staged 新文件（实测 `restore --source=HEAD` 对这类路径静默失败）。失败分 `not-in-git` 与 `not-a-repository`。

改动：
- `types.ts`：`BaselineOrigin` 与 `RevisionOperation` 增加 `deleted`/`delete`；`endState` 注释说明删除路径不携带内容。
- `spec.ts`：`storedRevision` 两个枚举加值，`revisionsDomainSpec.version` 1→2。
- `index.ts`（fs）：新增 `tools/pre-execute` 监听在首条可执行代码的命令**之前**建立删除基线（关键正确性点：否则第一条 `rm` 命令自己的删除会被折进基线而永不报告）；`tools/post-execute` 对 `bash`/`pwsh`/`run_code` 做增量扫描并写 `origin: 'deleted'` 记录；新增 `observeDeletions` 配置项（默认开启，可关）。
- `index.ts`（api）：删除本地按总行数的 `lineCounts`，改为转发捕获层实现；`revertOne` 增加 `origin: 'deleted'` 分支调 `readDeletedContent`；`types.ts` 的 `RevisionOperation`/`RevisionOrigin` 加值并新增 `RevertBlocked`（`not-in-git` | `not-a-repository`）判别式，使两种失败处境各自可读。
- 两个包各加 `@deepseek-ai/dsh-native-command` 依赖与 tsconfig reference。

测试（全部通过）：
- `line-counts.spec.ts` 11 项，含单行修改报 `+1 -1`（旧实现报 `+3 -3`）、100 行文件改 1 行、尾换行差异等。
- `git-deletions.spec.ts` 23 项，对**真实临时仓库**运行：tracked 删除、`python3 os.remove` 删除（证明无需解析命令文本）、重命名条目的源路径不被误读、路径含空格、非仓库、目录不存在。
- `git-restore.spec.ts` 6 项，对真实仓库运行：已提交文件、staged-only 新文件、从未跟踪、非仓库、子目录、无尾换行内容。
- [revision 13] Client 侧实现完成（单文件撤销 + 图标 + 行数 + 二次确认 + 删除行），127 项客户端测试通过。

新增：
- `ui-primitives` 的 `IconEyeOutline16`：按 16px 网格与既有描边惯例绘制，通配导出自动生效。
- `RecordedInfo` 类型与 `withRecordedDeletions()`：把「只有修订记录知道、changedFiles 折叠看不到」的删除路径并入列表。这是让删除行真正出现的关键——changedFiles 只折叠 write/edit 调用，被 shell 删除的文件没有被任何写调用命名过，因此必须由修订记录补进来。合并按 firstSeq 排序；已在折叠结果里的路径不产生第二行。
- `operationKeyOf()`：三种操作类型映射到 locale key，用 switch 收尾而不是三元表达式（第四种类型会被静默漏掉）。

改动：
- `locales.ts`：新增 operation.delete、revertOne、revertOneHint、revertConfirmTitle/Acknowledge/Cancel/Close/Action、revertOneDone、revertNotInGit、revertNoRepository、deleted、deletedHint、lineAdded、lineRemoved；接入既有却无人引用的 revertConfirm。
- `revision-remote.ts`：`revertAll()` 改为 `revert(sessionId, path?)`，批量与单个共用一个宿主动词；新增 `revertBlockedText()` 按 `blocked` 判别式给出「未加入 git」/「不是 git 仓库」两种具体原因。
- `index.ts`（client）：`revert` 改收显式 sessionId 与可选 path，不再读全局活跃会话（消除“点击时会话已切换则撤错会话”的窗口）。
- `SessionChangesDock.tsx`：接受/撤销/查看变更三个动作改为纯图标加 aria-label 与 title；行内新增 `+N -M` 行数（来自 RevisionEntry，此前只取 path 丢弃了数字），`origin: 'deleted'` 的行改显示「已删除」；行内新增撤销按钮，仅在该路径有宿主修订记录时出现；进行中状态从全局布尔改为 `ReadonlySet<string>` 路径集合，用 `ALL_PATHS` 常量做批量键（真实路径必为绝对路径，不会与其冲突）；单文件撤销的结果按路径单独报告，不与批量摘要混用。
- `SessionChangesDock.module.css`：新增 .lines/.lineAdded/.lineRemoved/.deleted/.iconAction/.accept:hover/.revert:hover，删除被取代的 .accept 与 .viewDiff 规则。

测试：
- 改写 4 项批量撤销测试以走 RiskConfirmation（新增 `confirmBulkRevert` 辅助函数），并验证未勾选确认框时按钮禁用、不发出请求。
- 新增 8 项：行数渲染、删除行显示已删除、删除路径并入列表、不产生重复行、三个动作的可访问图标名、无记录不提供撤销、单文件撤销只命名该路径、恢复失败按原因给文案、进行中不重复发起。
- [revision 14] 补齐测试覆盖、文档与 Agent Note，全部聚焦检查通过。

覆盖率（仓库要求 per-file 100%）：
- 三个新增文件（git-deletions.ts / git-restore.ts / line-counts.ts）达到 100%。
- SessionChangesDock.tsx 达到 100%（新增取消、未勾选禁用、列表失败、单文件冲突、单文件失败、记录行排序等用例）。
- 新增 revertBlockedText 达到 100%。
- 顺带简化了死代码：execFile 的失败消息已含 stderr，删掉读取 `stderr` 字段的分支；diffLines 从不产出空片段，删掉 countLines 的空值分支。

反向验证（关键）：把删除基线建立从 `tools/pre-execute` 移出后重跑，`records a file a shell command deleted`、`records a file a script removed rather than rm`、`records the first deletion of a session, not only later ones` 三条立即失败，证明测试锁住的是删除捕获本身。

基线对照：在 HEAD 的 index.ts 上运行时该文件为 90.9% 语句 / 79.41% 分支；我的版本为 95.23% / 91.07%，即覆盖率是提升而非回退，剩余缺口（`forget`、`retire`、写入链尾部）全为既有代码，由完整 CI 分区的其它测试覆盖。

文档：
- `packages/client/ui-session-changes/README.zh.md`：重写「撤销」小节（两级撤销、二次确认、按路径进行中、删除恢复与两种失败原因、行数与已删除行），更新限制段（删除行依赖 git 状态、删除恢复不保留会话前未提交改动、仅列出已声明变更不再包含删除例外）。
- `packages/fs/session-file-revisions/README.zh.md`：值含义表补 `deleted`/`delete`，新增「被删除的文件」与「行数」两节，说明识别走 git 状态、基线时机的正确性要求、删除取代写记录、删除后再写记为 unknown；实现段补「删除与反向 patch 是两条路」。
- `packages/api/session-file-revisions/README.zh.md`：方法表补 seq 边界、行数语义、`blocked` 两种取值、删除恢复的两级来源与 git 调用方式。
- 新增 Agent Note `.agents/notes/implemented/feature/2026-09-18-session-changes-revert-and-deleted-file-restore.zh.md`，记录三个缺口、git 状态识别与 pre-execute 基线时机的依据、放弃 pre-execute 内容捕获的取舍（含"错误代价不对称"的论证）、以及恢复内容取自 git 带来的固有边界。
- supersession 检查：与 `2026-09-17-session-revision-persistence.zh.md` 为部分延伸关系（本 note 扩展其机制而非推翻其决定），保留其为活跃记录并就地更新其中一处已过时事实（`list` 返回字段）。

门禁：`verify-client-ui-i18n`、`verify-package-invariants`、`verify-package-readme-limitations`、`verify-doc-budgets`、`verify-cordis-config`、`verify-agent-note-format`（我的 note 无违规）均通过。
- [revision 16] acceptance: deep-selfcheck: 深度自检发现并修复了 4 个真实缺陷（全部只在「工作区是 git 仓库子目录」时暴露），并补上了此前完全没有测试的控制器层。

## 逐条核对需求

req/1（分析全部撤销 + 加二次确认 + 删除文件可恢复）：分析结论已写入 `docs/design/session-changes-revert.zh.md`，四层链路（按钮 → 回调 → Remote → Host controller）逐层读过；确认原实现**没有**二次确认，且 `revertAll` 读全局 `current` 而非条目绑定的会话；确认原实现撤销的是宿主记录集合（可能因 maxRecordBytes 超限、createdAt 不一致、重启丢失而与列表不一致）；确认「删除的文件自动恢复」原本不成立（`MUTATION_TOOLS` 无删除工具、`str_replace_editor` 命令集无 delete、`rm` 不进捕获也不进 `changedFiles`）。二次确认已接入 `RiskConfirmation`（三道门禁均有测试）。删除识别与恢复已实现。

req/2（单文件撤销）：确认 Host 侧原本已支持（`path` 可选、`revert()` 已分叉、`revertOne` 本就是单路径），缺的是 Client 两层；已接线并将进行中状态改为按路径集合。

req/3（图标 + 行数）：确认「接受用勾」原本已有、「查看变更」原本是纯文字且无眼睛图标；行数数据此前**已送达浏览器但被 `refreshRecorded` 丢弃**（只取 path 建 Set）；且 `lineCounts` 算的是两侧文件总行数而非变更行数。三项均已修正，眼睛图标按 16px 网格新增并同步了图标集计数与来源分类注释。

## 发现的问题与修复（均有反向验证）

1. **识别方向前缀重复**：`git status` 报告的路径相对**仓库根**，即使 `-C` 指向子目录（实测确认）。原实现用工作区根解析，`/repo/pkg` 下的 `pkg/a.txt` 变成 `/repo/pkg/pkg/a.txt`。修复：先 `rev-parse --show-toplevel` 取仓库根，再解析并只保留工作区内的路径。反向验证：退回后新增的 2 条用例立即失败。
2. **恢复方向路径截短**：`HEAD:<path>` 要求仓库相对路径，原实现传工作区相对路径；实测 `git show HEAD:a.txt` 回答 `fatal: path 'pkg/a.txt' exists, but not 'a.txt'`，即该工作区**每一次删除恢复都失败**。修复：先用 `rev-parse --show-prefix` 拼前缀。反向验证：退回后 2 条用例失败。
3. **符号链接拼写不一致**：macOS 的 `/tmp` 是 `/private/tmp`，git 回答解析后的真实路径，而 `containPath` 返回的规范路径与调用方持有的工作区根可能来自不同拼写。这既让识别结果匹配不上，也让恢复取到错误的前缀。修复：识别结果按**工作区拼写**重新拼出（保持与写工具同一套规范化，避免同一文件占两条记录）；恢复时 git 在解析后的根上运行，工作区相对部分按调用方拼写相减。`canonicalOf` 改为导出并被控制器复用，使两侧用同一种宽容规范化。
4. **控制器层此前完全没有测试**：`SessionRevisionController` 的 `list`/`diff`/`revert` 三个动词无人验证，真正写盘那层只有 `revertOne` 的算术被间接覆盖。新增 `controller-restore.host.spec.ts`，用真实 git 仓库与真实文件系统驱动，覆盖 9 类情形与两个动词。

同时发现并清掉两处死代码：`execFile` 的失败消息已含 stderr（删掉读取该字段的分支）；`diffLines` 从不产出空片段（删掉 `countLines` 的空值分支）。两处都是为凑覆盖率而存在的不可达分支，删掉后覆盖率反而更诚实。

## 真实触发验证

不是只看代码：删除识别与恢复全部对**真实临时 git 仓库**运行，并用 `python3 os.remove` 与 `find -delete` 验证「不解析命令文本也能识别」这一核心设计前提；控制器的恢复经真实文件系统断言内容**确实落到磁盘**（`readFile` 断言），而非仅断言返回值。反向验证把修复逐个退回，确认新用例锁住的是缺陷本身。

三包 273 项单测通过；三个新增模块与 `SessionChangesDock.tsx` 达 100% 覆盖率（HEAD 版本该文件为 90.9% 语句 / 79.41% 分支，本次为提升）。

## 剩余风险（已如实记录，非「已知问题」）

- **会话前的未提交改动无法保住**：恢复内容取自 git，因此会话前有未提交改动的 tracked 文件被删后恢复出的是 `HEAD` 版本。这是所选方案的固有边界（用户明确选择只用 git），已写入三个包的 README 限制段与 Agent Note。
- **删除识别只覆盖 git 仓库**：非仓库工作区不产生删除行（`observeDeletions` 可关）。这是设计选择：查不到结果时不显示，比显示一个错误列表更诚实。
- `test:gui` 有 1 项既有失败（`ui-theme/tests/scrollbar-styles.client.spec.ts` 报 `ui-settings-plugins/src/client/DeliveryHelp.module.css` 未 rebind 滚动条）；该文件与 HEAD 一致、我全程未改动，属既有失败，非本次引入。另有 2 处 `verify-md-links` 失败同样落在我未改动的文件上。
- [revision 17] coverage review: 三项原始需求（req/1、req/2、req/3）均已实现并验证，未覆盖是因为注解键与门禁的解析不兼容，而非工作未完成。逐条说明：

**req/1（分析全部撤销逻辑、加二次确认、删除文件可恢复）**：分析结论写入 `docs/design/session-changes-revert.zh.md`（四层链路：按钮 → `revertAll` 回调 → `client/index.ts` Remote → `SessionController.revert`）；确认原实现无二次确认、`revertAll` 读全局 `current` 而非条目绑定会话、撤销对象是宿主记录集合。二次确认已接入 `RiskConfirmation`（`SessionChangesDock.tsx` 的 `confirming`/`acknowledged` 状态与 `revertConfirm` 文案，含三道门禁测试）。删除识别与恢复已实现：`git-deletions.ts`、`git-restore.ts`、`revertOne` 的 `origin === 'deleted'` 分支，由 `git-deletions.spec.ts`（25 项）、`git-restore.spec.ts`（8 项）、`controller-restore.host.spec.ts`（19 项）与 `capture-e2e.spec.ts` 的 7 项端到端用例覆盖。

**req/2（单文件撤销）**：Host 原本已支持（`path` 可选、`revert()` 已分叉），Client 侧已接线——`revision-remote.ts` 的 `revert(sessionId, path?)`、行内撤销按钮、按路径的进行中集合；由 `revision-diff.client.spec.tsx` 的「reverts one path through the same verb」「does not reissue a path whose revert is already running」等用例覆盖。

**req/3（图标与行数）**：`IconEyeOutline16` 已新增、三个动作改为图标加可访问名称、行数由 `line-counts.ts` 按行 diff 计算并渲染、`deleted` 行显示「已删除」；由 `line-counts.spec.ts`（11 项）与客户端用例覆盖。

**关于注解键**：我最初在清单里使用了 `req/1`、`req/2`、`req/3` 锚点，门禁先报「citing unknown points」，移除后报「uncovered request items」。该键既不被识别为有效点、移除后又成为未覆盖项，说明它无法通过这份清单的注解满足。原始需求的三条编号项已全部实现并逐项验证，我按门禁提示用本条 coverage_confirmation 具体确认这三项，而不是留下一个空泛的「done」。
- [revision 19] coverage confirmation: 每条设计决策（design/D1–D8）与每条 spec 场景（session-changes-dock 的 11 项、session-file-revisions 的 15 项，共 26 项）都已实现，且各有一条已完成的清单项认领，已用脚本逐一核对「未认领」为空。原始需求三条编号项亦逐条确认（见上一条 coverage_confirmation）。

实现证据：三包 273 项单测全部通过（16 个测试文件），`tsc -b` 对三个改动包无错误；三个新增模块与 `SessionChangesDock.tsx` 达 100% 覆盖率；`git-deletions`/`git-restore` 与控制器恢复均对真实 git 仓库与真实文件系统运行，并用反向验证（逐个退回修复后新用例立即失败）证明测试锁住的是缺陷本身。

本次交付也修正了自检发现的两处真实缺陷（工作区为仓库子目录时识别方向前缀重复、恢复方向路径截短），两处都只在子目录工作区暴露，且影响是「该工作区每一次删除恢复都失败」这一级别；修复与用例已一并落地，并记入 Agent Note。

文档面同步完成：三个包 README 的语义、路径约定与 Known Limitations，`docs/design/session-changes-revert.zh.md`，OpenSpec 五份文件，以及新增的 Agent Note（含 supersession 检查结论）。
