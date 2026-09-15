# 实施清单

## 1. http-proxy 包

- [ ] 1.1 新建 `packages/util/http-proxy/`，含 `package.json`（`@deepseek-ai/dsh-http-proxy`）、`tsconfig.json`、`README.zh.md`、`src/index.ts` (covers: network-proxy/出站请求遵循代理环境, design/D1)
- [ ] 1.2 实现 `src/policy.ts`：从环境快照解析代理策略，处理 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` 的大小写变体与 `NO_PROXY` 的域名、后缀、端口匹配 (covers: network-proxy/NO_PROXY 豁免列出的目标, design/D1)
- [ ] 1.3 实现 `src/install.ts`：把策略装为 undici 全局 dispatcher，返回释放函数；无代理配置时返回无操作释放函数 (covers: network-proxy/无代理配置时直连, design/D2)
- [ ] 1.4 在 `src/index.ts` 导出 `installProxyFromEnvironment` 与策略类型，注册进 `tsconfig.base.json` 的 paths 与聚合 tsconfig (covers: network-proxy/出站请求遵循代理环境, design/D2)

## 2. 启动接线

- [ ] 2.1 在 `packages/boot/app-boot/src/index.ts` 新增 `HOME_LAYER_PROXY_NAMES` 常量（`HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY`） (covers: network-proxy/home 的 .env 可以声明代理, design/D3)
- [ ] 2.2 修改 `isBootstrapOnly` 或其调用点，使 home 层的 `.env` 对这些名字放行，其余层继续拒绝；CA 与 TLS 名字在所有层保持拒绝 (covers: network-proxy/home 的 .env 可以声明代理, network-proxy/证书与 TLS 变量在任何层都被拒绝, design/D3)
- [ ] 2.3 在 `apps/cli/src/profile-boot.ts` 的 `runProfile` 中、`composeProfile` 之前调用 `installProxyFromEnvironment(options.environment, warn)`，并把返回的 disposer 接入 profile 生命周期 (covers: network-proxy/出站请求遵循代理环境, design/D2)
- [ ] 2.4 在 `apps/cli/package.json` 添加 `@deepseek-ai/dsh-http-proxy` 依赖 (covers: network-proxy/出站请求遵循代理环境, design/D2)

## 3. 门禁

- [ ] 3.1 新增 `scripts/verify-no-bare-dispatcher.ts`：以官方 master 的 226 行语法感知版本为基准（**不是** `545e2ad914` 的 91 行正则版），用 TypeScript AST 检测自建 undici agent 与显式 `dispatcher` 传参 (covers: network-proxy/门禁拒绝显式 dispatcher, design/D4)
- [ ] 3.2 识别范围覆盖 `import { Agent as X }` 重命名、`import * as undici` 命名空间、`const { Agent } = await import('undici')` 解构、动态导入重命名与函数内嵌套的动态导入 (covers: network-proxy/门禁拒绝显式 dispatcher, design/D4)
- [ ] 3.3 识别 `dispatcher: x`、`{ dispatcher }` 简写与 `{ 'dispatcher': x }` 三种写法 (covers: network-proxy/门禁拒绝显式 dispatcher, design/D4)
- [ ] 3.4 实现两层豁免：`packages/util/http-proxy/` 目录级豁免（路径先归一化为 POSIX 分隔符），以及 `proxy-exempt: <理由>` 标记的行级豁免（违规行本身或其正上一行） (covers: network-proxy/带理由的豁免被放行, design/D4)
- [ ] 3.5 在脚本中加入 `undici` 与 `dispatcher` 两词预过滤，源码不含二者时跳过 AST 解析 (covers: network-proxy/无关文件不被解析, design/D4)
- [ ] 3.6 在扫描语料为空时抛错，避免 glob 失配后门禁空过 (covers: network-proxy/门禁拒绝显式 dispatcher, design/D4)
- [ ] 3.7 新增 `scripts/verify-no-bare-dispatcher.spec.ts`，覆盖：显式 dispatcher 被拒、简写与引号键被拒、别名与命名空间构造被拒、动态导入各形态被拒、`proxy-exempt` 同行与上一行放行、归属包豁免、Windows 分隔符归一化、预过滤跳过、以及 `scanRepository()` 在本地树返回空 (covers: network-proxy/门禁拒绝显式 dispatcher, network-proxy/带理由的豁免被放行, network-proxy/无关文件不被解析, design/D4)
- [ ] 3.8 在 `scripts/run-gates.ts` 的 `ciSharedStaticGates()` 与 `hygieneLeafGates()` 各注册一个 gate (covers: network-proxy/门禁拒绝显式 dispatcher, design/D4)
- [ ] 3.9 在 `package.json` 添加 `verify-no-bare-dispatcher` 脚本入口 (covers: network-proxy/门禁拒绝显式 dispatcher, design/D4)

## 3b. web-fetch-http 改走策略路由

- [ ] 3b.1 修改 `packages/web/web-fetch-http/src/network.ts` 的 `requestPinned()`（`:179-190`），改经 `proxyRouteFor(url)` 取得路由与该路由所假定的传输，不再无条件自建 agent (covers: network-proxy/出站请求遵循代理环境, design/D4)
- [ ] 3b.2 在确实拥有自有传输的三处（钉扎 agent 的构造、传入该 agent 的 `dispatcher` 选项、以及按策略移交的 dispatcher）标注 `proxy-exempt: <理由>`，说明这是进程级 dispatcher 无法承载的按请求地址钉扎 (covers: network-proxy/带理由的豁免被放行, design/D4)
- [ ] 3b.3 新增或更新 `packages/web/web-fetch-http/tests/egress.spec.ts`，用假代理驱动实际传输并断言观察到的路由 (covers: network-proxy/代理环境变量重定向出站请求, design/D4)

## 4. 测试

- [ ] 4.1 单测：`policy.ts` 的解析——四个变量的大小写变体、无变量、仅 `NO_PROXY`、非法 URL (covers: network-proxy/出站请求遵循代理环境, network-proxy/NO_PROXY 豁免列出的目标, design/D1)
- [ ] 4.2 单测：`install.ts` 在无代理配置时返回无操作释放函数，且不改变全局 dispatcher (covers: network-proxy/无代理配置时直连, design/D2)
- [ ] 4.3 集成测试：起一个本地记录型代理，设 `HTTPS_PROXY` 指向它，断言出站请求经该代理；再设 `NO_PROXY` 命中目标，断言直连 (covers: network-proxy/代理环境变量重定向出站请求, network-proxy/NO_PROXY 豁免列出的目标)
- [ ] 4.4 测试：home 层 `.env` 声明 `HTTP_PROXY` 被接受，声明 `SSL_CERT_FILE` 被拒绝；调用目录层 `.env` 声明 `HTTP_PROXY` 被拒绝 (covers: network-proxy/home 的 .env 可以声明代理, network-proxy/证书与 TLS 变量在任何层都被拒绝, design/D3)
- [ ] 4.5 REAL-composition 测试：经 Loader 与真实 `cordis.yml` 启动 profile，断言代理在插件挂载前已生效 (covers: network-proxy/代理环境变量重定向出站请求, design/D2)

## 5. 文档

- [ ] 5.1 编写 `packages/util/http-proxy/README.zh.md`，含配置来源、`NO_PROXY` 语义、与 `NODE_USE_ENV_PROXY` 的区别、以及"已知限制与延期工作" (covers: design/D1, design/D3)
- [ ] 5.2 更新 `packages/boot/app-boot/README.zh.md` 的 `.env` 分层说明，记录 home 层代理豁免与 CA/TLS 不豁免 (covers: network-proxy/home 的 .env 可以声明代理, network-proxy/证书与 TLS 变量在任何层都被拒绝, design/D3)
- [ ] 5.3 更新 `docs/development.zh.md` 或等效文档，说明代理环境变量的使用方式 (covers: network-proxy/出站请求遵循代理环境)
- [ ] 5.4 新增 Agent Note 记录代理策略从启动快照解析、home 层豁免与裸 dispatcher 门禁三项决策 (covers: design/D1, design/D3, design/D4)
