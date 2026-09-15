# 上游能力移植执行状态

本文档记录 13 个 openspec 变更的落地进度与验证结论，供跨轮次接续。

## ⚠️ 关键环境发现：src/ 下的陈旧构建产物会遮蔽 TypeScript 源码

**现象**：仓库里存在 **107 个未被跟踪但已被 `.gitignore` 覆盖的 `src/*.js`** 文件（连同 107 个 `.js.map`、154 个 `.d.ts`、107 个 `.d.ts.map`），时间戳统一为 `09-15 19:48`（早于本次执行）。

**影响**：Vite/Vitest 的默认 `resolve.extensions` 把 `.js` 排在 `.ts` 之前，因此 `import '@deepseek-ai/dsh-X'` 会解析到 `packages/.../src/index.js`（陈旧编译产物）而不是 `src/index.ts`。**测试因此长期跑在旧代码上**，源码修改不生效，且不会有任何报错。

**已确认的证据**：
- 在 `session-projection/src/index.ts` 顶部加 `console.log` 标记，测试输出的 marker 来自 `src/index.js` 而非 `.ts`。
- 清掉这 107 个文件后，`packages/session/session-projection` 的 47 个测试立即全部通过（此前 1 个失败，且失败原因看起来像真实逻辑错误）。
- 同类现象让 `packages/core/agent-loop` 从「4 个失败」变成「1 个失败」。

**处置**：已执行 `find packages apps -path "*/src/*.js" -delete` 与对应的 `.js.map` / `.d.ts` / `.d.ts.map` 清理，当前 `src/*.js` 计数为 0。这些都是构建垃圾，删掉是安全的。

**由此修正的结论**：此前用 `git stash` 做的「预先存在」判定**不可靠**——`git stash` 只回退被跟踪文件，不影响这些未跟踪的 `.js` 产物，因此「stash 前后失败数相同」不能证明失败与改动无关。

## 环境事实（执行前侦察）

- 工作区分支 `new-feature-20260905`。
- `npx tsx scripts/verify-changed.ts` 可用，用于按改动面跑最小验证集。
- `npx tsx scripts/verify-cordis-config.ts` 可用（157 个配置文件）。
- `openspec validate <id> --strict` 可用。
- **测试按包名解析到 `src`（经 tsconfig paths），不解析 `lib`**——这已用 marker 双向确认。构建产物 `lib/` 只影响 `dsh` 进程启动与打包路径。

## 进度

| # | change | 状态 | 关键验证 |
|---|---|---|---|
| 1 | `update-default-tool-set` | ✅ 完成并提交 | base 3 测试、`verify-cordis-config` 157 文件、快照零新增失败 |
| 2 | `add-http-proxy-support` | ✅ 完成并提交 | 门禁 `no bare dispatcher`、178 测试、`tsc -b` 通过 |
| 3 | `add-coverage-partition-canonicalization` | ✅ 完成并提交 | 46 测试（含 4 个新 canonical 用例）、代理清理实测生效 |
| 4 | `refactor-experimental-release-policy` | ✅ 完成并提交 | 53 测试通过；四项发布判据逐元素相同 |
| 5 | `update-session-projection-view-gate` | ✅ 完成并提交 | **509 测试通过**（含 host spec） |
| 6 | `add-agent-loop-message-freeze-reuse` | ✅ 完成并提交 | 3 个新测试，**守卫已验证**：无优化时失败（spread 23>4），有优化时通过 |
| 7 | `add-typert-lazy-schema-materialization` | ⬜ 未开始 | — |
| 8 | `add-lazy-require-utility` | ⬜ 未开始 | — |
| 9 | `add-deferred-native-dependency-loading` | ⬜ 未开始 | — |
| 10 | `update-slash-menu-shared-ranker` | ⬜ 未开始 | — |
| 11 | `add-archived-sessions-page` | ⬜ 未开始 | — |
| 12 | `add-client-keyed-standard-hooks` | ⬜ 未开始 | — |
| 13 | `add-mcp-resource-access` | ⬜ 未开始 | — |

## 额外事故与修复（重要）

清理 debris 时我的 `find ... -delete` 范围过宽，**误删了 47 个被 git 跟踪的手写 `.d.ts` 声明文件**（各 `src/css-modules.d.ts`、`vite-env.d.ts`、`ripgrep.d.ts`、`turndown-plugin-gfm.d.ts` 等真实源码）。已通过 `git checkout HEAD~1 -- <file>` 全部恢复并单独提交（`4a1fec02f3`），恢复后 `tsc -b` 通过、工作区干净。

**教训**：清理 `src/` 下的产物时，必须先用 `git ls-files` 排除被跟踪文件，不能只按后缀匹配。

## 已提交记录

- `835a16e94f` 变更 1 + 差异扫描与四批方案文档
- `c920bf371b` 变更 2 + 3（http-proxy 包、app-boot/CLI 接线、覆盖率规范化、代理清理）
- `65f05222fa` 变更 6（消息冻结复用）
- `5fdbc42fce` 变更 5（投影 view 引用闸门）+ debris 清理
- `4a1fec02f3` 恢复被误删的 47 个手写 `.d.ts`

## 已知的非本次引入问题（清理 debris 后需重新评估，勿轻信此前结论）

- `packages/core/agent-loop/tests/scope-lifecycle.spec.ts`：清理 debris 后仍有 1 个失败，需重新判定归属。
- `scripts/verify-package-invariants.ts`：`packages/delivery/tool-delivery` 缺 `dsh-invariants` devDependency。
- `scripts/verify-md-links.ts`：3 条断链（`.agents/notes` 两处、`ui-settings-commands` 一处）。
- `scripts/verify-agent-note-format.ts`：2 条既有 note 格式违规。
- `scripts/check-workspace-constraints.ts`：6 条错误（版本号与 `files` 字段）。
- 快照套件 92 个失败：会话录制内含 record 时冻结的旧 header 文本 + fork 自建 `tool-delivery` 通知未进入录制；修复需真实 API 重录（`DSH_SNAPSHOT=record`），本地无 `DEEPSEEK_API_KEY`。

## 待收尾事项

- 变更 5 需要：更新 `README.zh.md`、`docs/subsystems/session-projection.zh.md`、`invariant.ts` 描述，写 Agent Note，勾选 tasks。
- 变更 4 需要：由我独立复核子代理的四项判据与门禁结果。
