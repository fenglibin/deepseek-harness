# Agent Note: 已归档会话设置页与归档集合的请求序号守卫

Status: implemented

## 问题

归档一个 Session 会把它从每一个 Workspace 分组界面中移除，而没有任何入口能把它带回来。归档集合是持久的显示过滤器，因此被隐藏的会话保留其日志、Workspace 记账位置与所在位置，但唯一的恢复途径是手工编辑领域状态。Client 此前根本没有列出已归档会话的地方。

同时存在一个与界面无关的竞态。`packages/api/workspace-controller/src/client/model.ts` 的 `ClientWorkspaceModel` 里，`archivedSessionIds` 有四个写入者：`archiveSession` 与 `unarchiveSession` 的一元回复、`follow()` 的 `archived` 增量（经 `replaceArchived`），以及 `replaceBaseline` 的完整基线。两个一元回复在成功时都无条件安装自己返回的集合，因此当一次回复晚于更新的请求、或晚于一个已推送的增量到达时，它会用陈旧集合覆盖新集合。

## 决策

归档集合的安装受一个单调递增的 `archiveRequestSeq` 守卫。`archiveSession` 与 `unarchiveSession` 各自在发起远程调用前自增该序号并记住自己的值，只有当它仍是当前值时，回复中的集合才被安装；`replaceBaseline` 与 `replaceArchived` 同样自增该序号，使任何更新的推送都作废在途的一元回复。较晚到达的陈旧回复因此不安装任何东西，集合保持在较新的请求或推送的结果上。

守卫与顺序守卫放在同一层：`insertBefore` 用 `orderRequestGeneration` 与 `orderFrameGeneration` 处理同一条一元／流竞态，归档集合用的是单一序号，因为基线与增量在这个投影里都是完整集合替换，二者对一元回复而言是同一种「更新的推送」。

新包 `@deepseek-ai/dsh-client-ui-settings-unarchive-sessions` 拥有恢复界面。它注册一个 id 为 `archived-sessions`、导航顺序为 25 的本地化 `settings.section` 贡献，把来自 `useWorkspaces` 的归档集合与来自 `useSessions` 的已加载 Session 摘要合并，按归档时间由新到旧列出，并显示为其记账的 Workspace 标题或未分组标签，以及相对最近活动时间；它按标题或 Workspace 名称过滤，并为每行提供一个取消归档操作。写入被拒绝时记录一条 console 诊断并保留该行以便再次尝试。缺失 Session 摘要的归档条目不产生行，因此页面绝不会渲染无法恢复任何东西的操作：该成员在归档集合里仍存在，只是在这里无法寻址，页面为此报告第三种空态，而不是把归档集合说成空的。

页面不持有 store 也不持有 transport。它读 `useWorkspaces` 与 `useSessions` 两个全局标准 prop，唯一的写入是注册处以 `ctx.uiWorkspace.unarchiveSession` 闭包注入的 `unarchive` 回调，符合 `packages/client/AGENTS.md` 的「web 层是纯呈现」与「组件永不接触 ctx」。

恢复操作所在的页面以已归档会话为主题，而已归档会话本身从每一个分组界面中隐藏，因此没有任何 Session 行能承载该操作。「已归档会话」页因此在设置导航中与「通用」「模型」「插件」并列，而该导航轨道本就带有本页在 `SettingsRoot.navIcon` 中声明的归档字形。

`{ type: 'archived', archivedSessionIds }` follow 增量本就携带完整集合，因此恢复复用它：Remote 应答在本地安装，其他每个 Client 都通过同一个增量收敛。本地 locale 是单语（`LOCALE_IDS` 为 `['zh']`），因此词典按 `ctx.locale.register(NS, { zh })` 注册单份中文，词条的 `time.*` 键名直接复用 `ui-primitives` 的 `relativeTime` 返回的 `unit` 取值。

## 考虑过的替代方案

**在 Session 行菜单放一个取消归档操作。** 行菜单拥有 Archive，但被恢复的会话在恢复之前没有可见的行，因此该操作在真正需要它的状态里无处安放；给每一行加一个禁用条目只是没有主体的装饰。

**页面自建 store 缓存归档集合。** 否决：归档集合已在 `ui-workspace` 的模型中、且经 stream 广播到所有 Client，再缓存一份会产生第二个真相源，并与「派生数据是框架 hook 数据上的纯函数」这条规则冲突。

**把会话已不存在的归档条目渲染为禁用行。** 这样的行可以解释缺口，却无法恢复任何东西；注册表与 Remote 虽然仍接受该 id，但页面只列出它能操作的条目，把遗留 id 留给未来的清理界面。

**先只做竞态修复、后做页面。** 否决：竞态修复解决的是「集合被陈旧回复覆盖」，而用户看不到已归档会话的根因是没有入口。两者一起交付才形成可验证的闭环，但实现顺序上守卫先落地，因为它不依赖页面且可独立测试。

**为守卫复用 `orderFrameGeneration` 一类的双序号。** 否决：那里的两个序号区分的是「本地乐观顺序」与「已提交的 Host 顺序」这两种身份不同的写入，而归档集合的四个写入者安装的都是同一种完整集合，单一序号即可表达「谁最新」，多一个序号只会多一个必须同步维护的状态。

## 后果

归档集合仍是恢复唯一重写的持久状态；Session 日志与 Workspace 记账位置都不受影响，被恢复的会话回到其记录的位置。

恢复界面受该页面能显示的内容限制：摘要未加载的已归档 id 没有行也没有取消归档操作，尽管注册表方法与 Remote 都接受它。通过自动化恢复仍然可用。页面不做批量取消归档、不做按 Workspace 分组，也不做排序切换，这些与官方一致。

序号守卫是有状态的：它只在 Client 模型实例的生命周期内有效，重连会以新基线开始新的一代。这在本地与「进程本地删除标记」的既有范围一致。

## 测试

`packages/api/workspace-controller/tests/model.client.spec.ts` 新增一条用例固定四种时序：后发的归档请求超越先发的取消归档请求时陈旧回复不安装、`replaceArchived` 推送的增量作废在途回复、`replaceBaseline` 的重建同样作废在途回复，以及没有更新的请求或推送时回复中的集合正常安装。

`packages/client/ui-settings-unarchive-sessions/tests/components.client.spec.tsx` 固定由新到旧的排序与工作区／最近活动时间文案、未分组标签、会话已不存在条目既不产生行也不产生操作、读取状态与三种空态（归档为空、无可恢复、查询无匹配）、按标题与工作区过滤，以及被拒绝时保留行并给出 console 诊断。`tests/browser-plugin.client.spec.tsx` 固定分节注册的 id、order、locale 命名空间与本地化 label、只声明实际使用的服务，以及插件卸载后词典随之释放。

`packages/client/ui-settings-general/tests/settings-root.client.spec.tsx` 的图标映射用例纳入新分支，断言四个已知 id 各自拥有不同字形而未知分节回落到齿轮。

`apps/web/tests/session-unarchive.e2e.ts` 覆盖真实线路上的完整往返：归档种子会话后从设置页恢复，断言页面行随空态离开、侧边栏行重新出现，并在重载后仍由 Host 基线重建。

## 相关

- [会话归档（注册表级全局集合）](2026-07-31-session-archive-global-set.zh.md)——归档集合的存储、注册表操作与全快照姿态仍由该记录持有；它预测的恢复面由本记录交付。
- [ui-settings-mcp 的 slot 与单语词典写法](../../../../packages/client/ui-settings-mcp/README.zh.md)——本包结构所依据的同类设置分节。
- [Web Client 子系统](../../../../docs/subsystems/web-client.zh.md)——slot 与 props 纪律的权威描述。
