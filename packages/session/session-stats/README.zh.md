---
description: "面向客户端与维护者的全日志会话计数与墙钟时间说明，用于选择、组合或排查 sessionStats 投影单元。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-stats

## 概述

`dsh-session-stats` 提供全日志会话数字——轮/步计数以及 LLM、工具、首 token、解码墙钟时间——以 `sessionStats` 投影单元的形式对外提供。客户端从注册表的快照与变更流中读取数字，且由于它们从完整持久日志折叠而来，分页或压缩都无法改变它们。同一插件还注册 `turnOutline` 单元，把整个日志里每个用户回合的起始提问折成有界预览，供聊天右侧的用户消息抽屉列出；它同样与分页无关，且一条刚发出的提问在落地时即可见，不必等该回合结束。第三个单元 `turnTiming` 按回合号提供墙钟时间、首 token 延迟与解码吞吐，让聊天底部的用时 pill 在每一轮都披露——回合边界被分页切出时，该轮不再缺少用时。在已挂载投影注册表的组合中选择它，例如 Web 聊天包（其统计条是参考消费者）；没有注册表的装配不受影响，其消费者回退到窗口口径计数。设置与字段语义在前；折叠内部细节放在下方可折叠的开发者章节中。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当客户端需要显示不受分页与压缩影响的全会话数字时，在会话存储与投影注册表旁挂载此插件。只有存在注册表时单元才会注册。

### 组合

```yaml
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-session-projection'
- name: '@deepseek-ai/dsh-session-stats'
```

### 各字段含义

| 字段 | 含义 |
|---|---|
| `turns` | 含至少一个已关闭步的不同轮次；被拒绝或空轮不计 |
| `steps` | 已关闭的步——完成、失败、取消与 max-tokens 的步全部计入 |
| `llmMs` | 组装出消息的步的模型墙钟时间之和 |
| `toolMs` | 匹配的 `tool/call` → `tool/result` 墙钟时间之和 |
| `ttftMs` / `ttftSteps` | 首 token 延迟之和及其承载步数 |
| `decodeMs` / `decodeTokens` | 上报用量的步的解码墙钟时间与提供方输出 token 之和 |

每个字段在首个贡献事件之前均为 0；已装配的注册表恒提供该键，因此客户端读取值本身，而非键的存在性。客户端通过投影 seam 的快照与变更流渲染全日志数字；参考消费者是 Web 聊天统计条，其窗口折叠以相同字段名充当无单元时的回退。

### 用户回合大纲

`turnOutline` 单元把每个以自身 `user/message` 开头的回合折成 `{ turn, prompt }`：`prompt` 是起始提问的有界单行预览，仅图或空 content 的提问为 `''`。列表按时间线排列，且包含正在进行中的那个回合——提问一落地就可见，`turn/end` 只把它定稿——因此抽屉不必等回合结束才显示读者刚发出的消息。

### 每轮用时与吞吐

`turnTiming` 单元按回合号提供四项事实：`runMs`（`turn/start` → `turn/end`）、`ttftMs`（该轮最低步的 `step/start` → 首个 token）、`tokensPerSecond`（同时上报解码时间与用量的步的合计比值）与 `peakTokensPerSecond`（其中单步的最高值）。单步回合的峰值恒等于平均，因为该回合只有一次模型调用；解码墙钟为 0 的步不产生比值。两个边界没有都落地的回合不产出条目。

### 失败与恢复

没有投影注册表时单元是惰性的：`inject` 使 fiber 保持挂起，不注册任何内容，因此其他装配缺少 `sessionStats` 键。卸载插件会移除该键，因为注册是挂载 fiber 上的 effect。被崩溃打断的步在会话重新加载后计入，届时崩溃恢复补写合成的 `step/end`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释数字背后的折叠；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

该单元是对已提交会话事件的纯折叠：`step/end` 是被计数的步事件，因为 agent loop 对每个进入的步在 `finally` 中恰好追加一条，因此完成、失败、取消与 max-tokens 的步都会落地一条。若改按已组装的 assistant 消息计数，则会多算 max-tokens 的 usage 宿主消息（空内容、被排除在 surface 之外），并少算被取消的步（在消息组装前已中止）。墙钟折叠逐字段对齐客户端窗口折叠。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`inject`、在挂载 fiber 上注册单元 |
| [`src/projection.ts`](src/projection.ts) | `sessionStats` 折叠：状态形状、逐事件转换、wire 视图 |
| [`src/turn-outline.ts`](src/turn-outline.ts) | `turnOutline` 折叠：用户回合起始提问的有界预览与 wire 视图 |
| [`src/turn-timing.ts`](src/turn-timing.ts) | `turnTiming` 折叠：每轮墙钟时间、首 token 与解码吞吐，以及其 wire 视图 |
| [`src/chunk-delta.ts`](src/chunk-delta.ts) | 两个 timing 折叠共用的首 token 判定 |
| [`src/types.ts`](src/types.ts) | 三个投影键的声明与字段类型的唯一归属 |

### 数据模型

折叠状态保存八个总计外加进行中的边界：`lastTurn`（最近一次被计数 `step/end` 的轮次）、`openStep`（打开步的边界事实，由其 `assistant/message` 关闭）与 `pendingCalls`（按 callId 记录的工具分发时间）。wire 视图是严格子集——八个总计——因此持久缓存的状态 schema 以边界字段扩展视图 schema。

### 折叠规则

- 不相关事件返回同一状态引用；注册表的 `Object.is` 门禁保持变更流安静。
- 首 token 延迟记录首个非空 delta chunk，并在步内 `llm/retry` 后保留。
- 解码时间与 token 只在同时携带首 token 与有效提供方用量报告的步上累加；与窗口折叠守卫节点用量一样忽略畸形用量。
- 工具时间按 callId 配对 `tool/call` → `tool/result`；未解决的调用在 `turn/end` 时丢弃，因为结果总在其轮内落地，而撞上 `Object` 原型名的 callId 读作未匹配。
- 每轮用时在该轮 `turn/end` 时由缓冲的轮内事件折叠，因此与客户端分页无关；步内 `llm/retry` 同样保留首 token 边界。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当单元约定不够用时阅读以下页面。它们从驱动单元的注册表逐步进入相邻的会话包。

- [会话投影子系统](../../../docs/subsystems/session-projection.zh.md)——驱动单元并提供快照与变更流值的注册表。
- [会话投影注册表包](../session-projection/README.zh.md)——单元注册所依据的注册表约定。
- [会话包映射](../README.zh.md)——相邻的持久化、投影、标题与遥测包。

-----

<a id="model-experience"></a>
## 模型体验

无，因为 sessionStats 单元把已写入日志的步边界折叠成面向客户端的读模型，不注册任何面向模型的内容。

#### KV Cache 影响

无；本包从不组装或发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明数字描述什么、单元何时缺失。它们是当前包约束。

- **步数统计的是已发生的工作，而非可见输出**——在产生任何可见内容前就失败的步仍以 `step/end` 关闭并计入；被崩溃打断的步在会话重新加载后计入，届时崩溃恢复补写合成的 `step/end`。
- **被取消的步计数但不计时**——没有组装出 assistant 消息，其部分流式时间不进入任何墙钟数字；反之 max-tokens 的 usage 宿主消息贡献 surface 上看不到的模型时间。
- **计数是日志口径，不是 surface 口径**——消息后来被压缩掉的步仍然计入；数字描述整个会话，而非当前模型可见 surface。
- **仅在组合了投影注册表时挂载**——其他装配不提供 `sessionStats` 键，其消费者回退到窗口口径计数。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
