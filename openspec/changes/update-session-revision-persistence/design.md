# 技术决策

完整草案见 `docs/design/session-revision-persistence.zh.md`；此处记录决策要点。

### D1 文案归因：面板报自己的错

`RevisionDiffPanel` 改用新的 `diffFailed`（「查看变更失败：{message}」）替换 `revertFailed`。该面板只调 `diff`、从不撤销，`revertFailed` 留给 dock 的 `revertAll` 路径（`SessionChangesDock.tsx:459`）。

### D2 诊断按错误码分派

客户端不再把 `result.error.message` 直接当文案，保留 `RemoteFailure` 上的 `code` 按码选文案：`session-revisions/unknown-path` 说明「本会话没有记录该文件的改动」，`session-revisions/no-workspace` 说明工作区无法确定，其余保留原始诊断作兜底。仓库已有保留码的先例（`packages/client/ui-settings-skills/src/client/index.ts:47`）。

### D3 修订记录持久化到侧车存储

新增 storage domain：`name: 'session_file_revisions'`，`layout: 'per-record'`，表 `sessions` 以 `SessionId` 为键。API 走 `storageDomain.open(spec)` → `domain.table(name)` → `KvTable`（`packages/storage/storage-domain/src/domain.ts:42-90`）；`storage-domain` 与 `storage-json` 已在 base bundle（`cordis.patch.yml:194-200`），web profile 继承，domain 由 `storage-domain` 自动路由。

记录绑定会话身份字段（`createdAt`、`cwd`），与当前会话头不符即丢弃——会话 id 是槽位而非生命周期，被删除后重建的同名 id 不能让旧记录继续生效（理由同 `packages/session/session-projection-cache/src/spec.ts:33-41`）。

捕获后写回；写盘失败不阻断工具执行，只记 warning。设字节上限（`Config` 字段，沿用 `maxRowBytes` 模式），超限**不写**并记日志，绝不截断——截断的基线会让撤销写出错误内容。

### D4 列表按行判定能力

客户端改读宿主已有的 `list` 动词（当前无消费者），用其 `entries` 决定每行是否提供「查看变更」「撤销」。`list` 只返回摘要（path/operation/origin/行数/oversized），不返回全文，首屏不搬运文件内容。

### D5 str_replace_editor 携带结构化改动事实

该工具结果值当前是纯字符串（`packages/fs/tool-str-replace-editor/src/index.ts:476-478`），捕获看不到前后内容。output schema 改为对象并用 `oneOf` 区分两类：改动类（`create`/`str_replace`/`insert`）携带 `{ path, before, after, operation }`（`before` 可为 `null`），只读类（`view`）不携带。`oneOf` 要求至少两个分支（`packages/core/tools/src/json-schema.ts:290-296`），此处正好两类。

`render` 保持返回与当前逐字相同的文本，模型可见输出与既有渲染断言不变。捕获侧据此把它纳入 `MUTATION_TOOLS`；`file-changes/src/mutation.ts:34` 本就把它算作变更，这一步让列表与可操作性重新对齐。

三个 mutator 已持有两侧内容：`replaceInFile` 读 `before`（`:298`）、`insertInFile` 读 `before`（`:353`），`FsWriteOutcome` 同时给出 `before` 与 `after`（`packages/fs/fs/src/types.ts:128-144`）。`before === null` 的歧义沿用 write 的既有规则：只有真正的新建才算 `absent`。

### D6 撤销后按状态清理记录

`revert` 当前从不调用 `forget`（`packages/api/session-file-revisions/src/index.ts:143-153`）。内存态下只是让已撤销的行留在列表；持久化后同一条记录会跨重启存活，读者会反复看到一个已无改动的文件。调整为：`reverted` 删除记录；`conflict` / `missing` 保留（文件上仍有本会话改动待处理）；`unchanged` 保留（撤销未实际发生，记录仍是描述现状的唯一依据）。

### D7 验证策略

单元覆盖 domain 往返、身份不符丢弃、超限不写、按状态清理；真实装配沿用 `capture-e2e.spec.ts` 形态（真实 `ToolRuntime` + 真实 `tools/post-execute`）补 `str_replace_editor` 捕获与重启后可读；客户端补 `diffFailed` 断言、按行能力、错误码分派。工具 schema 快照只记 `name/description/parameters`，改 output 不波及；但 PTC 的 `sdkSchemas` 会把 output 投影进 SDK 文本（`packages/core/tools/src/index.ts:881`、`:1230`），若相关期望受影响需在同一变更内更新。
