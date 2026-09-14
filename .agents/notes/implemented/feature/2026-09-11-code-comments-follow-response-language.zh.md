# Agent Note: 代码注释跟随响应语言指令

Status: implemented

## Problem

`zh` 响应语言指令管的是"人会读到的散文"：解释、计划、进度、总结、提问，以及模型撰写的提交信息、报告与文档正文。它把代码连同代码里的注释一起划入"原文保留"集合（`Keep code, shell commands, file paths, ... verbatim`），于是中文会话产出的代码注释仍是英文——读者看到的是中文解释配英文注释。

这个边界划错了对象。"原文保留"存在的理由是不能翻译标识符、路径、命令与引文这类必须逐字一致的代码标记；注释是给中文读者读的散文，与它们不同类。笼统的 `code` 一词把两者混在一起，模型按字面理解，注释就落在豁免区内。

## Decision

`zh` 指令把注释从"原文保留"集合中划出，要求模型自己撰写的注释使用中文：行注释、块注释与文档注释（JSDoc、docstring 等）一并纳入。

原 `Keep code, ...` 清单随之收敛为具体的代码标记——标识符、关键字、字符串字面量、shell 命令、文件路径、工具名、JSON key、URL，以及引用的用户或工具输出——不再使用笼统的 `code`。

指令保留一条边界：模型没有撰写的既有注释维持其原有语言。编辑现有文件时重写他人注释，会把改动范围扩大到用户没有要求的地方，并在 diff 中制造噪声。

提交信息正文原本就在"散文"条款覆盖内（指令里的"你撰写的提交信息、报告与文档正文"），本次只让注释与它并列，没有新增提交信息条款。

## Alternatives considered

**给 `Config` 增加 `codeComments` 字段，默认保持现状。** 否决：诉求是中文部署默认得到中文注释，一个默认关闭的开关不解决它；而新增配置面要同步 config-catalog、包 README 与 Model Experience 门禁，收益不匹配。将来确有部署需要英文注释时，再按当时的消费者证据引入。

**只在项目 `AGENTS.md` 里加一句。** 否决：那是逐项目维护的第二真相源，每个工作区都要重写一遍，且与"语言是部署属性"的既有归属判定冲突（见 [The deployment names the language the model answers in](2026-09-02-deployment-response-language.zh.md)）。

**要求模型顺带把文件里既有的英文注释改成中文。** 否决：用户要的是自己产出的注释，不是全仓库注释本地化；改写未授权的注释会污染 diff，并可能掩盖真正的逻辑改动。

**连思考语言一起强制。** 否决：思考内容由模型自有，提示词段落无法可靠规定它，这与 [指令禁止掉回英文那次改动](2026-09-03-chat-ux-response-language-directive.zh.md)的结论一致。该否决只针对**可靠性**，随后被[思考过程跟随响应语言指令](2026-09-14-reasoning-follows-response-language.zh.md)部分取代：那条指令追求的是方向而非保证，与本节注释条款所处的概率性状态相同。

## Consequences

中文部署现在无需配置即可得到中文注释：Web、headless、ACP 与 SDK 会话都随 `dsh-base` 携带该段落，子智能体也通过全局层合并收到它。英文部署与 `off` 逐字节不变，因为两者都不注册段落。

代价是指令变长：新增的注释条款与代码标记清单让段落比原来更长，此后[指令改用中文书写](2026-09-11-response-language-directive-in-chinese.zh.md)，字符数从约 900 降到约 300。只要解析出的语言不变，文本就保持稳定，不破坏前缀复用。`minimal` 预设仍因 persona 即完整提示词而收不到该指令。

模型对提示词的遵循是概率性的，指令只降低英文注释出现的概率。既有英文注释被有意保留，因此混合代码库里仍会看到英文注释——那是边界，不是遗漏。

## Testing

- `response-language.spec.ts` 新增一条用例，断言指令同时包含注释中文条款、既有注释保持条款与代码标记清单；整文件 18 条，整个包 19/19 通过（含 Loader 真实组合用例）。
- `loader.spec.ts` 仍断言中文指令渲染在 identity 与 persona 之间，它比对 `directiveText('zh')` 而非硬编码文本。
- `snapshots/` 的 expected 输出不含 zh 指令文本，因此 `test:snapshot` 不受影响。
- `run-oxlint.ts` 对改动包 0 警告 0 错误；`verify-package-readme-model-experience` 对 `packages/context/response-language` 通过。
