# file-browser 规格增量

## ADDED Requirements

### Requirement: 内容区的预览类型由扩展名决定

文件浏览器的内容区 SHALL 仅当一个文本文件的扩展名为 `.md`、`.markdown`、`.html` 或 `.htm` 时提供预览能力；其余文件 SHALL NOT 渲染预览控件。

#### Scenario: 打开 Markdown 文件
- **WHEN** 内容区展示一个 `.md` 或 `.markdown` 文件
- **THEN** 工具栏提供预览控件

#### Scenario: 打开 HTML 文件
- **WHEN** 内容区展示一个 `.html` 或 `.htm` 文件
- **THEN** 工具栏提供预览控件

#### Scenario: 打开其它文本文件
- **WHEN** 内容区展示一个扩展名既不是 Markdown 也不是 HTML 的文本文件
- **THEN** 工具栏不提供预览控件

### Requirement: 预览是内容区的切换视图

内容区 SHALL 在勾选预览时以渲染结果取代源码编辑器，并在取消勾选时回到编辑器。两种视图 SHALL 共享同一份缓冲区：勾选期间不可编辑，取消勾选后此前的未保存修改 SHALL 仍然存在。

#### Scenario: 勾选预览
- **WHEN** 用户在可预览文件上勾选预览
- **THEN** 内容区显示渲染结果而不是源码编辑器

#### Scenario: 取消勾选预览
- **WHEN** 用户在预览态取消勾选
- **THEN** 内容区回到源码编辑器
- **AND** 勾选前未保存的修改仍在编辑器中

#### Scenario: 预览呈现未保存的修改
- **WHEN** 缓冲区有未保存的修改且用户勾选预览
- **THEN** 渲染结果反映的是修改后的缓冲区

### Requirement: Markdown 预览支持完整语法

Markdown 预览 SHALL 经本仓既有的 Markdown 渲染管线渲染，并 SHALL 支持 GFM 表格、任务列表、删除线、KaTeX 数学与 mermaid 流程图。

#### Scenario: 渲染表格
- **WHEN** 预览的 Markdown 含有 GFM 表格
- **THEN** 内容区渲染出表格而不是管道符文本

#### Scenario: 渲染流程图
- **WHEN** 预览的 Markdown 含有 ```mermaid 代码块
- **THEN** 内容区渲染出流程图

### Requirement: HTML 预览在隔离源中运行脚本

HTML 预览 SHALL 在一个不给同源权限的内联框架中渲染当前缓冲区，使页面脚本可以运行，而该文档 SHALL NOT 能访问宿主页面的存储、Cookie 与同源接口。

#### Scenario: 预览带脚本的 HTML
- **WHEN** 用户预览一个依赖脚本渲染内容的 HTML 文件
- **THEN** 内容区显示渲染后的页面

#### Scenario: 预览文档的源
- **WHEN** 预览的 HTML 尝试访问宿主源的数据
- **THEN** 该访问被拒绝，宿主页面的存储与同源接口不可达

### Requirement: 搜索框与内容区动作的尺寸与相邻文字一致

浏览器形态工具栏的搜索框 SHALL 使用与文件树行同级的字号，且 SHALL 比共享输入原子的默认高度矮。内容区工具栏的动作按钮 SHALL 使用与紧邻的保存状态文字相同的字号。

#### Scenario: 工具栏的搜索框
- **WHEN** 用户打开文件浏览器
- **THEN** 搜索框的高度低于共享输入原子的默认高度
- **AND** 其字号与文件树行的字号一致

#### Scenario: 内容区的保存动作
- **WHEN** 内容区展示一个可编辑的文本文件
- **THEN** 「重新加载」与「保存」的字号与「已保存」一致

## MODIFIED Requirements

### Requirement: 会话文件链接在 Web 端只读查看

会话页面上展示的文件链接被点击时，客户端 SHALL 在 Web 端的文件浏览器对话框内以只读方式呈现该文件内容，而不是调用 Host 桌面打开器。该行为在 Host 无桌面环境、以及浏览器与 Host 不同机时同样成立。只读形态 SHALL 复用与浏览器形态相同的内容区实现，因此同一个 Markdown 或 HTML 文件在两个入口下 SHALL 提供相同的预览能力。

#### Scenario: 点击会话中的文件链接
- **WHEN** 用户点击会话页面里某个已编辑或新增文件的链接
- **THEN** 客户端打开文件浏览器对话框
- **AND** 对话框直接呈现该文件的内容
- **AND** 内容区处于只读态，不提供保存、覆盖与重载动作

#### Scenario: 云端部署下查看文件
- **WHEN** 部署在无桌面环境的 Host 上，用户点击会话中的文件链接
- **THEN** 文件内容仍在浏览器中呈现
- **AND** 该过程不依赖 Host 的桌面打开器

#### Scenario: 只读形态预览 Markdown 或 HTML
- **WHEN** 一个 `.md`、`.markdown`、`.html` 或 `.htm` 文件经会话文件链接打开
- **THEN** 只读形态同样提供预览控件
- **AND** 勾选后渲染结果与浏览器形态下一致
