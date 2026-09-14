# 让「修改的文件」覆盖整个会话并支持接受后再次变更重现

## 为什么

输入框上方的「本次修改的文件」dock 目前折叠的是**客户端已加载的事件窗口**（尾部 50 条消息，更早历史只在用户滚到顶部时才分页补齐），而不是整个会话日志。用真实日志实测（54 turn 的会话）：首页窗口只含 4 个 turn、去重后 1 个被改文件，而整个日志有 54 个 turn、84 个被改文件。被切在窗口外的 turn 连 `turn/start` 都不在窗口里，`deliverables` Definition 因此不发布任何 turn 数据，半截 turn 也不计入——这就是列表"有时像整个会话、有时像最近一次需求"的来源。

第二个独立缺陷：接受集是 `ReadonlySet<string>`，只按路径记录，折叠结果也丢弃了 `produced.seq`。因此接受 a.txt 后 agent 再改 a.txt，它永远不会回到列表，与期望语义相反。

## 改什么

1. 新增 host 侧 `file-changes` 投影单元：折叠**完整持久日志**里每次成功的 `write` / `edit` / `str_replace_editor` 变更，按规范化绝对路径去重，给出该路径最后一次变更的 seq。客户端分页多少都不影响结果。
2. 「修改的文件」dock 改为优先读该投影（`useProjection('changedFiles')`）；投影缺席时回退到现有的窗口折叠，回退路径同样给出 `lastSeq`，两条路径共用同一条接受规则。
3. 接受集改为 `路径 → 已接受的 lastSeq`；某文件的 `lastSeq` 大于已接受值时它重新出现在列表。「全部接受」是对当前全部待处理路径的同一规则批量写入。
4. 标题文案由「本次修改的文件」改为「修改的文件」。

## 影响

- 新增包 `packages/fs/file-changes`（`@deepseek-ai/dsh-file-changes`）：变更词汇的唯一 host 侧归属方、`changedFiles` 投影单元、`/client` 类型出口、README、invariant companion。
- 挂载到 web-app bundle。
- 改动 `packages/client/ui-session-changes`：数据源、接受集类型、标题文案、README、单测。
- 会话日志、工具语义、磁盘内容都不变；接受仍然只是界面层面的隐藏。
- 不改动每轮收尾的「产物」芯片行（`ui-deliverables`）：它本来就是 turn 局部的，语义正确。
