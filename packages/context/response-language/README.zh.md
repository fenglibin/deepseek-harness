---
description: "面向部署的回复语言指令：该 row 如何确定模型撰写用户可见文本所用的语言，适用于修改语言的用户与新增语言的维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-response-language

[English](README.md) | 中文

## 概述

`dsh-response-language` 规定模型撰写用户可见文本时使用的语言。它只注册一个系统提示词段落来声明该语言，不添加工具、不提供服务、不持有持久状态。

默认值 `auto` 先读取 Web 界面已保存的语言选择，再读取宿主进程自身的区域设置；当两者都没有指向本 row 能指导的语言时，它不注册任何段落。因此中文宿主无需配置即可得到用中文回答的智能体，英文宿主不受影响，而法语宿主也不会被要求用英文作答。该指令是提示词**段落**而非运行时上下文，所以它能穿过 `includeRuntimeContext: false`，并且能到达子智能体——子智能体的装配会合并全局层。

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

在智能体需要回答人的地方挂载这个 row。已发布的 `dsh-base` bundle 已经挂载；overlay 通过重写该 row 来固定语言或关闭指令。

### 配置

```yaml
- name: '@deepseek-ai/dsh-response-language'
  config:
    language: auto
```

| Field | Default | Meaning |
|---|---|---|
| `language` | `'auto'` | `auto` 依次遵循界面语言与宿主区域设置；`zh` 固定中文；`en` 固定英文；`off` 完全不注册段落 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-response-language)是每个可接受字段及其 JSDoc 的完整来源。

### 哪个信号优先

`auto` 按以下顺序解析，并在遇到第一个能指名语言的信号时停止。没有已发布指令的语言同样会终止搜索，而不会落到后面的信号上，因此中文宿主上的英文界面选择会生效并产生「无段落」：

1. Web 界面设置段中的 `locale.preference` 字段，即在「设置 → 常规」中选择的语言。两者之中只有这一项由人直接控制，而在有人显式选择语言之前它并不存在。
2. 宿主进程自身的区域设置：依次是 `LC_ALL`、`LC_MESSAGES`、`LANG`，最后是 ICU 默认值。中文版 macOS 或 Linux 桌面正是通过这条路径在无人配置的情况下影响模型。

指向没有已发布指令的语言（`fr`、`ja`、无法识别的标签）的信号解析为「无段落」。此时模型遵循对话自身的语言，这对本 row 无法指名的区域设置来说，是唯一诚实的做法。

### 段落缺失时

因为英文是模型无需指令就会使用的语言，`en` 与 `off` 都不输出内容；两者的意图不同：`en` 是部署方记录下来的固定选择，表示无论宿主如何都要英文。`off` 是在中文宿主上抑制该段落的唯一方式。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节说明该 row 的设计；可观察行为见 [Use this package](#use-this-package)。

### 设计理念

一个 `ctx.effect` 注册一个段落，其 `text` 是提供者函数而非字符串。该提供者在每次装配时重新解析，因此在会话中途切换界面语言会在下一步生效，既不需要重启也不需要重新注册。宿主进程的区域设置在进程生命周期内固定不变，因此在激活时采样一次；界面语言是实时设置，通过可选的 `settings` 服务在每次装配时读取。

段落注册在 `RESPONSE_LANGUAGE`（−950），紧随 harness 身份声明之后、检出路径与 Web 界面说明之前，使这条指令与它所限定的身份声明一起位于提示词顶部。

空文本是本 row 放弃输出的方式：提示词注册表在渲染时丢弃空段落，因此「无指令」不需要条件式注册，也不会留下空段落。

### locale 命名空间为何是字面量

`locale` 设置命名空间属于 `dsh-client-locale`——一个浏览器包，其宿主半区负责注册该段。导入那个常量会让宿主 row 对 Web 客户端产生生产依赖，并把它拖进每一个 composition，包括 headless 场景。因此命名空间名称是一个协议常量；而且这次读取天然是容错的：对于无人注册的命名空间，`settings.get` 返回 `undefined`，这正是 headless 下的常态。

### 源码地图

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、信号解析、指令文本、段落注册 |
| [`src/invariant.ts`](src/invariant.ts) | 不变量伴随插件（无运行时不变量；注册表拥有该段落的注销关系） |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当本 row 的契约不够用时，请阅读以下页面：它所贡献的注册表、它读取的设置，以及写入该设置的界面。

- [System-prompt 子系统](../../../docs/subsystems/system-prompt.zh.md) —— 段落注册表、集中顺序分配与变量插值。
- [Client locale 包](../../client/locale/README.zh.md) —— `locale` 设置命名空间与写入它的语言选择器。
- [Settings 子系统](../../../docs/subsystems/settings.zh.md) —— 命名空间如何注册、解析与观测。
- [Context 组地图](../README.zh.md) —— 同组的请求上下文包。

-----

<a id="model-experience"></a>
## 模型体验

### 回复语言指令

#### 模型看到的内容

只有一个段落，且仅在解析出的语言拥有已发布指令时出现。它要求该语言用于人会读到的全部内容，并豁免模型不得改写的数据。

##### 面向 `zh` 的指令

```markdown
Reply to the user in Simplified Chinese (简体中文). Write every sentence a person reads in Chinese — explanations, plans, progress updates, summaries, questions, and the prose of commit messages, reports, and documents you author. Keep code, shell commands, file paths, identifiers, tool names, JSON keys, URLs, and quoted user or tool output verbatim; translate only the prose around them. Do NOT switch to English when reproducing identifiers, paths, commands, or quoted user/tool output; quoted text stays quoted, surrounding prose stays Chinese. If the user writes in English, mirror their tone but keep your reply in Chinese unless they explicitly ask otherwise.
```

#### Token 影响

固定开销：约 80 个 token 的一段文本，在整个会话中要么存在要么不存在，不随对话增长。

#### KV Cache 影响

前缀稳定。只要解析出的语言不变，文本就保持不变，既不会让已可复用的前缀失效，也不会随步数增长。切换界面语言会替换这一段，并使其位置之后的前缀失效——对于罕见的、由用户发起的变更，这是刻意的代价。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下限制界定了该指令无法覆盖的范围。它们是本包当前的约束，不是待办清单。

- **只有两种受指导的语言** —— 目前只有 `zh` 发布了指令，其他区域设置都解析为「无段落」。
- **界面语言在被选择之前不可见** —— 新页面采用的、由浏览器推导出的语言从不落盘，因此在有人于「设置 → 常规」中显式选择语言之前，英文宿主上的中文浏览器只能经由宿主环境被识别。
- **`minimal` 预设会抑制该段落** —— 它的 persona 是 `complete: true`，装配会把完整的 persona 还原为唯一段落，丢弃包括本段落在内的其他全部贡献。
- **宿主区域设置在激活时采样** —— 在运行中的进程里修改 `LANG` 不会改变指令；界面语言则会，因为它在每次装配时读取。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

新增一种语言只需在 [`src/index.ts`](src/index.ts) 的 `DIRECTIVES` 映射中加一项，并在配置联合类型中补一项：解析、空文本放弃输出以及测试全部由该映射驱动。指令要求使用某种语言，同时保留数据原样；请保持这个区分，因为正是这项豁免阻止模型去翻译标识符、路径和被引用的输出。

</details>
