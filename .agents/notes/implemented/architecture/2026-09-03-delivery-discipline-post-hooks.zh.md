# Agent Note：交付纪律后置命令

Status: implemented

## 问题

B1–B3 为任务提供了只进不退的生命周期与记录、门禁前置条件，但 `accepted` 在模型选择写的记录之外没有任何验证即可到达：验收前没有运行 `openspec validate`、回归套件或深度自检，因此设计文档「只有全部验证通过才允许进入 accepted」的后置闸门（§6.3、§6.4）缺失。

## 决策

为工具策略新增 `postHooks` 命令列表，并在任务到达 `accepted` 之前运行。

- `@deepseek-ai/dsh-tool-delivery` 的 `Config` 新增 `postHooks?: string[]`（默认 `[]`），在 `apply` 时校验为非空命令字符串。包现在也注入 `shell`。
- `advance_delivery_task` 推进到 `accepted` 时，按序在调用 agent 的会话 `header.cwd` 下执行每个 hook。任一命令非零退出、超时或中止即为首个失败：`stateful` 下以 `DELIVERY_POST_HOOK_FAILED` 阻止验收；`advisory` 下以提醒形式呈现，验收仍继续。

这是[交付纪律设计](../../../../docs/design/delivery-discipline-rationale.zh.md)的 B4 批次：后置命令框架与失败回注。把 `openspec validate --strict` 接入默认 `postHooks` 是部署选择（bundle 可以列出它），深度自检驱动是同一机制指向自定义脚本。

## 备选方案

**把后置命令做成独立的 `verify` 工具。** 否决：独立工具会重新打开「模型必须记得调用它」的风险；把验证绑定到验收推进上，使其程序化地不可避免。

**在领域服务里阻止验收。** 否决：执行 shell 命令是工具层的部署策略；领域保持基于 durable 事件的纯状态机。

**只拒绝非零退出。** 否决：挂起或被杀的进程也必须让门禁失败，所以超时与中止都是一等失败。

## 后果

- **获得** 程序化的后置闸门：验收会运行配置的命令并据其结果决定（105 条单测，100% 覆盖率）。
- **代价** 工具包增加 `shell` 服务依赖（peer + bundle 解析的 `bash`/`subprocess` provider），以及一条在提交前等待 hooks 的异步 `advance` 路径。
- **延期（不变）** `delivery/artifact-written` 会话事件投影与客户端 UI（B5）。
