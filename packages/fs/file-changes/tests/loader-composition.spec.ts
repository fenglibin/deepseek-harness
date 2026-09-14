/**
 * REAL-composition proof: the shipped YAML shape (session + projection
 * registry + file-changes) boots through the vendored Loader, the function
 * plugin's namespace survives (no default export), and a logged turn whose
 * mutation succeeded serves the changed file through the composed registry.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as FileChangesPlugin from '@deepseek-ai/dsh-file-changes'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadYaml(lines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-file-changes-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...lines, ''].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-file-changes', FileChangesPlugin],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

describe('real Loader composition', () => {
  it('loads the shipped file-changes YAML shape and serves the changed file', async () => {
    const loaded = await loadYaml([
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-session-projection'",
      "- name: '@deepseek-ai/dsh-file-changes'",
    ])

    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])

    const session = loaded.sessions.create(SessionId('composed'), { meta: { cwd: '/proj' } })
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const source = session.append('tool/call', {
      turn: 1, step: 1, callId: ToolCallId('composed-1'), name: 'write',
      arguments: JSON.stringify({ file_path: 'notes/demo.txt', content: 'hello\n' }),
    })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('composed-1'),
        content: [{ type: 'text', text: 'Created notes/demo.txt' }],
        isError: false,
      }),
    }, { surfaceOp: 'append', sourceEventSeqs: [source.seq] })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const files = loaded.sessionProjections.snapshot(session).values.changedFiles?.files
    expect(files).toHaveLength(1)
    expect(files?.[0]).toMatchObject({ path: '/proj/notes/demo.txt', operation: 'write' })
    expect(files?.[0]?.firstSeq).toBe(files?.[0]?.lastSeq)
  })

  it('keeps the function-plugin namespace free of a default export', () => {
    // A default export beside the named form makes the Loader discard the
    // namespace (postmortem 0001) — pin its absence.
    expect('default' in FileChangesPlugin).toBe(false)
  })
})
