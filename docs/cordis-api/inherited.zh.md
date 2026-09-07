<!-- 由 scripts/gen-cordis-catalog.ts 生成——请勿手工编辑。
     运行 `pnpm run gen-cordis-catalog` 重新生成。 -->

# 继承的 Cordis API

每个插件在 harness 层级之外都能看到的框架 `ctx` 成员和事件——固定 vendor 源码（[vendoring policy](../../vendor/README.md)），以简洁方式汇总，使 harness 页面聚焦于仓库自有的词汇。详细的 Context、Fiber、Registry 和 Service API 在 [context.md](context.zh.md)、[fiber.md](fiber.zh.md)、[registry.md](registry.zh.md) 和 [service.md](service.zh.md) 中生成；事件派发方法在 [events.md](events.zh.md) 中。

本文档根据源码生成（`scripts/gen-cordis-catalog.ts`），并由 `pnpm run verify-cordis-catalog`（`doc-sync`（文档同步门禁）的一部分）验证新鲜度——请勿手工编辑。签名块使用 `ts cordis-catalog` 围栏，并在每个事件或服务方法前保留原始源码 JSDoc。doc-typecheck 会跳过这些裸声明片段；签名中的类型名称会链接到记录该类型的页面。

## 继承的 `ctx` 成员（cordis core + loader/hmr/timer）

- `ctx.on / ctx.once` — 注册一个事件监听器（可处置）。 ([`vendor/cordis/src/events.ts:34`](../../vendor/cordis/src/events.ts))
- `ctx.emit / ctx.parallel / ctx.serial / ctx.bail / ctx.waterfall` — 派发一个事件（同步 / 等待 / 首个 bail / 短路链）。 ([`vendor/cordis/src/events.ts:34`](../../vendor/cordis/src/events.ts))
- `ctx.plugin / ctx.inject` — 加载插件 / 声明所需服务。 ([`vendor/cordis/src/registry.ts:164`](../../vendor/cordis/src/registry.ts))
- `ctx.effect` — 注册一个绑定到 fiber 的可处置副作用。 ([`vendor/cordis/src/fiber.ts:9`](../../vendor/cordis/src/fiber.ts))
- `ctx.get / ctx.set / ctx.provide / ctx.accessor / ctx.mixin` — 低层服务 store 访问与绑定。 ([`vendor/cordis/src/reflect.ts:7`](../../vendor/cordis/src/reflect.ts))
- `ctx.extend / ctx.isolate / ctx.intercept` — 派生子上下文（作用域服务 / 隔离 / 拦截）。 ([`vendor/cordis/src/context.ts:42`](../../vendor/cordis/src/context.ts))
- `ctx.root / ctx.fiber / ctx.registry / ctx.reflect / ctx.events / ctx.logger` — 运行中上下文图的环境句柄。 ([`vendor/cordis/src/context.ts:16`](../../vendor/cordis/src/context.ts))
- `ctx.timer (+ interval / timeout / throttle / debounce)` — 可处置的计时器辅助。`timer` 键在运行时提供；四个受支持的辅助直接混入 ctx（通过 Pick 声明）。 ([`vendor/timer/src/index.ts:4`](../../vendor/timer/src/index.ts))
- `ctx.loader` — 启动应用的配置 Loader（在 loader 下存在）。 ([`vendor/loader/src/index.ts:30`](../../vendor/loader/src/index.ts))
- `ctx.hmr` — 热模块重载监视器（在 hmr 插件下存在）。 ([`vendor/hmr/src/index.ts:15`](../../vendor/hmr/src/index.ts))

## 继承的事件（cordis core + loader/hmr/timer）

- `internal/plugin` — 一个插件 fiber 被创建。 ([`vendor/cordis/src/events.ts:328`](../../vendor/cordis/src/events.ts))
- `internal/status` — 一个 fiber 改变了生命周期状态。 ([`vendor/cordis/src/events.ts:330`](../../vendor/cordis/src/events.ts))
- `internal/service` — 服务绑定的拦截钩子（无核心生产方）。 ([`vendor/cordis/src/events.ts:332`](../../vendor/cordis/src/events.ts))
- `internal/update` — Waterfall：正在应用 fiber 配置更新。 ([`vendor/cordis/src/events.ts:334`](../../vendor/cordis/src/events.ts))
- `internal/get` — Waterfall：正在从 store 读取服务。 ([`vendor/cordis/src/events.ts:336`](../../vendor/cordis/src/events.ts))
- `internal/set` — Waterfall：正在向 store 写入服务。 ([`vendor/cordis/src/events.ts:338`](../../vendor/cordis/src/events.ts))
- `internal/listener` — 一个监听器被注册。 ([`vendor/cordis/src/events.ts:340`](../../vendor/cordis/src/events.ts))
- `internal/dispatch` — 事件正在被派发给监听器。 ([`vendor/cordis/src/events.ts:342`](../../vendor/cordis/src/events.ts))
- `hmr/change` — 一个被监视的源文件在磁盘上发生变化。 ([`vendor/hmr/src/index.ts:20`](../../vendor/hmr/src/index.ts))
- `hmr/reload` — 变更后插件正在重新加载。 ([`vendor/hmr/src/index.ts:21`](../../vendor/hmr/src/index.ts))
- `exit` — 进程在信号上退出。 ([`vendor/loader/src/index.ts:23`](../../vendor/loader/src/index.ts))
- `loader/config-update` — loader 配置树发生变化。 ([`vendor/loader/src/index.ts:24`](../../vendor/loader/src/index.ts))
- `loader/entry-init` — 一个配置条目正在初始化。 ([`vendor/loader/src/index.ts:25`](../../vendor/loader/src/index.ts))
- `loader/partial-dispose` — 一个条目在重新加载时被部分处置。 ([`vendor/loader/src/index.ts:26`](../../vendor/loader/src/index.ts))
- `loader/patch-context` — 一个上下文在重新加载期间被修补。 ([`vendor/loader/src/index.ts:27`](../../vendor/loader/src/index.ts))
