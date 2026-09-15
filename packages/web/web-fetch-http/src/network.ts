/**
 * Public-network resolution and address-pinned HTTP transport for `web-fetch-http`.
 * One DNS answer set is validated before Undici receives it through a custom lookup,
 * so the connection cannot resolve the hostname again to a private address.
 *
 * @module @deepseek-ai/dsh-web-fetch-http/network
 */

import { lookup as systemLookup } from 'node:dns/promises'
import type { LookupAddress, LookupOptions } from 'node:dns'
import { isIP } from 'node:net'
import type { Dispatcher, Response } from 'undici'
import ipaddr from 'ipaddr.js'
import { WebError } from '@deepseek-ai/dsh-web'

/** One address resolved and retained for the subsequent pinned connection. */
export interface PublicAddress {
  /** Canonical textual IPv4 or IPv6 address. */
  readonly address: string
  /** Address family accepted by Node's connection lookup callback. */
  readonly family: 4 | 6
}

/** The result of one address-pinned request; closing releases its private pool. */
export interface PinnedResponse {
  /** HTTP response whose body remains readable until `close()` is called. */
  readonly response: Response
  /** Release the request's dispatcher after the response body is consumed or cancelled. */
  close(): Promise<void>
}

/** Resolver signature used to test public-address policy without process DNS changes. */
export type AddressResolver = (hostname: string, options: { all: true; order: 'verbatim' }) => Promise<LookupAddress[]>

/** RFC 6052 prefix lengths that may carry an IPv4 destination through NAT64. */
const RFC6052_PREFIX_LENGTHS = [32, 40, 48, 56, 64, 96] as const
const IPV4ONLY_DISCOVERY_HOST = 'ipv4only.arpa'
const IPV4ONLY_SENTINELS = new Set(['192.0.0.170', '192.0.0.171'])

interface Nat64Prefix {
  readonly bytes: readonly number[]
  readonly length: typeof RFC6052_PREFIX_LENGTHS[number]
}

/**
 * Return whether an address is globally reachable unicast. IPv4-mapped IPv6 is
 * classified by its embedded IPv4 address; transition and translation prefixes
 * remain blocked because their eventual IPv4 destination cannot be pinned here.
 *
 * @param input - textual IPv4 or IPv6 address.
 * @returns true only for a public unicast destination.
 */
export function isPublicIpAddress(input: string): boolean {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6
  try {
    parsed = ipaddr.parse(stripIpv6Brackets(input))
  } catch {
    return false
  }
  if (parsed instanceof ipaddr.IPv4) return parsed.range() === 'unicast'
  if (parsed.isIPv4MappedAddress()) return parsed.toIPv4Address().range() === 'unicast'
  return parsed.range() === 'unicast'
}

/**
 * Resolve a hostname once and reject the complete answer set if any destination
 * is not public. The returned addresses are the only ones the transport may use.
 *
 * @param hostname - URL hostname, including brackets when it is an IPv6 literal.
 * @param signal - aborts the wait for system resolution; an in-flight OS lookup may finish unused.
 * @param resolver - lookup implementation, overridden only by focused tests.
 * @returns the validated, non-empty address set.
 */
export async function resolvePublicAddresses(
  hostname: string,
  signal: AbortSignal,
  resolver: AddressResolver = systemLookup,
): Promise<PublicAddress[]> {
  const unbracketed = stripIpv6Brackets(hostname)
  const literalFamily = isIP(unbracketed)
  const resolved = literalFamily === 0
    ? await raceWithSignal(resolver(unbracketed, { all: true, order: 'verbatim' }), signal)
    : [{ address: unbracketed, family: literalFamily }]

  if (resolved.length === 0) {
    throw new WebError(`hostname "${hostname}" resolved to no addresses`, 'WEB_PROVIDER_ERROR')
  }

  const hasIpv6 = resolved.some(entry => entry.family === 6 && isIP(entry.address) === 6)
  const nat64Prefixes = hasIpv6
    ? await discoverNat64Prefixes(signal, resolver)
    : []

  const addresses: PublicAddress[] = []
  for (const entry of resolved) {
    if ((entry.family !== 4 && entry.family !== 6) || isIP(entry.address) !== entry.family) {
      throw new WebError(`hostname "${hostname}" resolved to an invalid IP address`, 'WEB_PROVIDER_ERROR')
    }
    if (!isPublicIpAddress(entry.address)) {
      throw new WebError(`URL hostname "${hostname}" resolves to a non-public IP address`, 'WEB_BLOCKED_URL')
    }
    const translatedIpv4 = translatedIpv4Address(entry.address, nat64Prefixes)
    if (translatedIpv4 !== undefined && !isPublicIpAddress(translatedIpv4)) {
      throw new WebError(`URL hostname "${hostname}" resolves through NAT64 to a non-public IPv4 address`, 'WEB_BLOCKED_URL')
    }
    addresses.push({ address: entry.address, family: entry.family })
  }
  return addresses
}

/** Discover the active DNS64 prefix set using RFC 7050's reserved hostname. */
async function discoverNat64Prefixes(signal: AbortSignal, resolver: AddressResolver): Promise<Nat64Prefix[]> {
  const discovered = await raceWithSignal(
    resolver(IPV4ONLY_DISCOVERY_HOST, { all: true, order: 'verbatim' }),
    signal,
  )
  const prefixes: Nat64Prefix[] = []
  const seen = new Set<string>()
  for (const entry of discovered) {
    if (entry.family !== 6 || isIP(entry.address) !== 6) continue
    const bytes = ipaddr.parse(entry.address).toByteArray()
    for (const length of RFC6052_PREFIX_LENGTHS) {
      const embedded = embeddedIpv4Address(bytes, length)
      if (embedded === undefined || !IPV4ONLY_SENTINELS.has(embedded)) continue
      const prefixBytes = bytes.slice(0, length / 8)
      const key = `${String(length)}:${prefixBytes.join('.')}`
      if (seen.has(key)) continue
      seen.add(key)
      prefixes.push({ bytes: prefixBytes, length })
    }
  }
  return prefixes
}

/** Return the RFC 6052-embedded IPv4 address when an IPv6 address matches a discovered prefix. */
function translatedIpv4Address(input: string, prefixes: readonly Nat64Prefix[]): string | undefined {
  if (isIP(input) !== 6) return undefined
  const bytes = ipaddr.parse(input).toByteArray()
  for (const prefix of prefixes) {
    if (!prefix.bytes.every((byte, index) => bytes[index] === byte)) continue
    const embedded = embeddedIpv4Address(bytes, prefix.length)
    if (embedded !== undefined) return embedded
  }
  return undefined
}

/** Extract one IPv4 address from an RFC 6052 IPv6 layout. */
function embeddedIpv4Address(bytes: readonly number[], prefixLength: Nat64Prefix['length']): string | undefined {
  if (prefixLength === 96) return bytes.slice(12, 16).join('.')
  if (bytes[8] !== 0) return undefined
  const prefixBytes = prefixLength / 8
  const beforeReservedOctet = 8 - prefixBytes
  const ipv4 = [
    ...bytes.slice(prefixBytes, prefixBytes + beforeReservedOctet),
    ...bytes.slice(9, 9 + 4 - beforeReservedOctet),
  ]
  return ipv4.join('.')
}

/**
 * 判断一个主机名是否为 IP 字面量，且 {@link resolvePublicAddresses} 会拒绝它。
 *
 * 经代理的跳转跳过这些检查，因为由代理解析源站；但字面量无需解析：地址已经写明，
 * 而把它交给一个运行在本机上的代理，恰恰会抵达这些检查本就要挡住的 loopback 或私有服务。
 *
 * @param hostname - URL 的主机名，可带方括号。
 * @returns 当该主机是任何请求都不应发送到的字面量地址时为 true。
 */
export function isNonPublicIpLiteral(hostname: string): boolean {
  const unbracketed = stripIpv6Brackets(hostname)
  return isIP(unbracketed) !== 0 && !isPublicIpAddress(unbracketed)
}

/**
 * 通过一个 agent 抓取，其 lookup 回调只返回已经校验过的地址集合。URL 主机名保持原样，
 * 以供 HTTP Host 与 TLS SNI 使用。
 *
 * 该 agent 属于这一次请求，因为地址集合就是它的：钉扎（pinning）正是本包拒绝
 * 「在校验与连接之间发生变化的 DNS 答案」的方式，而它不能进程级生效——运维配置在
 * loopback 上的 MCP 服务器或模型端点是被支持的终点，只有本工具抓取的 URL 才是
 * 模型可以选择的。
 *
 * @param url - 已校验的 HTTP(S) URL，策略不会把它路由到代理。
 * @param addresses - {@link resolvePublicAddresses} 返回的公共地址。
 * @param headers - 请求头。
 * @param signal - 请求与响应体读取的取消信号。
 * @returns 一个响应，以及消费方必须调用的 disposer。
 */
export async function requestPinned(
  url: URL,
  addresses: readonly PublicAddress[],
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<PinnedResponse> {
  // 让仅限 Node 的传输不要进入浏览器 worker 的启动图。预览环境可以加载提供方并在它的
  // DNS stub 上大声失败，而不必求值 Undici；Node 上的真实请求会在此处解析这个有维护的依赖。
  const { Agent, fetch } = await import('undici')
  // 只有 `proxyRouteFor` 未报告代理的 URL 才会走到这里，而这个 agent 携带的钉扎 lookup
  // 是单次请求的状态，进程级 dispatcher 无法承载。
  // proxy-exempt: 为一次请求钉住已校验的地址集合，且该 URL 是策略判定直连的。
  const dispatcher = new Agent({
    autoSelectFamily: true,
    connect: { lookup: createPinnedLookup(addresses) },
  })
  try {
    // proxy-exempt: 用的是上面那个 agent，其生命周期就是这一次请求。
    const response = await fetch(url, { method: 'GET', redirect: 'manual', headers, signal, dispatcher })
    return { response, close: async () => { await dispatcher.close() } }
  } catch (error: unknown) {
    await dispatcher.close()
    throw error
  }
}

/**
 * 通过代理策略已经安装好的 dispatcher 抓取，让代理解析源站。
 *
 * 不钉任何地址集合，因为根本没有可钉的：解析由代理完成，而钉在本地解析出的地址上的连接
 * 会直连源站，从而绕过代理。该 dispatcher 是进程级的，因此各次跳转共用它的连接池，
 * 也没有调用方会去关闭它。
 *
 * @param dispatcher - 该路由的 dispatcher，来自 `proxyRouteFor`。
 * @param url - 已校验的 HTTP(S) URL，策略会把它路由到代理。
 * @param headers - 请求头。
 * @param signal - 请求与响应体读取的取消信号。
 * @returns 一个响应，以及一个不释放任何东西的 disposer，使两条路径的关闭方式一致。
 */
export async function requestVia(
  dispatcher: Dispatcher,
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<PinnedResponse> {
  const { fetch } = await import('undici')
  // proxy-exempt: 该 dispatcher 是已安装策略自己的，由 `proxyRouteFor` 交过来。
  const response = await fetch(url, { method: 'GET', redirect: 'manual', headers, signal, dispatcher })
  return { response, close: () => Promise.resolve() }
}

/** 生产网络操作保留为对象，使提供方测试只替换解析环节。 */
export const publicHttpNetwork = {
  resolve: resolvePublicAddresses,
  request: requestPinned,
  requestVia,
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void

/**
 * Build the connector lookup that serves a fixed validated answer set.
 *
 * @param addresses - public addresses retained from the preceding resolution.
 * @returns a Node-compatible lookup callback that performs no network resolution.
 */
export function createPinnedLookup(addresses: readonly PublicAddress[]): (
  hostname: string,
  options: LookupOptions,
  callback: LookupCallback,
) => void {
  return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    const family = typeof options.family === 'number'
      ? options.family
      : options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : 0
    const eligible = family === 0 ? addresses : addresses.filter(address => address.family === family)
    const selected = eligible[0]
    if (selected === undefined) {
      const error = Object.assign(new Error(`no validated address for ${hostname} in family ${family}`), {
        code: 'ENOTFOUND',
        hostname,
      })
      callback(error, options.all === true ? [] : '', family)
      return
    }
    if (options.all === true) {
      callback(null, eligible.map(address => ({ ...address })))
      return
    }
    callback(null, selected.address, selected.family)
  }
}

/** Race a non-cancellable OS lookup without letting it delay tool cancellation. */
function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  const abortError = () => new Error('web fetch aborted during hostname resolution', { cause: signal.reason })
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const abort = () => { reject(abortError()) }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort) })
  })
}

/** WHATWG URL retains brackets around IPv6 hostnames; IP parsers do not. */
function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}
