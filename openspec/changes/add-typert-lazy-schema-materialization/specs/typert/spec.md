# typert 规范增量

## ADDED Requirements

### Requirement: 生成 schema 以工厂形式发射

typert 生成器 SHALL 为每个类型边界与每个类型声明发射工厂函数，而非立即求值的 schema 值。工厂 MUST 在首次调用时构造 schema 并缓存结果，后续调用 MUST 返回同一实例。

生成的类型声明文件 SHALL 把对应导出声明为返回 `z.ZodType` 的函数。

#### Scenario: 边界 schema 在首次调用时才构造

- **WHEN** 一个生成的包被加载
- **THEN** 其边界 schema MUST NOT 在加载期被构造
- **AND** 首次调用该工厂时 SHALL 构造并返回 schema

#### Scenario: 工厂重复调用返回同一实例

- **WHEN** 同一 schema 工厂被调用多次
- **THEN** 每次调用 SHALL 返回同一个 schema 实例
- **AND** SHALL NOT 重复构造

#### Scenario: 生成的声明与实现一致

- **WHEN** 消费方按生成声明使用该导出
- **THEN** 该导出 SHALL 可用作返回 `z.ZodType` 的函数
- **AND** 按值使用 SHALL 成为编译错误

### Requirement: 递归 schema 引用调用工厂

生成器为递归声明发射 `z.lazy` 时 SHALL 在回调内调用工厂，MUST NOT 直接引用工厂函数本身。

#### Scenario: 递归 schema 可正常解析

- **WHEN** 一个自引用类型声明被生成并用于解析一个嵌套值
- **THEN** 解析 SHALL 成功
- **AND** SHALL NOT 因 `z.lazy` 回调返回非 schema 而失败

#### Scenario: 泛型声明的递归引用保持参数化调用

- **WHEN** 一个带类型参数的声明递归引用自身
- **THEN** 其 `z.lazy` 回调 SHALL 以该声明的类型参数调用工厂

### Requirement: 严格编解码以工厂暴露 schema

`TypertCodec` 的 strict 分支 SHALL 以 `readonly create: () => TypertSchema` 暴露 schema，MUST NOT 以已物化的 `readonly schema: TypertSchema` 暴露。

消费严格编解码的代码 SHALL 经 `codec.create()` 取得 schema 后再使用。

#### Scenario: 网关经工厂解析输入

- **WHEN** 网关解码一个严格编解码承载的边界值
- **THEN** 它 SHALL 调用 `codec.create()` 取得 schema
- **AND** SHALL 以该 schema 的 `parse` 校验值

#### Scenario: 客户端经工厂解析输入

- **WHEN** 客户端解析一个生成 Remote 方法的输入字段
- **THEN** 它 SHALL 调用 `codec.create()` 取得 schema
- **AND** 校验失败 SHALL 以既有形态报错

### Requirement: 注册表在读取出口物化并缓存

typert 注册表 SHALL 以工厂形态存储贡献，并在读取出口物化。`get()`、`resolve()`、`list()` SHALL 返回包含已物化 schema 的记录。每个注册条目 MUST 至多物化一次，物化结果 SHALL 缓存在该条目上。

物化 MUST NOT 发生在注册期，也 MUST NOT 因未被读取而发生。

#### Scenario: 未读取的 schema 不被物化

- **WHEN** 一个包贡献了若干 schema，但调用方只读取其中一个
- **THEN** 只有被读取的 schema SHALL 被物化
- **AND** 其余 schema 的工厂 SHALL NOT 被调用

#### Scenario: 同一 schema 的重复读取复用缓存

- **WHEN** 同一 schema 被 `get()` 或 `resolve()` 读取多次
- **THEN** 其工厂 SHALL 只被调用一次
- **AND** 每次读取 SHALL 返回同一个 schema 实例

#### Scenario: list 返回物化后的记录

- **WHEN** 调用方枚举 schema 并应用过滤条件
- **THEN** 返回的每条记录 SHALL 包含已物化的 `schema`
- **AND** 被过滤掉的条目 SHALL NOT 被物化

#### Scenario: 包撤回后缓存随之消失

- **WHEN** 一个贡献被撤回
- **THEN** 其注册条目 SHALL 被移除
- **AND** 其物化缓存 SHALL 一并消失
- **AND** 重新注册 SHALL 从工厂重新物化

### Requirement: 贡献面与读取面类型分离

typert 注册表 SHALL 以 `TypertSchemaFactory` 作为贡献面的 schema 类型（`name` + `create`），以 `TypertSchemaRecord` 作为读取面的类型（含已物化的 `schema` 与身份字段）。`TypertSchemaRecord` MUST NOT 继承 `TypertSchemaFactory`。

#### Scenario: 贡献方提供工厂

- **WHEN** 一个生成包注册其 schema 贡献
- **THEN** 每个贡献项 SHALL 满足 `{ name: string; create: () => z.ZodType }`

#### Scenario: 读取方获得物化记录

- **WHEN** 调用方取得一个 schema 记录
- **THEN** 该记录 SHALL 含 `name`、已物化的 `schema`、`package`、`face` 与 `key`
- **AND** SHALL NOT 要求调用方再调用工厂

### Requirement: 校验探测工厂契约而非 zod 内部标记

typert 加载器与注册表校验 schema 与严格编解码时 SHALL 校验其满足工厂契约（`typeof create === 'function'`），MUST NOT 探测 zod 实例的内部标记（如 `_zod`）。缺少工厂的贡献 MUST 在注册期或加载期失败。

#### Scenario: 缺少 create 的 schema 贡献在注册期被拒绝

- **WHEN** 一个贡献项没有 `create` 函数
- **THEN** 注册 SHALL 抛出错误并指明该 schema 名
- **AND** SHALL NOT 延迟到首次读取时才失败

#### Scenario: 缺少 create 的编解码被拒绝

- **WHEN** 一个严格编解码没有 `create` 函数
- **THEN** 校验 SHALL 抛出错误并指明该主题

#### Scenario: 加载期不因校验而物化 schema

- **WHEN** 加载器校验一个合法清单
- **THEN** 它 SHALL NOT 调用任何 schema 工厂
- **AND** 校验 SHALL 仅检查契约形状

### Requirement: 生成产物与源码保持一致

`packages/extensions/tool-cordis/src/api-catalog.ts` SHALL 反映 typert 源码的契约描述（`TypertSchemaFactory`、`TypertCodec.create` 与 `get` / `resolve` / `list` 的返回语义）。MUST NOT 用官方文件整段覆盖该文件，MUST NOT 丢失本地 fork 已有的内容。

因本地生成器存在未登记服务而失败，本次对该文件的改动 SHALL 以定点修改字符串常量完成，并 SHALL 在 tasks 中记录恢复生成能力的后续工作。

#### Scenario: 类型声明反映工厂契约

- **WHEN** 检查生成产物中的 `TypertCodec` 声明
- **THEN** 其 strict 分支 SHALL 声明 `create: () => TypertSchema`
- **AND** 其 SHALL 声明 `TypertSchemaFactory`

#### Scenario: 本地 fork 内容不被覆盖

- **WHEN** 更新生成产物
- **THEN** 本地 fork 独有的条目（如 `delivery` 服务区块）SHALL 保持存在
- **AND** SHALL NOT 用官方版本整段替换该文件

#### Scenario: 生成器不可用被显式记录

- **WHEN** 尝试运行 `pnpm run gen-cordis-catalog`
- **THEN** 该命令 SHALL 因 `ctx.skillRoots` 与 `ctx.mcpAuthSink` 未登记而失败
- **AND** 该限制 SHALL 被记录为独立的前置修复项

### Requirement: 测试生成产物不被跟踪

`packages/typert/generator/tests/` 下的 `.generated-*` 临时产物 SHALL NOT 被 git 跟踪，但在分叉点就已被跟踪且与官方一致的 2 个历史遗留 SHALL 保持跟踪。清理 MUST 使用 `git rm --cached`，MUST NOT 删除文件浏览器。

#### Scenario: 清理后 gitignore 规则生效

- **WHEN** 需清理的 `.generated-*` 产物经 `git rm --cached` 移出索引
- **THEN** `.gitignore` 中 `packages/typert/generator/tests/.generated-*/` 规则 SHALL 对后续产物生效
- **AND** 后续测试运行 SHALL NOT 产生新的跟踪条目

#### Scenario: 两个历史遗留保持跟踪

- **WHEN** 执行清理
- **THEN** `.generated-model-O7FJNT/host.mjs` 与 `.generated-model-qwn8sk/host.mjs` SHALL 仍在索引中
- **AND** 其内容 SHALL 与分叉点一致

#### Scenario: 清理保留文件浏览器

- **WHEN** 执行清理
- **THEN** 磁盘上的生成产物 SHALL 保持存在
- **AND** 测试 SHALL 无需重新生成即可通过
