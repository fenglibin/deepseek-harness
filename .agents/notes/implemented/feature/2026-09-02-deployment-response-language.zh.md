# Agent Note: The deployment names the language the model answers in

Status: implemented

## Problem

在中文桌面上，Web 界面自身的文案早已是中文——自[客户端文案由 locale 拥有的决策](../architecture/2026-08-23-locale-owned-client-ui-copy.zh.md)起，`verify-client-ui-i18n` 与字典一致性检查就在强制这一点——但任务*执行过程中*页面展示的一切仍是英文。助手的正文、计划与总结，以及每一份子智能体汇报都是模型输出，而装配出的系统提示词从未提到任何语言。模型于是回退到其提示词所用语言，也就是英文，结果是中文用户得到的是一个中文外壳包着的英文智能体。

有两个事实让朴素的修法行不通。其一，用户看到的语言在浏览器中决定，而它唯一的持久副本——设置文档中的 `locale.preference`——只在有人显式选择语言时才写入；新页面由浏览器推导出的语言是刻意设计的临时值，从不落盘。其二，系统提示词有多个所有者：部署 persona 位于 `dsh-system-prompt` 的配置中，而每个已发布的 agent 预设都会用自己的 persona 遮蔽它，因此写进 persona 的文本无法在预设下存活。

## Decision

**新增一个宿主 row `dsh-response-language`，注册一个指明语言的提示词段落。** 它是 `systemPrompt` 与可选 `settings` 服务的 Consumer，自身不定义任何服务。该段落位于新分配的集中顺序 `RESPONSE_LANGUAGE`（−950），紧随 harness 身份声明之后、检出路径与 Web 界面说明之前，使语言声明紧邻它所限定的身份声明。

**默认值 `auto` 先读取界面语言，再读取宿主进程自身的区域设置。** 第一个能指名语言的信号即决定结果，而本 row 目前只为 `zh` 发布指令。因此中文宿主上的英文界面选择会生效且不产生段落，而法语宿主不会被要求用英文作答。宿主信号依次读取 `LC_ALL`、`LC_MESSAGES`、`LANG`，最后是 ICU 默认值；`C` 与 `POSIX` 被视为没有指明任何语言。英文解析为「无段落」，因为英文是模型无需指令就会使用的语言，这也让已提交的整套录制快照无需重新录制。

**该段落以文本提供者而非字符串注册，因此两个信号各自按其节奏被读取。** 宿主进程的区域设置在进程生命周期内固定，于激活时采样一次；界面语言是实时设置，通过 `ctx.get('settings')` 在每次装配时读取，因此切换语言会在下一步生效，无需重启。当没有适用指令时「不注册段落」以空文本表达——提示词注册表会在渲染时丢弃空段落，因此「无指令」不需要条件式注册，也不会留下空段落。

**`locale` 设置命名空间以字面字符串读取，而不是导入。** 该命名空间属于 `dsh-client-locale`——一个浏览器包，其宿主半区负责注册它。导入那个常量会让宿主 row 对 Web 客户端产生生产依赖，并把它拖进每一个 composition，包括 headless 场景。这次读取天然是容错的：对于无人注册的命名空间，`settings.get` 返回 `undefined`。

**每一套录制快照 composition 与 Web e2e scaffold 都固定 `language: en`。** 回放使用每次运行独立的 `DSH_HOME`，因此已保存的界面偏好无法影响它们，但 `LANG` 会从运行测试套件的机器继承——而本仓库是中文优先的，维护者经常在中文桌面上运行它。没有这个固定，每一份已提交的 `system-prompt.expected.md` 都会在那些机器上失配。固定值位于每个 headless 场景都叠加的共享 `default` composition、八个自带 composition 的 SDK 场景、两个 ACP 录制补丁、两份已录制的 SDK 子 composition，以及 Web scaffold 的密封补丁列表中。

## Alternatives considered

**把语言语句写进部署 persona。** 已否决：四个已发布的预设都挂载 `dsh-persona` 并遮蔽 `deployment:persona`，因此该语句在每个普通会话中都会消失；而 `minimal` 会把它的 persona 还原为*完整*提示词。语言要求属于部署的属性，不属于任何 agent 的身份。

**把文本放进 Web 应用的 `app:web-surface` 段落。** 已否决：Web bundle 是浏览器 surface，不是语言的所有者；而且该段落会被 `surfaceContext: false` 抑制——那恰恰是非交互层所用的配置。该要求对 headless、ACP 与 SDK 会话同样成立。

**给 `dsh-system-prompt` 自身的配置加一个 `responseLanguage` 字段。** 已否决：那样该包就会依赖 `locale` 设置命名空间与宿主环境探测，而它拥有的是提示词*装配*，不是任何一项部署策略。独立成 row 能把策略、默认值与测试集中在一处，并让 `dsh-system-prompt` 免于引入设置依赖。

**让客户端持久化浏览器推导出的区域设置，以便宿主机读取。** 已否决其作为本次改动的机制：那会让某个浏览器的一次临时探测在整个 DSH home 上持久生效，改变「新浏览器以临时语言启动」的语义。宿主环境在不触及 locale 包语义的前提下覆盖了这种情况，而显式的界面选择一旦存在仍然优先。

**对英文也输出指令。** 已否决：那会让全部 32 份录制的系统提示词依赖录制机器的区域设置，而没有任何行为收益——英文本就是模型的默认语言。重新录制需要可用的 API key，手工修改这些 fixture 可能与录制器实际产出的内容产生偏差。

**把指令注册为运行时上下文而非段落。** 已否决：`suppressRuntimeContext`（`minimal` 预设与 persona row 都可调用）会丢弃上下文，而这条指令必须穿过它。此外段落会传播到子智能体，其装配会合并全局层。

## Consequences

中文桌面现在无需配置即可得到用中文回答的智能体，且覆盖所有 profile：该 row 随 `dsh-base` 发布，因此 Web、headless、ACP 与 SDK 会话都会携带它。英文桌面逐字节不变，这也是没有任何录制 fixture 变动的原因。

代价是提示词现在依赖环境状态。两个随部署而变的输入——一个设置段与进程环境——参与塑造模型请求，因此每个回放 golden 与 Web scaffold 都固定语言，而不是继承机器状态。新增快照 composition 的维护者也必须固定它，否则就要接受一份只在自己桌面上通过的 fixture。

该指令覆盖全局段落所能到达的一切，也放过预设所抑制的一切：`minimal` 仍然得不到语言指令，因为它的 persona 就是完整提示词；而希望在中文宿主上保持沉默的部署可设置 `language: off`。新增一种语言只需在 `DIRECTIVES` 映射中加一项并补上联合类型成员——解析、空文本放弃输出以及测试全部由该映射派生。
