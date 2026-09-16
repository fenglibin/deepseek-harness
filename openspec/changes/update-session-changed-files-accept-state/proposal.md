# 让「修改的文件」的接受状态跨重挂载保持并新增当前/全部视图

## 为什么

用户报告：在「修改的文件」列表中点击「接受」或「全部接受」后，只要本会话后续还有文件变更，此前已接受过的全部文件又一起回到列表。

根因不在列表的划分方式，而在接受记录的归属：接受集是 dock 适配器的组件本地 state（packages/client/ui-session-changes/src/client/SessionChangesDock.tsx:298）。按 packages/client/AGENTS.md 与 packages/client/ui-renderer/src/client/scoped-slots.tsx 的既有规则，组件本地状态在作用域切换时按构造清空，需要跨重挂载存活的状态必须放进 session 绑定的来源。因此任何重挂载都会清空全部接受记录——这正是"全部变更的文件又出现"而非只出现新变更那几个的来源。用户已确认触发场景为刷新页面与切到别的会话再切回来。

该行为当前被测试固化为预期（tests/session-changes-dock.client.spec.tsx:539）并记在 README 已知限制「无跨会话持久化」中；前身变更 add-session-changed-files-log 的 D6 也明确选择不持久化。本次推翻该决策。

## 改什么

1. 接受集由组件本地 state 提升为 session 作用域 store 并持久化：同一会话内重挂载复用实例，切换会话互不干扰，会话消亡时框架清理持久化键。
2. dock 新增「当前变更」/「全部变更」两个视图。历史在数据上等于接受记录的键集合，不新增第二个列表存储。
3. 无待处理变更时面板不再整块消失，改为收起为一行摘要，使用户仍能进入「全部变更」看到曾被接受过的文件。
4. 明确历史变更允许与当前变更重叠：某文件被接受后再次变更时两侧同时存在，再次接受后只剩历史侧。

## 影响

- packages/client/ui-session-changes：接受集来源、视图切换、面板收起、locale 文案、CSS、单测、README。
- 新增该包的 store 声明文件与注册处 store 声明。
- 不改动宿主 changedFiles 投影、会话日志格式、工具语义与磁盘内容；接受仍是纯界面行为。
- 不改动每轮收尾的「产物」芯片行（ui-deliverables）。