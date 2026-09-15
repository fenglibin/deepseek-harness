/**
 * 资源模型对外发布的门面。
 *
 * 一个资源就是一个地址，而资源地址是 `dsh-resource://<type>/…` 形式的 URL：
 * host 部分即协议名。协议所属的客户端包注册一个 {@link ResourceProvider}，
 * 把地址变为帧流；任何 slot 组件都通过 {@link UseResource} 读取该流。需要作用域
 * （会话、工作区）的协议把作用域编进路径，例如
 * `dsh-resource://file/session/<sessionId>/<absolute path>`；模型本身只知道地址。
 * 其他 scheme 下的地址（`sidebar://guide`）是导航地址，不指向任何资源。
 * `ResourceProtocolMap`（声明在 ui-slots）是以声明合并维护的“协议 → 值类型”名册，
 * 因此消费方只需把协议名写成类型参数，就能拿到属主的值类型而无需导入属主的运行时。
 */
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ResourceProtocolMap } from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface GlobalStandardProps {
    /** 单个地址的实时值，经其协议所注册的提供方解析。 */
    useResource: UseResource
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 资源模型：协议提供方、pin 与逐地址的实时来源。 */
    resources: Resources
  }
}

/** 某个客户端包已声明的全部协议。 */
export type ResourceProtocol = Extract<keyof ResourceProtocolMap, string>

/**
 * 一个资源当前所处的位置。`none`：地址协议没有注册提供方，或该地址不是资源地址。
 * `loading`：提供方已打开但尚未产出。`live`：`value` 是最新一个 `ok` 帧的值。
 * `failed`：最新一帧报告了失败。
 */
export type ResourceStatus = 'none' | 'loading' | 'live' | 'failed'

/** 一个地址的当前状态，即 `useResource` 的返回值。 */
export interface ResourceSnapshot<Value> {
  readonly status: ResourceStatus
  /** 最新一个 `ok` 帧的值；后续失败帧不会清除它，首个成功帧之前缺席。 */
  readonly value: Value | undefined
  /** 最新一帧的失败；仅在 `status` 为 `failed` 时存在。 */
  readonly failure: RemoteFailure | undefined
}

/**
 * 全局标准钩子：一个地址的当前状态，按写成类型参数的协议收窄其类型。
 * 出现在每个 slot 组件的 props 上，不论其作用域。
 */
export type UseResource = <P extends ResourceProtocol>(
  address: string,
) => ResourceSnapshot<ResourceProtocolMap[P]>

/** 提供方的 `open` 在地址之外收到的内容。 */
export interface ResourceOpenContext {
  /** 最后一个订阅者或 pin 释放该资源时中止；流必须随之结束。 */
  readonly signal: AbortSignal
}

/** 一个协议的提供方，经 `ctx.resources.register` 注册。 */
export interface ResourceProvider<P extends ResourceProtocol> {
  /** 该提供方服务的 URL scheme。 */
  readonly protocol: P
  /**
   * 为一个地址打开帧流。第一帧是当前内容，之后每帧表示一次变化。`ok` 帧替换值；
   * 失败帧把资源标记为 `failed` 并携带其错误，同时保留上一个值。流自行结束则保留
   * 最后状态。失败永远以帧表达：流内部的抛错是编程错误，不会被捕获。
   * @param address - 完整地址，一个 `dsh-resource://<type>/…` URL。
   * @param ctx - 该流的 abort signal。
   * @returns 帧流；`ctx.signal` 中止后它必须停止。
   */
  open(address: string, ctx: ResourceOpenContext): AsyncIterable<RemoteResult<ResourceProtocolMap[P]>>
}

/**
 * `ctx.resources` 服务。一个资源就是一个地址；只要还有至少一个 `source` 订阅者
 * 或一个 pin 持有它，它就保持打开，最后一个持有者释放时中止提供方的流并丢弃状态。
 */
export interface Resources {
  /**
   * 为调用方的存续期注册一个协议的提供方。
   * @param provider - 该协议的提供方。
   * @returns 幂等的 disposer，由调用方自有的 `ctx.effect` 持有。
   * @throws 该协议已有提供方时。
   */
  register<P extends ResourceProtocol>(provider: ResourceProvider<P>): () => void
  /**
   * 在不订阅的情况下让一个资源保持打开。
   * @param address - 完整地址，一个 `dsh-resource://<type>/…` URL。
   * @param signal - 中止它即释放该 pin；已中止的 signal 不钉住任何资源。
   */
  pin(address: string, signal: AbortSignal): void
  /**
   * 一个资源的实时来源。资源被持有时，同一地址的引用保持稳定；第一个订阅者或 pin
   * 打开提供方的流，之后到达的订阅者立刻读到最新值。
   * @param address - 完整地址，一个 `dsh-resource://<type>/…` URL。
   * @returns 该 observable 状态；`getSnapshot` 读取时不会持有资源。
   */
  source(address: string): ObservableSnapshot<ResourceSnapshot<unknown>>
}
