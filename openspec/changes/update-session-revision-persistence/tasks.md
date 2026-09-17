# 实施清单

## 1. 修订记录的持久化

- [x] 新增 domain spec 与记录 schema（session_file_revisions、per-record、表 sessions 以 SessionId 为键，记录含修订列表与 createdAt/cwd/parentSession 身份）(covers: design/D3)
- [x] 服务 init 时打开 domain，捕获后写回；写盘失败只记 warning 不阻断工具执行 (covers: design/D3)
- [x] init 时恢复全部记录进内存并重算子树链接，`list` 随后同步读 (covers: design/D3)
- [x] 读取时校验子树每个成员的身份与当前会话头，不符即丢弃 (covers: design/D3, session-file-revisions/同名会话重建后旧记录不生效)
- [x] 记录字节上限进 Config，超限不写并记日志，绝不截断 (covers: design/D3, session-file-revisions/记录超过容量上限时不写入)

## 2. str_replace_editor 携带改动事实

- [x] output schema 改为对象 + oneOf（改动类携带 path/before/after/operation，view 类不携带）(covers: design/D5, session-file-revisions/编辑器创建的文件的改动被捕获, session-file-revisions/只读命令不产生改动记录)
- [x] render 保持返回逐字相同的文本，既有渲染断言不变 (covers: design/D5, session-file-revisions/结果文本保持逐字不变)
- [x] 捕获侧纳入该工具，before === null 沿用 write 的 absent/unknown 区分规则 (covers: design/D5, session-file-revisions/编辑器创建的文件的改动被捕获)

## 3. 撤销后的记录生命周期

- [x] revert 对 reverted 的路径删除记录 (covers: design/D6, session-file-revisions/成功撤销后该文件不再出现在修订记录中)
- [x] conflict / missing / unchanged 保留记录 (covers: design/D6, session-file-revisions/冲突与未变化时保留记录)

## 4. 界面

- [x] RevisionDiffPanel 改用 diffFailed 文案，移除误用的 revertFailed (covers: design/D1, session-file-revisions/读取差异失败)
- [x] 客户端保留远端错误码并按码分派文案，其它错误保留原始诊断 (covers: design/D2, session-file-revisions/本会话没有该文件的记录, session-file-revisions/无法确定会话工作区, session-file-revisions/其它失败保留原始诊断)
- [x] dock 改读 list 动词，按行判定是否提供「查看变更」与撤销；记录集合在变更列表增长时重读，不再只在挂载时读一次 (covers: design/D4, session-file-revisions/没有修订记录的文件行, session-file-revisions/有修订记录的文件行)
- [x] 「全部撤销」与逐行同一事实门控：记录集合不覆盖任何列出路径时不出现 (covers: design/D4, session-file-revisions/没有修订记录的文件行)

## 5. 测试与验证

- [x] 单元：domain 往返、身份不符丢弃（含子树成员）、超限不写、按状态清理记录 (covers: design/D7, session-file-revisions/重启后仍能查看变更, session-file-revisions/同名会话重建后旧记录不生效, session-file-revisions/记录超过容量上限时不写入, session-file-revisions/成功撤销后该文件不再出现在修订记录中, session-file-revisions/冲突与未变化时保留记录)
- [x] 真实装配：真实 ToolRuntime 经真实 tools/post-execute 捕获 str_replace_editor 的改动 (covers: design/D7, session-file-revisions/编辑器创建的文件的改动被捕获, session-file-revisions/只读命令不产生改动记录)
- [x] 客户端：diffFailed 断言、错误码分派、按行能力、增长时重读、全部撤销门控 (covers: design/D7, session-file-revisions/读取差异失败, session-file-revisions/本会话没有该文件的记录, session-file-revisions/无法确定会话工作区, session-file-revisions/其它失败保留原始诊断, session-file-revisions/没有修订记录的文件行, session-file-revisions/有修订记录的文件行)
- [x] 复核 PTC 与快照期望未被 output schema 变更破坏（tools 与 bundle 全绿，无需改动）(covers: design/D5, design/D7)
- [x] 三个包 README 同步：持久化语义、撤销清理规则、str_replace_editor 可撤销性与超限限制、记录集合重读时机 (covers: design/D3, design/D4, design/D6, design/D7)
- [x] 在真实构建产物中核验新文案与门控已编译进去，并单独验证装配关键用例 mounts every slot entry (covers: design/D1, design/D4, design/D7)
- [x] 逐条核对清单与 spec 全部 scenario、design D1-D7 的完整性并留证 (covers: design/D1, design/D2, design/D3, design/D4, design/D5, design/D6, design/D7, session-file-revisions/读取差异失败, session-file-revisions/本会话没有该文件的记录, session-file-revisions/无法确定会话工作区, session-file-revisions/其它失败保留原始诊断, session-file-revisions/重启后仍能查看变更, session-file-revisions/同名会话重建后旧记录不生效, session-file-revisions/记录超过容量上限时不写入, session-file-revisions/没有修订记录的文件行, session-file-revisions/有修订记录的文件行, session-file-revisions/编辑器创建的文件的改动被捕获, session-file-revisions/只读命令不产生改动记录, session-file-revisions/结果文本保持逐字不变, session-file-revisions/成功撤销后该文件不再出现在修订记录中, session-file-revisions/冲突与未变化时保留记录)
