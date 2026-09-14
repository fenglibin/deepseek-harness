# Agent Note: 中文是回复语言的默认值

Status: implemented

## Problem

`dsh-response-language` 最初把 `language` 的默认值定为 `auto`，让语言跟随 Web 界面的保存选择与宿主进程自身的区域设置。这个默认值在中文桌面上工作，但在英文宿主上什么都不做：`auto` 的第一个能指名语言的信号是 ICU 兜底给出的 `en-US`，而 `en` 没有已发布指令，解析于是返回「无段落」，模型按自己提示词的语言作答。

后果是一个依赖环境的默认值。同一份 `dsh-base` 组合在中文 macOS 上产出中文回答，在英文 macOS 上产出英文回答；而 DSH 的产品形态是中文优先的——客户端只发布 `zh` 一种字典，界面文案全部是中文。默认值与环境不一致时，用户看到的是中文界面配英文智能体，且没有任何配置项能解释这一差别。

`auto` 还有一个更窄的失效路径：它的第一个信号是 Web 界面保存的 `locale.preference`，而 `setLocale` 是唯一写该字段的入口，语言选择行已随客户端单语化移除。字段因此从不落盘，信号一恒为空，`auto` 在实践上退化为「读宿主区域设置」。

## Decision

**`language` 的默认值改为 `zh`。** 它不读任何信号：无论宿主区域设置如何，模型都用中文回答。`packages/context/response-language/src/index.ts` 的 schema 默认值与 `packages/bundle/base/cordis.patch.yml` 中该行的显式 `config` 同时改为 `zh`——后者会覆盖前者，只改一处不生效。

**`auto` 保留为备选值。** 希望模型跟随界面语言与宿主区域的部署显式设置它，解析规则、信号顺序与「无段落」语义都不变。`en` 与 `off` 同样不变。

**每一套录制快照 composition 与 Web e2e scaffold 继续固定 `language: en`。** 该固定值的理由从「隔离录制机器的区域设置」变为「阻止 base 层的 `zh` 指令进入 golden」，两者都要求显式覆盖，因此固定点一处未动。

## Alternatives considered

**保留 `auto` 为默认值，只让它在 `en` 上继续搜索后续信号。** 否决：`auto` 的终止语义已写进包 README 与四条单元测试，而它服务的是一个真实需求——用户在中文宿主上显式选择英文界面时，不应被要求用中文作答。把默认值钉成 `zh` 解决的是「产品默认是什么」，改解析语义解决的是「`auto` 怎么工作」，前者不需要动后者。

**只改 `packages/bundle/base/cordis.patch.yml` 的显式 config，保留 schema 默认值为 `auto`。** 否决：那样以别的方式挂载该 row 的部署（不经过 `dsh-base`，或自己写一行）仍会得到 `auto`，默认值与环境不一致的问题会在这些组合里复现。两处都改才让「不配置即中文」成为该 row 自身的属性。

**改 `dsh-system-prompt` 的默认 persona 或 web-app 的 `app:web-surface` 段落。** 否决理由与[语言归属判定](2026-09-02-deployment-response-language.zh.md)一致：persona 会被预设遮蔽，`app:web-surface` 会被 `surfaceContext: false` 抑制，而语言要求对 headless、ACP 与 SDK 会话同样成立。

**为英文也发布一段指令。** 否决：英文是模型无需指令就会使用的语言，一段英文指令不改变行为，却会让全部录制提示词依赖它；而本次改动的方向恰好相反——让中文成为唯一无需配置的默认。

## Consequences

未配置任何 `language` 的部署现在得到中文回答，覆盖 Web、headless、ACP 与 SDK 会话，因为该 row 随 `dsh-base` 发布。面向非中文读者的部署必须显式设置 `en` 或 `off`；这是本次改动的代价，也是「产品默认中文」这一立场的直接含义。

该默认值不再依赖环境状态：`zh` 不读设置段也不读进程环境，因此 `auto` 模式特有的那类「同一组合在不同机器上产出不同提示词」的问题在默认路径上消失。快照 composition 仍固定 `en`，但理由已不是机器差异，而是内容隔离。

`minimal` 预设仍然收不到该指令，因为它的 persona 就是完整提示词。

## Testing

- `response-language.spec.ts` 的默认值断言改为 `Config()` 返回 `{ language: 'zh' }`；新增一条用例在 `LC_ALL=en_US.UTF-8` 下以 schema 默认值装配，断言渲染出的提示词仍包含 `zh` 指令，锁定「英文宿主也得到中文」。
- `base.spec.ts` 新增断言锁定 `dsh-base` 中该行的 config 为 `{ language: 'zh' }`，防止显式 config 被改回 `auto` 而 schema 默认值被遮蔽。
- 整个包 20/20 通过（含 `loader.spec.ts` 的真实 Loader 组合用例），`packages/bundle/base` 2/2 通过；`run-oxlint.ts` 对两个包 0 警告 0 错误。
- 12 份快照 composition 与 2 份 fixture/scaffold 中解释 `en` 固定值的注释随理由更新，固定值本身未动，因此 `test:snapshot` 与 Web golden 的期望输出不变。
