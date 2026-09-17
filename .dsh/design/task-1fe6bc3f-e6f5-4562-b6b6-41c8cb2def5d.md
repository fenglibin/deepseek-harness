- [revision 3] 设计草案落盘于 docs/design/delivery-l0-selfcheck-and-command-ordering.zh.md（含已确证事实表、D1-D5 决策、五项备选方案）。要点：

D1 l0 自动建任务，但必须与 D2 一起交付。单独放开 index.ts 的级别条件会制造比原问题更严重的缺陷：create 只在当前任务为 accepted 时允许新建（否则抛 DELIVERY_ALREADY_EXISTS），而 l0 小修通常不会被推进到 accepted，于是第一个 l0 任务会停在 created/implemented，此后每一个新请求（含正常新请求）都撞上该错误，且 clear 虽在服务层存在却没有任何工具暴露，模型无法自救。用户会失去「继续对话」这一基本能力。

D2 l0 任务被新的直接人类请求替换：pre-step 创建前，若当前存在未完成的 l0 任务且本步收到新的直接人类请求，先 clear 再创建。范围严格限定 l0——l1/l2 的粘连是刻意的，大任务需要连续性。clear 留 tombstone 且进会话日志，可追溯。已知代价：l0 自检是尽力而为的，同一回合没走完 verified 就被下个请求替换；这是让 l0 保持轻量的必然取舍，要硬保证就得像 l1 一样要求等待完整流程。

D3 保留 l0 对清单与 covers 注解的豁免（checklistGap 与 requirementCoverageGap 的现有行为不变）。l0 纳入的是验收命令门禁这一道，不是全部四道；否则每个小修都要写清单并标注注解，与 l0 定位冲突。

D4 验收命令按配置顺序逐条校验：acceptanceGap 由「返回全部缺失命令」改为「返回第一条缺失命令及序号」，门禁消息说明第几条/共几条并只给这一条正文。理由是把顺序变成机械可判定的事实，模型无法跳着做。

D5 客户端拆成「已选顺序列表 + 候选勾选」：已选区带序号、可拖动、可方向键移动、可单条移除；候选区勾选即追加到末尾。方向键是必需而非可选的——仓库 web-styling 规范要求交互控件保留键盘可达路径。两条路径共用同一个「移动到目标下标」的控制器动作，避免两套顺序语义。Host schema 不变（仍是 string[]）。

关键事实（已逐条读码确证）：l0 的 LEVEL_PHASES 本身已含 verified，故放开建任务后门禁自动生效；验证命令是 string[]，数组顺序天然承载执行顺序；仓库无拖拽库，已有原生 HTML5 拖拽先例（ui-workspace/src/client/rows/Rows.tsx）。
- [revision 4] 决策标题（供覆盖率校验解析；正文见 docs/design/delivery-l0-selfcheck-and-command-ordering.zh.md）

### D1 l0 自动建任务，且必须与 D2 一起交付

单独放开 index.ts 的级别条件会制造比原问题更严重的缺陷：create 只在当前任务为 accepted 时允许新建，否则抛 DELIVERY_ALREADY_EXISTS；l0 小修通常不会被推进到 accepted，于是第一个 l0 任务会停在 created/implemented，此后每一个新请求都被拒绝，而 clear 虽在服务层存在却没有任何工具暴露，模型无法自救。用户会失去「继续对话」这一基本能力。

### D2 l0 任务被新的直接人类请求替换

pre-step 创建前，若当前存在未完成的 l0 任务且本步收到新的直接人类请求，先 clear 再创建；范围严格限定 l0，因为 l1/l2 的粘连是刻意的（大任务需要跨 turn 连续性）。替换判定集中在 tool-delivery 的 createReplacingL0，pre-step 与 create_delivery_task 共用，因此模型显式提高分级与自动路径行为一致。clear 留 tombstone 且进会话日志，被替换的任务仍可追溯。已知代价：l0 自检是尽力而为的，同一回合没走完 verified 就会被下个请求替换。

### D3 保留 l0 对清单与 covers 注解的豁免

l0 纳入的是「验收命令」这一道，不是全部四道。checklistGap 与 requirementCoverageGap 对 l0 的现有豁免不变，否则每个改文案、修拼写的小修都要先写清单并逐点标注，与 l0「小微修复」的定位直接冲突。l0 仍须留下至少一条 record_change 才能到 implemented，这是既有 gateAdvance 规则。

### D4 验收命令按配置顺序逐条校验

acceptanceGap 由返回「全部缺失命令」改为返回「最早缺失的那一条及其 1-based 位置与总数」。门禁消息说明当前是第几条、共几条，并只给出这一条的提示词正文。这样顺序成为机械可判定的事实：模型无法跳到后面某条，也无法一次声称全部完成；为第二条先记录而不记录第一条仍会被阻止。

### D5 客户端拆成已选顺序列表与候选勾选

数组顺序就是执行顺序，因此呈现必须让顺序可见可改：已选区逐行显示序号，支持拖动、方向键上移/下移与单条移除；候选区只列未选中的命令，勾选即追加到末尾，不重排已排好的顺序。拖动与方向键共用控制器里的同一个 moveVerificationCommand(name, to)，两条路径不会各自演变出不同的顺序语义。方向键是必需的而非装饰——仓库 Web 样式规范要求交互控件保留键盘可达路径。Host schema 不变（仍是 string[]）。
