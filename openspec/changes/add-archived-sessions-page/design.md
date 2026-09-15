# 技术决策

设计草案见 [docs/design/upstream-diff-analysis.zh.md](../../../docs/design/upstream-diff-analysis.zh.md) 第 3.1 节。本文件记录决策编号，供 tasks.md 锚定。

### D1 竞态守卫用请求序号，先于 UI 单独落地

`WorkspaceArchiveValue` 的 `archivedSessionIds` 有四个写入者：`archiveSession`、`unarchiveSession` 的一元回复，`replaceArchived` 的 stream 增量，以及 `replaceBaseline` 的完整基线。

守卫方式是单调递增的 `archiveRequestSeq`：每个一元操作在发起前自增并记住自己的序号，回复到达时只有序号仍是当前值才安装结果。`replaceBaseline` 与 `replaceArchived` 也自增该序号，使任何更新的推送都作废在途的一元回复。

该修复不依赖新页面，可以独立测试与独立提交，因此先落地。

### D2 页面只注册一个 slot，不持有 store

页面注册 `settings.section`（`id: 'archived-sessions'`、`order: 25`、`label: () => t('nav')`、`locale: NS`），读 `useWorkspaces` 与 `useSessions` 两个全局标准 prop，唯一写入是注册期闭包注入的 `unarchive` 回调。

不新增 store：归档集合已在 `ui-workspace` 的模型里，`useWorkspaces(state => state.archivedSessionIds)` 直接读它。这符合 `packages/client/AGENTS.md` 的"web 层是纯呈现"与"组件永不接触 ctx"约束。

### D3 归档集合与已加载摘要取交集，无摘要的行不渲染

行派生把 `archivedSessionIds` 与已加载的会话摘要合并，并对**没有摘要的成员直接丢弃**。因此归档集合中记录已删除会话时不产生行，也不产生无法完成的取消归档操作。

`order: 25` 的选择依据：本地现有 `settings.section` 的 id 与 order 为 `general`/0、`models`/10、`plugins`/15、`prompt-commands`/16、`skills`/17、`agent-presets`/20、`mcp`/20。25 落在其后且不与任何现有值冲突。

### D4 单语词典，删除 en 分支

官方用 `ctx.locale.register(NS, { zh, en })` 注册双词典。本地 `packages/client/locale/src/locale-settings.ts:15` 的 `LOCALE_IDS` 为 `['zh']`，单语。

本包改写为 `ctx.locale.register(NS, { zh })`。`packages/client/locale/src/client/index.ts:362` 保留 `register(ns, locale, dict)` 重载，因此改动是机械的。`locales.ts` 的 `zh` 词典直接采用官方中文文案（15 个键，含 `time.*` 相对时间键），`ArchivedSessionsLocaleKey = keyof typeof zh` 保留。

### D5 相对时间复用 ui-primitives 的 relativeTime

本地 `packages/client/ui-primitives/src/index.ts:38` 导出的 `relativeTime` 返回 `{ unit, n }`，`unit` 取值为 `'now' | 'minutes' | 'hours' | 'days' | 'months' | 'years'`，与官方逐字一致。因此词典的 `time.now`、`time.minutes`、`time.hours`、`time.days`、`time.months`、`time.years` 键名可直接复用，无需适配层。

### D6 navIcon 分支加在 ui-settings-general

`packages/client/ui-settings-general/src/client/SettingsRoot.tsx:27-32` 的 `navIcon(id)` 按 id 返回图标，当前覆盖 `models`、`agent-presets`、`plugins`，其余落到默认图标。

新页面的图标分支加在这里，使用 `ui-primitives` 已导出的 `IconArchiveOutline20`。这与既有三个分支的写法一致，不引入新的注册机制。

## 被拒绝的方案

**在 ui-workspace 或 ui-sidebar 加恢复入口**：不采用。归档会话是设置类操作而非导航操作，官方把它放在设置页；放在导航区会与 Workspace 列表的语义混淆。

**页面自建 store 缓存归档集合**：不采用。归档集合已在 `ui-workspace` 模型中且经 stream 广播，再缓存一份会产生第二个真相源。

**只做竞态修复、不做页面**：不采用。竞态修复解决的是"集合被陈旧回复覆盖"，而用户看不到归档会话的根因是没有入口；两者一起交付才能形成可验证的闭环。但实现顺序上先做守卫（D1）。

**为归档集合加分页**：不采用。官方按归档时间倒序全量渲染，且页面带搜索框；本地会话规模不需要分页，引入它会增加状态与测试面。
