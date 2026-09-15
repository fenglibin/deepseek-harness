# Agent Note: 共享 base 的默认文件编辑接口收敛为一套

Status: implemented

## Problem

`dsh-base` 同时选择了两套重叠的文件编辑接口：`packages/fs/tool-fs` 的 `read`、`write`、`edit`，以及 `packages/fs/tool-str-replace-editor` 的 `str_replace_editor`。重叠映射是 `view`↔`read`、`create`↔`write`、`str_replace`↔`edit`。

模型在等价接口之间做选择没有收益，而两套 schema 都在每次请求中占据提示词预算。基于 base 的 profile 因此默认携带第四套文件编辑工具。

同一份 base 还用 `fetch: false` 覆盖了 `packages/web/tool-web` 的 `Config.fetch` schema 默认值（该默认值本就是 `true`），使模型默认看不到 `web_fetch`。每个需要抓取能力的应用组合包都要重复同一条覆盖，而遗漏的组合只能搜索不能抓取。

## Decision

`packages/bundle/base/cordis.patch.yml` 只选择 `read`、`write`、`edit` 负责文件编辑，不再插入 `tool-str-replace-editor`；`packages/bundle/web-app` 中引用该条目的 `disabled: true` 覆盖同步删除，避免指向不存在的 id。

该工具的 `insert`（按行插入）与 `view` 的目录列举在 `tool-fs` 中没有对应物，因此包本身保留：显式插入该条目的组合仍可使用它。只写 `disabled: false` 的 patch 需要已有配置项才能生效，无法创建配置项，所以显式启用必须改用 `insert` 形式。`packages/bundle/base/package.json` 的依赖同步删除。

同一份 base 把 `tool-web` 的 `fetch` 从 `false` 改为 `true`，使基于 base 的 headless、SDK、ACP 与自定义 profile 一并继承 `web_search` 与 `web_fetch`，而 Web 应用继续按 agent preset 组合这两个工具。抓取的安全边界由提供方承担：`packages/web/web-fetch-http` 只接受不含内嵌凭据且不超过 2,048 字符的 `http:` 与 `https:` URL，只解析一次主机名，只要结果中有任何非公共单播地址就拒绝整个结果，并把连接固定到已校验的地址集合。这是 SSRF 防护，不是出网白名单：需要更严网络策略的部署在自己的 profile patch 中覆盖完整的 `tool-web` 配置。

独立负责工具选择的 `sdk-minimal` 与 minimal preset 不在本次范围内，继续保留它们自己的单工具默认值。

## 曾考虑的替代方案

**保留 `str_replace_editor` 并加一个开关。** 不予采用：开关只是把选择负担从模型移到用户，两套接口仍然并存，每请求的 schema 开销不减。

**删除 `packages/fs/tool-str-replace-editor` 包。** 不予采用：该工具的 `insert`（按行插入）与 `view` 的目录列举在 `tool-fs` 中没有对应物，显式插入它的部署仍是有效消费方。

**把 `dsh-tool-web` 的 `Config.fetch` schema 默认值改成 `false`。** 不予采用：它会反转工具包对所有消费方的契约，而本次只需改变共享 base 组合的选择。

**在 base 中保留 `fetch: false`，由每个应用组合包分别开启。** 不予采用：所有随附的完整产品都选择相同能力，重复配置没有表达产品差异，且新的 base-backed profile 容易遗漏这条覆盖。

## 后果

基于 base 的模型请求默认不再包含 `str_replace_editor` 的 schema 与提示词段落，并默认包含 `web_fetch` 的 schema 与抓取指引。需要前者的组合改用 `insert`；需要禁用后者的部署覆盖 `tool-web` 的 `fetch`。

抓取会拒绝访问非公共地址，因此依赖模型读取内网文档的部署在开启后这些请求会失败。

## Verification

`packages/bundle/base/tests/base.spec.ts` 三条用例：base 行集合不含 `tool-str-replace-editor` 且 `tool-web` 的 `fetch` 为 `true`；经 `applyEntryPatches` 验证显式 `insert` 仍注册该工具；平台 shell 栈门控不变。

`npx tsx scripts/verify-cordis-config.ts` 通过（157 个配置文件），证明删除条目后无悬空 id。

会话快照中的 `tool-schemas.expected.json` 与 `system-prompt.expected.md` 是生成产物，其模型可见输出随本次变更改变；本地快照套件在变更前已有 92 个与本次无关的失败（会话录制内含 record 时冻结的旧 header 文本，以及 fork 自建 `tool-delivery` 通知未进入录制），修复需要真实 API 重录，故本次以"不引入新的快照失败"为验证口径，经 stash 前后失败集对比确认零新增。
