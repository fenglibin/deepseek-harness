## ADDED Requirements

### Requirement: 插件卡片提供 README 全文入口
插件卡片展开后，凡该插件所属包发布了 README 的行 SHALL 在描述末尾提供「查看更多」入口；激活后 SHALL 以模态弹窗展示该 README 的全文（优先 `README.zh.md`）。

#### Scenario: 有 README 的行给出入口
- **WHEN** 一行所属包能被解析到，且该包带有 `README.zh.md` 或 `README.md`
- **THEN** 清单快照 SHALL 为该行带上读到的 README 文件名，卡片 SHALL 在描述末尾显示「查看更多」

#### Scenario: 没有 README 的行不给入口
- **WHEN** 一行所属包无法解析，或该包没有发布 README
- **THEN** 卡片 SHALL 不显示「查看更多」，且不给一个点了会失败的链接

#### Scenario: 全文按需取回
- **WHEN** 用户激活「查看更多」
- **THEN** 客户端 SHALL 在此时才向宿主取回全文，而不是把它放进清单快照

## ADDED Requirements

### Requirement: Markdown 内容浏览器兼容常见语法
README 全文 SHALL 以仓库既有的 Markdown 渲染管线渲染，并 MUST 正确展示表格、代码块与语法高亮、图片、链接、列表、引用、数学公式与 mermaid 流程图。

#### Scenario: 表格按表格渲染
- **WHEN** README 含 GFM 表格
- **THEN** 弹窗 SHALL 渲染出带表头与单元格的表格，而不是把管道符当正文

#### Scenario: mermaid 围栏渲染成图
- **WHEN** README 含 ```mermaid 代码块
- **THEN** 弹窗 SHALL 渲染出对应的流程图／图表；mermaid 运行时 MUST 按需动态加载，不出现 mermaid 围栏时不得加载

#### Scenario: 图片与外链可用
- **WHEN** README 含绝对 HTTP(S) 图片或链接
- **THEN** 弹窗 SHALL 正常展示图片并使链接可点

#### Scenario: 单张图失败不影响整篇文档
- **WHEN** 某个 mermaid 代码块渲染失败
- **THEN** 该块 SHALL 退回为代码块并给出原因，文档其余部分 SHALL 正常渲染
