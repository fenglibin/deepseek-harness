# 技术决策

### D1 全量事实由 host 侧投影单元提供，客户端不再从窗口折叠

客户端只能看到已加载的事件窗口（尾部 50 条消息，更早历史按需 prepend），而分页存在的意义就是不让它拿到全量日志。本仓库对同一个问题已有既定解法：`token-meter` 的 `turnUsage` 与 `session-stats` 的 `turnTiming`/`turnOutline` 都是为此而建的 host 侧单元，其模块注释明确写着客户端窗口折叠只能折叠已加载的页。新增 `changedFiles` 单元折叠完整持久日志，dock 用 `useProjection('changedFiles')` 读。

否决：
- **dock 挂载时循环 `loadOlder()` 直到 `hasMore === false`**——把整个日志塞进浏览器内存；实测该会话 54 个 turn 已达 139 万个逻辑事件。
- **继续客户端折叠、只把 `produced.seq` 带上**——只修接受语义，不修窗口边界。

### D2 变更词汇的宿主侧归属方是新包 `packages/fs/file-changes`

「哪次工具调用改了哪个文件」是一个事实，目前由 `ui-deliverables` 在客户端独占（`turn-deliverables.ts` 硬编码 `write`/`edit`/`str_replace_editor` 与各自的参数形状）。若新单元另写一份同样的解析，两份必须在「哪些调用算变更」上永远一致——正是仓库禁止的重复归属。

因此把该词汇上移到 host 侧新包 `@deepseek-ai/dsh-file-changes`（`packages/fs/`，fs 组拥有文件变更语义），由它同时服务：
- host 侧 `changedFiles` 投影单元（全量日志折叠）；
- `ui-deliverables` 的客户端 turn 局部折叠（turn-tail 芯片与正文行内引用），经该包 `/client` 出口取同一份解析。

这样只有一个所有者，两个界面读同一份判定。

否决的落点：
- **放进 `tool-fs`**——漏掉 `str_replace_editor`（属另一个包）。
- **两个工具包共享同一 key 各折一半**——`SessionProjectionRegistry.register()` 对已存在的 key 只递增 `refs`、不安装新 def，第二个注册方的 `apply` 永不运行。
- **放进 `session-stats`**——它已在 web-app 挂载且已有 `/client` 出口，但宪章是「全日志计数与墙钟时间」，文件变更不是统计量。
- **放进 `packages/client/ui-deliverables` 的 host half**——`packages/client/*` 是浏览器侧；仓库既有分工一律是 host 域包拥有投影、客户端 UI 包 type-only 消费（`ui-goal`/`dsh-goal`、`ui-delivery`/`dsh-delivery`、`ui-chat`/`dsh-session-stats`）。
- **用 `ctx.tools.get(name).presentCall` 的 `card: 'diff'` 代替工具名判定**——否决：在纯同步折叠里跨服务读取会让重放依赖当时的工具集；`str_replace_editor` 的 `insert` 返回 `card: 'generic'`（`kind: 'edit'`），单看 `card` 会漏；`write` 创建文件时 `presentationMeta.diffs` 为空数组，连路径都没有。

### D3 单元状态按路径收敛，不随事件增长

状态为 `{ cwd, changes: Record<path, { operation, firstSeq, lastSeq }> }`，键是按会话 cwd 规范化后的路径（与客户端 `canonicalMutationPath` 同一规则，故两者折叠结果一致）。规模由「会话改过多少个不同文件」决定（实测样本 84），而不是由事件数决定（139 万）——这是该状态可进投影缓存的前提，与 `turnUsage`「每个关闭的 attempt 一条、而非每个事件一条」是同一条纪律。cwd 取自 `init(header)` 并存入状态，使 `apply` 保持纯函数。

### D4 接受集按 (路径, lastSeq) 比较

wire 值给出按首次出现排序的 `{ path, operation, firstSeq, lastSeq }[]`。客户端接受集记 `Record<path, lastSeq>`，待处理集合为 `changes.filter(c => accepted[c.path] === undefined || c.lastSeq > accepted[c.path])`。这一条规则同时实现两条期望：接受某文件后它消失；该文件出现任何一次更新的成功变更调用（`lastSeq` 增大）就重新出现；「全部接受」是对当前全部待处理路径按同一规则的批量写入。

按用户确认，触发条件是「该文件出现任何一次更新的成功写入/编辑调用」，不做内容比对——因此 `write` 写回相同内容也算一次新变更。`operation` 保持现有的「最早一次」语义，不随重现改变。

### D5 投影缺席时回退到窗口折叠，两条路径共用同一接受规则

`useProjection('changedFiles')` 为 `undefined` 表示能力缺席（宿主单元未挂载，或基线/帧尚未携带该 key）。此时 dock 回退到现有的 `sessionChanges(conversation, cwd)` 窗口折叠，并同样为每条记录算出 `lastSeq`（窗口内该路径最后一次变更的 seq）。两条路径产出同一个形状，接受规则与面板渲染因此只有一份。

### D6 接受状态保持组件本地，不持久化

按用户确认：随页面刷新丢失，维持现状范围。接受集仍由 dock adapter 持有而非面板——面板在无 pending 时返回 null，集合放在面板上会在下次挂载时丢失。这条现有理由不变，只是集合类型从 `Set<string>` 变为 `Record<path, lastSeq>`。

### D7 标题文案改为「修改的文件」

按用户确认。`locales.ts` 的 `title` 由「本次修改的文件」改为「修改的文件」，避免「本次」被读成「这一次请求」。`summary`（`{count} 处变更`）不变。

### D8 每轮收尾的「产物」芯片行不改语义

按用户确认。那行本来就是 turn 局部的，语义正确；本次只让它复用 D2 的共享词汇，界面行为不变。

### D9 浏览器 bundle 需要放行新包的 `/client` 出口

`ui-deliverables` 的客户端折叠要按值引用新包的解析函数，而 `packages/client/tsdown.client.ts` 的 `INLINE_SAFE` 只放行「无运行时共享身份的浏览器安全纯折叠」白名单。新包 `/client` 正是这一类（纯函数、无单例状态），因此把 `@deepseek-ai/dsh-file-changes/client` 加入 `INLINE_SAFE`——与 `@deepseek-ai/dsh-token-meter/client` 同一条既有机制。
