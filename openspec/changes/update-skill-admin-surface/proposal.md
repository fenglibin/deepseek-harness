# 重做技能设置页并补齐启用、多文件编辑与压缩包上传

## 为什么

「设置 → 技能」目前把工作区选择、新建表单、导入面板与按根分组的条目列表平铺在一屏：新建表单常驻占住首屏，条目行把名称、描述与四类标记挤成一行，根路径与 rank 泄漏到用户视野。同时三项能力缺失：没有整体启用开关（只有 frontmatter 层面的模型/用户调用开关），编辑只能改 SKILL.md 的 frontmatter 与正文，导入只接受 URL。

## 改什么

**页面只做展示。** 顶部一行放作用域 TAB、工作区选择器与「导入技能」按钮，中部是技能表格，写入一律进弹窗。新建表单从页面移除。

**三个作用域 TAB。** 全局（`~/.agents/skills`）、应用（`~/.dsh/skills`）、工作区（当前工作区的 `.dsh/skills` 与 `.agents/skills`）。工作区 TAB 内带工作区选择器；`custom` 与 `bundled` 根不进入任何 TAB。

**表格带启用开关。** 每行有名称、描述、状态、启用开关、编辑与删除。禁用把条目移入同根的 `.disabled/` 子目录，启用移回；禁用项仍留在表格里，否则用户没有恢复入口。

**编辑弹窗是文件浏览器。** 左侧文件树列出条目目录内的全部文件，右侧编辑区带语法高亮。新增 listFiles/readFile/writeFile 三个 Remote 方法，写入 SKILL.md 前校验 frontmatter。

**导入支持上传。** 弹窗分 URL 与上传两个页签，上传接受 zip/tar/tar.gz；两条路径共用同一套解包校验，预览承诺的文件清单就是落盘清单。

## 影响

| 面 | 变化 |
|---|---|
| `dsh-host-skill-manager` | `SkillAdminEntry.enabled`、文件与上传相关的 wire 词汇、setEnabled/listFiles/readFile/writeFile/previewUpload、`.disabled` 扫描、解包与下载拆分 |
| `dsh-skill-filesystem` | `discoverRoot` 显式跳过 `.disabled` |
| `dsh-client-ui-settings-skills` | 页面重做为 TAB + 表格 + 三个弹窗，新增作用域映射、文件树与高亮编辑器组件 |

## 兼容性

`entryId` 仍是条目绝对路径，因此条目在启用与禁用之间移动时身份串变化；调用方每次写操作后重新取快照。这是预发布面的内部契约，不留兼容层。