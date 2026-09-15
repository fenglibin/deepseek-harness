# 技术决策

设计草案见 [docs/design/upstream-batch1-quick-wins.zh.md](../../../docs/design/upstream-batch1-quick-wins.zh.md)。本文件记录决策编号，供 tasks.md 锚定。

### D1 只从组合包移除条目，不退役包

`packages/fs/tool-fs` 的 `read`/`write`/`edit` 与 `packages/fs/tool-str-replace-editor` 的 `str_replace_editor` 提供重叠的文件编辑接口。重叠映射是 `view`↔`read`、`create`↔`write`、`str_replace`↔`edit`。

从 `dsh-base` 移除后者即可消除模型的选择负担与 schema token 开销，而包本身保留给显式插入它的组合。`insert`（按行插入）与 `view` 的目录列举在 `tool-fs` 中没有对应物，这是该包不被退役的原因。

官方 `36a4665144` 采用同一做法：`packages/fs/tool-str-replace-editor` 在官方仓库仍存在，只是不再被 base 选择。

### D2 移除必须与 web-app 覆盖同批

`packages/bundle/web-app/cordis.patch.yml:379-381` 有引用 base 条目的 `disabled: true` 覆盖。base 行删除后该覆盖指向不存在的 id。

官方三个提交的顺序证明这一点：`965adbb5cf` 先在 sdk-app 加 disable，`36a4665144` 从 base 移除并同步删除各应用的覆盖行，`63795eaa5c` 处理 minimal。悬空 id 会触发 `verify-cordis-config` 失败。

显式启用该工具的组合必须改用 `insert` 形式：只写 `disabled: false` 的 patch 需要已有配置项才能生效，无法创建配置项。该约束写入 base 的 README。

### D3 关闭点属于部署组合，不属于工具包

`packages/web/tool-web/src/index.ts:40` 的 `Config.fetch` schema 默认值是 `true`。本地 base 的 `fetch: false` 是唯一的关闭点，移除它即恢复工具包既定默认。

需要关闭联网读取的部署在自己的 profile `cordis.patch.yml` 中显式设回 `fetch: false`。patch 替换整个 config，因此必须重述想保留的键（如 `searchTimeoutMs: 60000`）。把 schema 默认值改成 `false` 会反转工具包的契约，并让所有未覆盖它的组合一起失去该能力。

### D4 快照按生成方式更新，不手工编辑

官方 `36a4665144` 的 stat 显示 50 个文件、+108/−2143，其中绝大多数是 `tool-schemas.expected.json`（每个 85 行）与 `system-prompt.expected.md`（每个 18-19 行）的期望输出。

这些是生成产物，必须经快照刷新路径重算。需逐文件判断：部分 `system-prompt.expected.md` 中的 `str_replace_editor` 出现在 JSON schema 片段里，若该快照的 `cordis.yml` 显式 insert 了编辑器，则对应内容不应删除。

### D5 不移植 minimal profile 的移除

官方把「base 移除」（`36a4665144`）与「minimal 移除」（`63795eaa5c`）拆成两个提交。后者同时删除了 `packages/bundle/sdk-minimal` 的 `fs-local` 行（编辑器是它唯一消费者）与 `packages/preset/agent-presets/presets/minimal/agent.cordis.yml` 的 `filesystem` 组。

本变更只做 base 部分。minimal preset 继续保留该工具，因此 `apps/cli/tests/web-agent-presets.e2e.ts`、`apps/web/tests/minimal-preset.snapshot.ts`、`apps/cli/tests/built-bin.e2e.ts` 与 `packages/client/ui-agent-preset/src/client/locales.ts:35` 的中文 preset 描述全部保持原样。

### D6 本地该包的 invariant 伴生入口不动

本地 `packages/fs/tool-str-replace-editor` 有 `src/invariant.ts` 与对应的 `"./invariant"` 导出（`tsconfig.base.json:570-571`），官方已删除该伴生。

本变更不改它，但需确认该伴生插件在包未被挂载时不报错：若伴生依赖 `invariants` 服务，未挂载时不应产生加载失败。

## 被拒绝的方案

**保留 `str_replace_editor` 但加开关**：不采用。开关只是把选择负担从模型移到用户，两套接口仍然并存。

**把 `dsh-tool-web` 的 `Config.fetch` 默认值改为 `false`**：不采用。它会改变工具包对**所有**消费方的契约，而本次只需改变 base 组合的选择。

**同时移除 minimal profile 的编辑器**：不采用。它牵动 preset、bundle 依赖与多个应用的断言，与「收敛 base 默认接口」是两个独立的变更，混在一起会让回归面难以界定。
