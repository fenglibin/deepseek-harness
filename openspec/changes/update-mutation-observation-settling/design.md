# 技术决策

### D1 结算位置：工具侧包裹，不新增服务

`mutateWithObservedBasis` 位于 `dsh-tool-fs/src/error.ts`，包住「分发意图 + 提供方变更」。它不注册服务、不新增事件，只复用既有的 `fs/*-intent` 槽位与 `fs/observed` 事件。

### D2 重新分发意图槽位，而非直接重试提供方

补读后再次调用 `ctx.waterfall('fs/*-intent', …)`，让**策略**从自己的观察记录派生版本基准，而不是由工具编造版本。工具不绕开策略的判定权，只补上它缺的那个事实（观察）。这是本次改动的语义核心。

### D3 失败从源头不产生

`execute()` 只返回一个成功结果；内部补读不产生 `tool/result` 事件。因此会话日志里没有那行，页面上也就没有那行。这与「失败后补读并返回内容」有本质区别：后者仍产生一次 `isError`，只保证之后隐藏。

### D4 缺失目标交给策略作答

`observeTarget` 发现目标不存在时发出 `{ kind: 'absent' }`——权威的负向观察。于是策略对 `edit` 给出 `FS_NOT_FOUND`（无内容可改），对 `write` 给出 `createIfAbsent`（可以创建）。工具不自己下结论。目标既非普通文件也非缺失（目录、特殊文件）时返回 `unusable`，保留原有失败，不假装已结算。

### D5 str_replace_editor 用更自然的形式

该工具的 `str_replace` 与 `insert` 本就必须读取内容来定位字面量或插入边界，过去却在读取**之前**分发意图、且不记录观察。改为先读取、发出 `fs/observed`、再分发意图。审计发现 `insert` 分支过去完全不做读取。

### D6 系统提示词同步

`edit`/`write` 的指导段落原写 "Read the file first (the default fs-observation-policy requires it)"。规则变了之后这句话成为错误指令——它会继续驱使模型做那次已无必要的 `read`。改为说明工具自行结算观察，同时保留仍然成立的忠告：`edit` 需要内容才能写出匹配的 `old_string`。

### D7 策略规则本身不变

`dsh-fs-observation-policy` 的语义一字未改：未见目标仍被门禁拒绝，陈旧观察仍以 `FS_STALE_VERSION` 失败，移除插件仍得到无条件变更。唯一改变的是「谁来满足这条规则」。

### 验证纪律：产物面必须单独验证

`vitest` 经 tsconfig `paths` 把 workspace 导入解析到 `src`（源码面），而 `dsh` 经包 `exports` 解析到 `lib/index.js`（产物面）。因此只改 `src` 不会改变运行中的 GUI，源码面全绿也不能证明用户看到的行为。产物面验证方式：`pnpm run build:lib:host` 后用纯 `node`（与 `dsh` 相同解析路径）从 `lib/index.js` 实际加载插件。