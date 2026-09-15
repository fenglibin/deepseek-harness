# default-tool-set 规范增量

## MODIFIED Requirements

### Requirement: 默认文件编辑接口唯一

`dsh-base` 组合包 SHALL 只选择一套文件编辑工具。它 SHALL NOT 选择 `tool-str-replace-editor`。

`packages/fs/tool-str-replace-editor` 包本身 SHALL 继续可用：显式插入该条目的组合 SHALL 照常注册 `str_replace_editor`。

#### Scenario: base 不注册 str_replace_editor

- **WHEN** 一个基于 `dsh-base` 的 profile 启动
- **THEN** 其工具注册表 SHALL NOT 包含名为 `str_replace_editor` 的工具
- **AND** SHALL 包含 `read`、`write` 与 `edit`

#### Scenario: 显式插入的组合仍可使用 str_replace_editor

- **WHEN** 一个自定义 profile 的 patch 显式插入 `@deepseek-ai/dsh-tool-str-replace-editor`
- **THEN** 该组合 SHALL 注册 `str_replace_editor`
- **AND** 该工具的行为 SHALL 与本变更前一致

#### Scenario: 期望输出不再声明该工具 schema

- **WHEN** 会话快照重新生成
- **THEN** 其 `tool-schemas.expected.json` SHALL NOT 包含 `str_replace_editor` 的 schema
- **AND** 其 `system-prompt.expected.md` SHALL NOT 包含该工具的提示词段落

#### Scenario: 组合配置不引用已移除的条目

- **WHEN** 任一随附组合包或其应用 patch 引用 `tool-str-replace-editor`
- **THEN** 该引用 SHALL 采用 `insert` 形式而不是 `disabled` 覆盖
- **AND** `verify-cordis-config` SHALL 不报告悬空 id

### Requirement: minimal profile 的工具集不受本次变更影响

`packages/bundle/sdk-minimal` 与 `packages/preset/agent-presets/presets/minimal` SHALL 保持其既有工具集。`dsh-base` 的变更 SHALL NOT 改变 minimal profile 注册的工具。

#### Scenario: minimal preset 仍注册该工具

- **WHEN** 以 minimal preset 启动会话
- **THEN** 其工具清单 SHALL 与本变更前一致
- **AND** SHALL 包含 `str_replace_editor`

## ADDED Requirements

### Requirement: web_fetch 默认可用

`dsh-base` 组合包 SHALL NOT 用 `fetch: false` 覆盖 `dsh-tool-web` 的 schema 默认值。基于 base 的 profile SHALL 默认注册 `web_fetch`。

#### Scenario: base 默认注册 web_fetch

- **WHEN** 一个基于 `dsh-base` 的 profile 启动
- **THEN** 其工具注册表 SHALL 包含 `web_fetch`

#### Scenario: 部署可以关闭 web_fetch

- **WHEN** 部署方在自己的 profile patch 中把 `tool-web` 的 `fetch` 设为 `false`
- **THEN** 该 profile SHALL NOT 注册 `web_fetch`
- **AND** SHALL 继续注册 `web_search`
