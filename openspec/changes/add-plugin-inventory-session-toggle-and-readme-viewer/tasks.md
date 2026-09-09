## 1. 宿主：组合文件写入
- [x] 1.1 `authoring.ts`：放开 `system` 预设的单行写入，写入 `resolve()` 解析出的组合文件本身 (covers: plugin-inventory-session-toggle/随部署自带的预设行也能停启, design/D1)
- [x] 1.2 `authoring.ts`：把整体 `dump` 换成按行定位的局部 `disabled` 编辑，保留注释与手写格式 (covers: plugin-inventory-session-toggle/写组合文件时保留注释与手写格式, design/D2)
- [x] 1.3 `authoring.ts`：拒绝流样式行与 `!!js` 门，保留「按文件自己声明的 id 定位」校验 (covers: plugin-inventory-session-toggle/没有可写身份或带表达式门的行不给开关, design/D7)
- [x] 1.4 `index.ts`：`setRowDisabled` 契约与 JSDoc 随新语义更新；`deleteComposition` 保持只对用户预设开放 (covers: plugin-inventory-session-toggle/删除预设仍然只对用户自建预设开放, design/D1)
- [x] 1.5 更新 `composition-edit.spec.ts`：随部署自带的预设可写、注释保留、嵌套行、拒绝项 (covers: plugin-inventory-session-toggle/随部署自带的预设行也能停启, design/D2)

## 2. 宿主：README 读取
- [x] 2.1 `description.ts`：新增按模块名返回 README 文件名与全文的解析函数（剥掉 frontmatter，`README.zh.md` 优先） (covers: plugin-readme-viewer/有 README 的行给出入口, design/D5)
- [x] 2.2 `types.ts`：`PluginInventoryEntry` 与 `AgentPresetPluginRow` 增加可选 `readme` 文件名 (covers: plugin-readme-viewer/没有 README 的行不给入口, design/D5)
- [x] 2.3 `index.ts`：新增 `pluginInventory/readme` Remote，`list` 投影带上文件名 (covers: plugin-readme-viewer/全文按需取回, design/D5)
- [x] 2.4 `inventory.spec.ts`：覆盖 readme 文件名投影与 readme Remote 的成功／缺席路径 (covers: plugin-readme-viewer/有 README 的行给出入口, design/D5)

## 3. 客户端：开关
- [x] 3.1 `PluginInventorySettingsTab.tsx`：会话插件行的开关条件从「用户预设」放宽到「有 id 且无 `!!js` 门」 (covers: plugin-inventory-session-toggle/随部署自带的预设行也能停启, design/D1)
- [x] 3.2 CSS：开关启用底色改 `--dsw-alias-state-success-primary` (covers: plugin-inventory-session-toggle/浅色外观下启用态不是黑色, design/D3)
- [x] 3.3 保留写入被拒的就地报错 (covers: plugin-inventory-session-toggle/写入被拒要报告, design/D1)

## 4. 渲染器：mermaid
- [x] 4.1 `render.tsx`：新增按渲染上下文开启的 mermaid 代码分支，动态 `import('mermaid')` (covers: plugin-readme-viewer/mermaid 围栏渲染成图, design/D4)
- [x] 4.2 mermaid 渲染失败退回代码块并给出原因 (covers: plugin-readme-viewer/单张图失败不影响整篇文档, design/D4)
- [x] 4.3 `ui-primitives` 依赖与单测 (covers: plugin-readme-viewer/mermaid 围栏渲染成图, design/D4)

## 5. 客户端：README 弹窗
- [x] 5.1 `locales.ts`：新增查看更多信息、弹窗标题、加载／失败／缺席文案与 Markdown chrome 文案 (covers: plugin-readme-viewer/有 README 的行给出入口, design/D6)
- [x] 5.2 `PluginInventorySettingsTab.tsx`：描述末尾的「查看更多」入口与 `Modal` 弹窗 (covers: plugin-readme-viewer/表格按表格渲染, design/D6)
- [x] 5.3 `index.ts`：注入 `readme` 取回回调 (covers: plugin-readme-viewer/全文按需取回, design/D5)
- [x] 5.4 组件测试：入口出现条件、弹窗加载态、失败态与 mermaid 分支 (covers: plugin-readme-viewer/有 README 的行给出入口, design/D6)

## 6. 收尾
- [x] 6.1 三个包的 README 同步 (covers: plugin-inventory-session-toggle/随部署自带的预设行也能停启, design/D1)
- [x] 6.2 Agent Note (covers: plugin-inventory-session-toggle/写组合文件时保留注释与手写格式, design/D2)
- [x] 6.3 构建并在 3080 GUI 验证 (covers: plugin-inventory-session-toggle/浅色外观下启用态不是黑色, design/D3)
