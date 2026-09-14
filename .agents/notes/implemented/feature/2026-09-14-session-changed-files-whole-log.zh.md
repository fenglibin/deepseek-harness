# Agent Note: 「修改的文件」dock 改读全会话投影，接受按变更身份生效

Status: implemented

## Problem

输入框上方的「本次修改的文件」dock 有两个互相独立的缺陷，用户看到的症状是「有时像整个会话、有时像最近一次需求」，以及「接受过的文件再也不回来」。

**缺陷 A：数据源是客户端已加载的窗口，不是整个会话。** dock 折叠的是 `chat` 视图时间线里的 `deliverables`，而该时间线由 Conversation 引擎从 Session Controller 的事件窗口组装——窗口初始只有尾部 50 条消息（`PAGE_MESSAGES`），更早历史只在用户滚到列表顶部时才 prepend。被切在窗口外的轮次连 `turn/start` 都不在窗口里，`deliverables` Definition 只有 update 没有 start，因此不发布任何轮次数据，半截轮次也不计入。用本机一个 54 轮的会话实测：

| | 首页窗口 | 整个日志 |
|---|---|---|
| 轮次 | 4 / 54 | 54 |
| 去重后被改文件 | 1 | 84 |

**缺陷 B：接受集只按路径记录，没有变更身份。** 接受集是 `ReadonlySet<string>`，折叠结果也丢弃了 `produced.seq`。因此接受 `a.txt` 之后，agent 再改 `a.txt`，它永远不会回到列表——与用户期望正好相反。

## Decision

**全量事实改由宿主投影单元提供。** 新增 `packages/fs/file-changes`（`@deepseek-ai/dsh-file-changes`），注册 `changedFiles` 单元折叠**完整**持久日志。客户端拿不到全量日志，而分页存在的意义就是不让它拿到；本仓库对同一问题已有既定解法——`token-meter` 的 `turnUsage` 与 `session-stats` 的 `turnTiming`/`turnOutline` 都是为「窗口折叠看不见被分页出去的轮次」而建的宿主单元。dock 用 `useProjection('changedFiles')` 读，投影缺席时回退到窗口折叠，两条路径产出同一形状。

否决 **dock 挂载时循环 `loadOlder()` 直到 `hasMore === false`**：把整个日志塞进浏览器内存（实测该会话已达 139 万个逻辑事件），分页机制正是为防这件事而存在。

**变更词汇上移到新包，成为唯一归属方。** 判定「哪次工具调用改了哪个文件」需要同时认识 `write`/`edit`（`tool-fs`）与 `str_replace_editor`（`tool-str-replace-editor`），而这两个包互不拥有对方。此前该词汇由 `ui-deliverables` 在浏览器侧独占；若宿主单元另写一份，两份必须在「什么算一次变更」上永远一致。

否决的落点：放进 `tool-fs`（漏掉 `str_replace_editor`）；两个工具包共享同一 key 各折一半（`SessionProjections.register()` 对已存在的 key 只递增 `refs`、不安装新 def，第二个注册方的 `apply` 永不运行）；放进 `session-stats`（宪章是「计数与墙钟时间」）；放进 `packages/client/ui-deliverables` 的 host half（`packages/client/*` 是浏览器侧，仓库既有分工一律是宿主域包拥有投影、客户端 UI 包 type-only 消费）。

否决 **用 `ctx.tools.get(name).presentCall` 的 `card: 'diff'` 代替工具名判定**：在纯同步折叠里跨服务读取会让重放依赖当时的工具集；`str_replace_editor` 的 `insert` 命令返回 `card: 'generic'`（`kind: 'edit'`），单看 `card` 会漏掉它；`write` 创建文件时 `presentationMeta.diffs` 为空数组，连路径都没有。

**折叠按 seq 而不是按到达顺序。** 两次折叠（宿主 `recordMutation` 与浏览器回退 `sessionChanges`）都按** seq** 定界：最早的一次变更拥有 `operation` 与 `firstSeq`，最晚的一次拥有 `lastSeq`，因此结果与事件/轮次的到达顺序无关。

这是自检中修掉的两处真实缺陷的共同根因：原实现取「先到者」，历史页 prepend 后顺序可能早于时间顺序，会让 `lastSeq` 倒退——而 `lastSeq` 正是接受语义的比较基准，倒退就会隐藏读者并未接受的变更。宿主侧另有一处只比较 `operation` 与 `lastSeq` 的提前返回，会静默丢弃 `firstSeq` 的修正；该分支是死代码（`recordMutation` 只在新的成功结果结算时到达，此时 pending 必变）且带 bug，已删除。

**接受按 (路径, lastSeq) 比较。** wire 值给出每个路径的 `firstSeq`/`lastSeq`；接受集记 `Record<path, lastSeq>`，待处理集合为「`lastSeq` 大于已接受 seq」。这一条规则同时实现两条期望：接受某文件后它消失；该文件出现任何一次更新的成功变更就重新出现；「全部接受」是同一规则对当前全部待处理路径的批量应用。按用户确认，触发条件是「该文件出现任何一次更新的成功写入/编辑调用」，不做内容比对——因此 `write` 写回相同内容也算一次新变更。

**状态按路径收敛，不随事件增长。** 单元状态是 `{ cwd, files, pending }`：`files` 每个被改过的不同路径一条（实测样本 84），`pending` 只保留尚未拿到结果的变更调用（结果落地即移除，`turn/end` 丢弃该轮残留）。这是硬要求而非微优化——该状态会写入投影缓存，按事件增长的累加器会把整份会话日志塞进每个检查点文档，而单个轮次可以横跨整个会话。`cwd` 在 `init(header)` 时捕获一次，因此 `apply` 始终保持纯函数。

**接受状态保持组件本地。** 按用户确认，随页面刷新丢失。接受集仍由 dock adapter 持有而非面板（面板在无待处理时返回 null，集合放在面板上会在下次挂载时丢失）。

**标题改为「修改的文件」。** 按用户确认，「本次」在列表变成真正的会话级之后会被读成「这一次请求」。

## Alternatives considered

**每轮收尾的「产物」芯片行也一并改成会话级。** 否决：那一行本来就是轮次局部的，语义正确；用户确认只修 dock。本次只让它复用同一份共享词汇。

**按内容比对决定「是否真的改了」。** 否决：需要宿主侧读取并比较文件内容，成本与歧义都更高；用户确认按调用计数即可。

**接受状态持久化到宿主 settings。** 否决：用户明确选择保持现状范围（刷新即重置），持久化会引入一个新的宿主持久化面与设置 namespace。

## Consequences

改动过文件的会话现在显示「修改的文件」卡片，列出的是**整个会话**的变更文件，与客户端分页了多少历史无关。折叠键是规范化后的绝对路径，因此同一文件的绝对/相对两种拼写收敛为一条；`operation` 仍取最早一次。接受某文件把它从列表隐藏，该文件此后被 agent 再次改动时重新出现；全部接受同理。接受不动磁盘，且随页面刷新重置。

代价：
- 多了一个宿主包与一个投影单元（每次会话事件都要过一遍 `apply`，但它对无关事件返回同一状态引用，因此不产生下游工作）。
- 浏览器侧多了一条对 `dsh-file-changes/client` 的按值引用，需要在客户端 bundle 纯度门禁里放行——与 `dsh-token-meter/client` 同一机制。
- 没有该投影的组合（例如只挂浏览器包的装配）回退到窗口折叠，长会话仍会少报早期改动；这条限制写进了两个包的 README。

## Testing

- `packages/fs/file-changes/tests/fold.spec.ts`（36 条）：路径规范化，词汇判定，折叠（成功/失败/替换来源结果/去重与 seq 边界/参数边界/三工具并存/轮次中断/无工作区根/真实日志端到端），以及「按 seq 折叠」的回归（乱序重放结果一致、更早 seq 修正 firstSeq、更早的不同操作拥有 operation）。
- **真实日志校验**：用一份未修改的 54 轮真实会话日志（1115 个 `tool/call`、1119 个 `tool/result`）驱动折叠，与对原始日志的独立重算逐条比对——84 个路径与 operation 完全一致，零缺失零多余。该日志中 21 个文件被改动多次，正是「接受后重现」必须生效的场景。
- `packages/client/ui-session-changes/tests/e2e-business.client.spec.tsx`（3 条）：真实 Session 日志 → 真实 `changedFiles` 投影单元 → 真实 dock 组件，走完完整故事（接受 → 新回合加文件，已接受者保持隐藏 → 再改已接受者则重现；全部接受后仅被重新变更者回来；接受不调用宿主打开器即不动磁盘；重新挂载后列表重建）。此前的 dock 测试都喂的是手写的投影值，从未验证过单元自身产出的值能驱动业务规则。
- `packages/fs/file-changes/tests/loader-composition.spec.ts`（2 条）：REAL 组合下经真实 Loader 启动 session + projection registry + 本包，一个完整轮次的成功 `write` 经注册表读到该文件；函数插件无 default export。
- `packages/client/ui-session-changes/tests/session-changes-dock.client.spec.tsx`（43 条）：新增 `pendingChanges` 四条（无接受全待处理、接受后隐藏、更新变更重现、无新变更保持隐藏）、面板层「`lastSeq` 更新后重现」、adapter 层「全部接受后再次变更重现」、「优先用投影而非已加载窗口」、「投影缺席时回退」、「接受不调用宿主打开器」（接受不动磁盘）、「重新挂载后全部变更重新待处理」（刷新后重建），以及 node half 与 invariant companion 的包壳覆盖；原有的折叠、规范化、点击打开、失败呈现、注册注入全部保留并通过。
- `packages/client/ui-deliverables`（31 条）在删除本地重复解析后全部通过，界面行为不变。
- 三个包合计 114 条测试通过。`packages/fs/file-changes` 与 `packages/client/ui-session-changes` 的 `src/**` 在 `vitest --coverage` 下达到 100% 语句/分支/函数/行，无豁免。
- `tsc -b tsconfig.client.json` 与 `tsc -b tsconfig.host.json` 均干净（host 面抓到了一个测试里的 `turn/end` reason 字面量类型错误，已修）；`run-oxlint` 对三个包 0 警告 0 错误。
- 门禁：`verify-cordis-config`、`package-invariants`、`verify-client-packages`、`client-bundle-purity`、`verify-package-readme-limitations`、`verify-package-readme-model-experience`（新包部分）、`verify-subsystem-pages`、`verify-md-links`（新文件部分）、`verify-doc-budgets`、`verify-client-ui-i18n`、`gen-module-graph --check` 均通过。
- 未跑 `test:web`（需要全仓库 build 与浏览器）。本分支上另有若干与本次改动无关的既有失败，均已核实为我未触碰的文件：`verify-package-dependencies` 与 `verify-md-links` 报 `ui-settings-commands`，`verify-package-readme-model-experience` 报同一包，`verify-doc-refs` 报 `cordis-catalog.spec.ts` 与 `known-event-types.ts`，`verify-md-wrap` 报 `docs/design/chat-ux-polish.zh.md`，`verify-agent-note-format` 报两份既有的 `delivery-openspec-split` 与 `turn-timing-unbounded-buffer-regression`，`gen-client-catalog`、`gen-doc-graphs`、`verify-cordis-catalog`、`verify-type-equiv`、`verify-package-paths` 亦各自报既有漂移（已确认在 stash 掉本次改动后同样失败）。

## Deferred

- **只认第一方变更工具。** 模型通过 `bash` 或脚本改动的文件不会被列出。扩展该集合是改 `mutation.ts` 一处，但每个新工具都需要论证其参数形状。
- **不解析符号链接。** 规范化只统一拼写，不解析文件系统身份。
- **接受状态不跨刷新。** 用户明确选择保持现状范围；若要持久化，需要一个新的宿主持久化面。
