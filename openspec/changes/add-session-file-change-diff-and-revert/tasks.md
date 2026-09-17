# 实施清单

## 1. 宿主捕获与折叠

- [x] 新增 packages/fs/session-file-revisions 包骨架与 workspace 注册 (covers: design/D6)
- [x] 从 tools/post-execute 捕获 write/edit 的 before/after 全文 (covers: design/D2, design/D6)
- [x] 每 path 只保留首次 before 作基线、最后一次 after 作末态，按位置折叠 (covers: design/D2, session-file-revisions/子代理的改动归入所属会话)
- [x] 子代理沿 parentSession 聚合到根会话，父子同路径合并取更早基线/更晚末态，跨会话用结算时刻而非会话本地 seq (covers: design/D1, session-file-revisions/子代理的改动归入所属会话)
- [x] 反向 patch 撤销：逐 hunk 应用、fuzzFactor 容错、冲突拒绝 (covers: design/D3, session-file-revisions/撤销保留外部改动, session-file-revisions/同一处被会话与外部同时改动, session-file-revisions/部分可还原)
- [x] 区分 absent 与 unknown 基线：只有 write 自报 create 才允许按新建删除 (covers: design/D7, session-file-revisions/撤销会话新建的文件)
- [x] 宿主包 invariant companion 与包不变式校验 (covers: design/D6)

## 2. Remote 命名空间

- [x] 新增 packages/api/session-file-revisions，暴露 list/diff/revert (covers: design/D6)
- [x] 撤销读磁盘当前内容而非捕获末态 (covers: design/D2, session-file-revisions/撤销保留外部改动)
- [x] 逐路径独立应用，冲突只报告该路径，全部撤销失败汇总 (covers: design/D3, session-file-revisions/撤销全部文件)
- [x] 会话新建文件仅内容未变时删除 (covers: design/D7, session-file-revisions/撤销会话新建的文件)
- [x] realpath 包含检查后才写盘，临时文件加 rename 原子回写 (covers: design/D7, session-file-revisions/记录的路径指向工作区之外)
- [x] 超 512KB 时 withheld 报 oversized 且不下发正文 (covers: design/D4, session-file-revisions/内容超过显示上限)

## 3. 界面

- [x] dock 每行加「查看变更」、头部加「全部撤销」 (covers: design/D6)
- [x] 复用 DiffBlock 展示累积差异 (covers: design/D2, session-file-revisions/展示单个文件在会话中的变更)
- [x] 结果按路径汇总展示，区分成功与冲突 (covers: design/D3, session-file-revisions/撤销全部文件)
- [x] 控件仅在装配捕获时出现，缺席时保持原有列表与接受行为 (covers: design/D6, session-file-revisions/未装配修订捕获)
- [x] 接受行为保持不变，与撤销语义分离 (covers: design/D5, session-file-revisions/接受不改变磁盘)

## 4. 装配与验证

- [x] web-app cordis.patch.yml 装配两个新包 (covers: design/D6)
- [x] 客户端装配（dsh-api-remotes）挂载 sessionFileRevisions Remote 贡献 (covers: design/D6, session-file-revisions/未装配修订捕获)
- [x] 包依赖、tsconfig 路径映射、verify-cordis-config 通过 (covers: design/D6)
- [x] 端到端：真实 ToolRuntime 执行 write → 捕获 → 撤销且保留外部改动 (covers: design/D2, design/D3)
- [x] 两个新包 README 与模型体验豁免登记 (covers: design/D6)
- [x] host 与 client 两面构建通过 (covers: design/D6)
- [x] 深度自检：逐条核对 spec 9 个 scenario 与 design D1-D7 的实现完整性，用可执行探针确证缺陷而非推断 (covers: req/1, design/D1, design/D2, design/D3, design/D4, design/D5, design/D6, design/D7)
- [x] 修复阻断级缺陷：客户端装配 dsh-api-remotes 从未挂载 sessionFileRevisions 命名空间，导致查看变更/撤销在真实 GUI 完全不可用 (covers: req/1, design/D6, session-file-revisions/未装配修订捕获, session-file-revisions/展示单个文件在会话中的变更)
- [x] 修复数据丢失级缺陷：write 的 before=null 被无条件当作会话新建，撤销会删除并非本次会话创建的文件；以 operation='create' 区分 absent 与 unknown (covers: req/1, design/D7, session-file-revisions/撤销会话新建的文件)
- [x] 修复跨会话合并缺陷：裸 seq 不可跨会话比较，父子合并取错基线/末态导致改动整体消失；引入 RevisionOrder 按结算时刻排序 (covers: req/1, design/D1, session-file-revisions/子代理的改动归入所属会话)
- [x] 修复未捕获基线文件被谎报为整文件新增：diff 以 withheld='baseline-missing' 说明，revert 报告 conflict，客户端区分两种无预览原因 (covers: req/1, design/D4, session-file-revisions/内容超过显示上限)
- [x] 收敛全部撤销语义：由宿主按权威完整集合执行，不再由客户端传可能不完整的路径子集 (covers: req/1, design/D3, session-file-revisions/撤销全部文件, session-file-revisions/撤销保留外部改动)
- [x] 清理无消费者的重复常量与闲置导出，修复 accept-store.ts 的悬空 @param 文档契约 (covers: req/1, design/D6)
- [x] 同步两个新包 README、api README 的字段契约，并修好其锚点、硬换行与链接缺陷 (covers: req/1, design/D6)
- [x] 回归验证：相关四包 122 个测试全绿，类型检查通过，model-experience/limitations/cordis-config/client-ui-i18n/md-wrap 在我改动面全部干净 (covers: req/1, design/D1, design/D2, design/D3, design/D4, design/D5, design/D6, design/D7, session-file-revisions/展示单个文件在会话中的变更, session-file-revisions/子代理的改动归入所属会话, session-file-revisions/撤销保留外部改动, session-file-revisions/同一处被会话与外部同时改动, session-file-revisions/部分可还原, session-file-revisions/撤销全部文件, session-file-revisions/撤销会话新建的文件, session-file-revisions/内容超过显示上限, session-file-revisions/接受不改变磁盘, session-file-revisions/未装配修订捕获, session-file-revisions/记录的路径指向工作区之外)
