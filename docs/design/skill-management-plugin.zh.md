# 技能管理插件设计

## 背景与目标

DSH 的「设置 → 插件」能查看已安装的 Cordis 插件，但技能（skill）没有任何图形入口：新增一个技能只能手工在磁盘上创建 `<name>/SKILL.md` 或 `<name>.md`，并手写 YAML frontmatter。本设计新增一对插件包，在设置中提供技能的浏览、新建、编辑、删除、调用开关与外部导入。

仓库中不存在可复用的现成插件：`settings.plugins.tab` 的两个贡献者分别负责可配置插件卡片与 Cordis 插件清单，均不涉及技能；`packages/client/ui-skill` 只提供 `/` 输入源与 `skill` 工具行渲染；host 侧唯一的技能 Remote（`SessionSkillCatalog`，命名空间 `skills`）是会话寻址的只读目录。

## 现状约束

技能由 `dsh-skill-filesystem` 从若干根目录发现，根目录按 rank 裁决重名。写入能力必须与这份根定义保持一致，否则界面会写到发现器不看的位置。

| Rank | 来源 | 路径 |
|---|---|---|
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` |
| 300 | `custom` | `Config.customSkillDirs` |
| 400 | `user-dsh` | `<dshHome>/skills` |
| 500 | `user-agents` | `<agentsHome>/skills` |
| 600 | `bundled` | `Config.bundledSkillDir` |

技能条目有两种形态：目录包 `<name>/SKILL.md`（可带 `references/`、`scripts/`、`assets/`）与扁平的 `<name>.md`。frontmatter 必填 `name`（kebab-case）与 `description`，可选 `whenToUse`、`metadata`、`disable-model-invocation`、`user-invocable`。

发现缓存无 TTL：只有提供方调用 `invalidate()`、运行时注册/释放，或注册表 revision 变化时才清除。

## 决策

### D1 新增独立的 `skillAdmin` Remote 命名空间

现有 `ctx.remote.skills` 服务于输入框的 `/` 补全：它按会话寻址、只返回用户可调用的**合并后**条目，且只有 `list`。管理面需要的是另一组事实——磁盘上实际存在什么、每条在哪、哪些被遮蔽或非法。两者语义不同，扩展现有命名空间会让一个只读的会话视图承担管理职责。

新增命名空间 `skillAdmin`，与 `skills` 并存。

### D2 管理视图读文件系统真相，不读注册表合并视图

注册表的 `list()`/`snapshot()` 返回去重后的胜出摘要，不含 `path`、`rank`，并会静默跳过 frontmatter 非法的条目。管理界面三项都需要：重名技能要能看到「谁遮蔽了谁」，编辑与删除要拿到绝对路径，非法条目要能被指出并修复。因此 host 侧自行扫描根目录并解析 frontmatter。

### D3 根定义由 `dsh-skill-filesystem` 暴露，不由管理插件重新推导

根解析依赖 `dshHome`、`agentsHome`、`customSkillDirs`、`bundledSkillDir` 与项目根查找，这些是 `dsh-skill-filesystem` 的知识。若管理插件自行推导，两边配置一旦不同就会出现「界面写入了发现器不扫描的目录」。

`dsh-skill-filesystem` 新增只读服务 `ctx.skillRoots`，暴露当前生效的根：

```ts
interface SkillRootInfo {
  /** Absolute root directory. */
  readonly path: string
  /** Discovery source label this root contributes under. */
  readonly source: SkillSource
  /** Precedence rank; a lower rank wins a duplicate name. */
  readonly rank: number
  /** Project root this root belongs to, when it is a project-scoped root. */
  readonly projectRoot?: string
  /** Whether the root is a trusted-host or bundled root that must not be written. */
  readonly readOnly: boolean
}
```

`bundled` 根不可写；其余根可写，包括 `custom` 根——`customSkillDirs` 本身就是部署方显式声明为技能根目录的路径，写入它符合该配置的意图，因此不额外设一个默认关闭的开关。

该服务只由**部署级实例**发布：Web 组合里 `skill-filesystem` 的 host 行保持启用，preset 挂载的实例只向本 scope 的注册表层贡献目录。Cordis 服务只有一个提供方，两次 `provide` 会让 preset 挂载直接失败；而 scope 实例的根（例如 cordis preset 通过 `customSkillDirs` 指向自己包内 `skills/` 的那一个）属于该 preset，没有会话的设置面板无法为它定位写入目标。

### D4 项目根由客户端显式传入

技能发现是 cwd 敏感的，设置面板不属于任何会话。Remote 的读与写请求都携带可选的 `projectRoot`：客户端从 `useWorkspaces` 取当前工作区路径填入。未提供时只呈现全局根（`user-dsh`、`user-agents`），项目根不出现——而非猜测一个 cwd。

### D5 文件操作走 Node 文件系统，不经过 `ctx.fs`

`ctx.fs` 缺少删除与建目录能力（其抽象方法是 `resolve`/`stat`/`readText`/`listDir`/`writeText`/`editText`），而管理面需要 `mkdir -p` 与递归删除。混用两套语义会让部分操作受 `fs-sandbox` 约束、部分不受。

管理面是 host 受信路径，语义上是「用户通过 GUI 操作自己的配置目录」，与会话沙箱要约束的模型文件操作不同。写入复用 `@deepseek-ai/dsh-util-atomic-write`（原子写且自动创建父目录），新建以「目标不存在」为前提。

### D6 写入后的可见性依赖文件监视器

`dsh-skill-filesystem` 的 `fs/observed` 同步失效路径只对第一方 `write`/`edit` **工具**生效（`mutationToolName(actor)` 校验 actor 名）；管理面的写入没有工具 actor，不会被同步失效。生效路径是 Chokidar 监视器：已存在的根在下一个模型步骤前刷新目录；尚不存在的根从最近存在祖先逐段探测，首次创建有轮询延迟。

界面不等待监视器：写入成功后自行重新读取清单并就地更新，保证操作反馈即时。目录到达模型侧的时延属于该提供方的既有行为，不在本插件内补偿。

### D7 frontmatter 以局部编辑改写，不整体重写

调用开关（`disable-model-invocation`、`user-invocable`）与描述修改若整体 `dump`，会抹掉用户写在 frontmatter 里的注释与键序。改为在 frontmatter 块内按行定位目标键：命中则改该行，未命中则在块尾追加；正文永不重写，除非用户显式编辑正文。

启用/禁用采用显式布尔写法而不是删键，因为「省略即允许」的默认值随接口不同（`disable-model-invocation` 省略为允许模型调用，`user-invocable` 省略为允许用户调用），写显式值才能让用户在文件里读到当前策略。

### D8 导入分两阶段：预览与落盘

`previewImport` 抓取并解包到内存，返回预览而**不写任何文件**；`commitImport` 依据预览标识落盘。用户确认的对象与实际写入的对象是同一份已解包数据。

预览包含：技能名与描述、完整 SKILL.md 正文、待写入文件清单（相对路径与字节数）、目标根的绝对路径、覆盖判定（目标是否已存在）。host 侧暂存预览结果，带条目上限与存活时限，`commitImport` 校验标识有效且未过期。

### D9 解包完整性硬校验

解包必须保证「预览列出的文件 = 实际写入的文件」，否则预览是虚假的保证。校验拒绝：路径穿越（`..` 段）、绝对路径、符号链接与硬链接条目、设备与其他非普通文件条目、超出单文件/总解压体积/文件数上限的包、tar 的 PAX 与 GNU 长名扩展。

压缩格式用 `fflate`（已在 `session-log-export` 与 `apps/web` 使用）做 zip 与 gzip 解压，tar 结构自行按受控子集解析——自写解析器在此不是重复造轮子，而是把「拒绝什么」写成可审查的显式分支。

内容不做审查、不做风险标记：按已确认的需求，导入的技能正文由用户在预览里自行判断。

### D10 破坏性操作的保护边界

删除需要二次确认，并报告将删除的确切路径与条目数（目录包会连同其 `references/`、`scripts/`、`assets/` 一并删除）。只读根（`bundled`，即部署随包交付的技能）拒绝写入与删除。`user-agents`（`~/.agents/skills`）与其他 agent 共享，界面在该根上明确提示「此目录与其他 agent 共享」。

## 组件

### host：`packages/host/skill-manager`

`SkillManagerGateway extends TypertRemoteService`，命名空间 `skillAdmin`。

| 方法 | 职责 |
|---|---|
| `list` | 根列表与每个根下的条目（含被遮蔽项与非法项） |
| `read` | 读取一个条目的 frontmatter 与正文 |
| `create` | 新建技能（选择根、名称、描述、正文、调用策略） |
| `update` | 改写正文与调用策略 |
| `delete` | 删除条目（文件或目录包） |
| `previewImport` | 抓取并解包到内存，返回预览 |
| `commitImport` | 按预览标识落盘 |

模块划分：根与条目扫描、frontmatter 解析与局部编辑、导入抓取、解包与校验、预览暂存。

### client：`packages/client/ui-settings-skills`

注册 `settings.section`（id `skills`，order 17，位于 `plugins` 与 `mcp` 之间），提供工作区选择、按根分组的条目列表、编辑表单、导入向导与预览对话框。文案经类型化字典，不硬编码。

## 测试

- host 单元测试：局部编辑保注释、重名遮蔽与 rank 裁决、只读根拒绝、解包校验的每条拒绝分支（路径穿越、绝对路径、符号链接、体积与数量上限）、预览过期、`commitImport` 覆盖判定。
- client 组件测试：分区渲染、表单校验、导入向导状态机、预览展示。
- REAL-composition 测试：以 test-only `cordis.yml` 经 Loader 启动，写入一个技能后断言它出现在 `ctx.skills` 的目录中——这条覆盖「写入落到发现器真正扫描的位置」。
- 该插件是产品可见面，需要 GUI 快照或截图证据。

## 已知取舍

- **首次创建全局根有探测延迟**：根目录此前不存在时，监视器按段轮询，模型侧可见时间晚于界面反馈。
- **预览暂存在内存**：进程重启后未提交的预览失效，用户需重新抓取。
- **不做内容审查**：恶意或低质技能正文不经模型或规则筛查，风险由预览环节的用户判断承担。
- **`custom` 根默认只读**：避免界面写入部署方用 `customSkillDirs` 指向的非技能目录。
