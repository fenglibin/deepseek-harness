# Agent Note: 会话与工作区列表的加载成本

Status: implemented

## Problem

工作区与会话的加载成本来自两个结构完全不同的地方，但两者在启动时叠加，并且都随会话数增长。

工作区一侧有一份自己的账本（`storages/workspace.json`），启动后所有读取都是同步零 I/O。会话一侧没有索引：`sessionPersistence.list()` 每次都遍历根下的每个会话目录，并为每份日志读取 header 行。启动时 `WorkspaceRegistry` 还要对每个 header 做一次 `realpath(cwd)` + `stat()`，且未按 cwd 去重——而会话天然聚集在极少数目录上（实测 196 个会话只来自 4 个目录，一个工作区的全部成员共享同一个 cwd）。

于此同时，客户端的会话列表刷新还藏着一个更陡的悬崖：`mergeOrderedBaseline` 对每个新行做一次线性扫描来定位插入点，在低重叠输入上退化到三次方。它只在首次拉取之后才被走到（`listPhase` 为 `ready` 时），而断线重连恰好就是这条路径，所以在真实使用中可达，只是平时看不见。

本 note 记录把这四处成本降下来的决策。它不改动任何持久格式，也不引入新的索引文件——那是一个有待单独决策的格式问题，见 [在会话索引中记录最后活动](../../proposed/architecture/2026-07-29-durable-last-activity-index.zh.md)。

## Decision

**会话列举改成 dirent 驱动 + 有界并发。** `listArtifacts` 原来对每个会话目录做三次 `open()` 探测（反向编码是否存在、日志是否存在、然后才打开日志读 header）。现在每个会话目录只 `readdir` 一次，一次调用就同时给出：本后端的日志是否存在、反向编码是否存在（致命失配）、以及条目的文件性。只有幸存的 header 读取才扇出，受 `LIST_ARTIFACT_CONCURRENCY` 限制。

分三个阶段，且顺序是承载语义的：根与项目目录串行遍历，因此"根不是目录"或"项目目录持有平铺遗留产物"仍然在任何按会话的工作开始前拒绝；每个会话目录的阶段在扇出之前完成，因此结构性失配永远先于 header 失配被报告。会话目录阶段与 `ensureRootEncoding` 检查的是同一个条件、给出同一个错误，所以列举不再等待它——那会为每个会话目录多付一次 `open()`。定向路径（`loadStored`、`readRaw`、`deleteStored`）仍保留它。

**并发的错误报告按输入下标而非完成顺序。** `mapBounded` 记录最低的失败下标并只报告它。这让一个同时存在多种故障的 store 每次运行都报同一个故障，而不是让诊断取决于谁先跑完；代价是慢的一项会推迟已经发现的故障。

**工作区侧按 cwd 记忆。** `resolveCwd` 以原始 cwd 为键记忆规范目录答案：`realpath` 对同一输入幂等，header 的 cwd 不可变，因此一次索引内同一 cwd 只可能有一个答案。这个 memo 属于索引的一部分，`replaceHeaderIndex` 会一并清除，所以增量重建不会复用另一次列举的答案。

**`mergeOrderedBaseline` 改为线性。** 已知行保留客户端的相对顺序并取基线的值；基线独有的行按"其后最近的已知行"分组，一次正向遍历完成分组。

## Alternatives considered

**给会话元数据建持久化索引。** 能从根本上消除列举的线性成本，但正是本 note 有意不做的事：文件在后端之外被删除时索引会漂移，而 JSONL 的单产物设计正是为了避免这种不一致。它会改动持久格式，属于格式决策。

**用目录 mtime 做列举缓存的失效信号。** 理论上成立（append 不改目录 mtime，header 不可变），但跨进程写入、mtime 时钟粒度、以及 NFS/SMB 的 mtime 缓存，每一条都能让"列表里少一个会话"发生。`list()` 是正确性敏感路径——会话是否出现在 UI 里取决于它——不值得用文件系统时间戳去推断。

**无限扇出 header 读取。** 在大 session root 上会耗尽进程的文件描述符表（EMFILE），报出一个调用方无法处理的错误，而不是本次的实际问题。有界并发报出的仍是真实的存储故障。

**保留并发的完成序错误报告。** `Promise.all` 的实现更简单，但同一个损坏 store 会在不同运行里报不同的错。这里的诊断价值高于实现的简洁。

## Consequences

列举的每会话 I/O 从「3 次 `open()` + 1 次读」降为「1 次 `readdir` + 1 次读」，扇出后本地 SSD 上 5000 会话约从 1.0s 降到 0.37s。工作区侧的 cwd 解析在 5000 header / 20 唯一 cwd 的合成场景里从 152ms 降到 1ms；收益等于「1 减去唯一 cwd 数与会话数之比」，所以会话集中在少数目录时才成立——而工作区本身按目录聚合，这正是常态。

`mergeOrderedBaseline` 在 5000 行、10% 重叠的最坏形态下从约 61s 降到 1.4ms，且现在是线性的；n=12000 时仍为 2ms。

代价有三处。其一，并发让诊断更依赖顺序约束：结构性阶段必须留在扇出之前，这个约束此前是串行的副产品，现在成了一条需要维护、并且由测试钉住的约定。其二，`mapBounded` 会等所有项 settle 才报告故障，因此一个慢项会推迟已发现的故障。其三，Windows 的 `dirent.isFile()/isDirectory()` 在 junction 与符号链接上的语义不同于 `open`，而这个仓库有 `ci-windows-blocking` 门禁——现在被 `readdir` 取代的 `exists()` 曾为 win32 特判过 ENOTDIR。

列举仍然是线性的，且没有跨调用缓存：每次刷新都重新付这笔成本。这一点已写入 `dsh-session-persistence-jsonl` 的 README 已知限制，并指向 SQLite 后端作为数千会话量级的替代。本 note 不解决它。

## Testing

- `jsonl.spec.ts` 新增两项：一项用 `open()` 计数（而非墙钟）断言每份日志至多被打开一次且去重，因为墙钟断言在 CI 并发下必然 flaky；一项在同一 store 里同时放入反向编码产物与 cwd 不匹配的 header，断言报出的是结构性失配——即扇出不得让自己的失败抢先。
- `ordered-baseline.client.spec.ts` 为这个此前没有测试文件引用的纯函数补了覆盖，其中一项以朴素插入实现为对照，在 500 组随机重叠与顺序上断言一致。改动期间另以 git HEAD 上的原始实现为对照做了 20000 组差分（对照实现取自 git 而非手抄，以排除同源抄错）。
- `workspace.spec.ts` 新增两项：共享同一 cwd 的多个会话必须全部进入 `sessionIds`（记忆若只服务首个调用方、或混淆命中与未命中分支就会漏掉其余），以及不同失败原因在共享解析后仍保持各自的消息。

## Related

- [在会话索引中记录最后活动](../../proposed/architecture/2026-07-29-durable-last-activity-index.zh.md)——论证了为什么列举必须保持只读 header：为计算 `updatedAt` 而读每份日志，会让 `list()` 的成本随总字节数而非会话数增长。本 note 的优化建立在同一前提上，也因此刻意没有把该字段加进列举路径。
- [会话持久化](2026-06-14-session-persistence.zh.md)——仅追加与绝不重写的不变式，它们是「不建索引」这一决定的上游依据。
