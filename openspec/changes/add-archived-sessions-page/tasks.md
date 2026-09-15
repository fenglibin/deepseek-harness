# 实施清单

## 1. 归档集合竞态守卫

- [ ] 1.1 在 `packages/api/workspace-controller/src/client/model.ts` 新增 `private archiveRequestSeq = 0` 字段，含说明"最新归档集合请求；更新的请求或推送使其作废"的 JSDoc (covers: archived-sessions/归档集合安装有请求序号守卫, design/D1)
- [ ] 1.2 在 `archiveSession`（该文件 `:165-172`）中于发起远程调用前自增并记住序号，回复到达时只在序号仍为最新时安装集合 (covers: archived-sessions/最新回复正常安装, archived-sessions/陈旧回复不覆盖新集合, design/D1)
- [ ] 1.3 在 `unarchiveSession`（该文件 `:178-184`）中施加同样的序号守卫 (covers: archived-sessions/陈旧回复不覆盖新集合, design/D1)
- [ ] 1.4 在 `replaceBaseline`（该文件 `:190-194`）与 `replaceArchived`（该文件 `:220-222`）中各自自增序号，使在途一元回复作废 (covers: archived-sessions/推送增量作废在途回复, design/D1)
- [ ] 1.5 在 `packages/api/workspace-controller` 的客户端模型用例中新增竞态场景：构造一次晚到的陈旧回复与一次先到的 stream 增量，断言集合不被覆盖 (covers: archived-sessions/陈旧回复不覆盖新集合, archived-sessions/推送增量作废在途回复, design/D1)

## 2. 已归档会话包

- [ ] 2.1 新建 `packages/client/ui-settings-unarchive-sessions/`，含 `package.json`（声明 `dsh.client.inject` 为 locale、ui-renderer、ui-session、ui-settings、ui-workspace）、`tsconfig.json`、`tsdown.config.ts`、`src/css-modules.d.ts` (covers: archived-sessions/设置页提供已归档会话恢复入口, design/D2)
- [ ] 2.2 编写 `src/client/locales.ts`：采用官方中文词典的 15 个键（含 `time.*` 相对时间键），导出 `zh`、`ArchivedSessionsLocaleKey`；删除 `en` 分支 (covers: archived-sessions/已归档会话分节区分三种空态, design/D4, design/D5)
- [ ] 2.3 编写 `src/client/index.ts`：声明 `LocaleNamespaceMap` 合并、定义 `NS = 'settings.archivedSessions'`、`inject = ['slots', 'locale', 'uiWorkspace']`，用 `ctx.locale.register(NS, { zh })` 注册单语词典，并向 `settings.section` 注册 `id: 'archived-sessions'`、`order: 25` 的分节 (covers: archived-sessions/设置页提供已归档会话恢复入口, design/D2, design/D3, design/D4)
- [ ] 2.4 编写 `src/client/ArchivedSessionsSection.tsx` 与 CSS module：读 `useWorkspaces(state => state.archivedSessionIds)`、`useWorkspaces(state => state.items)` 与 `useSessions(state => state)`，用 `useMemo` 派生行并对无摘要成员丢弃，渲染搜索框与逐行取消归档按钮 (covers: archived-sessions/列出已归档会话, archived-sessions/无摘要的归档成员不产生行, archived-sessions/搜索按标题或工作区过滤, design/D2, design/D3)
- [ ] 2.5 实现三种空态分支：归档集合为空、归档成员均无可恢复会话、查询无匹配 (covers: archived-sessions/已归档会话分节区分三种空态, design/D3)
- [ ] 2.6 实现取消归档写入：经 `inject` 工厂把 `ctx.uiWorkspace.unarchiveSession(sessionId)` 注入组件，组件点击后调用并处理失败 (covers: archived-sessions/取消归档后会话离开列表, design/D2)
- [ ] 2.7 补 `src/invariant.ts` 伴生入口，按本地规则说明该包不发布运行时检查的理由 (covers: archived-sessions/设置页提供已归档会话恢复入口)

## 3. 装配

- [ ] 3.1 在 `packages/client/ui-settings-general/src/client/SettingsRoot.tsx:27-32` 的 `navIcon` 加入 `archived-sessions` 分支，返回 `IconArchiveOutline20`，并补充图标导入 (covers: archived-sessions/设置页提供已归档会话恢复入口, design/D6)
- [ ] 3.2 在 `packages/bundle/web-app/cordis.patch.yml` 挂载 `@deepseek-ai/dsh-client-ui-settings-unarchive-sessions`，并在其 `package.json` 添加依赖 (covers: archived-sessions/设置页提供已归档会话恢复入口, design/D2)
- [ ] 3.3 在 `tsconfig.base.json` 的 paths、`tsconfig.client.json` 的 references 与 `apps/web/tsconfig.json` 的 references 中登记新包 (covers: archived-sessions/设置页提供已归档会话恢复入口)

## 4. 测试

- [ ] 4.1 新增 `packages/client/ui-settings-unarchive-sessions/tests/components.client.spec.tsx`：覆盖行派生与倒序、无摘要成员被丢弃、三种空态、搜索过滤、取消归档调用与失败处理 (covers: archived-sessions/列出已归档会话, archived-sessions/无摘要的归档成员不产生行, archived-sessions/已归档会话分节区分三种空态, archived-sessions/搜索按标题或工作区过滤, archived-sessions/取消归档后会话离开列表)
- [ ] 4.2 新增 `packages/client/ui-settings-unarchive-sessions/tests/browser-plugin.client.spec.tsx`：覆盖 slot 注册的 id、order、label 与 locale 命名空间，以及词典注册的释放 (covers: archived-sessions/设置页提供已归档会话恢复入口, design/D2, design/D3)
- [ ] 4.3 新增 `apps/web/tests/session-unarchive.e2e.ts` 端到端用例：归档一个会话后经设置页恢复，断言它重新出现在工作区导航，并按本地中文文案断言 (covers: archived-sessions/取消归档后会话离开列表, archived-sessions/列出已归档会话)
- [ ] 4.4 运行 `packages/client/ui-settings-general` 的既有测试，确认 `navIcon` 新增分支未影响既有图标映射 (covers: archived-sessions/设置页提供已归档会话恢复入口, design/D6)

## 5. 文档

- [ ] 5.1 编写 `packages/client/ui-settings-unarchive-sessions/README.zh.md`：包契约、注册的 slot、读取的 store、写入路径、单语词典说明，以及"已知限制与延期工作"（无批量操作、无分页、无按工作区分组） (covers: design/D2, design/D3, design/D4)
- [ ] 5.2 更新 `packages/api/workspace-controller/README.zh.md`，说明归档集合安装的请求序号守卫语义 (covers: archived-sessions/归档集合安装有请求序号守卫, design/D1)
- [ ] 5.3 更新 `packages/client/ui-settings-general/README.zh.md`（如有设置分节清单），登记新分节 (covers: archived-sessions/设置页提供已归档会话恢复入口, design/D6)
- [ ] 5.4 新增 Agent Note 记录归档集合四个写入者与序号守卫的决策依据 (covers: design/D1)
