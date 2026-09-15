# 技术决策

设计草案见 [docs/design/upstream-batch1-quick-wins.zh.md](../../../docs/design/upstream-batch1-quick-wins.zh.md)。本文件记录决策编号，供 tasks.md 锚定。

### D1 从启动环境快照解析，而不是 process.env

`installProxyFromEnvironment` 接受启动器捕获的环境快照，而不是直接读 `process.env`。

理由是 `.env` 分层：Harness home 的 `.env` 是用户自己的文件，允许声明代理；而 Node 在进程启动时就采样了环境，`NODE_USE_ENV_PROXY` 无法看到之后才解析出的 `.env` 值。从启动器快照解析是让 `.env` 层声明的代理生效的唯一路径。

官方 `apps/cli/src/profile-boot.ts:299` 在同一位置注释了这一理由。

### D2 在第一个插件挂载之前安装

调用点位于 `runProfile` 中、`composeProfile` 之前。任何插件一旦挂载就可能发起请求（凭据解析、模型目录拉取、MCP 连接），因此策略必须在这些之前生效。

安装函数返回 disposer，由 profile 生命周期持有，与 `createProcessShutdown` 同一层。

### D3 Harness home 层豁免代理名，CA 与 TLS 名不豁免

`packages/boot/app-boot/src/index.ts` 的 `BOOTSTRAP_NAMES` 拒绝 `.env` 声明 bootstrap 类变量。本地当前对所有层一视同仁。

代理决定每个请求的路由，而调用目录的 `.env` 随克隆一起来自他人，因此继续拒绝；Harness home 的 `.env` 是用户自己的，允许声明 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY`。

`SSL_CERT_FILE`、`SSL_CERT_DIR`、`REQUESTS_CA_BUNDLE`、`CURL_CA_BUNDLE`、`NODE_TLS_REJECT_UNAUTHORIZED` 在任何层都保持拒绝：它们改变信任对象，不是路由。`DSH_HOME` 本身是 bootstrap-only，因此没有任何 `.env` 能重新定位这个豁免。

### D4 裸 dispatcher 门禁与代理支持同批落地

显式 `dispatcher` 会覆盖全局 dispatcher，从而静默绕过 D1-D3 安装的策略。两者是同一契约的两面。

**本地已存在门禁要拒绝的形态**：`packages/web/web-fetch-http/src/network.ts:179-190` 的 `requestPinned()` 无条件执行 `const { Agent, fetch } = await import('undici')`、`new Agent({...})` 与 `fetch(url, { ..., dispatcher })`。官方把这一形态描述为「proxy support 之前 `web-fetch-http` 携带的确切缺陷，其 DNS 钉扎 agent 静默绕过了每一个代理」。

因此门禁与代理实现必须同批：只落地门禁会让 `scanRepository()` 在本地树上报出两条违规并使 CI 红；只落地代理会让该绕过路径继续存在。

落地时改 `web-fetch-http` 经 `proxyRouteFor(url)` 路由，并在确实拥有自有传输的三处标注 `proxy-exempt: <理由>`——该包把请求钉在已校验的地址上，这是进程级 dispatcher 无法承载的按请求状态。

**移植基准是官方 master 的 226 行版本**，不是初版 `545e2ad914` 的 91 行正则版。官方演进链为 `545e2ad914`（91 行，逐行正则）→ `e6dbf85f6c`（178 行，改为语法感知 AST）→ `cfc9b3bdef`（219 行）→ `4623c68e70`（223 行，两词预过滤）→ `c62d6f3a44`（包路径迁到 `util/`）→ `8470ddef1d`（226 行，API 收敛）。正则版会漏掉 `{ dispatcher }` 简写与 `import { Agent as X }` 重命名，与本地 `scripts/AGENTS.md` 对语法感知发现的要求冲突。

门禁的性能处理照搬 `4623c68e70`：源码既不含 `undici` 也不含 `dispatcher` 时跳过 AST 解析。官方实测通过过滤的文件从 1597 降到 21，该模式可复用到任何 AST 门禁。

例外机制为 `proxy-exempt: <理由>` 标记，判定范围是违规行本身或其正上一行——语法感知的匹配锚定在属性或 `new` 表达式而非整条语句，说明文字适合放在长行上方。

## 被拒绝的方案

**在 `packages/llm` 适配器内逐请求设置代理**：不采用。适配器无法覆盖 MCP、web 工具与凭据解析等其他出站路径，且 per-request 覆盖重新引入绕过路径。

**依赖 `NODE_USE_ENV_PROXY=1`**：不采用。Node 在进程启动时采样环境，`.env` 层声明的代理不生效；且它只覆盖 `fetch`，不覆盖其他 undici 消费方。

**让所有 `.env` 层都能声明代理**：不采用。调用目录的 `.env` 随克隆到达，允许它改路由等于允许仓库内容重定向用户流量。

**只移植门禁、暂不移植代理实现**：不采用。门禁保护的对象（全局 dispatcher）不存在时，门禁既无保护对象又会让本地树立即失败；其错误信息指向的 `proxyRouteFor` 也不可用。

**照抄初版 `545e2ad914` 的正则门禁**：不采用。它漏掉简写与重命名两种形态，且违反本地对语法感知发现的要求。
