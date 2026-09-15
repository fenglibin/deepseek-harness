/**
 * Generate the relationship layer above the module, Cordis, and tool catalogs.
 * Enumerable facts come from source; hybrid graphs add manifests for policy the
 * source cannot infer, while curated graphs explain flow and ownership.
 * `--check` verifies the generated set.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import ts from 'typescript'
import { projectCordisCatalog } from '@deepseek-ai/dsh-typert-generator'
import { CORDIS_CATALOG_POLICY } from './gen-cordis-catalog.ts'
import type { EventEntry, ServiceEntry } from '@deepseek-ai/dsh-typert-generator'
import {
  collectPackageGraph,
  escapeMermaidLabel as escLabel,
  graphNodeId as nodeId,
  type PackageGraphNode,
} from './package-graph.ts'
import { TypeScriptProject } from './ts-project.ts'

const root = resolve(import.meta.dirname, '..')
type Pkg = PackageGraphNode

interface GraphDoc {
  rel: string
  content: string
}

interface ServiceRole {
  key: string
  pkg: string
  title: string
  mode: 'core' | 'seam' | 'bundle'
  implementations?: string[]
  consumers?: string[]
  companions?: string[]
  note: string
}

interface ExamplePlugin {
  id: string
  name: string
}

interface EventRelation {
  dispatchers: Map<string, Set<string>>
  listeners: Set<string>
}

/** One scanned package source file and its owning package short name. */
export interface PackageSource {
  /** Repository-relative path. */
  rel: string
  /** Package short name from the `packages/<group>/<pkg>/src` path. */
  pkg: string
  /** The bound program source file. */
  sourceFile: ts.SourceFile
}

type EventReceiverKind = 'context' | 'agent-dispatch' | 'events-service'

const GROUP_ORDER = [
  'util',
  'attachment',
  'llm',
  'core',
  'typert',
  'goal',
  'experimental',
  'process',
  'bash',
  'pty',
  'sandbox',
  'e2b',
  'fs',
  'skill',
  'compact',
  'subagent',
  'tasks',
  'workflow',
  'web',
  'webhook',
  'spill',
  'todo',
  'plan',
  'cordis',
  'hooks',
  'session-persistence',
  'session-query',
  'session-title',
  'telemetry',
  'storage',
  'workspace',
  'support',
  'acp',
  'ui',
]

const SERVICE_ROLES: ServiceRole[] = [
  {
    key: 'attachments',
    pkg: 'attachment',
    title: 'Durable binary attachment storage',
    mode: 'seam',
    implementations: ['attachment-local'],
    consumers: ['api-session-controller', 'tool-fs', 'llm-pi-ai', 'llm-deepseek'],
    note: '宿主会在会话事件之前提交已接受的图片；提供方适配器将已授权的持久引用解析为提供方原生内容。',
  },
  {
    key: 'llm',
    pkg: 'llm',
    title: 'LLM adapter registry',
    mode: 'seam',
    implementations: ['llm-deepseek', 'llm-pi-ai', 'llm-replay'],
    consumers: ['agent-loop', 'compaction-basic'],
    note: '适配器注册提供方实现；agent loop（智能体循环）与压缩功能调用提供方无关的流服务。',
  },
  {
    key: 'deepseekLlmApiExtensions',
    pkg: 'deepseek-llm-api-extensions',
    title: 'Official DeepSeek request extensions',
    mode: 'seam',
    implementations: ['session-log-deepseek', 'plugin-package-inventory-deepseek'],
    consumers: ['llm-deepseek'],
    note: '插件准备彼此独立的顶层字段；官方适配器会合并这些字段，并在 HTTP 接受后提交其交付状态。',
  },
  {
    key: 'tokenMeter',
    pkg: 'token-meter',
    title: 'Replay token measurement',
    mode: 'core',
    consumers: ['compaction-basic'],
    note: '拥有按会话隔离的回放折叠区；压力消费方共享不可变且带修订版本的测量结果。',
  },
  {
    key: 'toolResultPruner',
    pkg: 'compaction-tool-result-pruner',
    title: 'Model-free tool-result pruning',
    mode: 'core',
    consumers: ['compaction-basic'],
    note: '在摘要压缩之前，通过可回放的单节点表面替换来重写过大的当前工具结果。',
  },
  {
    key: 'sessions',
    pkg: 'session',
    title: 'In-memory session store',
    mode: 'core',
    consumers: ['agent-loop', 'agent', 'session-persistence', 'session-query', 'session-query-sqlite', 'subagent-in-process-driver', 'invariants', 'message-feedback'],
    note: '拥有仅追加的 Session 实例，并发出持久的会话事件流。',
  },
  {
    key: 'sessionController',
    pkg: 'api-session-controller',
    title: 'Host Session Remote controller',
    mode: 'core',
    note: '拥有 Session 命令、冷读取、持久事件跟踪、实时控制状态、模型目录、工作区打开和 Agent 激活策略。',
  },
  {
    key: 'sessionFileReferences',
    pkg: 'api-session-controller',
    title: 'Session-addressed file-reference Remote adapter',
    mode: 'core',
    note: '通过 Session Controller 已建立的 Agent 查找策略委派文件引用发现。',
  },
  {
    key: 'sessionSkillCatalog',
    pkg: 'api-session-controller',
    title: 'Session-addressed skill Remote adapter',
    mode: 'core',
    note: '列出 Session 组合中用户可调用的技能，而不激活冷 Agent。',
  },
  {
    key: 'credentialsController',
    pkg: 'api-settings-controller',
    title: 'Host credential-surface Remote controller',
    mode: 'core',
    note: '将凭据引用 seam 投影到生成的 Remote 命名空间：批量分发、视图投影和拒绝映射都在此处，而非 seam Definition。',
  },
  {
    key: 'settingsController',
    pkg: 'api-settings-controller',
    title: 'Host settings-surface Remote controller',
    mode: 'core',
    note: '将用户设置 seam 投影到生成的 Remote 命名空间：读取始终脱敏，且每一次拒绝都在此处分类，而非 seam Definition。',
  },
  {
    key: 'workspaceController',
    pkg: 'api-workspace-controller',
    title: 'Host Workspace Remote controller',
    mode: 'core',
    note: '通过生成的 Remote 命名空间拥有 Workspace 命令和可安全重连的 Workspace 状态投递。',
  },
  {
    key: 'directoryPickerController',
    pkg: 'api-workspace-controller',
    title: 'Host directory-picking Remote controller',
    mode: 'core',
    note: 'Carries the picking seam onto the wire: capability gating, cancellation, and the seam-coded failures a browser directory flow discriminates on.',
  },
  {
    key: 'invariants',
    pkg: 'invariants',
    title: 'Package-owned invariant registry',
    mode: 'core',
    consumers: ['session', 'agent', 'scope', 'agent-loop'],
    note: '配套子路径注册所有者本地的检查；服务拥有选择、唯一性、子 fiber 和按包归属的失败。',
  },
  {
    key: 'typert',
    pkg: 'typert-registry',
    title: 'Runtime type registry',
    mode: 'core',
    consumers: ['typert-loader', 'api-gateway'],
    note: '插件直接或通过 dsh-typert-loader 注册实时 zod 贡献；API 网关消费调用描述符与提供方，而其他运行时消费方在各自的边界查询 schema 与反射元数据。',
  },
  {
    key: 'typertGateway',
    pkg: 'api-gateway',
    title: 'Typert Host invocation gateway',
    mode: 'core',
    note: '将生成的 Remote 描述符与实时 Cordis 服务关联，解析已注册身份，并通过共享的 Connection RPC 载体暴露一元调用。',
  },
  {
    key: 'sessionPersistence',
    pkg: 'session-persistence',
    title: 'Durable session persistence seam',
    mode: 'seam',
    implementations: ['session-persistence-jsonl', 'session-persistence-sqlite'],
    consumers: ['agent-loop', 'tool-bash', 'hooks-claude-code', 'hooks-codex', 'session-query', 'session-query-sqlite', 'message-feedback'],
    note: '后端持久化同一套 SessionEvent 词汇；应用在组合期选择后端。',
  },
  {
    key: 'settings',
    pkg: 'settings',
    title: 'User-settings seam',
    mode: 'seam',
    implementations: ['settings-file'],
    consumers: ['api-settings-controller', 'llm-deepseek', 'llm-pi-ai'],
    note: '插件注册命名空间 schema 并解析分层值；提供方存储原始文档。LLM 适配器在 user 段下把入口配置注册为组合基底；设置控制器提供脱敏的分层描述符并写入 user 层。',
  },
  {
    key: 'subagentModelSelection',
    pkg: 'tool-subagent',
    title: 'Subagent model-selection preference',
    mode: 'core',
    consumers: ['tool-subagent'],
    note: '拥有默认关闭的设置命名空间，Agent 作用域的委派工具在组装新的顶层 Session 时采样它。',
  },
  {
    key: 'credentials',
    pkg: 'credentials',
    title: 'Credential seam',
    mode: 'seam',
    implementations: ['credentials-local'],
    consumers: ['api-settings-controller', 'llm-deepseek', 'llm-pi-ai'],
    note: '配置承载对机密的引用；提供方拥有值。消费方按操作解析，因此轮换后的凭据会立即作用于下一次请求；设置控制器暴露无值的视图与仅写存储。',
  },
  {
    key: 'authorization',
    pkg: 'authorization',
    title: 'Authorization flow registry',
    mode: 'seam',
    implementations: [],
    consumers: ['llm-pi-ai'],
    note: '流程由知道如何获取某个凭据的插件注册，并以它们写入的记录为键；seam 拥有对话与每键一次尝试的生命周期，而从不拥有协议。',
  },
  {
    key: 'sessionTelemetry',
    pkg: 'session-telemetry',
    title: 'Session telemetry seam',
    mode: 'seam',
    implementations: ['session-telemetry-otel'],
    consumers: [],
    note: 'seam 捕获、脱敏会话记录并交给一个后端；没有其他消费方使用该服务——其输出离开进程。',
  },
  {
    key: 'storage',
    pkg: 'storage',
    title: 'Non-session storage hub',
    mode: 'seam',
    implementations: ['storage-json', 'storage-sqlite'],
    consumers: ['storage-domain'],
    note: '后端按名称并列注册；数据形态（domain 优先）挂载在 hub 上，并把类型化操作转换为不透明的 KV 单元原语。',
  },
  {
    key: 'storageDomain',
    pkg: 'storage-domain',
    title: 'Domain data facility',
    mode: 'core',
    consumers: ['workspace', 'message-feedback'],
    note: '等待每个已配置的后端，然后把 domain 形态发布为类型化持久状态的生命周期绑定服务。',
  },
  {
    key: 'messageFeedback',
    pkg: 'message-feedback',
    title: 'Lifecycle-bound message feedback',
    mode: 'core',
    note: '拥有按 assistant 消息本地的反馈、生命周期与目标校验、逐项 compare-and-set 以及 Host 一元 Remote 契约，而不进入 Session 历史或遥测。',
  },
  {
    key: 'workspaceRegistry',
    pkg: 'workspace',
    title: 'Workspace entity registry',
    mode: 'core',
    consumers: ['api-workspace-controller', 'api-session-controller'],
    note: '在 domain 设施之上拥有带 WorkspaceId 标记的记录；稳定的 sessionIds 账户驱动 Host RPC 与 GUI 投影。',
  },
  {
    key: 'sessionQuery',
    pkg: 'session-query',
    title: 'Session reads, traces, filters, and search',
    mode: 'seam',
    implementations: ['session-query-sqlite'],
    consumers: ['session-reference', 'tool-session-query'],
    note: '接口提供精确读取、过滤和轨迹；其具体后端增加全文对账、排序、片段和游标生成，而模型消费方拥有工作区权限和无游标渲染。',
  },
  {
    key: 'fileReferences',
    pkg: 'file-reference',
    title: 'File reference discovery',
    mode: 'seam',
    implementations: ['file-reference-local'],
    consumers: ['api-session-controller'],
    note: '接口在 Agent cwd 内返回仅路径的补全候选；提供方拥有命名空间访问与排序，而不读取文件内容。',
  },
  {
    key: 'sessionReferenceResolver',
    pkg: 'session-reference',
    title: 'Cross-session snapshot preparation',
    mode: 'core',
    note: '将受限的当前表面会话快照投影为持久的不受信消息上下文；宿主适配器拥有提及语法。',
  },
  {
    key: 'sessionTitle',
    pkg: 'session-title',
    title: 'Log-backed session titles',
    mode: 'seam',
    implementations: ['session-title-first-prompt-llm', 'session-title-all-prompts-llm'],
    note: '拥有确定性的回退、最新标题折叠以及唯一的可选异步提供方注册。',
  },
  {
    key: 'systemPrompt',
    pkg: 'system-prompt',
    title: 'System prompt assembly registry',
    mode: 'core',
    consumers: ['agent-loop', 'tools', 'tool-fs', 'tool-terminal', 'tool-web'],
    note: '为每一步收集提示词段落与面向模型的工具 schema。',
  },
  {
    key: 'tools',
    pkg: 'tools',
    title: 'Tool registry and guarded execution pipeline',
    mode: 'core',
    consumers: ['agent-loop', 'tool-ask-user', 'tool-bash', 'tool-cordis', 'tool-fs', 'tool-terminal', 'tool-skill', 'tool-subagent', 'tool-todo', 'tool-web'],
    note: '注册能力、拥有 PTC 模式传输，并把调用路由通过前置策略、单调守卫、分发环绕、后置策略和最终结果观察。',
  },
  {
    key: 'userQuestions',
    pkg: 'user-questions',
    title: 'Human question/answer seam',
    mode: 'seam',
    consumers: ['tool-ask-user'],
    note: 'UI 前端提供活跃的人类应答提供方；tool-ask-user 在提供方无关的 ask() promise 上暂停一次工具调用。',
  },
  {
    key: 'planMode',
    pkg: 'plan-mode',
    title: 'Plan collaboration state',
    mode: 'core',
    note: '折叠已记录的 plan/mode 状态、在轮次边界冲刷用户选择、渲染部署自有指引、注册 /plan，并在状态切换间保持 plan-exit schema 稳定。',
  },
  {
    key: 'agentPresets',
    pkg: 'agent-presets',
    title: 'Per-session agent composition',
    mode: 'core',
    note: '在受信与用户自建根上发现预设目录，并在创建期间在 agent 作用域下挂载一个预设 cordis.yml，拒绝从不激活或发布到根服务域的条目。',
  },
  {
    key: 'commands',
    pkg: 'commands',
    title: 'Human command registry',
    mode: 'core',
    note: '插件注册直接面向人类的命令，而不把调用发送给模型。',
  },
  {
    key: 'sessionProjections',
    pkg: 'session-projection',
    title: 'Session projection units',
    mode: 'core',
    consumers: ['api-session-controller', 'tool-todo', 'session-title'],
    note: '各 domain 注册状态驱动的折叠单元；急切驱动器维护按会话的水位状态，Session 控制器提供基线并推送变化值。',
  },
  {
    key: 'sessionProjectionCache',
    pkg: 'session-projection-cache',
    title: 'Persisted projection cache',
    mode: 'core',
    consumers: ['api-session-controller', 'session-query', 'session-reference', 'subagent'],
    note: '按会话持久化检查点投影单元状态（节流 + turn/end/detach 必检点），并提供冷读取阶梯：缓存行 + 持久化尾部回放，使列表永不加载完整日志。',
  },
  {
    key: 'skills',
    pkg: 'skill',
    title: 'Skill provider registry',
    mode: 'seam',
    implementations: ['skill-badge', 'skill-filesystem'],
    consumers: ['tool-skill'],
    note: '合并提供方的技能目录；tool-skill 渲染会话前缀目录并加载完整技能体。',
  },
  {
    key: 'skillRoots',
    pkg: 'skill-filesystem',
    title: 'Read-only view of the roots the local skill provider scans',
    mode: 'core',
    consumers: ['skill-manager'],
    note: '由本地文件系统提供方的部署级实例发布（scope 实例只向本 scope 的注册表层贡献目录，因为一个服务只有一个提供方），复用其自身的根解析（dshHome、agentsHome、customSkillDirs、bundledSkillDir 与项目根查找），使管理面的写入落在发现器真正扫描的目录，而不是第二份配置推导出的位置。',
  },
  {
    key: 'agents',
    pkg: 'agent',
    title: 'Agent service',
    mode: 'core',
    consumers: ['agent-loop', 'acp', 'subagent-in-process-driver'],
    note: '拥有实时 Agent 句柄、create/resume 工厂 seam 以及进程本地的发起者传播。',
  },
  {
    key: 'agentDefaultModel',
    pkg: 'agent-default-model',
    title: 'Default Agent model selection',
    mode: 'core',
    consumers: ['api-session-controller', 'headless'],
    note: '通过设置分层默认 ModelSelection，使直接与 Host 支撑的 Agent 入口共享同一状态所有者。',
  },
  {
    key: 'agentLoop',
    pkg: 'agent-loop',
    title: 'Concrete loop driver',
    mode: 'bundle',
    consumers: ['agent-spine-demo'],
    note: '唯一的具体 loop 插件；扩展包依赖 dsh-agent 事件与服务，而非本包。',
  },
  {
    key: 'goals',
    pkg: 'goal',
    title: 'Same-session goal domain',
    mode: 'core',
    note: '从会话日志折叠带修订的目标状态，并把实时续行激活保持在进程本地。',
  },
  {
    key: 'e2b',
    pkg: 'e2b',
    title: 'E2B sandbox lifecycle owner',
    mode: 'core',
    consumers: ['fs-e2b', 'subprocess-e2b'],
    note: '拥有一个共享的 E2B SDK 句柄、远程工作目录和最终沙箱处置，使两个基础 E2B 提供方驻留在同一 Linux 运行时。',
  },
  {
    key: 'subprocess',
    pkg: 'subprocess',
    title: 'Subprocess seam',
    mode: 'seam',
    implementations: ['subprocess-local', 'subprocess-e2b'],
    consumers: ['bash-local', 'bash-sandbox', 'terminal-bash', 'lsp-stdio', 'subagent-acp', 'subagent-codex', 'subagent-claude-code'],
    note: 'bash 执行器、PTY shell 后端、LSP 宿主，以及进程外的 ACP、Codex、Claude Code subagent 后端都通过 ctx.subprocess 启动；服务拥有进程坐标、树/会话生命周期、stdio 配置、终端机制和 kill 升级。',
  },
  {
    key: 'shell',
    pkg: 'shell',
    title: 'Bash executor seam',
    mode: 'seam',
    implementations: ['bash-local', 'bash-sandbox', 'pwsh-local'],
    consumers: ['tool-bash', 'tool-pwsh', 'hooks-claude-code', 'hooks-codex'],
    note: '面向模型的 shell 工具与钩子桥接消费此 seam；沙箱、远程或 PowerShell 执行器替换 bash-local 而不触及它们。',
  },
  {
    key: 'shellEnv',
    pkg: 'shell-env',
    title: 'Managed bash environment registry',
    mode: 'core',
    consumers: ['tool-bash', 'tool-pwsh'],
    note: '插件声明作用域受限的 DSH_* 事实；每个 shell 工具在每次执行时收集一份受信快照，其执行器重建命名空间。',
  },
  {
    key: 'terminals',
    pkg: 'terminal',
    title: 'Persistent PTY session registry',
    mode: 'seam',
    implementations: ['terminal-bash'],
    consumers: ['tool-terminal'],
    note: '注册表拥有精确的 Agent 会话身份与清理；后端拥有终端机制，而 tool-terminal 暴露所有者作用域的模型工具。',
  },
  {
    key: 'sandbox',
    pkg: 'sandbox',
    title: 'Process-sandbox seam',
    mode: 'seam',
    implementations: ['sandbox-local'],
    consumers: ['bash-sandbox', 'terminal-bash'],
    note: '消费方交出它们即将启动的确切 argv；同世界后端在逐调用策略下包装它并报告执行情况。',
  },
  {
    key: 'sandboxPolicy',
    pkg: 'sandbox-policy',
    title: 'Sandbox policy home',
    mode: 'core',
    implementations: [],
    consumers: ['bash-sandbox', 'fs-sandbox', 'terminal-bash'],
    note: '部署默认模式 + 工作区根的唯一归属；只有沙箱执行器与提供方读取该服务（工具层使用它同时导出的纯 `sandbox/mode` 折叠）。两个执行族都读取它，因此 bash 与 fs 不能限制到不同根。',
  },
  {
    key: 'approval',
    pkg: 'user-approval',
    title: 'Approval seam',
    mode: 'seam',
    implementations: [],
    consumers: ['tools', 'tool-bash', 'acp'],
    note: '一次性权限决策在 `approval/request` waterfall 上派发；应答者是监听者（ACP 桥接用于其自身 agent），缺席时失败关闭为 `unavailable`。',
  },
  {
    key: 'permissionPresets',
    pkg: 'permission-presets',
    title: 'Permission presets',
    mode: 'core',
    implementations: [],
    note: '面向用户的预设表（`workspace-write`/`danger-full-access`），捆绑沙箱模式与审批策略旋钮；一次切换写入一个 `permission/preset` 事件并贯穿到两个旋钮事件。',
  },
  {
    key: 'codeRuntime',
    pkg: 'code-runtime',
    title: 'Code-execution seam',
    mode: 'seam',
    implementations: ['code-runtime-worker-thread'],
    consumers: ['tools'],
    note: '针对宿主提供的异步绑定运行一个模型编写的程序；后端因底层与语言而异（工具注册表在 PTC 模式下消费它）。',
  },
  {
    key: 'fs',
    pkg: 'fs',
    title: 'Filesystem provider seam',
    mode: 'seam',
    implementations: ['fs-local', 'fs-sandbox', 'fs-e2b'],
    consumers: ['tool-fs'],
    companions: ['fs-observation-policy'],
    note: 'tool-fs 通过 ctx.fs 执行读写与编辑；fs-sandbox 按共享沙箱模式围栏变更；fs-observation-policy 通过 fs/* 事件门贡献观察状态检查。',
  },
  {
    key: 'compaction',
    pkg: 'compaction',
    title: 'Compaction seam',
    mode: 'seam',
    implementations: ['compaction-basic'],
    consumers: ['compaction-basic'],
    note: '基础后端消费步后压力与请求错误恢复事件；没有面向模型的 compact 工具。',
  },
  {
    key: 'subagents',
    pkg: 'subagent',
    title: 'Subagent provider and continuation service',
    mode: 'seam',
    implementations: ['subagent-spawn-in-process', 'subagent-fork-in-process', 'subagent-acp', 'subagent-codex', 'subagent-claude-code', 'subagent-dsh-sdk'],
    consumers: ['tool-subagent', 'tool-subagent-control', 'tool-ralph'],
    note: '提供方实现传输；服务还拥有可选的基于 Activation 的续行编排，tool-subagent 选择一次性或可续行的委派，tool-subagent-control 投递后续消息，tool-ralph 需要一条全新的结构化输出路由。',
  },
  {
    key: 'agentTeams',
    pkg: 'experimental-agent-team',
    title: 'Agent Teams coordination domain',
    mode: 'core',
    consumers: ['experimental-tool-agent-team', 'experimental-client-ui-agent-team'],
    note: '拥有隐式根名册、持久对等邮箱、共享任务 DAG、可续行子生命周期和生成的 Team Remote 方法；tool-agent-team 贡献模型控制，client-ui-agent-team 挂载浏览器贡献。',
  },
  {
    key: 'inspector',
    pkg: 'inspector',
    title: 'Cross-realm runtime inspection',
    mode: 'core',
    note: '拥有 Worker 托管的 CDP 目标，以及与传输无关的 Host 和 Client 观察和 Cordis 树查询 API。',
  },
  {
    key: 'jobs',
    pkg: 'jobs',
    title: 'Background job registry',
    mode: 'seam',
    implementations: ['jobs-local'],
    consumers: ['tool-bash', 'tool-terminal', 'tool-subagent', 'tool-jobs'],
    note: '生产方（后台 bash、PTY 发送和 subagent 委派）注册运行中的工作；tool-jobs 是读取、列出并终止它的面向模型控制器；jobs-local 是进程本地注册表。',
  },
  {
    key: 'web',
    pkg: 'web',
    title: 'Web access provider registry',
    mode: 'seam',
    implementations: ['web-search-exa', 'web-search-perplexity', 'web-search-deepseek', 'web-fetch-http'],
    consumers: ['tool-web'],
    note: '搜索与抓取提供方注册进同一个 ctx.web seam；tool-web 拥有稳定的面向模型名称。',
  },
  {
    key: 'spillStore',
    pkg: 'spill',
    title: 'Spill storage seam',
    mode: 'seam',
    implementations: ['spill-local'],
    consumers: ['spill-policy'],
    note: '后端保存过大的工具文本并返回面向模型的定位符加检索提示；spill-policy 是决定何时 spill 的 tools/post-execute 消费方。',
  },
  {
    key: 'directoryPicker',
    pkg: 'host-directory-picker',
    title: 'Workspace-directory picking seam',
    mode: 'seam',
    implementations: ['host-directory-picker-native', 'host-directory-picker-browse'],
    consumers: ['api-workspace-controller'],
    note: '区分交互能力：native 后端在宿主显示器上打开一个 OS 选择器，browse 后端为应用内浏览器提供列出/创建原语；双面后端从其浏览器半填充 ui-workspace 目录流槽位（无线上通告）。',
  },
  {
    key: 'webServer',
    pkg: 'host-webserver',
    title: 'HTTP route registration',
    mode: 'core',
    consumers: ['client-connection', 'client-modules', 'client-hmr'],
    note: '纯 node:http 载体：命名路由注册表、index 转换钩子和静态 dist 回退；web-transport 插件注册自己的路由。',
  },
  {
    key: 'clientModules',
    pkg: 'client-modules',
    title: 'Client plugin graph host',
    mode: 'core',
    consumers: ['client-hmr'],
    note: '从增量 dsh.client 扫描组合 __DSH_BOOT__ 入口图，提供插件 bundle，并通知 rebuilt/graph-changed 订阅者。',
  },
  {
    key: 'workflowEngine',
    pkg: 'workflow',
    title: 'Workflow script engine',
    mode: 'seam',
    implementations: ['workflow-worker-thread'],
    consumers: ['tool-workflow', 'tool-ralph'],
    note: '每个上下文一个引擎，如同 bash，没有命名提供方注册表；通用 workflow 与固定的 Ralph 消费方启动运行，其 agent() 调用通过 ctx.subagents 扇出。',
  },
  {
    key: 'webhookRuntime',
    pkg: 'webhook',
    title: 'Webhook rule runtime',
    mode: 'core',
    consumers: ['webhook-github'],
    note: '提供方适配器派发已认证的投递；受信插件注册独立的进程本地规则，运行时把非空结果转换为普通的 Workspace 支撑 Session，而无投递或完成状态。',
  },
  {
    key: 'lsp',
    pkg: 'lsp',
    title: 'Language-server navigation seam',
    mode: 'seam',
    implementations: ['lsp-stdio'],
    consumers: ['tool-lsp'],
    note: '提供方注册与选择，加上恰好四种操作之上的规范化查询执行；seam 不提供协议逃生口，因此后端翻译为规范化请求与结果。',
  },
  {
    key: 'imageUnderstanding',
    pkg: 'image-understanding',
    title: 'Generated text for images a route cannot read',
    mode: 'seam',
    consumers: ['api-session-controller'],
    note: '一条视觉路由为声明仅文本输入的目标路由描述一张持久图片；准入路径把结果附加到图片块，因此目标模型读到有界文字而非省略提示。',
  },
  {
    key: 'lightweightModel',
    pkg: 'lightweight-model',
    title: 'Auxiliary route for session titles and compaction',
    mode: 'core',
    consumers: ['compaction-basic', 'session-title-llm', 'tool-cordis'],
    note: '持有一对可选的提供方/模型，供辅助模型调用共享，使部署把每个辅助调用指向同一路由而无需逐个配置调用方。',
  },
  {
    key: 'delivery',
    pkg: 'delivery',
    title: 'Delivery task state and change log',
    mode: 'core',
    consumers: ['tool-delivery', 'tool-cordis'],
    note: '拥有当前交付任务、其阶段顺序和交付界面回放的持久变更流；调用方读取状态并记录变更，从不重写它们。',
  },
  {
    key: 'dynamicCordisRunner',
    pkg: 'cordis-host-runner',
    title: 'Dynamic Cordis package host runner',
    mode: 'core',
    consumers: ['tool-cordis'],
    note: '拥有内存定义注册表、Host 半的 vm 沙箱和 request-run 往返流程；浏览器页面通过其 Remote 命名空间在线访问同一服务。',
  },
  {
    key: 'cordisInspect',
    pkg: 'cordis-host-runner',
    title: 'Dynamic Cordis inspect registry',
    mode: 'core',
    consumers: ['tool-cordis'],
    note: '注册 Host inspect 提供方、镜像 Client 提供方 manifest，并通过动态 Cordis 传输路由 Client 查询。',
  },
]

function generatedHeader(title: string): string[] {
  return [
    '<!-- 由 scripts/gen-doc-graphs.ts 生成——请勿手工编辑。',
    '     运行 `pnpm run gen-doc-graphs` 重新生成。 -->',
    '',
    `# ${title}`,
    '',
  ]
}

function maintenanceFooter(source: string): string[] {
  return [`维护模式：${source}。`, '']
}

function graphIndexLink(rel: string): string {
  return relative('docs', rel).replaceAll('\\', '/')
}

function linkFromDoc(docRel: string, targetRel: string): string {
  return relative(dirname(docRel), targetRel).replaceAll('\\', '/')
}

function mermaidCode(value: string): string {
  return `<code>${value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code>`
}

function repoLink(path: string, label: string, up = '..'): string {
  return `[${label}](${up}/${path})`
}

function sourceLink(source: string, up = '..'): string {
  return repoLink(source.split(':')[0] ?? source, `\`${source}\``, up)
}

function pkgLink(pkg: Pkg | undefined, fallback: string, up = '..'): string {
  return pkg ? repoLink(pkg.rel, `\`${pkg.short}\``, up) : `\`${fallback}\``
}

function pkgList(names: string[] | undefined, pkgsByShort: Map<string, Pkg>): string {
  if (!names || names.length === 0) return '-'
  return names.map(name => pkgLink(pkgsByShort.get(name), name)).join(', ')
}

function tableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, '<br>')
}

function assertServiceRolesComplete(services: readonly ServiceEntry[]): void {
  const discovered = new Set(services.map(service => service.key))
  const classified = new Set(SERVICE_ROLES.map(role => role.key))
  const missing = [...discovered].filter(key => !classified.has(key)).sort()
  const stale = [...classified].filter(key => !discovered.has(key)).sort()
  if (missing.length || stale.length) {
    throw new Error([
      missing.length ? `missing service role classification: ${missing.join(', ')}` : '',
      stale.length ? `stale service role classification: ${stale.join(', ')}` : '',
    ].filter(Boolean).join('; '))
  }
}

function renderCapabilitySeams(pkgs: Pkg[], services: readonly ServiceEntry[]): string {
  assertServiceRolesComplete(services)
  const pkgsByShort = new Map(pkgs.map(pkg => [pkg.short, pkg]))
  const maintenance = '混合模式。服务从 Cordis 声明中发现；接口、实现和消费方角色在 `scripts/gen-doc-graphs.ts` 中分类，并设有完整性守卫'
  const nodes = new Map<string, string>()
  const edges = new Set<string>()
  const companionEdges = new Set<string>()
  const addNode = (id: string, label: string): void => {
    if (!nodes.has(id)) nodes.set(id, `  ${id}["${escLabel(label)}"]`)
  }
  const addEdge = (from: string, to: string): void => { edges.add(`  ${from} --> ${to}`) }
  const lines = generatedHeader('能力 Seams 与核心服务')
  lines.push(
    '服务可以是核心主干服务、可替换的能力 seam，也可以是组合包／组合点。下图展示了拥有服务声明的包、已知实现包，以及直接消费该服务的包。',
    '',
    '```mermaid',
    'flowchart LR',
  )
  for (const role of SERVICE_ROLES) {
    const svc = nodeId('svc', role.key)
    const owner = nodeId('pkg', role.pkg)
    addNode(owner, role.pkg)
    addNode(svc, `ctx.${role.key}<br/>${role.title}`)
    addEdge(owner, svc)
    for (const impl of role.implementations ?? []) {
      addNode(nodeId('pkg', impl), impl)
      addEdge(nodeId('pkg', impl), svc)
    }
    for (const consumer of role.consumers ?? []) {
      addNode(nodeId('pkg', consumer), consumer)
      addEdge(svc, nodeId('pkg', consumer))
    }
    for (const companion of role.companions ?? []) {
      addNode(nodeId('pkg', companion), companion)
      companionEdges.add(`  ${svc} -. event gate .-> ${nodeId('pkg', companion)}`)
    }
  }
  lines.push(...nodes.values(), ...[...edges].sort(), ...[...companionEdges].sort())
  lines.push('```', '', '| ctx 键 | 角色 | 所属包 | 实现 | 直接消费方 | 配套插件 | 说明 |', '| --- | --- | --- | --- | --- | --- | --- |')
  for (const role of SERVICE_ROLES) {
    lines.push(`| \`ctx.${role.key}\` | \`${role.mode}\` | ${pkgLink(pkgsByShort.get(role.pkg), role.pkg)} | ${pkgList(role.implementations, pkgsByShort)} | ${pkgList(role.consumers, pkgsByShort)} | ${pkgList(role.companions, pkgsByShort)} | ${tableCell(role.note)} |`)
  }
  lines.push('', ...maintenanceFooter(maintenance))
  return lines.join('\n')
}

function parseExampleCordis(rel: string): ExamplePlugin[] {
  const text = readFileSync(resolve(root, rel), 'utf8')
  const plugins: ExamplePlugin[] = []
  let current: { id: string; name?: string } | null = null
  const flush = (): void => {
    if (current?.name) plugins.push({ id: current.id, name: current.name })
  }
  for (const line of text.split('\n')) {
    // Top-level rows (`- id:`) and bundle-patch insert rows (`    - id:`).
    const id = /^\s*-\s+id:\s+(.+?)\s*$/.exec(line)
    if (id?.[1] !== undefined) {
      flush()
      current = { id: stripYamlScalar(id[1]) }
      continue
    }
    const name = /^\s+name:\s+(.+?)\s*$/.exec(line)
    if (name?.[1] !== undefined && current) current.name = stripYamlScalar(name[1])
  }
  flush()
  return plugins
}

function stripYamlScalar(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '')
}

const APP_EXAMPLES = [
  {
    id: 'dsh_base',
    rel: 'apps/cli/composition.md',
    title: 'DSH Base Composition',
    label: 'packages/bundle/base/cordis.patch.yml',
    config: 'packages/bundle/base/cordis.patch.yml',
    summary: 'The dsh-base bundle patch shared by the web, headless, sdk, and acp profiles; their mode bundles and user layers patch over it, while sdk-minimal owns a separate standalone tree.',
  },
]

type AppExample = typeof APP_EXAMPLES[number]

function renderAppComposition(example: AppExample): string {
  const plugins = parseExampleCordis(example.config)
  const maintenance = 'hybrid: the patch row list is parsed from its `cordis.yml`; app package expansion is curated from package source'
  const lines = generatedHeader(example.title)
  lines.push(
    example.summary,
    '',
    '```mermaid',
    'flowchart LR',
    `  cfg["${escLabel(example.label)}<br/>cordis.yml"]`,
  )
  for (const plugin of plugins) {
    const pluginNode = nodeId(`plugin_${example.id}`, plugin.id)
    lines.push(`  ${pluginNode}["${escLabel(plugin.id)}<br/>${escLabel(plugin.name)}"]`)
    lines.push(`  cfg --> ${pluginNode}`)
  }
  lines.push(
    '```',
    '',
    '| Plugin id | Package / module |',
    '| --- | --- |',
    ...plugins.map(plugin => `| \`${plugin.id}\` | \`${plugin.name}\` |`),
    '',
    `Source config: [\`${example.config}\`](${linkFromDoc(example.rel, example.config)}).`,
  )
  lines.push('', ...maintenanceFooter(maintenance))
  return lines.join('\n')
}

type CallSiteIndex = Map<ts.SignatureDeclaration | ts.JSDocSignature, ts.CallExpression[]>

/**
 * The only method names visitSource classifies; receiver typing runs on these
 * alone. Obligation: every method name matched by a branch inside visitSource
 * must appear here — the prefilter drops non-members before any branch runs,
 * so a branch for an unlisted name is silently dead.
 */
const EVENT_API_METHODS = new Set(['on', 'once', 'emit', 'parallel', 'serial', 'waterfall', 'dispatch'])

/**
 * Collect event dispatch/listener relations from real cross-file receiver types.
 *
 * TODO: the program is seeded from the host aggregate alone (ts-project.ts
 * documents why: one program cannot hold both faces' Context merges), so a
 * Client package enters only when a host file imports it. Client-face
 * listeners on client-face events are therefore under-reported —
   * `connection/reset` omits `ui-skill`/`ui-agent-preset`. Closing it needs a
   * second Client program whose relations merge into these, not a wider seed.
 */
export class EventRelationCollector {
  private readonly relations = new Map<string, EventRelation>()
  private readonly fileCallSites = new Map<ts.SourceFile, CallSiteIndex>()
  private readonly localCalleeProofs = new Map<ts.FunctionDeclaration, boolean>()
  private globalCallSites: CallSiteIndex | null = null
  private readonly contextType: ts.Type
  private readonly agentDispatchType: ts.Type
  private readonly eventsServiceType: ts.Type
  private readonly packageSourceFiles: ReadonlySet<ts.SourceFile>

  constructor(
    private readonly project: TypeScriptProject,
    private readonly sources: readonly PackageSource[],
  ) {
    this.contextType = this.declaredType('vendor/cordis/src/context.ts', 'Context')
    this.agentDispatchType = this.declaredType('packages/core/agent/src/dispatch.ts', 'AgentEventDispatch')
    this.eventsServiceType = this.declaredType('vendor/cordis/src/events.ts', 'EventsService')
    this.packageSourceFiles = new Set(sources.map(source => source.sourceFile))
  }

  /** Return all event relations discovered from the Program. */
  collect(): Map<string, EventRelation> {
    for (const source of this.sources) this.visitSource(source)
    return this.relations
  }

  /** Resolve one named class/interface declaration to its merged instance type. */
  private declaredType(relativePath: string, name: string): ts.Type {
    const sourceFile = this.project.sourceFile(relativePath)
    const declaration = sourceFile.statements.find((statement): statement is ts.ClassDeclaration | ts.InterfaceDeclaration => {
      return (ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement)) && statement.name?.text === name
    })
    const symbol = declaration?.name && this.project.checker.getSymbolAtLocation(declaration.name)
    if (!symbol) throw new Error(`cannot resolve TypeScript type ${name} from ${relativePath}`)
    return this.project.checker.getDeclaredTypeOfSymbol(symbol)
  }

  /** Index resolved function calls in the given files for narrow argument-flow recovery. */
  private buildCallSiteIndex(files: Iterable<ts.SourceFile>): CallSiteIndex {
    const index: CallSiteIndex = new Map()
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const declaration = this.project.checker.getResolvedSignature(node)?.declaration
        if (declaration) {
          const calls = index.get(declaration) ?? []
          calls.push(node)
          index.set(declaration, calls)
        }
      }
      ts.forEachChild(node, visit)
    }
    for (const file of files) visit(file)
    return index
  }

  /**
   * Return every indexed call resolving to one local helper declaration.
   * Fast path: when every same-file reference to the non-exported helper is
   * provably a direct callee, module scoping confines all of its calls to that
   * file, so only that file is indexed. Any other reference form may alias
   * the function value outward, so the original full package-source index
   * decides instead.
   */
  private callSitesFor(owner: ts.FunctionDeclaration): ts.CallExpression[] {
    if (!this.globalCallSites && !this.provenLocalCallee(owner)) {
      this.globalCallSites = this.buildCallSiteIndex(this.packageSourceFiles)
    }
    if (this.globalCallSites) return this.globalCallSites.get(owner) ?? []
    const file = owner.getSourceFile()
    let index = this.fileCallSites.get(file)
    if (!index) {
      index = this.buildCallSiteIndex([file])
      this.fileCallSites.set(file, index)
    }
    return index.get(owner) ?? []
  }

  /**
   * Prove every same-file reference to one helper is a direct callee. The
   * proof owns its premises: an exported helper or a helper in a global
   * script file (no import/export means program-wide scope, callable from
   * another file with no same-file reference at all) fails immediately.
   * Alias escapes (re-export statements, default exports, value reads)
   * resolve back to the owner symbol at a non-callee position and fail the
   * proof, as does anything the scan cannot positively classify.
   */
  private provenLocalCallee(owner: ts.FunctionDeclaration): boolean {
    const cached = this.localCalleeProofs.get(owner)
    if (cached !== undefined) return cached
    if (hasExportModifier(owner) || !ts.isExternalModule(owner.getSourceFile())) {
      this.localCalleeProofs.set(owner, false)
      return false
    }
    const name = owner.name
    const ownerSymbol = name && this.project.checker.getSymbolAtLocation(name)
    let proven = !!ownerSymbol
    const refersToOwner = (identifier: ts.Identifier): boolean => {
      // Shorthand properties resolve to the property symbol; ask for the value side.
      const local = ts.isShorthandPropertyAssignment(identifier.parent)
        ? this.project.checker.getShorthandAssignmentValueSymbol(identifier.parent)
        : this.project.checker.getSymbolAtLocation(identifier)
      if (!local) return false
      const symbol = local.flags & ts.SymbolFlags.Alias
        ? this.project.checker.getAliasedSymbol(local)
        : local
      return symbol === ownerSymbol
    }
    const visit = (node: ts.Node): void => {
      if (!proven) return
      if (ts.isIdentifier(node) && node !== name && node.text === name?.text
        && !isDirectCallee(node) && refersToOwner(node)) {
        proven = false
        return
      }
      ts.forEachChild(node, visit)
    }
    visit(owner.getSourceFile())
    this.localCalleeProofs.set(owner, proven)
    return proven
  }

  /** Walk one package source file and classify event API calls by receiver type. */
  private visitSource(source: PackageSource): void {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        if (this.isAgentEventEmitter(node.expression)) {
          const event = node.arguments[2]
          if (event) {
            for (const name of this.finiteStringValues(event) ?? []) {
              this.addDispatcher(name, source.pkg, 'emitAgentEvent')
            }
          }
        } else if (ts.isPropertyAccessExpression(node.expression) && EVENT_API_METHODS.has(node.expression.name.text)) {
          const receiverKind = this.receiverKind(node.expression.expression)
          const method = node.expression.name.text
          if (receiverKind === 'events-service' && method === 'dispatch') {
            const argumentList = node.arguments[1]
            if (argumentList) {
              for (const event of this.eventNamesFromArgumentList(argumentList, new Set())) {
                this.addDispatcher(event, source.pkg, 'events.dispatch')
              }
            }
          } else if (receiverKind === 'context' || receiverKind === 'agent-dispatch') {
            const eventNames = this.eventNamesFromCall(node, receiverKind)
            if (method === 'on' || method === 'once') {
              for (const event of eventNames) this.ensure(event).listeners.add(source.pkg)
            } else if (method === 'emit' || method === 'parallel' || method === 'serial' || method === 'waterfall') {
              for (const event of eventNames) this.addDispatcher(event, source.pkg, method)
            }
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source.sourceFile)
  }

  /** Match the exported contained-notification helper by declaration identity. */
  private isAgentEventEmitter(expression: ts.Expression): boolean {
    if (!ts.isIdentifier(expression)) return false
    const local = this.project.checker.getSymbolAtLocation(expression)
    if (!local) return false
    const symbol = local.flags & ts.SymbolFlags.Alias
      ? this.project.checker.getAliasedSymbol(local)
      : local
    const declarations = symbol.declarations ?? []
    return declarations.some((declaration) => {
      return ts.isFunctionDeclaration(declaration)
        && declaration.name?.text === 'emitAgentEvent'
        && this.project.relativePath(declaration.getSourceFile()) === 'packages/core/agent/src/dispatch.ts'
    })
  }

  /** Classify a receiver using assignability to the repository's actual event API types. */
  private receiverKind(receiver: ts.Expression): EventReceiverKind | undefined {
    const type = this.project.checker.getTypeAtLocation(receiver)
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return undefined
    if (this.project.checker.isTypeAssignableTo(type, this.eventsServiceType)) return 'events-service'
    if (this.project.checker.isTypeAssignableTo(type, this.contextType)) return 'context'
    if (this.project.checker.isTypeAssignableTo(type, this.agentDispatchType)) return 'agent-dispatch'
    return undefined
  }

  /** Resolve the event-name argument for Context and fused agent dispatch calls. */
  private eventNamesFromCall(call: ts.CallExpression, receiverKind: Exclude<EventReceiverKind, 'events-service'>): Set<string> {
    const candidates = receiverKind === 'context' ? call.arguments.slice(0, 2) : call.arguments.slice(0, 1)
    for (const candidate of candidates) {
      const values = this.finiteStringValues(candidate)
      if (values) return values
    }
    return new Set()
  }

  /** Recover the event slot from the argument array handed to EventsService.dispatch(). */
  private eventNamesFromArgumentList(expression: ts.Expression, seen: Set<ts.Node>): Set<string> {
    const current = unwrapExpression(expression)
    if (seen.has(current)) return new Set()
    seen.add(current)

    if (ts.isArrayLiteralExpression(current)) {
      for (const element of current.elements.slice(0, 2)) {
        if (ts.isOmittedExpression(element) || ts.isSpreadElement(element)) continue
        const values = this.finiteStringValues(element)
        if (values) return values
      }
      return new Set()
    }
    if (ts.isConditionalExpression(current)) {
      return unionSets(
        this.eventNamesFromArgumentList(current.whenTrue, new Set(seen)),
        this.eventNamesFromArgumentList(current.whenFalse, new Set(seen)),
      )
    }
    if (!ts.isIdentifier(current)) return new Set()

    const symbol = this.project.checker.getSymbolAtLocation(current)
    if (!symbol) return new Set()
    const events = new Set<string>()
    for (const declaration of symbol.declarations ?? []) {
      if (ts.isVariableDeclaration(declaration) && declaration.initializer && isConstDeclaration(declaration)) {
        addAll(events, this.eventNamesFromArgumentList(declaration.initializer, new Set(seen)))
      } else if (ts.isParameter(declaration)) {
        addAll(events, this.eventNamesFromParameter(declaration, seen))
      }
    }
    return events
  }

  /** Follow a non-exported local helper parameter back to every resolved call site. */
  private eventNamesFromParameter(parameter: ts.ParameterDeclaration, seen: Set<ts.Node>): Set<string> {
    const owner = parameter.parent
    if (!ts.isFunctionDeclaration(owner) || hasExportModifier(owner)) return new Set()
    const index = owner.parameters.indexOf(parameter)
    if (index < 0) return new Set()
    const events = new Set<string>()
    for (const call of this.callSitesFor(owner)) {
      const argument = call.arguments[index]
      if (argument) addAll(events, this.eventNamesFromArgumentList(argument, new Set(seen)))
    }
    return events
  }

  /** Return a finite string-literal value set, rejecting widened and generic strings. */
  private finiteStringValues(expression: ts.Expression): Set<string> | undefined {
    const current = unwrapExpression(expression)
    if (ts.isStringLiteralLike(current)) return new Set([current.text])
    if (this.isForwardedAgentEventParameter(current)) return undefined
    return finiteStringTypeValues(this.project.checker.getTypeAtLocation(current))
  }

  /** Reject the contextual parameter inside the AgentEventDispatch forwarding object. */
  private isForwardedAgentEventParameter(expression: ts.Expression): boolean {
    if (!ts.isIdentifier(expression)) return false
    const declarations = this.project.checker.getSymbolAtLocation(expression)?.declarations ?? []
    return declarations.some((declaration) => {
      if (!ts.isParameter(declaration)) return false
      const method = declaration.parent
      if (!ts.isMethodDeclaration(method) || !ts.isObjectLiteralExpression(method.parent)) return false
      const contextualType = this.project.checker.getContextualType(method.parent)
      return contextualType !== undefined
        && this.project.checker.isTypeAssignableTo(contextualType, this.agentDispatchType)
    })
  }

  /** Get or create one relation row. */
  private ensure(event: string): EventRelation {
    const existing = this.relations.get(event)
    if (existing) return existing
    const relation = { dispatchers: new Map<string, Set<string>>(), listeners: new Set<string>() }
    this.relations.set(event, relation)
    return relation
  }

  /** Add one dispatcher method without duplicating package/method labels. */
  private addDispatcher(event: string, pkg: string, method: string): void {
    const relation = this.ensure(event)
    const methods = relation.dispatchers.get(pkg) ?? new Set<string>()
    methods.add(method)
    relation.dispatchers.set(pkg, methods)
  }
}

/** Return whether an identifier is the callee of a call, seen through value-preserving wrappers. */
function isDirectCallee(identifier: ts.Identifier): boolean {
  let current: ts.Node = identifier
  while (
    ts.isParenthesizedExpression(current.parent)
    || ts.isAsExpression(current.parent)
    || ts.isTypeAssertionExpression(current.parent)
    || ts.isNonNullExpression(current.parent)
    || ts.isSatisfiesExpression(current.parent)
  ) {
    current = current.parent
  }
  return ts.isCallExpression(current.parent) && current.parent.expression === current
}

/** Peel syntax-only wrappers that do not change an expression's runtime value. */
function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)
  ) {
    current = current.expression
  }
  return current
}

/** Return every value only when a type is a closed string-literal union. */
function finiteStringTypeValues(type: ts.Type): Set<string> | undefined {
  if (type.flags & ts.TypeFlags.StringLiteral) {
    return new Set([(type as ts.StringLiteralType).value])
  }
  if (type.flags & ts.TypeFlags.Never) return new Set()
  if (!type.isUnion()) return undefined
  const values = new Set<string>()
  for (const member of type.types) {
    const memberValues = finiteStringTypeValues(member)
    if (!memberValues) return undefined
    addAll(values, memberValues)
  }
  return values
}

/** Return whether a variable declaration belongs to a const declaration list. */
function isConstDeclaration(declaration: ts.VariableDeclaration): boolean {
  return (declaration.parent.flags & ts.NodeFlags.Const) !== 0
}

/** Return whether a declaration is visible to callers outside its source module. */
function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((modifier) => {
    return modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword
  }) ?? false)
}

/** Add every member of source to target. */
function addAll<T>(target: Set<T>, source: ReadonlySet<T>): void {
  for (const value of source) target.add(value)
}

/** Return the union of two sets without mutating either input. */
function unionSets<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): Set<T> {
  const out = new Set(left)
  addAll(out, right)
  return out
}

/**
 * Select the package source files of one project in deterministic order.
 * @param project - the loaded repository TypeScript project.
 * @returns `packages/<group>/<pkg>/src` files tagged with their package name.
 */
export function collectPackageSources(project: TypeScriptProject): PackageSource[] {
  return project.sourceFiles().flatMap((sourceFile): PackageSource[] => {
    const rel = project.relativePath(sourceFile)
    const match = /^packages\/[^/]+\/([^/]+)\/src\/.+\.ts$/.exec(rel)
    return match?.[1] ? [{ rel, pkg: match[1], sourceFile }] : []
  }).sort((left, right) => left.rel.localeCompare(right.rel))
}

function collectEventRelations(): Map<string, EventRelation> {
  const project = new TypeScriptProject(root)
  return new EventRelationCollector(project, collectPackageSources(project)).collect()
}

function relationPackages(map: Map<string, Set<string>>, pkgsByShort: Map<string, Pkg>): string {
  if (map.size === 0) return '-'
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([pkg, methods]) => `${pkgLink(pkgsByShort.get(pkg), pkg)} (${[...methods].sort().map(m => `\`${m}\``).join(', ')})`)
    .join(', ')
}

function listenerPackages(listeners: Set<string>, pkgsByShort: Map<string, Pkg>): string {
  if (listeners.size === 0) return '-'
  return [...listeners].sort().map(pkg => pkgLink(pkgsByShort.get(pkg), pkg)).join(', ')
}

function renderEventRelations(pkgs: Pkg[], events: readonly EventEntry[]): string {
  const relations = collectEventRelations()
  const pkgsByShort = new Map(pkgs.map(pkg => [pkg.short, pkg]))
  const maintenance = '生成内容。Cordis 事件声明及生产方／监听方的关系边由仓库的 TypeScript Program 解析。'
  const lines = generatedHeader('事件生产方与消费方矩阵')
  lines.push(
    '本矩阵展示哪些包会派发各个 harness 自有事件，以及哪些包会监听这些事件。事件之间存在多对多关系，因此密集的关系数据以表格而非一张大型关系图呈现。接收方和事件名称类型还涵盖有意绕过 `ctx.emit` 的内含派发位置，例如 subagent 生命周期封装。',
    '',
    '| 事件 | 模式 | 声明位置 | 派发方 | 监听方 |',
    '| --- | --- | --- | --- | --- |',
  )
  for (const event of [...events].sort((a, b) => a.name.localeCompare(b.name))) {
    const relation = relations.get(event.name) ?? { dispatchers: new Map<string, Set<string>>(), listeners: new Set<string>() }
    lines.push(`| \`${event.name}\` | \`${event.mode}\` | ${sourceLink(event.source)} | ${relationPackages(relation.dispatchers, pkgsByShort)} | ${listenerPackages(relation.listeners, pkgsByShort)} |`)
  }
  // Every declared event needs a dispatcher: zero means dead vocabulary or an
  // unrecognized semantic dispatch form. Listener-free extension points remain
  // valid. Client-declared events are exempt: the relation scan seeds the HOST
  // aggregate program only (host+client cannot share one program — the cordis
  // Context merges collide), so client dispatch sites are structurally
  // invisible here; their rows stay in the table for the declarations' sake.
  const undispatched = [...events]
    .filter(event => !event.source.startsWith('packages/client/'))
    .filter(event => (relations.get(event.name)?.dispatchers.size ?? 0) === 0)
    .map(event => event.name)
    .sort()
  if (undispatched.length > 0) {
    throw new Error(
      `event-producer-consumer matrix: no dispatcher found for declared event${undispatched.length > 1 ? 's' : ''} `
      + `${undispatched.map(name => `"${name}"`).join(', ')} — dead vocabulary, or a dispatch form the semantic scan misses `
      + '(teach scripts/gen-doc-graphs.ts that form)',
    )
  }
  const declared = new Set(events.map(event => event.name))
  const extra = [...relations.keys()].filter(event => !declared.has(event)).sort()
  if (extra.length > 0) {
    lines.push('', '## 包源码中出现的非 harness 或未声明事件字符串', '', '| 事件字符串 | 派发方 | 监听方 |', '| --- | --- | --- |')
    for (const event of extra) {
      const relation = relations.get(event)
      if (!relation) continue
      lines.push(`| \`${event}\` | ${relationPackages(relation.dispatchers, pkgsByShort)} | ${listenerPackages(relation.listeners, pkgsByShort)} |`)
    }
  }
  lines.push('', ...maintenanceFooter(maintenance))
  return lines.join('\n')
}

function renderLifecycle(): string {
  const maintenance = '人工维护的 Mermaid 时序图，由生成器写出；确切的事件签名位于生成的 Cordis 目录中。'
  return [
    ...generatedHeader('Agent 轮次与步骤生命周期'),
    '此时序图是 [architecture.md](architecture.zh.md#turn-flow) 的配套图示。持久的回放事实保存在 `session/event` 中，实时控制与状态则保存在 `agent/*` 中。',
    '',
    '```mermaid',
    'sequenceDiagram',
    '  participant User',
    '  participant Agent',
    '  participant Driver',
    '  participant Hooks as hook listeners',
    '  participant Prompt as ctx.systemPrompt',
    '  participant LLM as ctx.llm',
    '  participant Tools as ctx.tools',
    '  participant Session',
    '  participant SDK as UI or SDK listener',
    '  User->>Agent: followup(content)',
    `  Agent-->>SDK: ${mermaidCode('agent/inbox/spliced')}`,
    `  Agent-->>SDK: ${mermaidCode('agent/inbox/inserted')} { message }`,
    '  Agent->>Driver: queued work wakes driver',
    `  Driver-->>SDK: ${mermaidCode('agent/status')} running`,
    `  Driver->>Session: ${mermaidCode('turn/start')}`,
    '  Note over Agent,Driver: claim pending next-step input plus one queued prompt',
    `  Driver-->>SDK: ${mermaidCode('agent/inbox/spliced')} pure deletion`,
    `  Driver-->>SDK: ${mermaidCode('agent/inbox/claimed')} { message, turn } per message`,
    `  Driver->>Hooks: ${mermaidCode('agent/pre-step')} waterfall`,
    '  Hooks-->>Driver: authoritative reject or enter(messages)',
    '  alt proposed step rejected or pre-step failed',
    '    Driver-->>Driver: claimed batch stays removed, the open turn spends no step',
    '  else enter proposed step',
    `  Driver->>Session: ${mermaidCode('step/start')}`,
    `  Driver->>Session: ${mermaidCode('user/message')} per entered message`,
    `  Driver->>Prompt: ${mermaidCode('system-prompt/assemble')} waterfall`,
    `  Driver->>LLM: ${mermaidCode('agent/request')} waterfall, then ${mermaidCode('llm/stream')} waterfall`,
    '  LLM-->>Driver: StreamChunk*',
    `  Driver->>Session: ${mermaidCode('assistant/chunk')}*`,
    `  Session-->>SDK: ${mermaidCode('session/event')} ${mermaidCode('assistant/chunk')}*`,
    '  alt final adapter or terminal in-band request failure',
    `    Driver->>Session: ${mermaidCode('step/end')}`,
    `    Driver->>Hooks: ${mermaidCode('agent/request-error')} waterfall`,
    '    Hooks-->>Driver: return retry action or preserve the original error',
    '  else model request succeeded',
    `  Driver->>Session: ${mermaidCode('assistant/message')}`,
    '  Driver->>Tools: classify pending call by executionMode',
    '  loop barriers and bounded rolling pool, reclassify before start',
    '    opt call starts',
    `      Driver->>Session: ${mermaidCode('tool/call')}`,
    '      Driver->>Tools: ordered pre, concurrent execute',
    '      Tools-->>Session: tool-owned events when applicable',
    '    end',
    '    opt next model-order result ready',
    '      Driver->>Tools: ordered post',
    `      Driver->>Session: ${mermaidCode('tool/result')}`,
    '    end',
    '  end',
    `  Driver->>Session: ${mermaidCode('step/end')}`,
    '  opt natural stop and next-step inbox empty',
    `    Driver->>Hooks: ${mermaidCode('agent/turn-stopping')} serial terminal checkpoint`,
    '  end',
    '  opt next-step input is pending',
    '    Driver-->>Driver: claim pending next-step input',
    `    Driver-->>SDK: ${mermaidCode('agent/inbox/claimed')} { message, turn } per message`,
    `    Driver->>Hooks: ${mermaidCode('agent/pre-step')} waterfall`,
    '    Hooks-->>Driver: authoritative reject or enter(messages)',
    '  end',
    '  end',
    '  end',
    `  Driver->>Session: ${mermaidCode('turn/end')}`,
    `  Driver-->>SDK: ${mermaidCode('agent/status')} idle`,
    '```',
    '',
    '`assistant/message` 事件记录每一次成功的提供方调用，包括无内容和 `max-tokens` 的结束。空内容不进入派生历史，而持久事件保留用量和 `sourceEventSeqs`，列出确切的 `assistant/chunk` 事件，包括显式的空列表。',
    '',
    '`dsh-compaction-basic` 在请求派生之前用 `agent/pre-step` 处理压力，并仅在规范上下文溢出时用 `agent/request-error`。一旦任一触发条件成立，可选的工具结果剪枝会在摘要选择之前运行。恢复在已关闭的失败步与失败轮次关闭之间工作，且仅在剪枝或摘要推进表面替换代数时才开启新的重试轮次；否则原始请求错误保持权威。',
    '',
    '返回的 `agent/pre-step` 决策是权威的；包裹 `next()` 的监听者保留下游消息和 `startsRequestSeries`，除非替换是有意的。转向与注入的上下文在后续 claim 操作取走其下一批后，通过同一 waterfall。',
    '',
    '需要可回放转录数据的 SDK 用户应消费 `session/event`；`agent/*` 是队列/状态、提示词拦截、请求构造、转向、续行和错误的实时协调 API。',
    '',
    ...maintenanceFooter(maintenance),
  ].join('\n')
}

function renderToolPipeline(): string {
  const maintenance = '人工维护的 Mermaid 流程图，由生成器写出；确切的工具 schema 与事件签名位于生成的目录中。'
  return [
    ...generatedHeader('工具执行流水线'),
    '此图展示策略、钩子、沙箱、文件系统守卫、结果重写、最终结果观察和 UI 渲染在不改变循环的情况下何时运行。`tools/pre-execute` waterfall（瀑布式事件）首先运行，随后是单调守卫，然后运行 `tools/execute` 和 `tools/post-execute` waterfall；这三个 waterfall 可以改写一次调用。由定义自身控制的 `finalizeContent` 和 `tools/result` 在此之后运行。',
    '',
    '```mermaid',
    'flowchart TD',
    '  model["Assistant message contains tool-call block"]',
    `  toolCall["Session event: ${mermaidCode('tool/call')}<br/>logged before execution"]`,
    '  presentCall["UI pending card<br/>presentCall(args)"]',
    `  pre["${mermaidCode('tools/pre-execute')} waterfall<br/>hooks, permission, sandbox"]`,
    '  guards["Registered monotonic guards<br/>deny or abstain; identity protected"]',
    '  denied["denied or approval refused<br/>tool body skipped"]',
    `  approval["${mermaidCode('ctx.approval')} one-shot prompt<br/>absent or unanswerable: deny"]`,
    `  around["${mermaidCode('tools/execute')} waterfall<br/>timeout, retry, metrics (around dispatch)"]`,
    '  toolBody["Registered tool execute() body"]',
    `  fsGate["${mermaidCode('fs/write-intent')} or ${mermaidCode('fs/edit-intent')}<br/>tool-fs mutations only"]`,
    `  owned["Tool-owned session events<br/>${mermaidCode('todo/write')}, ${mermaidCode('fs/observed')}, ${mermaidCode('hook/invoked')}, ${mermaidCode('hook/result')}, ${mermaidCode('tool/code-dispatch')}"]`,
    `  post["${mermaidCode('tools/post-execute')} waterfall<br/>accept, block, replace, add context"]`,
    '  normalized["Registry outer normalization<br/>pipeline/result snapshot throws become isError"]',
    '  finalize["ToolDefinition.finalizeContent<br/>last content-only invariant"]',
    `  final["${mermaidCode('tools/result')} synchronous notification<br/>frozen authoritative outcome"]`,
    '  context["Active-batch additionalContexts FIFO<br/>injected user/message after recorded tool results"]',
    `  toolResult["Session event: ${mermaidCode('tool/result')}<br/>single model-facing outcome"]`,
    '  allResults["Tool batch settled<br/>recorded tool/result events complete"]',
    '  presentResult["UI completed card<br/>presentResult(args, result)"]',
    '  model --> toolCall',
    '  toolCall --> presentCall',
    '  toolCall --> pre',
    '  pre -->|allow| guards',
    '  guards -->|allow| around',
    '  guards -->|deny| denied',
    '  guards -.->|throw| normalized',
    '  around --> toolBody',
    '  pre -->|deny| denied',
    '  pre -->|ask| approval',
    '  approval -->|allowed-once| guards',
    '  approval -->|rejected, cancelled, unavailable| denied',
    '  approval -.->|throw| normalized',
    '  denied --> post',
    '  pre -.->|throw| normalized',
    '  toolBody --> fsGate',
    '  fsGate --> toolBody',
    '  toolBody --> owned',
    '  toolBody --> around',
    '  around --> post',
    '  around -.->|wrapper throws| normalized',
    '  post -.->|throw| normalized',
    '  post --> finalize',
    '  normalized --> finalize',
    '  finalize --> final',
    '  final --> toolResult',
    '  toolResult --> presentResult',
    '  toolResult --> allResults',
    '  allResults --> context',
    '```',
    '',
    '文件系统的先读后编辑检查在 `fs/*` 事件上位于 `tool-fs` 之下。通用 pre/post waterfall 承载钩子与审批策略；`ctx.approval` 在单调守卫之前解析询问，而不可重排的所有者策略仍是注册守卫。超时等环绕分发关注点包裹 `tools/execute`。注册表无损快照候选结果，并在可见定义快照后的 `finalizeContent` 回调强制执行其同步的仅内容不变量之前规范化快照失败。随后 `tools/result` 观察不可变的、无损 JSON 结果。这让钩子跨工具族而不把工具耦合到某个策略服务。PTC 模式把保留的 `run_code` 传输及其序列化子调用都送入流水线；子调用携带父 token、记录 `tool/code-dispatch`、把拒绝作为绑定拒绝返回，并省略 `additionalContexts` 以保持调用/结果相邻。',
    '',
    ...maintenanceFooter(maintenance),
  ].join('\n')
}

function renderDocs(): GraphDoc[] {
  const pkgs = collectPackageGraph(root, GROUP_ORDER, 'gen-doc-graphs')
  const { model } = projectCordisCatalog(root, CORDIS_CATALOG_POLICY)
  const docs: GraphDoc[] = [
    { rel: 'docs/capability-seams.zh.md', content: renderCapabilitySeams(pkgs, model.services) },
    ...APP_EXAMPLES.map(example => ({ rel: example.rel, content: renderAppComposition(example) })),
    { rel: 'docs/event-producer-consumer.zh.md', content: renderEventRelations(pkgs, model.events) },
    { rel: 'docs/agent-lifecycle.zh.md', content: renderLifecycle() },
    { rel: 'docs/tool-execution-pipeline.zh.md', content: renderToolPipeline() },
  ]
  docs.unshift({ rel: 'docs/graph-atlas.zh.md', content: renderIndex(docs) })
  return docs
}

function renderIndex(docs: GraphDoc[]): string {
  const labels: Record<string, string> = {
    'docs/capability-seams.zh.md': '能力 seam 与核心服务',
    'apps/cli/composition.md': 'dsh 共享基础组合',
    'docs/event-producer-consumer.zh.md': '事件生产方／消费方矩阵',
    'docs/agent-lifecycle.zh.md': 'agent（智能体）轮次与步骤生命周期',
    'docs/tool-execution-pipeline.zh.md': '工具执行流水线',
  }
  const modes: Record<string, string> = {
    'docs/capability-seams.zh.md': 'hybrid generated',
    'apps/cli/composition.md': 'hybrid generated',
    'docs/event-producer-consumer.zh.md': 'hybrid generated',
    'docs/agent-lifecycle.zh.md': 'curated',
    'docs/tool-execution-pipeline.zh.md': 'curated',
  }
  const rows = [
    '| [模块依赖图](module-graph.zh.md) | `generated` |',
    '| [工具 schema 目录与包映射](tool-catalog.zh.md) | `generated` |',
    ...docs.map((doc) => {
      const link = graphIndexLink(doc.rel)
      return `| [${labels[doc.rel] ?? link}](${link}) | \`${modes[doc.rel] ?? 'generated'}\` |`
    }),
  ]
  const maintenance = '混合。每个链接页面声明其模式为生成、混合或人工维护。'
  return [
    ...generatedHeader('文档图索引'),
    '这些图展示生成目录未包含的关系。可以用它们查找包之间的关系、能力 seam、事件流、面向模型的工具、应用组合和运行时生命周期路径。精确签名和类型定义仍以[子系统页面](subsystems/core.zh.md)（类型和生成的 `cordis-surface` 区域）及[工具目录](tool-catalog.zh.md)为准。',
    '',
    '本索引背后的流程决策记录在[文档图 Agent Note](../.agents/notes/archived/process/2026-07-03-documentation-graph-atlas.zh.md)中。',
    '',
    '| 图 | 模式 |',
    '| --- | --- |',
    ...rows,
    '',
    '运行 `pnpm run gen-doc-graphs` 重新生成；运行 `pnpm run verify-doc-graphs` 验证新鲜度。',
    '',
    ...maintenanceFooter(maintenance),
  ].join('\n')
}

function main(): void {
  const docs = renderDocs()
  if (process.argv.includes('--check')) {
    const stale: string[] = []
    for (const doc of docs) {
      const abs = resolve(root, doc.rel)
      const committed = existsSync(abs) ? readFileSync(abs, 'utf8') : null
      if (committed !== doc.content) stale.push(doc.rel)
    }
    if (stale.length === 0) {
      console.log(`gen-doc-graphs: ${docs.length} graph doc(s) are up to date.`)
      return
    }
    console.error(`gen-doc-graphs: stale graph doc(s): ${stale.join(', ')}. Run \`pnpm run gen-doc-graphs\` and commit the result.`)
    process.exit(1)
  }

  for (const doc of docs) {
    mkdirSync(dirname(resolve(root, doc.rel)), { recursive: true })
    writeFileSync(resolve(root, doc.rel), doc.content)
  }
  console.log(`gen-doc-graphs: wrote ${docs.length} graph doc(s).`)
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  main()
}
