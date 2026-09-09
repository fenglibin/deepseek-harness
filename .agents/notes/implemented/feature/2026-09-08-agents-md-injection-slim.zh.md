# Agent Note: 精简注入的 AGENTS.md 基线以降低每次请求的固定开销

Status: implemented

## Problem

`agent-instructions` 把三份 AGENTS.md 作为会话基线注入：`AGENTS.md`（23,900 字节）、`packages/AGENTS.md`（6,271）、`packages/client/AGENTS.md`（24,766），合计 54,937 字节，且每一次模型请求都会随基线重发。

实测会话显示 25 次请求分布在 36 分钟内，密集段 38.6 秒内发 4 次请求（约 6.2 次/分钟）。单次请求约 40k tokens 时峰值达到约 248k tokens/分钟，逼近 250k 的 TPM 上限——超限发生在密集段，不是整场平均。基线里混入的低频查阅型内容（目录树、命令清单、新建包清单、依赖声明细则）是这部分开销的大头，它们只在特定任务里有用，却和"违反即加载失败"的硬规则一起被无条件注入。

## Decision

按"违反会不会静默产出错的东西"重新划分三份文件，合计从 54,937 降到 30,480 字节（-44.5%）：

- **`packages/client/AGENTS.md` 24,766 → 8,543**：逐字保留 Slot and props discipline（7 条）、Reactive read、ctx discipline、Layering non-negotiables、Directory regime；把 Dependency declaration、Build-time browser environment、Export discipline、New plugin package checklist、New component checklist、Before you push 迁到 `docs/subsystems/web-client.zh.md`，Shared modules and the module graph 迁到 `client-modules.zh.md`，Styling 迁到 `docs/web-styling.zh.md`，Testing 迁到 `docs/testing.zh.md`。末尾留 `## Moved to the subsystem docs` 对照表，让读者知道去哪找而不是以为规则被删了。Conversation Node discipline 直接压缩为链接——`conversation.zh.md` 已有 18 处覆盖 `match`/`update`。
- **`AGENTS.md` 23,900 → 15,666**：删除与中文段完全重复的 CodeGraph 英文段（3,525 字节）；目录树迁到 `packages/README.zh.md`、命令清单迁到 `docs/development.zh.md`，各留一句链接；散文规范压成一句，保留"把可机械检查的不变式接入顶层 gate"这条硬约束。
- **`packages/AGENTS.md` 不动**：它只有 6,271 字节、712 词，而 `doc-budgets.manifest.json` 给它的是 750 词紧预算；内容是 15 条硬规则加命名约束，没有介绍性或查阅型内容，可压空间不足 10%，压缩只会损失 gate 实际检查的细节（tsconfig 的 `rootDir`/`outDir`、README 的三个要求）。它的开销问题不在篇幅，而在它对所有 `packages/` 工作无条件注入——那要靠按子目录分级的 nested 注入解决，不是靠删字。

## Alternatives considered

**只砍字数、不搬家。** 最快，但依赖声明、新建包清单、命令清单没有别的归宿，删掉即丢失，下次需要的人只能靠试错重新发现。

**改 `agent-instructions` 的 `maxBytes` 让它自动裁剪。** 裁剪规则（render.ts）在预算不足时先丢"最宽泛的"文件、再二分截断尾部，砍哪里由字节数决定而不是语义——很可能砍掉硬规则、留下清单。

**把 `packages/AGENTS.md` 也按比例压缩。** 会让它掉进 750 词预算的安全区，但代价是丢掉 gate 实际检查的配置细节，省下的不到总注入量的 2%，不值得。

## Consequences

- 收益：单次请求的 AGENTS.md 基线开销从约 18k tokens 降到约 10k tokens，密集段峰值每分钟少约 50k tokens。
- 代价：客户端规则现在分散在 `AGENTS.md` 与四篇子系统文档之间，改动一侧的人需要留意另一侧；对照表是这个代价的止血而不是根治。根 `AGENTS.md` 的目录树与命令清单也各自多了一处归属。
- 过程中修正了三类问题：一是初版"Moved"表声称 Export discipline、Build-time env、Styling/i18n、Testing 已有归宿，实测目标文档 0 处覆盖，已补搬原文；二是搬运后相对路径基准从 `packages/client/` 变为 `docs/`，13 处链接与锚点失效，已全部修复；三是本仓库文档用 `<a id="..."></a>` 显式声明锚点，追加章节必须同时写锚点，否则链接解析不到。
- 一次意外：首次追加到 `docs/development.zh.md` 与 `packages/README.zh.md` 的内容被另一个进行中的会话覆盖，导致 AGENTS.md 已删而目标文档未收到，内容一度真正丢失。已用 `git show HEAD:` 重新落地并改为追加后立即验证。并发会话下改文档必须"改完即验"，不能假设写入生效。
