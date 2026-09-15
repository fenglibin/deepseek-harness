# 实施清单

## 1. base 组合包配置

- [ ] 1.1 从 `packages/bundle/base/cordis.patch.yml` 删除 `tool-str-replace-editor` 条目（`:493-497`，含 `maxOutputChars: 16000` 配置） (covers: default-tool-set/base 不注册 str_replace_editor, design/D1)
- [ ] 1.2 同步删除 `packages/bundle/web-app/cordis.patch.yml:379-381` 中引用该条目的 `disabled: true` 覆盖，避免悬空 id (covers: default-tool-set/组合配置不引用已移除的条目, design/D2)
- [ ] 1.3 删除 `packages/bundle/base/package.json:118` 的 `@deepseek-ai/dsh-tool-str-replace-editor` 依赖 (covers: default-tool-set/base 不注册 str_replace_editor, design/D1)
- [ ] 1.4 把同文件 `tool-web` 条目的 `fetch: false` 改为 `fetch: true`（`:534`），并重写其上方注释（`:507-516`）使其描述 base 默认提供搜索与抓取 (covers: default-tool-set/base 默认注册 web_fetch, design/D3)

## 2. 包契约保持不变

- [ ] 2.1 确认 `packages/fs/tool-str-replace-editor` 未改动，其 `package.json`、`src/`、README 保持原样 (covers: default-tool-set/显式插入的组合仍可使用 str_replace_editor, design/D1)
- [ ] 2.2 确认该包的 `src/invariant.ts` 伴生入口与 `"./invariant"` 导出未改动，且该伴生插件在包未被挂载时不报错 (covers: default-tool-set/显式插入的组合仍可使用 str_replace_editor, design/D6)
- [ ] 2.3 确认 `packages/web/tool-web/src/index.ts` 的 `Config.fetch` schema 默认值仍为 `true`，未因本次变更反转 (covers: default-tool-set/部署可以关闭 web_fetch, design/D3)
- [ ] 2.4 确认 minimal preset 相关文件未改动：`packages/bundle/sdk-minimal/cordis.patch.yml`、`packages/preset/agent-presets/presets/minimal/agent.cordis.yml`、`packages/client/ui-agent-preset/src/client/locales.ts` (covers: default-tool-set/minimal profile 的工具集不受本次变更影响, design/D5)

## 3. 测试

- [ ] 3.1 更新 `packages/bundle/base/tests/base.spec.ts:46` 的 `tool-web` 断言，从 `{ fetch: false }` 改为 `{ fetch: true }` (covers: default-tool-set/base 默认注册 web_fetch, design/D3)
- [ ] 3.2 在 `packages/bundle/base/tests/base.spec.ts` 新增用例断言 base 行集合不含 `tool-str-replace-editor`，且显式 `insert` 该条目的组合仍注册该工具 (covers: default-tool-set/base 不注册 str_replace_editor, default-tool-set/显式插入的组合仍可使用 str_replace_editor, design/D1)
- [ ] 3.3 在 `packages/bundle/base/tests/base.spec.ts` 新增用例断言 base 默认注册 `web_fetch`，并断言 patch 设 `fetch: false` 后只注册 `web_search` (covers: default-tool-set/base 默认注册 web_fetch, default-tool-set/部署可以关闭 web_fetch, design/D3)
- [ ] 3.4 确认 `apps/cli/tests/web-agent-presets.e2e.ts`、`apps/web/tests/minimal-preset.snapshot.ts` 与 `apps/cli/tests/built-bin.e2e.ts` 未改动且通过（本变更不含 minimal 移除） (covers: default-tool-set/minimal profile 的工具集不受本次变更影响, design/D5)
- [ ] 3.5 运行 `pnpm run verify-cordis-config`，确认 base 与 web-app 组合无悬空 id (covers: default-tool-set/组合配置不引用已移除的条目, design/D2)

## 4. 快照与生成物

- [ ] 4.1 经快照刷新路径重新生成受影响期望输出（本地 35 个文件引用 `str_replace_editor`、10 个引用 `web_fetch`），确认 `tool-schemas.expected.json` 不再含该工具 schema (covers: default-tool-set/期望输出不再声明该工具 schema, design/D4)
- [ ] 4.2 逐文件检查 `snapshots/**/system-prompt.expected.md`：显式 insert 编辑器的快照不应删除对应内容，其余按刷新结果处理 (covers: default-tool-set/期望输出不再声明该工具 schema, design/D4)
- [ ] 4.3 逐文件检查 `snapshots/session/*/cordis.yml` 中被删除的配置行，确认它们只对应 `tool-str-replace-editor` 条目 (covers: default-tool-set/期望输出不再声明该工具 schema, design/D4)
- [ ] 4.4 重跑 `apps/cli/composition.md` 的生成器，确认其中的工具清单同步更新 (covers: default-tool-set/base 不注册 str_replace_editor, design/D4)

## 5. 文档

- [ ] 5.1 更新 `packages/bundle/base/README.zh.md`：`:48` 工具集描述补联网抓取并移除编辑器，`:52` 后新增用 `insert` 形式显式启用编辑器的示例，并说明只写 `disabled: false` 的 patch 无法创建配置项 (covers: default-tool-set/base 不注册 str_replace_editor, default-tool-set/base 默认注册 web_fetch, design/D2)
- [ ] 5.2 在 `packages/fs/tool-str-replace-editor/README.zh.md` 补充"已知限制与延期工作"：说明该工具不再被 `dsh-base` 默认选择，需要它的组合须显式 `insert` (covers: default-tool-set/显式插入的组合仍可使用 str_replace_editor, design/D1)
- [ ] 5.3 新增 Agent Note 记录"默认文件编辑接口唯一"的决策依据，含重叠映射与 `insert` 保留理由 (covers: design/D1, design/D2, design/D5)
- [ ] 5.4 新增 Agent Note 或更新既有记录，说明 base 默认提供联网抓取及其 SSRF 防护边界与内网地址拒绝行为 (covers: default-tool-set/base 默认注册 web_fetch, design/D3)
