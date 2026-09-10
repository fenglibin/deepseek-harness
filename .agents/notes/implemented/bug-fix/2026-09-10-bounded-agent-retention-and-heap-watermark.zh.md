# Agent Note: Host 保留的 Agent 无界导致堆耗尽

Status: implemented

## Problem

`dsh web` 进程在持续运行约 25 小时后以 `FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory` 中止（SIGABRT）。日志里唯一的前置异常是一条来自 subagent SDK 的 SSE 解析失败，与本崩溃没有因果关系：Mark-Compact `(reduce)` 只回收 1.2% 的堆，说明撞上的是**滞留**，而不是分配风暴。

滞留者是被保留的普通 Agent。`ApiSessionAgentController` 用一张以 Session id 为键的表保存每个被激活过的 Agent 的 teardown capability，只在 `deleteSession` 时移除：控制器既不设上限，也不因空闲释放。而每次 `follow`（打开一个 Session，包括 Client 重连）都会把冷 Session 提升为 live Agent，于是"长时间运行的 Host 累积每个被浏览器打开过的 Session"成为默认行为。每个被保留的 Agent 钉住其 Session 的整份内存事件日志——`Session.log` 在内存里一条流式 delta 一个冻结事件对象，只在持久化时折叠成 chunk-rows（事故现场一份 subagent Session 落盘 2,954 行、内存 76,601 事件，差 26 倍）。

事故进程在崩溃时同时运行 2 个各约 6 万事件的 subagent Session，此前 25 小时内累积的会话日志解压后合计 202 MB（折叠后）——还原成事件对象后正好顶到本机 V8 的默认堆上限 4,288 MB，而该上限是 Node 的默认值，部署从未显式设置。

## Decision

`ApiSessionAgentController` 接受一个有界的保留策略（由 `SessionController` 从 Config 解析后显式传入），并配套一个运行时水位：

- `liveAgentLimit`（默认 16，`0` 不设上限）与 `liveAgentIdleMs`（默认 10 分钟）。每次 `activate` 后按"最久未活跃"顺序释放，直到保留集回到上限内。只有空闲、已静默（`now - lastUsedAt >= idleMs`）且不在激活中的 Agent 可被释放，运行中的 Agent 永不释放，所以配额是**软上限**：没有可释放对象时保留集可以暂时超出。
- 活动时间戳由控制器的入口（`resolve`、`ensureSession`、`selectionFor`/`selectForNextRequest`、`serializeImageAdmission`、`activate`）与 Host 的 `agent/status`（回合起止）更新，静默期因此从最后一次真实使用算起，而不是从激活算起。
- 释放复用既有的退役路径 `release()`，Session 保持 durable，下次使用走普通冷恢复。释放**不**发布 `api-session/removed`：`session/disposed` 的监听器先询问 `consumeRetentionRelease(id)`，命中保留释放就不广播，Client 的行与 follow stream 都保留（follow 本就监听 `session/created` 并重放快照游标之后的尾段）。删除仍按原路径广播自己的 removal。
- enforcement 前剪掉不再属于本控制器的保留条目（同一 id 被后来的生命周期接管），避免为一个不消耗配额的条目去释放别的 Session；释放失败被容纳并记 warn，不破坏触发它的那次激活。
- `heap-watch.ts` 的 `installHeapWatch` 按 `heapWatchIntervalMs`（默认 5 分钟，`0` 关闭）记一行堆水位：堆用量、V8 堆上限、RSS、保留 Agent 数、保留事件数；`heapWatchWarnRatio`（默认 0.75）以上按 warn 记录；`heapWatchSnapshotNearLimit`（默认 0，不抓取）接上 `v8.setHeapSnapshotNearHeapLimit`，让下次临界自动留下 heap snapshot。非法策略在安装期抛错，且校验先于"禁用"短路。

## Alternatives considered

**只把 Node 堆上限调大。** 否决：4,288 MB 是默认值而非硬约束，调大只是把墙往后推；本次事故的 4 GB 是 25 小时的真实累积，加倍只能换来一次更晚的中止。部署仍应显式设置 `--max-old-space-size` 并在临界抓 snapshot，但那是止血，不是修复。

**在 `Session` 里做内存日志折叠（复用 chunk-rows）。** 否决：要改的是"日志是唯一权威"这一核心不变式——`seq` 的连续性、projection fold 与 follow 的 gap 检测都建立在 `log` 之上，折叠要么破坏它们，要么在每个读取点引入解折叠层。退役 + 冷恢复相反：它是既有的、Client 已处理好的路径。

**为活跃集加定时淘汰。** 否决：没有新激活就没有新增长，配额已经在增长发生的那一刻被 enforcement；定时器只会给空闲进程增加噪音与唤醒，还会让"何时释放"变得不可预测。

**只做水位诊断，不动保留策略。** 否决：诊断能把下次失败变成证据，但不会阻止它；本次事故里保留集与堆上限之间没有任何缓冲。

## Consequences

收益：Host 的内存由配额而非会话数量决定，`follow`（打开会话）不再隐含"永久保留"，长时间运行的 Host 有一行可读的水位曲线，临界时还能自动产出 heap snapshot 供事后定位。代价：被释放的 Session 在下次使用时支付一次冷恢复（重读并折叠日志），对巨型 Session 是可见延迟；默认 16 的上限意味着同时打开的会话需要超过 16 个才会触发释放，日常使用不会察觉。契约面新增 5 个可选 Config 字段，缺省或 `0` 都保持旧行为，未改动任何 Remote 方法或事件。

## Testing

漏拦复盘：既有控制器用例覆盖的都是"某次操作是否正确"，没有一条断言"长期驻留的保留集有界"——配额是横切每个入口的性质，不是任何单一路径的行为，所以它既不在既有用例的形状里，也没有对应的回归。改进措施即本条 Decision 的三类断言（配额、静默期、运行中不释放）与 Host 级"释放不广播删除"的集成用例；水位日志让下一次同类问题在崩溃之前就有曲线可读。



`packages/api/session-controller/tests/agent-retention.host.spec.ts` 覆盖控制器级 9 例（未超上限不释放、上限为 0 不释放、LRU 释放且保留释放只报告一次、静默期边界、运行中永不释放但之后排空到配额内、显式 release 不算保留释放、保留事件计数、释放失败被容纳且不破坏触发它的激活、被后来生命周期接管的条目只剪枝不释放）与 Host 级 2 例（超过上限的静默 Session 被退役但不广播 `api-session/removed` 且下次解析冷恢复成功；回合边界重启静默期）。Host 级夹具沿用仓库既有的 `activatingFactory` 范式，令 dispose 同时摘除 Agent 与 Session，因此"不广播"的断言建立在真实的 `session/disposed` 之上，而不是一个不会触发它的替身。`tests/heap-watch.host.spec.ts` 覆盖渲染、阈值边界（含堆上限缺失）、真实进程采样、安装期 info 与 warn、禁用时不安装、卸载后停止采样，以及非法策略抛错。
