---
description: "面向用户与维护者的模型轮询使用说明：每个 agent 步骤在会话所选模型与配置的候选池之间轮流切换模型，主动分散负载以降低限流概率。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-round-robin

## 概述

`dsh-llm-round-robin` 是主动的模型轮询插件：每个 agent 步骤把请求路由轮换到轮询池中的下一个模型，轮询池由「会话所选模型」锚定、后面跟一组配置的候选模型。与只在限流发生后切换的 [`dsh-llm-failover`](../llm-failover/README.zh.md) 不同，本插件在每个步骤都主动换一个模型，把连续请求分散到多个路由，从而降低任何单一模型触发限流的概率。

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

当 agent 运行会密集发起模型请求、并且部署里有多个可用的模型路由时挂载本包。它是负载分散器：每个步骤在「会话所选模型 + 候选模型」之间轮流取值，不改变请求内容或重试策略。

### 何时选择

当组合同时运行 agent loop，并希望在多个模型之间主动轮换以摊薄每个模型的请求频率时选择它。候选列表为空时本包是一个 no-op，每个步骤都沿用会话所选模型。直接调用 `ctx.llm.stream()` 的消费方跳过本包：它们不经过 `agent/request` 扩展点。

### 最小配置

候选模型是一组有序的提供方／模型路由。会话所选模型始终是轮询池的第一个元素，之后按声明顺序轮换候选：

```yaml
- name: '@deepseek-ai/dsh-llm-round-robin'
  config:
    candidates:
      - provider: deepseek-official
        model: deepseek-v4-pro
      - provider: deepseek-official
        model: deepseek-v4-flash
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `when` | `[]` | 限定轮询生效的锚点模型路由（`provider`／`model`）；留空匹配所有锚点模型，否则仅对列出的模型生效 |
| `candidates` | `[]` | 会话所选模型之后按顺序轮换的候选路由；每个条目需要非空 `provider` 与 `model` |

省略 `candidates` 或留空即关闭轮询。`when` 留空时轮询适用于所有锚点模型；列出路由时，仅当会话所选模型命中其中一项才轮换，其余步骤沿用会话所选模型。候选路由不校验目录成员关系：一个候选指向未注册的提供方时，轮到它的那次请求会以 `NO_ADAPTER` 大声失败，而不是静默跳过。

### 你可以观察到什么

轮询不会产生新的会话事件。每个步骤轮换一次，因此会话日志里只会看到针对不同模型的 `request/header` 与 `request/context` 快照；轮询顺序是「会话所选模型 → 候选 1 → 候选 2 → … → 会话所选模型」循环。

### 失败与恢复

轮询不处理失败。某个模型请求失败后，恢复由下游重试执行器（`dsh-llm-retry`）或限流故障转移（`dsh-llm-failover`）负责；本插件只决定每个步骤先用哪个模型。同一步骤内的重试不会再次轮换——它们沿用该步骤已经选定的模型。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释轮询背后的设计；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

轮询建立在两个 agent 扩展点上：`agent/pre-step` 在每个步骤边界推进游标，`agent/request` 把游标映射到请求配置。`agent/request` 用 `prepend` 注册以保证顺序——它先于模型选择运行，从而让轮询结果成为请求的最终路由；`agent/pre-step` 是步骤边界的权威信号，重试不会再次触发它，所以同一逻辑请求的重试沿用同一模型。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 函数插件：候选解析、`agent/pre-step` 游标推进、`agent/request` 路由改写 |

### 轮询流程

每个步骤开始时 `agent/pre-step` 把该 agent 的游标加一。请求组装时，`agent/request` 用 `await next()` 拿到会话所选模型作为锚点，组装去重后的轮询池 `[锚点, ...候选]`，按 `游标 % 池大小` 选中下一个模型；游标落在锚点上时原样返回，落在候选上时改写路由并清掉锚点的推理强度，让候选解析自己的适配器默认值。因此候选无论随后以何种错误失败，都不会改变本步骤已经选定的模型。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

包级约定对大多数消费方已经足够；需要周边领域时再阅读以下页面。

- [dsh-llm 服务](../llm/README.zh.md)——拥有 `retryPolicy` 的提供方无关服务。
- [llm-failover 包](../llm-failover/README.zh.md)——限流发生时切换候选模型的故障转移，与本包互补。
- [LLM 流式子系统](../../../docs/subsystems/llm-streaming.zh.md)——`StreamChunk` 协议与适配器约定。

-----

<a id="model-experience"></a>
## 模型体验

通过改写每个步骤请求的 `provider`／`model` 路由间接影响；模型可见请求内容与消息仍由请求组装与提供方适配器负责，本插件不改动任何模型可见文本。

#### KV Cache 影响

轮换会把请求落到不同模型路由，各路由的 KV Cache 前缀可能与锚点模型不同，从而降低前缀复用率；请求内容本身不变，因此不会污染任何模型的上下文。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定轮询的作用范围。它们是当前包约束，不是任务积压。

- **agent 步骤是唯一边界**——直接 `ctx.llm.stream()` 的消费方仍是单次调用，不经过本插件的扩展点。
- **候选路由不预校验**——指向未注册提供方的候选会在轮到时以 `NO_ADAPTER` 失败，而不是在加载期被拒绝。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：维护者备注与开放问题。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- 轮询状态是进程内的 `WeakMap`，按 agent 持有，刻意不持久化：一次冷恢复会从当前步骤的锚点重新开始轮换，这与「每个步骤是一次独立轮换」的语义一致。
- 候选轮换对 `agent/request` 使用 `prepend` 注册，保证它先于 `installModelSelection` 这类在 agent 创建时注册的模型选择监听器运行，从而让轮询结果成为最终路由。
- 游标在 `agent/pre-step` 里无条件推进，即使某个步骤被拒绝也会推进一格；这只让轮询顺序偏移一格，不影响正确性。

</details>
