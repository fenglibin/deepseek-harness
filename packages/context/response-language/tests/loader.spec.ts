/**
 * REAL-composition tier (packages/AGENTS.md): boot the package-owned
 * response-language Loader fixture as a subprocess through the same app/boot
 * path a deployment uses, and assert the assembled model-visible prompt the
 * row contributes — not a hand-built registry.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { directiveText } from '@deepseek-ai/dsh-response-language'

const driver = fileURLToPath(new URL('./fixtures/loader/driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/loader/cordis.yml', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

interface LoaderReport {
  rendered: string
  sectionNames: string[]
}

describe('response-language through a real Loader composition', () => {
  it('renders the Chinese directive between the identity and the persona', async () => {
    let report: LoaderReport | undefined
    const { stderr } = await runLoaderSmoke({
      label: 'response-language loader smoke',
      tempDirPrefix: 'response-language-loader-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
      inspect: async (cwd) => {
        report = JSON.parse(await readFile(join(cwd, 'response-language-report.json'), 'utf8')) as LoaderReport
      },
    })
    expect(stderr).not.toContain('UNHANDLED')
    expect(report).toBeDefined()
    expect(report?.sectionNames).toEqual([
      'harness:identity',
      'deployment:response-language',
      'deployment:persona',
    ])
    expect(report?.rendered).toBe([
      'You are an AI agent powered by DeepSeek Harness.',
      directiveText('zh'),
      'Persona for the response-language smoke.',
    ].join('\n\n'))
  })
})
