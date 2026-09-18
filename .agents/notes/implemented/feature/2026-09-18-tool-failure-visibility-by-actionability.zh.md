# Agent Note: 会话页面按可处置性白名单展示工具失败行

Status: implemented

## Problem

会话页面上频繁出现用户无法处置的工具失败行：

```
Error: cannot edit ".../git-restore.ts": file changed since it was read — its current content follows; retry now.
Error: cannot write ".../line-counts.spec.ts": file no longer exists — re-read the file, then retry
Error: offset 670 is out of range for ".../SessionChangesDock.tsx" (655 lines)
Error: delivery verification blocked: acceptance command 1 of 1 has no recorded run: - /deep-selfcheck: ...
```

这些失败的成因全部落在模型自己撰写的输入上：陈旧的变更版本、越界的读取位置、未满足的交付前置条件。读者既未参与该失败，也没有处置手段，而模型收到同一段结果后即可自行纠正。呈现在时间线上只制造疑惑，并让一次很快自愈的尝试永久留在记录里。

此前的判定是「黑名单隐藏」：只列 `FS_EDIT_NOT_FOUND`、`FS_AMBIGUOUS_EDIT` 两码，其余失败一律可见。该方向有两处结构性缺陷。其一，它只能覆盖作者事先想到的错误码：工具持续增加，每个新码都要回来补一次白名单。其二，按码判定无法处理语义复用的码——`read` 的越界与目标缺失当时共用 `FS_NOT_FOUND`，两者可处置性相反。

实测规模（本项目 `~/.dsh/sessions/` 下 140 个会话、29,038 次 `tool/result`，其中 492 次失败）支持这一判断：

| 错误码 | 次数 | 处置方 |
|---|---|---|
| `FS_NOT_OBSERVED` | 153 | 模型 |
| `FS_STALE_VERSION` | 118 | 模型 |
| `DELIVERY_GATE_BLOCKED` | 43 | 模型 |
| `FS_EDIT_NOT_FOUND` | 27 | 模型 |
| `DELIVERY_ALREADY_EXISTS` | 21 | 模型 |
| `FS_NOT_FOUND` | 12 | 混合：10 次目标缺失、2 次越界 |
| `FS_AMBIGUOUS_EDIT` | 10 | 模型 |
| 其余长尾 12 类 | 31 | 模型 |
| 无 `error.code` 的裸 `Error` | 52 | 模型（多为参数错误） |

需要读者介入的失败实测 6 次（`FS_SANDBOX_DENIED` 2、`NO_PROVIDER` 2、`GOAL_TOOL_AUTHORITY_REQUIRED` 1、`SEARCH_FAILED` 1），占全部失败的 1.2%。

## Decision

判定反转为「可处置白名单展示」。`HiddenToolFailureProjector`（`packages/client/ui-chat/src/client/conversation-nodes/hidden-tool-failure.ts`）只保留白名单内的失败行可见，其余已结算的顶层 `isError` 调用标记 `visibility: 'hidden'`。

白名单是读者能够处置的集合：

- `FS_SANDBOX_DENIED`、`FS_PERMISSION_DENIED` —— 环境或权限拒绝，读者可能需要放宽策略。
- `SANDBOX_APPROVAL_UNAVAILABLE` —— 提权需要审批而审批路径根本用不了，只有读者能解决该配置。
- `NO_PROVIDER` —— 部署缺少可用提供方，模型重试无法修复。
- `GOAL_TOOL_AUTHORITY_REQUIRED` —— 需要读者授予的权限。
- `SEARCH_FAILED` —— 搜索工具自身不可用，而非模型的查询有误。

### 提权审批失败按「路径是否可用」分流

`sandbox escalation ... no approval channel is available` 实测出现，且抛的是裸 `Error`，因此按无码规则会被隐藏——但它的处置方是读者（需配置审批通道），与白名单要保护的类别直接冲突。`dsh-sandbox` 的 `escalation.ts` 因此新增 `SANDBOX_APPROVAL_UNAVAILABLE`，覆盖三种审批路径不可用的状态：未组装审批服务、调用无 agent 可路由、无可用应答者。

「用户拒绝提权」与「取消」不携带该码，虽然它们产生同一类消息文本。那是用户对**那一次询问**的答复，模型照常继续，把它回显为红色错误只是噪音——这与「审批路径不可用」是部署事实有本质区别。该区分只有依据码才表达得出来，按消息文本无法分辨。

工具的通用审批路径（`core/tools/src/index.ts` 的 `serviceAsk`，`ctx.get('approval')` 未组装或调用无 agent）同样产生「no approval channel is available」，但不携带该码：能够显示页面的部署必定组装了审批服务，而 headless 部署没有读者在场，因此那些分支不是「读者能处置」的场景。这条路径的 deny 结果只带 `message` 不带 `code`（同文件 `denialReason` 分支），该不对称由此成为有意选择而非疏漏。

不携带 `error.code` 的失败也隐藏。实测 52 次这类失败中，文本如 `old_string and new_string must differ`、`change_id must be verb-led kebab-case`，全部是模型自身的参数错误；把它们排除在默认隐藏之外，等于让最大的一类噪音留在页面上。

白名单制而非黑名单制的独立证据来自 `DELIVERY_POST_HOOK_FAILED`：它实测出现 7 次，但该码在当前源码中已不存在（`advance_delivery_task` 的 post-hooks 机制被移除），现存记录来自历史会话 replay。黑名单制会让每个已删除的码在重放旧会话时重新变成可见噪音；白名单制下未知码默认隐藏，因此天然安全。

判定仍只依据 `tool/result` 事件上已持久化的 `error.code`，不解析结果消息文本——同一语义在 `fs-local`、`fs-e2b`、`tool-str-replace-editor` 三个后端措辞各不相同，按文本匹配既脆弱又必然漏掉后端。

### 越界读取单独成码

`FsErrorCode`（`packages/fs/fs/src/types.ts`）新增 `FS_OFFSET_OUT_OF_RANGE`，`tool-fs` 的 `read-render.ts` 在 `offset` 越过文件末尾时抛该码；目标路径不存在继续抛 `FS_NOT_FOUND`。

这是白名单制的前提而非附带清理。实测 `FS_NOT_FOUND` 的 12 次中，10 次是 `cannot read "...": not found`，2 次是 `offset N is out of range`。同一个码承载可处置性相反的两类语义时，任何按码的判定都必然对其中一类做出错误结论：越界是请求方的错误，目标缺失是关于文件树的事实。

### 隐藏失败行不等于隐藏结果

过程中的失败行被隐藏，读者仍保有结果的信号：以失败收场的轮次渲染自己的终态行（`conversation-nodes/turn-error.ts` 在 `turn/end` 的 `reason.kind === 'error'` 时物化），需要读者同意的操作通过审批表面发问（`packages/client/ui-approval` 的 composer 接管），不依赖工具结果行。因此该变更不引入阈值汇总或 turn 终态兜底——「需要读者参与」本身已有专门的呈现通道，而把读者刚做出的拒绝再回显为红色错误行属于噪音。

### 移除被架空的 RecoveredMutationProjector

`RecoveredMutationProjector`（原 `conversation-nodes/recovered-mutation.ts`）隐藏 `FS_NOT_OBSERVED` / `FS_STALE_VERSION`，但以「存在锚点更晚的同路径成功变更」为条件，因此持有跨节点状态。这两个码在新判定下已无条件隐藏，该投影无论条件是否成立都不改变输出，成为不产生效果的死代码。它连同其在 `chat-snapshot-builder.ts` 两条装配链上的位置一并删除。

反向的取舍在此明确：原投影解决过真实问题（模型重试成功后留下陈旧错误行），删除它意味着放弃「失败后来被修复」这一区分——但该区分在新方向下不再有可观察后果，因为两类都隐藏。

### 合并两份被取代的记录

本变更取代并合并了两份已实施记录，它们的独有依据在此保存，原文件删除。

**「模型自己写错的 edit 搜索文本失败行不再出现在页面上」**（原 `implemented/feature/2026-09-16-unactionable-edit-failure-rows-hidden.zh.md`，已合并删除）的独有内容：`FS_EDIT_NOT_FOUND` / `FS_AMBIGUOUS_EDIT` 只表示模型自己撰写的搜索文本写错了，读者无从处置。它记录的两条依据仍然有效，并在本变更下由更宽的规则覆盖——同一语义在各文件系统后端措辞不同（`fs-local/src/fsio.ts` 是 `old_string was not found in "<path>"`，`tool-str-replace-editor/src/index.ts` 是 `No replacement was performed, old_str \`...\` did not appear verbatim in <path>.`，`fs-e2b/src/index.ts` 又是第三种），因此判定只读持久化的 `error.code`；隐藏无条件成立，不要求任何后续成功，因为模型常常放弃那条路径而不是重试。它否决的备选方案仍在本次「Alternatives considered」中成立：并入条件式投影会让两个码在无后续成功时仍然可见，而在渲染层隐藏会让同类规则出现两处归属。

**「被后续同文件成功覆盖的 mutation 失败不再停留在页面上」**（原 `implemented/feature/2026-09-04-chat-ux-recovered-mutation-errors-hidden.zh.md`，已合并删除）的独有内容：它引入的 `RecoveredMutationProjector` 及其「标记 hidden 而非移除节点」的机制说明。该机制依据仍然有效并已由现存的 `ReferenceLabelProjector` 与 `HiddenToolFailureProjector` 共同承担：节点在调用结算时即物化，assembler 禁止撤回已物化的节点，因此隐藏只能是 `visibility: 'hidden'`。它记录的一条历史事实值得保留：`FS_EDIT_NOT_FOUND` / `FS_AMBIGUOUS_EDIT` 曾按「非临时性失败必须保持可见」保持可见，后来被划为例外。

其原始的动机场景——「失败与重试成功之间隔着模型的流式思考时，用户从头到尾盯着红字」——由 [先读后写由工具在变更前自动完成](2026-09-15-observation-settled-before-mutation.zh.md) 从产生侧消除（拒绝时补读，使那次失败根本不发生），本变更则从呈现侧兜住剩余情况。

### 模型侧与持久化格式不动

`ToolErrorInfo`（`packages/core/tools/src/index.ts`）的 `{ name, code }` 结构不变，不新增呈现意图字段。隐藏是纯渲染期决策：`tool/result` 事件的 `content` 与 `error` 原样保留，模型照常据以纠正，历史会话无需迁移即可获得新行为。

## Alternatives considered

**保留黑名单制，继续扩大白名单。** 否决：这正是产生问题的方向。它要求作者预见每一个新错误码，而实测长尾有 12 类失败与 52 次无码失败未被任何清单覆盖；且它无法表达「同一码承载可处置性相反的语义」。

**按码判定改为解析结果消息文本。** 否决：同一条件在 `fs-local`、`fs-e2b`、`tool-str-replace-editor` 三处措辞不同，按文本匹配既脆弱又必然漏掉后端。持久化的 `error.code` 随会话日志 replay，一处判定覆盖全部后端。

**在 `toolDefinition.buildViewNode` 内隐藏。** 否决：判定归属视图投影，chat 快照的每个消费方据此拿到同一份结果；把「是否该给读者看」散进各 Definition 会让同类规则出现多处归属。

**在 `ui-tool` 渲染层隐藏。** 否决：同上，可见性判定属于视图投影层，渲染层拿到的应已是最终判定。

**由抛错方声明呈现意图（扩展 `ToolErrorInfo`）。** 更彻底，且符合「决策在做出决策的操作中强制执行」：谁拥有知识谁声明。否决的代价权衡是它要改会话事件格式，牵动两个 SDK 的期望输出与 `snapshots/` 会话快照，而按码判定的白名单在客户端一处即可覆盖本次实测的全部失败。当前无消费者需要比码更细的呈现意图。

**为隐藏失败引入阈值汇总提示。** 否决：以失败收场的轮次已有终态行，需要读者同意的操作已有审批通道，页面不需要为中间过程再加信号；额外机制还要引入「同类失败」「阈值」等需要另行定义的判定。

**保留 `RecoveredMutationProjector` 但降级为无副作用。** 否决：它不产生任何输出，留下的是一段读起来像在工作的代码与一条过时注释。

**让 `RecoveredMutationProjector` 继续承担这两个码的条件判定。** 否决：那会让示例 1（`FS_STALE_VERSION` 且无后续成功）重新出现在页面上，与本次目标直接冲突。

**把两个码的无条件隐藏并入 `RecoveredMutationProjector` 的码集。** 否决：该投影的判定依赖后续成功，把无条件隐藏的码混入会使它们在无后续成功时仍然可见，与目标相反。

## Consequences

读者不再看到自己无法处置的工具失败行。模型收到的结果文本与错误码一字未改，照常据以纠正。判定是渲染期决策，因此历史会话无需迁移即获得新行为；反之若要调整白名单，也只改客户端。

代价与已知边界：

- **白名单需要随能力演进维护。** 一个新的「需要读者介入」的错误码若未及时加入白名单，其失败行会被隐藏。这是方向反转的固有代价：遗漏的后果从「页面上多一行噪音」变成「页面上少一行必要信息」。缓解事实是这类失败已由审批表面与轮次终态行承担呈现，白名单本身只需覆盖真正要求读者动手的环境与权限问题。
- **`FS_PERMISSION_DENIED` 实测 0 次。** 纳入白名单依据的是语义同类性（与沙箱拒绝同属环境权限问题，一旦出现即需读者处理），而非实测频次。
- **不覆盖 PTC 嵌套子调用。** `tool/code-dispatch` 事件只记录 `isError` 与 `content`，不带 `{ name, code }`，客户端据此构造的子调用节点没有可判定的错误码；实测该事件在本部署中为 0 次。记入 `packages/client/ui-chat/README.zh.md` 的 Known Limitations。
- **`RecoveredMutationProjector` 删除后不可局部恢复。** 若判定方向将来再变，重新引入「失败后来被修复」的区分需要重建该投影，而非改一个开关。

## Testing

- `packages/client/ui-chat/tests/conversation-node-definitions.client.spec.ts`：白名单五码保持 visible；`FS_STALE_VERSION`、`FS_NOT_OBSERVED`、`DELIVERY_GATE_BLOCKED`、`FS_EDIT_NOT_FOUND`、`DELIVERY_POST_HOOK_FAILED`（已删除的历史码）等默认 hidden 并离开可见顺序；无 `error.code` 的失败默认 hidden；成功调用不受影响；增量 upsert 与全量 replace 两条链判定一致。原「非可恢复失败保持可见」用例改用白名单内的 `FS_PERMISSION_DENIED` 以保留其原意，原「可恢复失败被后续成功覆盖」用例并入无条件隐藏的覆盖。
- `packages/fs/tool-fs/tests/read-render.spec.ts` 与 `tools.spec.ts`：越界返回 `FS_OFFSET_OUT_OF_RANGE`，目标缺失仍返回 `FS_NOT_FOUND`，两条断言各自固定其错误码。
- `npx vitest run packages/client/ui-chat/`：26 个文件、336 条通过。
- `npx vitest run packages/fs/tool-fs/ packages/fs/fs/`：8 个文件、215 条通过。
- `npx tsc -b packages/fs/tool-fs/tsconfig.json` 通过（会连带重建 `dsh-fs` 的类型产物，因此新增的错误码进入产物面）。

## Related

- [受防护变更错误在模型边界追加恢复指令](2026-08-03-fs-tool-error-remedy.zh.md)——`FS_STALE_VERSION` 的模型可见恢复指令由该 Note 拥有，本次不改其面向模型的部分。
- [先读后写由工具在变更前自动完成](2026-09-15-observation-settled-before-mutation.zh.md)——从产生侧消除 `FS_NOT_OBSERVED` 的那次拒绝；本变更从呈现侧兜住剩余情况。
- [受防护变更失败在调用内补读目标](2026-09-15-in-call-reread-on-guarded-mutation-refusal.zh.md)——`FS_STALE_VERSION` 的补读路径，其「只改进 UI 呈现」的否决理由引用过已删除的投影。
