/**
 * Editing one composition row's enablement: the one write to a preset that is
 * not a whole-directory copy. It addresses the row by the id the file itself
 * declares, moves only that row's `disabled` line, and leaves a `!!js` gate
 * alone.
 */

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { beforeEach, describe, expect, it } from 'vitest'
import AgentPresets, { COMPOSITION_FILE, type Config } from '@deepseek-ai/dsh-agent-presets'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const NESTED = [
  '# Leading comment the edit must not eat.',
  '- id: alpha',
  '  name: ../../plugins/contribute.js',
  '',
  '# Between rows, so still outside every item.',
  '- id: gated',
  '  name: ../../plugins/contribute.js',
  '  disabled: !!js process.platform === \'win32\'',
  '- id: group',
  '  name: cordis:group',
  '  group: true',
  '  config:',
  '    - id: beta',
  '      name: ../../plugins/contribute.js',
  '      disabled: true',
  '',
].join('\n')

let ctx: Context
let userRoot: string

/** Hand-craft a preset directory under the writable root. */
async function seedPreset(id: string, composition = NESTED): Promise<void> {
  await mkdir(join(userRoot, id), { recursive: true })
  await writeFile(join(userRoot, id, COMPOSITION_FILE), composition)
}

/** The composition file of one seeded preset, as the write left it. */
function written(id: string): Promise<string> {
  return readFile(join(userRoot, id, COMPOSITION_FILE), 'utf8')
}

beforeEach(async () => {
  userRoot = await mkdtemp(join(tmpdir(), 'dsh-preset-edit-'))
  ctx = new Context()
  ctx.baseUrl = pathToFileURL(FIXTURES).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentPresets, {
    default: 'standard',
    roots: [
      { path: join(FIXTURES, 'system'), trust: 'system' as const },
      { path: userRoot, trust: 'user' as const },
    ],
    // This file pins its own roots: the shipped set would shadow the fixture
    // ids, and the derived harness-home root would add the developer's own.
    includeShippedRoot: false,
    includeUserRoot: false,
  } satisfies Config)
})

/** One roster over a single root of the given trust, seeded with one preset. */
async function seededRoster(
  trust: 'system' | 'user',
  id: string,
  composition = NESTED,
): Promise<{ readonly ctx: Context; readonly path: string }> {
  const root = await mkdtemp(join(tmpdir(), `dsh-preset-edit-${trust}-`))
  await mkdir(join(root, id), { recursive: true })
  const path = join(root, id, COMPOSITION_FILE)
  await writeFile(path, composition)
  const seeded = new Context()
  seeded.baseUrl = pathToFileURL(FIXTURES).href + '/'
  await seeded.plugin(Loader)
  seeded.loader.builtins.include = Include
  await seeded.plugin(SessionProjectionRegistry)
  await seeded.plugin(AgentPresets, {
    default: id,
    roots: [{ path: root, trust }],
    includeShippedRoot: false,
    includeUserRoot: false,
  } satisfies Config)
  return { ctx: seeded, path }
}

describe('enabling and disabling one composition row', () => {
  it('stops a row by writing its disabled flag, keeping every other row', async () => {
    await seedPreset('mine')

    await ctx.agentPresets.setRowDisabled('mine', 'alpha', true)

    const text = await written('mine')
    expect(text).toContain('disabled: true')
    // A `!!js` gate is the author's and is left exactly as it was written.
    expect(text).toContain('disabled: !!js process.platform === \'win32\'')
  })

  it('enables a row by dropping the flag, including one nested in a group', async () => {
    await seedPreset('mine')

    await ctx.agentPresets.setRowDisabled('mine', 'beta', false)

    const text = await written('mine')
    expect(text).toContain('id: beta')
    expect(text).not.toContain('id: beta\n      disabled')
    // The group that owns the row survives the edit.
    expect(text).toContain('id: group')
  })

  it('leaves every other byte of the file alone, comments included', async () => {
    await seedPreset('mine')

    await ctx.agentPresets.setRowDisabled('mine', 'alpha', true)

    expect(await written('mine')).toBe(NESTED.replace('- id: alpha\n', '- id: alpha\n  disabled: true\n'))
  })

  it('writes a preset the deployment ships, at the file discovery resolved', async () => {
    const shipped = await seededRoster('system', 'shipped')

    await shipped.ctx.agentPresets.setRowDisabled('shipped', 'alpha', true)

    expect(await readFile(shipped.path, 'utf8')).toContain('disabled: true')
  })

  it('finds a row whose id is not its first key', async () => {
    await seedPreset('mine', '- name: ../../plugins/contribute.js\n  id: alpha\n')

    await ctx.agentPresets.setRowDisabled('mine', 'alpha', true)

    expect(await written('mine')).toBe('- name: ../../plugins/contribute.js\n  disabled: true\n  id: alpha\n')
  })

  it('refuses a row no row in the composition declares', async () => {
    await seedPreset('mine')
    await expect(ctx.agentPresets.setRowDisabled('mine', 'absent', true))
      .rejects.toThrow(/no row declares id/)
  })

  it('refuses to replace a `!!js` gate, which is the author\'s to change', async () => {
    await seedPreset('mine')
    await expect(ctx.agentPresets.setRowDisabled('mine', 'gated', true))
      .rejects.toThrow(/only its author may replace/)
  })

  it('skips rows that are not mappings while looking for the id', async () => {
    await seedPreset('mine', '- null\n- just-a-string\n- id: alpha\n  name: ../../plugins/contribute.js\n')

    await ctx.agentPresets.setRowDisabled('mine', 'alpha', true)

    expect(await written('mine')).toContain('disabled: true')
  })

  it('refuses a composition that is not a row list', async () => {
    await seedPreset('mine', 'not: a list\n')
    await expect(ctx.agentPresets.setRowDisabled('mine', 'alpha', true))
      .rejects.toThrow(/not a row list/)
  })

  it('refuses a composition it cannot read', async () => {
    await mkdir(join(userRoot, 'ghost'), { recursive: true })
    await expect(ctx.agentPresets.setRowDisabled('ghost', 'alpha', true))
      .rejects.toThrow(/composition file is unreadable/)
  })

  it('demands both ids up front', async () => {
    await seedPreset('mine')
    await expect(ctx.agentPresets.setRowDisabled('', 'alpha', true))
      .rejects.toThrow(/must be a non-empty string/)
    await expect(ctx.agentPresets.setRowDisabled('mine', '', true))
      .rejects.toThrow(/must be a non-empty string/)
    await expect(ctx.agentPresets.setRowDisabled('never-existed', 'alpha', true))
      .rejects.toThrow(/not found/)
  })

  it('reaches a preset a second root owns, writing the file that root resolved', async () => {
    const second = await mkdtemp(join(tmpdir(), 'dsh-preset-edit-second-'))
    await mkdir(join(second, 'elsewhere'), { recursive: true })
    const path = join(second, 'elsewhere', COMPOSITION_FILE)
    await writeFile(path, NESTED)
    const layered = new Context()
    layered.baseUrl = pathToFileURL(FIXTURES).href + '/'
    await layered.plugin(Loader)
    layered.loader.builtins.include = Include
    await layered.plugin(SessionProjectionRegistry)
    await layered.plugin(AgentPresets, {
      default: 'standard',
      roots: [
        { path: userRoot, trust: 'user' as const },
        { path: second, trust: 'user' as const },
      ],
      includeShippedRoot: false,
      includeUserRoot: false,
    } satisfies Config)

    // The row edit is not confined to the first user root: it writes the
    // composition discovery resolved, whichever configured root supplied it.
    await layered.agentPresets.setRowDisabled('elsewhere', 'alpha', true)

    expect(await readFile(path, 'utf8')).toContain('disabled: true')
  })

  it('refuses a row written in a flow style this edit cannot preserve', async () => {
    await seedPreset('mine', '- {id: alpha, name: ../../plugins/contribute.js}\n')

    await expect(ctx.agentPresets.setRowDisabled('mine', 'alpha', true))
      .rejects.toThrow(/cannot preserve/)
  })

  it('still refuses to delete a preset the deployment ships', async () => {
    const shipped = await seededRoster('system', 'shipped')

    await expect(shipped.ctx.agentPresets.remoteExportDelete('shipped'))
      .rejects.toThrow(/ships with the deployment/)
  })
})
