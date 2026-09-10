# Agent Note: 交付纪律浮卡的宽度、任务排版与限高滚动

Status: implemented

## Problem

在 `conversation.side.float` 槽位渲染的 `DeliveryFloatCard` 是会话正文左边缘的悬浮进度面板。
`L2` 任务下任务列表展开较长，截图与用户报告先后指出了四个叠加的布局缺陷：

- `.root { width: min(260px, calc(100% - 24px)) }` 把面板上限卡死在 260px。
- `.taskItem { display: flex; align-items: baseline }` + `.taskContent { white-space: nowrap; text-overflow: ellipsis }` 把任务文字与状态 chip 挤在同一个 baseline row，单行 `nowrap+ellipsis` 的截断又把视觉拉到面板右缘之后，读起来像是任务名向对话正文"伸出"了一段。
- `.group` 对所有分组（需求分析 / 设计文档 / 任务列表 / 实现验证）统一用 `display: flex; align-items: baseline`，于是"任务列表"标题和第一条任务共享同一基线行，标题右侧整段留白，浪费横向空间。
- `.root` 没有高度上限，任务特别多时展开的浮卡一路撑到页面底部，且 `panel` 自身不可滚动，底部任务被裁掉也无法触达。

读到的真实问题是四个叠加效果：面板不够宽、长任务名被强行单行截断、任务列表标题没有独占一行、以及浮卡整体无界。修完后 `M0-1.x` 系列那种长描述既不再叠到对话正文、也不会被切到只剩 `...`，且任务列表再多也能在半个视口内滚动浏览。

## Decision

`packages/client/ui-delivery/src/client/DeliveryFloatCard.module.css` 做以下五处改动；DOM 结构与所选字段保持不变，因此对话正文、浮卡语义、所有现有的 `data-*` 属性都不会动。

1. 浮卡宽度上限的最终值是 320（演化路径 260 → 360 → 320：先从 260 加宽让长任务标题可读，第一轮回归后再回退一档，因为 360 在 ≥920px 的列宽下视觉占比仍然偏高，正文左侧 ~280–372px 都被卡片压住。`.body` 在 conversationRoot 中受 `--dsh-chat-content-width`（680–920px）约束，浮卡右缘离面板中线至少还有 `column_width / 2 - 12 - 320` ≈ 132 至 228px 的安全间距，因此不会与对话正中内容重叠。`calc(100% - 24px)` 仍然保留，是窄列（<344px）的兜底。
2. `.taskItem` 从 `display: flex; align-items: baseline` 改成 `display: flex; flex-direction: column; gap: 2px`。状态 chip 掉到任务文字下方一行，不再抢占任务名的横向空间。
3. `.taskContent` 把 `nowrap + ellipsis` 换成 `display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; line-clamp: 3; overflow: hidden`，配合 `overflow-wrap: break-word; word-break: break-word` 允许 CJK + 英文混排换行，再多就三行截断，不会撑爆浮卡。`.taskState` 增加 `align-self: flex-start` 让状态 chip 左对齐到列表缩进处。
4. `.group[data-group='tasks']` 覆写为 `flex-direction: column; align-items: stretch; gap: 4px`。"任务列表"标题独占一行，第一条任务换行到标题之下；`align-items: stretch` 让 `<ol>` 吃到面板整宽，任务标题仍然拿到 320px 而不是 shrink-wrap。
5. `.root` 增加 `display: flex; flex-direction: column; max-height: 50vh`，`.card` 增加 `flex: none`，`.panel` 增加 `overflow-y: auto; min-height: 0`。浮卡整体不超过半个视口高度；标题折叠按钮固定不滚，超出部分在 `panel` 内滚动。

UI 其他部分（卡片标题行的 `L2 我要做...`、折叠按钮、`L0` 跳过"设计文档"组的语义进度、阶梯配色、阶段计数）一律不动；交付纪律浮卡的可读语义也没有变化。

## Alternatives considered

**只放宽宽度、保留水平任务行。** 否决：状态 chip 与文字在同一行时，水平空间是被状态文本先抢走的；只加宽浮卡并不能让长任务名透出更多字符，反而会让状态 chip 拉得更大，与 `data-status` 视觉合同背离。把任务项改为纵向排版才是根本上释放文字宽度的姿势。

**限制更短的 line-clamp（例如 1 行或 2 行）。** 否决：L2 任务经常包含 `M0-1.x <动词> <对象> <细节>` 模式，三行的窗口正好覆盖最常见的长度；两行会重新引入单行 ellipsis 的痛点，再长就要全文字 hover-tooltip 一类的次级交互。

**引入全文 tooltip / 展开浮卡为抽屉式。** 否决：当前卡片的"折叠展开"已经通过 `expanded` state 拥有了，先折叠浮卡再 hover 单条任务再决定要不要展开是三次交互；line-clamp 在原生层一次性解决，不引入新交互面。

**改为内联 chip 颜色块 + 文字，让 `data-status` 用色块传达状态。** 否决：状态文字本身是项目已有的 `已实现/进行中/待实现` 文案，读者已经建立文字与状态的映射，加色块只会挤占本来就紧的文字宽度。

**迁移到 full 宽度 side panel（撤销 `position: absolute`）。** 否决：浮卡存在的原因（`§6.6 会话侧边栏/卡片`）就是要"贴在正文左边缘、不占布局空间"；改成占用布局的侧栏会让本就在窄列里挣扎的对话正文继续被压缩，是更大的退化。

**限高用 `50%`（相对 `.body`）而非 `50vh`。** 否决：`.body` 高度会随会话 header 与 composer 变化，`50%` 的"半页"语义不稳定；`50vh` 直接对应当前视口，与项目里 `Menu.module.css` 的 `calc(100vh - 24px)` 口径一致，读起来就是"页面的一半"。

**滚动区放在 `.root` 而不是 `.panel`。** 否决：`.root` 滚动会把标题折叠按钮一起滚走，用户就看不到如何收回浮卡；把滚动放在 `panel`、`card` 设 `flex: none`，折叠按钮始终固定，语义与交互都更稳。

## Consequences

读得到的视觉变化：长 L2 任务标题最多占浮卡整宽的 3 行，状态 chip 跟在标题下方左侧，不再与标题同行的右沿抢位置；"任务列表"标题独占一行，任务列表在它下方换行展开；浮卡整体最多半个视口高，任务列表再多也在 `panel` 内滚动，折叠按钮固定可点。`.taskList` 的 `gap` 从 2 提到 4，给分行后的上下间距一点点喘息。截断后的视觉错位感消失。

风险：把 `.taskItem` 改为 `flex-direction: column` 之后状态 chip 跟随任务名换行 —— 在极窄浮卡宽度（比如窄视口把 100% - 24 拉到 220-260 区间）下任务名会贴边截断得更早。这是已被既有 `min(360px, calc(100% - 24px))` 缓解的退化，<384px 视口本就少见。`max-height: 50vh` 与 `panel` 滚动在 `vh` 单位下随视口缩放，若未来浮卡迁到侧栏（取消 absolute）需要把 `50vh` 换成相对定位上下文的 `50%`，否则"半页"语义会漂。

测试与验证：现有 `packages/client/ui-delivery/tests/delivery-float-card.client.spec.tsx` 9 条用例继续全过（25 / 25 across the package），断言点是用 `[data-group="tasks"]` 与 `[data-status="..."]` 的 attribute selector，DOM 结构未变；`README.zh.md` 也无需更新，因为浮卡的语义分组（需求分析 / 设计文档 / 任务列表 / 实现验证）、L0 跳过 `设计文档` 与阶段进度的事实描述都没变。
