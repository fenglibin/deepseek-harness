---
description: "面向用户与维护者的限流故障转移说明：在 agent 请求被限流时轮流切换候选模型，避免每次限流都等待固定退避。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-failover

## 概述

`dsh-llm-failover` 是限流场景下的模型故障转移插件：当一个模型请求因限流（`RATE_LIMIT`，HTTP 429）失败时，它把下一次重试的路由改写为本步骤内尚未尝试过的候选模型，从而跳过提供方重试策略里固定的限流等待；只有全部候选模型也都被限流后，它才把失败转交给下游重试执行器（`dsh-llm-retry`），恢复原来的等待后重试行为。每次限流都能立即换一个模型重试，而不是每次都干等 30 秒。

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

当 agent 运行需要从暂时性限流中恢复、并且部署里还有多个可用的模型路由时，挂载本包。它是限流场景的优化器：提供方适配器拥有各自的 `retryPolicy`，本包只决定“限流时先换哪个模型”，不改变重试策略本身。

### 何时选择

当组合同时运行 agent loop 与 `dsh-llm-retry`、并且希望限流时优先轮换候选模型而不是直接等待时选择它。候选列表为空时本包是一个 no-op，每个限流都原样转交给提供方重试策略。直接调用 `ctx.llm.stream()` 的消费方跳过本包：它们不经过 `agent/request-error` 扩展点。

### 最小配置

候选模型是一组有序的提供方／模型路由。限流时按声明顺序轮换：

```yaml
- name: '@deepseek-ai/dsh-llm-failover'
  config:
    candidates:
      - provider: deepseek-official
        model: deepseek-v4-pro
      - provider: deepseek-official
        model: deepseek-v4-flash
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `when` | `[]` | 限定故障转移生效的锚点模型路由（`provider`／`model`）；留空匹配所有锚点模型，否则仅对列出的模型生效 |
| `candidates` | `[]` | 限流时按顺序尝试的候选路由；每个条目需要非空 `provider` 与 `model` |

省略 `candidates` 或留空即关闭故障转移。`when` 留空时故障转移适用于所有锚点模型；列出路由时，仅当会话所选模型命中其中一项，该模型被限流才会触发故障转移，其余模型被限流仍按原样转交给提供方重试策略。候选路由不校验目录成员关系：一个候选指向未注册的提供方时，该次请求会以 `NO_ADAPTER` 大声失败，而不是静默跳过。

### 你可以观察到什么

故障转移不会产生新的会话事件。限流发生后，本插件把下一次重试的路由改写为候选模型，立即返回 `{ kind: 'retry' }`，因此会话日志里只会看到针对候选模型的 `request/header` 与 `request/context` 快照，不会看到固定等待对应的 `llm/retry` 事件。当全部候选都尝试过之后，后续限流才由 `dsh-llm-retry` 记录 `llm/retry` 并等待。

### 失败与恢复

只对 `RATE_LIMIT` 生效；其它失败 code 原样转交给下游。每个 step 是一次独立的故障转移周期：一次成功完成后，下一个 step 的限流会重新从候选列表开头轮换。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释故障转移背后的设计；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

故障转移建立在两个 agent 扩展点上：`agent/request-error` 决定“是否立即重试并换成哪个模型”，`agent/request` 把挂起的候选路由落到下一次请求配置上。两个监听器都用 `prepend` 注册以保证顺序——`agent/request-error` 上先于提供方重试执行器运行，从而用立即重试短路掉固定等待；`agent/request` 上先于模型选择运行，从而让候选路由成为请求的最终路由。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 函数插件：候选解析、`agent/request` 路由改写、`agent/request-error` 立即重试与转交、`agent/pre-step` 周期复位 |

### 恢复流程

限流失败连同其路由到达 `agent/request-error`。本插件把当前路由加入本步骤的 `tried` 集合，选出第一个尚未尝试的候选，记为挂起路由并返回 `{ kind: 'retry' }`；loop 随后重跑本步骤，`agent/request` 把挂起路由应用到请求配置、把候选标记为已尝试，同时清掉旧路由的推理强度让候选解析自己的默认值。因此候选无论随后以限流还是其它错误失败，都不会在本步骤内被重复选中。没有未尝试候选时调用 `next()`，把失败交给 `dsh-llm-retry` 的固定限流等待。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

包级约定对大多数消费方已经足够；需要周边领域时再阅读以下页面。

- [dsh-llm 服务](../llm/README.zh.md)——拥有 `retryPolicy` 的提供方无关服务。
- [llm-retry 包](../llm-retry/README.zh.md)——本插件转交失败后执行固定限流等待的重试执行器。
- [LLM 流式子系统](../../../docs/subsystems/llm-streaming.zh.md)——`StreamChunk` 协议与适配器约定。

-----

<a id="model-experience"></a>
## 模型体验

通过改写重试请求的 `provider`／`model` 路由间接影响；模型可见请求内容与消息仍由请求组装与提供方适配器负责，本插件不改动任何模型可见文本。

#### KV Cache 影响

切换模型会使重建的请求落到另一个模型路由，该路由的 KV Cache 前缀可能与原模型不同；原请求的失败分片不会进入派生消息，因此不会污染任何模型的上下文。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定故障转移的作用范围。它们是当前包约束，不是任务积压。

- **agent 轮次是唯一边界**——直接 `ctx.llm.stream()` 的消费方仍是单次尝试，不经过本插件的扩展点。
- **候选轮换是一次性的**——每个 step 只按顺序尝试每个候选一次；全部候选都限流后，本插件退回纯等待重试，直到下一个 step 才重新轮换。
- **候选路由不预校验**——指向未注册提供方的候选会在使用时以 `NO_ADAPTER` 失败，而不是在加载期被拒绝。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：维护者备注与开放问题。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- 故障转移状态是进程内的 `WeakMap`，按 agent 持有，刻意不持久化：一次冷恢复会从当前 step 的开头重新开始轮换，这与“每个 step 是一次独立周期”的语义一致。
- 候选轮换对 `agent/request` 使用 `prepend` 注册，保证它先于 `installModelSelection` 这类在 agent 创建时注册的模型选择监听器运行，从而让候选路由成为最终路由。

</details>
