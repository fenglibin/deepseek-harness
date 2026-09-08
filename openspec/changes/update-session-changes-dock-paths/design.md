# 技术决策

### D1 去重键改为规范化路径

`sessionChanges` 目前用原始 `produced.path` 作键。改为先规范化：相对路径按会话 cwd 解析（`resolveWorkspacePath`），再按 `/`、`\` 切分并丢弃空段与 `.`，`..` 回退一段。规范化结果同时作为去重键与展示/打开用的路径，因此 `src/a.ts` 与 `/proj/src/a.ts` 收敛为一条，且交给宿主的路径一定是绝对路径。

### D2 cwd 由 dock 注册的 inject 提供

session 作用域的 `slots.register.inject` 工厂收到 `sessionId`，用 `ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd` 读工作区根——与 ui-chat 的 `openFile` 同源、同为注入面里的普通数据，不引入新的框架扩展点，也不让组件接触 ctx。

### D3 openFile 退化为一次远端转接

因为 D1 已经把路径解析到绝对形式，dock 的 `openFile` 只需 `ctx.remote.session.openWorkspacePath({ path })` 并把 `!result.ok` 转成 rejection。这避免复制 ui-chat 里 cwd 解析与错误文案的那段逻辑，也不新建跨插件能力接缝。

### D4 行内展示工作区相对路径，分两段排版

绝对路径是折叠与打开用的身份，行内则显示 `displayPath(path, cwd)` 去掉工作区根前缀的拼写；工作区外的文件（或没有工作区根的会话）没有更短的命名方式，保留绝对路径。行内拆成目录段与文件名段两个 span：目录段 `flex: 0 1 auto` 可省略，文件名段 `flex: 0 0 auto` 永不截断。`title` 始终携带绝对路径——它是悬停时的消歧信息；`aria-label` 用行内拼写，与读者看到的一致。

### D5 打开失败就地成行

面板持有 `openError: string | null`，`openFile` rejection 时渲染列表下方一行 `role="alert"`（文案 `openFailed` + 宿主消息），下一次成功打开时清除。不引入 toast/弹窗：dock 是输入区上方的轻量条带，就地一行与它的体量匹配。