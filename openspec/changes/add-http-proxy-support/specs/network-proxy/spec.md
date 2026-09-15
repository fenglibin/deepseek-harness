# network-proxy 规范增量

## ADDED Requirements

### Requirement: 出站请求遵循代理环境

Harness SHALL 把启动环境中的 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 与 `NO_PROXY` 解析为代理策略，并安装为进程级 undici dispatcher。该策略 SHALL 在第一个插件挂载之前生效。

策略 SHALL 从启动器捕获的环境快照解析，而不是读取 `process.env`，使 `.env` 层声明的代理同样生效。

#### Scenario: 代理环境变量重定向出站请求

- **WHEN** 启动环境中设置了指向某代理的 `HTTPS_PROXY`
- **THEN** Harness 自身的出站 HTTPS 请求 SHALL 经该代理发出
- **AND** 适配器、MCP 传输与 web 工具的请求 SHALL 全部遵循同一策略

#### Scenario: 无代理配置时直连

- **WHEN** 启动环境中没有任何代理变量
- **THEN** 出站请求 SHALL 直接发往目标
- **AND** 其可观察行为 SHALL 与本变更前一致

#### Scenario: NO_PROXY 豁免列出的目标

- **WHEN** 启动环境设置了代理并同时设置了 `NO_PROXY`
- **THEN** 命中 `NO_PROXY` 列表的目标 SHALL 直连
- **AND** 其余目标 SHALL 经代理

#### Scenario: home 的 .env 可以声明代理

- **WHEN** Harness home 的 `.env` 声明 `HTTPS_PROXY`
- **THEN** 该值 SHALL 进入代理策略
- **AND** 调用目录 `.env` 声明的同名变量 SHALL 被拒绝

### Requirement: 证书与 TLS 变量在任何层都被拒绝

`SSL_CERT_FILE`、`SSL_CERT_DIR`、`REQUESTS_CA_BUNDLE`、`CURL_CA_BUNDLE` 与 `NODE_TLS_REJECT_UNAUTHORIZED` SHALL 只能来自继承的进程环境。任何 `.env` 层声明它们 SHALL 被拒绝，包括 Harness home 层。

#### Scenario: home 的 .env 声明 CA 文件被拒绝

- **WHEN** Harness home 的 `.env` 声明 `SSL_CERT_FILE`
- **THEN** 启动 SHALL 失败并指出该名字只能来自继承环境

### Requirement: 包不得绕过全局 dispatcher

包 SHALL NOT 自建 undici agent，也 SHALL NOT 给 `fetch` 显式传递 `dispatcher` 选项，因为显式 dispatcher 会覆盖全局策略。需要绕过的场景 SHALL 在源码中携带 `proxy-exempt: <理由>` 标记。

#### Scenario: 门禁拒绝显式 dispatcher

- **WHEN** 某包源码给 `fetch` 显式传递 `dispatcher`
- **THEN** `verify-no-bare-dispatcher` SHALL 报告违规并指出文件与位置

#### Scenario: 带理由的豁免被放行

- **WHEN** 某包源码携带 `proxy-exempt: <理由>` 标记并使用显式 dispatcher
- **THEN** 门禁 SHALL NOT 报告违规

#### Scenario: 无关文件不被解析

- **WHEN** 某源码文件既不含 `undici` 也不含 `dispatcher`
- **THEN** 门禁 SHALL 跳过该文件的 AST 解析
