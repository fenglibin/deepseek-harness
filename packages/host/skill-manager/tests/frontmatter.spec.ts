import { describe, expect, it } from 'vitest'
import {
  editSkillFrontmatter,
  parseSkillFrontmatter,
  removeSkillFrontmatterKeys,
  renderSkillDocument,
} from '../src/frontmatter.ts'

/** A skill file carrying a comment and a key the caller will not touch. */
const RAW = [
  '---',
  '# routing hints',
  'name: demo',
  'description: A demo skill',
  'whenToUse: When demoing',
  '---',
  '',
  'Body text.',
  '',
].join('\n')

describe('parseSkillFrontmatter', () => {
  it('splits the block, the body, and the offsets between them', () => {
    const block = parseSkillFrontmatter(RAW)
    expect(block).toBeDefined()
    expect(block!.data).toMatchObject({
      name: 'demo',
      description: 'A demo skill',
      whenToUse: 'When demoing',
    })
    expect(block!.body).toBe('\nBody text.\n')
    // Slicing by the reported offsets must reproduce the block verbatim.
    expect(RAW.slice(block!.keysStart, block!.keysEnd)).toBe(
      '# routing hints\nname: demo\ndescription: A demo skill\nwhenToUse: When demoing\n',
    )
  })

  it('returns undefined when the file opens with something other than a delimiter', () => {
    expect(parseSkillFrontmatter('no frontmatter here\n')).toBeUndefined()
  })

  it('returns undefined when the first line is the only line', () => {
    expect(parseSkillFrontmatter('---')).toBeUndefined()
  })

  it('returns undefined when the closing delimiter never arrives', () => {
    expect(parseSkillFrontmatter('---\nname: demo\n')).toBeUndefined()
  })

  it('returns undefined when the block holds no mapping', () => {
    expect(parseSkillFrontmatter('---\n- one\n- two\n---\n')).toBeUndefined()
  })

  it('throws on malformed YAML so a caller can report the file rather than drop it', () => {
    expect(() => parseSkillFrontmatter('---\nname: [\n---\n')).toThrow()
  })

  it('tolerates CRLF line endings', () => {
    const block = parseSkillFrontmatter('---\r\nname: demo\r\n---\r\nbody\r\n')
    expect(block?.data).toMatchObject({ name: 'demo' })
  })

  it('reads an empty block as an empty mapping', () => {
    const block = parseSkillFrontmatter('---\n\n---\nbody\n')
    expect(block?.data).toEqual({})
    expect(block?.body).toBe('body\n')
  })
})

describe('editSkillFrontmatter', () => {
  it('replaces a key in place and keeps comments, order, and untouched keys', () => {
    const next = editSkillFrontmatter(RAW, [['description', 'Rewritten']])
    expect(next).toBe(RAW.replace('description: A demo skill', 'description: Rewritten'))
    expect(next).toContain('# routing hints')
    expect(next.indexOf('name: demo')).toBeLessThan(next.indexOf('description: Rewritten'))
  })

  it('appends a key the block does not carry', () => {
    const next = editSkillFrontmatter(RAW, [['user-invocable', false]])
    expect(next).toContain('user-invocable: false')
    expect(next.endsWith('---\n\nBody text.\n')).toBe(true)
  })

  it('quotes a value that would otherwise change the document shape', () => {
    const next = editSkillFrontmatter(RAW, [['description', 'has: a colon']])
    expect(parseSkillFrontmatter(next)?.data).toMatchObject({ description: 'has: a colon' })
  })

  it('writes booleans as YAML booleans rather than strings', () => {
    const next = editSkillFrontmatter(RAW, [['disable-model-invocation', true]])
    expect(parseSkillFrontmatter(next)?.data).toMatchObject({ 'disable-model-invocation': true })
  })

  it('adds a key to an empty block', () => {
    const next = editSkillFrontmatter('---\n---\nbody\n', [['name', 'demo']])
    expect(next).toBe('---\nname: demo\n---\nbody\n')
  })

  it('refuses a file with no frontmatter block', () => {
    expect(() => editSkillFrontmatter('body only\n', [['name', 'demo']])).toThrow(
      'skill file has no frontmatter block to edit',
    )
  })

  it('leaves an empty block empty when nothing is updated', () => {
    expect(editSkillFrontmatter('---\n---\nbody\n', [])).toBe('---\n---\nbody\n')
  })
})

describe('removeSkillFrontmatterKeys', () => {
  it('drops the named key and leaves the rest of the block alone', () => {
    const next = removeSkillFrontmatterKeys(RAW, ['whenToUse'])
    expect(next).not.toContain('whenToUse')
    expect(next).toContain('description: A demo skill')
    expect(next).toContain('# routing hints')
  })

  it('leaves the block intact when the key is absent', () => {
    expect(removeSkillFrontmatterKeys(RAW, ['absent'])).toBe(RAW)
  })

  it('empties a block whose only key is removed', () => {
    expect(removeSkillFrontmatterKeys('---\nname: demo\n---\nbody\n', ['name'])).toBe('---\n---\nbody\n')
  })

  it('refuses a file with no frontmatter block', () => {
    expect(() => removeSkillFrontmatterKeys('body only\n', ['name'])).toThrow(
      'skill file has no frontmatter block to edit',
    )
  })
})

describe('frontmatter block edges', () => {
  it('reads a block whose closing delimiter is the last line with no trailing newline', () => {
    const block = parseSkillFrontmatter('---\nname: demo\n---')
    expect(block?.data).toMatchObject({ name: 'demo' })
    expect(block?.body).toBe('')
  })

  it('reads a block whose body ends without a newline', () => {
    const block = parseSkillFrontmatter('---\nname: demo\n---\nbody')
    expect(block?.body).toBe('body')
  })

  it('reads an empty block as an empty mapping', () => {
    const block = parseSkillFrontmatter('---\n\n---\nbody\n')
    expect(block?.data).toEqual({})
    expect(block?.body).toBe('body\n')
  })

  it('reads a whitespace-only block as an empty mapping', () => {
    const block = parseSkillFrontmatter('---\n   \n---\nbody\n')
    expect(block?.data).toEqual({})
  })

  it('replaces a key that carries leading whitespace', () => {
    const next = editSkillFrontmatter('---\n  name: demo\n---\nbody\n', [['name', 'renamed']])
    expect(next).toBe('---\nname: renamed\n---\nbody\n')
  })

  it('renders a numeric-looking value as a quoted string', () => {
    const text = renderSkillDocument([['description', '42']], '')
    // A bare 42 would parse back as a number and fail the description check.
    expect(parseSkillFrontmatter(text)?.data.description).toBe('42')
  })

  it('renders a body that itself starts with a delimiter', () => {
    const text = renderSkillDocument([['name', 'demo']], '---\nnot a block\n---')
    expect(parseSkillFrontmatter(text)?.data).toMatchObject({ name: 'demo' })
  })
})

describe('renderSkillDocument', () => {
  it('renders explicit fields above the body', () => {
    expect(renderSkillDocument([
      ['name', 'demo'],
      ['description', 'A demo skill'],
      ['disable-model-invocation', false],
    ], 'Do the thing.')).toBe(
      '---\nname: demo\ndescription: A demo skill\ndisable-model-invocation: false\n---\n\nDo the thing.\n',
    )
  })

  it('renders a frontmatter-only document when the body is blank', () => {
    expect(renderSkillDocument([['name', 'demo']], '   ')).toBe('---\nname: demo\n---\n')
  })

  it('round-trips through the parser', () => {
    const text = renderSkillDocument([['name', 'demo'], ['description', 'A demo skill']], 'Body.')
    expect(parseSkillFrontmatter(text)).toMatchObject({
      data: { name: 'demo', description: 'A demo skill' },
      body: '\nBody.\n',
    })
  })
})
