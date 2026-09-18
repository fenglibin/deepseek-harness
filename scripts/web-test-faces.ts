/**
 * Keep every TypeScript source under `apps/web/tests` registered with exactly one
 * compiler face, and keep both registration lists free of dead entries.
 *
 * The two faces cannot share one program: they merge cordis Context under the same
 * keys with different services. The Client aggregate (`apps/web/tsconfig.json`)
 * therefore excludes the Host-plane web e2e lane one file at a time, while
 * `tsconfig.host.json` includes it one file at a time. Both lists are maintained by
 * hand, so an e2e file that is missing from the exclusion reaches the Client program
 * and drags the Host package graph in with its workspace imports (TS6059/TS6307).
 * This gate re-derives both programs through the TypeScript config parser and rejects
 * any file no face loads, any face-local import that crosses faces, and any literal
 * entry that names no file.
 */

import { existsSync, globSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

const CLIENT_CONFIG = 'apps/web/tsconfig.json'
const HOST_CONFIG = 'tsconfig.host.json'
const WEB_TEST_DIRECTORY = 'apps/web/tests'
const WEB_TEST_PREFIX = `${WEB_TEST_DIRECTORY}/`
/** Entry keys that register a web e2e file, per face. */
const CLIENT_ENTRY_KEY = 'exclude'
const HOST_ENTRY_KEY = 'include'

/** The TypeScript sources one face's program loads from `apps/web/tests`. */
interface CompilerFace {
  /** Repo-relative sources under `apps/web/tests`, in the program's own order. */
  readonly files: readonly string[]
  /** Options that resolve that face's relative imports. */
  readonly options: ts.CompilerOptions
}

/** One parsed configuration plus the entries the face registers web e2e files with. */
interface ParsedConfig {
  /** Raw configuration text, for the literal entry lists. */
  readonly raw: Readonly<Record<string, unknown>>
  readonly face: CompilerFace
}

/**
 * Find every registration defect in the two web-test compiler faces.
 *
 * @param root - Repository root containing both aggregate tsconfigs.
 * @returns Repo-relative diagnostics, sorted by location.
 */
export function collectWebTestFaceViolations(root: string): string[] {
  const client = parseConfig(root, CLIENT_CONFIG)
  const host = parseConfig(root, HOST_CONFIG)
  const clientFiles = new Set(client.face.files)
  const hostFiles = new Set(host.face.files)
  const clientOnly = new Set([...clientFiles].filter(file => !hostFiles.has(file)))
  const hostOnly = new Set([...hostFiles].filter(file => !clientFiles.has(file)))
  const violations = [
    ...unregisteredViolations(root, clientFiles, hostFiles),
    ...importViolations(root, CLIENT_CONFIG, client.face, hostOnly),
    ...importViolations(root, HOST_CONFIG, host.face, clientOnly),
    ...entryViolations(root, CLIENT_CONFIG, client.raw, CLIENT_ENTRY_KEY, 'tests/'),
    ...entryViolations(root, HOST_CONFIG, host.raw, HOST_ENTRY_KEY, WEB_TEST_PREFIX),
  ]
  return violations.sort()
}

/**
 * Read one tsconfig through the TypeScript parser and keep its `apps/web/tests` sources.
 * @param root - Repository root.
 * @param configPath - Repo-relative tsconfig path.
 * @returns the parsed configuration and the face it declares.
 */
function parseConfig(root: string, configPath: string): ParsedConfig {
  const configFile = resolve(root, configPath)
  if (!existsSync(configFile)) throw new Error(`${configPath}: configuration file is missing`)
  const read = ts.readConfigFile(configFile, path => ts.sys.readFile(path))
  if (read.error !== undefined) {
    throw new Error(`${configPath}: ${ts.flattenDiagnosticMessageText(read.error.messageText, '\n')}`)
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configFile))
  const failure = parsed.errors.find(error => error.category === ts.DiagnosticCategory.Error)
  if (failure !== undefined) {
    throw new Error(`${configPath}: ${ts.flattenDiagnosticMessageText(failure.messageText, '\n')}`)
  }
  const files = parsed.fileNames
    .map(file => repoRelative(root, file))
    .filter(file => file.startsWith(WEB_TEST_PREFIX))
  return { raw: read.config as Readonly<Record<string, unknown>>, face: { files, options: parsed.options } }
}

/**
 * List every TypeScript source the repository keeps under `apps/web/tests`.
 * @param root - Repository root.
 * @returns repo-relative sources, sorted.
 */
function webTestSources(root: string): string[] {
  const patterns = [`${WEB_TEST_DIRECTORY}/**/*.ts`, `${WEB_TEST_DIRECTORY}/**/*.tsx`]
  const found = new Set<string>()
  for (const pattern of patterns) {
    for (const match of globSync(pattern, { cwd: root })) found.add(match.split(sep).join('/'))
  }
  return [...found].sort()
}

/**
 * Reject a source that no face program loads and no other rule already reports.
 * @param root - Repository root.
 * @param clientFiles - Sources the Client program loads.
 * @param hostFiles - Sources the Host program loads.
 * @returns diagnostics for unregistered sources.
 */
function unregisteredViolations(
  root: string,
  clientFiles: ReadonlySet<string>,
  hostFiles: ReadonlySet<string>,
): string[] {
  return webTestSources(root)
    .filter(file => !clientFiles.has(file) && !hostFiles.has(file))
    .map(file => `${file}: no compiler face loads this file; a Host-plane file needs both an ${CLIENT_CONFIG} "${CLIENT_ENTRY_KEY}" entry and a ${HOST_CONFIG} "${HOST_ENTRY_KEY}" entry`)
}

/**
 * Reject relative imports that leave a face for a source only the other face loads.
 * @param root - Repository root.
 * @param configPath - Repo-relative config owning the importing face.
 * @param face - The importing face.
 * @param forbidden - Sources the other face owns exclusively.
 * @returns diagnostics for every crossing import.
 */
function importViolations(
  root: string,
  configPath: string,
  face: CompilerFace,
  forbidden: ReadonlySet<string>,
): string[] {
  const violations: string[] = []
  for (const file of face.files) {
    const absPath = resolve(root, file)
    for (const specifier of relativeImportSpecifiers(absPath)) {
      const resolved = resolveRelativeImport(absPath, specifier, face.options)
      if (resolved === undefined) continue
      const target = repoRelative(root, resolved)
      if (!forbidden.has(target)) continue
      violations.push(`${file}: ${configPath} loads this file, but it imports ${target}, which only the other face loads; register ${file} with the face that owns ${target}`)
    }
  }
  return violations
}

/**
 * Collect the relative import specifiers one module declares.
 * @param absPath - Absolute module path.
 * @returns relative specifiers in source order.
 */
function relativeImportSpecifiers(absPath: string): string[] {
  if (!existsSync(absPath)) return []
  const source = readFileSync(absPath, 'utf8')
  return ts.preProcessFile(source, true, false).importedFiles
    .map(imported => imported.fileName)
    .filter(fileName => fileName.startsWith('.'))
}

/**
 * Resolve one relative specifier, falling back to the file-system conventions the
 * repository writes relative imports with (an explicit `.ts` extension, then the
 * usual index files) when the face's module resolution declines it.
 * @param fromAbs - Absolute importing module path.
 * @param specifier - Relative specifier as written in source.
 * @param options - Compiler options the owning face resolves with.
 * @returns the absolute target path, or undefined when nothing matches.
 */
function resolveRelativeImport(fromAbs: string, specifier: string, options: ts.CompilerOptions): string | undefined {
  const resolved = ts.resolveModuleName(specifier, fromAbs, options, ts.sys).resolvedModule?.resolvedFileName
  if (resolved !== undefined) return resolved
  const target = resolve(dirname(fromAbs), specifier)
  for (const candidate of [target, `${target}.ts`, `${target}.tsx`, resolve(target, 'index.ts')]) {
    if (ts.sys.fileExists(candidate)) return candidate
  }
  return undefined
}

/**
 * Reject literal registration entries that name no file.
 * @param root - Repository root.
 * @param configPath - Repo-relative config owning the entries.
 * @param raw - Raw configuration object.
 * @param key - Entry key the face registers web e2e files under.
 * @param prefix - Path prefix selecting the entries this gate owns.
 * @returns diagnostics for every dead entry.
 */
function entryViolations(
  root: string,
  configPath: string,
  raw: Readonly<Record<string, unknown>>,
  key: string,
  prefix: string,
): string[] {
  const configDir = dirname(resolve(root, configPath))
  return literalEntries(raw, key)
    .filter(entry => entry.startsWith(prefix))
    .filter(entry => !existsSync(resolve(configDir, entry)))
    .map(entry => `${configPath}: ${key} entry ${JSON.stringify(entry)} names no file`)
}

/**
 * Read the literal (wildcard-free) string entries of one configuration key.
 * @param raw - Raw configuration object.
 * @param key - Configuration key to read.
 * @returns the trimmed literal entries.
 */
function literalEntries(raw: Readonly<Record<string, unknown>>, key: string): string[] {
  const value = raw[key]
  const entries = typeof value === 'string' ? [value] : Array.isArray(value) ? value : []
  return entries.filter((entry): entry is string => typeof entry === 'string' && !entry.includes('*'))
}

/**
 * Render an absolute path as a repo-relative POSIX path.
 * @param root - Repository root.
 * @param path - Absolute path.
 * @returns the repo-relative path.
 */
function repoRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}

if (import.meta.main) {
  const root = resolve(import.meta.dirname, '..')
  const violations = collectWebTestFaceViolations(root)
  if (violations.length === 0) {
    console.log(`verify-web-test-faces: ${String(webTestSources(root).length)} source(s) checked, every web e2e file is registered with one face.`)
    process.exit(0)
  }
  console.error('verify-web-test-faces: the web e2e compiler-face registration is inconsistent:')
  for (const violation of violations) console.error(`  ${violation}`)
  process.exit(1)
}
