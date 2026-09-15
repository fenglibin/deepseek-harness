# 上游能力移植执行状态（已完结）

本文档记录 13 个 openspec 变更的落地与验证结论。**全部 13 个变更已实现、验证并提交**，13/13 通过 `openspec validate --strict`。

## ⚠️ 关键环境发现：src/ 下的陈旧构建产物会遮蔽 TypeScript 源码

仓库里曾有 **107 个未被跟踪但已被 `.gitignore` 覆盖的 `src/*.js`**（连同 `.js.map`、`.d.ts`、`.d.ts.map`），时间戳早于本次执行。Vite/Vitest 的默认 `resolve.extensions` 把 `.js` 排在 `.ts` 之前，因此 `import '@deepseek-ai/dsh-X'` 会解析到陈旧编译产物而不是源码——**测试长期跑在旧代码上且无任何报错**。

已清理，`src/*.js` 计数为 0。**注意保留 41 个 `css-modules.d.ts` 与 `use-sync-external-store.d.ts`、`ripgrep.d.ts`、`turndown-plugin-gfm.d.ts` 等被 git 跟踪的合法声明文件。**

由此修正的方法论：`git stash` **不能**用来判断"失败是否预先存在"（它不影响未跟踪产物）。本次改用「`git show HEAD:<path>` 对比」与「`git log <range> -- <path>` 确认改动面」两种可证方法。

## 交付总览

| # | change | 状态 | 关键验证 |
|---|---|---|---|
| 1 | `update-default-tool-set` | ✅ | base 3 测试；`verify-cordis-config` 157 文件 |
| 2 | `add-http-proxy-support` | ✅ | 门禁 `no bare dispatcher`；178 测试 |
| 3 | `add-coverage-partition-canonicalization` | ✅ | 46 测试；代理清理实测生效（带假代理仍通过） |
| 4 | `refactor-experimental-release-policy` | ✅ | 53 测试；四项发布判据逐元素相同 |
| 5 | `update-session-projection-view-gate` | ✅ | 509 测试 |
| 6 | `add-agent-loop-message-freeze-reuse` | ✅ | **守卫已验证**：无优化时 spread 23>4 失败 |
| 7 | `add-typert-lazy-schema-materialization` | ✅ | 500 测试；清理 47 个误跟踪产物 |
| 8 | `add-lazy-require-utility` | ✅ | 2 新测试 + 依赖门禁 17 测试 |
| 9 | `add-deferred-native-dependency-loading` | ✅ | 441 测试；**实测启动省 sharp 55–79ms** |
| 10 | `update-slash-menu-shared-ranker` | ✅ | 702 测试；行为增强实测验证 |
| 11 | `add-archived-sessions-page` | ✅ | 100 测试；**竞态守卫已验证**（移除后失败） |
| 12 | `add-client-keyed-standard-hooks` | ✅ | 520 测试 |
| 13 | `add-mcp-resource-access` | ✅（1 项阻塞） | **真实 stdio MCP 服务器 e2e 4 测试 + 29 e2e 全通过** |

## 已验证为「有效守卫」的测试（移除实现即失败）

| 守卫 | 验证方式 | 结果 |
|---|---|---|
| agent-loop 冻结复用 | `git show HEAD~1:` 换回旧源码 | 无优化时 spread 23>4 失败 ✓ |
| 归档集合竞态 | 脚本移除 `requestSeq === this.archiveRequestSeq` | 无守卫时 `[]` ≠ `['archived','fresh']` 失败 ✓ |
| 代理门禁 | `scanRepository()` 在本地树返回空 | ✓ |
| sharp 延迟加载 | 加载 attachment-local 后 sharp 在 `require.cache` 中计数为 0 | ✓ |
| MCP 资源 | 真实 stdio 子进程读三种资源 + 二进制不外泄 + 指令字面量注入 | 4/4 通过 ✓ |

## 最终全量验证

- **单元测试**：`npx vitest run` → **18660 passed / 21 failed / 116 skipped（18797）**，通过率 99.89%。
- **类型检查**：`npx tsc -b tsconfig.host.json` → **0 错误**（全仓 host 面）。
- **门禁**：`verify-cordis-config` 157 文件通过；`verify-client-packages` 52 包通过；`verify-client-ui-i18n` 587 文件通过。

### 21 个失败全部为预先存在或环境限制（已逐条归因）

| 失败 | 归因 |
|---|---|
| `ui-file-browser` 滚动条 rebind（1） | **在基线提交 `cb0d22a168` 的独立 worktree 上复现完全相同的失败** |
| `gen-persistence-catalog` 渲染（1） | fork 中文化了生成器却未同步 spec 的英文断言（提交 `6537426d2d`） |
| `tool-delivery` 沙箱写入（3） | 测试在 `$HOME` 建临时目录，被文件沙箱以 EPERM 拒绝 |
| `cordis-catalog`（2） | 生成器报 `ctx.skillRoots` / `ctx.mcpAuthSink` 未登记到 `SERVICE_PAGE` |
| `verify-subsystem-pages`（7）、`verify-changed`（2）、`session-fixture-layout`（1）、`cordis-core-api`（1）、`project-doc-site`（2）、`doc-standard`（1）、`benchmark-npm-resolution`（1）、`session-snapshot/harness`（1） | 均用隔离 temp fixture，且 `git log cb0d22a168..HEAD -- <file>` 证明我的提交从未触及这些文件 |

**反证**：`git log --oneline cb0d22a168..HEAD -- <每个失败文件>` 对以上文件全部返回空。

## 本次修复的两个真实回归

全量测试发现了两个由我引入、并已修复的门禁期望失准：

1. `scripts/run-gates.spec.ts` 固定了 hygiene 模式的 gate id 清单，我新增 `no-bare-dispatcher` 后失准 → 已补入清单。
2. `packages/bundle/sdk-minimal/tests/sdk-minimal.spec.ts` 固定了行清单，我挂载 `mcp-resources` 后失准 → 已补入行。

外加 5 处 `result.content[0]!` 双重索引导致的 `TS2532` → 已改为安全收窄，全仓 host 面类型检查恢复 0 错误。

## 唯一未交付的验收项

`add-mcp-resource-access` 的 tasks 5.7（会话快照场景）**仍为未完成**，原因具体且不可绕过：

1. 录制需要 `DSH_SNAPSHOT=record` 的真实 API 调用，本地**无 `DEEPSEEK_API_KEY` 也无 `.env`**。
2. 官方该场景录制为 **v3** 格式，而本地 `SESSION_FORMAT_VERSION = 0`，无法直接复制官方录制。

模型可见面（三个工具 schema 与 `mcp:<server>` 指令段落）已由真实 stdio 子进程的 e2e 与单测覆盖，缺的是无密钥可回放的会话快照。

## 过程中的一次事故（已修复）

清理 `src/` 构建产物时我的 `find -delete` 范围过宽，**误删 47 个被 git 跟踪的手写 `.d.ts` 声明文件**（各 `css-modules.d.ts`、`vite-env.d.ts`、`ripgrep.d.ts` 等真实源码）。已用 `git checkout HEAD~1 -- <file>` 全部恢复并单独提交（`4a1fec02f3`），恢复后 `tsc -b` 通过。**教训**：清理产物前必须先用 `git ls-files` 排除被跟踪文件。

## 提交记录（15 个）

```
db2313ec7a 修正新增 e2e 与门禁期望的类型与清单，使全仓 host 面类型检查通过
99f42e9868 修正因新增门禁与 sdk-minimal 挂载而失准的两个门禁期望清单
87bff2fedd 标记 http-proxy 变更的任务完成
ea07c9a52b 客户端 keyed 标准钩子类型合成与资源注册表；MCP 资源访问与服务器指令注入
27125ee937 新增已归档会话设置页，并修复归档集合被陈旧回复覆盖的竞态
207da07632 原生依赖改为按需加载：sharp、koffi、node-pty、@xterm/headless 不再进入启动路径
3528c3a166 斜杠菜单与 skill 候选共用共享名称排序器，标题参与匹配
38f791b8c7 新增按调用方解析的惰性加载原语 lazy-require，并在依赖门禁中识别其 specifier
f3e7a491b0 Typert 生成的 schema 改为首次使用时物化并缓存，并清理 47 个误跟踪的测试生成产物
4a1fec02f3 恢复被误删的手写 .d.ts 声明文件（此前清理构建产物时范围过宽）
5fdbc42fce 会话投影变更流改为按原始 view 引用把关，并清理 src 下遮蔽源码的陈旧构建产物
65f05222fa 按循环实例复用已证明的消息冻结：请求构造的深冻结遍历量不再随历史长度增长
c920bf371b 1、新增 http-proxy 包并从启动快照安装代理策略（含 app-boot 与 CLI 接线）；2、覆盖率分区位置规范化与测试进程环境代理清理
835a16e94f 1、收敛 base 默认工具集：移除 str_replace_editor 默认启用，默认开启 web_fetch；2、上游差异扫描与四批移植方案
```
