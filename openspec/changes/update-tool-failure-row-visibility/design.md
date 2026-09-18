### D1 判定改为可处置白名单展示

`packages/client/ui-chat/src/client/conversation-nodes/hidden-tool-failure.ts` 的判定反转：命中原有白名单的失败行保持 `visibility: 'visible'`，其余 `isError` 行标记 `visibility: 'hidden'`。

白名单为 `FS_SANDBOX_DENIED`、`FS_PERMISSION_DENIED`、`NO_PROVIDER`、`GOAL_TOOL_AUTHORITY_REQUIRED`、`SEARCH_FAILED`。前两码是环境权限问题，`NO_PROVIDER` 是提供方配置缺失，`GOAL_TOOL_AUTHORITY_REQUIRED` 需用户授权，`SEARCH_FAILED` 表示搜索工具本身不可用——全部是用户必须处理的场景。`FS_PERMISSION_DENIED` 实测 0 次，但语义上与沙箱拒绝同类，纳入代价极低。

不携带 `error.code` 的裸 `Error` 一并隐藏：实测 52 次，文本如 `old_string and new_string must differ`、`change_id must be verb-led kebab-case`，全部是模型自身的参数错误。

判定按持久化 `error.code`，不解析消息文本：同一语义在 `fs-local`、`fs-e2b`、`tool-str-replace-editor` 三个后端措辞各不相同，按文本匹配必然漏掉后端。`error.code` 随会话日志持久化、可 replay，一处判定覆盖全部后端。

`RecoveredMutationProjector` 保持独立，不做合并：它处理「后续同路径成功后才隐藏」的条件式判定，其实现持有跨节点状态；本投影是无条件默认隐藏，判定只依赖单个节点。两者都标记 `visibility`，而非 `null`——assembler 禁止撤回已物化的节点。

选白名单制而非黑名单制的独立证据：`DELIVERY_POST_HOOK_FAILED` 实测 7 次，但该码在当前源码已不存在，记录来自历史会话 replay。黑名单制会让每个已删除的码在 replay 时变成可见噪音。

### D2 拆出 FS_OFFSET_OUT_OF_RANGE

`packages/fs/fs/src/types.ts` 的 `FsErrorCode` 联合新增 `FS_OFFSET_OUT_OF_RANGE`；`packages/fs/tool-fs/src/read-render.ts` 的越界改抛该码。

这是 D1 的必要前提。实测 `FS_NOT_FOUND` 的 12 次中，10 次是 `cannot read "...": not found`（对用户有信息量，可能反映真实路径问题），2 次是 `offset N is out of range`（模型传错参数）。同一码承载可处置性相反的语义，不拆码则默认隐藏会误吞前者。

### D3 不引入 turn 终态兜底与阈值汇总

不做「同一 turn 内同类隐藏失败超过 N 次则汇总」的机制，理由有两条已核实的事实：

`packages/client/ui-chat/src/client/conversation-nodes/turn-error.ts` 在 `turn/end` 的 `reason.kind === 'error'` 时渲染独立的失败行，因此 agent 彻底失败时用户仍能看到结果，过程噪音与最终结果不混淆。

`packages/client/ui-approval` 的 `ApprovalPanel` 是 composer 接管，提权审批走该独立通道而非工具错误行。因此「需要用户参与」的场景本身就有专门通道承担展示职责。用户拒绝提权产生的 `the user rejected escalating...` 反而应当隐藏——把用户刚做的决定回显为红色错误属于噪音。

### D4 不动持久化格式

`ToolErrorInfo`（`packages/core/tools/src/index.ts`）的 `{ name, code }` 结构不变，不新增呈现意图字段。生产者声明呈现意图虽然更彻底，但要改会话事件格式，牵动两个 SDK 与 `snapshots/` 期望输出，收益不足以匹配代价。隐藏是纯渲染期决策，历史会话无需迁移。