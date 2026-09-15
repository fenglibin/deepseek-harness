# 收敛默认工具集：移除 str_replace_editor 并默认开启 web_fetch

## 为什么

共享 `dsh-base` 组合包同时选择了两套重叠的文件编辑接口：`packages/fs/tool-fs` 的 `read`/`write`/`edit`，以及 `packages/fs/tool-str-replace-editor` 的 `str_replace_editor`。模型在等价接口之间做选择没有收益，而两套 schema 都在每次请求中占据提示词预算。官方在 `36a4665144` 依据同一条理由从 base 移除了后者。

同时 base 用 `fetch: false` 覆盖了 `dsh-tool-web` 的 schema 默认值，使模型默认看不到 `web_fetch`。`packages/web/tool-web/src/index.ts:40` 的 schema 默认值本就是 `true`，本地这行覆盖是唯一的关闭点。官方在 `0a0f9e59ff` 移除了它。

## 做什么

- 从 `packages/bundle/base/cordis.patch.yml` 删除 `tool-str-replace-editor` 条目（保留包本身）
- 同步删除 `packages/bundle/web-app/cordis.patch.yml` 中引用该条目的 `disabled: true` 覆盖（悬空 id 会导致配置校验失败）
- 删除 `packages/bundle/base/package.json` 中的该包依赖
- 把该文件中 `tool-web` 的 `fetch: false` 改为 `true`，并重写其上方注释
- 同步更新 `packages/bundle/base/tests/base.spec.ts` 的断言与受影响快照

## 不做什么

- 不删除 `packages/fs/tool-str-replace-editor` 包：显式插入该条目的自定义组合仍可使用。该工具的 `insert`（按行插入）与 `view` 的目录列举在 `tool-fs` 中没有对应物
- 不在 `dsh-tool-web` 层改动 schema 默认值：关闭点属于部署组合，不属于工具包契约
- 不为 `str_replace_editor` 保留兼容开关：两套接口并存正是本次要消除的状态
- **不移植 minimal profile 的移除**：官方把「base 移除」与「minimal 移除」拆成两个提交。本次只做前者，minimal preset 继续保留该工具，`apps/cli/tests/web-agent-presets.e2e.ts` 与 `apps/web/tests/minimal-preset.snapshot.ts` 的断言保持原样

## 影响

- `packages/bundle/base/cordis.patch.yml`：删 5 行、改 1 行、注释重写
- `packages/bundle/web-app/cordis.patch.yml`：删 3 行
- `packages/bundle/base/package.json`：删 1 行依赖
- `packages/bundle/base/tests/base.spec.ts`：`fetch: false` 断言改为 `true`，并新增工具集合断言
- `packages/bundle/base/README.zh.md`：补工具集描述与显式启用的 `insert` 示例
- `apps/cli/composition.md`：重跑生成器
- `snapshots/`：本地 35 个文件引用 `str_replace_editor`、10 个引用 `web_fetch`，按生成方式刷新

本变更只改组合包配置与期望输出，不涉及持久化 schema 或协议，属于 l1。
