# 会话变更撤销：分析结论与设计

## 背景

会话页面输入框上方的「修改的文件」列表由 `@deepseek-ai/dsh-client-ui-session-changes` 承担，其撤销能力由 `@deepseek-ai/dsh-api-session-file-revisions`（Host Remote）与 `@deepseek-ai/dsh-session-file-revisions`（捕获与持久化）提供。本次工作要回答三个问题并补齐差距：全部撤销的现状与安全性、单文件撤销的缺失、行内控件的呈现。

## 一、现状分析

### 1.1 全部撤销的链路

从按钮到落盘经过四层：

| 层 | 位置 | 行为 |
|---|---|---|
| 按钮 | `SessionChangesDock.tsx` 的 `revertAll` | 显示条件：Remote 存在，且至少一个列出路径有宿主修订记录 |
| 回调 | 同文件 `revertAll` | 置 `reverting`，调 Remote，按 `summarize` 显示冲突数或成功数 |
| Remote | `client/index.ts` 的 `revertAll` | 读 `ctx.sessions.list` 的 `current`，调 `remote.revert({ sessionId })`，不带 `path` |
| Host | `api/session-file-revisions/src/index.ts` 的 `revert` | `path` 缺席时取 `this.revisions(sessionId)` 全集，逐路径 `revertOne`，一个失败不阻塞下一个 |

**没有二次确认**：一次点击直接落盘。写盘走临时文件加 rename，删除走 `rm`，都不可逆。

**撤销对象不是列表显示的全集**，而是宿主修订记录里的路径。两个集合可能不一致：修订记录超过 `maxRecordBytes` 时不落盘、会话 id 的 `createdAt` 不一致时记录被 `retire`、重启后记录丢失。逐路径结果分四类：`reverted` 真正还原、`conflict` 多数情况未改动（但 `partial` 时已写盘）、`missing` 与 `unchanged` 未做任何事。

**不对称**：`list` 与 `diff` 都收显式 `sessionId`，唯独 `revertAll` 读全局 `current`。

### 1.2 撤销的语义边界

`revertContent(baseline, endState, current)` 是**反向补丁**而非覆盖：把「baseline → endState」的补丁反转后逐 hunk 打在当前内容上，因此会话之外他人所做的改动被保留。对不上上下文的 hunk 被跳过（容错一行），全跳过即 `conflict`。

**「会话删除的文件会被自动恢复」当前不成立**，原因是删除从未被捕获：

- `MUTATION_TOOLS` 只含 `write`、`edit`、`str_replace_editor`
- `str_replace_editor` 的命令集是 `view`/`create`/`str_replace`/`insert`，没有 delete
- DSH 没有专门的删除工具，agent 删文件只能走 bash 的 `rm`

因此 `rm` 既不进捕获记录，也不进 `changedFiles` 列表，被删文件在列表里根本不出现。能被撤销的是**会话新建**的文件（`origin: 'absent'`）。

### 1.3 单文件撤销

**Host 已支持**：`RevisionsRevertRequest.path` 可选，`revert()` 已按 `path` 分叉，`revertOne` 本就是单路径实现。缺的是 Client 两层：`RevisionRemote` 只暴露 `revertAll`，行上没有按钮，且 `reverting` 是全局布尔。

### 1.4 行数

`RevisionEntry` 已带 `added`/`removed` 并经 Remote 送达浏览器，但客户端 `refreshRecorded()` 只取 `entry.path` 建 Set，丢弃了两个数字。

且 `lineCounts()` 算的**不是变更行数，而是两侧文件的总行数**：

```ts
const removed = baseline === null ? 0 : baseline.split('\n').length - (baseline.endsWith('\n') ? 1 : 0)
const added = endState.split('\n').length - (endState.endsWith('\n') ? 1 : 0)
```

现有测试因 `'old\n' → 'new\nlonger\n'` 两侧内容整体替换而与变更行数巧合相等，掩盖了缺陷。`'a\nb\nc\n' → 'a\nB\nc\n'` 会报 `+3 -3`，正确应为 `+1 -1`。

## 二、已确认的需求决策

| 议题 | 决策 |
|---|---|
| 全部撤销二次确认 | 用 `RiskConfirmation`，需勾选确认框方可执行 |
| 单文件撤销 | 采用，图标用 `IconUndoOutline16`，不做二次确认 |
| 行数语义 | 修正为真正的变更行数 |
| 删除文件恢复 | 由 git 提供内容，不做 pre-execute 内容捕获 |
| 删除行的归属 | 只列「本会话期间变为已删除」的文件 |
| 非 git 工作区 | 列表照常显示删除行，恢复时提示不可恢复 |
| 恢复失败文案 | 分情况给具体原因 |

## 三、设计

### D1 删除的识别不解析 bash 命令，改问 git

识别「某路径被删除」是让删除行进入列表的前提。方案不是解析 bash 命令文本（`bash` 是任意代码，`find -delete`、`for` 循环、`python -c "os.remove"`、`git clean` 都无法穷尽），而是直接查询工作区的 git 状态。

实测证据（macOS，真机）：

- `git status --porcelain -z` 在 7302 文件的仓库上耗时 33ms
- 用 `python3 os.remove` 删除与 `find -delete` 删除的文件，git 均识别为 ` D <path>`，因此无需解析命令文本即可覆盖脚本与间接删除

**归属基线**：`git status` 报告的是工作区当前全部删除，不区分是否本会话所为。为避免把会话开始前就已删除、或会话外删除的文件列进来，会话内**首次**查询时记一份删除基线，之后只报告增量。基线按会话持有，随会话作用域生命周期。

### D2 删除需要新的 origin

现有 `FileRevision` 的 `endState` 是必填 `string`，无法表达「不存在」。新增 `origin: 'deleted'`，语义为 `baseline` 为原内容、`endState` 为删除时的最后内容。连带改动：`spec.ts` 的 `storedRevision` 枚举、`revertOne` 的恢复分支、列表的行状态。

`revisionsDomainSpec.version` 由 1 提升到 2。按仓库预发布立场不做兼容垫片，旧记录由 `per-record` 布局按会话丢弃。

### D3 恢复内容由 git 提供，且分三种来源

恢复不读捕获内容，而按以下优先级向 git 取：

1. `git status` 确认该路径当前确为已删除
2. 内容取自 `HEAD`：`git restore --source=HEAD -- <path>`
3. pending 新文件（index 有、HEAD 没有）：`git cat-file -p :<path>` 取回内容后写盘

实测确认：`git restore --source=HEAD` 对 index-only 路径**静默失败**，故必须先用 `git cat-file -p :<path>` 尝试。

失败分情形报告，均为实测得到的可判定条件：

| 情形 | 判据 | 文案方向 |
|---|---|---|
| 工作区不是 git 仓库 | `git status` 报 `not a git repository` | 工作区不是 git 仓库，无法恢复 |
| 文件未加入 git | `pathspec ... did not match any file(s) known to git` | 文件未加入 git，无法恢复 |
| 路径不在工作区内 | 复用既有 `containPath` 的 `EscapeError` | 沿用既有越界文案 |

**已知限制**：会话前存在未提交改动的 tracked 文件被删后，只能恢复到 HEAD 版本，那些未提交改动丢失。这是用户明确接受的限制，须写入 README 的 Known Limitations。

### D4 git 调用走无 shell 执行边界

复用既有的 `@deepseek-ai/dsh-native-command` 的 `runNativeCommand(command, args, signal)`：参数数组传递、无 shell、带 abort 传播。git 路径与参数均不由模型控制（路径来自已捕获的 revision 记录，并经 `containPath` 收敛），故不构成注入面。

新能力归属 `api/session-file-revisions`（Host Remote 所有者），因为它已在同一处做文件 IO（`readFile`/`rename`/`rm`/`writeFile`），git 恢复是同一职责的延伸，不新开包。

### D5 单文件撤销走同一个 `revert` 动词

不新增 Remote 动词：`revert` 已按 `path` 可选分叉，Client 只需把 `revision-remote.ts` 的接口从 `revertAll()` 改为 `revert(path?)`，并在行上接线。这样批量与单个走同一条已在 Host 测试覆盖的路径。

行内状态改为按路径的记录（`ReadonlySet<string>` 表示进行中的路径），替代现在的全局 `reverting` 布尔；批量撤销仍可沿用该集合判定"全部进行中"。

### D6 行数在 Host 用真正的行 diff 计算

`list` 动词的 `lineCounts` 改用 `diff` 包的 `diffLines`（该依赖已在 `fs/session-file-revisions` 声明）计算真实增删行数：

- `origin: 'existing'`：`diffLines(baseline, endState)` 统计 added/removed
- `origin: 'absent'`：全部为新增，removed 为 0
- `origin: 'unknown'`：两侧均为 0，因为无基线可比（保持现有诚实语义）

`diff` 包位于 `fs/session-file-revisions`，而计算发生在 `api/session-file-revisions`。选择把纯函数 `lineCounts` 下沉到 `fs/session-file-revisions`（与 `revertContent` 同居），由 api 包调用，避免为计算在 api 包新引入 `diff` 依赖。

### D7 图标与行内呈现

| 用途 | 图标 | 现状 |
|---|---|---|
| 接受 | `IconCheckOutline16` | 已有 |
| 撤销 | `IconUndoOutline16` | 已有 |
| 查看变更 | 新增 `IconEyeOutline16` | 需新增 |

新增图标按 `icons/index.tsx` 既有的 16px 网格与描边惯例绘制。按钮保留 `aria-label`（既有测试与可访问性均依赖它），文案经 `session-changes` locale 字典。

行内呈现顺序：路径、操作徽标、`+N -M` 行数、查看变更、接受、撤销。删除行以「已删除」替代行数显示。

### D8 二次确认复用 RiskConfirmation 与既有死文案

locale 字典里已有 `revertConfirm`（「撤销将把 {count} 个文件还原到本次会话开始前的状态，其它来源的改动会保留。」）但全仓库无人引用。本次接入它，并补确认框所需的标题、勾选文案、取消/确认标签。确认框在执行前展示将影响的文件数，与 `revertConfirm` 的 `{count}` 占位一致。

## 四、非目标

- 不做 pre-execute 内容捕获（用户已明确选择只用 git）
- 不新增模型可见的 delete 工具
- 不解析 bash 命令文本
- 不改 `revertContent` 的反向补丁语义
- 不改 `changedFiles` 投影折叠的既有写入工具识别规则

## 五、验证要求

- Host：`lineCounts` 的真实行数用例（含内容整体替换与单行修改两类，防止再次巧合相等）；git 检测与恢复的四条失败路径
- Client：单文件撤销接线、二次确认门禁（未勾选时确认按钮不可用）、图标与行数渲染、删除行状态
- 录制会话快照：涉及用户可见输出变化，须按仓库规矩更新无密钥快照
- `pnpm run test:gui` 与 `verify-client-ui-i18n` 覆盖 Client 面
