/**
 * 出站代理的**安装时机契约**：`runProfile` 必须在第一个插件挂载之前装好
 * dispatcher。
 *
 * 这是 design D2 与 spec 的 `SHALL 在第一个插件挂载之前生效` 的唯一守护：
 * 两者都基于「任何插件一经挂载就可能发起请求」这一前提，而该前提只在挂载
 * 顺序上成立。若把安装移到 `composeProfile` 之后，本用例会失败。
 *
 * 做法是让一个真实的 cordis 插件在挂载时**立即**检查全局 dispatcher：它
 * 读到的必须是代理 dispatcher，而不是 undici 的默认直连 dispatcher。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execa } from 'execa'
import { afterEach, describe, expect, it } from 'vitest'

const dshBinScript = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

/** 仓库内 fixture：挂载瞬间报告 dispatcher 形态（临时目录无法解析 undici）。 */
const PROBE_PLUGIN = fileURLToPath(new URL('./fixtures/proxy-order-probe.mjs', import.meta.url))

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/**
 * 启动一次真实 profile，让探针插件报告挂载瞬间的 dispatcher 状态。
 * @param environment - 追加到启动环境的变量。
 * @returns 子进程的组合输出与退出码。
 */
async function bootWithProbe(
  environment: Record<string, string>,
): Promise<{ output: string; exitCode: number }> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-proxy-order-'))
  roots.push(home)
  const patch = join(home, 'probe.cordis.yml')
  await writeFile(patch, `- insert:\n    - id: proxy-order-probe\n      name: '${pathToFileURL(PROBE_PLUGIN).href}'\n`)

  const result = await execa(process.execPath, [
    '--import', 'tsx/esm', dshBinScript,
    '--profile', 'headless',
    '--patch', patch,
    'proxy order probe',
  ], {
    reject: false,
    timeout: 60_000,
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_TSCONFIG: tsconfigPath,
      ...environment,
    },
  })
  return { output: `${result.stdout}\n${result.stderr}`, exitCode: result.exitCode ?? 0 }
}

describe('出站代理的安装时机', () => {
  it('插件挂载时全局 dispatcher 已经是代理 dispatcher', async () => {
    const { output } = await bootWithProbe({ HTTPS_PROXY: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9' })
    const probe = /dsh-probe: installed=(\w+)/.exec(output)
    expect(probe, `探针未报告（输出片段：${output.slice(-400)}）`).not.toBeNull()
    // 插件挂载时策略必须已发布——即安装在 composeProfile 之前完成。
    expect(probe![1]).toBe('true')
  })

  it('未配置代理时 dispatcher 保持直连', async () => {
    const { output } = await bootWithProbe({ HTTPS_PROXY: '', https_proxy: '', HTTP_PROXY: '', http_proxy: '' })
    const probe = /dsh-probe: installed=(\w+)/.exec(output)
    expect(probe, `探针未报告（输出片段：${output.slice(-400)}）`).not.toBeNull()
    expect(probe![1]).toBe('false')
  })
})
