# Agent Note: 出站代理策略从启动快照解析并在首个插件挂载前安装

Status: implemented

## Problem

Node 的内建 `fetch`（undici）不读 `HTTP_PROXY` 一类的环境变量——它默认直连。因此一个在企业代理后运行的部署，其模型适配器、MCP HTTP 传输与 web 工具的请求都会绕过代理。

三条路都走不通：

- 依赖 `NODE_USE_ENV_PROXY`：Node 在**进程启动时**采样环境，因此声明在 `.env` 层里的代理看不到；而该变量本身也无法在进程启动后由代码补设。
- 让每个消费方各自建 dispatcher：`packages/llm`、`mcp-client`、`web-fetch-http` 会各自复制一份策略解析，且任何新消费方都可能漏做。
- 在插件里安装：插件挂载时可能已经发出过请求。

## Decision

新增 `packages/util/http-proxy`，把「解析策略」与「安装 dispatcher」拆成两个可独立测试的步骤，并在 `apps/cli/src/profile-boot.ts` 的 `runProfile` 中**先于 `composeProfile`** 调用安装：

```ts
const disposeProxy = await installProxyFromEnvironment(options.environment, report)
const composed = await composeProfile(options.profile, options.patchFiles)
```

安装位置是整个设计的成立条件：任何插件一经挂载就可能发起请求，所以安装必须发生在第一个插件之前。返回的 disposer 接入 `createProcessShutdown`，与进程生命周期同生共死。

**从 `options.environment`（启动器快照）解析，而不是 `process.env`**——这正是 `.env` 层里声明的代理能生效的原因。

配套三处：

- `packages/boot/app-boot/src/index.ts` 的 `HOME_LAYER_PROXY_NAMES` 让 harness home 的 `.env` 可以声明四个代理变量。该豁免**只对 home 层开放**：调用目录的 `.env` 与项目层仍被拒绝，因为代理改变的是出站路由这一进程级安全属性。
- `packages/web/web-fetch-http` 的三处内部 dispatcher 构造改为经 `proxyRouteFor` 解析，并就地标注 `proxy-exempt:`（豁免点是被有意保留的直连路径）。
- 新增门禁 `scripts/verify-no-bare-dispatcher.ts`，AST 扫描全仓，拒绝在 `packages/util/http-proxy/` 之外构造 undici agent 或向请求传显式 `dispatcher`。

## 曾考虑的替代方案

**依赖 `NODE_USE_ENV_PROXY`。** 不予采用：Node 在进程启动时采样环境，`.env` 层里声明的代理对它不可见，且该标志无法在启动后补设。

**让每个消费方各自解析并安装。** 不予采用：策略解析会被复制到三处以上，且新增消费方容易漏做——这正是门禁要防的失败模式。

**在插件内安装 dispatcher。** 不予采用：插件挂载时可能已经发过请求，安装时机就晚了；这正是本设计把安装放在 `composeProfile` 之前的原因。

**把豁免开放给所有 `.env` 层（含项目层）。** 不予采用：项目层文件随仓库走，让它可以重定向出站流量会把一个仓库内文件变成流量劫持点；home 层是操作者自己的机器偏好，风险归属清晰。

**用正则扫描代替 AST。** 不予采用：`dispatcher: x` 与 `'dispatcher': x` 与 `undici.fetch(..., { dispatcher })` 都需要语法感知才能可靠判定，正则既会漏报也会误报。

## Consequences

代理策略在进程内只解析一次、只安装一次，所有经 undici 的出站请求统一遵循它。`NO_PROXY` 的匹配语义与 Node 自身保持一致（同一份实现被两侧使用）。

代价与边界：安装依赖 `runProfile` 的调用顺序这一**位置契约**，它目前只由代码注释与本次新增的 boot 级测试守护，重构把安装移到 `composeProfile` 之后会静默破坏它。仅覆盖 undici 路径——使用其他 HTTP 客户端的代码不受影响。子进程不自动继承代理（`proxyEnvironmentForChild` 用于显式传递）。

`.env` 的接受面因 home 层豁免而变宽，这一点已写入 `packages/boot/app-boot/README.zh.md`。

## Testing

`packages/util/http-proxy/tests/` 三个 spec：`policy.spec.ts` 覆盖解析与 `NO_PROXY` 匹配，`install.spec.ts` 证明内置 `fetch` 被重定向，`matcher-parity.spec.ts` 固定与 Node 的匹配语义一致。`packages/web/web-fetch-http/tests/proxy.spec.ts` 用真实 `node:http` 假代理与真实 origin 服务器驱动实际传输，断言经代理时跳过了本地地址解析。`packages/boot/app-boot/tests/app-boot.spec.ts` 覆盖 home 层放行与调用目录/项目层仍被拒。`scripts/verify-no-bare-dispatcher.spec.ts` 覆盖四种违规形态与当前树通过。

`docs/development.zh.md` 记录该策略的单一真相源与四个消费方。
