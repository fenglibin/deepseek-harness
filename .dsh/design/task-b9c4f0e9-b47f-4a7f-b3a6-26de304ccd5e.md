- [revision 3] ## 现状（实测，非推断）

只有一个实现：`packages/client/ui-session-changes`（`conversation.input.dock`，order -10，标题 `本次修改的文件`）。全仓库只有这一处渲染该标题，也只有这一处 accept 逻辑；用户感觉到的"两套机制"是同一份代码在两种数据窗口下的表现。真正独立的第二个界面是每轮收尾助手消息下的"产物"芯片行（`ui-deliverables` → `conversation.chat.turnTail`），turn 局部、与 dock 不共享状态。

两个缺陷是独立的：

**缺陷 A —— 数据源是"已加载窗口"，不是整个会话。**
`SessionChangesDock.tsx:111` 的 `sessionChanges()` 遍历 `chat.timeline.turns`，而该 timeline 由 `ConversationNodeAssembler` 从 Session Controller 的 event window 组装（`assembly.ts:83`），窗口初始只有尾部 50 条消息（`session.ts:39` `PAGE_MESSAGES = 50`）。更早历史仅在用户滚到顶部时 prepend（`ChatView.tsx:570`）。用真实日志实测（54 turn 的会话）：

| | 首页窗口 | 整个日志 |
|---|---|---|
| turn 数 | 4 / 54 | 54 |
| 去重后被改文件 | 1 | 84 |

被切在窗口外的 turn 连 `turn/start` 都不在窗口里，`deliverables` Definition 只有 update 没有 start，因此不发布任何 turn 数据（`turn-deliverables.ts:211` 要求 `scope === 'turn'` 且有 state），半截 turn 也不计入。这正是"有时像整个会话、有时像最近一次需求"的来源。

**缺陷 B —— 接受集只按路径记录，没有版本概念。**
`SessionChangesDock.tsx:236` 的接受集是 `ReadonlySet<string>`，`:157` 是 `changes.filter(c => !accepted.has(c.path))`；而折叠结果 `ProducedChange` 只有 `{ path, operation }`，`produced.seq` 被丢弃。因此接受 a.txt 后 agent 再改 a.txt，它永远不会回到列表——与期望语义相反。

## 决策

### D1 全量事实改由 host 侧 projection unit 提供

客户端拿不到全量日志，而分页存在的意义就是不让它拿。本仓库对此已有既定解法与先例：`token-meter` 的 `turnUsage`、`session-stats` 的 `turnTiming`/`turnOutline` 都是为同一个"窗口折叠看不见被分页出去的 turn"问题而存在的 host 侧单元，其模块注释明确写着客户端窗口折叠只能折叠已加载的页。dock 照此办理：新增 host 侧单元 `changedFiles`，折叠完整持久日志，客户端用 `useProjection('changedFiles')` 读。

否决的两个替代方案：
- **dock 挂载时循环 `loadOlder()` 直到 `hasMore === false`**：把整个日志塞进浏览器内存，分页机制正是为防这件事而存在（实测该会话 54 turn 已达 139 万个逻辑事件）。
- **继续在客户端折叠、只是把 `produced.seq` 带上**：不解决窗口边界，只解决缺陷 B。

### D2 单元归 host 侧新包 `packages/fs/session-file-changes` 所有

折叠需要同时认识 `write`、`edit`（`tool-fs`）与 `str_replace_editor`（`tool-str-replace-editor`）三个工具，而这两个包互不拥有对方。可行的落点比较：

- **放进 `tool-fs`**：漏掉 `str_replace_editor`，不可接受。
- **两个包共享同一个 key 各折一半**：不可行——`SessionProjectionRegistry.register()` 对已存在的 key 只递增 `refs`、不安装新 def，第二个注册方的 `apply` 永远不会运行。
- **放进 `session-stats`**：它已在 web-app bundle 挂载、已有 `/client` 类型出口，但它的宪章是"全日志计数与墙钟时间"，文件变更不是统计量。
- **复用工具声明（`ctx.tools.get(name).presentCall` 的 `card: 'diff'`）代替硬编码工具名**：否决。`presentCall` 是纯函数但需要 tools 服务，在 projection 的纯同步折叠里跨服务读取会让重放依赖当时的工具集；而且 `str_replace_editor` 的 `insert` 命令返回 `card: 'generic'`（`kind: 'edit'`），`card === 'diff'` 单独判断会漏掉它。另外 `write` 创建文件时 `presentationMeta` 的 `diffs` 为空数组，连路径都没有。
- **放进 `packages/client/ui-deliverables` 的 host half**：否决。`packages/client/*` 是浏览器侧，把 host projection 单元放进去违反该目录的分层。

因此新包落在 `packages/fs/`（fs 组拥有文件变更语义），同时提供 `/client` 类型出口。它成为这套变更词汇的唯一 host 侧归属方；`ui-deliverables` 的客户端 turn 局部折叠（turn-tail 芯片与正文行内引用需要它）保持不动，两者服务不同界面。

### D3 单元状态按路径记录"最后一次变更的 seq"，接受集据此比较

单元状态为 `Record<path, { operation, lastSeq }>`（plain JSON，可进 projection cache），wire 值给出按首次出现排序的 `{ path, operation, lastSeq }[]`。客户端接受集记 `Record<path, seq>`：`pending = changes.filter(c => accepted[c.path] === undefined || c.lastSeq > accepted[c.path])`。这一个规则同时实现两条期望——接受某文件后它消失，该文件出现任何一次更新的成功写入/编辑调用就重新出现；"全部接受"是同一规则对所有当前 pending 路径的一次批量写入。

按用户确认：重新出现的触发条件是"该文件出现任何一次更新的成功写入/编辑调用"，不做内容比对。

### D4 接受状态保持组件本地，不持久化

按用户确认：随页面刷新丢失，维持现状范围。接受集仍由 dock adapter 持有（而非面板），以免面板在无 pending 时返回 null 导致集合在下次挂载时丢失——这条现有理由不变，只是集合类型从 `Set<string>` 变成 `Record<path, seq>`。

### D5 标题文案改为「修改的文件」

按用户确认。`locales.ts` 的 `title` 由 `本次修改的文件` 改为 `修改的文件`，避免"本次"被读成"这一次请求"。`summary`（`{count} 处变更`）不变。

### D6 每轮收尾的「产物」芯片行不动

按用户确认。那行本来就是 turn 局部的，语义正确，两个界面职责清晰。

## 待办清单

1. 新增 `packages/fs/session-file-changes`：变更词汇、`changedFiles` projection unit、`/client` 类型出口、README、invariant companion
2. web-app bundle 挂载该包
3. `ui-session-changes` 改为读 `useProjection('changedFiles')`，接受集改 `Record<path, seq>`
4. `locales.ts` 标题改「修改的文件」
5. 单测：单元折叠（成功/失败/去重/重排/多工具）、dock 接受与再变更重现、全部接受
6. README 与 Agent Note 同步
