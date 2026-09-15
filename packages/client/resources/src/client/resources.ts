/**
 * `ctx.resources`：提供方注册表，以及 `useResource` 背后逐地址的状态。
 *
 * 每个曾被读取过的地址都保有一条记录，且永不删除；最后一次释放丢弃的是它的状态
 * （流被中止，快照回到空闲）。保留记录是为了让 `source()` 在 React 从渲染到订阅的
 * 窗口期以及 StrictMode 重挂载期间保持引用稳定——重建记录会让每次渲染都重新订阅并
 * 重启流。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { createSnapshotStore, type ObservableSnapshot, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  ResourceOpenContext,
  ResourceProtocol,
  ResourceProvider,
  Resources,
  ResourceSnapshot,
} from './contract.ts'

/** 抹掉值类型的提供方，使一个 map 能容纳所有协议。 */
interface RuntimeProvider {
  readonly protocol: string
  open(address: string, ctx: ResourceOpenContext): AsyncIterable<RemoteResult<unknown>>
}

/** 一个地址：它的状态、持有者与运行中的流。 */
interface ResourceRecord {
  readonly address: string
  /** 该地址的协议 key（`dsh-resource://` 的 host）；地址不是资源地址时缺席。 */
  readonly protocol: string | undefined
  readonly store: SnapshotStore<ResourceSnapshot<unknown>>
  readonly source: ObservableSnapshot<ResourceSnapshot<unknown>>
  /** 订阅者加 pin；该值大于 0 时流保持运行。 */
  holders: number
  /** 提供方的流运行期间存在；中止它即结束该流。 */
  controller: AbortController | undefined
}

/**
 * 资源地址唯一使用的 URL scheme：`dsh-resource://<type>/…`，其中 host 即协议名。
 * 其他 scheme（`sidebar://…`）是导航地址，不指向任何资源。
 */
export const RESOURCE_SCHEME = 'dsh-resource'

/**
 * 一个地址的协议 key：`dsh-resource://` URL 的 host，按 URL 解析器的读法（小写）。
 * 其他任何字符串——别的 scheme，或 URL 解析器拒绝的字符串——都不指向协议，按
 * “协议没有提供方”的地址处理。
 * @param address - 完整地址。
 * @returns 协议 key；地址不是资源地址时为 `undefined`。
 */
export function protocolOf(address: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(address)
  } catch {
    // URL 解析器拒绝没有 scheme 的字符串（`/a/b.txt`、`''`）；此处不会因其他原因
    // 抛错，而无法解析的地址本来就不属于本模型。
    return undefined
  }
  if (parsed.protocol !== `${RESOURCE_SCHEME}:`) return undefined
  // 非特殊 scheme 的 host 对 URL 解析器是不透明的，会保留大小写。
  return parsed.hostname === '' ? undefined : parsed.hostname.toLowerCase()
}

function idle(status: 'none' | 'loading'): ResourceSnapshot<unknown> {
  return { status, value: undefined, failure: undefined }
}

/** `ctx.resources` 的实现。 */
export class ResourceRegistry implements Resources {
  private readonly providers = new Map<string, RuntimeProvider>()
  private readonly records = new Map<string, ResourceRecord>()

  /** @param ctx - 其 effect 拥有已注册提供方的 Cordis 上下文。 */
  constructor(private readonly ctx: Context) {}

  register<P extends ResourceProtocol>(provider: ResourceProvider<P>): () => void {
    const runtime: RuntimeProvider = provider
    const { protocol } = runtime
    if (this.providers.has(protocol)) {
      throw new Error(`resources: protocol "${protocol}" already has a provider`)
    }
    const dispose = this.ctx.effect(() => {
      this.providers.set(protocol, runtime)
      for (const record of this.recordsOf(protocol)) this.attach(record)
      return () => {
        this.providers.delete(protocol)
        for (const record of this.recordsOf(protocol)) this.detach(record)
      }
    }, `resources.register(${JSON.stringify(protocol)})`)
    return () => { void dispose() }
  }

  pin(address: string, signal: AbortSignal): void {
    if (signal.aborted) return
    const record = this.record(address)
    this.hold(record)
    signal.addEventListener('abort', () => { this.release(record) }, { once: true })
  }

  source(address: string): ObservableSnapshot<ResourceSnapshot<unknown>> {
    return this.record(address).source
  }

  private record(address: string): ResourceRecord {
    let record = this.records.get(address)
    if (record === undefined) {
      record = this.create(address)
      this.records.set(address, record)
    }
    return record
  }

  private create(address: string): ResourceRecord {
    const protocol = protocolOf(address)
    const store = createSnapshotStore<ResourceSnapshot<unknown>>(
      idle(this.providerOf(protocol) === undefined ? 'none' : 'loading'),
    )
    const record: ResourceRecord = {
      address,
      protocol,
      store,
      holders: 0,
      controller: undefined,
      source: {
        getSnapshot: () => store.getSnapshot(),
        subscribe: (listener) => {
          const unsubscribe = store.subscribe(listener)
          this.hold(record)
          let active = true
          return () => {
            if (!active) return
            active = false
            unsubscribe()
            this.release(record)
          }
        },
      },
    }
    return record
  }

  private providerOf(protocol: string | undefined): RuntimeProvider | undefined {
    return protocol === undefined ? undefined : this.providers.get(protocol)
  }

  private *recordsOf(protocol: string): Iterable<ResourceRecord> {
    for (const record of this.records.values()) {
      if (record.protocol === protocol) yield record
    }
  }

  private hold(record: ResourceRecord): void {
    record.holders += 1
    if (record.holders === 1) this.start(record)
  }

  private release(record: ResourceRecord): void {
    record.holders -= 1
    if (record.holders > 0) return
    this.stop(record)
    record.store.set(idle(this.providerOf(record.protocol) === undefined ? 'none' : 'loading'))
  }

  /** 提供方到来：被持有的记录开流，空闲记录转为 `loading`。 */
  private attach(record: ResourceRecord): void {
    if (record.holders > 0) {
      this.start(record)
      return
    }
    record.store.set(idle('loading'))
  }

  /** 提供方离开：流结束，记录报告 `none`。 */
  private detach(record: ResourceRecord): void {
    this.stop(record)
    record.store.set(idle('none'))
  }

  private start(record: ResourceRecord): void {
    const provider = this.providerOf(record.protocol)
    if (provider === undefined) return
    const controller = new AbortController()
    record.controller = controller
    if (record.store.getSnapshot().status !== 'loading') record.store.set(idle('loading'))
    void this.consume(record, provider, controller.signal)
  }

  private stop(record: ResourceRecord): void {
    record.controller?.abort()
    record.controller = undefined
  }

  /** 失败以帧到达；流内部的抛错交由上层暴露。 */
  private async consume(record: ResourceRecord, provider: RuntimeProvider, signal: AbortSignal): Promise<void> {
    const stream = provider.open(record.address, { signal })
    for await (const frame of stream) {
      // 提供方在中止它的那次释放之后仍产出的帧不属于任何人；结束循环同时归还迭代器。
      if (signal.aborted) break
      record.store.set(frame.ok
        ? { status: 'live', value: frame.value, failure: undefined }
        : { status: 'failed', value: record.store.getSnapshot().value, failure: frame.error })
    }
  }
}
