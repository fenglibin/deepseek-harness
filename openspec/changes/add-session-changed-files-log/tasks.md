# 实现清单

- [x] 新增 packages/fs/file-changes 包：变更词汇、路径规范化、有界折叠、changedFiles 投影单元、/client 出口、invariant companion、README 与包骨架；注册进两个 tsconfig 聚合与 tsconfig.base.json 的 paths (covers: session-changed-files/变更事实从完整会话日志折叠, session-changed-files/条目按规范化路径去重并携带最后一次变更的 seq, session-changed-files/三种变更工具都被计入, session-changed-files/失败的变更调用不计入, session-changed-files/同一文件多次变更只占一条, session-changed-files/两种拼写收敛为一条, session-changed-files/变更位于已加载窗口之外, design/D1, design/D2, design/D3)
- [x] web-app bundle 挂载新包并声明依赖；INLINE_SAFE 放行 @deepseek-ai/dsh-file-changes/client (covers: design/D1, design/D9)
- [x] ui-session-changes 改读 useProjection('changedFiles')（缺席时回退窗口折叠），接受集改 Record<path, lastSeq> 并按 lastSeq 判定待处理，标题改「修改的文件」 (covers: session-changed-files/dock 展示整个会话的变更, session-changed-files/投影缺席时回退, session-changed-files/接受后同一文件再次变更则重现, session-changed-files/接受后无新变更则保持隐藏, session-changed-files/全部接受后仅新变更重现, session-changed-files/接受不动磁盘, session-changed-files/接受状态不跨页面刷新保留, design/D4, design/D5, design/D6, design/D7)
- [x] ui-deliverables 复用新包共享词汇，删除本地六段重复解析；界面行为不变 (covers: design/D2, design/D8)
- [x] 单测：单元折叠 27 条与 REAL 组合 2 条；dock 41 条（含接受与再变更重现、投影优先与回退一致、包壳覆盖） (covers: session-changed-files/变更事实从完整会话日志折叠, session-changed-files/失败的变更调用不计入, session-changed-files/三种变更工具都被计入, session-changed-files/同一文件多次变更只占一条, session-changed-files/两种拼写收敛为一条, session-changed-files/变更位于已加载窗口之外, session-changed-files/接受后同一文件再次变更则重现, session-changed-files/接受后无新变更则保持隐藏, session-changed-files/全部接受后仅新变更重现, session-changed-files/投影缺席时回退)
- [x] 验证：受影响包单测 101 条通过、两个 tsconfig 面干净、lint 0 警告 0 错误、两个新包 src/** 覆盖率 100% 无豁免、相关 verify 门禁通过 (covers: design/D1, design/D3, design/D4, design/D5)
- [x] Agent Note 与三份 README 同步；supersession 检查完成（两份既有笔记判为部分取代并原地更正） (covers: design/D1, design/D2, design/D4, design/D6)
