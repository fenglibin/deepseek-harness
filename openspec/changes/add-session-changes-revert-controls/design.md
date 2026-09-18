# 技术设计

## 现状事实（实测与代码确认）

- 全部撤销链路：`SessionChangesPanel` 的按钮 → `SessionChangesDock` 的 `revertAll` → `client/index.ts` 的 `revertAll`（读全局 `current`，调 `remote.revert({ sessionId })` 不带 path）→ Host `SessionRevisionController.revert`（取 `revisions(sessionId)` 全集逐路径 `revertOne`）。
- `revertContent` 是反向补丁而非覆盖：把 baseline→endState 的补丁反转后逐 hunk 打在当前内容上，因此保留会话外改动；对不上上下文的 hunk 跳过（`FUZZ_FACTOR = 1`），全跳过即 `conflict`。`partial` 结果**已经写盘**但仍报 `conflict`。
- `revisionsDomainSpec.version = 1`，`layout: 'per-record'`，按会话丢弃过期记录。
- `git status --porcelain -z` 在 7302 文件仓库耗时 33ms；` D <path>` 表示工作区删除。
- `git restore --source=HEAD -- <path>` 对 index-only 路径（pending 新文件）**静默失败**；`git cat-file -p :<path>` 能取回其内容。
- 非 git 目录报 `fatal: not a git repository`；未加入 git 的路径报 `error: pathspec ... did not match any file(s) known to git`。
- 会话前有未提交改动的 tracked 文件被删后，`git restore --source=HEAD` 恢复到 HEAD 版本，那些未提交改动丢失（git 中无记录）。

### D1 删除识别走 git 状态查询，不解析命令文本

bash 是任意代码：`find . -delete`、`for f in $(cat list); do rm $f; done`、`python -c "os.remove"`、`git clean -fd` 都无法用命令文本解析穷尽。git 状态查询是**结果**而非**意图**，因此天然覆盖脚本与间接删除。

归属基线：`git status` 报告工作区当前全部删除，不区分是否本会话所为。会话内首次查询时记一份删除基线，之后只报告增量；基线按会话持有，随会话作用域生命周期。这样会话开始前已删除、或会话外删除的文件不会被列入。

**备选与取舍**：解析 bash 命令文本可在执行前读回精确内容，能保住会话前的未提交改动，但覆盖率有硬上限且是启发式——错误会表现为"恢复出错误内容"而非"报告无法恢复"，比识别不出来更糟。用户明确选择只用 git，接受未提交改动丢失。

### D2 删除需要新的 origin 与存储版本提升

现有 `FileRevision.endState` 是必填 `string`，无法表达「不存在」。新增 `origin: 'deleted'`，语义为 `baseline` 存原内容、`endState` 存删除时的最后内容。

连带改动：`storedRevision` 的 enum 增加该值；`revertOne` 增加恢复分支；列表行以「已删除」替代行数。`revisionsDomainSpec.version` 1→2，按仓库预发布立场不做兼容垫片，旧记录由 `per-record` 布局按会话丢弃。

### D3 恢复内容由 git 提供，分三级取用

1. `git status` 确认该路径当前确为已删除（状态查询与恢复之间若被并发修改，git 自身会拒绝，不需额外护栏）。
2. 内容取自 `HEAD`：`git restore --source=HEAD -- <path>`。
3. index-only 路径：先 `git cat-file -p :<path>` 取内容再写盘。实测 `restore --source=HEAD` 对这类路径静默失败，故必须前置尝试。

失败分情形报告，判据均为实测得到的可判定字符串：

| 情形 | 判据 | 文案方向 |
|---|---|---|
| 工作区不是 git 仓库 | `not a git repository` | 工作区不是 git 仓库，无法恢复 |
| 文件未加入 git | `pathspec ... did not match` | 文件未加入 git，无法恢复 |
| 路径越出工作区 | 复用既有 `containPath` 的 `EscapeError` | 沿用既有越界文案 |

新增 `RemoteErrorDetailsMap` 条目承载这两个新失败码，使失败原因能跨 wire 到达客户端并由 locale 渲染。

### D4 git 调用走既有 no-shell 执行边界

复用 `@deepseek-ai/dsh-native-command` 的 `runNativeCommand(command, args, signal)`：参数数组传递、无 shell、带 abort 传播，已有调用先例（`directory-picker-native`）。被恢复路径来自已捕获的 revision 记录并经 `containPath` 收敛，不由模型控制，故不构成注入面。

能力归属 `api/session-file-revisions`：它已在同一处做文件 IO（`readFile`/`rename`/`rm`/`writeFile`），git 恢复是同一职责的延伸，不为一个动词新开包。

### D5 单文件撤销复用同一 Remote 动词

不新增动词：`revert` 已按 `path` 可选分叉，Host 分支已被现有测试覆盖。`RevisionRemote` 的 `revertAll()` 改为 `revert(path?)`，批量与单个走同一条路径，避免两套批次语义漂移。

行内进行中状态从全局 `reverting: boolean` 改为 `ReadonlySet<string>`（进行中的路径集合）；批量撤销按"全部路径都在集合内"判定禁用态。

顺带修正一处不对称：`revertAll` 目前读 `ctx.sessions.list` 的全局 `current`，而 `list`/`diff` 都收显式 `sessionId`。改为与该条目其余动词一致地使用注入的会话 id，消除"点击时活跃会话已切换则撤错会话"的窗口。

### D6 行数在 Host 用真实行 diff 计算

`lineCounts` 现按两侧文件总行数计算，与 JSDoc 承诺的 "lines between two texts" 不符，且现有测试因 `'old\n' → 'new\nlonger\n'` 两侧整体替换而与变更行数巧合相等，掩盖缺陷。改用 `diff` 包的 `diffLines`：

- `existing`：`diffLines(baseline, endState)` 统计 added/removed
- `absent`：全部为新增，removed = 0
- `unknown`：两侧均为 0（无基线可比，保持现有诚实语义）

**归属**：纯函数下沉到 `fs/session-file-revisions`（与 `revertContent` 同居，该包已声明 `diff` 依赖），由 api 包调用。避免为一个纯计算在 api 包新引入 `diff` 依赖。

### D7 行内控件与图标

| 用途 | 图标 | 来源 |
|---|---|---|
| 接受 | `IconCheckOutline16` | 既有 |
| 撤销 | `IconUndoOutline16` | 既有（回头箭头，比叉更贴近撤销语义） |
| 查看变更 | `IconEyeOutline16` | 新增，按 16px 网格与描边惯例绘制 |

行内顺序：路径、操作徽标、`+N -M` 行数、查看变更、接受、撤销。删除行以「已删除」替代行数。按钮保留 `aria-label`（既有测试与可访问性依赖它），全部文案经 `session-changes` locale 字典。

### D8 二次确认复用 RiskConfirmation 与既有文案

`RiskConfirmation` 已要求勾选确认框才启用主按钮，与"每次改动重大"的诉求一致。接入字典里已存在却无人引用的 `revertConfirm`，补标题、勾选、取消、确认四类标签，并把将影响的文件数代入 `{count}`。

## 非目标

不做 pre-execute 内容捕获；不新增模型可见的 delete 工具；不解析 bash 命令文本；不改 `revertContent` 的反向补丁语义；不改 `changedFiles` 投影的既有写入工具识别规则；不把 `revertAll` 的状态提示改为弹窗（保留条带内行内反馈）。
