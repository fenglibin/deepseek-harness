# Agent Note: 投影检查点无界把 `dsh web` 拖进堆快照停摆

Status: implemented

## Problem

一个 `dsh web` 进程停止应答：端口仍在 LISTEN，浏览器连接保持 ESTABLISHED，首页请求永远转圈。进程没有死，它 88% CPU、RSS 8.5 GB、累计 CPU 时间 40 分钟，`sample` 两次（间隔 15 分钟）拿到完全相同的调用栈：

```
uv__run_timers → v8::internal::Heap::CollectGarbage
  → v8::internal::HeapProfiler::TakeSnapshot
  → v8::internal::HeapSnapshotGenerator::GenerateSnapshot()
  → V8HeapExplorer::IterateAndExtractReferences → ExtractPropertyReferences
```

`--heapsnapshot-near-heap-limit` 触发的捕获在 GC 回调里**同步**执行，V8 先把整张快照图建在内存里再流式写盘，全程不让出 event loop。于是 HTTP 服务彻底停摆，而快照文件 15 分钟后仍是 0 字节（还在建图），进程 physical footprint 52 GB（≈12 GB 堆 + ~40 GB 快照图）。诊断钩子把一个会留下 `FATAL ERROR` 与水印曲线的崩溃，变成了一个两者都不留下的无限停顿。

堆为什么到 12 GB，是三个各自合理的决定叠加出来的：

1. **`turnUsage` 投影缓存了整个回合的原始事件。** `turn-usage-projection` 用 `buffer: [...state.buffer, event]` 累积 `turn/start` 到 `turn/end` 之间的每个事件，而一个回合可以横跨整段会话（一次 prompt、一次长时间自主执行）。两个 XFClaw 会话的投影文档里，`turnUsage.turns` 是 `{}`、`currentTurn` 是 `1`、`buffer` 从第 132 行一直排到第 1,514,155 行（下一个键 `sessionStats`），占满 46 MB 文档的 99%；另一份 54.8 MB 的同形。这份状态既无界又是 O(n²)——每个事件都复制一次整个数组。
2. **检查点写入把这份状态物化两遍再序列化。** 注册表的 `checkpoint()` 先 `structuredClone` 一份（它的契约要求 `val` 必须脱离实时引用），缓存再 `snapshotJsonValue` 深拷贝一份，然后 `JSON.stringify` 成约 48 MB 的字符串并 fsync。`writeEveryEvents: 200` 意味着一个 9 万事件的回合要付约 450 次这样的代价。事故时刻的现场正好是这次写入：进程 fd 22w 打开着 48,234,496 字节的 `writeAtomic` 临时文件（mtime 12:29），而快照文件的 mtime 是 12:29:54。
3. **这份状态对每个已存会话常驻，且不受任何保留上限约束。** `session_projcache` 用 per-record JSON 布局，`loadAll` 在打开域时把目录下每条记录读进内存，所以内存随会话数量线性增长。`liveAgentLimit`（默认 16）只约束保留的 Agent，管不到这张表。

2026-09-10 的有界 Agent 保留修复没有拦住它，因为那条边界约束的是 **Agent 数量**，而这里的成本是"每会话 × 会话长度"。

## Decision

**投影状态必须是可检查点的，而不只是可折叠的。** `turnUsage` 改为增量折叠：`TurnUsageFold` 携带 `turn`、`attempt`（尝试生命周期状态机）、`attempts`（每个**已结算**尝试一条）、`sawEnd`、`invalid`，由 `beginTurnUsageFold` / `stepTurnUsageFold` / `settleTurnUsageFold` 驱动。状态因此随回合的步数增长，而不是随事件数增长——事故里那两个会话的回合各有 161 步。`deriveTurnTokenUsage`（客户端窗口折叠）改为在这台机器之上实现，两个读者仍然共用一套语义，只是不再共用一份事件缓冲。`stateVersion` 从 1 升到 2，旧的缓存行按既有规则在读取时被丢弃而不是迁移。

**检查点路径只保留一次深拷贝。** 注册表的 `structuredClone` 是契约上的那一次（`val` 必须脱离实时引用），缓存侧改为用 `isJsonValue` **校验**无损 JSON 契约而不是再 `snapshotJsonValue` 拷贝一次。`put` 现在显式声明前置条件：调用方必须传入已脱离的值（`write` 传注册表的检查点，`coldSnapshot` 传 restore 新折叠出的值）。

**常驻内存是预算，不是会话数的函数。** 缓存新增 `maxRowBytes`（默认 4 MiB）与 `budgetBytes`（默认 64 MiB）。超过行上限的检查点不写入、已存储的会被丢弃；常驻总量超预算时按最冷优先丢弃，启动时先做一次同样的清扫（这是让调低的策略对既有行生效的唯一时刻）。两类行永不作为牺牲者：仍被挂载的会话的行（下一次检查点会立刻重写它，丢弃只换来写抖动），以及本次刚写入的行。丢弃的是派生数据，下一次冷读重折叠日志即可，代价只是一段更长的尾部重放。

**临界快照不再默认开启。** `run.sh` 去掉 `--heapsnapshot-near-heap-limit`，只保留显式的 `--max-old-space-size`，并写清为什么不能再加回来；`heap-watch.ts` 与 `session-controller` 的 `snapshotNearLimit` / `heapWatchSnapshotNearLimit` JSDoc 从"代价是一次停顿"改成陈述实情：同步建图、footprint 数倍于堆、大堆上等于无限停顿。水印（默认 5 分钟一行）才是让进程继续服务的诊断。

## Why the agent-retention fix did not catch this

那条边界问的是"Host 保留多少个 Agent"，它按 Session 数量与空闲时长工作。这个缺陷的成本是每个会话自己的**投影状态**乘以会话长度，与 Agent 数量无关，也与空闲无关——一个刚被打开的会话就会写出它。两个边界度量的是不同维度，所以前者通过并不蕴含后者成立。

## Alternatives considered

**只做保留预算（C），不把投影状态改成有界。** 否决：行上限会把每一次检查点都变成拒绝，会话于是完全不被缓存，`cachedSnapshot` 的零 I/O 列表读取对所有长会话失效。状态必须先有界，缓存才有意义；两者是互补的而不是可替代的。

**保留原始事件缓冲，只给它加长度上限。** 否决：上限让披露取决于上限落在哪里——同一个回合会因为长度不同而得出不同会计。折叠保持精确，且顺带消掉 O(n²) 的数组复制。

**把聚合也改成增量（维护运行中的求和）。** 否决：`aggregateAttempts` 对 `reasoningTokens` 与 `routes` 是"全有或全无"语义（前者要求每个尝试都上报，后者要求每个尝试都有归属），重写一遍等于把这套规则复制成两份，日后必然分叉。折叠保留一台状态机与一个聚合器，而 `attempts` 只随步数增长。

**改去掉注册表的 `structuredClone`，保留缓存的 `snapshotJsonValue`。** 否决：注册表的 `checkpoint()` 契约明确写着每个 `val` 都是脱离的 clone，`session-title`、`token-meter`、`session-projection-cache` 之外的调用方也依赖它；保留那一次、把缓存侧的拷贝降级为校验，是更小的契约改动。

**把预算做成硬上限（包括丢弃活跃会话的行）。** 否决：被挂载会话的行正是下一次写入的目标，丢掉它等于用预算换写抖动，并让会话的下一次读取支付一次刚支付过的重折叠。软的部分写在配置 JSDoc 与 README 里。

**保留临界快照但改成异步。** 否决：V8 的快照构造就是同步的，worker 也无法剖析主 isolate 的堆；"异步快照"不是可选项。

**改成调低 `--max-old-space-size` 而不摘掉快照。** 否决：那只会更早中止，依然不留下剖析，而水印已经在 75% 处告警——它本来就是这个用途。

## Consequences

收益：投影状态从"整段日志"缩到"每个回合的尝试数"，事故里的 46 MB 检查点文档变成约 1 KB 量级；检查点路径少掉一次与状态等大的深拷贝；缓存内存成为可配置预算，不再随会话数量线性增长；`dsh web` 在内存压力下仍然服务，操作者拿到的是水印曲线而不是一个静默停顿。代价：`stateVersion` 升到 2 会让所有既有 `turnUsage` 缓存行失效，每个长会话的下一次冷读要多折叠一次尾部；超过行上限的检查点不再被缓存，那些会话的每次冷读都要重折叠整段日志（日志本身有告警）；预算是软的，当所有行都属于活跃会话时允许暂时超出。契约面新增两个有默认值的 Config 字段，且 base bundle 显式声明了它们。

## Testing

`turn-usage.spec.ts` 新增增量折叠的行为断言（整段折叠与逐事件折叠一致、invalid 会闩锁、回合未结束不披露、每个已结算尝试一条记录），既有的 50 条整段折叠用例保持不变地全绿——它们是这次重写的等价性证据。`turn-usage-projection.spec.ts` 新增"检查点状态随步数而非事件数增长"（20 步 × 4 KB 载荷折叠后小于 8 KB）与"未结束回合的折叠能通过持久文档往返"两条。`cache.spec.ts` 新增"超行上限不缓存、已存的行在打开时被清扫"与"预算按冷行淘汰、绝不动活跃会话的行"两条，以及一条锁定单次脱离点的用例（写入后改动实时状态不得改写已存记录）。

顺带修掉三条既有抖动用例，它们犯的是同一个错：等待条件比断言弱，于是"先到的那次写入"满足了等待。`writes at session disposal (detach, the live-to-cold moment)` 等的是"文档里有值"，而创建写入留下的旧切面就能满足它（HEAD 上实测 5/12 失败），谓词改为等待**释放切面自己的水位**；`contains a durable write failure` 等的是"有告警"，而创建写入对着同一个 blocker 失败的告警先到，谓词改为点名它要断言的**那条** `turn/end` 告警；`coldSnapshot write-back is fail-soft` 用的是固定 `settle()`，改为轮询那条 write-back 告警。三处都保留了原作者"不依赖固定 settle"的意图。

量化证据（实测，不是估计）：以事故里最大的会话（`session-add4be94`，内存 769,057 个事件、落盘 31,044 行）为输入，折叠 `turnUsage` 全程耗时 **12 ms**，得到 161 个已结算尝试——所以"版本升级要重折叠一次"的代价是毫秒级，不是这次停摆的原因。真实缓存目录（81 条记录、估算 127.2 MiB）在默认策略下被清扫掉的正是 3 条病态记录（57.8 / 48.6 / 19.1 MB，全部由 `turnUsage` 主导），其余记录的**最大正常键只有约 7 KB**，所以 4 MiB 的行上限有约 600 倍余量，不会误杀正常会话。

需求层面的端到端验证：以真实数据的副本冷启动一个 `dsh web`，首页 `GET /?token=…` → 303 → `GET /` 返回 **200 / 26,166 字节 HTML / 4 ms**，进程随后稳定在个位数 CPU、约 490 MB RSS——这正是事故当天"转圈圈出不来"的反面。
