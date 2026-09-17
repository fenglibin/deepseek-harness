/**
 * File-extension to syntax-highlighting language hints.
 *
 * The hint ids are the aliases this package's shiki singleton resolves to a
 * grammar (see `./markdown/highlight.ts`), so the table has to live beside that
 * singleton: it decides which grammar an extension asks for, and a second copy
 * elsewhere would have to agree with it forever. An unknown extension yields
 * `undefined` and a caller renders plain monospace.
 *
 * The mapping is a presentation fact, so it belongs on the Client — the Host
 * answers file bytes, not how they should be colored.
 *
 * @module @deepseek-ai/dsh-client-ui-primitives/file-language
 */

/**
 * Extension (lowercased, without the dot) to the shiki language alias.
 *
 * Covers the common back- and front-end languages and the configuration formats
 * an operator edits by hand. Aliases the highlighter does not resolve still fall
 * back to plain text there; keeping them here means adding a grammar upstream
 * needs no change at the call sites.
 */
const LANG_BY_EXTENSION: Readonly<Record<string, string>> = {
  // JavaScript family.
  ts: 'ts', tsx: 'tsx', mts: 'ts', cts: 'ts',
  js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js',
  // Back-end languages.
  py: 'py', rb: 'rb', go: 'go', rs: 'rs', java: 'java',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cxx: 'cpp',
  cs: 'cs', kt: 'kotlin', swift: 'swift', php: 'php', lua: 'lua',
  // Shell.
  sh: 'sh', bash: 'bash', zsh: 'zsh',
  // Configuration and data.
  json: 'json', jsonc: 'jsonc', toml: 'toml', ini: 'ini',
  yaml: 'yaml', yml: 'yml', xml: 'xml', sql: 'sql',
  // Markup and styles.
  md: 'md', markdown: 'markdown', mdx: 'mdx',
  html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
}

/**
 * Derive the syntax-highlighting hint from a file path's extension.
 *
 * Case-insensitive on the extension. A dotfile whose name begins with the dot
 * (`.gitignore`) has no extension and yields `undefined`. The lookup is an
 * own-property check so a name like `foo.constructor` maps to no language rather
 * than to an inherited member.
 * @param path - workspace-relative or absolute file path.
 * @returns the language hint, or `undefined` when the extension maps to none.
 */
export function languageOfPath(path: string): string | undefined {
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return undefined
  const extension = base.slice(dot + 1).toLowerCase()
  return Object.hasOwn(LANG_BY_EXTENSION, extension) ? LANG_BY_EXTENSION[extension] : undefined
}
