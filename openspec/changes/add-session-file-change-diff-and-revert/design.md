# 会话文件变更查看与撤销：技术决策

### D1 语义边界：只统计本会话，子代理沿 parentSession 聚合

「当前会话」的边界是 Session。子代理是独立 Session（`SessionHeader.parentSession` 记录父会话），各有自己的事件日志，因此并行任务天然不互相污染。视图聚合本会话及子孙子代理：沿 parentSession 上溯到根，合并整棵子树的变更，撤销时一并还原。

### D2 累积 diff 是「会话启始态 → 会话末态」，不是 → 当前磁盘

最关键的一条。若取当前磁盘内容，外部或其它会话的改动会被算进本次会话，也会被撤销一并抹掉。

- 累积 diff = 会话启始态 → 会话最后一次修改后的预期内容
- 撤销 = 把会话改动从当前磁盘内容里减掉，保留其它来源的改动

每个 path 只存第一次的 before 作基线（null 表示原先不存在）、最后一次 after 作末态。不存中间态——那是重复且立刻过期的数据。按 seq 折叠而非到达顺序，因此重放与增量追加结果一致。

### D3 撤销用反向 patch，逐 hunk 应用且冲突安全

用 jsdiff v9（仓库已有依赖）的 createTwoFilesPatch(endState, baseline) —— 这个方向本身即撤销 patch，不能再 reverse（实测反向会得到「重做」）。逐 hunk 应用，fuzzFactor: 1。

实测矩阵：
- agent 改 line2 / 用户改 line5 → 还原 line2，保留 LINE5-USER
- agent 改三处 / 用户改第四处 → 全部还原，保留用户改动
- 同一行被改 → 返回 none，整体拒绝，不半改文件
- 多 hunk 部分冲突 → 逐 hunk 应用，成功的保留、冲突的跳过

由此得出：逐 hunk 应用使单 hunk 冲突不牵连同文件其它 hunk；真冲突报失败，绝不静默写入；全部撤销按文件逐个应用、失败汇总。

### D4 大文件降级为「不预览但可撤销」

超过 512KB 的内容只报 oversized 不下发正文，但基线仍完整保存，撤销照常工作。撤销是唯一必须完整保留基线的理由。

### D5 「接受」与「撤销」是两种不同操作，并存

接受是界面层面的隐藏（不动磁盘，现有行为不变）；撤销是真还原。UI 上明确分开。

### D6 三个新包，主工程零改动

- packages/fs/session-file-revisions：捕获与折叠、反向 patch
- packages/api/session-file-revisions：Remote 命名空间 list/diff/revert
- packages/client/ui-session-changes 扩展：dock 控件与 diff 面板

捕获挂在既有的 tools/post-execute waterfall 上（exec.agent.session 即会话，value 携带 before/after 全文），因此 dsh-tool-fs 一行未改。UI 复用既有 DiffBlock 原语。装配只改 web-app cordis.patch.yml。

### D7 写盘的安全边界

revert 是唯一写盘动作。每次写盘前解析会话自身的工作区根并经 realpath 包含检查——path 来自会话日志，捕获之后放置的符号链接可能指向工作区之外。回写走同目录临时文件加 rename，中断不留截断文件。基线为 null（会话新建）时仅在内容仍是会话写入的那一刻才删除，避免删掉后来他人写入的内容。