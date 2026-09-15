# 技术决策

设计草案见 [docs/design/mcp-oauth-config-reachability.zh.md](../../../docs/design/mcp-oauth-config-reachability.zh.md)。本文件记录决策编号，供 tasks.md 锚定。

### D7 OAuth 字段读写对称，与 allowedTools 同构

`settingsToMcpJson` 与 `entryToServerJson` 在条目为 OAuth 时写出 dsh 扩展字段 `authMode` / `clientId` / `authorizationUrl` / `tokenUrl` / `scopes`。

三条规则：仅当 `auth.kind === 'oauth'` 时写出，因此 `none` 条目输出逐字不变；`scopes` 仅在条目携带时写出，与 `allowedTools` 的省略规则一致；其他平台读到按未知字段忽略，这是 `mcp.json` 既有扩展字段的既定约定。

反转 D6 的理由：设置页的编辑功能建立在 `mcp.json` 往返之上，单向省略使编辑器看不到字段、保存时丢失。`allowedTools` 已经证明扩展字段读写对称是可行且被接受的。

### D8 读方向的沉默继承改述为升级与手编兼容

上一轮为缓解丢配置引入了「文档沉默时继承当前分节的 auth」。字段对称后该规则的存在理由减弱，但保留，因为两个真实场景仍需要它：旧版本写下的 `mcp.json` 没有 OAuth 字段，而 settings 已有 OAuth 条目，此时把沉默读作 `none` 会让第一次手编丢配置；半配置（写了 `authMode` 但漏端点）仍报错而非静默降级。

该规则的角色从「缓解措施」变为「升级与手编兼容」，注释与文档按新理由改述。

### D9 本次不新增设置页 OAuth 表单控件

只修数据丢失与可发现性。独立表单控件（输入框 + 认证按钮）需要新 UI 与本地化文案，且当前「粘贴 JSON」路径在文档化之后已可用，因此作为后续增强。

## 被考虑的备选方案

**只改编辑器渲染，不改 `mcp.json`**：`entryToServerJson` 输出 OAuth 字段但 `settingsToMcpJson` 不输出。被拒因是编辑保存会经 Host 的 `updateMcpServer` 重渲染整个条目，写入路径仍省略字段，配置照旧丢失——两条路径必须同时对称。

**新增表单控件替代 JSON 编辑**：对用户更友好，但改动面大得多，且没有解决「手编 `mcp.json` 无法配置 OAuth」这一并存的缺口。

**保持 D6 只读，仅在编辑器里做特殊保留**：让编辑器把未显示的字段原样带回。被拒因是这需要一条"编辑器必须记住它看不见的字段"的隐式契约，任何新的渲染路径都可能再次丢字段，属于治标。
