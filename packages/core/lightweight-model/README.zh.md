---
description: "面向用户与维护者的轻量模型路由说明，用于决定会话标题、压缩摘要等辅助调用应该使用哪个模型。"
kind: "package-reference"
---

# @deepseek-ai/dsh-lightweight-model

## 概述

`dsh-lightweight-model` 持有一个可选的 provider/model 路由，供辅助模型调用使用，而不是复用会话自己的模型。会话标题与压缩摘要——LLM 接缝中用 `GenerateOptions.purpose` 标记的两类调用——会先查询 `ctx.lightweightModel`，再回落到主请求使用的路由，因此当会话所用模型无法胜任一个很短的辅助请求时，标题仍然能生成。该路由默认为空；用户在「设置」→「模型」中挑选后，已挂载的设置提供方会把这个选择叠加到组合配置项之上。当辅助调用应该运行在比会话更便宜或更快的模型上时，请选择本包。

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

当辅助模型调用需要能够脱离会话自身路由时，挂载本包。该服务回答一个问题——辅助调用应该使用哪条路由（如果有）？——用户未设置时它保持沉默。

### 配置路由

组合配置项是可选的，默认为空。同时给出两个字段，即可为部署提供自己的基础路由：

```yaml
- name: '@deepseek-ai/dsh-lightweight-model'
  config:
    provider: deepseek-official
    model: deepseek-v4-flash
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `provider` | `''` | 辅助调用使用的已注册提供方路由；为空表示未设置 |
| `model` | `''` | 辅助调用使用的提供方模型 id；为空表示未设置 |

省略 `config` 会让路由保持为空，这也是随发行版附带的默认值：此时辅助调用与引入本包之前一样，原样复用会话自己的路由。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-lightweight-model)是每个受支持字段的穷尽式真源。

### 读取与修改路由

`currentSelection()` 返回一个游离的 `{ provider, model }`，路由未设置时返回 `undefined`。`saveSelection()` 保存一条路由；`clearSelection()` 清空它，让辅助调用重新跟随会话。

```text
const route = ctx.lightweightModel.currentSelection()
if (route !== undefined) dispatch(route)
await ctx.lightweightModel.clearSelection()
```

没有设置提供方时，两个写入都是空操作，组合配置项保持当前值。本服务不校验目录成员资格：一条提供方路由可以提供未对外宣告的模型，可用性诊断由发起请求的消费方负责。

### 消费路由

消费方通过 `ctx.get('lightweightModel')` 读取本服务（因为它是可选的），并把它放在自身显式配置与继承来的会话路由之间：

```text
const target = configured ?? ctx.get('lightweightModel')?.currentSelection() ?? inheritedRoute
```

两个随发行版提供的消费方已经这样做：[`session-title-llm`](../../session/session-title-llm/README.zh.md) 与 [`compaction-basic`](../../compaction/compaction-basic/README.zh.md)。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制 —— 点击展开</summary>

本节说明服务如何实现上述行为；可观察契约已在[使用本包](#use-this-package)中覆盖。

### 设计概念

本服务是一个带设置来源的组合配置项，形态与 [`agent-default-model`](../agent-default-model/README.zh.md) 一致：插件配置提供基础成对值，挂载设置提供方后 `lightweight-model` 设置分区成为实时来源。由于每个消费方都通过 `currentSelection()` 读取，一次设置写入不需要重建任何注册级事实。这一对值是全有或全无的——只给 provider 不给 model 的分区会在设置边界被拒绝，而不是留给每个消费方各自判断。

### 源文件映射

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`LightweightModelConfig` 服务、设置分区安装、`currentSelection`/`saveSelection`/`clearSelection` |
| [`src/invariant.ts`](src/invariant.ts) | 不变量伴生插件 |

### 行为说明

三个公开方法都是对该来源的薄读写：`currentSelection()` 返回一个新的游离对象，调用方持有它不会别名服务状态；两个写入方法在设置提供方存在时通过 `ctx.settings` 整体替换分区。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

包级契约对多数消费方已经足够；需要周边领域时再读这些页面。

- [会话标题子系统](../../../docs/subsystems/session-title.zh.md) —— 持久化标题状态与辅助请求记录。
- [共享 LLM 标题策略](../../session/session-title-llm/README.zh.md) —— 一次标题调用所遵循的路由、框架与超时策略。
- [轻量模型路由](../../../.agents/notes/implemented/feature/2026-09-04-lightweight-model-routing.zh.md) —— 辅助调用为什么需要自己的路由，以及背后的实测数据。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-lightweight-model) —— 每个受支持的配置字段及其来源声明。
- [core 组地图](../README.zh.md) —— core 各包如何组合。

-----

<a id="model-experience"></a>
## 模型体验

通过本服务提供给辅助调用的路由产生间接影响；这些调用各自拥有对模型可见的请求，且从不进入会话历史。

#### KV 缓存影响

把辅助调用路由到另一个提供方意味着它无法复用会话的前缀缓存。这是有意接受的取舍：标题与压缩调用都很小，一条不共享前缀但能跑完的路由，优于一条根本跑不完的路由。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了本服务的职责范围，属于当前包约束，不是任务清单。

- **没有设置提供方则无法持久化** —— 未挂载设置提供方时，`saveSelection()` 与 `clearSelection()` 无法为后续进程保留选择。
- **不支持按任务分别配置路由** —— 一条路由服务所有辅助调用；若部署希望标题与压缩摘要使用不同模型，仍需配置那些消费方各自的 `provider`/`model` 覆盖项，它们位于本路由之上。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

无。

</details>
