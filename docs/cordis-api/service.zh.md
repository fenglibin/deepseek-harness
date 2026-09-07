<!-- 由 scripts/gen-cordis-catalog.ts 生成——请勿手工编辑。
     运行 `pnpm run gen-cordis-catalog` 重新生成。 -->

# Service

上下文服务的基类。以插件形式加载的子类会将自身注册为 `ctx.<name>`。

Base class for services that expose a named API on `ctx`.

Subclasses call `super(ctx, name)` from their constructor. The service is registered immediately and is automatically removed with the owning fiber.

[来源](../../vendor/cordis/src/service.ts#L11)

### service.name

```ts cordis-catalog
/** The service name this instance is registered under. */
public name!: string
```

The service name this instance is registered under.

[来源](../../vendor/cordis/src/service.ts#L30)

## 静态成员

### Service.init

```ts cordis-catalog
/** Symbol key of an instance method run after construction (class plugins). */
static readonly init: unique symbol
```

Symbol key of an instance method run after construction (class plugins).

[来源](../../vendor/cordis/src/service.ts#L13)

### Service.check

```ts cordis-catalog
/** Symbol key of the availability predicate passed to `ctx.provide()`. */
static readonly check: unique symbol
```

Symbol key of the availability predicate passed to `ctx.provide()`.

[来源](../../vendor/cordis/src/service.ts#L15)

### Service.config

```ts cordis-catalog
/** Symbol key of the phantom intercept-config type parameter. */
static readonly config: unique symbol
```

Symbol key of the phantom intercept-config type parameter.

[来源](../../vendor/cordis/src/service.ts#L17)

### Service.invoke

```ts cordis-catalog
/** Symbol key of the call body making a service callable (e.g. `ctx.logger()`). */
static readonly invoke: unique symbol
```

Symbol key of the call body making a service callable (e.g. `ctx.logger()`).

[来源](../../vendor/cordis/src/service.ts#L19)

### Service.extend

```ts cordis-catalog
/** Symbol key of the helper deriving an extended service instance. */
static readonly extend: unique symbol
```

Symbol key of the helper deriving an extended service instance.

[来源](../../vendor/cordis/src/service.ts#L21)

### Service.tracker

```ts cordis-catalog
/** Symbol key of the tracker metadata used for context tracing. */
static readonly tracker: unique symbol
```

Symbol key of the tracker metadata used for context tracing.

[来源](../../vendor/cordis/src/service.ts#L23)

### Service.resolveConfig

```ts cordis-catalog
/** Symbol key of the intercept-config resolution helper below. */
static readonly resolveConfig: unique symbol
```

Symbol key of the intercept-config resolution helper below.

[来源](../../vendor/cordis/src/service.ts#L25)
