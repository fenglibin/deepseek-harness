import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { pluginDescription } from '../src/description.ts'

const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** One sentence of frontmatter, as a package's own README would publish it. */
function frontmatter(lines: readonly string[]): string {
  return ['---', ...lines, '---', '', '# pkg', ''].join('\n')
}

/**
 * Materialize a fake deployment root.
 * @param files - paths relative to the root, with their contents.
 * @returns the root directory and an anchor that resolves packages inside it.
 */
async function root(files: Record<string, string>): Promise<{ anchor: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-plugin-description-'))
  created.push(dir)
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }
  return { anchor: pathToFileURL(join(dir, 'anchor.js')).href }
}

/** A package directory: its module, an optional manifest, and its READMEs. */
function pkg(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([name, content]) => [`node_modules/pkg/${name}`, content]))
}

describe('pluginDescription', () => {
  it('skips Loader builtins, which ship inside Cordis and publish no README', async () => {
    const { anchor } = await root({})
    expect(await pluginDescription('cordis:timer', [anchor])).toBeUndefined()
  })

  it('reads the description a package published in its localized README', async () => {
    const { anchor } = await root(pkg({
      'index.js': 'module.exports = {}',
      'package.json': '{"name":"pkg","version":"1.0.0","main":"index.js"}',
      'README.zh.md': frontmatter(['description: "中文一句说明"', 'kind: "package-reference"']),
    }))
    expect(await pluginDescription('pkg', [anchor])).toBe('中文一句说明')
  })

  it('falls back to the unlocalized README and to a subpath specifier', async () => {
    const { anchor } = await root(pkg({
      'index.js': 'module.exports = {}',
      'extra.js': 'module.exports = {}',
      'package.json': '{"name":"pkg","version":"1.0.0","main":"index.js","exports":{".":"./index.js","./extra":"./extra.js"}}',
      'README.md': frontmatter(['description: "Unlocalized summary"']),
    }))
    expect(await pluginDescription('pkg', [anchor])).toBe('Unlocalized summary')
    expect(await pluginDescription('pkg/extra', [anchor])).toBe('Unlocalized summary')
  })

  it('reports nothing for a README that published no frontmatter block', async () => {
    const { anchor } = await root(pkg({
      'index.js': 'module.exports = {}',
      'package.json': '{"name":"pkg","version":"1.0.0"}',
      'README.md': '# pkg\n\nNo frontmatter here.\n',
    }))
    expect(await pluginDescription('pkg', [anchor])).toBeUndefined()
  })

  it('reports nothing for a frontmatter block the file never closes', async () => {
    const { anchor } = await root(pkg({
      'index.js': 'module.exports = {}',
      'package.json': '{"name":"pkg","version":"1.0.0"}',
      'README.md': '---\ndescription: "unterminated"\n',
    }))
    expect(await pluginDescription('pkg', [anchor])).toBeUndefined()
  })

  it('reports nothing for frontmatter that is not a mapping', async () => {
    const { anchor } = await root(pkg({
      'index.js': 'module.exports = {}',
      'package.json': '{"name":"pkg","version":"1.0.0"}',
      'README.md': '---\njust prose\n---\n',
    }))
    expect(await pluginDescription('pkg', [anchor])).toBeUndefined()
  })

  it('reports nothing for frontmatter that parses to null', async () => {
    const { anchor } = await root(pkg({
      'index.js': 'module.exports = {}',
      'package.json': '{"name":"pkg","version":"1.0.0"}',
      'README.md': '---\nnull\n---\n',
    }))
    expect(await pluginDescription('pkg', [anchor])).toBeUndefined()
  })

  it('reports nothing for unparsable frontmatter', async () => {
    const { anchor } = await root(pkg({
      'index.js': 'module.exports = {}',
      'package.json': '{"name":"pkg","version":"1.0.0"}',
      // A tab starts a block scalar indentation error inside the mapping.
      'README.md': '---\ndescription: "x"\n\tbad: [\n---\n',
    }))
    expect(await pluginDescription('pkg', [anchor])).toBeUndefined()
  })

  it('reports nothing when the block carries no description, a non-string one, or a blank one', async () => {
    for (const lines of [['kind: "package-reference"'], ['description: 42'], ['description: "   "']]) {
      const { anchor } = await root(pkg({
        'index.js': 'module.exports = {}',
        'package.json': '{"name":"pkg","version":"1.0.0"}',
        'README.md': frontmatter(lines),
      }))
      expect(await pluginDescription('pkg', [anchor])).toBeUndefined()
    }
  })

  it('stops the walk at the owning manifest rather than reading a group README', async () => {
    const { anchor } = await root({
      ...pkg({ 'index.js': 'module.exports = {}', 'package.json': '{"name":"pkg","version":"1.0.0"}' }),
      'README.md': frontmatter(['description: "Belongs to no package"']),
    })
    expect(await pluginDescription('pkg', [anchor])).toBeUndefined()
  })

  it('stops the walk at the filesystem root when no package owns the module', async () => {
    const { anchor } = await root({ 'node_modules/pkg/index.js': 'module.exports = {}' })
    expect(await pluginDescription('pkg', [anchor])).toBeUndefined()
  })

  it('reports nothing when no anchor installs the module', async () => {
    const { anchor } = await root({})
    expect(await pluginDescription('pkg', [anchor])).toBeUndefined()
  })

  it('tries every anchor in order until one resolves the module', async () => {
    const missing = await root({})
    const installed = await root(pkg({
      'index.js': 'module.exports = {}',
      'package.json': '{"name":"pkg","version":"1.0.0"}',
      'README.zh.md': frontmatter(['description: "Found under the second anchor"']),
    }))
    expect(await pluginDescription('pkg', [missing.anchor, installed.anchor]))
      .toBe('Found under the second anchor')
  })
})
