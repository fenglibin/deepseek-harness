# 实施清单

## 1. 并排对齐模型

- [x] 新增 revision-diff-model：把两版本文本折叠成对齐的 [left,right] 行对，删增按索引配对、单侧补空占位 (covers: design/D3, session-file-revisions/替换占用同一行, session-file-revisions/单侧增删以空占位对齐)
- [x] 两侧行号由 hunk 的 oldStart/newStart 递增，空位侧不编号 (covers: design/D3, session-file-revisions/两栏各有自己的行号)
- [x] 跳过 `\ No newline at end of file` 注解行，避免显示文件里没有的文本并让后续行号错位 (covers: design/D3)
- [x] 变更区段划分与统一格式文本输出 (covers: design/D7, design/D8, session-file-revisions/复制内容可被 diff 工具接受)

## 2. 全屏视图

- [x] 新增 RevisionDiffOverlay：复用 Modal headless，自有头部（文件名/路径/统计/复制/关闭）、两栏栏目名、正文与底部导航 (covers: design/D2, session-file-revisions/点击查看变更打开全屏视图, session-file-revisions/以 dialog 语义暴露并可关闭)
- [x] 经 ui-primitives 既有 shiki 单例为两栏着色，懒加载语法到达后重渲染，未知扩展名退化为纯文本 (covers: design/D5, session-file-revisions/按文件语言高亮)
- [x] 配对行用 diffChars 标注字符级差异，超长行跳过内部标注 (covers: design/D5, session-file-revisions/标出替换行内部真正改动的字符)
- [x] 两栏横向滚动同步且不回环；纵向滚动由正文区独担 (covers: design/D6)
- [x] 上一处/下一处跳转、位置读数与 J/K 键；超长文件折叠并给出展开控件 (covers: design/D4, design/D7, session-file-revisions/在变更之间跳转)
- [x] oversized / baseline-missing / 空变更 / 读取失败四种状态如实说明，不绘制替代内容 (covers: design/D10, session-file-revisions/内容超过预览上限, session-file-revisions/基线未捕获, session-file-revisions/读取被拒绝)

## 3. 触发与承载接线

- [x] dock 改为发布打开请求，删除内联面板渲染路径 (covers: design/D1, session-file-revisions/点击查看变更打开全屏视图)
- [x] 新增 shell.overlay 注册与共享 observable 请求源，随插件 fiber 卸载 (covers: design/D1)
- [x] 查看器保持只读，撤销仍只由 dock 拥有，消除重复的撤销生命周期 (covers: design/D9)
- [x] 按记录逐行判定的能力门控与增长时重取保持不变 (covers: session-file-revisions/没有修订记录的文件行, session-file-revisions/会话进行中新增的文件)

## 4. 消除重复的语言映射

- [x] 把扩展名到语言映射收归 ui-primitives（高亮器所有者）并导出 (covers: design/D5)
- [x] ui-file-browser 改为再导出该共享实现，不再保留第二份表 (covers: design/D5)

## 5. 测试与验证

- [x] 对齐模型单测锁定全部边界：替换配对、纯增、纯删、不等长、新建文件、空文件、单行、有无尾换行、跨 hunk 行号、变更区段、字符级区间、超长行、统一格式输出 (covers: design/D3, design/D5, design/D7, design/D8)
- [x] 查看器用例覆盖打开、栏目名、同行配对、两侧行号、统计、字符标记、跳转与回绕、复制内容、四种状态、关闭 (covers: design/D2, design/D4, design/D6, design/D7, design/D8, design/D10, session-file-revisions/以 dialog 语义暴露并可关闭, session-file-revisions/按文件语言高亮, session-file-revisions/标出替换行内部真正改动的字符, session-file-revisions/在变更之间跳转)
- [x] dock 用例覆盖能力缺席、按行门控、发布请求、进行中新增文件、撤销四态与重取 (covers: design/D1, design/D9, session-file-revisions/没有修订记录的文件行, session-file-revisions/会话进行中新增的文件)
- [x] 在真实构建产物中核验并排模型、覆盖层注册与新文案已编译进去 (covers: design/D1, design/D2)
- [x] 同步 README：全屏并排视图、导航、复制格式与只读边界 (covers: design/D2, design/D7, design/D8, design/D9)
