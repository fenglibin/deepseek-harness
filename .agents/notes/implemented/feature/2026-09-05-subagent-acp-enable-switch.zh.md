# Agent Note: subagent-acp enable switch (dormant optional provider)

Status: implemented

## Problem

`dsh-subagent-acp` 在被挂载的那一刻就注册 `SubagentProvider`。某个部署为可选的子 agent 挂载了该行、但其命令不存在——例如在未安装 CodeBuddy 的机器上——却仍然要承担注册以及 `apply` 里的任何配置校验，尽管该 provider 永远无法启动运行。唯一的关闭方式是把这一行从组合里整体移除，这同时也会丢掉用户可能想保留的配置。

## Decision

给 `dsh-subagent-acp` 增加一个 `enabled` 配置字段（布尔，默认 `true`）。当为 `false` 时，`apply` 在注册 provider 之前、也在任何字段校验之前就返回，因此休眠行不产生任何副作用，也绝不会导致加载失败。preset 工具行上的 cordis `disabled` 标志仍是另一个独立于 agent 平面的开关，它隐藏模型可见的委派工具而不卸载 provider。

### 两个开关

- `enabled`（provider 配置）：`false` 让 backend 行保持休眠——不注册到 `ctx.subagents`、不做校验、不做命令检查。即使保留该行，没有 CodeBuddy 的机器也能照常加载。
- `disabled`（cordis 工具行）：在 provider 保持注册的同时，隐藏 `dsh-tool-subagent` 委派工具。

两者合起来提供完整控制：完全移除 CodeBuddy 就删掉这两行；保留配置但休眠就设 `enabled: false`；让 CodeBuddy 可委派就移除工具行的 `disabled`。

### 命令缺失仍为首次启动时失败

`enabled` 不增加加载期的命令检查。命令缺失或不可执行仍在首次 `start` 时以 `process-start` 失败，因为命令可执行性只在 spawn 时才真正解析——那才是最早可解决点。加载期检查会破坏既有的契约（指向不存在二进制的 `command` 必须能加载、仅在 `start` 时失败），还会探测一个环境相关的事实（PATH、文件系统），而 spawn 已经权威地解析了它。

### CodeBuddy preset 工具行

三个 agent preset（`standard`、`cordis`、`ptc`）新增 `tool-subagent-codebuddy` 行（`provider: codebuddy`、`toolName: subagent_codebuddy`、`backgroundMode: one-shot`、`maxDepth: provider-managed`），与 Codex、Claude Code 兄弟一样默认 `disabled: true`。CodeBuddy 讲标准 ACP，因此在 host 平面复用 `dsh-subagent-acp`（`command: codebuddy --acp`），而不是一个专属 backend 包。

## Alternatives considered

### 为什么不做加载期命令检查？

在加载时校验命令能解析为可执行文件，会破坏既有的契约——[ACP subagent backend](2026-06-22-acp-subagent-backend.zh.md) 的测试锁定了「指向不存在二进制的 `command` 能加载、仅在首次 `start` 失败」的行为。命令可执行性还依赖环境，因此加载期探测既脆弱，又与既有的 `process-start` 失败冗余。

### 为什么不建专属 CodeBuddy backend 包？

Codex 与 Claude Code 各自需要 backend 包，是因为它们不讲 ACP；见 [Codex and Claude Code providers note](2026-08-04-claude-code-and-codex-subagent-backends.zh.md)。CodeBuddy 讲 ACP，因此 `dsh-subagent-acp` 配 `command: codebuddy --acp` 已能驱动它；专属包只会重复 ACP 客户端。

## Consequences

`enabled: false` 的行对注册表零贡献、也从不被校验，因此组合可以携带一个休眠的可选 provider，既无运行成本也不会加载失败。代价是 `dsh-subagent-acp` 上多一个配置字段；`enabled` 的默认值（`true`）为每个现有挂载保持原行为。三个 preset 现在各自携带一个默认禁用的 CodeBuddy 工具行，与 Codex、Claude Code 兄弟一致。
