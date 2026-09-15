# Agent Note: 技能管理面读取文件系统真相

Status: implemented

## 问题

技能（skill）此前只有只读通路：模型侧 `skill` 工具、用户侧 `/name` 命令，以及宿主 `skills/list`。新增一个技能只能在磁盘上手工创建 `<name>/SKILL.md` 或 `<name>.md` 并手写 YAML frontmatter，设置里没有任何入口。设置 →「插件」下的两个页签分别管理 Cordis 插件与可配置插件卡片，都不涉及技能。

要加一个管理面，第一件事是决定它读的是什么。`ctx.skills` 注册表返回合并去重后的胜出摘要：同名的落败项不可见，条目没有绝对路径，frontmatter 非法的文件被静默跳过并只留下一条警告。对「列出并编辑磁盘上的技能」这件事，这三项恰好都是必需的——重名要能看出谁遮蔽了谁，改写与删除要拿到路径，非法文件要能被指出并修复。注册表还按 scope 分层，而设置面板不属于任何会话，没有天然的 scope。

第二个问题是写入目标。技能发现对 cwd 敏感，根解析依赖 `dshHome`、`agentsHome`、`customSkillDirs`、`bundledSkillDir` 与项目根查找。管理插件若自行推导这些，两边配置一旦不同就会出现「界面写入了发现器不扫描的目录」，而这类错误只在模型看不到刚建的技能时才暴露。

## 决策

**管理面新增独立的 `skillAdmin` Remote 命名空间，不扩展 `skills`。** 后者服务于输入框的 `/` 补全：按会话寻址、只返回用户可调用的合并条目、只有 `list`。让这个只读的会话视图承担管理职责，会把两种语义压进一个命名空间。两者并存。删除方法名为 `delete` 而不是 `remove`：客户端装配把命名空间方法装到命名空间服务自身，而 `RemoteNamespaceService.prototype.remove` 是它卸载方法用的成员，同名会被 `assertMethodAvailable` 拒绝（`client api: method "skillAdmin/remove" conflicts with its namespace service`），仓库既有命名空间也都用 `delete`。

**管理面的条目类型叫 `SkillAdminEntry`，且它的 wire 模块自包含。** 两个命名空间的词汇表在同一个门面（`@deepseek-ai/dsh-api-remotes/client`）里相遇，而管理面的磁盘条目与会话目录的 `SkillEntry` 语义不同（前者带 entryId/path/form，后者只有 name/description/modelInvocable），因此管理面一侧带 `SkillAdmin` 前缀，目录一侧保留 `SkillEntry`。`types.ts` 又是 Client 编译面要编译的模块，而 Client 面到不了 host 包的源码，所以它命名的两个 `dsh-skill` 形状（`SkillSource`、`SkillInvocationPolicy`）在该模块内陈述；host 侧的值在每个使用点仍然可赋值，漂移由那些赋值点报错。

**管理视图扫描文件系统真相。** 每个被扫描的根返回其直接条目，包括同名落败项与 frontmatter 不可用项。遮蔽按 rank 计算并在条目上标出。不可用项携带它被丢弃的原因，因此界面是唯一能看见它们的地方。

**根定义由 `dsh-skill-filesystem` 暴露。** 该包新增只读服务 `ctx.skillRoots`（`SkillRootInfo`：path/source/rank/projectRoot/readOnly），复用其既有的私有根解析。管理插件注入它，因此不存在第二份配置。函数式插件用 `ctx.provide` 注册该服务即可，无需引入 Service 子类——生命周期随 fiber 释放。

**该服务只由部署级实例发布，Web 组合因此启用 host 的 `skill-filesystem` 行。** Cordis 服务只有一个提供方：preset 也挂载自己的实例，两次 `provide` 会让 preset 挂载直接失败（`service "skillRoots" has been registered`），而 `ctx.skills` 的注册表是分层的、本可以同时接受两者。因此 `skill-filesystem` 只在 `scopeOf(ctx) === undefined` 时发布该服务，scope 实例只向本 scope 的注册表层贡献目录；Web 组合不再禁用 base 的 host 行，它就是这个部署级实例。代价是全局层同时承载部署级的本地发现（此前由 preset 独占），因此 plane-separation 门禁为这一行加了有依据的例外，preset 侧的发现断言也随之改写在真实组合 e2e 中。scope 实例的根（cordis preset 指向自己包内 `skills/` 的那个 `customSkillDirs`）仍归该 preset，不进管理面的根列表。

**项目根由客户端显式传入，不猜测。** 读与写请求都携带可选的 `projectRoot`，由界面从 `useWorkspaces` 取当前工作区填入；未提供时只呈现全局根。设置面板没有会话，猜一个 cwd 会把技能写到用户没预期的位置。

**文件操作走 Node 文件系统而非 `ctx.fs`。** 后者没有删除与建目录能力（其抽象方法是 resolve/stat/readText/listDir/writeText/editText），而管理面需要 `mkdir -p` 与递归删除。混用会让部分操作受 `fs-sandbox` 约束、部分不受，产生两套语义。管理面是宿主受信路径，语义上是用户通过界面操作自己的配置目录，与会话沙箱要约束的模型文件操作不同。写入复用 `@deepseek-ai/dsh-util-atomic-write`。

**frontmatter 按行局部编辑。** 调用开关与描述的改写若整体重写文件，会抹掉用户写在 frontmatter 里的注释与键序。改为在块内按顶层键名定位一行改写，未命中的键追加到块尾，正文单独按解析偏移替换。调用开关写显式布尔值而不是删键：两个键的「省略即允许」默认方向相反（`disable-model-invocation` 省略为允许模型调用，`user-invocable` 省略为允许用户调用），只有写显式值才能让用户在文件里读到当前策略。

**只有 `bundled` 根只读。** 它随部署交付。其余根可写，包括 `customSkillDirs` 声明的根——那本身就是部署方显式指定为技能根目录的路径，为它再加一个默认关闭的开关缺乏依据。

**写入后用同一次扫描重新确认条目存在。** 写成功但发现不到（例如根解析在两次调用间变化）作为失败报出，而不是静默成功。

**导入分两阶段，且解包只接受描述得清楚的成员。** `previewImport` 抓取并解包到内存、返回文件清单与 SKILL.md 正文而不写盘；`commitImport` 依据预览标识落盘，而预览被取走即失效，因此同一份批准不会被写两次。解包用 `fflate` 解 zip、Node 的 `zlib.gunzipSync`（带 `maxOutputLength`）解 gzip，tar 结构按受控子集自解析：类型不是普通文件或目录的成员（链接、设备、PAX 与 GNU 长名扩展）一律拒绝，路径穿越、绝对路径、盘符、空段、超限体积与成员数同样拒绝。理由是预览若不能保证「列出的文件等于落盘的文件」就是虚假的保证，而把拒绝项写成显式分支比依赖第三方解包器的默认行为更可审查。GitHub 来源走 contents API 逐文件读取而非下载归档，于是技能位于子目录与位于仓库根是同一条路径。

**导入不覆盖既有条目。** 目标目录已存在时提交被拒绝，即便预览已标出会替换——目标里可能有这次导入并不知晓的文件。这与 `create` 的既有语义一致，代价是「更新一个已安装的技能」需要先删除再导入两步。

**路径校验是所有来源共用的最后一道关。** 归档成员与仓库清单行都经同一个 `safeEntryPath`，且写入前再用 `contains` 复核一次落点。仓库清单不能只校验前缀：一行 `s/../evil.md` 前缀合法、剥离后却是 `../evil.md`，若不经统一校验就会拼到目标目录之外。

**体积上限以实际字节为准，不以声明为准。** 仓库清单里的 `size` 只是 API 的说法，真正写入的是下载回来的字节，因此单文件与合计上限都在拿到响应后重算；归档侧同理，zip 在解压前按声明体积拒、tar 按展开后的长度拒。

## 曾考虑的替代方案

**扩展现有 `skills` 命名空间，加 `create`/`update`/`delete`。** 不予采纳，因为该命名空间按会话寻址且返回合并视图；管理面需要的是按工作区寻址的磁盘真相。两者混在一个命名空间里，消费方无法从方法名判断自己拿到的是哪一种。

**把管理面的条目类型也叫 `SkillEntry`。** 不予采纳：门面同时承载两个命名空间的词汇，同名会让既有消费方（`ui-skill` 的 `/` 补全读的是会话目录条目）静默拿到管理面的类型，而编译错误会落在与本次改动无关的包上。

**让 `types.ts` 继续从 `@deepseek-ai/dsh-skill` 取那两个形状。** 不予采纳：该模块由 Client 编译面编译，而 Client 面无法编译 host 包的源码（`tsconfig.client.json` 会以 rootDir 报错）；`dsh-host-plugin-inventory` 的 `types.ts` 已经是自包含的同一先例。

**管理插件自行解析根目录。** 不予采纳，因为根解析依赖发现器的配置，两边独立推导必然漂移，而漂移的后果是静默的（写入成功但模型看不到）。

**在注册表上新增一个返回路径与 rank 的管理专用读方法。** 不予采纳，因为那会让发现缓存承担管理语义：注册表缓存以 scope 链为键、按 revision 失效，而磁盘真相不随这些变化。管理面直接扫描，代价是每次读取都访问文件系统，收益是它读到的就是磁盘当前的样貌。

**保留 `custom` 根默认只读，另加一个开关。** 不予采纳，因为缺乏支持的默认值。`customSkillDirs` 是部署方的显式选择，写入它符合该配置的意图。

**为解包外部压缩包自写 zip 解析。** 不予采纳：zip 的中央目录、数据描述符与 zip64 是自写容易出错的部分，而 `fflate` 已在 `session-log-export` 与 `apps/web` 使用。自写的只是 tar 的受控子集，因为那里要表达的是「拒绝什么」，用显式分支比配置第三方解包器更可审查。

**用 Node 的 `zlib.gunzipSync` 而非 `fflate` 解 gzip。** 采纳前者：`maxOutputLength` 让解压炸弹在展开之前失败，而 `fflate` 的同步接口没有等价的上界。

## 后果

收益是界面能看到发现器看不见的东西：被遮蔽的同名技能、frontmatter 非法而静默丢弃的文件、以及每个条目的绝对路径。写入落在发现器真正扫描的目录，因为根来自提供方本身而不是第二份配置。

代价有四处。其一，管理面每次读取都访问文件系统，不走注册表的发现缓存——这是刻意的，缓存以 scope 链为键并随 revision 失效，而磁盘真相不随这两者变化。其二，`fs/observed` 的同步失效只对第一方 `write`/`edit` 工具的调用生效，界面写入没有工具身份，因此模型侧可见性依赖监视器：已存在的根在下一个模型步骤前刷新，而此前不存在的根按路径段轮询，首次创建存在探测延迟。其三，条目身份是绝对路径的品牌包装，改名即变，尚无稳定句柄。其四，frontmatter 编辑是行级的，把值写成多行块或使用锚点的文件会在块尾得到新增的一行而不是原地替换。

本次改动不修改 `SessionEventMap`、不涉及会话日志，也不改变面向模型的目录渲染，因此两台 SDK 的期望输出与录制快照不受影响。

## Deferred

导入不覆盖既有条目——目标已存在时拒绝，先删除或改名再导入，因此「更新一个已安装的技能」尚需手工两步。覆盖率门禁未验证，且组合测试是程序化挂载真实包而非经 Loader 引导 `cordis.yml`——Loader 的行由 Node 解析、只能到达已构建的 `lib/`，而测试运行在源码面。
