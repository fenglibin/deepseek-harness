# 接入 CodeBuddy

本指南介绍如何把本机安装的 [CodeBuddy](https://cnb.cool/codebuddy/codebuddy-code) 作为 DeepSeek Harness（DSH）的子代理委派目标接入。CodeBuddy 通过标准的 Agent Client Protocol（ACP）暴露自己，DSH 复用现有的 `dsh-subagent-acp` 后端驱动它，无需编写任何代码。

## 前提

- 本机已安装 CodeBuddy CLI，`codebuddy` 命令可用（`codebuddy --version` 能打印版本）。
- 已按[根目录 README](../../../README.zh.md#run)启动 DSH 的一个 profile，并知道它的名字（`dsh --profile <name>`）。

## 先理解：CodeBuddy 是委派目标，不是模型

CodeBuddy 是一个完整的编码 agent：它会推理、调用自己的工具、修改文件，最后返回结果。因此它接入的是 DSH 的**子代理（subagent）**能力，而不是**模型（llm）**能力：

- 主 agent 的对话、推理、工具执行仍然走 DSH 自己的模型。
- CodeBuddy 只在主 agent **主动调用委派工具**时，处理被委派的那个子任务，返回最终结果。

所以「接入 CodeBuddy」不是「让所有请求改道去 CodeBuddy」，而是「让 DSH 具备把子任务交给 CodeBuddy 的能力」。是否委派、委派多少次，由模型在会话里自行决定。

## 第一步：注册 provider（host 平面）

在 profile 的补丁层里挂载 `dsh-subagent-acp`，并把它指向 CodeBuddy。编辑：

```
$DSH_HOME/profiles/<profile 名>/cordis.patch.yml
```

写入：

```yaml
- insert:
    - id: subagent-codebuddy
      name: '@deepseek-ai/dsh-subagent-acp'
      config:
        providerName: codebuddy
        enabled: true
        command: codebuddy
        args: ['--acp']
        permission: reject
```

- `command` 是要 spawn 的可执行文件；`args: ['--acp']` 让 CodeBuddy 以 stdio ACP 模式启动。
- `enabled: true`（默认）注册该 provider；设为 `false` 则不注册、也不做任何校验，命令缺失的机器照常加载。
- `permission: reject` 自动拒绝 CodeBuddy 子进程的权限请求；改 `allow` 则批准第一个允许项。

保存后重启 host（或触发补丁热重载）使 provider 生效。

## 第二步：启用委派工具（agent 平面）

provider 注册后，还要让模型「看到」委派工具。shipped preset（`standard`、`cordis`、`ptc`）里已经预置了 `tool-subagent-codebuddy` 这一行，默认 `disabled: true`。把它复制到用户目录并移除 `disabled`：

```
$DSH_HOME/.agent-presets/<preset 名>/agent.cordis.yml
```

找到并去掉 `disabled: true`：

```yaml
- id: tool-subagent-codebuddy
  name: '@deepseek-ai/dsh-tool-subagent'
  # disabled: true        ← 删掉这行
  config:
    provider: codebuddy
    toolName: subagent_codebuddy
    backgroundMode: one-shot
    maxDepth: provider-managed
```

`provider` 必须与第一步的 `providerName` 一致（`codebuddy`）；`toolName` 是模型看到并调用的工具名。

## 验证

开启一个新会话，确认两件事：

1. 模型可调用 `subagent_codebuddy` 工具。
2. 让模型「用 subagent_codebuddy 完成一个任务」，它会把任务委派给 CodeBuddy，CodeBuddy 在自己的进程里执行并返回结果。

若 CodeBuddy 子进程启动失败（例如 `codebuddy` 命令不存在），委派会以 `process-start` 失败并返回诊断——命令可执行性只在 spawn 时才真正解析，加载期不做检查。

## 配置选项

除 `enabled` 外，`dsh-subagent-acp` 的其余字段原样透传给 CodeBuddy：

| 字段 | 含义 |
|---|---|
| `enabled` | 总开关；`false` 时不注册 provider、不做任何校验 |
| `command` | 每次运行 spawn 的可执行文件（`codebuddy`） |
| `args` | CLI 标志，原样传给 `codebuddy` |
| `permission` | `reject` 拒绝所有权限请求；`allow` 批准第一个允许项 |
| `cwd` | 工作目录覆盖；缺省为委派会话的 cwd |
| `env` | 在凭据擦除后的父环境之上叠加的子进程环境 |

### 指定模型

CodeBuddy 的模型 ID 是它自己的命名空间，与 DSH 的模型 ID 无关。通过 `args` 传 `--model` 指定：

```yaml
args: ['--acp', '--model', 'claude-sonnet-4-20250514']
```

同理可用 `--effort`（推理努力）、`--tools ""`（禁用内置工具做纯文本工作）、`--mcp-config`（注入 MCP 服务器）。模型 ID 需填 CodeBuddy 认识的 ID，查 `codebuddy --help` 或 CodeBuddy 自身的模型列表。

CodeBuddy 是进程外子代理，DSH 的「子代理模型选择」能力对它不生效（ACP 后端不声明 `agentOptions` 能力）。要「多个模型可选」，就挂多个 `dsh-subagent-acp` 实例，各自配不同的 `providerName`、`--model` 和 `toolName`，让模型按需调用其一。

## 排错

- **委派报 `process-start`**：`codebuddy` 命令不存在或不可执行。检查 `command` 是否在 PATH 中，或改用绝对路径。
- **模型看不到 `subagent_codebuddy` 工具**：`provider` 与 `providerName` 不一致，或工具行仍带 `disabled`，或 provider 未注册。
- **想完全关闭 CodeBuddy**：设 `enabled: false`（保留配置但休眠），或移除这两段配置（彻底卸载）。

## 相关文档

- [`dsh-subagent-acp` 参考](../../../packages/subagent/subagent-acp/README.zh.md) —— 后端完整配置与限制。
- [设计文档](../../design/codebuddy-acp-provider.zh.md) —— 为什么走子代理而非模型、CLI 与 ACP 的取舍。
- [插件配置目录](../../config-catalog.zh.md#deepseek-aidsh-subagent-acp) —— 每个字段的权威定义。
