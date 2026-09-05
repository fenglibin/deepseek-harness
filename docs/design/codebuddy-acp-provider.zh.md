# CodeBuddy ACP Provider

> 状态：分析与设计已完成，等待确认（暂缓实现）
> 读者：维护者与决策者
> 关联诉求：将本机安装的 CodeBuddy 通过 Agent Client Protocol（ACP）作为模型服务来源之一接入，与现有 DSH 模型体验对齐；增加一个开关控制是否开启 CodeBuddy 的 ACP 调用；文档说明配置方式，给用户最大控制权限。

---

## 1. 背景与动机

DeepSeek Harness（DSH）通过两条能力 seam 组装模型后端。`llm` seam（`dsh-llm` 的 `LlmAdapter`）建模的是**单次无状态 chat-completion 调用**，多轮循环由 DSH 驱动；`subagent` seam（`dsh-subagent` 的 `SubagentProvider`）把任务委派给一个**自主运行并返回最终结果**的子 agent。CodeBuddy 是一个完整的编码 agent，不是文本模型：它会推理、调用自己的工具、修改文件，最后才汇报最终答案。因此它匹配的是 `subagent` seam，而不是 `llm` seam。

CodeBuddy 以两种形式暴露标准 ACP：`codebuddy --acp` 走 stdio（ndJsonStream），`codebuddy --serve`（或 `--acp-transport streamable-http`）走 HTTP。DSH 已自带 `dsh-subagent-acp`，这是一个通用的进程外 ACP backend，用 `@agentclientprotocol/sdk` 客户端通过 stdio 驱动任意 ACP agent——与 CodeBuddy 原生使用的协议、传输完全一致。本设计复用该 backend 把 CodeBuddy 挂载为可委派的 provider，并增加一个启用开关，使未安装 CodeBuddy 的部署完全不受影响。

---

## 2. 目标

- 不写新的 ACP 客户端，把本机 CodeBuddy 挂载为可委派的 provider：复用 `dsh-subagent-acp`，将 `command` 指向 `codebuddy --acp`。
- 与现有外部 agent provider（`codex`、`claude-code`）体验一致：provider 作为 subagent backend 出现，模型可见的委派工具默认关闭，用户显式开启后生效。
- 增加一个明确开关控制是否开启 CodeBuddy 的 ACP 调用，使没有 CodeBuddy 的机器照常加载运行。
- 通过配置暴露 CodeBuddy CLI 提供的全部控制（`command`、`args`、`permission`、`cwd`、`env`），让用户完全掌控 CodeBuddy 的启动方式与可执行的操作。

## 3. 非目标

- 不在 ACP 之上实现 `LlmAdapter`：一次 `session/prompt` 是一轮完整自主 agent 运行，不是单轮 chat-completion，工具调用语义无法交回 DSH loop。
- 不新建 CodeBuddy 专属 backend 包：CodeBuddy 讲标准 ACP，`dsh-subagent-acp` 已覆盖；Codex 与 Claude Code 之所以有专属包，是因为它们不讲 ACP。
- 本设计不支持可续（continuable）的 CodeBuddy 子代理：ACP 子代理为 one-shot，沿用现有 backend 的限制。
- 不把 CodeBuddy 内部的工具活动或推理过程透出到父会话：backend 只返回最终的 `agent_message_chunk` 文本。

---

## 4. 现状

### 4.1 DSH 委派 seam

| 组件 | 包 | 职责 |
|---|---|---|
| Subagent 服务 | `dsh-subagent` | 命名 provider 注册表；`start()` 发布子代理运行并返回最终结果 |
| ACP backend | `dsh-subagent-acp` | 每次运行 spawn 一个子进程，用 ACP 客户端通过 stdio（`ndJsonStream`）驱动 |
| 委派工具 | `dsh-tool-subagent` | 模型可见工具，把一个 `ctx.subagents` provider 名绑定到一个工具 |
| Codex / Claude Code backend | `dsh-subagent-codex` / `dsh-subagent-claude-code` | 同一委派 seam，非 ACP 传输；preset 工具行默认 `disabled: true` |

`dsh-subagent-acp` 现有 config：`providerName`、`command`、`args`、`cwd`、`permission`（`allow` | `reject`）、`env`、`disposeEofGraceMs`、`disposeGraceMs`。它不声明任何启动时能力（`agentOptions`、`outputSchema`、`depthLimit`、`toolFilter`、`persona` 全为 `false`），因此进程外 provider 的工具行使用 `backgroundMode: one-shot` 与 `maxDepth: provider-managed`。

### 4.2 CodeBuddy 的 ACP 能力

CodeBuddy 是 ACP 兼容的编码 agent。`codebuddy --help` 记录了此处相关的控制项：

- `--acp` 以 `ndJsonStream` 走 stdio 启动 ACP 模式——正是 `dsh-subagent-acp` 已驱动的传输。
- `--acp-transport stdio | streamable-http` 选择传输；`--serve` 暴露 HTTP 服务（localhost 端口加 `/api/v1/acp` REST 面）。
- `--model`、`--effort`、`--tools`（限制或禁用内置工具）、`--permission-mode`、`--mcp-config`、`--system-prompt`、`--max-turns`、`--session-id` 控制子代理运行。

ACP 会话流程为 `initialize` → `session/new` → `session/prompt`，流式推送 `agent_message_chunk`、`agent_thought_chunk`、`tool_call`、`tool_call_update`、`interruption_request`、`session_end` 等更新；backend 已消费该流程并只保留最终文本。

### 4.3 参考实现（CodeMate）

一个兄弟项目通过 `codebuddy -p`（子进程）和 `@tencent-ai/agent-sdk` 驱动 CodeBuddy。该路径可用，但为字符串解析与版本兼容打了几百行补丁（`normalizeModelId` 应对 `--model` 命名变更、用 `Promise.race` 手动超时、`extractLoginUrl`、Node 版本检查）。DSH 改用 ACP 协议，这些解析都不需要；只有配置思路（权限模式、工具限制、模型选择、重试）可作为 config 字段迁移过来。

---

## 5. 方案对比

### 方案 A：在 ACP 之上实现 `LlmAdapter`（否决）

把 ACP `session/prompt` 事件映射为 `StreamChunk`。否决原因：一次 `session/prompt` 是一轮完整自主 agent 运行，不是一轮模型回合——CodeBuddy 使用自己的工具集，DSH 无法把工具调用交回，且 DSH 的每一轮循环都会变成一次嵌套的 agent 运行。文本流可用，但工具语义错误。

### 方案 B：复用 `dsh-subagent-acp` + `command: codebuddy`（选定）

CodeBuddy 通过 stdio 讲标准 ACP，`dsh-subagent-acp` 已能驱动。无需新的 ACP 客户端，也无需新的 backend 包；改动仅为配置外加一个启用开关。

### 方案 C：新建 CodeBuddy 专属 backend 包（否决）

仿照 `dsh-subagent-codex`。否决原因：Codex 与 Claude Code 需要专属包只是因为它们不讲 ACP；CodeBuddy 讲 ACP，专属包只会重复 `dsh-subagent-acp`。

**决策**：方案 B，外加 backend config 新增 `enabled` 开关，以及一份文档化的 preset 工具行。

---

## 6. 推荐设计

### 6.1 组合

两行协同，与已发布的 Codex、Claude Code provider 完全一致：

1. **Host 平面**——挂载指向 CodeBuddy 的 `dsh-subagent-acp` 注册 provider：

```yaml
- id: subagent-codebuddy
  name: '@deepseek-ai/dsh-subagent-acp'
  config:
    providerName: codebuddy
    enabled: true
    command: codebuddy
    args: ['--acp']
    permission: reject
```

2. **Agent 平面**——暴露模型可见工具，默认禁用，使没有 CodeBuddy 的机器不受影响：

```yaml
- id: tool-subagent-codebuddy
  name: '@deepseek-ai/dsh-tool-subagent'
  disabled: true
  config:
    provider: codebuddy
    toolName: subagent_codebuddy
    backgroundMode: one-shot
    maxDepth: provider-managed
```

`subagents` 注册表本身留在 host 平面；preset 只贡献工具，与现有 `delegation` 分组一致。

### 6.2 启用开关

给 `dsh-subagent-acp` config 新增一个字段：`enabled`（布尔，挂载时默认 `true`）。

- `enabled: true`（默认）注册 provider，行为与现有完全一致；命令缺失或不可执行时，仍在首次 `start` 以 `process-start` 失败——命令可执行性只在 spawn 时真正解析，即最早可解决点。
- `enabled: false` 不注册任何 provider，也不做任何校验，因此没有 CodeBuddy 的部署即使保留了该行也能照常加载。
- 工具行上的 cordis `disabled` 标志仍是 Agent 平面的开关：它隐藏委派工具而不卸载 provider。

两个开关合起来提供完整控制：完全不想要 CodeBuddy 就移除这两行；保留配置但休眠就设 `enabled: false`；让 CodeBuddy 可委派就移除工具行的 `disabled`。

### 6.3 配置面

现有 `dsh-subagent-acp` 字段已覆盖 CodeBuddy 提供的控制项；`args` 原样携带 CLI 标志：

| 字段 | 含义 |
|---|---|
| `command` | 每次运行 spawn 的可执行文件（如 `codebuddy`） |
| `args` | CLI 标志，如 `['--acp', '--model', 'deepseek-v4-pro']` |
| `cwd` | 工作目录覆盖；缺省为委派会话的 cwd |
| `permission` | `reject`（拒绝所有权限请求）或 `allow`（批准第一个允许项） |
| `env` | 在凭据擦除后的父环境之上叠加的额外子进程环境 |
| `disposeEofGraceMs` / `disposeGraceMs` | 清理宽限 |

`--model` 或 `--effort` 覆盖通过 `args` 传入；`--tools ""` 禁用 CodeBuddy 内置工具用于纯文本工作；`--mcp-config` 注入 MCP 服务器。这些与 CodeBuddy CLI 一一对应，因此除 `enabled` 外无需新增 schema。

---

## 7. 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| 部署启用了 CodeBuddy 但未安装 | 首次委派失败 | preset 工具行默认 `disabled`，因此工具在启用前不可见；命令缺失在首次 `start` 以 `process-start` 失败，诊断指明 provider 与阶段 |
| ACP 子代理无法履行 `agentOptions` / `depthLimit` | 工具行必须保持 `one-shot` + `provider-managed` | seam 在 start 时拒绝不支持的能力而非忽略 |
| CodeBuddy 中间工具活动对父代理不可见 | 父代理只见最终答案 | 作为 backend 既有契约记录在案；ACP 仍通过 `interruption_request` 暴露权限决策 |
| CodeBuddy CLI 标志跨版本变化 | `args` 字符串失效 | 标志是用户拥有的配置而非代码；失效是用户可编辑的值，不同于 CodeMate 的硬编码解析 |

**回滚**：`enabled: false`（或卸载这两行）即移除能力；`dsh-subagent-acp` 与 `dsh-subagent` 不受影响，无 loop 改动，无新增会话事件格式。

---

## 8. 已确认决策

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 用哪条 seam | `subagent`（委派），而非 `llm`（模型服务） |
| 2 | 用哪个 backend | 复用 `dsh-subagent-acp`；不新建 backend 包 |
| 3 | 传输 | `codebuddy --acp` 的 stdio `ndJsonStream` |
| 4 | 启用开关 | 新增 `enabled` config 字段（默认开启）加现有 cordis `disabled` 工具行标志 |
| 5 | 命令缺失行为 | 保持现有：`enabled: true` 时命令缺失在首次 `start` 以 `process-start` 失败（不做加载期命令检查） |

---

> 确认后，实现将落地 `dsh-subagent-acp` 的 `enabled` 字段、其 config schema 与测试、一个默认禁用的 preset 工具行，以及一份 Agent Note，遵循现有仓库约定。
