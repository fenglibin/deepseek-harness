# 增加已归档会话设置页并修复归档集合竞态

## 为什么

本地已有完整的会话归档能力：`packages/client/ui-workspace/src/client/navigation.ts` 暴露 `archiveSession` 与 `unarchiveSession`（`:36-40`、`:196-198`），Host 侧 `packages/api/workspace-controller` 有 `@Remote('unarchiveSession')`（`index.ts:117`），归档集合也经 stream 增量广播到所有 Client（`feed.ts:113-116` 发布 `{ type: 'archived' }` 帧，客户端 `client/index.ts:108` 调 `replaceArchived`）。

但归档后没有任何恢复入口：会话从 Workspace 导航中隐藏，用户无处取消归档。官方新增 `packages/client/ui-settings-unarchive-sessions`（14 文件约 900 行）在设置页提供该入口。

同时存在一个竞态缺陷。`packages/api/workspace-controller/src/client/model.ts` 的 `archiveSession`（`:165-172`）与 `unarchiveSession`（`:178-184`）在收到成功回复后无条件调用 `installArchived(result.value.archivedSessionIds)`。而 stream 增量与基线替换（`replaceBaseline` `:190-194`、`replaceArchived` `:220-222`）也调用 `installArchived`。当一次一元回复晚于更新的请求或晚于一个已推送的增量到达时，它会用陈旧集合覆盖新集合。官方在 `76941d0085` 用请求序号守卫修复（`model.ts` 净 +16 行）。

## 做什么

- 在 `packages/api/workspace-controller/src/client/model.ts` 加入 `archiveRequestSeq` 序号守卫
- 新增 `packages/client/ui-settings-unarchive-sessions` 包，注册 `settings.section` 的已归档会话页
- 在 `packages/client/ui-settings-general/src/client/SettingsRoot.tsx` 的 `navIcon` 加入该页的图标分支
- 把新包挂载进 `packages/bundle/web-app`

## 不做什么

- 不改 Host 侧的归档语义与 stream 帧形状：缺陷在客户端模型的安装时机，不在协议
- 不做批量取消归档、排序切换或按 Workspace 分组过滤：官方页面只有搜索框与逐行取消归档
- 不改 `settings.section` slot 契约：本地 `packages/client/ui-settings/src/client/contract/slots.ts:54` 与官方一致
- 不做归档集合的分页或虚拟滚动：官方按归档时间倒序全量渲染

## 影响

- `packages/api/workspace-controller/src/client/model.ts`：+16 行序号守卫
- `packages/client/ui-settings-unarchive-sessions/`：新增包（含 `src/client/index.ts`、`locales.ts`、`ArchivedSessionsSection.tsx`、CSS module、测试与 README.zh.md）
- `packages/client/ui-settings-general/src/client/SettingsRoot.tsx`：`navIcon` 加一行分支与一个图标导入
- `packages/bundle/web-app/cordis.patch.yml` 与 `package.json`：挂载新包
- `tsconfig.base.json`、`tsconfig.client.json`、`apps/web/tsconfig.json`：登记新包
- e2e：新增归档会话页的端到端用例

新页面的文案来自 `settings.archivedSessions` 命名空间，本地单语词典只含 `zh`。归档集合是持久状态且跨 Client 广播，竞态修复影响状态安装时机，定为 l1。
