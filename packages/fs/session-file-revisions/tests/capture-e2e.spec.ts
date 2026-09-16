/**
 * End-to-end capture check: a REAL tool execution through the REAL
 * `tools/post-execute` waterfall, carrying a REAL Session on the exec, records
 * the baseline and end state the revert acts on.
 *
 * Every other capture test calls the fold directly. This one proves the plugin's
 * own wiring — where the session comes from, which results count, and what the
 * recorded pair is — because those are the parts a unit test cannot reach.
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SessionFileRevisions from '../src/index.ts'
import { revertContent } from '../src/revert.ts'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-capture-'))
})

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await rm(root, { recursive: true, force: true })
})

/** One session and tool runtime wired to the real capture plugin. */
async function composed(id: string) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const session = Session.create(SessionId(id), undefined, {
    version: 0, id: SessionId(id), createdAt: 0, cwd: root,
  })
  await ctx.plugin(SessionFileRevisions)
  return { ctx, session }
}

/** Register a `write`-shaped tool whose body performs the real disk write. */
function registerWrite(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'write',
    description: 'Write a UTF-8 text file.',
    parameters: {
      file_path: { type: 'string', required: true },
      content: { type: 'string', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          before: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          after: { type: 'string', required: true },
        },
      },
      render: () => [{ type: 'text', text: 'ok' }],
    },
    async execute(args: { file_path: string; content: string }) {
      const path = join(root, args.file_path)
      let before: string | null = null
      try {
        before = await readFile(path, 'utf8')
      } catch {
        before = null
      }
      await writeFile(path, args.content, 'utf8')
      return { path, before, after: args.content }
    },
  }))
}

describe('capture through the real tool pipeline', () => {
  it('records the baseline the session found and the end state it left', async () => {
    const { ctx, session } = await composed('s1')
    registerWrite(ctx)
    await writeFile(join(root, 'a.txt'), 'original\n', 'utf8')

    await ctx.tools.execute({
      callId: ToolCallId('c1'),
      name: 'write',
      arguments: { file_path: 'a.txt', content: 'changed\n' },
      agent: { session } as never,
      signal: new AbortController().signal,
    })

    const revisions = ctx.sessionFileRevisions.list(session.id)
    expect(revisions).toHaveLength(1)
    expect(revisions[0]?.baseline).toBe('original\n')
    expect(revisions[0]?.endState).toBe('changed\n')
    await ctx.fiber.dispose()
  })

  it('records a create with a null baseline', async () => {
    const { ctx, session } = await composed('s2')
    registerWrite(ctx)

    await ctx.tools.execute({
      callId: ToolCallId('c1'),
      name: 'write',
      arguments: { file_path: 'new.txt', content: 'fresh\n' },
      agent: { session } as never,
      signal: new AbortController().signal,
    })

    const revisions = ctx.sessionFileRevisions.list(session.id)
    expect(revisions[0]?.baseline).toBeNull()
    expect(revisions[0]?.endState).toBe('fresh\n')
    await ctx.fiber.dispose()
  })

  it('keeps the first baseline across repeated edits', async () => {
    const { ctx, session } = await composed('s3')
    registerWrite(ctx)
    await writeFile(join(root, 'a.txt'), 'original\n', 'utf8')

    for (const content of ['one\n', 'two\n', 'three\n']) {
      await ctx.tools.execute({
        callId: ToolCallId(`c-${content}`),
        name: 'write',
        arguments: { file_path: 'a.txt', content },
        agent: { session } as never,
        signal: new AbortController().signal,
      })
    }

    const revisions = ctx.sessionFileRevisions.list(session.id)
    expect(revisions).toHaveLength(1)
    expect(revisions[0]?.baseline).toBe('original\n')
    expect(revisions[0]?.endState).toBe('three\n')
    await ctx.fiber.dispose()
  })

  it('produces a revert that restores the file the session found', async () => {
    const { ctx, session } = await composed('s4')
    registerWrite(ctx)
    await writeFile(join(root, 'a.txt'), 'original\n', 'utf8')

    await ctx.tools.execute({
      callId: ToolCallId('c1'),
      name: 'write',
      arguments: { file_path: 'a.txt', content: 'changed\n' },
      agent: { session } as never,
      signal: new AbortController().signal,
    })

    // Someone outside the session edits an unrelated line afterwards.
    await writeFile(join(root, 'a.txt'), 'changed\nOUTSIDE\n', 'utf8')
    const [revision] = ctx.sessionFileRevisions.list(session.id)
    const current = await readFile(join(root, 'a.txt'), 'utf8')
    const result = revertContent(revision?.baseline ?? null, revision?.endState ?? '', current)
    expect(result.applied).toBe('all')
    if (result.applied !== 'all') return
    // The session's line is restored and the outside edit survives.
    expect(result.content).toBe('original\nOUTSIDE\n')
    await ctx.fiber.dispose()
  })
})
