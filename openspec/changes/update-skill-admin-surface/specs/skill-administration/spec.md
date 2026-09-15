# 技能管理面

## ADDED Requirements

### Requirement: 作用域分栏

技能设置页 SHALL 以三个子 TAB 分隔技能作用域：全局（`user-agents` 根）、应用（`user-dsh` 根）与工作区（`project-dsh` 与 `project-agents` 根）。`custom` 与 `bundled` 根 SHALL 不出现在任何 TAB 中。

#### Scenario: 按来源归入 TAB
- **WHEN** 快照包含来自 `user-agents`、`user-dsh`、`project-dsh` 与 `bundled` 的条目
- **THEN** 全局 TAB 只列出 `user-agents` 条目，应用 TAB 只列出 `user-dsh` 条目，工作区 TAB 只列出 `project-dsh` 条目，`bundled` 条目不出现在任何 TAB

#### Scenario: 切换 TAB 不重新请求
- **WHEN** 用户在同一快照内切换子 TAB
- **THEN** 页面就地重新分组，不发起新的 Remote 读取

### Requirement: 工作区选择

工作区 TAB SHALL 提供工作区选择器；未选择工作区时该 TAB SHALL 提示先选择工作区，且 SHALL NOT 猜测工作目录。

#### Scenario: 选择工作区后展示项目技能
- **WHEN** 用户在已知工作区列表中选中一项
- **THEN** 页面以该工作区路径重新读取快照，并列出其项目级根下的条目

#### Scenario: 切换工作区时关闭已开弹窗
- **WHEN** 用户在一个工作区下打开了编辑或导入弹窗，随后切换工作区
- **THEN** 该弹窗关闭，因为它承载的条目属于上一个工作区

### Requirement: 技能表格

列表页 SHALL 以表格展示当前作用域的技能，每行 SHALL 包含名称、描述、状态标记、启用开关、编辑入口与删除入口，且 SHALL NOT 展示根路径或 rank 等发现器内部字段。

#### Scenario: 渲染一行技能
- **WHEN** 快照中的条目同时具有描述、被遮蔽标记与非法原因
- **THEN** 该行显示名称与描述，并用独立标记呈现被遮蔽与无法加载状态

#### Scenario: 只读根上的行
- **WHEN** 条目所属根拒绝写入
- **THEN** 该行不提供启用开关、编辑与删除入口

### Requirement: 切换启用状态

管理面 SHALL 提供 `setEnabled`，把条目在同根的启用位置与 `.disabled/` 子目录之间移动；目标位置已被占用时 SHALL 拒绝并报告冲突。

#### Scenario: 禁用条目
- **WHEN** 对一个目录包条目发起禁用
- **THEN** 整个包目录被移动到 `<root>/.disabled/<name>/`，条目内容不变

#### Scenario: 启用条目
- **WHEN** 对一个位于 `.disabled/` 下的条目发起启用
- **THEN** 该条目回到 `<root>/<name>/` 或 `<root>/<name>.md`

#### Scenario: 目标已占用
- **WHEN** 启用时 `<root>/<name>` 已被同名的启用条目占用
- **THEN** 操作被拒绝，两个条目都不被改动

#### Scenario: 只读根拒绝切换
- **WHEN** 对只读根下的条目发起切换
- **THEN** 操作被拒绝并报告该根不可写

### Requirement: 禁用把条目移出发现面

禁用 SHALL 让条目不再出现在技能注册表与用户命令目录中；启用 SHALL 让它重新出现。

#### Scenario: 禁用后模型看不到
- **WHEN** 一个条目被禁用
- **THEN** 该技能不再出现在 `ctx.skills` 的目录中，也不再出现在 `/` 命令补全里

#### Scenario: 启用后重新可见
- **WHEN** 该条目被重新启用
- **THEN** 该技能重新出现在 `ctx.skills` 的目录中

### Requirement: 禁用目录不被发现

技能发现器 SHALL 跳过根目录下名为 `.disabled` 的条目，不把它或其内容解析为技能。

#### Scenario: 禁用目录中的技能文件
- **WHEN** 根目录下存在 `.disabled/demo/SKILL.md`
- **THEN** 发现器既不把 `demo` 列为技能，也不把 `.disabled` 列为技能

### Requirement: 禁用条目仍留在列表中

管理面 SHALL 扫描 `.disabled/` 并把其中条目标记为已禁用；这些条目 SHALL 与启用条目一起出现在同一张表格中。

#### Scenario: 禁用条目可被恢复
- **WHEN** 一个条目处于禁用状态
- **THEN** 它仍出现在所属作用域的表格里，带已禁用标记，且开关可以切回启用

### Requirement: 浏览与编辑技能文件

管理面 SHALL 提供 `listFiles`、`readFile` 与 `writeFile`，覆盖条目目录内的全部文件。每个请求解析后的绝对路径 SHALL 落在该条目目录内，否则 SHALL 拒绝。

#### Scenario: 列出条目目录内的文件
- **WHEN** 读取一个含 `SKILL.md`、`references/a.md` 与 `scripts/run.py` 的目录包
- **THEN** 三个文件都以相对路径列出，并各自带字节数

#### Scenario: 路径逃逸被拒绝
- **WHEN** 请求的相对路径解析后落在条目目录之外
- **THEN** 操作被拒绝且不触碰文件系统

#### Scenario: 保存文件
- **WHEN** 用户在一个文件里修改内容并保存
- **THEN** 该文件的文本被替换，其他文件不受影响

### Requirement: 只读文件的呈现

超出体积上限或内容含 NUL 字节的文件 SHALL 被标记为只读并只作展示，界面 SHALL NOT 允许保存它们。

#### Scenario: 二进制资源
- **WHEN** 条目目录内有一个图片文件
- **THEN** 文件树列出它，编辑区显示为不可编辑

#### Scenario: 超限文件
- **WHEN** 一个文件超过单文件体积上限
- **THEN** 界面报告内容被截断且不允许保存

### Requirement: 非法改写被拒绝

写入名为 `SKILL.md` 的文件时，管理面 SHALL 先校验 frontmatter 含 kebab-case 的 `name` 与非空 `description`，不合法时 SHALL 拒绝写入。

#### Scenario: 缺描述
- **WHEN** 用户保存的 `SKILL.md` 删掉了 `description`
- **THEN** 保存被拒绝，磁盘上的文件保持原样

### Requirement: 删除需二次确认

删除入口 SHALL 先弹出确认对话框并展示将删除的确切路径，确认后才执行删除。

#### Scenario: 取消删除
- **WHEN** 用户在确认对话框中选择取消
- **THEN** 条目保持不变

#### Scenario: 确认删除目录包
- **WHEN** 用户确认删除一个目录包
- **THEN** 该包连同其全部文件被删除

### Requirement: 导入弹窗

列表页 SHALL 在工具栏提供「导入技能」入口，打开一个含 URL 与上传两个页签的弹窗；弹窗 SHALL 允许选择写入的目标根，并 SHALL 在写入前展示预览。

#### Scenario: URL 导入
- **WHEN** 用户在 URL 页签填入一个来源并请求预览
- **THEN** 弹窗展示将写入的文件清单、目标路径与 SKILL.md 正文，确认后才落盘

#### Scenario: 目标根可选
- **WHEN** 弹窗打开时
- **THEN** 目标根默认预选当前作用域对应的根，且用户可以改选其他可写根

### Requirement: 上传压缩包导入

上传页签 SHALL 接受 zip、tar 与 tar.gz 文件，并 SHALL 让上传的字节与 URL 导入走同一套解包校验。

#### Scenario: 上传合法压缩包
- **WHEN** 用户选择含 SKILL.md 的 zip 文件
- **THEN** 预览列出解包后的文件清单，且落盘的文件与清单一致

#### Scenario: 上传被拒绝的压缩包
- **WHEN** 上传的包含路径穿越成员或非普通文件条目
- **THEN** 预览被拒绝，不写入任何文件

#### Scenario: 超出上传上限
- **WHEN** 选择的文件超过上传体积上限
- **THEN** 界面报告超限并建议改用 URL 导入

### Requirement: 页面不再平铺写入表单

进入技能设置页 SHALL 只展示已有技能的表格与工具栏；新建表单 SHALL 从页面上移除。

#### Scenario: 进入页面
- **WHEN** 用户打开「设置 → 技能」
- **THEN** 首屏是作用域 TAB、工作区选择器（仅工作区 TAB）、「导入技能」按钮与技能表格

### Requirement: 界面文案本地化

本分区 SHALL NOT 硬编码用户可见文案；全部文本 SHALL 经类型化字典路由。

#### Scenario: 文案来自字典
- **WHEN** 渲染列表、弹窗与确认对话框
- **THEN** 每一处文本都由字典 key 提供