# 技术决策

### D1 判定用持久化的 error code，不用消息文本

`tool/result` 事件的 `data.error`（`packages/core/session/src/types.ts:275`，`error?: { name: string; code: string }`）由核心 `errorInfo()` 对 `HarnessError` 子类投影而来，随会话日志持久化、可 replay。`ToolResultNode.error` 在 Client 侧已可用（`packages/client/ui-conversation/src/client/contract/records.ts:169`）。

用 code 而非解析消息文本的理由：同一语义的文案在多处各写一份且措辞不同——`fs-local/src/fsio.ts:773` 是 `old_string was not found in "<path>"`，而 `tool-str-replace-editor/src/index.ts:301` 是 `No replacement was performed, old_str \`...\` did not appear verbatim in <path>.`；`fs-e2b/src/index.ts:163` 又是第三种措辞。按文本匹配会既脆弱又必然漏掉后端。

实测验证（`seq:141001`）：`{"name":"FsError","code":"FS_AMBIGUOUS_EDIT"}` 确实落在真实日志上。

### D2 新建投影，不并入 `RECOVERABLE_CODES`

`RecoveredMutationProjector`（`recovered-mutation.ts:22`）隐藏 `FS_NOT_OBSERVED` / `FS_STALE_VERSION`，但其隐藏是**有条件**的：要求存在锚点更晚的同路径成功 mutation（`isCovered()`）。本次要的是**无条件**隐藏——模型失败后常常不再重试同一路径，而那正是用户当前看到残留错误的场景。

把这两个 code 加进 `RECOVERABLE_CODES` 是错的：无后续成功时它们仍会显示，恰与本变更目标相反。故新增独立投影，沿用同一 `replace` / `apply` 形态保持装配一致性，但不持有跨节点状态（其判定是节点局部的，`apply` 无需回看 store）。

### D3 归属视图投影层，而非 `toolDefinition.buildViewNode`

既有 Note 否决「在 `buildViewNode` 内隐藏」的理由是「覆盖判定需要后续成功，单个 Definition 看不到」——该理由对本次无条件判定**不成立**（`chatNode()` 本身支持 `visibility` 选项）。仍选投影层的理由有两条：

1. 与既有可见性投影同层，chat 快照的每个消费方拿到同一份结果，其他读取方无需各自重算——这正是既有 Note 选择投影层时给出的理由。
2. 把「是否该给用户看」散进每个 Definition 会让同类规则出现两处归属；`tool.ts` 的 Definition 应保持只描述调用生命周期。

### D4 白名单内容与明确排除的邻居

`HIDDEN_CODES = { FS_EDIT_NOT_FOUND, FS_AMBIGUOUS_EDIT }`（`packages/fs/fs/src/types.ts:175` 的 `FsErrorCode` 中）。

排除并说明理由：

- `FS_NOT_OBSERVED` / `FS_STALE_VERSION`：已有条件式投影负责，语义不同。
- `FS_SANDBOX_DENIED` / `FS_PERMISSION_DENIED`：用户可能需要授权，必须可见。
- `FS_NOT_FOUND` / `FS_NOT_REGULAR_FILE` / `FS_NOT_TEXT` / `FS_TOO_LARGE`：属于目标选择问题，路径信息对用户有意义。
- `FS_STALE_VERSION`：模型可自行重读重试，但用户也需知晓文件被并发改动。

`FS_EDIT_NOT_FOUND` 还覆盖「`old_string` 为空」（`fsio.ts:768`），同属模型参数错误，一并隐藏符合意图。

### D5 不覆盖 PTC 嵌套子调用

`PtcDispatchEventData`（`packages/core/tools/src/types.ts:20`）只有 `isError` + `content`，无 `{ name, code }`；`ptc.ts:509` 的 append 未写 identity。Client 侧 `childResult()`（`packages/client/ui-chat/src/client/conversation-nodes/tool.ts:92`）据此构造的 `ToolResultNode` **不带** `error` 字段，故按 code 判定在子调用上不可用。

补齐需扩展会话事件格式，牵动 `snapshots/session/ptc-*`、`snapshots/web/ptc-round` 与两个 SDK 期望输出。实测该部署 43 个会话中 `tool/code-dispatch` 事件总数为 0（native 呈现模式，`packages/bundle/base/cordis.patch.yml:542` 的 `tools` 条目省略 `mode` 取默认 `native`）。packages/AGENTS.md 要求抽象必须有当前消费者，故延后并记入 Known Limitations。

### D6 决策反转与 Agent Note 处置

`2026-09-04-chat-ux-recovered-mutation-errors-hidden.zh.md` 的 Alternatives 记载「非临时性失败（无匹配、权限拒绝）是有意义的，必须保持可见」，`conversation-node-definitions.client.spec.ts` 亦有断言 `FS_EDIT_NOT_FOUND` 保持可见的用例。

按 `.agents/notes/AGENTS.md`：这是决策反转，需**新增** Note 交叉链接旧的；旧 Note 保持 implemented 不归档（其主体机制仍有效），但其中与现状矛盾的表述需就地更新，避免留下矛盾的权威表述。同时该断言用例需改写为「非白名单错误码保持可见」。
