---
description: "Web 设置中的技能分区，供在图形界面上查看磁盘技能、新建与删除技能的用户阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-skills

## 概述

本包给 Web 客户端加上「设置 → 技能」页：列出每个被扫描的根目录及其中的技能条目，并就地新建或删除条目。在此之前，新增一个技能只能手工在磁盘上创建 `<name>/SKILL.md` 并手写 frontmatter，图形界面没有任何入口。分区自己不持有任何 Host 事实——根、条目、遮蔽关系与可写性全部来自 `skillAdmin` Remote。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备忘](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

与 Host 侧管理包一起组合；本包注入 `remote.skillAdmin`，缺了它注册即失败。

它是设置分区列表中的一项，`settings.section` 的 `id` 为 `skills`、`order` 为 17，因此排在「插件」之后、「MCP 服务器」之前。导航文案由本包自己的字典提供，外壳不含任何自带文案。

### 界面提供什么

- **三个作用域页签。** 全局（`~/.agents/skills`）、应用（`~/.dsh/skills`）与工作区（当前工作区里的 `.dsh/skills` 与 `.agents/skills`）。`custom` 与 `bundled` 根不进入任何页签。工作区页签内再选工作区：技能发现对 cwd 敏感，而设置面板不属于任何会话，猜一个 cwd 会把技能写到用户没预期的位置。
- **两行的技能列表。** 第一行左侧是名称与状态标记，右侧是编辑、删除与启用开关；第二行是描述，默认最多三行，超出时可展开与收起，悬停时以提示气泡显示全文。被遮蔽与无法加载的条目仍然显示，因为发现器会静默丢弃它们，界面是唯一能看见它们的地方。
- **启用开关。** 禁用把条目移进**它自己那个根**下的 `.disabled/`，启用移回。每个根各有自己的停放目录，所以位置本身就决定了作用域：`~/.agents/skills/.disabled/` 属于全局，`~/.dsh/skills/.disabled/` 属于应用，工作区两个根下的属于工作区——不存在一个共享的停放目录，也就没有「停放后如何区分作用域」的问题。已停用的条目仍留在它所属的作用域页签里并带已禁用标记，否则用户就没有恢复入口。
- **共享目录提醒。** 两个 `.agents` 根（用户级与项目级）与其他 agent 工具共享，界面在这两处说明改动会影响它们。
- **编辑弹窗。** 左侧文件树列出条目拥有的全部文件，右侧带语法高亮的编辑区。SKILL.md 的 frontmatter 契约由 Host 在写入时把关，界面不重复实现。
- **导入弹窗。** 两个页签，默认停在上传：上传本地的 zip / tar 文件，或从 URL（GitHub 位置或压缩包直链）导入。写入目标根可选，且只列当前作用域内的可写根。底部固定三个动作——取消、预览、保存。点「预览」在表单之上叠加一个只读弹窗：左侧是压缩包内全部文件的树，右侧是当前文件的带高亮内容，与编辑弹窗同构，差别只是没有任何编辑入口——落盘的就是压缩包里的字节。关闭预览回到表单，已填的来源与目标根都还在。点「保存」则跳过预览，解析并直接落库；若目标目录已存在，保存就地报错并保留表单，不发起写入。
- **删除确认。** 二次确认并显示将删除的确切路径。

只读根（`bundled`）上的行不提供启用开关、编辑与删除入口。

### 可观察的成功与失败

读取失败显示重试入口；写入失败就地报告 Remote 的失败码与消息。写入成功后分区重新读取快照，因此界面在监视器刷新前就已反映自己的写入。

二进制文件与超过体积上限的文件在编辑区里只展示、不可编辑，并说明原因。切换作用域页签不重新请求——一次快照足以覆盖三个页签，只有工作区选择变化才会重新读取。切换页签或工作区会关闭已打开的弹窗，因为它承载的条目属于上一个选择。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计理念

分区是纯展示层，没有自己的 host 状态：所有事实经注入面从 `skillAdmin` Remote 取回，组件只保留表单草稿、当前视图状态与待确认的删除目标。这与 Web 客户端的「业务数据在对象层」约定一致——入口声明的 store 只承载共享的查看状态，而这里连共享状态都不存在，因为分区在任意时刻只有一个实例。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | 分区注册、注入面、字典注册 |
| [`src/client/scope.ts`](src/client/scope.ts) | 发现来源到三个页签的映射 |
| [`src/client/SkillsSection.tsx`](src/client/SkillsSection.tsx) | 页签、工具栏与弹窗编排 |
| [`src/client/SkillsList.tsx`](src/client/SkillsList.tsx) | 技能列表、描述展开与启用开关 |
| [`src/client/SkillEditorDialog.tsx`](src/client/SkillEditorDialog.tsx) | 编辑弹窗 |
| [`src/client/SkillFileTree.tsx`](src/client/SkillFileTree.tsx) | 文件树 |
| [`src/client/SkillFileEditor.tsx`](src/client/SkillFileEditor.tsx) | 高亮编辑区 |
| [`src/client/ImportSkillDialog.tsx`](src/client/ImportSkillDialog.tsx) | 导入表单与两个底部动作 |
| [`src/client/SkillImportPreviewDialog.tsx`](src/client/SkillImportPreviewDialog.tsx) | 只读的导入预览弹窗 |
| [`src/client/locales.ts`](src/client/locales.ts) | 简体中文字典与 key 真源 |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴生插件 |

### 数据流

`apply` 闭包持有 `ctx.remote`，把九个调用包成注入面交给组件。组件在挂载、切换工作区与每次写入成功后取一次快照。工作区列表来自渲染器绑定的 `useWorkspaces`，不额外订阅。

编辑区是透明 textarea 叠加 shiki 高亮层：两层共用字体、行高与内边距，滚动由 textarea 同步到底层，textarea 关掉软换行以保证两层行数一致。语法提示直接取文件扩展名——`ui-primitives` 高亮器的别名表本身就是按扩展名索引的，不需要第二份映射。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [设置子系统参考](../../../docs/subsystems/settings.zh.md)——分区的注册约定与 settings 服务。
- [skill 子系统参考](../../../docs/subsystems/skills.zh.md)——本分区所管理的技能词汇。
- [Host 侧管理包](../../host/skill-manager/README.zh.md)——本包消费的 Remote 契约。
- [Web 客户端架构](../../../docs/subsystems/web-client.zh.md)——插槽、注入面与模块图约定。

-----

<a id="model-experience"></a>
## 模型体验

不直接影响模型。通过 Host 侧管理包的写入间接到达：新建或改写的技能文件由发现器的监视器捕获，在下一个模型步骤进入会话目录或触发替换目录。

#### KV Cache 影响

不直接影响。目录替换由 `dsh-tool-skill` 负责，本包不产生任何模型可见文本。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **导入的写入必须经过一次解析**——写入只接受预览身份，而身份只能由解析来源或解包上传字节产生，因此「保存」是解析与写入的连做，界面不展示中间产物。解析结果在写入、过期或切换页签后失效。
- **导入不覆盖既有条目**——目标已存在时提交被拒绝，界面据此禁用写入按钮；先删除再导入。
- **编辑器不做二进制编辑**——图片等资源在文件树里列出，在编辑区里只读，替换它们要回到文件系统。
- **文件树是只读结构**——可以浏览并编辑已有文件，但新建、删除与重命名文件不在界面内。
- **文件树不列出隐藏文件**——`.` 开头的文件与目录（`.gitignore`、`.git` 等）不作为技能内容列出，也不参与遍历。
- **项目级技能需先选工作区**——未选择时项目根不出现，这是刻意的：设置面板没有会话，猜测 cwd 会把技能写到用户没预期的位置。
- **页签只覆盖三个作用域**——`custom` 与 `bundled` 根里的技能在这页看不到。

<a id="dev-note"></a>
### 开发备忘

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备忘是维护者的工作上下文，明确不具权威性——已交付的行为与限制以上文和代码为准。编辑弹窗在一个组件里同时持有文件树与文档两种状态机，文件数继续增长时值得拆成两个独立的加载单元。
</details>
