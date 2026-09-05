---
description: "交付包组：每个会话持有一份持久的、可追溯变更的任务，以及推动它走完有纪律生命周期的模型工具。"
kind: "package-group"
---

# 交付纪律

## 概述

`delivery/` 组为一次 agent 会话提供一份关于它正在做的工作的持久记录：一个带有目标、规模等级与生命周期阶段的任务，因为它存放在会话日志中，所以能经受会话恢复、fork 与进程重启。状态包负责保存任务并强制其阶段顺序；工具包决定任务何时推进，以及模型在多强的门禁下被要求遵守这套纪律。在没有东西创建任务之前，任务并不存在。本页映射该组；逐包约定由包 README 负责。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

本组包含两个包；包 README 与下方链接拥有细节。

| 包 | 提供的能力 |
|---|---|
| [`delivery/`](delivery/README.zh.md) | 持久任务服务：为每个会话创建、推进、记录并清除一份比较并设置式任务 |
| [`tool-delivery/`](tool-delivery/README.zh.md) | 面向模型的工具，以及决定任务何时可以推进的门禁强度 |

-----

<a id="related-documentation"></a>
## 相关文档

先读子系统页面了解持久词汇，再读包 README 了解约定。

- [交付子系统参考](../../docs/subsystems/delivery.zh.md)——任务身份、阶段顺序、投影与持久事件。
- [Goal 子系统参考](../../docs/subsystems/goal.zh.md)——常被与交付纪律混淆的相邻同会话关注点：它管的是续跑轮次，而非任务状态。
- [添加工具](../../docs/cookbook/adding-a-tool.zh.md)——面向模型的交付工具如何与其他工具并列注册。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
