# 实现清单

- [x] 在 `dsh-tool-fs/src/error.ts` 实现 `mutateWithObservedBasis`：捕获 `FS_NOT_OBSERVED` 后记录观察并重新分发意图槽位 (covers: fs-mutation-observation/变更前结算观察, design/D2)
- [x] 实现 `observeTarget`：普通文件→读取并记 present；缺失→记 absent；其他→unusable (covers: fs-mutation-observation/缺失目标由策略作答, design/D4)
- [x] 将 `write` 与 `edit` 的意图分发接入 `mutateWithObservedBasis` (covers: fs-mutation-observation/变更前结算观察, design/D1)
- [x] 收窄 `recoverMutationFailure` 为只处理仍会失败的防护变更，并在发现缺失时记录 absent (covers: fs-mutation-observation/陈旧变更仍失败并给出内容, design/D3)
- [x] 同步 `edit`/`write` 系统提示词，去掉「为满足策略而读」 (covers: fs-mutation-observation/提示词不再要求先读, design/D6)
- [x] 将 `tool-str-replace-editor` 的 `str_replace` 与 `insert` 改为先读取并发出观察、再分发意图 (covers: fs-mutation-observation/str_replace_editor 同规则, design/D5)
- [x] 更新 `dsh-tool-fs` 测试：未读变更不再失败、无需 read 调用、缺失目标与外部删除路径 (covers: fs-mutation-observation/变更前结算观察, design/D3)
- [x] 更新 `dsh-tool-str-replace-editor` 测试：未 view 的 str_replace 直接成功、字面量不匹配仍失败 (covers: fs-mutation-observation/str_replace_editor 同规则, design/D5)
- [x] 同步 29 个 `system-prompt.expected.md` 侧车与 `fs-policy-reject` 快照 (covers: fs-mutation-observation/提示词不再要求先读, design/D6)
- [x] 更新三个包的 README 与 Agent Note（新增 observation-settled-before-mutation，并在旧 note 标注被取代） (covers: fs-mutation-observation/变更前结算观察, design/D1)
- [x] 重建 `lib/` 产物并用纯 node 从 `lib/index.js` 验证产物面行为 (covers: fs-mutation-observation/产物面验证, design/D1)