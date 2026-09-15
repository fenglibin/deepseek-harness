# 上游能力移植执行状态

本文档记录 13 个 openspec 变更的落地进度与验证结论，供跨轮次接续。

## 环境事实（执行前侦察）

- 工作区分支 `new-feature-20260905`，执行开始时干净（HEAD `cb0d22a168`）。
- `npx tsx scripts/verify-changed.ts` 可用，用于按改动面跑最小验证集。
- `npx tsx scripts/verify-cordis-config.ts` 可用（157 个配置文件）。
- `openspec validate <id> --strict` 可用。

## 阻塞发现：92 个快照失败为预先存在

`npx vitest run --config vitest.snapshot.config.ts` 有 **92 个失败**，与本次移植无关：

- **已验证**：把 `packages/bundle/base` 与 `packages/bundle/web-app` 的改动 `git stash` 后，失败集**完全相同**（92 vs 92，`comm` 对比无差异）。
- **根因一**：会话录制 `.jsonl` 内含 record 时冻结的 `request/header` 文本。例：fixture 中 `mark_analysis_done` 的描述缺 "record_spec(kind: design)" 字样，而源码已更新。
- **根因二**：fork 自建的 `tool-delivery` 插件注入的 "delivery size grading" 通知未进入任何录制。
- **`DSH_SNAPSHOT=refresh` 无法修复**：它只从既有录制重新派生 sidecar，不重写录制内的 header；实测刷新后仍 57 个失败，二次运行反而升到 60（不收敛）。
- **修复需要 `DSH_SNAPSHOT=record`（真实 API 调用）**：本地未设置 `DEEPSEEK_API_KEY`，也无 `.env`。

**结论**：本任务的验收以「不引入新的快照失败」为准，而非「快照全绿」。每个变更都用 stash 前后失败集对比来证明零新增。

## 进度

### 第 1 批

| change | 状态 | 验证 |
|---|---|---|
| `update-default-tool-set` | 实现中 | base 测试 3 个通过；`verify-cordis-config` 157 文件通过；快照零新增失败 |
| `add-http-proxy-support` | 未开始 | — |
| `add-coverage-partition-canonicalization` | 未开始 | — |
| `refactor-experimental-release-policy` | 未开始 | — |

#### `update-default-tool-set` 已完成的改动

- `packages/bundle/base/cordis.patch.yml`：删除 `tool-str-replace-editor` 条目；`tool-web` 的 `fetch: false` → `true`；重写该行上方注释。
- `packages/bundle/web-app/cordis.patch.yml`：删除 `- id: tool-str-replace-editor / disabled: true` 覆盖（避免悬空 id）。
- `packages/bundle/base/package.json`：删除 `@deepseek-ai/dsh-tool-str-replace-editor` 依赖。
- `packages/bundle/base/tests/base.spec.ts`：`fetch` 断言改为 `true`；新增断言 base 行集合不含该工具；新增用例经 `applyEntryPatches` 验证显式 `insert` 仍可注册该工具。

**未做**：`apps/cli/package.json` 的依赖未删——官方也保留它（`grep` 确认官方同行为），因为它是 CLI 插件清单而非 base 组合。
**未做**：minimal preset 与 `sdk-minimal` 未动——按 design/D5，本变更不含 minimal 移除。
