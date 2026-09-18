# 补齐会话变更列表的撤销能力

## 为什么

会话输入框上方的「修改的文件」列表当前只有三个动作：接受、查看变更、全部撤销。调查发现三处硬伤。

**全部撤销没有二次确认。** 一次点击直接落盘，写盘走临时文件加 rename、删除走 `rm`，都不可逆。locale 字典里其实已经写好一条 `revertConfirm` 文案（「撤销将把 {count} 个文件还原到本次会话开始前的状态，其它来源的改动会保留。」），但全仓库无人引用——设计意图存在，接线从未发生。

**撤销不了会话删除的文件。** 捕获层 `MUTATION_TOOLS` 只含 `write`、`edit`、`str_replace_editor`，后者的命令集（`view`/`create`/`str_replace`/`insert`）没有 delete，DSH 也没有专门的删除工具，因此 agent 删文件只能走 bash 的 `rm`。而 `rm` 既不进捕获记录、也不进 `changedFiles` 投影，被删的文件在列表里根本不出现，读者无从知道会话删过什么，更谈不上恢复。这些路径的原始内容也不在 DSH 的任何记录里。

**撤销不了单个文件。** Host 侧其实已经支持：`RevisionsRevertRequest.path` 可选，`revert()` 已按 `path` 分叉，`revertOne` 本就是单路径实现。缺的是 Client 两层——`RevisionRemote` 只暴露 `revertAll`，行上也没有按钮。

另有两处呈现问题：行数数据虽然已由 Host 算好并经 Remote 送达浏览器，但客户端只取了 `path` 建 Set，把数字丢弃；而 Host 侧的 `lineCounts` 算的并不是变更行数，是**两侧文件的总行数**，一个只改一行的文件会显示成 `+100 -100`。

## 改什么

1. **全部撤销加二次确认。** 复用仓库既有的 `RiskConfirmation`（需勾选确认框方可执行），接入那条已存在的 `revertConfirm` 文案，并在确认框里展示将影响的文件数。

2. **删除的文件进入列表并可恢复。** 识别不解析 bash 命令文本（bash 是任意代码，`find -delete`、`for` 循环、`python -c`、`git clean` 无法穷尽），改为查询工作区的 git 状态：实测 `git status --porcelain -z` 在 7302 文件的仓库上耗时 33ms，且用 `python3 os.remove` 与 `find -delete` 删除的文件 git 均识别为 ` D <path>`，脚本与间接删除同样覆盖。只列「本会话期间变为已删除」的文件——会话内首次查询记一份删除基线，之后只报增量。恢复内容由 git 提供，不需要会话记录原始内容。

3. **单文件撤销接线。** 不新增 Remote 动词，复用 `revert` 已支持的可选 `path`，让批量与单个走同一条已测试路径。行内状态从全局 `reverting` 布尔改为按路径的集合。

4. **行数修正为真实增删行数**，并与新增的图标一起呈现。

## 影响

- `packages/fs/session-file-revisions`：`capture.ts`（删除事件捕获）、`spec.ts`（存储枚举与域版本 1→2）、`types.ts`、`index.ts`（`lineCounts` 下沉并改用真实行 diff）。
- `packages/api/session-file-revisions`：`index.ts`（删除恢复的 git 取用与失败分类）、`types.ts`（新的失败码与 origin）。
- `packages/client/ui-session-changes`：`SessionChangesDock.tsx`、`revision-remote.ts`、`locales.ts`、`SessionChangesDock.module.css`、`src/client/index.ts`、`tests/`、`README.zh.md`。
- `packages/client/ui-primitives`：新增 `IconEyeOutline16`。
- 存储域版本提升按仓库预发布立场不做兼容垫片，旧记录由 `per-record` 布局按会话丢弃。
- 不新增模型可见的工具，不改 `changedFiles` 投影的既有写入工具识别规则，不改 `revertContent` 的反向补丁语义。

## 已知限制

会话前存在未提交改动的 tracked 文件被删除后，只能恢复到 HEAD 版本，那些未提交改动丢失——它们在 git 里没有任何记录。此限制须写入包 README 的 Known Limitations。
