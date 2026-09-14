/**
 * The whole-log changed-file fold: the `changedFiles` projection unit's
 * event-by-event transition, the mutation vocabulary it classifies calls with,
 * and path canonicalization. The window-independent behavior is the point of
 * the unit, so the fold is driven directly over the events that make up a
 * Session log.
 */
import { describe, expect, it } from 'vitest'
import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  canonicalMutationPath, changedFilesProjectionDefinition, changedFilesView,
  mutationTarget, stepFileChanges, type FileChangesState,
} from '../src/index.ts'

/** Fold a synthetic Session log through the unit's own transition. */
function fold(events: readonly SessionEvent[], cwd?: string): FileChangesState {
  return events.reduce(
    stepFileChanges,
    changedFilesProjectionDefinition.init({
      version: 0,
      id: SessionId('file-changes-spec'),
      createdAt: 0,
      ...cwd === undefined ? {} : { cwd },
    }),
  )
}

/** One `tool/call` event for a mutation tool. */
function call(
  seq: number, turn: number, callId: string, name: string, args: unknown,
): SessionEvent {
  return {
    type: 'tool/call',
    seq,
    time: seq,
    data: { turn, step: 1, callId: ToolCallId(callId), name, arguments: JSON.stringify(args) },
  }
}

/** One settled `tool/result` event for a previously recorded call. */
function result(seq: number, turn: number, callId: string, isError = false): SessionEvent {
  return {
    type: 'tool/result',
    seq,
    time: seq,
    data: {
      turn,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId(callId),
        content: [{ type: 'text', text: isError ? 'failed' : 'ok' }],
        isError,
      }),
    },
    surfaceOp: 'append',
    sourceEventSeqs: [seq - 1],
  } as unknown as SessionEvent
}

function turnStart(turn: number): SessionEvent {
  return { type: 'turn/start', seq: 0, time: 0, data: { turn } }
}

function turnEnd(seq: number, turn: number): SessionEvent {
  return { type: 'turn/end', seq, time: seq, data: { turn, reason: 'completed' } } as SessionEvent
}

describe('canonicalMutationPath', () => {
  it('resolves a Workspace-relative path against the Session cwd', () => {
    expect(canonicalMutationPath('src/a.ts', '/proj')).toBe('/proj/src/a.ts')
  })

  it('collapses dot segments, duplicate separators, and backslashes', () => {
    expect(canonicalMutationPath('/proj/lib/../src//a.ts', '/proj')).toBe('/proj/src/a.ts')
    expect(canonicalMutationPath('src\\a.ts', '/proj')).toBe('/proj/src/a.ts')
  })

  it('keeps a relative path relative without a Workspace root', () => {
    expect(canonicalMutationPath('src/a.ts', undefined)).toBe('src/a.ts')
  })
})

describe('mutationTarget', () => {
  it('reads file_path for write and edit and path for str_replace_editor', () => {
    expect(mutationTarget('write', '{"file_path":"a.txt","content":"x"}'))
      .toEqual({ path: 'a.txt', operation: 'write' })
    expect(mutationTarget('edit', '{"file_path":"a.txt","old_string":"x","new_string":"y"}'))
      .toEqual({ path: 'a.txt', operation: 'edit' })
    expect(mutationTarget('str_replace_editor', '{"command":"create","path":"a.txt","file_text":"x"}'))
      .toEqual({ path: 'a.txt', operation: 'edit' })
  })

  it('rejects read-only and unsupported calls', () => {
    expect(mutationTarget('read', '{"file_path":"a.txt"}')).toBeNull()
    expect(mutationTarget('str_replace_editor', '{"command":"view","path":"a.txt"}')).toBeNull()
    expect(mutationTarget('bash', '{"command":"rm a.txt"}')).toBeNull()
  })

  it('rejects incomplete mutation arguments', () => {
    // A write with no content, an edit whose strings are equal or empty, and a
    // str_replace with no old_str never mutated a file.
    expect(mutationTarget('write', '{"file_path":"a.txt"}')).toBeNull()
    expect(mutationTarget('edit', '{"file_path":"a.txt","old_string":"x","new_string":"x"}')).toBeNull()
    expect(mutationTarget('edit', '{"file_path":"a.txt","old_string":"","new_string":"y"}')).toBeNull()
    expect(mutationTarget('str_replace_editor', '{"command":"str_replace","path":"a.txt"}')).toBeNull()
  })

  it('rejects malformed JSON and non-object arguments', () => {
    expect(mutationTarget('write', 'not json')).toBeNull()
    expect(mutationTarget('write', '"a string"')).toBeNull()
    expect(mutationTarget('write', '[1,2]')).toBeNull()
  })

  it('rejects a blank path and a non-string path', () => {
    expect(mutationTarget('write', '{"file_path":"   ","content":"x"}')).toBeNull()
    expect(mutationTarget('write', '{"file_path":42,"content":"x"}')).toBeNull()
  })

  it('accepts the optional fields each mutation tool allows', () => {
    // `edit` tolerates an explicit replace_all boolean; `str_replace` tolerates
    // an absent new_str; `insert` needs a non-negative integer line.
    expect(mutationTarget('edit', '{"file_path":"a.txt","old_string":"x","new_string":"y","replace_all":true}'))
      .toEqual({ path: 'a.txt', operation: 'edit' })
    expect(mutationTarget('str_replace_editor', '{"command":"str_replace","path":"a.txt","old_str":"x"}'))
      .toEqual({ path: 'a.txt', operation: 'edit' })
    expect(mutationTarget('str_replace_editor', '{"command":"insert","path":"a.txt","insert_line":3,"new_str":"x"}'))
      .toEqual({ path: 'a.txt', operation: 'edit' })
  })

  it('rejects the optional fields each mutation tool refuses', () => {
    // A non-boolean replace_all, a negative or fractional insert_line, a
    // missing new_str on insert, and a create without file_text.
    expect(mutationTarget('edit', '{"file_path":"a.txt","old_string":"x","new_string":"y","replace_all":"yes"}')).toBeNull()
    expect(mutationTarget('str_replace_editor', '{"command":"insert","path":"a.txt","insert_line":-1,"new_str":"x"}')).toBeNull()
    expect(mutationTarget('str_replace_editor', '{"command":"insert","path":"a.txt","insert_line":1.5,"new_str":"x"}')).toBeNull()
    expect(mutationTarget('str_replace_editor', '{"command":"insert","path":"a.txt","insert_line":1}')).toBeNull()
    expect(mutationTarget('str_replace_editor', '{"command":"create","path":"a.txt"}')).toBeNull()
  })

  it('rejects an editor command with no path', () => {
    expect(mutationTarget('str_replace_editor', '{"command":"create","file_text":"x"}')).toBeNull()
  })

  it('rejects a str_replace whose new_str is not a string', () => {
    expect(mutationTarget('str_replace_editor', '{"command":"str_replace","path":"a.txt","old_str":"x","new_str":42}'))
      .toBeNull()
  })

  it('rejects an unsupported editor command', () => {
    expect(mutationTarget('str_replace_editor', '{"command":"delete","path":"a.txt"}')).toBeNull()
    expect(mutationTarget('str_replace_editor', '{"path":"a.txt"}')).toBeNull()
  })
})

describe('changedFiles folding', () => {
  it('records a successful mutation and ignores unrelated events', () => {
    const events = [
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } } as SessionEvent,
      call(1, 1, 'c1', 'write', { file_path: 'a.txt', content: 'x' }),
      result(2, 1, 'c1'),
      turnEnd(3, 1),
    ]
    expect(changedFilesView(fold(events, '/proj'))).toEqual({
      files: [{ path: '/proj/a.txt', operation: 'write', firstSeq: 2, lastSeq: 2 }],
    })
  })

  it('counts only the mutation whose result succeeded', () => {
    const events = [
      call(1, 1, 'c1', 'edit', { file_path: 'a.txt', old_string: 'x', new_string: 'y' }),
      result(2, 1, 'c1', true),
      turnEnd(3, 1),
    ]
    expect(changedFilesView(fold(events, '/proj')).files).toEqual([])
  })

  it('keeps the earliest operation and the latest seq for one path', () => {
    const events = [
      call(1, 1, 'c1', 'write', { file_path: 'a.txt', content: 'x' }),
      result(2, 1, 'c1'),
      turnEnd(3, 1),
      call(4, 2, 'c2', 'edit', { file_path: 'a.txt', old_string: 'x', new_string: 'y' }),
      result(5, 2, 'c2'),
      turnEnd(6, 2),
    ]
    expect(changedFilesView(fold(events, '/proj')).files).toEqual([
      { path: '/proj/a.txt', operation: 'write', firstSeq: 2, lastSeq: 5 },
    ])
  })

  it('folds two spellings of one file into one entry', () => {
    const events = [
      call(1, 1, 'c1', 'write', { file_path: 'src/a.ts', content: 'x' }),
      result(2, 1, 'c1'),
      call(3, 2, 'c2', 'edit', { file_path: '/proj/src/a.ts', old_string: 'x', new_string: 'y' }),
      result(4, 2, 'c2'),
    ]
    expect(changedFilesView(fold(events, '/proj')).files).toEqual([
      { path: '/proj/src/a.ts', operation: 'write', firstSeq: 2, lastSeq: 4 },
    ])
  })

  it('orders entries by first-seen seq, not by key insertion', () => {
    const events = [
      call(1, 1, 'c1', 'write', { file_path: 'b.txt', content: 'x' }),
      result(2, 1, 'c1'),
      call(3, 1, 'c2', 'write', { file_path: 'a.txt', content: 'x' }),
      result(4, 1, 'c2'),
    ]
    expect(changedFilesView(fold(events, '/proj')).files.map(file => file.path))
      .toEqual(['/proj/b.txt', '/proj/a.txt'])
  })

  it('covers write, edit, and str_replace_editor alike', () => {
    const events = [
      call(1, 1, 'c1', 'write', { file_path: 'a.txt', content: 'x' }),
      result(2, 1, 'c1'),
      call(3, 1, 'c2', 'edit', { file_path: 'b.txt', old_string: 'x', new_string: 'y' }),
      result(4, 1, 'c2'),
      call(5, 1, 'c3', 'str_replace_editor', { command: 'insert', path: 'c.txt', insert_line: 0, new_str: 'x' }),
      result(6, 1, 'c3'),
    ]
    expect(changedFilesView(fold(events, '/proj')).files.map(file => file.path))
      .toEqual(['/proj/a.txt', '/proj/b.txt', '/proj/c.txt'])
  })

  it('drops an interrupted turn\'s unsettled calls', () => {
    const events = [
      call(1, 1, 'c1', 'write', { file_path: 'a.txt', content: 'x' }),
      turnEnd(2, 1),
      // The result arrives after its turn already ended: no pending entry is left.
      result(3, 1, 'c1'),
    ]
    const state = fold(events, '/proj')
    expect(state.pending).toEqual({})
    expect(changedFilesView(state).files).toEqual([])
  })

  it('ignores a result whose call was not a mutation', () => {
    const events = [
      call(1, 1, 'c1', 'read', { file_path: 'a.txt' }),
      result(2, 1, 'c1'),
    ]
    expect(changedFilesView(fold(events, '/proj')).files).toEqual([])
  })

  it('ignores a replacement-origin result', () => {
    // A shadowed span's result is not the transcript's own history, so it
    // cannot prove a mutation landed.
    const replacement = { ...result(2, 1, 'c1'), surfaceOp: 'replace' }
    const events = [
      call(1, 1, 'c1', 'write', { file_path: 'a.txt', content: 'x' }),
      replacement as SessionEvent,
    ]
    expect(changedFilesView(fold(events, '/proj')).files).toEqual([])
  })

  it('keeps a relative path when the Session has no Workspace root', () => {
    const events = [
      call(1, 1, 'c1', 'write', { file_path: 'a.txt', content: 'x' }),
      result(2, 1, 'c1'),
    ]
    expect(changedFilesView(fold(events)).files).toEqual([
      { path: 'a.txt', operation: 'write', firstSeq: 2, lastSeq: 2 },
    ])
  })

  it('keeps the state reference when an event is not its own', () => {
    const state = fold([], '/proj')
    const unrelated = { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } } as SessionEvent
    expect(stepFileChanges(state, unrelated)).toBe(state)
    // A result with no pending call is also a no-op.
    expect(stepFileChanges(state, result(1, 1, 'missing'))).toBe(state)
    // A turn/end with nothing pending changes nothing either.
    expect(stepFileChanges(state, turnEnd(2, 1))).toBe(state)
  })

  it('never lets a replayed result regress the recorded bounds', () => {
    // A resumed or repaired replay can re-deliver an event the fold already
    // saw. The accept rule compares against `lastSeq`, so the bound must never
    // move backwards; `firstSeq` and the operation belong to the earliest
    // mutation and must not drift either.
    const events = [
      call(1, 1, 'c1', 'write', { file_path: 'a.txt', content: 'x' }),
      result(2, 1, 'c1'),
      call(3, 1, 'c2', 'edit', { file_path: 'a.txt', old_string: 'x', new_string: 'y' }),
      result(4, 1, 'c2'),
    ]
    const before = fold(events, '/proj')
    expect(before.files['/proj/a.txt']).toEqual({ operation: 'write', firstSeq: 2, lastSeq: 4 })
    // Re-deliver the already-folded edit result: idempotent.
    const again = stepFileChanges(before, result(4, 1, 'c2'))
    expect(again.files['/proj/a.txt']).toEqual({ operation: 'write', firstSeq: 2, lastSeq: 4 })
  })

  it('drops a pending entry whose result failed', () => {
    const events = [
      call(1, 1, 'c1', 'write', { file_path: 'a.txt', content: 'x' }),
      result(2, 1, 'c1', true),
    ]
    const state = fold(events, '/proj')
    expect(state.pending).toEqual({})
    expect(changedFilesView(state).files).toEqual([])
  })

  it('folds a real Session log end to end', () => {
    const session = Session.create(SessionId('file-changes-real'), undefined, {
      version: 0,
      id: SessionId('file-changes-real'),
      createdAt: 0,
      cwd: '/proj',
    })
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const source = session.append('tool/call', {
      turn: 1, step: 1, callId: ToolCallId('real-1'), name: 'write',
      arguments: JSON.stringify({ file_path: 'notes/demo.txt', content: 'hello\n' }),
    })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('real-1'),
        content: [{ type: 'text', text: 'Created notes/demo.txt' }],
        isError: false,
      }),
    }, { surfaceOp: 'append', sourceEventSeqs: [source.seq] })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const state = session.events.reduce(
      stepFileChanges,
      changedFilesProjectionDefinition.init(session.header),
    )
    // The write's result seq is host-assigned; assert the shape and that the
    // single entry's bounds agree rather than pinning a literal seq.
    const [entry] = changedFilesView(state).files
    expect(entry).toMatchObject({ path: '/proj/notes/demo.txt', operation: 'write' })
    expect(entry?.firstSeq).toBe(entry?.lastSeq)
  })
})

describe('multi-mutation paths', () => {
  /** Record `count` successful mutations of one path inside one turn. */
  function repeated(count: number, isError = false): readonly SessionEvent[] {
    const events: SessionEvent[] = [turnStart(1)]
    let seq = 1
    for (let index = 0; index < count; index += 1) {
      events.push(call(seq, 1, `c${String(index)}`, 'write', { file_path: 'src/a.txt', content: 'x' }))
      events.push(result(seq + 1, 1, `c${String(index)}`, isError))
      seq += 2
    }
    events.push(turnEnd(seq, 1))
    return events
  }

  it('advances lastSeq across repeated mutations of one path', () => {
    const [entry] = changedFilesView(fold(repeated(3), '/proj')).files
    expect(entry).toMatchObject({ path: '/proj/src/a.txt', operation: 'write' })
    expect(entry?.firstSeq).toBe(2)
    expect(entry?.lastSeq).toBe(6)
  })

  it('counts a path whose only successful mutation follows a failed one', () => {
    // A failed call contributes nothing, but it must not poison the path: the
    // later success still records it.
    const events: SessionEvent[] = [
      turnStart(1),
      call(1, 1, 'c1', 'write', { file_path: 'src/a.txt', content: 'x' }),
      result(2, 1, 'c1', true),
      call(3, 1, 'c2', 'write', { file_path: 'src/a.txt', content: 'y' }),
      result(4, 1, 'c2'),
      turnEnd(5, 1),
    ]
    const [entry] = changedFilesView(fold(events, '/proj')).files
    expect(entry).toMatchObject({ path: '/proj/src/a.txt', firstSeq: 4, lastSeq: 4 })
  })

  it('keeps lastSeq from moving backwards when an older result replays', () => {
    // The accept rule compares against lastSeq; a value that could regress
    // would hide a change the reader never accepted.
    const events = [
      call(1, 1, 'c1', 'write', { file_path: 'src/a.txt', content: 'x' }),
      result(2, 1, 'c1'),
      call(3, 1, 'c2', 'edit', { file_path: 'src/a.txt', old_string: 'x', new_string: 'y' }),
      result(4, 1, 'c2'),
    ]
    const folded = fold(events, '/proj')
    const [entry] = changedFilesView(folded).files
    expect(entry?.lastSeq).toBe(4)
    // Replaying the earlier result must not lower it.
    const replayed = stepFileChanges(folded, result(2, 1, 'c1'))
    expect(changedFilesView(replayed).files[0]?.lastSeq).toBe(4)
  })

  it('keeps the earliest operation when a later mutation uses another kind', () => {
    const events = [
      call(1, 1, 'c1', 'write', { file_path: 'src/a.txt', content: 'x' }),
      result(2, 1, 'c1'),
      call(3, 1, 'c2', 'edit', { file_path: 'src/a.txt', old_string: 'x', new_string: 'y' }),
      result(4, 1, 'c2'),
    ]
    expect(changedFilesView(fold(events, '/proj')).files[0])
      .toMatchObject({ operation: 'write', firstSeq: 2, lastSeq: 4 })
  })
})

describe('replay order', () => {
  it('moves firstSeq back when a re-delivered result is genuinely earlier', () => {
    // The no-op guard must compare EVERY field: matching on the operation and
    // lastSeq alone would silently drop this correction.
    const events = [
      call(4, 1, 'c1', 'write', { file_path: 'a.txt', content: 'x' }),
      result(5, 1, 'c1'),
    ]
    const before = fold(events, '/proj')
    expect(before.files['/proj/a.txt']).toEqual({ operation: 'write', firstSeq: 5, lastSeq: 5 })
    const earlier = [
      ...events,
      call(2, 2, 'c2', 'write', { file_path: 'a.txt', content: 'y' }),
      result(3, 2, 'c2'),
    ]
    expect(fold(earlier, '/proj').files['/proj/a.txt'])
      .toEqual({ operation: 'write', firstSeq: 3, lastSeq: 5 })
  })


  it('takes the operation from the strictly earlier mutation', () => {
    // An out-of-order replay where the earlier call is a different kind: the
    // earlier one owns the operation, the later one owns lastSeq.
    const events = [
      call(4, 1, 'c1', 'edit', { file_path: 'a.txt', old_string: 'x', new_string: 'y' }),
      result(5, 1, 'c1'),
      call(2, 2, 'c2', 'write', { file_path: 'a.txt', content: 'x' }),
      result(3, 2, 'c2'),
    ]
    expect(fold(events, '/proj').files['/proj/a.txt'])
      .toEqual({ operation: 'write', firstSeq: 3, lastSeq: 5 })
  })

  it('reaches the same list whether the log replays forwards or backwards', () => {
    // Replay normally delivers events in order, but a resumed or repaired
    // replay must not be able to move `lastSeq` backwards — the accept rule
    // compares against it, so a regressed value would hide an unaccepted change.
    const forwards = [
      call(1, 1, 'c1', 'write', { file_path: 'src/a.txt', content: 'x' }),
      result(2, 1, 'c1'),
      call(3, 2, 'c2', 'edit', { file_path: 'src/a.txt', old_string: 'x', new_string: 'y' }),
      result(4, 2, 'c2'),
      call(5, 2, 'c3', 'write', { file_path: 'src/b.txt', content: 'x' }),
      result(6, 2, 'c3'),
    ]
    const backwards = [
      call(5, 2, 'c3', 'write', { file_path: 'src/b.txt', content: 'x' }),
      result(6, 2, 'c3'),
      call(3, 2, 'c2', 'edit', { file_path: 'src/a.txt', old_string: 'x', new_string: 'y' }),
      result(4, 2, 'c2'),
      call(1, 1, 'c1', 'write', { file_path: 'src/a.txt', content: 'x' }),
      result(2, 1, 'c1'),
    ]
    expect(changedFilesView(fold(backwards, '/proj')).files)
      .toEqual(changedFilesView(fold(forwards, '/proj')).files)
  })
})
