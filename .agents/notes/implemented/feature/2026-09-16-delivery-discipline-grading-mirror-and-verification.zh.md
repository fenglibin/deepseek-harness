# Agent Note: 交付纪律的分级语义、任务源与实现验证

Status: implemented

## 问题

交付纪律的三处行为与其声明不符，且各自都让「功能看起来可用、实际不成立」。

**编号列表使分级失效。** `scanSignals` 把「3 条及以上编号项」计为一个 strong 命中，`gradeObjective` 又在 `strong > 0` 时返回 `l2`。实测一段 26 字符、不含任何信号词的 `1、修复登录按钮\n2、修复注册按钮\n3、修复退出按钮` 即被判 `l2`。列出多条要点是提出需求最常见的写法，因此这条规则的误判面远大于长度阈值：同一段 410 字符的真实请求在 `specChars` 取 200、300、1200 三档下均判 `l2`，仅 600 档为 `l1` —— 调高长度阈值并不能修正它。

**`l1` 没有确定性的产生路径。** `l2` 由 `agent/pre-step` 自动创建，`l1` 仅注入一次 rubric 交由模型自愿调用创建工具。模型不创建则不存在任务，进度面板也不存在。

**「实现验证」对 `l1` 空转、对 `l2` 仅形式检查。** 它依赖 `openspec show <changeId> --json`，而 `l1` 的 change id 是空串，命令必然非零退出并被当作「无需检查」直接返回；对 `l2` 也只校验 `covers:` 注解是否指向已声明的点，不核验实现。任务若从未调用 `record_tasks`，检查因记录缺失而整段放行。

## 决策

### 编号列表是可拆分性，不是规模

`scanSignals` 把编号列表从一个 strong 命中改为一个 medium 命中。可拆分对应 `l1`（出一份设计文档），而 `l2` 的语义是必须产出 OpenSpec 四件套的结构契约级变更；两者等价会让任何写成三条要点的需求无条件进入重流程。相应地，「重构 / 重写 / 升级 / 替换」这类在日常措辞中频繁出现的词也从 strong 移到 medium。

### `l1` 与 `l2` 都自动创建任务

`autoDetect` 判定为 `l1` 时同样创建任务，`l0` 保持自由执行。一致性比「单个中等信号命中是否足以施加纪律」的谨慎更重要：该档缺少确定性产生路径时，交付任务与进度面板对一整类需求根本不存在。

### 任务清单的唯一权威源由投影自己维护

`delivery-tasks` 的 fold 同时消费 `delivery/tasks`（显式记录）、`delivery/change`（自持当前任务的 `level` 与 `phase`）与 `todo/write`（`l1` 的清单镜像）。镜像让 l1 的轻量待办列表直接进入权威源，无需模型额外调用记录工具。

**被推翻的机制。** 最初的设计是让工具插件监听 `session/event` 捕获 `todo/write` 后追加一条持久 `delivery/tasks`。实测不可行：`Session.append` 禁止重入（`packages/core/session/src/index.ts` 的 `if (entry?.appending) throw new Error('session append cannot reenter while another append is being published')`），而 `session/event` 监听器正是在 `appending = true` 期间被调用的。实测输出该错误且投影保持 `null`，即写入完全失败。在 fold 内镜像则完全不写日志。

### 验证按三类输入执行四道检查

推进到 `verified` 时依次检查清单完整性、覆盖性、产物核验与逐条对账。覆盖关系由清单项内容行尾的 `(covers: <key>)` 注解承载：`req/<n>` 对应原始需求的第 n 条编号项，`design/<Dn>` 对应设计文档的 `### D<n>` 标题，`<capability>/<Scenario name>` 对应增量 spec 的 `#### Scenario:`。验收与 `openspec validate --strict --json` 从 `accepted` 前移到 `verified`，因为声称「已验证」的阶段才是必须拿出证据的阶段。用户可配置的验收此后由提示词命令承载（见[验收命令与卡片可用性](2026-09-16-delivery-acceptance-commands-and-card-usability.zh.md)），其记录要求同样在 `verified` 判定。`l0` 不参与注解覆盖：它没有清单义务，也就没有承载注解的地方。

### capability 目录从磁盘枚举，不经过 `openspec show`

`coverageGap` 原先用 `openspec show <id> --json` 取得 delta 的 capability 列表。该命令拒绝 proposal.md 未使用其英文标题（`## Why`、`## What Changes`）的 change，而中文本地化部署写 `## 为什么` 是自然选择 —— 仓库内 3 个既有 change 中有 2 个因此 `show` 失败而 `validate` 通过。命令的非零退出被当作「无需检查」，使所有 `l2` 的 scenario 点静默消失。改为直接 `listDir` 枚举 `openspec/changes/<id>/specs/`，`openspec validate` 仍是结构合法性的权威。

### 复核轮次按当前任务从会话日志计数

复核轮次原先使用模块级 `Map`，键为任务 id，因此跨会话共享预算。改为从会话日志计数，并按事件自带的 `ref.id` 过滤到当前任务：只按文本前缀计数会让同一会话中清除后新建的任务继承上一个任务的已用轮次、开局即无预算。

## 备选方案

**把编号列表保留为强信号，只调高长度阈值。** 否决：实测显示该误判由编号规则主导而非阈值 —— 同一段 410 字符请求在阈值取 200、300、1200 三档下均判 `l2`，仅 600 档为 `l1`。调阈值改变不了「列三条要点即进重流程」这一结果，等于没有修正用户报告的问题。

**`l1` 也禁用 `todo_write`，强制模型调用 `record_tasks`。** 否决：源确实会唯一，但代价是模型为一档轻量工作多调一个更重的工具，而 `todo_write` 本就是该档的自然表达。让投影镜像既保住唯一源，也不改变模型的使用方式。

**在 `agent/pre-step` 等 append 之外补写镜像事件。** 否决：可行，但把镜像推迟到下一个轮次边界，进度面板在此期间显示过期状态。投影内 fold 无延迟。

**保持 `todo` 与 `delivery-tasks` 双源，仅改 UI 分别展示。** 否决：漂移问题依旧，只是从「看不见」变成「看得见的两个互相矛盾的列表」。

**验证只做确定性判定，不设复核放行。** 否决：覆盖类差异存在模型无法在注解里表达的合理情形（例如一个需求点由多处实现），完全堵死会迫使模型写出勉强的注解。保留轮次受限的复核，但把命令核验排除在可放行范围之外。

**改用独立 verifier 子代理交叉验证实现。** 否决：强度更高，但引入额外的模型成本与时延；当前四道检查已能覆盖「模型自报状态」与「产物实证」的分界，留待按需追加。

## 后果

- 编号列表降级后，此前被判 `l2` 的多条问题式需求回到 `l1`，OpenSpec 四件套的产生频率下降。若后续发现 `l2` 过少，应通过收窄 medium 信号调整，而不是恢复编号规则。
- `l1` 自动创建提高了会话日志与进度面板的出现频率。
- 验证加强后，此前空转通过的任务首次产生阻断。
- 镜像写入沿用既有 `delivery/tasks` 事件类型与严格解码器，不提升 `SESSION_FORMAT_VERSION`；但 `l1` 从此也参与该投影，重放路径需覆盖空 change id 的情形。
- 客户端无法值导入 `LEVEL_PHASES`（`@deepseek-ai/dsh-delivery/client` 是纯类型出口，产物仅 `export {}`），因此阶段表保留 host 与 client 两份定义，并由 `delivery-phases.client.spec.ts` 断言两者相等以防分叉。

## 验证

`packages/delivery`（含 7 条走 `SessionStore` 的真实组装测试）、`packages/delivery/tool-delivery`、`packages/client/ui-delivery` 与 `packages/client/ui-settings-plugins` 的测试全部通过。四处防线经变异测试确认有效：阶段表漂移护栏（改坏客户端表即失败）、复核轮次的任务作用域（移除 `ref.id` 过滤即失败）、设置卡片的嵌套路径写入（退回标量 `set` 即失败）、以及 `l1` 镜像路径的覆盖检查（缺 `covers:` 即阻断）。
