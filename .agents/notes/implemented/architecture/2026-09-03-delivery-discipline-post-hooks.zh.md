# Agent Note: 交付纪律后置命令

Status: implemented

## 问题

B1–B3 为任务提供了只进不退的生命周期与记录、门禁前置条件，但 `accepted` 在模型选择写的记录之外没有任何验证即可到达：验收前没有运行 `openspec validate`、回归套件或深度自检，因此设计文档「只有全部验证通过才允许进入 accepted」的后置闸门（§6.3、§6.4）缺失。

## 决策

工具策略带一个验收配置项，在任务到达 `verified` 之前生效；验收阶段与门禁失败语义由这条记录确立。用户可配置的验收改由提示词命令承载，见[交付纪律的验收命令与设置卡片可用性](../feature/2026-09-16-delivery-acceptance-commands-and-card-usability.zh.md)：配置项是 `verificationCommands`，取提示词命令名，不再经 shell 执行。本记录余下的事实仍是当前状态。

- `@deepseek-ai/dsh-tool-delivery` 的 `Config` 带 `verificationCommands?: string[]`（默认 `[]`），在 `apply` 时校验为非空字符串。包注入 `shell` 用于结构校验。
- `advance_delivery_task` 推进到 `verified` 时，按序在调用 agent 的会话 `header.cwd` 下执行结构校验命令。任一命令非零退出、超时或中止即为首个失败：`stateful` 下以 `DELIVERY_STRUCTURAL_VALIDATION_FAILED` 阻止验证；`advisory` 下以提醒形式呈现，验证仍继续。
- 先执行一条按 change id 定向的 `openspec validate <change_id> --strict --json`：只校验本次任务自己的 change，因此 `openspec/changes/` 下无关的历史变更不能阻塞验证。该命令只在清单记录了合法 change id 时执行——即 `l2` 任务；非 `l2` 任务没有 OpenSpec 变更，其 `record_tasks` 记录的是空字符串，空目标会拼出无目标的 `openspec validate` 并必然失败，所以空白或不合法的 id 按「没有变更可校验」处理，不执行该命令。这个判断在推进时重新做一次，而不是沿用记录时的结论：只有 `l2` 任务在记录时被校验过，而该 id 会被拼进 shell 命令。

这是[交付纪律设计](../../../../docs/design/delivery-discipline-rationale.zh.md)的 B4 批次：后置命令框架与失败回注。深度自检驱动是同一机制指向部署自定义的验收。

## 备选方案

**把后置命令做成独立的 `verify` 工具。** 否决：独立工具会重新打开「模型必须记得调用它」的风险；把验证绑定到验收推进上，使其程序化地不可避免。

**在领域服务里阻止验收。** 否决：执行 shell 命令是工具层的部署策略；领域保持基于 durable 事件的纯状态机。

**只拒绝非零退出。** 否决：挂起或被杀的进程也必须让门禁失败，所以超时与中止都是一等失败。这一条现在只适用于结构校验命令：提示词验收没有退出码可判，改按「是否留下验收记录」判定（见上方链接的替代记录）。

**非 `l2` 任务也执行 `openspec validate`。** 否决：非 `l2` 任务根本没有 OpenSpec 变更，没有可校验的目标，命令只会报「Nothing to validate」而失败。给没有变更的任务强加一条校验，等于要求它去伪造一个变更来通过验收。

## 后果

- **获得** 程序化的后置闸门：验收会运行配置的命令并据其结果决定（105 条单测，100% 覆盖率）。
- **代价** 工具包增加 `shell` 服务依赖（peer + bundle 解析的 `bash`/`subprocess` provider），以及一条在提交前等待结构校验的异步 `advance` 路径。
- **延期（不变）** `delivery/artifact-written` 会话事件投影与客户端 UI（B5）。
