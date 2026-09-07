# Agent Note：会话列表顺序由 Host 权威化

Status: implemented

## 问题

不同的浏览器打开 dsh Web 客户端时，即使指向同一个 Host、同一个工作区，看到的会话列表顺序也不一致。根因是会话的展示顺序被持久化在浏览器本地：`dsh-client-store` 的 `dsh.workspace.view.v6` 里保存了 `sessionOrderByAccount`（每个工作区 / 未分组 / 单列表的本地顺序记账）与 `sessionUpdatedAtByAccount`（一次性置顶的时间戳基线），而 `ui-workspace` 用 `reconciledSessionOrder` 拿这份本地顺序覆盖了 Host 权威的 `WorkspaceView.sessionIds` 手动顺序。此外，「最近更新」模式的活动置顶、未分组与单列表的手动拖拽顺序都只写浏览器本地，从不回写 Host。于是每个浏览器各自积累一份不同的顺序，即使同一工作区也互不一致。

## 决策

让会话顺序由 Host 权威 + 确定性派生，浏览器本地不再覆盖：

- **最近更新**模式：按每个 Session 的 `updatedAt` 降序排序，`id` 作并列裁决。这是确定性派生，无需任何本地状态，跨浏览器一致。
- **手动排序**模式：真实 Workspace 展示 Host 持久化的 `WorkspaceView.sessionIds`（`buildGroup` 的 `account` 顺序）；未分组与单列表没有 Host 账户，按最近更新时间排序（`recency`）。
- **拖拽**：仅手动模式下的真实 Workspace 会话可拖拽，结果写入 Host（`insertSessionBefore`）；最近更新模式、未分组、单列表不提供拖拽（`dragProps` 置为 `undefined`）。
- **Store 收窄**：`ui-workspace` 的 `createWorkspaceViewStore` 只保留纯 UI 偏好（`groupBy`、`orderBy`、`groupExpansion`、`archivedExpanded`），删除 `sessionOrderByAccount`、`sessionUpdatedAtByAccount`、`FLAT_SESSION_ORDER_KEY` 及 `syncSessionOrderAccount` / `setSessionOrder` / `retainAccountKeys`；persist key 升级到 `dsh.workspace.view.v7`，旧 key 里的本地顺序数据被整体弃用。保留 `retainGroupExpansionKeys` 清理被删除工作区留下的孤儿展开键。
- **`deriveGroups` 增加 `orderBy` 参数**（默认 `manual` 以保持纯函数默认语义），真实 Workspace 按 `manual`/`updated` 在 `account` 与 `recency` 之间选择；未分组始终 `recency`。

## 被否决的方案

**把「最近更新」的置顶结果也回写 Host。** 否决：未分组与单列表没有 Host 账户，无法回写；而「最近更新」本质是 `updatedAt` 的派生值，持久化一份会漂移的副本没有价值，还引入写放大。

**仅把默认的「最近更新」改成确定性排序，手动排序保持现状。** 否决：手动排序下的未分组与单列表仍跨浏览器不一致，且保留本地顺序覆盖需要继续维护 `reconciledSessionOrder` 与时间戳基线的全部复杂度，收益不成比例。

**给未分组 / 单列表也增加 Host 账户以持久化手动顺序。** 否决：后端改动大；未分组是「没有归属工作区」的兜底桶，单列表是跨工作区的临时视图，都不承载「用户手动固定顺序」的语义，按时间排序已足够。

## 影响

- **得到**：会话列表顺序跨浏览器一致；删除约三百行本地顺序记账逻辑（`nextSessionOrderAccount`、`reconciledSessionOrder`、`compareSessionRecency`、`orderedUngrouped` 等），store 与派生面更简单。
- **代价**：未分组与单列表失去手动拖拽排序，改为按最近更新时间排序；「最近更新」从「进入时完整排序 + 后续一次性置顶」简化为「始终按更新时间排序」，两者对用户可见的差异极小（最近更新的会话都在顶部）。
- **行为变化**：最近更新模式下会话行不再可拖拽；新建会话的 blank 行不再有「置顶」特效，而是按其 `updatedAt` 自然排序（新建即最新，通常在顶部）。
- **验证**：`ui-workspace` 11 个测试文件 163 条用例全绿；`tree.client.spec.ts` 与 `workspace-browser.client.spec.tsx` 中围绕本地顺序的用例改写为断言 Host 顺序 / 确定性 recency 排序 / `insertSessionBefore` 锚点参数。
