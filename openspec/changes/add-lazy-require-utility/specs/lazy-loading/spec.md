# lazy-loading 规范增量

## ADDED Requirements

### Requirement: 调用方相对的惰性加载器

`@deepseek-ai/dsh-lazy-require` SHALL 导出 `createLazyRequire<T>(specifier, parentURL)`，返回一个零参数 loader。该 loader MUST NOT 在构造时加载依赖，MUST 在首次调用时以 `node:module` 的 `createRequire(parentURL)` 加载 `specifier`。

`parentURL` SHALL 决定 specifier 的解析基准；本包 MUST NOT 用自身模块位置解析 specifier。

#### Scenario: 解析基准来自调用方

- **WHEN** 调用方以自身的 `import.meta.url` 作为 `parentURL` 构造 loader
- **THEN** 依赖 SHALL 按该调用方 package 的解析路径解析
- **AND** 本包被安装多份副本时 SHALL 仍解析到调用方所属的那一份

#### Scenario: 首次调用才加载

- **WHEN** 构造出一个 loader 但尚未调用它
- **THEN** 依赖 SHALL NOT 被加载
- **AND** 依赖的模块副作用 SHALL NOT 发生

### Requirement: 只缓存成功的加载

loader SHALL 记忆化成功加载的模块值，MUST NOT 缓存失败的加载。

#### Scenario: 成功结果被复用

- **WHEN** 连续两次调用同一个 loader 且首次加载成功
- **THEN** 两次调用 SHALL 返回同一个模块值
- **AND** 依赖 SHALL 只被加载一次

#### Scenario: 失败的加载不被缓存

- **WHEN** 一次调用因依赖缺失而抛出
- **THEN** 该错误 SHALL 原样传播给调用方
- **AND** 再次调用同一个 loader 时 SHALL 重新尝试加载
- **AND** 补齐依赖后 SHALL 加载成功

### Requirement: 依赖门禁识别惰性 specifier

`scripts/verify-package-dependencies.ts` 的 `collectRuntimeSourceExportUses()` SHALL 把 `createLazyRequire` 调用中的字面量 specifier 识别为运行时依赖。识别 SHALL 覆盖具名导入（含重命名）与命名空间导入两种形式。

被识别的 specifier MUST 与 `import()`、`require()` 的字面量同等对待，即记为 `NAMESPACE_RUNTIME_EXPORT`。

#### Scenario: 具名绑定被识别为运行时依赖

- **WHEN** 一个源文件从 `@deepseek-ai/dsh-lazy-require` 具名导入 `createLazyRequire`，并以字面量 specifier 调用它
- **THEN** 该 specifier SHALL 出现在该文件的运行时导出使用集合中
- **AND** 它 SHALL 被记为命名空间运行时导出

#### Scenario: 命名空间绑定被识别为运行时依赖

- **WHEN** 一个源文件以命名空间形式导入该包，并调用其 `createLazyRequire` 成员
- **THEN** 该调用的字面量 specifier SHALL 同样被记为运行时依赖

#### Scenario: 非惰性调用不被误判

- **WHEN** 一个源文件调用与该包无关的普通函数
- **THEN** 其字面量实参 SHALL NOT 被记为运行时依赖
- **AND** `import()` 与 `require()` 的既有识别结果 SHALL 保持不变

### Requirement: 包登记与 invariant 伴生件

新增包 SHALL 完成 workspace 登记：`tsconfig.base.json` 的 `paths`、`tsconfig.host.json` 的 project reference、`packages/util/README.zh.md` 的包表，以及 `docs/config-catalog.zh.md` 的库包索引。

按本地 `packages/AGENTS.md` 的规则，该包 SHALL 发布 `./invariant` 伴生入口。

#### Scenario: 包入口可在 workspace 内解析

- **WHEN** 一个 workspace 包 import `@deepseek-ai/dsh-lazy-require`
- **THEN** TypeScript SHALL 经 `paths` 解析到 `packages/util/lazy-require/src`
- **AND** `tsconfig.host.json` SHALL 引用该包

#### Scenario: 空 invariant 伴生件带说明

- **WHEN** 该包的 invariant 伴生件以空 installer 注册
- **THEN** 其源码 SHALL 含 `No runtime invariant:` 说明
- **AND** `exports["./invariant"]` SHALL 指向 `./lib/types/invariant.d.ts` 与 `./lib/invariant.js`
- **AND** `verify-package-invariants` SHALL 通过

### Requirement: 静态打包限制被记录

该包 README SHALL 在「已知限制与延期工作」记录：静态打包器不发现仅在 `createLazyRequire()` 调用中命名的依赖。

#### Scenario: README 记录打包限制

- **WHEN** 阅读该包 README 的「已知限制与延期工作」
- **THEN** SHALL 存在关于静态打包器无法发现惰性 specifier 的条目
- **AND** SHALL 说明 Preview image 使用的 package 需要保持该依赖通过受支持的字面量请求可达
