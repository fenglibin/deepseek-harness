# DSH 中英双语环境单语化方案（仅保留中文）

> 本文档为纯中文单语文档，是"仅保留中文"目标形态的首个实例，不配英文侧与 `.i18n.yaml` 一致性记录。

## 1. 背景与动机

DSH 当前在两条独立战线上同时维护中英双语：

1. **文档双语配对**：每个文档是三元组 `foo.md`（英文）+ `foo.zh.md`（中文）+ `foo.i18n.yaml`（一致性记录）。
2. **客户端 UI 运行时多语言**：Web UI 内置 `zh`/`en` 两套字典，可运行时切换。

维护两种语言带来的是纯增量负担：每次改动文档都要同步两份并重录 hash，每次改 UI 文案都要同步两个字典，浪费大量时间和 Token，而对中文场景没有任何收益。目标是把 DSH 收敛为**仅支持中文**，让后续需求不再需要考虑多语言环境，同时不影响与 i18n 无关的单元测试和标准 Git 提交。

## 2. 现状梳理

### 2.1 机制 A：客户端 UI 运行时多语言（产品功能）

- 核心包 `packages/client/locale/`，内置 `zh` + `en` 两个语言，`FALLBACK_LOCALE = 'en'`。
- 130+ 个 client 包各自带 `locales.ts` / `locale.ts` 字典，通过 `register(ns, { zh, en })` 强类型注册。
- 设置中存在"语言"偏好项（`LanguageRow`），用户可切换中英文。
- 两个门禁：
  - `verify-client-ui-i18n`：拒绝在 Client 源码里硬编码产品文案。
  - `locale-dictionary-parity.spec.ts`：强制 `zh`/`en` 字典键集合对称。

### 2.2 机制 B：文档双语配对（维护负担）

- 每个文档是三元组 `foo.md` + `foo.zh.md` + `foo.i18n.yaml`，`.i18n.yaml` 记录两侧 git blob hash。
- 规模：**1323 个 `.zh.md` + 1320 个 `.i18n.yaml`**，另含大量英文 `.md`。
- 门禁 `verify-translation-pairing`（属 `doc-sync`）：强制配对完整、hash 一致、语言切换器、结构签名（标题层级 / 表格 / 代码块 / 链接逐字节对齐）。
- 配套基础设施：
  - 约 15 个 `translation-*` / `paired-*` 脚本。
  - git merge driver（`.gitattributes` 中 `*.i18n.yaml merge=dsh-translation-pairing`）。
  - `website/docs.ts` 双语站点投影（`DocsLocale = 'root' | 'en'`）。
  - `.agents/skills/dsh-translate-docs/` 技能。
  - `docs/i18n/` 整本翻译规则与术语表。

## 3. 目标与已确认决策

### 3.1 目标

- 文档只保留一份中文，删除英文侧与 `.i18n.yaml`。
- Web UI 只保留中文，删除英文字典、语言切换项。
- 删除全部翻译基础设施（脚本、门禁、merge driver、技能、翻译规则文档）。
- 后续需求不再需要维护双语，单测与 Git 提交回归标准行为。

### 3.2 已确认决策

| 决策 | 结论 |
|---|---|
| 改造范围 | 文档 + Web UI 英文一起移除，彻底纯中文 |
| 中文文件命名 | 保留 `.zh.md` 后缀，只删英文 `.md` 和 `.i18n.yaml`，不做重命名 |

## 4. 影响面分析

### 4.1 规模

| 项目 | 数量 / 范围 |
|---|---|
| `.zh.md` | 1323 个（保留） |
| `.i18n.yaml` | 1320 个（删除） |
| 配对英文 `.md` | 约 1320 个（删除，精确锚定"有 `.i18n.yaml` 的配对"） |
| translation 脚本 | 约 15 个 + 对应 spec + fixtures/snapshots（删除） |
| client 包字典 | 130+ 个包（删除 en 字典） |

### 4.2 单元测试影响

- **会改写/删除**的是"验证双语契约"的测试：`locale.client.spec.ts`（约 30 条 en 断言）、`translation-pairing.spec.ts`、`translation-pairing-merge.spec.ts`、`translation-links.spec.ts`、`translation-brief.spec.ts`、`translation-prompt.spec.ts`、`paired-markdown-derivatives.spec.ts`、`locale-dictionary-parity.spec.ts` 等。
- **不受影响**的是所有与 i18n 无关的业务单测。

### 4.3 Git 提交影响

- 删除 `.gitattributes` 中 `*.i18n.yaml merge=dsh-translation-pairing` 后，`.i18n.yaml` 的自定义 merge driver 失效（文件本身也已删除）。
- 普通 Git 提交 / 合并回归标准行为，**零负面影响**。

## 5. 分阶段实施计划

按批次串行执行，每批次完成后立即验证，绿了再进下一批。

### 批次 1：文档单语化（内容层）

对每个有 `.i18n.yaml` 的配对，精确执行：

1. 删除英文侧 `.md`。
2. 删除 `.i18n.yaml`。
3. 保留 `.zh.md`，并删除其 H1 后的语言切换器行（``）。
4. 修正 `.zh.md` 内指向**已删英文 `.md`** 的交叉链接。指向语料库内文档的链接本就用 `.zh.md` 路径、无需改动；仅指向语料库外被删英文的链接需修正。

1323 与 1320 的 3 个 `.zh.md` 差异需逐一排查（可能为缺失 `.i18n.yaml` 的孤儿）。

### 批次 2：删除翻译基础设施（机制层）

- **脚本**（含对应 `.spec.ts`、fixtures、snapshots）：
  - `verify-translation-pairing.ts`
  - `translation-pairing.ts` + `translation-pairing.manifest.json`
  - `translation-pairing-git.ts`
  - `translation-pairing-record.ts`
  - `translation-pairing-merge.ts`
  - `merge-translation-pairing.ts`
  - `merge-translation-pairing-driver.sh`
  - `translation-links.ts`
  - `translation-brief.ts` / `gen-translation-brief.ts`
  - `translation-prompt.ts` / `verify-translation-prompt.ts`
  - `paired-markdown-derivatives.ts`
  - `scripts/fixtures/translation-prompt/`、`scripts/snapshots/translation-prompt-*/`
- **门禁**：`run-gates.ts` 的 `docSyncLeafGates` 摘掉 `translation-pairing`、`translation-prompt` 两个 gate。
- **package.json scripts**：删除 `verify-translation-pairing`、`verify-translation-prompt`、`resolve-translation-pairing-conflicts`、`gen-translation-brief`。
- **`.gitattributes`**：删除 `*.i18n.yaml merge=dsh-translation-pairing`。
- **`docs/i18n/`**：整目录删除。
- **技能**：删除 `.agents/skills/dsh-translate-docs/`。
- **website**：`website/docs.ts` 收敛 `DocsLocale` 为 `'root'`，`pairedPages`/`mirroredPages` 简化为纯中文站；`website/build.ts` 同步。
- **规则文档改写**：
  - 根 `AGENTS.md`：line 57 "bilingual docs"、line 147 "Routine bilingual work / dsh-translate-docs" 相关条款。
  - `docs/AGENTS.md`：双语配对契约整段改写为单语中文规则。

### 批次 3：客户端 UI 单语化

- `packages/client/locale/src/client/index.ts`：`FALLBACK_LOCALE` 由 `'en'` 改为 `'zh'`；`BUILT_IN_LOCALE_METADATA` 只保留 `zh`；删除 en 字典导出。
- `locale-settings.ts`：`BuiltInLocaleId` 由 `'zh' | 'en'` 收窄为 `'zh'`。
- 130+ 个 client 包：删除 en 字典，`register(ns, { zh, en })` 改为 `register(ns, { zh })`（用类型检查 + 脚本批量驱动）。
- 移除 `LanguageRow` 语言切换设置项。
- 门禁 / 测试：
  - `locale-dictionary-parity.spec.ts`：由"zh/en 键对称"改写为"仅允许 zh"或删除。
  - `verify-client-ui-i18n`：保留（"文案走字典"仍正确，字典只剩 zh）。
  - `locale.client.spec.ts`：改写约 30 条 en 行为断言。

### 批次 4：全量验证闭环

`pnpm run test`、`doc-sync`、`test:docs`、`docs:build`、`typecheck`、`lint` 全绿；确认删除英文后无死链接、无残留引用。

## 6. 关键边界判断（默认判断，除非另行否决）

- **判断 A —— 纯英文单语文档（AGENTS.md 系列）保留英文不动**：根 `AGENTS.md`、`docs/AGENTS.md`、`packages/AGENTS.md`、`.agents/notes/**/AGENTS.md` 是给 AI 的 standing orders，本非双语配对文档、不构成"写两份"负担。仅删除 / 改写其中"双语配对"相关条款，不整体翻译成中文。若需中文化，属独立工程。
- **判断 B —— 删除范围精确锚定"有 `.i18n.yaml` 的配对"**：不碰 packages 内非配对的英文 README 与源码注释。
- **判断 C —— UI 移除英文是产品级、不可逆变更**：DSH 为开源项目，移除 Web UI 英文后海外用户只能用中文界面。已确认执行。

## 7. 风险与验证策略

- 删除 / 改写走脚本批量（`git mv` + `find` + `sed`），不逐文件手工操作，降低遗漏。
- 每批次完成立即验证：批次 1/2 跑 `doc-sync`、`test:docs`；批次 3 跑 `test:gui`、`typecheck`。
- 分批提交，每批可独立 review。
- 关键风险：删除英文后 `verify-md-links` 报死链接；`LocaleNamespaceMap` / `BuiltInLocaleId` 收窄引发的编译错误需以 `typecheck` 全量收敛。

## 8. 后续步骤

1. 用户审阅本方案，确认三个默认判断。
2. 从批次 1 开始串行实施，每批验证后进入下一批。
3. 全部完成后跑全量门禁闭环，并在变更记录中沉淀漏拦复盘。
