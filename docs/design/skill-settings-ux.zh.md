# 技能设置页体验优化设计

## 背景与目标

「设置 → 技能」已经能读写磁盘上的技能，但整页把工作区选择、新建表单、导入面板与按根分组的条目列表平铺在一起：新建表单常驻占据首屏，条目行把名称、描述与四类标记挤在一行，根路径与 rank 泄漏到用户视野。本设计重做这一页的信息架构与交互，并补齐三项尚缺的能力：启用开关、多文件编辑、压缩包上传。

既有实现见 [技能管理插件设计](skill-management-plugin.zh.md)；本设计只描述改变的部分，未提及的决策沿用该文档。

## 现状约束

技能发现器 `dsh-skill-filesystem` 只扫描一个根目录的**直接子项**：目录且含 `SKILL.md` 记为目录包，`.md` 文件记为扁平技能。它不递归，也不理解任何"禁用"概念。管理面 `dsh-host-skill-manager` 复刻同一套扫描规则，并额外跳过 `.` 开头的条目。

因此根目录下的 `.x` 子目录既不在发现面内，也不在管理面内——这一点是下面 D2 的全部依据。

## 决策

### D1 作用域三分类在客户端按 `source` 映射

三个子 TAB 与发现来源的对应关系：

| TAB | `source` | 绝对路径 |
|---|---|---|
| 全局 | `user-agents` | `<agentsHome>/skills` |
| 应用 | `user-dsh` | `<dshHome>/skills` |
| 工作区 | `project-dsh`、`project-agents` | `<projectRoot>/.dsh/skills`、`<projectRoot>/.agents/skills` |

`custom`（部署方用 `customSkillDirs` 声明的根）与 `bundled`（随部署交付、只读）不进入任何 TAB。

映射写在客户端而不是让 Host 新增一个 `scope` 字段：`source` 已经是发现器的稳定契约，"这三个来源归到哪一屏"是呈现决策，把它写进 wire 词汇会让 Host 承担一份它不拥有的知识。

### D2 启用状态用 `<root>/.disabled/` 目录承载

禁用把条目移入同根的 `.disabled/` 子目录，启用移回：

| 形态 | 启用时 | 禁用时 |
|---|---|---|
| 目录包 | `<root>/<name>/SKILL.md` | `<root>/.disabled/<name>/SKILL.md` |
| 扁平 | `<root>/<name>.md` | `<root>/.disabled/<name>.md` |

理由：

- 发现器扫不到 `.disabled/SKILL.md`，也扫不到 `.disabled/<name>.md`（它只解析根的一层直接子项），所以禁用即刻从模型目录与 `/` 命令目录消失；
- 同根内 `rename` 是原子的，技能文件一个字节都不改，恢复即回到原位；
- 不需要新的 frontmatter 键，技能契约（`name`、`description`、`whenToUse`、`disable-model-invocation`、`user-invocable`）保持不变；
- 移动本身触发 watcher：原路径的 `unlinkDir`（禁用）与新路径的 `addDir`（启用）都在 `depth: 1` 的观察面内，缓存失效无需额外通道。

被否决的方案与原因：

- **技能目录内放标记文件**（如 `<name>/.disabled`）：扁平技能没有自己的目录，两种形态无法对等表达；且每个技能每次发现都多一次 stat。
- **frontmatter 新增 `enabled` 键**：要求 `dsh-skill` 与 `dsh-skill-filesystem` 同时认这个键，而键会随技能文件被复制、被导入、被分享，语义脱离这台部署。
- **禁用清单写进 DSH 配置**：技能文件不动，但状态脱离技能本体，换机器或重装即丢失，而技能本身是随目录走的。

### D3 发现器显式跳过 `.disabled`

当前扫描逻辑恰好扫不到 `.disabled` 下的内容，但那是"它下面没有 `SKILL.md`"的巧合。显式跳过把「禁用目录永不被发现」写成发现器的契约，顺带省掉每个根每次发现的一次多余 stat。

### D4 管理面把 `.disabled` 里的条目列为 `enabled: false` 并留在列表里

禁用后条目从列表消失，用户就没有恢复入口。管理面因此额外扫描 `.disabled/`，把这些条目标记为已禁用并排在同一张表里；表格用状态列区分，开关可直接切回。

`SkillAdminEntry` 增加 `enabled: boolean`。`entryId` 仍是条目的绝对路径，所以条目在启用与禁用之间移动时身份会变化——调用方在每次写操作后重新取快照，不缓存 `entryId`。

### D5 文件树与文件读写是独立的一组 Remote 方法

现有 `read` 服务的是「SKILL.md 的 frontmatter 表单」路径，返回解析后的字段；编辑器要的是目录内任意文件的原文。两者语义不同，不合并。

新增：

| 方法 | 职责 |
|---|---|
| `listFiles` | 一个条目目录内的全部文件（相对路径、字节数、是否可编辑） |
| `readFile` | 一个文件的文本内容与语言提示 |
| `writeFile` | 写入一个文件的文本 |

约束：

- 每次解析后的绝对路径都必须落在条目目录内，否则拒绝——这是不可信输入的最后一道边界；
- 文件数与递归深度设上限，避免异常目录把一次读取变成无界遍历；
- 单文件体积设上限，超限标记为只读而不是截断后写入；
- 内容含 NUL 字节的成员判为二进制，只读展示；
- 写入目标为 `SKILL.md` 时先校验 frontmatter（`name` 为 kebab-case 且 `description` 非空），不合法即拒绝——发现器会静默丢弃不合法条目，界面不能把用户的技能写成一个模型永远看不到的文件。

### D6 编辑器是透明 textarea 叠加高亮层

编辑区用两层：底层 `<pre>` 渲染 `highlightLines` 的逐行 span，上层 `<textarea>` 文字透明、光标可见，两层共用字体、行高与内边距，滚动位置由 textarea 同步到底层。

选这个方案而非引入编辑器依赖：`ui-primitives` 已经持有唯一的语法高亮器，`highlightLines` 正好输出逐行 span；`LANG_ALIASES` 的键本身就是文件扩展名，所以语言提示可以直接取扩展名，不需要第二份映射表。textarea 用 `wrap="off"`，避免软换行让两层的行对不齐。

### D7 上传与 URL 导入共用同一套解包校验

URL 导入已经有一条完整的解包与校验链（压缩格式探测、路径穿越拒绝、符号链接拒绝、条目与体积上限）。上传不能另起一条：预览承诺的文件清单必须就是落盘的文件清单。

`import/source.ts` 拆成两段：把「下载」与「解包内存字节」分开，上传路径把浏览器传来的字节直接交给同一段解包。

字节经 base64 承载，沿用 `dsh-attachment` 的规范 base64 准入先例（非规范编码即拒绝）。上传文件本身的体积上限独立于解包上限，因为 base64 会放大约三分之一。

### D8 列表页只做展示，写入都进弹窗

页面结构收敛为：

- 顶部一行：作用域 TAB、工作区选择器（仅工作区 TAB）、「导入技能」按钮；
- 中部：技能表格，列为名称、描述、状态、启用开关、编辑、删除；
- 弹窗：编辑（文件树 + 编辑区）、导入（URL / 上传两个页签）、删除确认。

新建表单从页面移除。手写 frontmatter 创建技能不再是界面路径；`skillAdmin.create` 保留在 Remote 面上，因为它仍是导入之外唯一的程序化写入入口，删掉它会让 GUI 之外的调用方没有落点。

## 组件

### Host：`packages/host/skill-manager`

| 变化 | 位置 |
|---|---|
| `SkillAdminEntry.enabled`、`SkillFileNode`、`SkillFileDocument` 等 wire 词汇 | `src/types.ts` |
| `.disabled` 扫描、`setEnabled`、`listFiles`/`readFile`/`writeFile` | `src/index.ts` |
| 解包与下载拆分、上传入口 | `src/import/source.ts` |

### Host：`packages/skill/skill-filesystem`

`discoverRoot` 显式跳过 `.disabled` 目录。

### Client：`packages/client/ui-settings-skills`

| 文件 | 职责 |
|---|---|
| `SkillsSection.tsx` | TAB、工具栏、快照装载、弹窗编排 |
| `ScopeTabs.tsx` | 作用域 TAB 与工作区选择器 |
| `SkillsTable.tsx` | 表格、启用开关、编辑与删除入口 |
| `SkillEditorDialog.tsx` | 文件树 + 编辑区 |
| `SkillFileTree.tsx` | 文件树 |
| `SkillFileEditor.tsx` | 高亮编辑区 |
| `ImportSkillDialog.tsx` | URL 与上传两个页签 |
| `scope.ts` | `source` 到 TAB 的映射（纯函数） |

## 测试

- host 单元：`.disabled` 扫描与条目分类、`setEnabled` 的移动与冲突拒绝、文件路径逃逸拒绝、体积与数量上限、二进制判定、`SKILL.md` 写入的 frontmatter 校验、上传字节的解包校验。
- host 集成：禁用后条目不再出现在 `ctx.skills` 的目录中，启用后重新出现——这条覆盖"移动真的让发现器改变结论"。
- client 组件：TAB 切换与 `source` 映射、表格渲染、启用开关、编辑弹窗的文件树与保存、导入弹窗两个页签的状态机、删除确认。
- 该页面是产品可见面，需要 GUI 截图或 GIF 证据。

## 已知取舍

- **禁用依赖目录约定**——第三方工具若不认识 `.disabled`，会把它当成一个普通目录；它不会被发现器读作技能，但也不会被别的工具自动跳过。
- **条目身份随移动变化**——`entryId` 是绝对路径，切换启用状态后同一条技能的身份串不同，调用方不能跨写操作缓存它。
- **编辑器不做二进制编辑**——图片等资源只列出、只读，替换它们仍要回到文件系统。
- **上传体积受通道限制**——base64 走 Remote 的 JSON 载荷，上限按部署设；更大的包应走 URL 导入。
- **不展示的两类根没有界面**——`custom` 根与 `bundled` 根里的技能在这页看不到，需要时按来源另开入口。
