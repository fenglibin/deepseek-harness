/**
 * File-extension to syntax-highlighting language hints for the file browser.
 *
 * The hint ids are the aliases `ui-primitives`' shiki singleton resolves to a
 * grammar, so this table decides only which grammar an extension asks for; an
 * unknown extension yields `undefined` and the editor renders plain monospace.
 * The mapping lives on the Client because it is a presentation fact — the Host
 * answers file bytes, not how they should be colored.
 * @module @deepseek-ai/dsh-client-ui-file-browser/language
 */

/**
 * Extension (lowercased, without the dot) to the shiki language alias.
 *
 * Covers the common back- and front-end languages and the configuration
 * formats an operator edits by hand. Aliases the highlighter does not resolve
 * still fall back to plain text there; keeping them here means adding a grammar
 * upstream needs no change in this package.
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
 * own-property check so a name like `foo.constructor` maps to no language
 * rather than to an inherited member.
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
