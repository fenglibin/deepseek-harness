# 先读后写由工具在变更前自动完成

## Why

`dsh-fs-observation-policy` 要求「本会话观察过目标」才允许变更，而这条要求此前是**模型的义务**：未见目标被拒绝（`FS_NOT_OBSERVED`）后，由模型自己再发一次 `read` 再重试。

代价有两层，第二层是关键：

1. 一轮纯发现性的往返。
2. 那次拒绝以 `isError` 结果留在会话日志里，因此必然在对话页面上渲染成红色错误行。客户端的 `RecoveredMutationProjector` 只在「同一文件后续变更成功」时**事后**隐藏它——用户看到红字一闪而过，或当失败与重试之间隔着模型流式思考时，从头到尾盯着它。

用户复审明确指出：要页面随时不出现红色，就不能产生那次失败。

## What Changes

- **`dsh-tool-fs`**：`write` 与 `edit` 在意图槽位拒绝未见目标时，于当次调用内读取目标、记录观察、重新分发意图槽位，使命中原样成功。中间的补读不产生 `tool/result` 事件，因此该失败从不进入会话日志或页面。
- **`dsh-tool-str-replace-editor`**：`str_replace` 与 `insert` 本就必须读取内容来定位字面量或插入边界，改为先读取并发出 `fs/observed`、再分发意图槽位。
- **系统提示词**：`edit`/`write` 的指导不再要求「为满足策略而读」，改为说明工具自行结算观察。
- **策略插件语义不变**：未见目标仍被门禁拒绝，陈旧观察仍以 `FS_STALE_VERSION` 失败；移除插件仍得到无条件变更。

## Impact

- 受影响能力：`fs-mutation-observation`
- 受影响包：`dsh-tool-fs`、`dsh-tool-str-replace-editor`；README 与系统提示词侧车同步
- 模型可见变化：`FS_NOT_OBSERVED` 不再是模型可见的失败；系统提示词两段文本改变
- 语义放宽范围有限：补读只在策略拒绝（即本会话从未观察过目标）时发生，因此「未见目标 + 先前外部改动」被吸收；**已显式 `read` 过的目标不触发补读，其后的外部改动仍以 `FS_STALE_VERSION` 失败**，该保护完好
- 不受影响：`FS_STALE_VERSION`、字面量不匹配（`FS_EDIT_NOT_FOUND`/`FS_AMBIGUOUS_EDIT`）、沙箱拒绝仍照常失败
- 验证纪律：`vitest` 走源码面（`src`），而 `dsh` 走产物面（`lib/index.js`），两者必须分别验证