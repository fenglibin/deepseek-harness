/** 插件设置分区及其各插件卡片的文案包。 */

/** 这些界面渲染的文案键。 */
export type PluginsSettingsLocaleKey =
  | 'nav' | 'title' | 'intro' | 'tabs' | 'configurableTab' | 'empty'
  | 'overridden' | 'reset' | 'readOnly' | 'expand' | 'collapse'
  | 'save' | 'saving' | 'discard' | 'unsaved' | 'saveFailed' | 'invalidNumber'
  | 'bashTitle' | 'bashDescription' | 'bashTimeoutMs' | 'bashTimeoutMsHint'
  | 'bashMaxOutputBytes' | 'bashMaxOutputBytesHint'
  | 'agentLoopTitle' | 'agentLoopDescription' | 'agentLoopMaxParallel' | 'agentLoopMaxParallelHint'
  | 'webSearchTitle' | 'webSearchDescription'
  | 'webSearchApiKey' | 'webSearchApiKeyHint' | 'webSearchApiKeySet' | 'webSearchApiKeyUnset'
  | 'webSearchBaseUrl' | 'webSearchBaseUrlHint' | 'webSearchMaxUses' | 'webSearchMaxUsesHint'
  | 'subagentModelSelectionTitle' | 'subagentModelSelectionDescription'
  | 'subagentModelSelectionToggle' | 'subagentModelSelectionChoose' | 'subagentModelSelectionAllowed'
  | 'subagentModelSelectionLoading' | 'subagentModelSelectionLoadFailed' | 'subagentModelSelectionRetry'
  | 'subagentModelSelectionPartial' | 'subagentModelSelectionUnavailable'
  | 'subagentModelSelectionUnavailableGroup' | 'subagentModelSelectionEmpty'
  | 'subagentModelSelectionRequired' | 'subagentModelSelectionConflict' | 'subagentModelSelectionOff'
  | 'deliveryTitle' | 'deliveryDescription'
  | 'deliveryEnforcement' | 'deliveryEnforcementHint'
  | 'deliveryEnabled' | 'deliveryEnabledHint'
  | 'deliveryAutoDetect' | 'deliveryAutoDetectHint'
  | 'deliveryRequireOpenspecForBugs' | 'deliveryRequireOpenspecForBugsHint'
  | 'deliveryMaxReviewRounds' | 'deliveryMaxReviewRoundsHint'
  | 'deliveryDesignTodoCount' | 'deliveryDesignTodoCountHint'
  | 'deliveryDesignFiles' | 'deliveryDesignFilesHint'
  | 'deliverySpecTodoCount' | 'deliverySpecTodoCountHint'
  | 'deliverySpecChars' | 'deliverySpecCharsHint'
  | 'deliveryGradingPrompt' | 'deliveryGradingPromptHint'
  | 'deliveryVerificationCommands' | 'deliveryVerificationCommandsHint'
  | 'deliveryVerificationEmpty' | 'deliveryVerificationMissing'
  | 'deliveryVerificationSelected' | 'deliveryVerificationSelectedEmpty'
  | 'deliveryVerificationCandidates' | 'deliveryVerificationRemove'
  | 'deliveryVerificationMoveUp' | 'deliveryVerificationMoveDown'
  | 'deliveryVerificationDragHint' | 'deliveryVerificationDragHandle'
  | 'invalidBoolean' | 'invalidEnum' | 'useDefault'
  | 'deliveryHelpLink' | 'close'
  | 'deliveryHelpArtifactsHeading'
  | 'deliveryHelpArtifactsNote'
  | 'deliveryHelpAutoDetect'
  | 'deliveryHelpConfigHeading'
  | 'deliveryHelpConfigNote'
  | 'deliveryHelpCoverExample'
  | 'deliveryHelpCoversHeading'
  | 'deliveryHelpCoversNote'
  | 'deliveryHelpGradingPrompt'
  | 'deliveryHelpDesignFiles'
  | 'deliveryHelpDesignTodoCount'
  | 'deliveryHelpEnabled'
  | 'deliveryHelpEnforcement'
  | 'deliveryHelpFlowHeading'
  | 'deliveryHelpFlowNote'
  | 'deliveryHelpFooter'
  | 'deliveryHelpIntro'
  | 'deliveryHelpMaxReviewRounds'
  | 'deliveryHelpVerificationCommands'
  | 'deliveryHelpRequireOpenspecForBugs'
  | 'deliveryHelpSpecChars'
  | 'deliveryHelpSpecTodoCount'
  | 'deliveryHelpTierL0'
  | 'deliveryHelpTierL1'
  | 'deliveryHelpTierL2'
  | 'deliveryHelpTiersHeading'
  | 'deliveryTierL0Name' | 'deliveryTierL1Name' | 'deliveryTierL2Name'
  | 'deliveryHelpVerifyHeading'
  | 'deliveryHelpVerifyIntro'
  | 'deliveryHelpVerifyRelease'
  | 'deliveryHelpVerifyStep1'
  | 'deliveryHelpVerifyStep2'
  | 'deliveryHelpVerifyStep3'
  | 'deliveryHelpVerifyStep4'

/** 简体中文文案。 */
export const zh: Record<PluginsSettingsLocaleKey, string> = {
  nav: '插件',
  title: '插件',
  intro: '配置和查看本部署已安装的插件。',
  tabs: '插件视图',
  configurableTab: '插件配置',
  empty: '本部署没有开放任何插件设置。',
  overridden: '已覆盖',
  reset: '恢复默认',
  readOnly: '本部署的设置为只读。',
  expand: '展开设置',
  collapse: '收起设置',
  save: '保存',
  saving: '保存中…',
  discard: '放弃修改',
  unsaved: '未保存',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  invalidNumber: '请填数字；留空表示使用默认值。',
  bashTitle: '终端',
  bashDescription: '限制 agent 运行的每一条命令。',
  bashTimeoutMs: '命令超时（毫秒）',
  bashTimeoutMsHint: '单条命令允许运行多久，超时即终止。',
  bashMaxOutputBytes: '单流输出上限（字节）',
  bashMaxOutputBytesHint: '超出部分会转存到临时文件，而不是被丢弃。',
  agentLoopTitle: 'Agent 循环',
  agentLoopDescription: 'Agent 如何派发工具调用。',
  agentLoopMaxParallel: '并行工具调用数',
  agentLoopMaxParallelHint: '同一步内最多同时运行多少个可并行的调用。',
  webSearchTitle: '网页搜索',
  webSearchDescription: 'DeepSeek 搜索提供方。',
  webSearchApiKey: 'API Key',
  webSearchApiKeyHint: '不写入设置文件。留空表示保持当前密钥。',
  webSearchApiKeySet: '已配置密钥。',
  webSearchApiKeyUnset: '未配置密钥；配置之前搜索不可用。',
  webSearchBaseUrl: '接口地址',
  webSearchBaseUrlHint: '留空则使用提供方默认地址。',
  webSearchMaxUses: '单次请求最多搜索次数',
  webSearchMaxUsesHint: '一次请求在必须作答前最多可以搜索多少次。',
  subagentModelSelectionTitle: 'Subagent',
  subagentModelSelectionDescription: '控制 Agent 为 Subagent 选择模型的权限。',
  subagentModelSelectionToggle: '允许 Agent 为 Subagent 选择模型',
  subagentModelSelectionChoose: '开启后，Agent 可以从下方授权模型中，为每个 Subagent 选择提供方、模型和推理强度。仅影响新会话。',
  subagentModelSelectionAllowed: 'Agent 可选择的模型',
  subagentModelSelectionLoading: '正在加载模型…',
  subagentModelSelectionLoadFailed: '无法加载模型。',
  subagentModelSelectionRetry: '重试',
  subagentModelSelectionPartial: '部分模型提供方暂时无法加载；已保存的选择仍可移除。',
  subagentModelSelectionUnavailable: '当前不可用',
  subagentModelSelectionUnavailableGroup: '已保存但当前不可用',
  subagentModelSelectionEmpty: '当前没有模型提供方公布模型。',
  subagentModelSelectionRequired: '保存前请至少选择一个模型。',
  subagentModelSelectionConflict: '设置已在其他位置更新。请放弃修改后重试。',
  subagentModelSelectionOff: '关闭后，Subagent 使用配置的默认模型或继承父 Agent 的模型；已选模型会保留。',
  deliveryTitle: '交付纪律',
  deliveryDescription: '需求如何分级，以及每个级别要走完哪些阶段。',
  deliveryEnforcement: '门禁强度',
  deliveryEnforcementHint: 'stateful 阻止推进，advisory 只提醒，off 关闭全部门禁。',
  deliveryEnabled: '启用交付工具',
  deliveryEnabledHint: '关闭后不再向模型提供任何交付工具。',
  deliveryAutoDetect: '自动识别需求规模',
  deliveryAutoDetectHint: '开启后按下方阈值与信号自动创建任务，无需模型主动调用。',
  deliveryRequireOpenspecForBugs: '缺陷修复强制拆分',
  deliveryRequireOpenspecForBugsHint: '达到设计阈值的小微缺陷修复也按 L2 处理。',
  deliveryMaxReviewRounds: '复核轮次上限',
  deliveryMaxReviewRoundsHint: '覆盖类差异允许模型复核放行的最大轮次。',
  deliveryDesignTodoCount: 'L1 待办数阈值',
  deliveryDesignTodoCountHint: '预估待办数达到该值即判为 L1。',
  deliveryDesignFiles: 'L1 改动文件阈值',
  deliveryDesignFilesHint: '预估改动文件数达到该值即判为 L1。',
  deliverySpecTodoCount: 'L2 待办数阈值',
  deliverySpecTodoCountHint: '预估待办数达到该值即判为 L2。',
  deliverySpecChars: 'L2 目标长度阈值',
  deliverySpecCharsHint: '目标文本长度超过该值直接判为 L2，不再扫描信号。',
  deliveryGradingPrompt: '分级判定规则',
  deliveryGradingPromptHint: '这段文本作为分级判定的系统提示词发送。判定由一次独立的模型调用完成，因此调整识别逻辑不需要改代码。',
  deliveryVerificationCommands: '验收命令',
  deliveryVerificationCommandsHint: '勾选后，推进到「已验证」前必须由模型按上方顺序依次执行这些命令并记录验收结果；前一条没有记录时不会要求下一条。命令来自「设置 → 提示词命令」。',
  deliveryVerificationEmpty: '还没有可选的命令。请先到「设置 → 提示词命令」添加常用命令，再回到这里勾选。',
  deliveryVerificationMissing: '已不在提示词命令列表中，移除即可。',
  deliveryVerificationSelected: '执行顺序',
  deliveryVerificationSelectedEmpty: '还没有选中任何命令。从下方勾选即按顺序追加到末尾。',
  deliveryVerificationCandidates: '可选命令',
  deliveryVerificationRemove: '移除',
  deliveryVerificationMoveUp: '上移',
  deliveryVerificationMoveDown: '下移',
  deliveryVerificationDragHint: '拖动可调整顺序；键盘用户可用每行的「上移」「下移」按钮。',
  deliveryVerificationDragHandle: '拖动以调整顺序',
  invalidBoolean: '请填 true 或 false；留空表示使用默认值。',
  invalidEnum: '请从可选值中选择；留空表示使用默认值。',
  useDefault: '使用默认值',
  deliveryHelpEnforcement: '决定门禁的强度。stateful 在条件不满足时直接阻止推进；advisory 只在对话里提醒，仍然放行；off 关闭全部门禁但不注销工具（要完全不暴露工具，只能在组合配置里设 enabled: false，因为那在加载期就决定不注册）。这一项在每次判定时读取，因此改动立即生效。',
  deliveryHelpEnabled: '是否注册交付工具。关闭后模型看不到任何交付工具，也不会自动创建任务。与 enforcement 的 off 不同：off 仍注册工具、只是不阻断；enabled 为 false 则在加载期就不注册。因此本开关若在组合配置中已关闭，这一页也不会出现。',
  deliveryHelpGradingPrompt: '分级判定的规则文本，作为一次独立模型调用的系统提示词发送——模型只回一个分级标签，判定结果据此创建任务。判定用模型而不是关键词，是因为子串匹配无法区分「改 auth.ts 里的注释」与「改 auth 协议」：任何词表都会同时漏判和误判。整段文本可以按你的团队约定改写，例如补充「涉及数据库迁移一律 L2」「只改文档一律 L0」这类规则，改动立即生效且不需要改代码。唯一不受本段影响的是长度阈值：目标文本超过它直接判为 L2，不再调用模型。留空会被拒绝，因为空提示词会让每次判定都失败并回退到 L1。',
  deliveryHelpAutoDetect: '开启后，直接来自人类的请求会先跑一遍程序化分级，判定为 L0、L1 或 L2 都自动创建任务，无需模型主动调用工具。判定为 L0 时另注入一次分级判据，让模型在觉得请求比扫描结果更大时把分级提上去。关闭后一律不自动创建，全部交由模型判断。',
  deliveryHelpRequireOpenspecForBugs: '开启时，被标记为缺陷修复、且达到设计阈值的请求会被强制判为 L2，即使文本扫描认为它只是 L1。用于防止「修复」类工作因篇幅短而绕过结构契约审查。',
  deliveryHelpMaxReviewRounds: '覆盖类差异允许模型用一段具体说明放行的最大次数。每次放行都会记入任务的变更记录以便追溯；轮次用尽后必须真正补齐覆盖。命令核验失败不在此列，任何情况下都不能被放行。',
  deliveryHelpDesignTodoCount: '预估待办数达到此值即判为 L1。模型在创建任务时可提供预估待办数；判定发生在任务创建时，之后不再改变。',
  deliveryHelpDesignFiles: '预估改动文件数达到此值即判为 L1。用于识别「改动面宽但描述简短」的请求，例如一次跨多个文件的重命名。',
  deliveryHelpSpecTodoCount: '预估待办数达到此值即判为 L2。数值通常明显高于 L1 的同一项，用于区分「一件事拆成几步」与「一整套结构改造」。',
  deliveryHelpSpecChars: '目标文本长度超过此值直接判为 L2，不再扫描信号。这是最强的一道长度闸门：超过它的请求无论措辞如何都会进入需要产出 OpenSpec 四件套的重流程，因此该值决定了「多长的描述值得走完整流程」。',
  deliveryHelpVerificationCommands: '推进到「已验证」之前必须完成的验收。候选命令来自「设置 → 提示词命令」里配置的提示词命令，勾选即可，无需手写命令文本。勾选后，模型必须在推进到「已验证」之前按这里的顺序执行这些命令并留下验收记录，否则会被阻止——这道门禁判定的是「是否留下了验收记录」，不是模型的措辞。顺序是硬要求：门禁每次只要求当前最早那条尚未记录的命令，为后面的命令先记录不会放行，因此上方的顺序列表可以用拖动或每行的上移/下移按钮调整。L2 任务另外会自动执行 openspec validate --strict 结构校验，该项与这里的勾选无关，始终生效。',
  deliveryHelpLink: '帮助',
  close: '关闭',
  deliveryHelpIntro: '交付纪律为一次人类请求建立一份持久的、可追溯变更的任务，并让它在完整的生命周期里推进。任务分级决定这次工作要走完哪些阶段、要留下哪些产物，以及结束时如何被验证。这一页说明分级是怎么判定的、每一级各自要做什么、会产出什么，以及「实现验证」到底检查什么。',
  deliveryHelpTiersHeading: '需求分级与判定规则',
  deliveryTierL0Name: 'L0 · 小微修复',
  deliveryTierL1Name: 'L1 · 需要设计的改动',
  deliveryTierL2Name: 'L2 · 结构契约级变更',
  deliveryHelpTierL0: '小微修复。改动局部、无结构影响，例如改一处文案或修一个拼写错误。判定为 L0 时同样会创建交付任务并走「已创建 → 已实现 → 已验证 → 已验收」，因此验收命令这道门禁对它生效；但 L0 没有任务清单与 covers 注解的义务，也不要求设计文档，因此实际负担仍然是「记录一条变更」。判定条件：目标文本未超过 L2 长度阈值，且分级判定给出的结果是 L0。',
  deliveryHelpTierL1: '需要先想清楚再动手的工作。跨端、新增能力、或含需要权衡的设计决策。判定后会自动创建任务，阶段序列为「已创建 → 已设计 → 已实现 → 已验证 → 已验收」，其中「已设计」要求至少一条设计记录。判定条件：分级判定给出 L1，或模型创建任务时给出的预估改动文件数／预估待办数达到 L1 阈值。判定失败（模型不可用或没有给出分级）时也回退为 L1，因为与其放行一个未判定的请求，不如让它留下一条设计记录。',
  deliveryHelpTierL2: '结构契约级变更。它改动的不是某一处实现，而是别人依赖的约定：能力接缝、会话事件、持久化 schema、投影、公共 API 或协议、跨版本数据格式，或涉及数据格式、协议、兼容性、安全的非小微缺陷修复。阶段序列在 L1 基础上增加「已拆分」，要求至少产出一份 OpenSpec 变更（说明、设计、任务清单与规格增量四件套）。判定条件：目标文本长度超过 L2 长度阈值、或分级判定给出 L2、或预估待办数达到 L2 阈值、或开启「缺陷修复强制拆分」时非小微缺陷。有多条判据时取最高级别。L2 下 todo_write 会被拒绝，任务清单以 OpenSpec 的 tasks.md 为准。',
  deliveryHelpFlowHeading: '每一级的执行流程',
  deliveryHelpFlowNote: '任务创建后一律先澄清并对齐需求，再调用 mark_analysis_done 标记分析完成；在此之前写设计会被阻止。之后按级别推进：L0 记录一条变更即可进入实现；L1 需要先记录一条设计；L2 还需要先把 OpenSpec 四件套写到 openspec/changes/<change-id>/ 下，并在 record_tasks 里同步同一份清单。阶段是只进不退的，跳过必需阶段会被拒绝。',
  deliveryHelpArtifactsHeading: '会产生的交付物',
  deliveryHelpArtifactsNote: '.dsh/changes/<task-id>.md 记录每条变更与每次复核（任何级别都会写）；.dsh/design/<task-id>.md 记录设计摘要（L1 与 L2）；openspec/changes/<change-id>/ 下的 proposal.md、design.md、tasks.md 与 specs/<capability>/spec.md 是 L2 的四件套，其中 tasks.md 是 OpenSpec 实际解析、也是任务清单的磁盘权威。分级依据本身也会写入 .dsh/changes/<task-id>.md，标明是长度阈值、模型判定还是失败回退。所有记录同时作为会话事件持久化，因此能经受会话恢复与进程重启。',
  deliveryHelpVerifyHeading: '实现验证的执行逻辑',
  deliveryHelpVerifyIntro: '推进到「已验证」时按三类输入执行四道检查：原始需求、任务列表、设计文档。前三道是确定性判定，模型无法用一句「已完成」绕过。',
  deliveryHelpVerifyStep1: '一、清单完整性：权威任务列表里的每一项都必须已完成。L2 以磁盘 tasks.md 为准，并要求磁盘勾选与上报的清单逐项一致；L1 以任务清单为准，未记录清单会被阻止；L0 没有清单义务，因此豁免。',
  deliveryHelpVerifyStep2: '二、覆盖性：原始需求的每一条编号项与设计文档的每一个决策标题，都必须被一条已完成的任务项通过 covers 注解声明覆盖。未覆盖的点会被逐条列出并回注，模型需要补齐或逐条说明。',
  deliveryHelpVerifyStep3: '三、产物核验：L2 先执行 openspec validate --strict 结构校验，非零退出即阻止验证；随后核对已勾选的验收命令是否都留下了验收记录。未留下记录的会被阻止，且不因模型确认完成而豁免。多条命令按配置顺序逐条要求：每次只提示当前最早那条尚未记录的命令，并说明它是第几条、共几条，因此跳到后面某条不会被放行。',
  deliveryHelpVerifyStep4: '四、逐条对账：覆盖关系由上述注解承载，取代一段自由文本放行。',
  deliveryHelpVerifyRelease: '覆盖类差异允许在「复核轮次上限」内由一段具体说明放行并留痕（至少 20 字，且会记入任务的变更记录）；轮次用尽后必须真正补齐。验收记录缺失与结构校验失败不在可放行范围内。「已验收」只做最终确认，不再重复执行验证。',
  deliveryHelpCoversHeading: 'covers 注解的写法',
  deliveryHelpCoversNote: '把注解写在任务项内容的行尾。键名有三种：req/<n> 对应原始需求的第 n 条编号项（写成「1、… 2、… 3、…」的需求需要 req/1、req/2、req/3）；design/<Dn> 对应设计文档里 ### D<n> 形式的决策标题；<capability>/<Scenario name> 对应 OpenSpec 规格增量里的每个 Scenario。一个任务项可以同时声明多个键，用逗号分隔。没有注解的任务项不覆盖任何点，因此一份完全不带注解的清单无法通过验证。',
  deliveryHelpCoverExample: '- [x] 做甲 (covers: req/1, design/D1)\n- [x] 做乙 (covers: req/2, capability/它应当工作)',
  deliveryHelpConfigHeading: '配置项说明',
  deliveryHelpConfigNote: '每个配置项旁的问号图标给出该项的详细说明。改动在这里写入的是用户层覆盖，立即生效且优先于组合配置；把某项清空即回到组合配置的默认值。若本部署未挂载设置服务，本卡片不会出现，此时只能通过组合配置调整。',
  deliveryHelpFooter: '把某一项留空表示使用默认值，而写成 false 表示显式关闭 —— 两者含义不同。',
}
