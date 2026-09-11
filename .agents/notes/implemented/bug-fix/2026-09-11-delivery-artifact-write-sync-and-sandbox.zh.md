# Agent Note: 交付纪律 — 产物写盘同步与沙箱作用域修复

Status: implemented

## Problem

对一个真实的长会话（L2 任务，deepseek-v4.1-flash 模型）复盘时，暴露了交付纪律子系统三处产物写盘缺陷：

1. `record_tasks` 只把实现清单写进 `delivery-tasks` 会话投影，从不落盘到 `openspec/changes/<change_id>/tasks.md`。而 OpenSpec 与推进门禁读取的是磁盘文件，于是左侧浮卡（投影）、模型实际执行、OpenSpec 拆分出的 `tasks.md` 三方各自漂移。`checklistMismatch` 只在 `advance to implemented` 时比对「已完成数/总数」，既拦不住漂移，也拦不住「投影已勾选、磁盘全未勾选」的假一致。
2. `record_change`/`record_design`/`record_spec` 的写盘 helper（`writeArtifact`/`appendArtifact`）调用 `ctx.fs.writeText` 时未传第 5 个参数 `sandboxPolicy`。在 `workspace-write` 沙箱下，`SandboxedFileSystem.checkedTarget` 因而回退到 `ctx.sandboxPolicy.resolve()`（无 session），`workspaceRoot` 退化为 harness 进程的 `process.cwd()` 而非 session 的 `cwd`。当两者不同（典型部署：DSH 从仓库启动、用户项目在别处）时，`.dsh/*` 与 `openspec/*` 写入一律被 `FS_SANDBOX_DENIED` 拒绝——模型只能靠 bash 旁路再写一份，这正是「设计文档先写到 `docs/plans` 又补一份到 `.dsh/design`」的根因。
3. `guidance()` 未说明设计文档的分层约定：完整调研/设计稿是业务产物、应落普通目录；`record_design` 记录的是指向它们的摘要，而非重复整篇文档。模型因此分不清该写几份。

## Decision

补齐三处，均落在 `@deepseek-ai/dsh-tool-delivery`，不动领域状态机与门禁语义：

- `record_tasks` 变为 async：对 l2 任务，先 `readTasksMarkdown` 读盘一次，`orderItemsByMarkdown` 把模型传入的清单按盘上顺序重排（保证左浮卡投影与 `tasks.md` 顺序一致），`recordTasks` 存内存，再 `renderTasksMarkdown` 渲染 + `writeTasksMarkdown` 写盘。渲染按 `content` 与盘上每行（剥除 `(covers: …)` 标注后）精确匹配，匹配行仅翻转 checkbox，保留标题、空行、分组与标注；未匹配项追加到末尾；`in_progress` 视作未勾选；输出以单个换行结尾。读/写失败抛 `DELIVERY_TASKS_WRITE_FAILED`。`checklistMismatch` 报错区分「total 漂移」（content 不匹配或增删项，建议 `record_spec(kind: tasks)` 重写或对齐 content）与「状态不同步」（仅 checkbox 状态漂移，建议重新 `record_tasks`），各给出针对性修复指引。
- 新增 `sandboxPolicyFor(ctx, agent)`：通过 `ctx.reflect.get('sandboxPolicy')`（与 `optionalSettings` 同法，避免未注入时 proxy trap 报错）取 `SandboxPolicyService`，`resolve({ session: agent.session })` 得到以 session `cwd` 为 `workspaceRoot` 的 policy。`writeArtifact`/`appendArtifact`/`writeTasksMarkdown` 写盘时把它作为 `writeText` 的第 5 个参数传入；bare backend 下该 service 缺失，返回 `undefined`，行为与旧代码一致。
- `guidance()` 增加一句：完整分析/设计稿写到普通项目路径（如 `docs/`），`record_design` 记录指向它们的简洁摘要而非重复全文。

配套：`DeliveryErrorCode` 新增 `DELIVERY_TASKS_WRITE_FAILED`；`tool-delivery` 增 peer/dev 依赖 `@deepseek-ai/dsh-sandbox`、`@deepseek-ai/dsh-sandbox-policy`、`@deepseek-ai/dsh-fs-sandbox` 及 `tsconfig.json` 的 `sandbox-policy` project reference；24 个含 delivery guidance 的会话快照中，16 个新版本（含 `mark_analysis_done` 句）同步补上新增提示句，8 个历史版本（不含该句、插入点不存在）保持不变。

## Alternatives considered

**让 `checklistMismatch` 每次 `record_tasks` 都强制对账，而非只写盘同步。** 否决：写盘同步后投影与磁盘天然一致，逐次对账成为冗余的第二次读取；防御性对账仍保留在 `advance to implemented` 一处，用于拦截带外编辑。

**在 `SandboxedFileSystem` 层让无 session 的 `resolve()` 也能命中正确 root。** 否决：无 session 时回退到 `process.cwd()` 是有意设计的 agentless fallback；delivery 工具持有 session，正确做法是把 session 传下去，而非改动 fallback 语义破坏其它调用方。

**放行 `.dsh` 目录的沙箱写入，绕过拒绝。** 否决：`.dsh` 下的写操作仍应受沙箱约束，只是必须以 session `cwd` 为边界判定；放行等于拆除对这类路径的防护。

**方案 A 之外，再让 `create_delivery_task` 落一个空的 `.dsh/design/<id>.md` 占位。** 否决：占位文件不消除「完整文档写哪、摘要写哪」的认知错位，反而引入一份无内容文件；提示层澄清即可覆盖该场景。

## Consequences

- **获得** 左浮卡、实际执行、OpenSpec `tasks.md` 三方一致（每次 `record_tasks` 落盘，顺序与状态都对齐）；`workspace-write` 沙箱下交付工具能写 `.dsh/*` 与 `openspec/*`；模型不再重复写完整设计文档；`checklistMismatch` 报错能区分内容漂移与状态不同步，模型据此快速定位根因。
- **代价** l2 任务的每次 `record_tasks` 多一次读+一次写 `tasks.md`（单文件、按需触发）；`tool-delivery` 新增两个 peer 依赖；沙箱回归测试需把 session `cwd` 与 fs 默认 `cwd` 置于 `/tmp`/`os.tmpdir()` 之外（`writableRoots` 会放行临时区，否则测试恒真）。
- **验证** delivery 包 207 条单测全绿（含 3 条沙箱回归测试；反证：临时让 `sandboxPolicyFor` 返回 `undefined` 时 3 条全失败，证明锁定真实根因）；`renderTasksMarkdown` 6 条、`orderItemsByMarkdown` 5 条纯函数单测覆盖匹配、标注保留、追加、去重与顺序；新增 2 条 `checklistMismatch` 报错区分用例锁定「内容漂移」与「状态不同步」两条路径。
