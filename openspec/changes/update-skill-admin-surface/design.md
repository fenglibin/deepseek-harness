# 技术决策

完整设计见 [docs/design/skill-settings-ux.zh.md](../../../docs/design/skill-settings-ux.zh.md)。这里记录每项决策与取舍。

### D1 作用域三分类在客户端按 source 映射

三个 TAB 对应 `user-agents`（全局）、`user-dsh`（应用）、`project-dsh` + `project-agents`（工作区）；`custom` 与 `bundled` 不进入任何 TAB。

映射不写进 wire 词汇，因为 `source` 已经是发现器的稳定契约，"这三个来源归到哪一屏"是呈现决策。让 Host 新增 `scope` 字段会让它承担一份它不拥有的知识，而且每当界面想调整分组都要改 Host。

### D2 启用状态用同根的 `.disabled/` 目录承载

禁用把 `<root>/<name>/` 或 `<root>/<name>.md` 整体移入 `<root>/.disabled/`，启用移回。

发现器 `discoverRoot` 只解析根的一层直接子项：目录项要求 `<dir>/SKILL.md` 存在，文件项要求 `.md` 结尾。`.disabled/` 下既没有 `<root>/.disabled/SKILL.md`，其成员也不是根的直接子项，因此禁用即刻从模型目录与用户命令目录消失。

同根内 `rename` 是原子的，技能文件零改动，恢复即回到原位。移动触发 watcher：禁用产生原路径 `unlinkDir`，启用产生新路径 `addDir`，两者都在 `depth: 1` 的观察面内，缓存失效不需要额外通道。

被否决的方案：

- 技能目录内标记文件（`<name>/.disabled`）：扁平技能没有自己的目录，两种形态无法对等表达；每个技能每次发现多一次 stat。
- frontmatter 新增 `enabled` 键：要求 `dsh-skill` 与 `dsh-skill-filesystem` 同时认这个键，且键随技能文件被复制、导入、分享，语义脱离这台部署。
- 禁用清单写进 DSH 配置：技能文件不动，但状态脱离技能本体，换机器或重装即丢失。

### D3 发现器显式跳过 `.disabled`

当前扫描恰好扫不到 `.disabled` 下的内容，但那是"它下面没有 SKILL.md"的巧合。显式跳过把「禁用目录永不被发现」写成契约，并省掉每个根每次发现的一次多余 stat。

### D4 管理面把禁用条目列为 `enabled: false` 并保留在列表

禁用后条目从列表消失，用户就没有恢复入口。管理面额外扫描 `.disabled/`，把这些条目标记后排在同一张表里，开关可直接切回。

`SkillAdminEntry` 增加 `enabled: boolean`。`entryId` 仍是绝对路径，所以条目移动时身份变化；调用方在每次写操作后重新取快照，不缓存它。

### D5 文件树与文件读写是独立的一组 Remote 方法

现有 `read` 返回解析后的 frontmatter 字段，服务的是表单路径；编辑器要的是目录内任意文件的原文。两者语义不同，不合并。

新增 `listFiles`、`readFile`、`writeFile`，约束：

- 解析后的绝对路径必须落在条目目录内，否则拒绝；
- 文件数与递归深度设上限，避免异常目录把读取变成无界遍历；
- 单文件体积设上限，超限标记只读而非截断后写入；
- 内容含 NUL 字节判为二进制，只读展示；
- 写入目标为 `SKILL.md` 时先校验 frontmatter（`name` 为 kebab-case 且 `description` 非空）。发现器会静默丢弃不合法条目，界面不能把用户的技能写成一个模型永远看不到的文件。

### D6 编辑器是透明 textarea 叠加高亮层

底层 `<pre>` 渲染 `highlightLines` 的逐行 span，上层 `<textarea>` 文字透明、光标可见；两层共用字体、行高与内边距，滚动位置由 textarea 同步到底层。textarea 用 `wrap="off"`，避免软换行让两层行对不齐。

不引入编辑器依赖：`ui-primitives` 已持有唯一的语法高亮器，`highlightLines` 正好输出逐行 span；`LANG_ALIASES` 的键本身就是文件扩展名，语言提示可直接取扩展名，不需要第二份映射表。

### D7 上传与 URL 导入共用同一套解包校验

URL 导入已有完整解包链（格式探测、路径穿越拒绝、符号链接拒绝、条目与体积上限）。上传不能另起一条：预览承诺的文件清单必须就是落盘清单。

把 `import/source.ts` 的「下载」与「解包内存字节」拆开，上传路径把浏览器传来的字节直接交给同一段解包。字节经规范 base64 承载，沿用 `dsh-attachment` 的准入先例（非规范编码即拒绝）。上传文件体积上限独立于解包上限，因为 base64 会放大约三分之一。

### D8 列表页只做展示，写入都进弹窗

页面结构：顶部一行放作用域 TAB、工作区选择器（仅工作区 TAB）与「导入技能」按钮；中部是名称/描述/状态/启用/编辑/删除的表格；弹窗承载编辑、导入与删除确认。

新建表单从页面移除。`skillAdmin.create` 保留在 Remote 面上，因为它仍是导入之外唯一的程序化写入入口，删掉它会让 GUI 之外的调用方没有落点。