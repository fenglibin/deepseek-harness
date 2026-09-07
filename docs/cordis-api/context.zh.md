<!-- 由 scripts/gen-cordis-catalog.ts 生成——请勿手工编辑。
     运行 `pnpm run gen-cordis-catalog` 重新生成。 -->

# 上下文

上下文是 Cordis 的核心对象：所有服务、事件和生命周期 API 都通过 `ctx` 访问。事件方法见[事件](events.zh.md)，副作用与当前 fiber 见 [Fiber](fiber.zh.md)，插件加载见[注册表](registry.zh.md)。

Root and child dependency containers for Cordis plugins.

A context is a proxy: normal property reads go through the service resolver, while `extend()`, `isolate()`, and `intercept()` create scoped child contexts without mutating their parent.

[来源](../../vendor/cordis/src/context.ts#L42)

### ctx.extend(meta?)

```ts cordis-catalog
/**
 * Create a child context with extra metadata on top of the current scope.
 *
 * The child prototypally inherits every property of this context; own
 * properties of `meta` shadow the inherited ones. The parent is not mutated.
 *
 * @param meta — own properties (including symbol keys) to define on the child.
 * @returns a child context inheriting from this one.
 */
extend(meta = {}): this
```

Create a child context with extra metadata on top of the current scope.

The child prototypally inherits every property of this context; own properties of `meta` shadow the inherited ones. The parent is not mutated.

- `meta` — own properties (including symbol keys) to define on the child.

**返回** a child context inheriting from this one.

[来源](../../vendor/cordis/src/context.ts#L99)

### ctx.isolate(name, label?)

```ts cordis-catalog
/**
 * Create a child context with an independent service scope for `name`.
 *
 * Below the returned context, reads and writes of the service `name`
 * resolve against the new label instead of the parent's, so a different
 * implementation can be provided without affecting the parent scope.
 * Passing the same `label` to two `isolate()` calls joins their scopes.
 *
 * @param name — the service name to isolate.
 * @param label — scope label to join; defaults to a fresh unique symbol.
 * @returns a child context whose `name` service resolves in the new scope.
 */
isolate(name: string, label?: symbol)
```

Create a child context with an independent service scope for `name`.

Below the returned context, reads and writes of the service `name` resolve against the new label instead of the parent's, so a different implementation can be provided without affecting the parent scope. Passing the same `label` to two `isolate()` calls joins their scopes.

- `name` — the service name to isolate.
- `label` — scope label to join; defaults to a fresh unique symbol.

**返回** a child context whose `name` service resolves in the new scope.

[来源](../../vendor/cordis/src/context.ts#L121)

### ctx.intercept(name, config)

```ts cordis-catalog
/**
 * Add service-specific intercept config for plugins started below this
 * context.
 *
 * Plugins loaded under the returned context see `config` merged into the
 * service's resolved config (ancestor entries first; see
 * `Service[symbols.resolveConfig]`). The parent context is not affected.
 *
 * @param name — the service name whose config to intercept.
 * @param config — the intercept config to merge for that service.
 * @returns a child context carrying the additional intercept entry.
 */
intercept<K extends InjectKey>(name: K, config: Context[K] extends { [symbols.config]: infer T } ? T : never): this
intercept(name: string, config: any): this
```

Add service-specific intercept config for plugins started below this context.

Plugins loaded under the returned context see `config` merged into the service's resolved config (ancestor entries first; see `Service[symbols.resolveConfig]`). The parent context is not affected.

- `name` — the service name whose config to intercept.
- `config` — the intercept config to merge for that service.

**返回** a child context carrying the additional intercept entry.

[来源](../../vendor/cordis/src/context.ts#L139)

### ctx.root

```ts cordis-catalog
/** The root context of the application (every child context shares it). @experimental */
root: this
```

The root context of the application (every child context shares it). @experimental

[来源](../../vendor/cordis/src/context.ts#L22)

### ctx.baseUrl

```ts cordis-catalog
/** Base URL used to resolve relative plugin/module specifiers, if the runtime sets one. */
baseUrl?: string
```

Base URL used to resolve relative plugin/module specifiers, if the runtime sets one.

[来源](../../vendor/cordis/src/context.ts#L24)

### ctx.events

```ts cordis-catalog
/** The event bus. Its methods are also mixed onto `ctx` (`ctx.on`, `ctx.emit`, ...). */
events: EventsService
```

The event bus. Its methods are also mixed onto `ctx` (`ctx.on`, `ctx.emit`, ...).

[来源](../../vendor/cordis/src/context.ts#L26)

### ctx.logger

```ts cordis-catalog
/** The logging service. Call `ctx.logger(name)` for a named logger. */
logger: LoggerService
```

The logging service. Call `ctx.logger(name)` for a named logger.

[来源](../../vendor/cordis/src/context.ts#L28)

### ctx.reflect

```ts cordis-catalog
/** The reflection layer backing the context proxy (`ctx.get`, `ctx.provide`, ...). */
reflect: ReflectService
```

The reflection layer backing the context proxy (`ctx.get`, `ctx.provide`, ...).

[来源](../../vendor/cordis/src/context.ts#L30)

### ctx.registry

```ts cordis-catalog
/** The plugin registry. Its methods are mixed onto `ctx` (`ctx.plugin`, `ctx.inject`). */
registry: RegistryService
```

The plugin registry. Its methods are mixed onto `ctx` (`ctx.plugin`, `ctx.inject`).

[来源](../../vendor/cordis/src/context.ts#L32)

## 静态成员

### Context.effect

```ts cordis-catalog
/** Symbol key under which a disposer exposes its {@link EffectMeta} diagnostics tree. */
static readonly effect: unique symbol
```

Symbol key under which a disposer exposes its EffectMeta diagnostics tree.

[来源](../../vendor/cordis/src/context.ts#L44)

### Context.filter

```ts cordis-catalog
/** Symbol key for a context's listener filter, consulted on every event dispatch. */
static readonly filter: unique symbol
```

Symbol key for a context's listener filter, consulted on every event dispatch.

[来源](../../vendor/cordis/src/context.ts#L46)

### Context.isolate

```ts cordis-catalog
/** Symbol key of the isolation map (see the `Context[symbols.isolate]` property). */
static readonly isolate: unique symbol
```

Symbol key of the isolation map (see the `Context[symbols.isolate]` property).

[来源](../../vendor/cordis/src/context.ts#L48)

### Context.intercept

```ts cordis-catalog
/** Symbol key of the intercept map (see the `Context[symbols.intercept]` property). */
static readonly intercept: unique symbol
```

Symbol key of the intercept map (see the `Context[symbols.intercept]` property).

[来源](../../vendor/cordis/src/context.ts#L50)

### Context.is(value)

```ts cordis-catalog
/**
 * Returns true for Cordis context proxies and context prototypes.
 *
 * Works across realms and across multiple copies of cordis, because the
 * brand is keyed by a global symbol rather than by `instanceof`.
 *
 * @param value — the value to test.
 * @returns `true` if `value` is a Cordis context, narrowing its type.
 */
static is(value: any): value is Context
```

Returns true for Cordis context proxies and context prototypes.

Works across realms and across multiple copies of cordis, because the brand is keyed by a global symbol rather than by `instanceof`.

- `value` — the value to test.

**返回** `true` if `value` is a Cordis context, narrowing its type.

[来源](../../vendor/cordis/src/context.ts#L61)

## 服务存储与混入

### ctx.get(name, strict?)

```ts cordis-catalog
/**
 * Read a service from the store without the inject requirement.
 *
 * @param name — the service name.
 * @param strict — when `true` (default), only return implementations
 * whose providing fiber is currently active.
 * @returns the service value, or `undefined` when not (yet) provided.
 */
get<K extends string & keyof this>(name: K, strict?: boolean): undefined | this[K]
get(name: string, strict?: boolean): any
```

Read a service from the store without the inject requirement.

- `name` — the service name.
- `strict` — when `true` (default), only return implementations whose providing fiber is currently active.

**返回** the service value, or `undefined` when not (yet) provided.

[来源](../../vendor/cordis/src/reflect.ts#L17)

### ctx.set(name, value)

```ts cordis-catalog
/**
 * Overwrite a provided service's value.
 *
 * Only the fiber that provided the service may set it; setting an
 * unprovided name throws.
 *
 * @param name — the service name.
 * @param value — the new service value.
 */
set<K extends string & keyof this>(name: K, value: undefined | this[K]): void
set(name: string, value: any): void
```

Overwrite a provided service's value.

Only the fiber that provided the service may set it; setting an unprovided name throws.

- `name` — the service name.
- `value` — the new service value.

[来源](../../vendor/cordis/src/reflect.ts#L29)

### ctx.provide(name, value)

```ts cordis-catalog
/**
 * Register a service implementation owned by the current fiber.
 *
 * The service becomes visible to dependents in the same isolation scope
 * once the fiber is active; it is unregistered (waking dependents) when
 * the returned disposer runs or the fiber unloads. Throws if the name is
 * already provided in this scope or declared as an accessor.
 *
 * @param name — the service name.
 * @param value — the service value.
 * @returns a disposer that unregisters the service.
 */
provide<K extends string & keyof this>(name: K, value: undefined | this[K]): () => void
provide(name: string, value?: any): () => void
```

Register a service implementation owned by the current fiber.

The service becomes visible to dependents in the same isolation scope once the fiber is active; it is unregistered (waking dependents) when the returned disposer runs or the fiber unloads. Throws if the name is already provided in this scope or declared as an accessor.

- `name` — the service name.
- `value` — the service value.

**返回** a disposer that unregisters the service.

[来源](../../vendor/cordis/src/reflect.ts#L44)

### ctx.accessor(name, options)

```ts cordis-catalog
/**
 * Define a computed context property backed by get/set hooks.
 *
 * The accessor is removed when the current fiber unloads. Throws if the
 * name is already declared.
 *
 * @param name — the context property name.
 * @param options — the `get` hook and optional `set` hook.
 */
accessor(name: string, options: Omit<Property.Accessor, 'type'>): void
```

Define a computed context property backed by get/set hooks.

The accessor is removed when the current fiber unloads. Throws if the name is already declared.

- `name` — the context property name.
- `options` — the `get` hook and optional `set` hook.

[来源](../../vendor/cordis/src/reflect.ts#L56)

### ctx.mixin(name, mixins)

```ts cordis-catalog
/**
 * Expose selected members of a service directly on `ctx`.
 *
 * Each mixed-in key becomes an accessor that forwards to the service
 * (binding methods to it), so e.g. `ctx.on` forwards to `ctx.events.on`.
 * Mixins are removed when the current fiber unloads.
 *
 * @param name — the context property holding the source service.
 * @param mixins — keys to forward, or a source-key → ctx-key map.
 */
mixin<K extends string & keyof this>(name: K, mixins: (keyof this & keyof this[K])[] | Dict<string>): void
mixin<T extends {}>(source: T, mixins: (keyof this & keyof T)[] | Dict<string>): void
```

Expose selected members of a service directly on `ctx`.

Each mixed-in key becomes an accessor that forwards to the service (binding methods to it), so e.g. `ctx.on` forwards to `ctx.events.on`. Mixins are removed when the current fiber unloads.

- `name` — the context property holding the source service.
- `mixins` — keys to forward, or a source-key → ctx-key map.

[来源](../../vendor/cordis/src/reflect.ts#L67)
