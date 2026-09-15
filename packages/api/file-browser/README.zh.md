---
description: "工作区受限的文件浏览器 Host 面：面向 Web GUI 运维人员的 fileBrowser Remote 命名空间与 /api/file.asset 图片字节路由。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-file-browser

## 概述

本包拥有 `fileBrowser` Remote 命名空间与 `/api/file.asset` 字节路由，让 Web GUI 能在**一个工作区目录之内**列举目录、读取与写入文本、新建、重命名、删除，以及按文件名搜索。它的每一个入口都以工作区身份解析根目录，并把目标规范化后检查包含关系，因此符号链接也不能把访问带出该根目录。文本写入经由同目录临时文件加 `rename` 原子发布，并携带读入时的版本令牌，用来拒绝覆盖他人已改动的文件。图片不经由 Remote 传输：`read` 只为图片返回一个字节 URL，浏览器直接取回。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把本插件挂载进 Web 宿主组合，它就会注册 `fileBrowser` 命名空间与字节路由。唯一的配置是四组边界，都由部署方按需覆盖。

```yaml
- name: '@deepseek-ai/dsh-api-file-browser'
  config:
    maxFileBytes: 2097152
    maxImageBytes: 33554432
    listLimit: 2000
    searchLimit: 500
```

### Remote 方法

| 方法 | 请求 | 返回 |
|---|---|---|
| `list` | 工作区、目录相对路径、是否显示隐藏项 | 该层的直接子项与截断标志 |
| `read` | 工作区、文件相对路径 | 描述该文件的判别联合（见下） |
| `write` | 工作区、路径、内容、可选版本令牌 | 写入产生的版本 |
| `create` | 工作区、父目录、名称、文件或目录 | 新条目的相对路径 |
| `rename` | 工作区、当前路径、新名称 | 移动后的相对路径 |
| `delete` | 工作区、路径 | 空 |
| `search` | 工作区、名称片段 | 匹配项与截断标志 |

相对路径一律使用 `/` 分隔符；空字符串表示工作区根目录。名称是单个非空路径片段：含分隔符、为空、`.` 或 `..` 都以 `file-browser/invalid-name` 被拒绝。

### `read` 的四条分支

「文本可编辑、图片可查看」在这一处收敛——只有 `text` 分支携带内容进入编辑器：

| 分支 | 何时出现 | 客户端行为 |
|---|---|---|
| `text` | 内容采样判定为 UTF-8 文本且在大小上限内 | 进编辑器，带版本令牌 |
| `image` | 扩展名是 PNG/JPEG/WebP/GIF 之一 | 用返回的 `url` 加载图片 |
| `binary` | 采样含 NUL 字节或不是合法 UTF-8 | 只报大小，不给编辑器 |
| `too-large` | 大小超过 `maxFileBytes` | 报大小与上限，不给编辑器 |

判定顺序是图片扩展名、大小上限、内容采样，所以一张超大的图片仍然按图片呈现而不是按超限拒绝。

### 包含与越界

每个方法都从 `workspaceId` 解析工作区根目录，再把目标规范化并检查它是否仍在根之下。检查用的是 `realpath` 而非词法前缀比较，因为工作区内的符号链接可以指向外部，而词法比较会放过它。不存在目标（一次新建）会解析其最深的已存在祖先，因为那才是新建将要落地的位置。

被拒绝的目标以 `file-browser/outside-workspace` 失败；其余稳定码为 `not-found`、`stale`、`exists`、`invalid-name`、`unreadable` 与 `unsupported`。

这些操作是运维人员对自己工作区的显式编辑动作，因此**不受调用会话沙箱模式限制**：只读会话里用户仍然能保存自己的文件。围栏就是工作区根目录本身。

### 版本乐观锁

`read` 的 `text` 分支返回一个 `mtimeMs:size` 摘要作为版本令牌。`write` 带上它时，磁盘上的文件自该版本以来若已变化，写入就以 `file-browser/stale` 被拒绝而不是静默覆盖；省略令牌则无条件写入。写入本身先落到同目录下唯一命名的临时文件，再 `rename` 发布——同目录放置正是让该重命名不跨设备、从而保持原子性的原因。

### 图片字节路由

`/api/file.asset?workspaceId=…&path=…` 接受 `GET` 与 `HEAD`，返回图片字节、媒体类型与长度，并带 `cache-control: no-store`。该路由与 Remote 共用同一份包含检查，因此 `<img src>` 到不了任何 `read` 会拒绝的位置。查询参数缺失回 400，工作区未知回 404，越界或不是受支持图片回 403。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包只服务浏览器里由人操作的文件管理器：它不注册提示词、工具或会话事件，也不进入任何模型请求。

#### KV Cache 影响

无直接影响；通过该界面读写文件不会改变模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 搜索只匹配条目名称，不做文件内容检索。
- 目录列举在 `listLimit` 处截断并只报告截断，不提供分页或游标。
- 二进制文件只报大小，不提供十六进制预览或下载。
- 版本令牌由 `mtimeMs` 与 `size` 组成：同一毫秒内写入同样长度的内容不会被识别为一次变化。
- 包含检查与随后的系统调用之间存在残余 TOCTOU（祖先符号链接被替换），对已认证的本地 GUI 调用者这一威胁模型可接受。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

`src/containment.ts` 拥有路径解析与包含判定，`src/workspace-io.ts` 拥有每一项磁盘操作与它的结构化拒绝，`src/index.ts` 只做工作区解析、把拒绝翻译成线上错误码，并注册字节路由。两者共享同一份包含实现是有意为之：图片路径与文本路径是同一个信任问题，第二份实现会成为第二个可能漂移的地方。

</details>
