---
description: "会话文件修订的持久化与错误归因设计草案：修正「查看变更」误报撤销失败，把修订记录持久化到侧车存储以对齐 dock 列表与修订记录的生命周期，并让 str_replace_editor 的改动也可查看与撤销。"
kind: "design-draft"
---

# 会话文件修订的持久化与错误归因设计

## 目标与范围

目标：

1. 「查看变更」失败时报它自己的错，且诊断可读。
2. 修订记录跨进程重启存活，使 dock 列表里不再出现点开必然报错的行。
3. `str_replace_editor` 的改动同样可查看、可撤销。

非目标：

- 不改变撤销的语义与安全边界（反向 patch、逐 hunk、realpath 包含检查、写盘原子性均保持）。
- 不把修订记录写进会话日志：`tool/result` 的契约与录制快照保持不动。
- 不引入第二个语言字典（仓库是单语 `zh`，见 `scripts/locale-dictionary-parity.spec.ts`）。

---

## 1. 背景与动机

「修改的文件」dock 上有两个动作：「查看变更」（读一个文件的累积差异）与「全部撤销」（把本会话的改动从磁盘移除）。两者由同一份「会话文件修订」记录支撑。当前这份记录只活在 dsh 进程的内存里，于是出现三类缺陷。

**缺陷一：错误归因错误。** `RevisionDiffPanel` 在拉取 diff 失败时复用了「撤销失败」这条文案（`packages/client/ui-session-changes/src/client/RevisionDiffPanel.tsx:104` 使用 `revertFailed`，字典定义为 `packages/client/ui-session-changes/src/client/locales.ts:25`）。该面板自身从不执行撤销——它的 `diff` 调用与撤销毫无关系。读者被告知一件没发生的事。

**缺陷二：诊断不可读。** 客户端把远端错误折叠成 `new Error(result.error.message)`（`packages/client/ui-session-changes/src/client/index.ts:83`）后直接展示，于是失败码 `session-revisions/unknown-path` 连同英文原文一起摊给读者。错误码本来就在 `RemoteFailure` 上（`packages/typert/protocol/src/types.ts:63`），却被丢掉了。

**缺陷三：数据源与生命周期不一致（根因）。** dock 的列表读宿主 `changedFiles` 投影，它折叠**完整持久日志**，进程重启后可从磁盘重建（`packages/fs/file-changes/src/projection.ts`）。而「查看变更／撤销」读 `SessionFileRevisions` 的内存 store，它挂在 `tools/post-execute` 上捕获，**完全不持久化**（`packages/fs/session-file-revisions/src/registry.ts` 无任何 storage 依赖）。两者的时间窗因此不同：列表能显示的文件，重启后每一条都点不开。

关键约束是：**修订记录无法从会话日志重放。** 日志里的 `tool/result` 只保存渲染文本与可选的 `meta`（`packages/core/agent-loop/src/tool-calls.ts:313`），而修订捕获需要的是 `before`/`after` 全文。`str_replace_editor` 的快照就是证明——`snapshots/sdk/persistent-tools/session.jsonl:49` 里结果只有一行文本。因此「从日志重建修订」这条路走不通，必须自己持久化。

---

## 2. 已确证的事实

| 事实 | 依据 |
|---|---|
| dock 列表面板在 diff 失败时用 `revertFailed` 文案 | `RevisionDiffPanel.tsx:104` |
| `revertFailed` 的文本是「撤销失败：{message}」 | `locales.ts:25` |
| 该面板只调 `diff`，从不调 `revert` | `RevisionDiffPanel.tsx:78`；`RevisionRemote` 定义于同文件 19-27 行 |
| 客户端丢弃远端错误码，只保留 message | `client/index.ts:83`、`:94` |
| 修订 store 纯内存、无持久化 | `packages/fs/session-file-revisions/src/registry.ts`（`Map` 字段，无 storage 引用） |
| 列表读的是可从日志重建的投影 | `packages/fs/file-changes/src/projection.ts:58` |
| `tool/result` 不保存结构化 value 全文 | `packages/core/agent-loop/src/tool-calls.ts:313`；`packages/core/session/src/types.ts` 的 `'tool/result'` 定义 |
| `str_replace_editor` 的结果值目前是纯字符串 | `packages/fs/tool-str-replace-editor/src/index.ts:476-478` |
| 该工具的三个 mutator 已持有 before/after | `replaceInFile` 读 `before`（:298）、`insertInFile` 读 `before`（:353）；`FsWriteOutcome` 同时给出 `before` 与 `after`（`packages/fs/fs/src/types.ts:128-144`） |
| 该工具只装配在 minimal preset 与 sdk-minimal | `packages/preset/agent-presets/presets/minimal/agent.cordis.yml:85`、`packages/bundle/sdk-minimal/cordis.patch.yml:119` |
| 工具 schema 快照只含 name/description/parameters，不含 output | `snapshots/sdk/text-turn/tool-schemas.expected.json` 的 `initial` 结构 |
| `list` 动词在客户端类型面已可用，且当前无消费者 | `packages/api/session-file-revisions/lib/typert.remote-client.d.ts`；全仓库无 `.list(` 业务调用 |
| 持久化 API 是 `storageDomain.open(spec)` → `domain.table(name)` → `KvTable` | `packages/session/session-projection-cache/src/index.ts:143-145`；`KvTable` 定义于 `packages/storage/storage-domain/src/domain.ts:42-90` |
| `storage-domain` 与 `storage-json` 在 base bundle 中，web profile 继承 | `packages/bundle/base/cordis.patch.yml:194-200`；`packages/bundle/web-app/cordis.patch.yml` 头部声明它是在 base 之上的补丁层 |
| `revert` 成功后不清理记录 | `packages/api/session-file-revisions/src/index.ts:143-153`（`forget` 从未被调用） |
| 工具快照只记 name/description/parameters，output 不进快照 | 遍历 `snapshots/sdk/*/tool-schemas.expected.json` 得到的键并集为这三个 |
| 但 output schema 会投影进 PTC 模式的 SDK 文本 | `packages/core/tools/src/index.ts:1230-1244`（`sdkSchemas`）、`:881`（`SDK_RENDERERS` 渲染） |
| `output.schema` 会被用于校验工具返回值 | `packages/core/tools/src/index.ts:1786`；必填 `{ schema, render, presentationMeta? }` 见 `:1030-1036` |

---

## 3. 设计决策

### D1 文案归因：面板报自己的错

`RevisionDiffPanel` 使用新的 `diffFailed`（「查看变更失败：{message}」）替换 `revertFailed`。该面板从不撤销，`revertFailed` 留给 dock 的 `revertAll` 路径（`SessionChangesDock.tsx:459`）。

### D2 诊断按错误码分派，而不是摊开远端英文

客户端不再把 `result.error.message` 直接当文案。`remoteVerbs` 保留错误码，交给面板按码选择文案：

| 错误码 | 读者看到的话 |
|---|---|
| `session-revisions/unknown-path` | 本会话没有记录该文件的改动，无法显示变更 |
| `session-revisions/no-workspace` | 无法确定该会话的工作区，无法显示变更 |
| 其它 | 查看变更失败：{message}（兜底，保留原始诊断） |

错误码本来就在 `RemoteFailure` 上（`packages/typert/protocol/src/types.ts:63`），只是当前被丢弃。仓库已有保留码的先例（`packages/client/ui-settings-skills/src/client/index.ts:47`）。

### D3 修订记录持久化到侧车存储

新增一个 storage domain，把每个会话的修订记录写到磁盘，使它在进程重启后仍可读。这是缺陷三的根治手段。

- **domain**：`name: 'session_file_revisions'`，`layout: 'per-record'`（一个会话一份文档），表 `sessions` 以 `SessionId` 为键。按会话分记录使版本升级只丢弃陈旧记录，而不是整个介质（与 `session_projcache` 同构，见 `packages/session/session-projection-cache/src/spec.ts`）。
- **记录内容**：该会话自己与子代理的全部修订（`FileRevision[]`），连同绑定用的会话身份字段（`createdAt`、`cwd`）。
- **写入点**：捕获到一次改动后写回。写盘失败不阻断工具执行——修订是能力增强，不是主流程前置条件；失败记一条 warning。
- **读取点**：服务 `init` 时把域内全部记录恢复进内存，`list(sessionId)` 随后是同步读。选在 init 恢复而不是按需回落，是因为该动词同步返回，而按需回落要把 await 穿过每一层读取。
- **身份校验**：记录绑定 `createdAt`/`cwd`，与当前会话头不符则丢弃。理由与会话投影缓存相同（`packages/session/session-projection-cache/src/spec.ts:33-41`）：会话 id 是一个槽位，不是一次生命周期，被删除后重建的同名 id 不能让旧记录继续生效。

容量：单会话记录含全部改动文件的两个全文版本，因此设一个字节上限（沿用 `session-projection-cache` 的 `maxRowBytes` 模式，配置项放 `Config`）。超限时**不写**并在日志中说明，而不是静默截断——截断的基线会让撤销写出错误内容。

### D4 列表按行判定能力，不再出现必然报错的行

客户端改为读宿主已有的 `list` 动词（当前无消费者），用它的 `entries` 决定每一行是否提供「查看变更」「撤销」。

这样列表与修订记录读的是同一份权威事实，缺陷三在界面上的表现消失：没有修订记录的文件行不显示按钮，而不是给出一个点开必然失败的按钮。

`list` 只返回摘要（path/operation/origin/行数/oversized），不返回全文，因此首屏不搬运文件内容。

### D5 `str_replace_editor` 携带结构化改动事实

该工具当前的结果值是纯字符串（`packages/fs/tool-str-replace-editor/src/index.ts:476-478`），修订捕获看不到前后内容。改为对象结果，用 `oneOf` 区分两类返回值：

- **改动类**（`create` / `str_replace` / `insert`）携带 `{ path, before, after, operation }`，其中 `before` 可为 `null`。
- **只读类**（`view`）不携带这些字段。

`render` 保持返回与当前**逐字相同**的文本，因此模型可见输出不变、既有测试断言（`tests/tools.spec.ts` 断言渲染文本）不变。

捕获侧据此把该工具纳入 `MUTATION_TOOLS`。`mutation.ts` 已经把它算作变更（`packages/fs/file-changes/src/mutation.ts:34`），因此这一步让列表与可操作性重新对齐。

三个 mutator 都已持有两侧内容：`replaceInFile` 读 `before`（`:298`）、`insertInFile` 读 `before`（`:353`），且 `FsWriteOutcome` 同时给出 `before` 与 `after`（`packages/fs/fs/src/types.ts:128-144`）。`before === null` 的歧义处理沿用 write 的既有规则：只有真正的新建才算 `absent`。

`oneOf` 要求至少两个分支（`packages/core/tools/src/json-schema.ts:290-296`），此处正好两类。

### D6 撤销成功后清掉该路径的记录

`revert` 当前不清理记录（`packages/api/session-file-revisions/src/index.ts:143-153` 里 `forget` 从未被调用）。内存态下这只是让「已撤销」的行留在列表里；一旦持久化，同一条记录会跨重启一直存活，读者会反复看到一个已经没有改动的文件。

调整：`revert` 对 `status` 为 `reverted` 的路径删除其记录；`conflict` / `missing` 保留，因为文件上仍有本会话的改动待处理。`unchanged` 也保留——撤销没有实际发生，记录仍是描述现状的唯一依据。

### D7 验证策略

- **单元**：domain 记录的往返（写→重建服务→读回）；身份不符时丢弃；超限时不写；`revert` 后按状态清理记录。
- **真实装配**：沿用既有 `capture-e2e.spec.ts` 的形态（真实 `ToolRuntime` + 真实 `tools/post-execute`），补 `str_replace_editor` 的捕获，以及「重启后仍能读到修订」。
- **客户端**：`revision-diff.client.spec.tsx` 改断言到 `diffFailed`；新增按行能力（无记录的行不显示按钮）与错误码分派的用例。
- **快照**：工具 schema 快照只记 `name/description/parameters`，改 output 不波及；但 PTC 模式的 SDK 文本会带上新 output schema，若 `ptc.spec.ts` 的期望受影响的，在同一变更内更新。
- **文档**：三个包的 README 同步（含新 domain 的持久化语义、`revert` 的清理规则、`str_replace_editor` 的可撤销性）。

---

## 4. 影响面

| 包 | 改动 |
|---|---|
| `packages/fs/session-file-revisions` | 新增 domain spec 与持久化读写；把 `str_replace_editor` 纳入捕获；`forget` 的调用点 |
| `packages/api/session-file-revisions` | `revert` 后按状态清理记录 |
| `packages/client/ui-session-changes` | 新文案键；错误码分派；按行能力判定；读 `list` 动词 |
| `packages/fs/tool-str-replace-editor` | output schema 改为对象 + `oneOf`；`render` 保持不变 |
| 装配 | 若 domain 需要显式配置，在 base/web-app 的 `cordis.patch.yml` 相应条目上补充 |

---

## 5. 风险与未决

- **`str_replace_editor` 的 output 变更触及 PTC SDK 文本**。`sdkSchemas()` 会把 output 投影进 Python/TS 的 SDK 渲染（`packages/core/tools/src/index.ts:881`、`:1230`）。这属于「public API 变更」，需要在同一变更内更新 `ptc.spec.ts` 的期望。
- **持久化引入磁盘增长**。每个被改动文件的两个版本被保存，长会话加多文件会累积。`maxRowBytes` 是硬上限，但「超限就不写」意味着超大改动的会话退回今天的行为——需要在 README 的已知限制里写明。
- **撤销后清理记录改变了 `list` 的输出**。若将来有别的消费者依赖「历史改动清单不变」，需要重新评估；当前 `list` 无消费者，风险为零。
- **`str_replace_editor` 只装 minimal preset 与 sdk-minimal**，web GUI 用不到它。因此 D5 在本轮的读者可见收益为零，价值在于消除「列表显示但不可操作」的不一致，并为将来把该工具装进 web profile 时不留缺口。若你希望缩小本轮范围，D5 是唯一可以单独摘出的一项。
