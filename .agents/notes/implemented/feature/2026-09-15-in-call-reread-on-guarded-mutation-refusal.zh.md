# Agent Note: 受防护变更失败在当次调用内重新读取目标

Status: implemented

**本记录已被[先读后写由工具在变更前自动完成](2026-09-15-observation-settled-before-mutation.zh.md)部分取代。** 它仍然准确的描述是：`FS_STALE_VERSION` 仍以「重新读取目标并附加当前内容」的方式向模型报告；`remediateFsError` 仍是目标不可重新读取时的回落路径。被取代的是决策本身——它选择在**失败之后**补救，因此那次 `isError` 仍会渲染成页面上的红色错误行。后续记录改为在**变更之前**结算观察，从源头不产生该失败。

## 问题

策略插件对未观测目标的拒绝（`FS_NOT_OBSERVED`，消息 `edit requires reading "<path>" first`）以及陈旧观察的拒绝（`FS_STALE_VERSION`）共享同一个补救：重新读取目标。此前 [受防护变更错误在模型边界追加恢复指令](2026-08-03-fs-tool-error-remedy.zh.md) 只是把这条补救写成文本追加到失败消息上——`— read the file, then retry`——把执行它的责任完全留给模型。

代价是一整轮往返，而且是纯发现性的往返。对话页面里反复出现的 `Error: edit requires reading …` 就是它的可见形态：模型必须再发一次 `read`，等结果回来，然后第三次调用才可能成功。更糟的是它容易被忽略——`edit` 要求 `old_string` 逐字匹配，而模型在没看过内容时给出的 `old_string` 本就是猜的；即便它照做了重新读取，失败也只会从 `FS_NOT_OBSERVED` 变成 `FS_EDIT_NOT_FOUND`，错误并未消失。

无密钥快照 `fs-policy-reject` 记录了完整形态：用户指令明确要求「Do NOT use the read tool」，模型第一次 `edit` 被拒，第二次 `edit` 再次被拒——两次失败，零进展。

## 决策

`dsh-tool-fs` 在当次工具调用内完成补救。`src/error.ts` 的 `recoverMutationFailure` 取代原先直接调用 `remediateFsError` 的位置（`write.ts` 与 `edit.ts` 的沙箱拒绝映射之后）：它重新读取目标，把文件的当前内容以 `read` 同款信封附在失败消息里，并在失败消息中说明「its current content follows; retry now.」。

这条路径之所以成立，是因为**重新读取本身就是策略要求的那个观察**。`readFileWindow` 在读取成功后发出 `fs/observed`，策略插件随即记录 `{ kind: 'present', version }`；因此模型的下一次 `write`/`edit` 直接通过意图槽位，无需任何额外的 `read` 调用。快照 `fs-policy-reject` 刷新后的差异正是这一点：第二次 `edit` 从「再次被拒」变为「updated successfully」，而模型的指令仍禁止使用 `read`。

失败语义全部保留：结果仍是 `isError`，`FsError` 错误码不变（重试/权限/UI 层继续据此路由），原始错误仍作为 `cause` 链入。变化的是消息文本——从纯恢复指令变成「原消息 + 内容」，因此模型的下一轮重试是有依据的，而不是又一次猜测。

### 补救是尽力而为的

目标无法重新读取时（不存在、不可读、是目录、二进制，或调用已取消）回落到原有的 `remediateFsError`：只追加恢复指令。捕获范围是完整读取路径——一次恢复尝试绝不能取代变更自身的失败，那才是模型必须处理的可操作结果。因此 `recoverMutationFailure` 把 `rereadTarget` 整体包在 `try` 中。

### 归属与边界

重新读取发生在 `dsh-tool-fs`，不在策略插件里。`dsh-fs-observation-policy` 保持零文件系统 I/O——[文件系统能力 seam](../architecture/2026-06-26-file-context-as-event-gate.zh.md) 明确否决了策略侧 `stat`，理由是策略侧的检查与工具实际写入之间存在 TOCTOU 间隙。工具侧重新读取不触碰这条边界：它不比较版本、不做门禁判断，只是读取并发出观察，把新鲜度判定继续留给提供方锁内的 CAS。

读取预算由部署的 `Config` 约束：恢复读取使用 `readLimit` 作为行上限，并复用 `readMaxBytes`/`readMaxLineLength`/`readStreamMinSize`，因此返回内容有界，且与 `read` 工具完全一致。`readFileWindow` 从 `read.ts` 的 `read` 执行器中抽出，使两条路径共享同一套窗口与流式决策，而不是各写一份。

## 考虑过的替代方案

- **静默自动补读后重试变更**（模型看不到任何失败）。否决：`edit` 要求 `old_string` 逐字匹配，模型没看过内容时给出的匹配串本就是猜的，补读后仍会以 `FS_EDIT_NOT_FOUND` 失败——错误只是换了张脸，没有消失。对 `write` 更严重：那会把策略刻意设的门槛（「拒绝覆盖会话未读取过的现有文件」）实质降级为「基于最新版本覆盖」，正是 [事件门禁决策](../architecture/2026-06-26-file-context-as-event-gate.zh.md) 与策略 README 所声明的保护。返回内容并让模型重试，则保留了「先看再改」的纪律，同时省掉发现往返。
- **只改进 UI 呈现**（把可恢复失败降级为提示样式）。否决：模型仍要多花一轮往返，问题只是被藏起来。客户端已有的 `RecoveredMutationProjector` 只隐藏「之后同一文件改成功了」的失败行，对未恢复的失败无能为力。
- **在策略插件的 `fs/edit-intent` 监听器里读取。** 否决：违反策略插件的零 I/O 边界，且会重新引入该边界专门消除的 TOCTOU 间隙。
- **通过 `exec.deferContext` 把内容作为独立上下文消息附加。** 否决：这会让内容脱离它所解释的那次失败，在 transcript 中形成一条无法与调用关联的消息；错误结果自身的文本才是模型读到该失败的位置。

## 后果

- **两个错误码的模型可见文本改变**：`FS_STALE_VERSION` 与 `FS_NOT_OBSERVED` 在目标可读时不再只带恢复指令。无密钥快照 `fs-policy-reject` 已刷新（会话 JSONL 与 `workspace.expected/settings.txt`——后者的变化独立证明了 edit 真的落盘）。`dsh-tool-fs` 与 `dsh-fs-observation-policy` 的 README 逐字更新。- **失败结果变长**：内容受 `readLimit`/`readMaxBytes` 约束，但确实比一行恢复指令长。这是有意的取舍——它替换掉的是模型为获取同一内容而单独发起的一次 `read` 往返，净 token 更少。
- **`read` 的窗口读取被抽出共享**：`readFileWindow` 现在是 `read` 执行器与恢复路径的共同实现；`read` 的对外行为与 stat 预算（一次 `stat`）不变。
- **同一策略的另一个消费方未覆盖**：`dsh-tool-str-replace-editor` 也消费 `fs/edit-intent` 并会收到 `FS_NOT_OBSERVED`，但它不使用 `dsh-tool-fs` 的错误包装层，因此仍只报告裸错误码。它属于同一条用户问题的另一半，其恢复路径需要在该包内单独实现。
- **恢复读取不增加 `stat` 预算的常规路径**：成功变更仍是零 `stat`；只有失败路径才会为恢复多付一次 `stat` 加一次读取。

## 验证

- `packages/fs/tool-fs/tests/error.spec.ts` 直接覆盖 `recoverMutationFailure`：内容出现在恢复消息中、错误码与 `cause` 保留、恢复读取确实发出 `present` 观察、`FS_STALE_VERSION` 走同一路径、内容受 `limit` 约束、目标缺失与目录目标回落到纯恢复指令、不可恢复错误码与非 `FsError` 原样透传且不触发任何读取。
- `packages/fs/tool-fs/tests/integration.spec.ts` 断言组装后的工具路径：未读 `write`/`edit` 与陈旧变更的拒绝文本都包含文件内容，且**不插入任何 `read` 调用**重试即可成功——这条断言正是「省掉一轮往返」的可执行证据。
- 无密钥快照 `fs-policy-reject` 重放通过。该场景的刷新按设计重放已录制的模型输出、只重跑工具，因此转录中模型的推理文本仍是刷新前录制的（它当时以为需要先读）；证据在工具结果与工作区：第二次 `edit` 由失败变为成功，`workspace.expected/settings.txt` 由 `color: blue` 变为 `color: green`，而全程没有任何 `read` 调用。
