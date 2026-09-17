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
import Storage from '@deepseek-ai/dsh-storage'
import {
  Config as storageJsonConfig, apply as storageJsonApply, inject as storageJsonInject, name as storageJsonName,
} from '@deepseek-ai/dsh-storage-json'
import {
  Config as storageDomainConfig, apply as storageDomainApply, inject as storageDomainInject, name as storageDomainName,
} from '@deepseek-ai/dsh-storage-domain'
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
  await mountStorage(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const session = Session.create(SessionId(id), undefined, {
    version: 0, id: SessionId(id), createdAt: 0, cwd: root,
  })
  await ctx.plugin(SessionFileRevisions, {})
  return { ctx, session }
}

/**
 * Mount the storage stack the capture's domain opens through.
 *
 * The revisions are durable, so the plugin cannot compose without a medium: the
 * json backend lands the per-record tree under this suite's tmp root, which is
 * what lets a test reopen the same root as a fresh process would.
 * @param ctx - the composed context.
 */
async function mountStorage(ctx: Context): Promise<void> {
  await ctx.plugin(Storage)
  await ctx.plugin(
    { name: storageJsonName, inject: storageJsonInject, apply: storageJsonApply, Config: storageJsonConfig },
    { root },
  )
  await ctx.plugin(
    { name: storageDomainName, inject: storageDomainInject, apply: storageDomainApply, Config: storageDomainConfig },
    { backend: 'json' },
  )
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
          operation: { type: 'string', required: true, enum: ['create', 'update'] },
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
      return {
        path,
        operation: before === null ? 'create' as const : 'update' as const,
        before,
        after: args.content,
      }
    },
  }))
}

/**
 * Register a `write`-shaped tool that mirrors the storage backend's
 * presentation bound: it reports `before: null` for an overwrite it declined to
 * buffer, while still reporting `operation: 'update'`.
 * @param ctx - the composed context to register into.
 * @param bufferLimit - the content length past which no prior content is read.
 */
function registerBoundedWrite(ctx: Context, bufferLimit: number): void {
  ctx.tools.register(defineTool({
    name: 'write',
    description: 'Write a UTF-8 text file, withholding a bulky diff basis.',
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
          operation: { type: 'string', required: true, enum: ['create', 'update'] },
          before: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          after: { type: 'string', required: true },
        },
      },
      render: () => [{ type: 'text', text: 'ok' }],
    },
    async execute(args: { file_path: string; content: string }) {
      const path = join(root, args.file_path)
      let existing: string | null = null
      try {
        existing = await readFile(path, 'utf8')
      } catch {
        existing = null
      }
      // The bound is checked on the OPENED file's size, exactly as fs-local's
      // `readTextForDiff` does; `before` is withheld when it is reached.
      const withheld = existing === null || existing.length >= bufferLimit
      await writeFile(path, args.content, 'utf8')
      return {
        path,
        operation: existing === null ? 'create' as const : 'update' as const,
        before: withheld ? null : existing,
        after: args.content,
      }
    },
  }))
}

/**
 * Register a `str_replace_editor`-shaped tool over the real disk.
 *
 * Its output schema mirrors the shipped tool's `oneOf`: a mutating command
 * reports the path with both content sides, `view` reports path and text only.
 * @param ctx - the composed context to register into.
 */
function registerEditor(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'str_replace_editor',
    description: 'View or edit a file.',
    parameters: {
      command: { type: 'string', required: true, enum: ['view', 'str_replace'] },
      path: { type: 'string', required: true },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', required: true },
              text: { type: 'string', required: true },
              before: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
              after: { type: 'string', required: true },
              operation: { type: 'string', required: true, enum: ['create', 'update'] },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', required: true },
              text: { type: 'string', required: true },
            },
          },
        ],
      },
      render: (_args, value) => [{ type: 'text', text: (value as { text: string }).text }],
    },
    async execute(args: { command: string; path: string }) {
      const before = await readFile(args.path, 'utf8')
      if (args.command === 'view') return { path: args.path, text: 'contents' }
      await writeFile(args.path, 'after\n', 'utf8')
      return { path: args.path, text: 'edited', before, after: 'after\n', operation: 'update' as const }
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

  it('does not read a withheld overwrite basis as a create', async () => {
    // A bulky overwrite reports `before: null` while `operation: 'update'`. The
    // file existed before this session touched it, so recording it as absent
    // would make a revert delete a file the session never created.
    const { ctx, session } = await composed('s5')
    registerBoundedWrite(ctx, 8)
    await writeFile(join(root, 'big.txt'), 'x'.repeat(64), 'utf8')

    await ctx.tools.execute({
      callId: ToolCallId('c1'),
      name: 'write',
      arguments: { file_path: 'big.txt', content: 'small\n' },
      agent: { session } as never,
      signal: new AbortController().signal,
    })

    const [revision] = ctx.sessionFileRevisions.list(session.id)
    expect(revision?.origin).toBe('unknown')
    expect(revision?.baseline).toBeNull()
    await ctx.fiber.dispose()
  })

  it('still records a real create as an absent baseline', async () => {
    const { ctx, session } = await composed('s6')
    registerBoundedWrite(ctx, 8)

    await ctx.tools.execute({
      callId: ToolCallId('c1'),
      name: 'write',
      arguments: { file_path: 'fresh.txt', content: 'made\n' },
      agent: { session } as never,
      signal: new AbortController().signal,
    })

    const [revision] = ctx.sessionFileRevisions.list(session.id)
    expect(revision?.origin).toBe('absent')
    await ctx.fiber.dispose()
  })

  it('records a str_replace_editor mutation through the real pipeline', async () => {
    // The editor is registered here with the shape its own package now returns:
    // a mutating command reports the pair, a read reports text only. Capture
    // must take the first and ignore the second, or the editor's changes would
    // be listed by the dock while staying impossible to view or revert.
    const { ctx, session } = await composed('s7')
    registerEditor(ctx)
    await writeFile(join(root, 'a.txt'), 'before\n', 'utf8')

    await ctx.tools.execute({
      callId: ToolCallId('c1'),
      name: 'str_replace_editor',
      arguments: { command: 'str_replace', path: join(root, 'a.txt') },
      agent: { session } as never,
      signal: new AbortController().signal,
    })

    const [revision] = ctx.sessionFileRevisions.list(session.id)
    expect(revision?.baseline).toBe('before\n')
    expect(revision?.endState).toBe('after\n')
    await ctx.fiber.dispose()
  })

  it('records nothing for a read-only str_replace_editor call', async () => {
    const { ctx, session } = await composed('s8')
    registerEditor(ctx)
    await writeFile(join(root, 'a.txt'), 'contents\n', 'utf8')

    await ctx.tools.execute({
      callId: ToolCallId('c1'),
      name: 'str_replace_editor',
      arguments: { command: 'view', path: join(root, 'a.txt') },
      agent: { session } as never,
      signal: new AbortController().signal,
    })

    expect(ctx.sessionFileRevisions.list(session.id)).toEqual([])
    await ctx.fiber.dispose()
  })
})

describe('durable revisions', () => {
  /**
   * One storage-backed context whose store holds `id` at `createdAt`.
   *
   * The session the tool runs against is the one entered into the store: the
   * capture binds the record to that header's identity, so running against some
   * other session object would bind it to a lifecycle the restore cannot match.
   */
  async function durable(
    id: string,
    createdAt: number,
    config?: { maxRecordBytes: number },
    /** Omit the config argument entirely, as the shipped cordis.yml row does. */
    omitConfig = false,
  ) {
    const ctx = new Context()
    await mountStorage(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const session = ctx.sessions.create(SessionId(id), {
      // The store fills `version` and `id`; only the creation facts are supplied.
      meta: { createdAt, cwd: root },
    })
    if (omitConfig) await ctx.plugin(SessionFileRevisions)
    else await ctx.plugin(SessionFileRevisions, config ?? {})
    return { ctx, session }
  }

  /** One `write` through the real tool runtime, so the capture sees a settled result. */
  async function write(ctx: Context, session: Session, content: string): Promise<void> {
    await ctx.tools.execute({
      callId: ToolCallId('c1'),
      name: 'write',
      arguments: { file_path: 'a.txt', content },
      agent: { session } as never,
      signal: new AbortController().signal,
    })
  }

  it('restores a revision after the process is replaced', async () => {
    const first = await durable('r1', 1_000)
    registerWrite(first.ctx)
    await writeFile(join(root, 'a.txt'), 'original\n', 'utf8')
    await write(first.ctx, first.session, 'changed\n')
    // Disposal drains the queued write and closes the domain, which is what a
    // clean Host shutdown does before the next process reads the medium.
    await first.ctx.fiber.dispose()

    // A fresh context over the same storage root is what a restarted Host is.
    const second = await durable('r1', 1_000)
    const revisions = second.ctx.sessionFileRevisions.list(SessionId('r1'))
    expect(revisions).toHaveLength(1)
    expect(revisions[0]?.baseline).toBe('original\n')
    expect(revisions[0]?.endState).toBe('changed\n')
    await second.ctx.fiber.dispose()
  })

  it('refuses a restored record whose session lifecycle no longer matches', async () => {
    const first = await durable('r2', 1_000)
    registerWrite(first.ctx)
    await writeFile(join(root, 'a.txt'), 'original\n', 'utf8')
    await write(first.ctx, first.session, 'changed\n')
    await first.ctx.fiber.dispose()

    // Same id, different lifecycle: a deleted-and-recreated session must not
    // inherit baselines captured from the log it replaced.
    const second = await durable('r2', 2_000)
    expect(second.ctx.sessionFileRevisions.list(SessionId('r2'))).toEqual([])
    await second.ctx.fiber.dispose()
  })

  it('does not persist a record past the configured cap', async () => {
    const first = await durable('r3', 1_000, { maxRecordBytes: 1 })
    registerWrite(first.ctx)
    await writeFile(join(root, 'a.txt'), 'original\n', 'utf8')
    await write(first.ctx, first.session, 'changed\n')
    // The cap is a write-side refusal, not a read-side filter: the session keeps
    // its revisions for as long as this process lives.
    expect(first.ctx.sessionFileRevisions.list(SessionId('r3'))).toHaveLength(1)
    await first.ctx.fiber.dispose()

    // A truncated baseline would let a revert write content the session never
    // made, so the over-cap record is absent rather than shortened.
    const second = await durable('r3', 1_000)
    expect(second.ctx.sessionFileRevisions.list(SessionId('r3'))).toEqual([])
    await second.ctx.fiber.dispose()
  })

  it('retires a reverted path so it stops being offered', async () => {
    const { ctx, session } = await durable('r4', 1_000)
    registerWrite(ctx)
    await writeFile(join(root, 'a.txt'), 'original\n', 'utf8')
    await write(ctx, session, 'changed\n')
    expect(ctx.sessionFileRevisions.list(session.id)).toHaveLength(1)

    await ctx.sessionFileRevisions.dropPath(session.id, join(root, 'a.txt'))
    expect(ctx.sessionFileRevisions.list(session.id)).toEqual([])
    await ctx.fiber.dispose()
  })

  it('persists with NO config argument, as the shipped assembly declares it', async () => {
    // The shipped cordis.yml row sets no `config`, so the plugin is constructed
    // with `undefined`. Reading a field straight off that config threw inside the
    // write job, where the fail-soft catch swallowed it: capture worked in
    // memory and nothing ever reached the disk, so every revision was lost on
    // restart and the surface reported no record for paths the list showed.
    const first = await durable('nc', 1_000, undefined, true)
    registerWrite(first.ctx)
    await writeFile(join(root, 'a.txt'), 'original\n', 'utf8')
    await write(first.ctx, first.session, 'changed\n')
    await first.ctx.fiber.dispose()

    const second = await durable('nc', 1_000, undefined, true)
    expect(second.ctx.sessionFileRevisions.list(SessionId('nc'))).toHaveLength(1)
    await second.ctx.fiber.dispose()
  })

  it('retires the record across a restart once the path was reverted', async () => {
    const { ctx, session } = await durable('r5', 1_000)
    registerWrite(ctx)
    await writeFile(join(root, 'a.txt'), 'original\n', 'utf8')
    await write(ctx, session, 'changed\n')
    await ctx.sessionFileRevisions.dropPath(session.id, join(root, 'a.txt'))
    await ctx.fiber.dispose()

    const second = await durable('r5', 1_000)
    expect(second.ctx.sessionFileRevisions.list(SessionId('r5'))).toEqual([])
    await second.ctx.fiber.dispose()
  })

  it('refuses a recreated child record merged into a live root', async () => {
    // A read merges a root with its descendants, and a child's id names a slot
    // just as the root's does. Checking only the queried root would let a
    // recreated child feed baselines from the log it replaced into the root's
    // answer, which a revert would then act on.
    const first = await durable('r6', 1_000)
    const child = first.ctx.sessions.create(SessionId('r6-child'), {
      meta: { createdAt: 1_000, cwd: root, parentSession: SessionId('r6') },
    })
    registerWrite(first.ctx)
    await writeFile(join(root, 'a.txt'), 'original\n', 'utf8')
    await first.ctx.tools.execute({
      callId: ToolCallId('c1'),
      name: 'write',
      arguments: { file_path: 'a.txt', content: 'changed\n' },
      agent: { session: child } as never,
      signal: new AbortController().signal,
    })
    await first.ctx.fiber.dispose()

    // The root keeps its lifecycle; the child is recreated under the same id.
    const second = await durable('r6', 1_000)
    second.ctx.sessions.create(SessionId('r6-child'), {
      meta: { createdAt: 2_000, cwd: root, parentSession: SessionId('r6') },
    })
    expect(second.ctx.sessionFileRevisions.list(SessionId('r6'))).toEqual([])
    await second.ctx.fiber.dispose()
  })
})
