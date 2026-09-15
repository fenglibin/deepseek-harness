---
description: "技能文件系统真相的管理面，供需要列出、新建、改写或删除磁盘上 skill 的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-skill-manager

## 概述

发现注册表回答的是「哪个 skill 对这个 agent 胜出」，本包回答的是「磁盘上有什么」。这两组事实不同：注册表返回去重后的胜出摘要，不含路径与 rank，并会静默跳过 frontmatter 非法的文件；管理界面三项都需要——重名技能要能看出谁遮蔽了谁，改写与删除要拿到绝对路径，非法文件要能被指出。写入的目标根由 `ctx.skillRoots` 提供，因此在这里创建的 skill 就是下一次发现会读到的 skill。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

与本地技能提供方一起挂载：本包注入 `skillRoots`，缺了它启动即失败。

```yaml
- name: '@deepseek-ai/dsh-skill'
- name: '@deepseek-ai/dsh-skill-filesystem'
- name: '@deepseek-ai/dsh-host-skill-manager'
```

它通过 Typert Remote 把命名空间 `skillAdmin` 暴露给浏览器面。

| 方法 | 作用 |
|---|---|
| `list` | 一个工作区的管理视图：每个被扫描的根及其条目，含被遮蔽项、不可用项与已停放项 |
| `read` | 一个条目的完整文件文本与其解析出的 frontmatter 字段 |
| `create` | 在指定根下新建条目 |
| `update` | 改写条目的 frontmatter 字段与正文 |
| `delete` | 删除条目；目录包连同其内容一并删除 |
| `setEnabled` | 在同根内把一个条目移入或移出 `.disabled/` |
| `listFiles` | 一个条目拥有的全部文件及其字节数 |
| `readFile` | 一个条目内单个文件的文本，或它为何不可编辑 |
| `writeFile` | 替换一个条目内单个文件的文本 |
| `previewImport` | 抓取并解包一个来源，返回将写入的文件清单而不落盘 |
| `previewUpload` | 解包一份上传的压缩包字节，返回同一形状的预览 |
| `readPreviewFile` | 读取一份暂存预览里的单个文件，供读者在批准前查看 |
| `commitImport` | 写入一份已批准的预览 |

导入是三段式的：`previewImport` 或 `previewUpload` 解包并暂存，`readPreviewFile` 供读者逐个查看暂存内容，`commitImport` 才落盘。读取不消耗预览——只有提交会——因此逐个查看文件永远不会被当成批准。暂存有数量上限与存活时限，过期或已提交的标识一律以 `skill-admin/import-expired` 拒绝。

### 启用与禁用

发现器只解析根的一层直接子项，因此把条目移进同根的 `.disabled/` 就足以让它从模型目录与 `/` 命令目录消失。`setEnabled` 做这次移动：目录包移动整个 `<name>/`，扁平技能移动 `<name>.md`，技能文件本身一个字节都不改，恢复即回到原位。移动也触发 watcher 的 `unlinkDir` 与 `addDir`，模型侧缓存因此自行失效，不需要额外通道。

`list` 同时返回 `.disabled/` 里的条目并把它们标为 `enabled: false`：禁用后条目若从列表消失，调用方就没有恢复入口。已停放的条目不参与遮蔽计算——它此刻不在被扫描的集合里，因此既不遮蔽同名技能，也不被遮蔽。

### 文件浏览与编辑

`listFiles`、`readFile` 与 `writeFile` 覆盖一个条目拥有的文件。目录包的文件根是它自己的目录；扁平技能与同级技能共享根目录，因此它只拥有寻址它的那一个文件。

每次请求解析后的路径都必须落在文件根内，否则以 `skill-admin/file-escapes-entry` 拒绝。文件数与递归深度有上限，符号链接与 `.` 开头的条目只被跳过、不参与遍历。单文件超过 512 KiB 或内容含 NUL 字节时，`readFile` 把文档标为 `editable: false` 并扣留正文，`writeFile` 以 `skill-admin/file-not-writable` 拒绝——交回半截正文等于邀请一次会毁掉后半段的保存。

写入条目入口文件前会校验 frontmatter 含 kebab-case 的 `name` 与非空 `description`。入口文件是目录包的 `SKILL.md` 或扁平技能唯一的那一个文件；只按文件名判定会漏掉后者。发现器会静默丢弃不合法条目，所以这里把「写成一个模型永远看不到的技能」当作失败而非成功。

### 可观察的成功与失败

`list` 对不存在的根、不可读的根都返回空条目列表而非报错——那是空状态。每个条目携带 `enabled`（发现器此刻是否读取它）、`shadowed`（同名条目中有更低 rank 的胜出）与可选 `invalid`（发现器会丢弃它的原因）。

写入失败走 `RemoteError` 码表：`skill-admin/invalid-name`（非 kebab-case）、`skill-admin/root-not-found`（路径不在被扫描集合中）、`skill-admin/root-not-writable`（只读根）、`skill-admin/entry-exists`（目标已占用）、`skill-admin/invalid-frontmatter`（文件没有可编辑的 frontmatter 块，或改写后不再可发现）、`skill-admin/entry-not-found`、`skill-admin/file-not-found`、`skill-admin/file-not-writable`、`skill-admin/file-escapes-entry`、`skill-admin/upload-invalid`（非规范 base64 或超出上传上限）、`skill-admin/io-failed`。

`setEnabled` 对「条目已在被请求的状态」是幂等的：源与目标相同即直接重读条目，因此一次丢失响应后重发的开关不会报冲突。

`bundled` 根只读，因为它随部署交付。其余根可写，包括 `customSkillDirs` 声明的根——那本身就是部署方显式指定为技能根目录的路径。

写入后用同一次扫描重新确认条目存在，因此「写成功但发现不到」会作为 `io-failed` 报出，而不是静默成功。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计理念

本包建立在「发现」与「管理」的分离之上。根解析属于 `dsh-skill-filesystem`：它知道 `dshHome`、`agentsHome`、`customSkillDirs`、`bundledSkillDir` 与项目根查找。本包不重新推导这些，而是读 `ctx.skillRoots`，因此两边配置不会漂移。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | Remote 服务、根扫描、遮蔽计算、写入 |
| [`src/frontmatter.ts`](src/frontmatter.ts) | frontmatter 解析与保注释局部编辑 |
| [`src/types.ts`](src/types.ts) | wire 词汇 |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴生插件 |

### 扫描与遮蔽

扫描每个根的直接条目：目录且含 `SKILL.md` 记为 `bundle`，`.md` 文件记为 `flat`。随后扫描同根的 `.disabled/`，把其中的条目按同样的规则读出并标为已停放。每个文件解析 frontmatter；解析失败、缺 `name`/`description`、名称非 kebab-case 都记为 `invalid` 并保留在视图里，供用户修复。遮蔽按 rank 计算：同名条目中 rank 最小者胜出，其余标记 `shadowed`；已停放的条目被排除在裁决之外。

### 写入

写入走 `@deepseek-ai/dsh-atomic-write`（原子替换并创建父目录）。新建断定目标不存在；改写先读原文件，再在 frontmatter 块内按行定位目标键改写，未命中的键追加到块尾，因此注释、键序与调用方未提及的键都被保留。正文替换用解析出的偏移，不整体重写文件。

启用状态不走写入而走同根内的 `rename`，`mkdir` 只在首次停放时创建 `.disabled/`。

文件操作走 Node 文件系统而非 `ctx.fs`：后者没有删除与建目录能力，混用会让部分操作受沙箱约束、部分不受，而这是 host 受信的管理路径。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [skill 子系统参考](../../../docs/subsystems/skills.zh.md)——注册表、提供方约定与本地发现优先级。
- [skill-filesystem 包](../../skill/skill-filesystem/README.zh.md)——本包消费的 `ctx.skillRoots` 来源。
- [设置页客户端包](../../client/ui-settings-skills/README.zh.md)——本包的浏览器面消费方。
- [实施计划](../../../docs/design/skill-management-plugin.zh.md)——决策与取舍。

-----

<a id="model-experience"></a>
## 模型体验

不直接影响模型。间接影响经发现器：本包写入的技能文件由 `dsh-skill-filesystem` 的监视器捕获，在下一个模型步骤触发目录刷新；新建的根目录此前不存在时，监视器按路径段轮询，模型侧可见时间晚于界面反馈。

#### KV Cache 影响

不直接影响。目录刷新由提供方与 `dsh-tool-skill` 负责，其追加替换目录的行为不变。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **仅读写本地提供方的根**——根来自 `ctx.skillRoots`，其他提供方（运行时注册、远程来源、随包徽章）贡献的技能不出现在管理视图中。
- **扫描深度为一层**——与本发现器一致，只识别 `<root>/<name>/SKILL.md` 与 `<root>/<name>.md`。
- **frontmatter 编辑是行级的**——按顶层键名定位一行；把值写成多行块或使用锚点的文件，改写会落在新增一行上而不是原地替换。
- **删除不设回收站**——目录包连同 `references/`、`scripts/`、`assets/` 一并删除，调用方需自行二次确认。
- **条目身份随停放变化**——`entryId` 是绝对路径的品牌包装，切换启用状态后同一条技能的身份串即变化，调用方不能跨写操作缓存它。
- **停放目录是一条约定**——第三方工具不认识 `.disabled`：它不会被本发现器读成技能，但也不会被别的工具自动跳过。
- **编辑器不做二进制编辑**——图片等资源只列出、只读，替换它们仍要回到文件系统。
- **文件树有固定的边界**——文件数、递归深度与单文件体积上限写死在插件内；超出边界的树会被标为 partial，超出体积的文件只展示。
- **导入不覆盖既有条目**——目标目录已存在时写入被拒绝，即使预览已标出会替换；先删除或改名再导入。
- **预览暂存在内存**——进程重启后未提交的预览失效，需重新抓取。
- **导入不做内容审查**——技能正文不经模型或规则筛查，风险由预览环节的读者自行判断。
- **解包上限是固定的安全界**——成员数、单文件与合计体积上限写死在插件内，因为它们是不可信输入的边界而非随部署变化的选项。
- **GitHub 导入走 contents API**——未认证请求受该 API 的速率限制；一次性下载整仓库的归档不经此路径。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确不具权威性——已交付的行为与限制以上文和代码为准。两个开放问题：其一，`read` 返回的 `entryId` 是绝对路径的品牌包装，条目改名后身份即变化，尚无稳定句柄；其二，导入功能落地时，预览暂存需要条目上限与存活时限，目前尚未设计。
</details>
