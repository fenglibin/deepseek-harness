<!-- 由 scripts/gen-cordis-catalog.ts 生成——请勿手工编辑。
     运行 `pnpm run gen-cordis-catalog` 重新生成。 -->

# Fiber

fiber 是一个已加载的插件实例，包含其生命周期状态、经过校验的配置以及已注册的作用。`ctx.fiber` 是当前 fiber，`ctx.effect()` 会将调用委托给它。

### ctx.effect(execute, label?)

```ts cordis-catalog
/**
 * Register a cleanup-aware effect on this fiber.
 *
 * `execute` runs immediately; the disposers it produces are collected and
 * run (in reverse order) either when the returned disposer is called or
 * when the fiber unloads, whichever comes first. Calling the disposer twice
 * is a no-op. Throws `CordisError('INACTIVE_EFFECT')` if the fiber is
 * already disposed, and `TypeError` if `execute` returns an invalid shape.
 *
 * @param execute — the effect body; see {@link Effect} for accepted shapes.
 * @param label — effect label shown in `getEffects()` diagnostics.
 * @returns a disposer that tears the effect down and settles once done.
 */
effect(execute: () => SyncEffect, label?: string): Disposable<Promise<void>>
effect(execute: () => Effect, label?: string): AsyncDisposable<Promise<void>>
```

Register a cleanup-aware effect on this fiber.

`execute` runs immediately; the disposers it produces are collected and run (in reverse order) either when the returned disposer is called or when the fiber unloads, whichever comes first. Calling the disposer twice is a no-op. Throws `CordisError('INACTIVE_EFFECT')` if the fiber is already disposed, and `TypeError` if `execute` returns an invalid shape.

- `execute` — the effect body; see `Effect` for accepted shapes.
- `label` — effect label shown in `getEffects()` diagnostics.

**返回** a disposer that tears the effect down and settles once done.

[来源](../../vendor/cordis/src/fiber.ts#L415)

### ctx.fiber

```ts cordis-catalog
/** The fiber (plugin runtime instance) that owns this context. */
fiber: Fiber
```

The fiber (plugin runtime instance) that owns this context.

[来源](../../vendor/cordis/src/fiber.ts#L12)

## Fiber 类

Runtime instance of one plugin application.

A fiber tracks dependency state, validated config, lifecycle effects, and cleanup for the plugin context returned by `ctx.plugin()`.

[来源](../../vendor/cordis/src/fiber.ts#L184)

### fiber.uid

```ts cordis-catalog
/** Unique id within the registry; 0 for the root fiber, `null` once disposed. */
public uid: number | null
```

Unique id within the registry; 0 for the root fiber, `null` once disposed.

[来源](../../vendor/cordis/src/fiber.ts#L186)

### fiber.ctx

```ts cordis-catalog
/** The context this fiber's plugin runs in (extends the parent context). */
public readonly ctx: Context
```

The context this fiber's plugin runs in (extends the parent context).

[来源](../../vendor/cordis/src/fiber.ts#L188)

### fiber.config

```ts cordis-catalog
/** The validated plugin config (updated by `update()`). */
public config: any
```

The validated plugin config (updated by `update()`).

[来源](../../vendor/cordis/src/fiber.ts#L190)

### fiber.state

```ts cordis-catalog
/** Current lifecycle state; transitions emit `internal/status`. */
public state
```

Current lifecycle state; transitions emit `internal/status`.

[来源](../../vendor/cordis/src/fiber.ts#L194)

### fiber.dispose

```ts cordis-catalog
/** Dispose this fiber: unload the plugin, then settle once cleanup finished. */
public readonly dispose: () => Promise<void>
```

Dispose this fiber: unload the plugin, then settle once cleanup finished.

[来源](../../vendor/cordis/src/fiber.ts#L196)

### fiber.store

```ts cordis-catalog
/** Snapshot of required service implementations while loaded; `undefined` otherwise. */
public store: Dict<Impl> | undefined
```

Snapshot of required service implementations while loaded; `undefined` otherwise.

[来源](../../vendor/cordis/src/fiber.ts#L198)

### fiber.inertia

```ts cordis-catalog
/** The in-flight load/unload transition, if one is currently running. */
public inertia: Promise<void> | undefined
```

The in-flight load/unload transition, if one is currently running.

[来源](../../vendor/cordis/src/fiber.ts#L200)

### fiber.name

```ts cordis-catalog
/** The plugin's display name, inherited from the nearest named ancestor, else `'root'`. */
get name()
```

The plugin's display name, inherited from the nearest named ancestor, else `'root'`.

[来源](../../vendor/cordis/src/fiber.ts#L336)

### fiber.assertActive()

```ts cordis-catalog
/**
 * Throw if the fiber has already been disposed.
 *
 * @returns nothing when the fiber is still active.
 * @throws {CordisError} `INACTIVE_EFFECT` when the fiber's uid has been cleared.
 */
assertActive()
```

Throw if the fiber has already been disposed.

**返回** nothing when the fiber is still active.

[来源](../../vendor/cordis/src/fiber.ts#L351)

### fiber.effect(execute, label?)

```ts cordis-catalog
/**
 * Register a cleanup-aware effect on this fiber.
 *
 * `execute` runs immediately; the disposers it produces are collected and
 * run (in reverse order) either when the returned disposer is called or
 * when the fiber unloads, whichever comes first. Calling the disposer twice
 * is a no-op. Throws `CordisError('INACTIVE_EFFECT')` if the fiber is
 * already disposed, and `TypeError` if `execute` returns an invalid shape.
 *
 * @param execute — the effect body; see {@link Effect} for accepted shapes.
 * @param label — effect label shown in `getEffects()` diagnostics.
 * @returns a disposer that tears the effect down and settles once done.
 */
effect(execute: () => SyncEffect, label?: string): Disposable<Promise<void>>
effect(execute: () => Effect, label?: string): AsyncDisposable<Promise<void>>
```

Register a cleanup-aware effect on this fiber.

`execute` runs immediately; the disposers it produces are collected and run (in reverse order) either when the returned disposer is called or when the fiber unloads, whichever comes first. Calling the disposer twice is a no-op. Throws `CordisError('INACTIVE_EFFECT')` if the fiber is already disposed, and `TypeError` if `execute` returns an invalid shape.

- `execute` — the effect body; see `Effect` for accepted shapes.
- `label` — effect label shown in `getEffects()` diagnostics.

**返回** a disposer that tears the effect down and settles once done.

[来源](../../vendor/cordis/src/fiber.ts#L415)

### fiber.getEffects()

```ts cordis-catalog
/**
 * Return metadata for currently registered effects.
 *
 * @returns one {@link EffectMeta} tree per labeled live effect.
 */
getEffects()
```

Return metadata for currently registered effects.

**返回** one `EffectMeta` tree per labeled live effect.

[来源](../../vendor/cordis/src/fiber.ts#L568)

### fiber.await()

```ts cordis-catalog
/**
 * Wait for current lifecycle work and rethrow startup errors.
 *
 * @returns this fiber, once it has settled into a stable state.
 * @throws the config-validation or plugin-startup error, if any.
 */
async await()
```

Wait for current lifecycle work and rethrow startup errors.

**返回** this fiber, once it has settled into a stable state.

[来源](../../vendor/cordis/src/fiber.ts#L704)

### fiber.restart()

```ts cordis-catalog
/**
 * Dispose and immediately reload this plugin with its current config.
 *
 * @returns a promise resolving once the reload settled.
 * @throws {CordisError} `INACTIVE_EFFECT` when the fiber is already disposed.
 */
async restart()
```

Dispose and immediately reload this plugin with its current config.

**返回** a promise resolving once the reload settled.

[来源](../../vendor/cordis/src/fiber.ts#L718)

### fiber.update(config, noSave?)

```ts cordis-catalog
/**
 * Validate and apply new config, then restart the plugin.
 *
 * Runs the `internal/update` waterfall first, so update hooks (and HMR)
 * can veto or replace the restart.
 *
 * @param config — the new raw config; validated before anything restarts.
 * @param noSave — hint for persistence hooks not to write the change back.
 * @returns the update waterfall result; the default restart returns a promise.
 * @throws when validation, an update listener, or the restarted plugin fails.
 */
update(config: any, noSave = false)
```

Validate and apply new config, then restart the plugin.

Runs the `internal/update` waterfall first, so update hooks (and HMR) can veto or replace the restart.

- `config` — the new raw config; validated before anything restarts.
- `noSave` — hint for persistence hooks not to write the change back.

**返回** the update waterfall result; the default restart returns a promise.

[来源](../../vendor/cordis/src/fiber.ts#L736)

## Effect

Effect body result accepted by `ctx.effect()` and plugin startup.

Either a single disposer, a promise of one, or a (possibly async) iterable yielding several — generator effects register each yielded disposer as it is produced.

```ts cordis-catalog
/**
 * Effect body result accepted by `ctx.effect()` and plugin startup.
 *
 * Either a single disposer, a promise of one, or a (possibly async) iterable
 * yielding several — generator effects register each yielded disposer as it
 * is produced.
 */
type Effect<T = any> =
  | SyncEffect<T>
  | AsyncEffect<T>
```

[来源](../../vendor/cordis/src/fiber.ts#L83)

## Disposable

Function returned by an effect to release resources during disposal.

Disposers run in reverse registration order when the owning fiber unloads; they may be async, in which case unloading awaits them.

```ts cordis-catalog
/**
 * Function returned by an effect to release resources during disposal.
 *
 * Disposers run in reverse registration order when the owning fiber unloads;
 * they may be async, in which case unloading awaits them.
 */
type Disposable<T = any> = () => T
```

[来源](../../vendor/cordis/src/fiber.ts#L74)

## EffectMeta

Tree node used to expose nested effect labels for diagnostics.

```ts cordis-catalog
/** Tree node used to expose nested effect labels for diagnostics. */
interface EffectMeta {
  /** Human-readable effect label, e.g. `ctx.on("event")` or `ctx.provide("name")`. */
  label: string
  /** Metadata of nested effects registered while this effect ran. */
  children: EffectMeta[]
}
```

[来源](../../vendor/cordis/src/fiber.ts#L96)

## CordisError

Framework error with a stable machine-readable code.

```ts cordis-catalog
/** Framework error with a stable machine-readable code. */
class CordisError extends Error {
  /**
   * @param code — the stable error code; also the default message.
   * @param message — optional human-readable override.
   */
  constructor(public code: CordisError.Code, message?: string)
}

/** Cordis error code definitions. */
namespace CordisError {
  export type Code = keyof typeof Code

  export const Code = {
    INACTIVE_EFFECT: 'cannot create effect on inactive context',
  } as const
}
```

[来源](../../vendor/cordis/src/fiber.ts#L157)

## ValidationError

Error raised when plugin configuration fails standard-schema validation.

```ts cordis-catalog
/** Error raised when plugin configuration fails standard-schema validation. */
class ValidationError extends TypeError {
  name = 'ValidationError'

  /**
   * Build the aggregated message from schema issues.
   *
   * @param issues — the standard-schema issues, one message line each.
   */
  constructor(issues: readonly StandardSchemaV1.Issue[])
}
```

[来源](../../vendor/cordis/src/fiber.ts#L19)
