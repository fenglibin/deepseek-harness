# Agent Note: 插件列表展示描述、就地启停并浏览 README

Status: implemented

## Problem

「设置 → 插件 → 插件列表」是一份只读投影：它能列出插件名与启停状态，却答不出三件事——这个插件是干什么的、能不能在这里把它打开或关掉，以及它的完整文档写在哪里。用户想停用一个插件只能去改 `cordis.yml` 或 preset 的 `agent.cordis.yml`，而列表本身又恰好是唯一知道「部署里到底装了哪些插件」的界面。

困难在于这些都不在现有数据里。Cordis 与 Loader 都不携带插件描述：一个条目只有一个模块说明符，插件自己也不发布任何人类可读的说明。启停则跨两个持久化平面——全局条目属于条目树（文件支撑的树会写回 `cordis.yml`，内存根树什么都不写），预设行属于 preset 的组合文件，而组合文件此前只有「整目录复制」这一种写入。

## Decision

**描述读包文档。** 宿主在投影每一行时解析模块名到包目录，取最近的 `README.zh.md` 或 `README.md` 顶部 frontmatter 的 `description`；解析不到包、包没有 README、或 frontmatter 里没有可解析的描述，该行就不带 `description` 键。解析锚点依次是条目所在树的 base、本部署的 base、本模块自身，第一个解析成功的锚点说了算；走到包 manifest 停止向上，因为再往上的 README 属于另一个包。`cordis:` 内建直接跳过。

**启停分两个归属，预设行不区分 trust。** 全局条目经 `pluginInventory/setEnabled` 写条目自己的 `disabled`，由条目所在树决定这次改动是否落盘。预设行经 `agentPresets/setRowDisabled` 写组合文件，行由文件自己声明的 id 定位，启用是删掉 `disabled` 键而不是写成 `false`；随部署自带的 preset 与用户自建 preset 一视同仁——部署提供的是「要不要运行这一行」的默认，不是「这个用户不许改」的否决。删除 preset 仍然只对用户自建 preset 开放：删除是破坏性的，改一行不是。

**组合文件写入是保注释的局部编辑。** 只用 js-yaml 重新 dump 整个文件，会抹掉随部署 preset 组合文件里一百多行设计注释。改为按行定位目标行块（扫描 `- ` 列表项、把该块单独解析出来匹配 `id`），只在 `<keyIndent>disabled: true` 这一行上增删，其余字节原样保留；写回前把结果再读一遍，读不回同一组合就拒绝而不是留下一个 Loader 解析不了的坏文件。嵌套在 `group.config` 里的行、`id` 不是首个键的行都能命中；流样式（`- {id: x}`）追加新行会产生非法 YAML，这类行明确拒绝。

**两类行不给开关。** 组合文件里没有声明 id 的行，以及由 `!!js` 表达式决定启停的行：前者没有可写的身份，后者那个门是作者的，换掉它不是开关该替用户做的决定。写入成功后标签页重新读取整份快照，因为某行的有效状态与根 Fiber 阶段只有 Loader 真正停掉或拉起插件之后才答得出来。

**开关启用态用状态色，不用品牌墨色。** `--dsw-alias-brand-primary` 在浅色外观是近黑的 `neutral-bluish-1000`、深色外观是近白的 `neutral-bluish-50`，它是一块墨色药丸而不是「开」。启用态改用 `--dsw-alias-state-success-primary`，两套外观由主题各自定义，随外观切换自动变化。

**README 全文按需取，复用 MarkdownText 渲染。** 清单快照里每行额外带 `readme` 文件名（读到 `README.zh.md` 或 `README.md` 时的实际名字），它是「要不要显示查看更多信息」的依据，因此不会出现点了就报错的链接。点击后以 `Modal` 弹窗取回 `pluginInventory/readme(moduleName)` 的正文（frontmatter 已剥掉，因为那正是 description 的来源），用会话消息同一套 `MarkdownText` 渲染。`mermaid` 围栏由 `diagrams` prop 打开：运行时只在首次出现图时动态加载，单图失败退回源码；会话消息不传 `diagrams`，默认行为不变。全文不进 `list` 快照，几十个插件的散文不该让每次清单读取都付账。

## Alternatives considered

**让插件自己声明描述。** 新增一个 `export const description` 约定，由各插件提供，描述最准确也最可控。落选原因是它要求改动仓库里的每一个插件，并新增一个校验门禁来防止后续插件漏声明——为了让一张列表有一句话可读，把成本摊到整个包集合上不值得，而且第三方插件几乎不会遵守。

**读 `package.json` 的 `description`。** 覆盖率与 README 方案相当，也是英文的一行摘要。落选是因为它面向包的使用者而非插件的使用者：本仓库的 `package.json` 描述写的是「Read-only Cordis Loader inventory tab in Web Plugins settings」这类包身份说明，而 README frontmatter 的 `description` 本来就是给列表和选择器看的那一句。

**把预设行的写入也放进 `pluginInventory`。** 客户端就只需要一个 Remote 命名空间，也不用新增注入依赖。落选是因为组合文件归 `dsh-agent-presets` 所有：它才知道 `!!js` 门长什么样、如何按 id 定位行。让清单服务去写它只负责投影的文件，会把这条归属边界拆开。

**允许开关覆盖 `!!js` 门。** 让用户能关掉 `tool-pwsh` 这类条件行看起来更完整。落选是因为那是一次不可逆的编辑——表达式被 `true`/删除之后无法从界面恢复——而界面只承诺展示状态，不承诺替作者重写组合。

**为预设行引入用户级 override 层而不是改文件。** 把 system 预设的开关写进用户设置，挂载时以 runtime patch 生效，不碰发行文件。落选是因为「直接改写组合文件」是本次明确的取舍：它保留「文件就是真相」的单一持久化，代价是随部署升级会覆盖用户改过的发行文件——这一代价记录在 Consequences。

**新写一套 Markdown 浏览器。** 落选，`ui-primitives` 的 `MarkdownText` 已经是 GFM 表格、脚注、KaTeX、Shiki 高亮的完整渲染器，只缺 mermaid 一个分支。

## Consequences

清单不再是只读：它现在能改变部署实际运行的插件集合，因此行级写入路径必须自带归属判断（谁的文件、谁的门）。代价是每次 `list()` 都要为每个插件做一次模块解析与文件读取，且描述不缓存——换来的是包文档改动在下一次读取即可见，不需要再维护一份可能漂移的缓存。

预设行的改动要到下一个会话才生效：写的是文件，本次已经组合过该 preset 的会话继续跑在它启动时那一代组合上。这与「preset 文件是输入，绝不是挂载子树的持久化目标」那条不变式一致——挂载子树仍然从不写回。

对随部署自带的 preset 就地写入，意味着部署升级（重装 / `git pull`）会覆盖用户改过的行，或在工作区留下脏改动；这是「文件即真相」取舍的代价，README 的已知限制里如实记录。组合文件里除目标行外其余字节原样保留，因此作者手写的注释不会因为一次开关而丢失。
