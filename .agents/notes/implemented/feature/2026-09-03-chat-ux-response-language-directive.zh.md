# Agent Note: `zh` 响应语言指令现在明确禁止掉回英文

Status: implemented

[English](2026-09-03-chat-ux-response-language-directive.md) | 中文

## Problem

用户在「设置 → 通用设置 → 语言」里选了「中文」，Web 界面文案也确实切到了中文，但模型输出仍大量是英文——尤其思考过程基本是英文。之前对语言设置的那次改动「没有起到效果」：界面语言和模型输出语言是两条不同的通道，只有前者在动。

## Decision

加强 [`response-language`](../../../../packages/context/response-language/src/index.ts) 里唯一的 `zh` 指令。这条指令原本就要求中文、并保留代码 / 路径 / 引文原文，但缺少真正能阻止模型在回答中途滑回英文的两条条款：

- 一条显式的「复现标识符 / 路径 / 命令 / 引文时，禁止切换到英文」，以及
- 一条镜像条款：即使用户用英文输入，回复也保持中文，除非用户明确要求用英文。

这两条是**追加**到既有的「原文保留」条款之后，而不是替换，所以指令现在用一句话流完整表达：正文用中文写、非正文原文保留、围绕原文的上下文不得切换英文、用户写英文时回复仍保持中文。

### 为什么是修指令，而不是修写入链路

改动范围是在端到端追查完整个链路之后才圈定的，因为同一症状（界面中文、输出英文）也可能来自 locale 偏好根本没到达 Host：

- **读路径正确。** `localePreference(ctx)` 读 `settings.get('locale').preference`，而真实的 `SettingsProvider.get(ns)` 返回的就是该 namespace 的解析值对象（`{ preference }`），正好是这行代码 `section['preference']` 期望的结构。`response-language.spec.ts` 已覆盖 `zh`/`en`/`off`、GUI 优先于环境、以及无 settings / 非对象 section 的兜底。
- **插件已按默认挂载。** `packages/bundle/base/cordis.patch.yml` 以 `language: auto` 挂载 `response-language`。
- **写入链路在回环时会到达 Host。** 浏览器通过 `SettingsScopeController.mutate → ctx.remote.settings.mutate → SettingsController.mutate → ctx.settings` 写入，而 settings 基础插件在 `ctx.remote.$host.isLoopback` 为真时取 `persistence = 'host'`（而非 `'memory'`）。用户已确认是回环页面。

读路径、写路径、挂载三处都正确，剩下的解释就是指令本身偏软：模型被一句简短的话要求写中文、又没有明确的禁止条款，就会掉回英文——而思考用英文又会把周围的正文一起带成英文。

## Alternatives considered

**加一条 `en` 指令做正控。** 否决：超出已确认范围；项目今天只出 `zh`，`en` 指令的缺失是有意为之。

**给读路径加 dev-trace 日志来审计是哪一环失败。** 在代码级审计之后不再需要：每一环都读写同一个 `locale` namespace 的 `preference` 字段，挂载与回环持久化都已确认。加日志只会增加审计已经回答过的可观测性。

**连思考语言也强制。** 否决：思考内容是模型自有的；harness 注入的是系统提示段，任何措辞都无法可靠地规定内部思考语言。加强后的指令只管用户可见的正文，那才是用户读到的内容。

## Consequences

`zh` 用户现在得到的指令是：正文用中文、非正文原文保留、围绕原文的上下文禁止掉回英文、用户写英文时仍保持中文。指令仍是 `RESPONSE_LANGUAGE` 位置上的一段，因此依然在 `includeRuntimeContext: false` 下存活，也依然能传递到子代理。

代价是系统提示更长（多了三条条款），这正是换取更强指令的意图。思考语言仍是模型自己的，所以用户可能仍看到英文思考，即使正文回答已经是中文。

## Testing

- `response-language.spec.ts` —— `directiveText('zh')` 现在额外断言指令包含 `Do NOT switch to English` 与 `mirror their tone but keep your reply in Chinese`。整文件 17 条测试。
- `loader.spec.ts` —— 仍在 identity 与 persona 之间渲染中文指令。
- 整个包 18/18 通过。其中 `lets the stored GUI language outrank the host environment` 这条硬编码了运行主机是 `zh`；它在 `LC_ALL=zh_CN.UTF-8` 下通过，属于既有的环境假设，不是本次改动引入。
- 没有 recorded-session snapshot 内嵌旧指令文本（`translate only the prose around them` 未出现在任何 `snapshots/` 的 expected 输出里），所以 `test:snapshot` 不受影响。
- `tsc -b tsconfig.client.json` 与 `run-oxlint.ts` 通过；两份 `response-language` README 已更新为同一指令文本。

## Deferred

同一 UX 优化的其余两项仍然独立提交：带接受/拒绝的修改文件列表，以及抑制已被重试解决的错误。
