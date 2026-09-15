import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import { HttpFetchProvider } from '@deepseek-ai/dsh-web-fetch-http'
import type { HttpFetchLimits } from '@deepseek-ai/dsh-web-fetch-http'
import { isNonPublicIpLiteral, publicHttpNetwork } from '../src/network.ts'

const limits: HttpFetchLimits = {
  maxResponseBytes: 5_000_000,
  maxBodyChars: 100_000,
  timeoutMs: 5_000,
  maxRedirects: 5,
  userAgent: 'test-agent/1.0',
}

/** 假代理看到的绝对形式（absolute-form）目标；有内容即证明这一跳被隧道转发了。 */
let proxied: string[]
let proxy: Server
let origin: Server
let proxyUrl: string
let originUrl: string

/**
 * 所有关于「被隧道转发的一跳」的断言都以它为靶子。loopback 无法承担该角色：没有任何策略
 * 会把本机路由到代理。该主机永远不会被解析——由代理应答这个绝对形式请求——这也正是
 * 「被跳过的解析器」可被观察到的原因。
 */
const proxyTarget = 'http://origin.test/page'
let disposeProxy: (() => Promise<void>) | undefined

function listen(server: Server): Promise<AddressInfo> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => { resolve(server.address() as AddressInfo) })
  })
}

function respond(_request: IncomingMessage, response: ServerResponse, body: string): void {
  response.writeHead(200, { 'content-type': 'text/plain' })
  response.end(body)
}

beforeEach(async () => {
  proxied = []
  proxy = createServer((request, response) => {
    proxied.push(request.url ?? '')
    respond(request, response, 'via-proxy')
  })
  origin = createServer((request, response) => { respond(request, response, 'direct') })
  const [proxyAddress, originAddress] = await Promise.all([listen(proxy), listen(origin)])
  proxyUrl = `http://127.0.0.1:${String(proxyAddress.port)}`
  originUrl = `http://127.0.0.1:${String(originAddress.port)}/page`
})

afterEach(async () => {
  await disposeProxy?.()
  disposeProxy = undefined
  vi.restoreAllMocks()
  await Promise.all([
    new Promise<void>((resolve) => { proxy.close(() => { resolve() }) }),
    new Promise<void>((resolve) => { origin.close(() => { resolve() }) }),
  ])
})

/**
 * 安装一位「为两种协议导出同一个代理」的用户的策略；fixture 在每个用例之后将其释放。
 */
async function installProxy(): Promise<() => Promise<void>> {
  const env = { get: (name: string) => (name === 'HTTP_PROXY' || name === 'HTTPS_PROXY' ? { value: proxyUrl } : undefined) }
  return await installProxyFromEnvironment(env, () => undefined)
}

describe('经代理抓取', () => {
  it('把请求隧道转发，且绝不为它解析公共地址', async () => {
    const resolve = vi.spyOn(publicHttpNetwork, 'resolve')
    disposeProxy = await installProxy()

    const result = await new HttpFetchProvider(limits).fetch({ url: proxyTarget })

    expect(result.body.content).toBe('via-proxy')
    expect(proxied).toEqual([proxyTarget])
    // 走代理时源站的 DNS 发生在代理侧，因此那个会拒绝非公共终点的解析器根本不会被咨询。
    expect(resolve).not.toHaveBeenCalled()
  })

  it('对策略不代理的一跳保持解析并钉扎', async () => {
    const resolve = vi.spyOn(publicHttpNetwork, 'resolve')
      .mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
    // 无需任何绕过条目：已解析的策略绝不会把 loopback 路由到代理，而这正是本用例断言
    // 「仍然解析并钉扎」的场景。
    disposeProxy = await installProxy()

    const result = await new HttpFetchProvider(limits).fetch({ url: originUrl })

    expect(result.body.content).toBe('direct')
    expect(proxied).toEqual([])
    expect(resolve).toHaveBeenCalledOnce()
  })

  it('在未安装代理时解析并钉扎', async () => {
    const resolve = vi.spyOn(publicHttpNetwork, 'resolve')
      .mockResolvedValue([{ address: '127.0.0.1', family: 4 }])

    const result = await new HttpFetchProvider(limits).fetch({ url: originUrl })

    expect(result.body.content).toBe('direct')
    expect(resolve).toHaveBeenCalledOnce()
  })

  it.each(['10.0.0.5', '169.254.169.254', '127.0.0.2'])(
    '拒绝 %s，而不是让代理替我们抵达它',
    async (host) => {
      const resolve = vi.spyOn(publicHttpNetwork, 'resolve')
      disposeProxy = await installProxy()

      // 经代理那条路之所以存在，是因为由代理解析源站；而字面量无需解析，因此走它只会白白
      // 花掉地址检查，并把本机上的代理交到那些检查本就要拒绝的私有或 loopback 终点。
      // 所以这一跳改走已校验的路径，那里既有的拒绝逻辑已经覆盖它。
      await expect(new HttpFetchProvider(limits).fetch({ url: `http://${host}:8080/` }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
      expect(proxied).toEqual([])
      expect(resolve).toHaveBeenCalledOnce()
    },
  )

  it('把 IPv4 映射字面量读作非公共，且不询问网络', () => {
    // 经由该谓词而非一次 fetch 驱动：IPv6 字面量会让 `resolvePublicAddresses` 在拒绝任何东西
    // 之前先去找 NAT64 前缀，而那是一次真实的 DNS 查询。上面三个 IPv4 用例已经在没有它的情况下
    // 端到端地证明了该分支。
    expect(isNonPublicIpLiteral('[::ffff:7f00:1]')).toBe(true)
    expect(isNonPublicIpLiteral('[::1]')).toBe(true)
    expect(isNonPublicIpLiteral('[::ffff:808:808]')).toBe(false)
    expect(isNonPublicIpLiteral('example.com')).toBe(false)
  })

  it('在经代理的路径上仍然拒绝跨源重定向', async () => {
    proxy.removeAllListeners('request')
    proxy.on('request', (request, response) => {
      proxied.push(request.url ?? '')
      response.writeHead(302, { location: 'http://elsewhere.example/next' })
      response.end()
    })
    disposeProxy = await installProxy()

    await expect(new HttpFetchProvider(limits).fetch({ url: proxyTarget }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_REDIRECT_BLOCKED' }))
  })

  it('在任何一跳之前仍然拒绝传输策略否定的 URL', async () => {
    disposeProxy = await installProxy()

    await expect(new HttpFetchProvider(limits).fetch({ url: 'ftp://example.com/x' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_INVALID_URL' }))
    expect(proxied).toEqual([])
  })
})
