# Agent Note: 会话变更列表的撤销补齐与被删除文件的恢复

Status: implemented

## 问题

输入框上方的「变更列表」此前只有三个动作：接受、查看变更、全部撤销。三处缺口各自独立，但都指向同一件事——读者对"这个会话动了什么"的掌控不完整。

**全部撤销没有二次确认。** 一次点击直接落盘，写盘走临时文件加 `rename`、删除走 `rm`，都不可逆。字典里其实早就写好一条 `revertConfirm` 文案，全仓库无人引用：设计意图存在，接线从未发生。

**撤销不了单个文件。** Host 侧其实已经支持——`RevisionsRevertRequest.path` 可选，`revert()` 已按 `path` 分叉，`revertOne` 本就是单路径实现——缺的只是 Client 两层：`RevisionRemote` 只暴露 `revertAll`，行上没有按钮，且"进行中"是一个全局布尔。

**撤销不了被删除的文件。** 捕获层的 `MUTATION_TOOLS` 只含 `write`、`edit`、`str_replace_editor`，后者的命令集（`view`/`create`/`str_replace`/`insert`）没有 delete，DSH 也没有专门的删除工具——agent 删文件只能走 bash 的 `rm`。而 `rm` 既不进捕获记录、也不进 `changedFiles` 投影，被删的文件在列表里根本不出现，读者无从知道会话删过什么，更谈不上恢复。

另有一处安静的缺陷：`lineCounts` 算的不是变更行数，而是**两侧文件的总行数**。原有测试用 `'old\n' → 'new\nlonger\n'` 断言 `+2 -1`，而两侧内容整体替换时总行数与变更行数恰好相等，因此测试锁住了一个错误实现：`'a\nb\nc\n' → 'a\nB\nc\n'` 会报 `+3 -3`，正确值是 `+1 -1`。

## 决定

### 删除的识别查询 git 状态，不解析命令文本

bash 是任意代码：`find . -delete`、`for f in $(cat list); do rm $f; done`、`python -c "os.remove(...)"`、`git clean -fd` 都无法用命令文本穷尽，而漏认与错认都会让读者看到一个**错误的列表**。git 状态是**结果**而非**意图**，因此覆盖脚本与间接删除，也与删除是怎么发生的无关。

实测：`git status --porcelain -z -uall` 在 7302 文件的仓库上耗时 33ms；用 `python3 os.remove` 与 `find -delete` 删除的文件，git 均报告为 ` D <path>`。`-uall` 是必需的——默认状态下未跟踪目录会被折叠成一条 `?? dir/`，逐文件的事实才是与基线可比的东西。

归属由 `DeletionBaseline` 按会话解决：git 报告工作区当前全部删除，不区分是否本会话所为。基线在会话内**第一条可能删除文件的命令执行之前**建立（`tools/pre-execute`），之后只报告增量。这个时机是正确性要求而非优化：把基线建立推迟到命令之后，那条命令自己的删除就会被折进基线而永远不被报告。

### 恢复内容取自 git 对象

删除的路径**没有内容侧可存**：发现它被删除时，文件已经不在磁盘上了。因此捕获层只记录"它被删了"，恢复改从工作区的 git 对象取内容——已提交的文件取 `HEAD` 版本，只进过 index 的未提交新文件取 index 内容。实测 `git restore --source=HEAD` 对 index-only 路径**静默失败**，所以两条来源是并列尝试而不是二选一。

这砍掉了整个内容捕获层：不需要在 `pre-execute` 读回文件内容，不需要为删除单独存一份字节，也不受 4 MiB 记录上限影响。代价写在下面。

### 单个与批量撤销共用一个动词

`revert(path?)` 复用 Host 已经测试过的分叉，而不是新增第二个动词。两套批次语义会各自演化，而它们的"全部"必须永远一致。

顺带修掉一处不对称：`revertAll` 原本读 `ctx.sessions.list` 的全局 `current`，而 `list`/`diff` 都收显式 `sessionId`。改为与该条目其余动词一致地使用注入的会话 id，消除"点击时活跃会话已切换则撤错会话"的窗口。

### 行数按行 diff 计算

`lineCounts` 下沉到 `fs/session-file-revisions`（与 `revertContent` 同居，该包已声明 `diff` 依赖），改用 `diffLines`。api 层转发它，避免为一个纯计算在新包引入 `diff`。

### 存储域版本 1 → 2

`origin` 与 `operation` 的枚举都扩了值，旧文档无法表达。按仓库预发布立场不做兼容垫片，由 `per-record` 布局按会话丢弃。

## 自检发现的缺陷

深度自检在两条路径上各发现一个真实缺陷，两者都只在**工作区是仓库子目录**时暴露——而这是一个完全普通的布局（会话工作区常常是 monorepo 里的一个包）。

**识别方向：前缀被重复。** `git status` 报告的路径相对于**仓库根**，即使 `-C` 指向的是仓库的子目录（git 的行为如此）。原实现直接用工作区根去解析这些相对路径，于是工作区 `/repo/pkg` 下的 `pkg/a.txt` 被解析成 `/repo/pkg/pkg/a.txt`——一个从不存在的路径。修复：先用 `rev-parse --show-toplevel` 取仓库根再解析，并只保留工作区之内的路径（工作区之外的删除不是这次会话的列表该显示的东西）。

**恢复方向：路径被截短。** git 的 `HEAD:<path>` 与 `:<path>` 要求**仓库相对**路径，而原实现传的是工作区相对路径。工作区是仓库子目录时，`git show HEAD:a.txt` 回答的是 `fatal: path 'pkg/a.txt' exists, but not 'a.txt'`，于是该工作区里的**每一次删除恢复都失败**。修复：先用 `rev-parse --show-prefix` 取工作区在仓库中的前缀再拼接。

修完这两处后，自检又发现控制器与捕获层对**符号链接拼写**的假设不一致：macOS 上 `/tmp` 是 `/private/tmp`，git 回答的是解析后的真实路径，而 `containPath` 返回的规范路径与调用方持有的工作区根可能来自不同拼写。`readDeletedContent` 因此在解析过符号链接的根上运行 git，但用调用方的拼写相减——被删文件没有可解析的真实路径，混用两种拼写会减掉两个无关的前缀。识别方向同理：结果按**工作区拼写**重新拼出，因为修订记录与写工具走同一套规范化，返回真实路径会让同一个文件占两条记录。

这四处都有反向验证：把修复逐个退回后，对应的新用例立即失败（识别方向 2 条、恢复方向 2 条、控制器 3 条），因此它们锁住的是缺陷本身而不是无论如何都能通过的路径。

同时补上了此前完全没有测试的 `SessionRevisionController`：它的 `list`/`diff`/`revert` 三个动词此前只有 `revertOne` 的辅助函数被 `revert-io.spec.ts` 间接覆盖，真正写盘的那层无人验证。新增的 `controller-restore.host.spec.ts` 用真实 git 仓库与真实文件系统驱动控制器，覆盖已提交/仅 index/未跟踪/非仓库/嵌套工作区/已存在/未知基线/会话新建/单路径 九类情形。

## 替代方案

**在 `pre-execute` 解析 bash 命令文本，执行前读回内容。** 否决：识别出 `rm a.txt` 时能在文件还在时精确保存它，从而保住会话前的未提交改动。但覆盖率有硬上限且是启发式的，而**错误的代价不对称**——解析错了会表现为"恢复出错误内容"，比"报告无法恢复"更糟。用户明确选择只用 git。

**新增模型可见的 delete 工具。** 否决：那会改变工具集与系统提示词，属于仓库里影响面最大的一类变更；而且它只覆盖"模型愿意用新工具"的情况，bash 删除依然存在。

**解析 `git status` 之外的来源（文件监视器）。** 否决：DSH 全仓库没有文件监视器，且沙箱（seatbelt/bwrap/landlock）是内核级允许/拒绝，不能"先备份再删"。

**只做单个撤销，不碰批量确认。** 否决：批量撤销是本次唯一真正破坏性的动作，确认是它最需要的东西。

**让全部撤销也逐文件确认。** 否决：一次撤销十个文件要过十次确认，会把读者训练成无脑点过。

## 后果

- **获得** 读者能看到会话删除过哪些文件，并尝试恢复；单个文件可撤销；全部撤销要过一次显式确认；行数终于描述真实的变更量。
- **代价（必须知道）** 恢复内容取自 git，因此**一个在会话开始前就有未提交改动的 tracked 文件被删除后，恢复出来的是 `HEAD` 版本**——那些未提交改动在 git 中没有任何记录，谁也找不回来。这不是可以后续修补的近似，而是所选方案的固有边界，已写入三个包的 README 限制段。
- **不变** `revertContent` 的反向补丁语义（保留会话之外他人做的改动）与 `changedFiles` 投影对写工具的识别规则都没有改动。
- **新增配置** `observeDeletions`（默认开启）：工作区不是 git 仓库时关掉它比留着一个永远不产生删除行的能力更诚实。
- **列表的两个来源** 现在会合流：`changedFiles` 折叠看不到被 shell 删除的路径（没有任何写调用命名过它），由修订记录的 `deleted` 条目补入，按 `firstSeq` 排序。这是删除行能出现在界面上的机制。

## 验证

Host（111 项）：`line-counts.spec.ts` 钉住单行修改报 `+1 -1`（旧实现报 `+3 -3`）、100 行文件改 1 行、尾换行差异；`git-deletions.spec.ts` 对**真实临时仓库**覆盖 tracked 删除、`python3 os.remove` 删除、重命名条目的源路径不被误读、路径含空格、非仓库；`git-restore.spec.ts` 对真实仓库覆盖已提交文件、staged-only 新文件、从未跟踪、非仓库、子目录、无尾换行内容；`capture-e2e.spec.ts` 新增 7 项，经真实 `tools/pre-execute`/`post-execute` waterfall 驱动 `bash` 形状的工具真正执行命令。

反向验证（关键）：把基线建立从 `pre-execute` 移出后重跑，`records a file a shell command deleted`、`records a file a script removed rather than rm`、`records the first deletion of a session, not only later ones` 三条立即失败——证明这些测试锁住的是删除捕获本身，而不是一条无论如何都能通过的路径。

Client（127 项）：确认框的三道门禁（未勾选时按钮禁用且不发出请求、取消不发请求、勾选后执行）、单文件撤销只命名该路径、进行中不重复发起、行数与已删除行的渲染、删除路径并入列表且不产生重复行、三个动作的可访问图标名。

门禁：`verify-client-ui-i18n`、`verify-package-invariants`、`verify-package-readme-limitations`、`verify-doc-budgets`、`verify-cordis-config` 均通过。
