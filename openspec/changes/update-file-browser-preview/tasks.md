# 实现清单

- [x] ui-file-browser：新增 preview.ts 的 previewKindOfPath，.md/.markdown 与 .html/.htm 分别归为 markdown 与 html (covers: file-browser/内容区的预览类型由扩展名决定, design/D4)
- [x] ui-file-browser：CodeEditor 工具栏在可预览文件上渲染「预览」复选框，切换编辑器与预览 (covers: file-browser/预览是内容区的切换视图, design/D2, design/D3)
- [x] ui-file-browser：Markdown 预览经 MarkdownText 渲染并开启 mermaid 流程图 (covers: file-browser/Markdown 预览支持完整语法, design/D5)
- [x] ui-file-browser：HTML 预览经 srcDoc + sandbox="allow-scripts" 的 iframe 渲染 (covers: file-browser/HTML 预览在隔离源中运行脚本, design/D6)
- [x] ui-file-browser：取消勾选回到编辑器并保留未保存的缓冲区 (covers: file-browser/预览与编辑共享同一缓冲区, design/D3)
- [x] ui-file-browser：搜索框降为 26px 高、13px 字号并收紧宽度 (covers: file-browser/搜索框与内容区动作的尺寸与相邻文字一致, design/D1)
- [x] ui-file-browser：内容区「重新加载」「保存」改用 sm 尺寸，与「已保存」同字号 (covers: file-browser/搜索框与内容区动作的尺寸与相邻文字一致, design/D1)
- [x] ui-file-browser：新增文案进 fileBrowser locale 字典 (covers: file-browser/预览是内容区的切换视图)
- [x] ui-file-browser 单测：预览类型判定、复选框显隐、两种预览渲染、缓冲区保留、只读形态同样可预览 (covers: file-browser/内容区的预览类型由扩展名决定, file-browser/预览是内容区的切换视图, file-browser/Markdown 预览支持完整语法, file-browser/HTML 预览在隔离源中运行脚本, file-browser/会话文件链接在 Web 端只读查看)
- [x] 验证：受影响范围单测、client 面类型检查、lint 与 verify 门禁 (covers: design/D1)
- [x] 收尾：README 与 Agent Note 一并写齐并跑文档门禁 (covers: design/D1)
