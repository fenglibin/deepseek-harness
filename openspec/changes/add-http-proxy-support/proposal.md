# 增加出站网络代理支持

## 为什么

本地当前完全没有代理支持。Node 的 `fetch` 默认忽略 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 与 `NO_PROXY` 环境变量，而本地没有任何代码安装 undici 全局 dispatcher。

后果是本地所有出站请求都直连目标：`packages/llm/llm-deepseek/src/adapter.ts:643` 的 `fetch`、内网模型插件、MCP HTTP 传输、以及 `dsh-tool-web` 的搜索与抓取。代理环境变量只对子进程生效，Harness 自身的流量绕过代理。对部署在内网或必须经代理出网的环境，这是功能性缺口。

官方以 `packages/util/http-proxy` 提供该能力，并在 CLI 启动路径的第一个插件挂载之前安装它。

## 做什么

- 新增 `packages/util/http-proxy` 包，从启动环境快照解析代理策略并安装为 undici 全局 dispatcher
- 在 `apps/cli/src/profile-boot.ts` 的 profile 组装之前调用安装函数
- 在 `packages/boot/app-boot/src/index.ts` 增加 Harness home 层的代理名豁免，使 home 的 `.env` 可以声明代理
- 新增 `verify-no-bare-dispatcher` 门禁，禁止包自建 agent 或显式传 `dispatcher` 绕过全局策略

## 不做什么

- 不改 `NODE_USE_ENV_PROXY` 相关行为：Node 在进程启动时采样环境，无法反映 `.env` 层声明的代理
- 不在 CA 与 TLS 相关名字上开口子：它们改变信任对象而非路由，在任何层都保持拒绝
- 不为单个适配器提供 per-request 代理覆盖：策略是进程级的，per-request 覆盖会重新引入绕过路径

## 影响

- `packages/util/http-proxy/`：新增包（约 681 行，`index.ts` 导出面、`install.ts` dispatcher 安装、`policy.ts` 策略解析）
- `packages/boot/app-boot/src/index.ts`：新增 `HOME_LAYER_PROXY_NAMES` 常量与 `isBootstrapOnly` 的分层判定
- `apps/cli/src/profile-boot.ts`：新增 `installProxyFromEnvironment` 调用与 disposer 接线
- `apps/cli/package.json`：新增 `@deepseek-ai/dsh-http-proxy` 依赖
- `scripts/verify-no-bare-dispatcher.ts` 与 `.spec.ts`：新增
- `scripts/run-gates.ts`：新增 gate
- `tsconfig.base.json`：新增 paths 映射

代理策略影响每个出站请求的路由，属于安全相关变更，定为 l2。
