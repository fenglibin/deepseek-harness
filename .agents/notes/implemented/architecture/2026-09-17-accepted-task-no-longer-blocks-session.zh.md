# Agent Note: 已接受的任务不再占死会话

Status: implemented

## 问题

会话里存在一个已 `accepted` 的 `l1`/`l2` 任务时，新的直接人类请求不会被自动建任务，也不会被模型显式建任务——每个后续请求都在没有交付任务的情况下运行。

三处规则本来各自正确，叠在一起才成了死结：

- **domain**（`DeliveryService.create`）：当前任务非 `accepted` 时拒绝新建。它明确允许 `accepted` 之后新建，`fold.ts` 同样只要求新 create 是 revision 1 且前一个任务已 `accepted`（或在会话里从未出现过）。
- **工具描述**（`create_delivery_task`）：写明「An accepted task may be replaced」。
- **策略**（`createReplacingL0`）：只豁免 `l0`——`current.level !== 'l0'` 即抛 `DELIVERY_TOOL_TASK_EXISTS`。

策略漏掉了 `accepted` 这一档，于是三条规则里唯一没写对的那条决定了行为：`accepted` 的 `l1`/`l2` 既不是可替换的 `l0`，又没有任何工具能 `clear` 它，会话就此被一个**已经完成**的任务永久占住。`runAutoDetect` 里同样的 `level !== 'l0'` 判断让它更隐蔽——它在发起分级调用之前就 return，把整个失败记成一次 warning 后静默跳过。

实测复现（真实 agent-loop，探针验证后删除）：把 l1 任务推到 `accepted`，然后发一条新请求；修复前 `ctx.delivery.get(agent).objective` 仍是旧任务，修复后是一个新 id 的新任务。同一个死结也拦住了 `create_delivery_task` 本身——工具调用抛 `DELIVERY_TOOL_TASK_EXISTS`，模型无法自救。

## 决定

把「现有任务是否仍占用会话」收成一个谓词，让策略与 domain 的规则只有一处归属：

```ts
function holdsClaim(current: DeliveryView | undefined): boolean {
  return current !== undefined && current.level !== 'l0' && current.phase !== 'accepted'
}
```

`createReplacingL0` 与 `runAutoDetect` 共用它，`accepted` 因此与 `l0` 一样放行。两处的差异只在 `clear`：`l0` 需要先 `clear`（留下可追溯的 tombstone），`accepted` 不需要——domain 自己就接受这次 create，多写一个 `clear` 只会留下一个没有消费者的事件。

`runAutoDetect` 的两处 return 都改用该谓词：进入时判断是否需要分级，判定落地后重新判断（判定期间模型可能建了或完成了任务）。

## 替代方案

**在 domain 放开 `accepted` 限制。** 否决：那里没有限制可放开——`DeliveryService.create` 本来就允许，`fold.ts` 也允许。放宽它不会改变任何行为，缺陷在策略层。

**给模型一个 `clear_delivery_task` 工具。** 否决：那要求模型主动记得清理，正是交付纪律要消除的「靠自觉」失败模式。[l0 纳入自检](2026-09-17-l0-selfcheck-and-ordered-acceptance-commands.zh.md)当初拒绝这条的理由在这里同样成立。

**把所有级别都变成可替换。** 否决：未完成的 `l1`/`l2` 需要跨 turn 的连续性，这正是它保留占用的原因。本次只补齐已完成的档位。

**只改 `createReplacingL0`，不动 `runAutoDetect`。** 否决：后者在分级调用之前就 return，是这条路径上更早的一道门；只改一处会让自动路径继续静默跳过。

## 后果

- **获得** 完成的交付任务不再阻塞会话。用户发出新请求就得到新任务，与 `create_delivery_task` 的既有声明一致。
- **不变** 未完成的 `l0` 仍被下一条直接请求替换（带 tombstone），未完成的 `l1`/`l2` 仍保留占用。既有测试锁定了这两条。
- **代价** `holdsClaim` 是普通布尔函数而非类型谓词，`createReplacingL0` 里因此保留了 `current !== undefined &&` 守卫以完成收窄；这是把规则集中到一处的可见成本。

## 验证

`tool-delivery.spec.ts` 新增三条：auto-detect 路径在 `accepted` 的 l1 之后建出新任务、`create_delivery_task` 同样路径能建出任务、以及替换 `accepted` 任务时只写一条 `create`（不写 `clear` tombstone）。既有「still refuses to replace an unfinished l1 task」与「does not create a second task when one already exists」锁定未完成 `l1` 的占用不变。

反向验证（关键）：把 `holdsClaim` 改回 `level !== 'l0'` 后，前两条立即失败（`expected 'finished work' to be 'a brand new request'` 与工具调用 `expected true to be false`）；真实 agent-loop 探针同样从「新任务」变回「仍是旧任务」。这证明测试覆盖的是缺陷本身。

注意测试用的是 `l1` 而非 `l0`：`l0` 本就走在 `level !== 'l0'` 的放行侧，用它测会得到永远通过的假绿——第一版测试正是因此骗过了反向验证。
