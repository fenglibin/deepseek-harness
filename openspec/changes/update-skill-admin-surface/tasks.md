# 实施清单

## Host：wire 词汇与管理面

- [x] host：wire 词汇增加 enabled、文件节点与上传请求 (covers: skill-administration/禁用条目仍留在列表中, design/D4)
- [x] host：管理面扫描 .disabled/ 并把条目标记为已禁用 (covers: skill-administration/禁用条目仍留在列表中, design/D4)
- [x] host：setEnabled 在同根内移动条目，冲突时拒绝 (covers: skill-administration/切换启用状态, design/D2)
- [x] host：listFiles/readFile/writeFile 与路径、体积、二进制约束 (covers: skill-administration/浏览与编辑技能文件, design/D5)
- [x] host：写入 SKILL.md 前校验 frontmatter (covers: skill-administration/非法改写被拒绝, design/D5)
- [x] host：previewUpload 与解包、下载拆分 (covers: skill-administration/上传压缩包导入, design/D7)

## Host：发现器

- [x] 发现器：discoverRoot 显式跳过 .disabled (covers: skill-administration/禁用目录不被发现, design/D3)

## Client：设置页

- [x] client：作用域映射与三个子 TAB (covers: skill-administration/作用域分栏, design/D1)
- [x] client：技能表格、启用开关与删除确认 (covers: skill-administration/技能表格, design/D8)
- [x] client：编辑弹窗的文件树与高亮编辑区 (covers: skill-administration/文件浏览器编辑, design/D6)
- [x] client：导入弹窗的 URL 与上传两个页签 (covers: skill-administration/导入弹窗, design/D7)
- [x] 移除常驻新建表单，文案全部经字典 (covers: skill-administration/页面不再平铺写入表单, design/D8)

## 验证

- [x] host 单元测试：移动、冲突、路径逃逸、上限、frontmatter 校验 (covers: skill-administration/切换启用状态, design/D2)
- [x] host 集成测试：禁用后条目从 ctx.skills 消失并可恢复 (covers: skill-administration/禁用把条目移出发现面, design/D2)
- [x] client 组件测试：TAB、表格、开关、两个弹窗状态机 (covers: skill-administration/技能表格, design/D8)
- [x] 更新两个包 README、skills 子系统文档与 Agent Note (covers: skill-administration/禁用目录不被发现, design/D3)
- [x] 构建 host 与 client 产物并验证 GUI (covers: skill-administration/技能表格, design/D8)
