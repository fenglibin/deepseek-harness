# Agent Note: 先读后写由工具在变更前自动完成

Status: implemented

## 问题

策略插件要求"本会话观察过目标"才允许变更。此前这条要求是**模型的义务**：工具把未见目标的拒绝原样报上去（`FS_NOT_OBSERVED`），由模型自己再发一次 `read` 然后重试。

代价有两层，而第二层才是真正的问题：

1. **一轮纯发现性的往返**。模型必须读一次，才能重试。
2. **那次拒绝会作为 `isError` 结果留在会话日志里**，因此必然在对话页面上渲染成一行红色错误。客户端当时有一个 `RecoveredMutationProjector`，只在"同一文件后续变更成功"时把它隐藏，而隐藏是**事后**的：红色行先出现，等下一次成功落地才消失。用户看到的是红字一闪而过，或者——当失败与重试成功之间隔着模型的流式思考时——从头到尾盯着它。

[上一轮决策](2026-09-15-in-call-reread-on-guarded-mutation-refusal.zh.md)处理了第 1 层：拒绝时补读并返回内容。它没有处理第 2 层，因为失败仍然发生。用户复审时指出这正是症结：**要页面随时都不出现红色，就不能产生那次失败**。

## 决策

`dsh-tool-fs` 把"先读后写"内化为自己的义务，在**变更之前**完成观察结算。

`src/error.ts` 的 `mutateWithObservedBasis` 包住两个变更工具的意图分发与提供方调用：

```text
try:  mutate(await dispatchIntent())
catch FS_NOT_OBSERVED:
    记录观察（读取目标；目标缺失则记录缺失；非普通文件则放弃）
    return mutate(await dispatchIntent())
```

关键在于**重新分发意图槽位**，而不是直接重试提供方调用。策略从它自己的观察记录里派生版本基准，所以补读之后那次分发返回的是 `{ version: vObserved }`（或对缺失目标返回 `createIfAbsent`），提供方随即在锁内 CAS 这个版本。工具不绕过策略，也不自己判断版本——它只是把策略缺的那个事实（观察）补上，然后让策略重新作答。

因此**失败从未被产生**：`execute()` 只返回一个成功结果，中间的补读是调用内部的，不产生 `tool/result` 事件。会话日志里没有那行、页面上也就没有那行。

`dsh-tool-str-replace-editor` 用更自然的形式达到同一效果：`str_replace` 与 `insert` **本来就必须读取文件内容**（要定位字面量或插入边界），只是过去在读取**之前**分发意图、且不记录观察。现在它们先读取、发出 `fs/observed`、再分发意图，于是策略从一开始就有基准可用。审计发现该包的一个 `insert` 分支过去完全不做读取——它在读取之前就分发意图，因而对未见目标必然拒绝。

### 系统提示词同步

`edit` 与 `write` 的指导段落原本写着 "Read the file first (the default fs-observation-policy requires it)"。规则变了，这句话就成了错误的指令：它会继续驱使模型做那次已无必要的 `read`。两段改为说明工具自行结算观察，并保留仍然成立的忠告——`edit` 需要内容才能写出匹配的 `old_string`。

### 规则本身没有变

策略插件的语义一字未改：未见目标仍然被门禁拒绝，陈旧观察仍然以 `FS_STALE_VERSION` 失败。改变的只是**谁来满足它**。把策略插件从组合里移除仍然会得到无条件变更，这一点与之前完全一致。

## 考虑过的替代方案

- **沿用上一轮方案（失败后补读并返回内容）**。已实现过，被用户复审否决：它把红色行留给页面，只保证"之后再隐藏"。本案替换了它。
- **在 UI 层把这类失败渲染成中性提示**。否决：模型仍会看到并浪费一轮，问题被藏起来而非解决；且该行仍留在会话日志里，任何其他渲染方都要各自再判一次。
- **从部署里移除 `dsh-fs-observation-policy`**。否决：那会连并发版本保护（CAS）一并失去，两个进程同时写同一文件可能互相覆盖。用户明确只要消除噪音，不要削弱保护。
- **静默补读后直接重试提供方调用（不重新分发意图）**。否决：那等于工具自己编造版本基准，绕过策略的判定权；重新分发让策略用自己的记录作答，语义归属清晰。

## 后果

- **`FS_NOT_OBSERVED` 不再是模型可见的失败**。它在意图槽位里仍然会抛出，但被工具在同一调用内结算。仍然可见的变更失败只有 `FS_STALE_VERSION`（变更期间文件被外部改写）、字面量不匹配（`FS_EDIT_NOT_FOUND`/`FS_AMBIGUOUS_EDIT`）与沙箱拒绝。
- **陈旧判定只对「本会话从未观察过」的目标放宽**。补读只在策略拒绝时发生，因此它的影响范围正好是未见目标：读到当前内容并记下当前版本，先前的外部改动被吸收。会话已经显式 `read` 过的目标不触发补读，变更照旧 CAS 那个较旧的已观察版本——因此「读取之后发生的外部改动」仍以 `FS_STALE_VERSION` 失败。两者合起来是：CAS 基准要么是刚读到的新鲜版本，要么是模型确实读过、因而有资格据以改写的版本。
- **缺失目标的错误码变准确**。恢复读取发现目标不存在时会记录确认缺失，于是策略给出 `FS_NOT_FOUND`（edit 无内容可改）或 `createIfAbsent`（write 可以创建），而不是让模型去读一个不存在的文件。
- **已观察路径的预算不变**：不读取、不探测 `stat`。只有被拒绝的那一次才多付一次 `stat` 加一次读取。
- **系统提示词的两段文本改变**，因此 29 个 `system-prompt.expected.md` 侧车同步更新。
- **快照 `fs-policy-reject` 的语义改变**。该场景录制了模型对同一文件连续两次 `edit`（参数相同）。第一次现在直接成功；第二次因 `old_string` 已被改掉而报 `FS_EDIT_NOT_FOUND`。它不再是"红色行不再出现"的证据——恰恰相反，它现在同时演示了本次修复（第一次的 `FS_NOT_OBSERVED` 消失）与它消除不了的残余（模型自己写错搜索文本）。后者的处理见[按可处置性白名单展示工具失败行](2026-09-18-tool-failure-visibility-by-actionability.zh.md)。

## 验证

- `packages/fs/tool-fs/tests/error.spec.ts` 覆盖 `mutateWithObservedBasis` 的结算语义与回落路径。
- `packages/fs/tool-fs/tests/integration.spec.ts` 断言组装后的工具路径：未读 `write`/`edit` 都**不再产生 `isError`**，且全程没有任何 `read` 工具调用；目标缺失时 `edit` 报 `FS_NOT_FOUND`、`write` 照常创建；外部删除后第一次变更失败、其恢复读取记录缺失、随后的 `write` 走防护创建重建文件。
- `packages/fs/tool-str-replace-editor/tests/tools.spec.ts` 断言未 `view` 过的 `str_replace` 直接成功，且字面量不匹配仍以 `FS_EDIT_NOT_FOUND` 失败。
- 全部验证运行于源码面（`vitest` 经 tsconfig `paths` 解析到 `src`）。这与运行中的 GUI 是**同一个面**：`dsh` 由 `node --import tsx/esm apps/cli/src/bin.ts` 启动，`tsx` 按 `tsconfig.base.json` 的 `paths` 把 `@deepseek-ai/dsh-tool-fs` 解析到 `packages/fs/tool-fs/src`。已在同一启动路径下用 `import.meta.resolve` 实测确认。因此改动无需重建 `lib/` 即可被运行中的服务加载——但 `tsx` 只在进程启动时加载模块，且 `run.sh` 不含 watch/HMR，所以**已经运行的进程仍需重启**才会载入新代码。
