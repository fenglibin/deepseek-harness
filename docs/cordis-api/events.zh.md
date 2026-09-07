<!-- 由 scripts/gen-cordis-catalog.ts 生成——请勿手工编辑。
     运行 `pnpm run gen-cordis-catalog` 重新生成。 -->

# 事件

每个上下文中都混入了事件分发 API。Harness 事件声明及其分发模式会生成到各自所属的[子系统页面](../subsystems/core.zh.md)。

### ctx.parallel(name, ...args)

```ts cordis-catalog
/**
 * Dispatch an event, running all listeners concurrently.
 *
 * @param name — the event name.
 * @param args — arguments passed to every listener.
 * @returns a promise resolving once every listener has settled.
 */
parallel<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): Promise<void>
parallel<K extends keyof Events>(thisArg: NoInfer<ThisType<Events[K]>>, name: K, ...args: Parameters<Events[K]>): Promise<void>
```

Dispatch an event, running all listeners concurrently.

- `name` — the event name.
- `args` — arguments passed to every listener.

**返回** a promise resolving once every listener has settled.

[来源](../../vendor/cordis/src/events.ts#L44)

### ctx.emit(name, ...args)

```ts cordis-catalog
/**
 * Dispatch an event synchronously, ignoring listener return values.
 *
 * @param name — the event name.
 * @param args — arguments passed to every listener.
 */
emit<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): void
emit<K extends keyof Events>(thisArg: NoInfer<ThisType<Events[K]>>, name: K, ...args: Parameters<Events[K]>): void
```

Dispatch an event synchronously, ignoring listener return values.

- `name` — the event name.
- `args` — arguments passed to every listener.

[来源](../../vendor/cordis/src/events.ts#L53)

### ctx.serial(name, ...args)

```ts cordis-catalog
/**
 * Dispatch an event, awaiting listeners in order until one bails.
 *
 * @param name — the event name.
 * @param args — arguments passed to each listener.
 * @returns the first bail value (non-null, non-false, non-undefined), if any.
 */
serial<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): Promisify<ReturnType<Events[K]>>
serial<K extends keyof Events>(thisArg: NoInfer<ThisType<Events[K]>>, name: K, ...args: Parameters<Events[K]>): Promisify<ReturnType<Events[K]>>
```

Dispatch an event, awaiting listeners in order until one bails.

- `name` — the event name.
- `args` — arguments passed to each listener.

**返回** the first bail value (non-null, non-false, non-undefined), if any.

[来源](../../vendor/cordis/src/events.ts#L63)

### ctx.bail(name, ...args)

```ts cordis-catalog
/**
 * Dispatch an event, calling listeners in order until one bails.
 *
 * @param name — the event name.
 * @param args — arguments passed to each listener.
 * @returns the first bail value (non-null, non-false, non-undefined), if any.
 */
bail<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>
bail<K extends keyof Events>(thisArg: NoInfer<ThisType<Events[K]>>, name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>
```

Dispatch an event, calling listeners in order until one bails.

- `name` — the event name.
- `args` — arguments passed to each listener.

**返回** the first bail value (non-null, non-false, non-undefined), if any.

[来源](../../vendor/cordis/src/events.ts#L73)

### ctx.waterfall(name, ...args)

```ts cordis-catalog
/**
 * Dispatch an event whose last argument is a `next` continuation.
 *
 * Each listener wraps the rest of the chain: calling `next()` invokes the
 * next listener (finally the built-in behavior); not calling it vetoes.
 *
 * @param name — the event name.
 * @param args — listener arguments; the final one is the innermost `next`.
 * @returns the outermost listener's return value.
 */
waterfall<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>
waterfall<K extends keyof Events>(thisArg: NoInfer<ThisType<Events[K]>>, name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>
```

Dispatch an event whose last argument is a `next` continuation.

Each listener wraps the rest of the chain: calling `next()` invokes the next listener (finally the built-in behavior); not calling it vetoes.

- `name` — the event name.
- `args` — listener arguments; the final one is the innermost `next`.

**返回** the outermost listener's return value.

[来源](../../vendor/cordis/src/events.ts#L86)

### ctx.on(name, listener, options?)

```ts cordis-catalog
/**
 * Register an event listener owned by the current fiber.
 *
 * @param name — the event name to listen for.
 * @param listener — called with the dispatch arguments.
 * @param options — listener options; a boolean is shorthand for `prepend`.
 * @returns a disposer removing the listener; `true` if it was still registered.
 */
on<K extends keyof Events>(name: K, listener: Events[K], options?: boolean | EventOptions): () => boolean
```

Register an event listener owned by the current fiber.

- `name` — the event name to listen for.
- `listener` — called with the dispatch arguments.
- `options` — listener options; a boolean is shorthand for `prepend`.

**返回** a disposer removing the listener; `true` if it was still registered.

[来源](../../vendor/cordis/src/events.ts#L97)

### ctx.once(name, listener, options?)

```ts cordis-catalog
/**
 * Same as `on()`, but the listener disposes itself after its first call.
 *
 * @param name — the event name to listen for.
 * @param listener — called at most once with the dispatch arguments.
 * @param options — listener options; a boolean is shorthand for `prepend`.
 * @returns a disposer removing the listener; `true` if it was still registered.
 */
once<K extends keyof Events>(name: K, listener: Events[K], options?: boolean | EventOptions): () => boolean
```

Same as `on()`, but the listener disposes itself after its first call.

- `name` — the event name to listen for.
- `listener` — called at most once with the dispatch arguments.
- `options` — listener options; a boolean is shorthand for `prepend`.

**返回** a disposer removing the listener; `true` if it was still registered.

[来源](../../vendor/cordis/src/events.ts#L106)

## EventOptions

Options accepted by `ctx.on()` and `ctx.once()`.

```ts cordis-catalog
/** Options accepted by `ctx.on()` and `ctx.once()`. */
interface EventOptions {
  /** Add the listener before existing listeners for the same event. */
  prepend?: boolean
  /** Receive the event regardless of context filter checks. */
  global?: boolean
}
```

[来源](../../vendor/cordis/src/events.ts#L112)

## DispatchMode

Event dispatch strategy used by the event service.

`emit` runs synchronous listeners without awaiting them, `parallel` awaits all listeners together, `serial` awaits them in order until one bails, `bail` stops on the first synchronous bail value, and `waterfall` composes listeners around a final `next` callback.

```ts cordis-catalog
/**
 * Event dispatch strategy used by the event service.
 *
 * `emit` runs synchronous listeners without awaiting them, `parallel` awaits
 * all listeners together, `serial` awaits them in order until one bails,
 * `bail` stops on the first synchronous bail value, and `waterfall` composes
 * listeners around a final `next` callback.
 */
type DispatchMode = 'emit' | 'parallel' | 'serial' | 'bail' | 'waterfall'
```

[来源](../../vendor/cordis/src/events.ts#L32)
