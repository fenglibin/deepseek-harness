/**
 * 校验没有任何包自建 undici agent，或给 `fetch` 传入显式的 dispatcher。
 *
 * Node 内置的 `fetch` 走的是 undici 的全局 dispatcher，而 `@deepseek-ai/dsh-http-proxy` 会在启动时
 * 安装它。显式给出的 `dispatcher` 会覆盖那个全局的，因此一个自己构造 `new Agent(...)` 的调用点
 * 无论用户配置了什么代理都会直连——正是 `web-fetch-http` 在代理支持出现之前所携带的缺陷：
 * 它的 DNS 钉扎 agent 静默绕过了每一个代理。
 *
 * 该包的 `proxyRouteFor(url)` 是询问「这一次请求发往何处」并取回该答案所假定传输的受认可方式。
 * 一个确实自有传输的调用点——因为它携带进程级 dispatcher 无法承载的按请求状态，正如
 * `web-fetch-http` 的地址钉扎那样——用下面的标记说明。
 *
 * 发现过程是语法感知的，正如 `scripts/AGENTS.md` 所要求：逐行正则既会漏掉 `{ dispatcher }` 简写，
 * 也会漏掉导入把 `Agent` 改名的 `new Alias(...)`，而两者与写全的形式一样会绕过代理。
 * 来自动态 `await import('undici')` 的绑定与静态绑定同等对待——本仓库在所有必须让传输留在
 * 浏览器 worker 启动图之外的地方，都是这样加载 undici 的。
 */

import { globSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')

/** 拥有 dispatcher 构造的包；它自己的 agent 就是实现本身。 */
export const DISPATCHER_OWNER = 'packages/util/http-proxy/'

/**
 * 带有此标记的注释说明该构造或选项为何被豁免。它在该违规行本身或其**正上一行**上生效，
 * 因为语法感知的匹配锚定在属性或 `new` 表达式上，而不是整条语句，而解释应当放在长行上方。
 */
export const ALLOW_MARKER = 'proxy-exempt:'

/** 一旦构造即选定传输的 undici agent 类，无论本地名是什么。 */
const AGENT_EXPORTS = new Set(['Agent', 'ProxyAgent', 'EnvHttpProxyAgent'])

/** 这些类必须来自的模块；别处同名的类并不选定任何传输。 */
const AGENT_MODULE = 'undici'

/** 覆盖全局 dispatcher 的请求选项，无论怎么写。 */
const DISPATCHER_PROPERTY = 'dispatcher'

/** 一个会绕过已配置代理的源码位置。 */
export interface DispatcherViolation {
  /** 仓库相对路径，使用 POSIX 分隔符。 */
  readonly file: string
  /** 从 1 开始的行号。 */
  readonly line: number
  /** 该位置违反了哪条规则。 */
  readonly what: string
  /** 违规的源码文本，已去除首尾空白。 */
  readonly text: string
}

/**
 * 判断一个表达式是否为 `import('undici')`，带或不带 `await`。动态形式是本仓库在所有必须让
 * 传输留在浏览器 worker 启动图之外的地方加载 undici 的方式，因此对之视而不见的门禁会漏掉
 * 本仓库自己的惯用法。
 *
 * @param expression - 变量声明的初始化式（若存在）。
 * @returns 求值它是否得到 undici 模块。
 */
function isUndiciImport(expression: ts.Expression | undefined): boolean {
  if (expression === undefined) return false
  const call = ts.isAwaitExpression(expression) ? expression.expression : expression
  if (!ts.isCallExpression(call) || call.expression.kind !== ts.SyntaxKind.ImportKeyword) return false
  const [specifier] = call.arguments
  return specifier !== undefined && ts.isStringLiteral(specifier) && specifier.text === AGENT_MODULE
}

/**
 * 记录一次解构式动态导入把哪些名字绑定到了 agent 类。
 *
 * @param pattern - `const { Agent, ProxyAgent: P } = await import('undici')` 的绑定模式。
 * @param agents - 本地名加入的收集器。
 */
function collectDestructuredAgents(pattern: ts.ObjectBindingPattern, agents: Set<string>): void {
  for (const element of pattern.elements) {
    if (!ts.isIdentifier(element.name)) continue
    const property = element.propertyName
    const imported = property === undefined
      ? element.name.text
      : ts.isIdentifier(property) || ts.isStringLiteral(property) ? property.text : undefined
    if (imported !== undefined && AGENT_EXPORTS.has(imported)) agents.add(element.name.text)
  }
}

/**
 * 本文件中绑定到 undici agent 类的本地名，包括 `import { Agent as X }` 改名、动态
 * `import('undici')` 的解构与命名空间形式，以及命名空间导入自身的名字，从而使
 * `undici.Agent` 也能被识别。
 *
 * @param source - 已解析的文件。
 * @returns 本文件中绑定的 agent 标识符与命名空间标识符。
 */
function agentBindings(source: ts.SourceFile): { agents: Set<string>; namespaces: Set<string> } {
  const agents = new Set<string>()
  const namespaces = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === AGENT_MODULE) {
        const bindings = node.importClause?.namedBindings
        if (bindings !== undefined && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text)
        else if (bindings !== undefined) {
          for (const element of bindings.elements) {
            const imported = (element.propertyName ?? element.name).text
            if (AGENT_EXPORTS.has(imported)) agents.add(element.name.text)
          }
        }
      }
    } else if (ts.isVariableDeclaration(node) && isUndiciImport(node.initializer)) {
      if (ts.isIdentifier(node.name)) namespaces.add(node.name.text)
      else if (ts.isObjectBindingPattern(node.name)) collectDestructuredAgents(node.name, agents)
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(source, visit)
  return { agents, namespaces }
}

/**
 * 判断一个表达式是否命名了 undici agent 类：一个已绑定的标识符，或一次 `<namespace>.Agent`
 * 属性访问。
 *
 * @param expression - `new` 表达式的被调用者。
 * @param bound - 本文件绑定到 agent 类或命名空间的标识符。
 * @returns 构造它是否选定传输。
 */
function namesAgent(expression: ts.Expression, bound: ReturnType<typeof agentBindings>): boolean {
  if (ts.isIdentifier(expression)) return bound.agents.has(expression.text)
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    return bound.namespaces.has(expression.expression.text) && AGENT_EXPORTS.has(expression.name.text)
  }
  return false
}

/**
 * 判断一个对象字面量成员是否提供了 `dispatcher`，覆盖 `dispatcher: x`、`{ dispatcher }` 简写
 * 与 `{ 'dispatcher': x }`。
 *
 * @param member - 一个对象字面量元素。
 * @returns 该成员是否命名了 dispatcher 选项。
 */
function suppliesDispatcher(member: ts.ObjectLiteralElementLike): boolean {
  if (ts.isShorthandPropertyAssignment(member)) return member.name.text === DISPATCHER_PROPERTY
  if (!ts.isPropertyAssignment(member)) return false
  const name = member.name
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text === DISPATCHER_PROPERTY
  return false
}

/**
 * 找出一个源文件中所有裸 dispatcher 位置。
 *
 * @param file - 仓库相对路径，用于豁免属主包并报告位置。
 * @param sourceText - 文件内容。
 * @returns 每个违规位置一条记录，按源码顺序。
 */
export function findDispatcherViolations(file: string, sourceText: string): DispatcherViolation[] {
  const posix = file.replaceAll('\\', '/')
  if (posix.startsWith(DISPATCHER_OWNER)) return []
  // 两种违规都在源码里点名这两个词之一：agent 构造需要来自 undici 模块的绑定，而该选项是一个
  // 名为 `dispatcher` 的属性。此前照旧解析仓库其余部分使本门禁成为最慢的一个——1597 个文件中
  // 只有 21 个能通过该过滤。
  if (!sourceText.includes(AGENT_MODULE) && !sourceText.includes(DISPATCHER_PROPERTY)) return []
  const source = ts.createSourceFile(posix, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const bound = agentBindings(source)
  const lines = sourceText.split('\n')
  const violations: DispatcherViolation[] = []

  const record = (node: ts.Node, what: string): void => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line
    const exempt = [lines[line], lines[line - 1]].some(text => text?.includes(ALLOW_MARKER) === true)
    if (exempt) return
    violations.push({ file: posix, line: line + 1, what, text: (lines[line] ?? '').trim() })
  }

  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && namesAgent(node.expression, bound)) {
      record(node, 'constructs an undici agent')
    }
    if (ts.isObjectLiteralExpression(node) && node.properties.some(suppliesDispatcher)) {
      record(node.properties.find(suppliesDispatcher) as ts.Node, 'passes an explicit `dispatcher`')
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(source, visit)
  return violations
}

/**
 * 扫描仓库中每个包与应用的源文件。
 *
 * @returns 找到的每一条违规，按扫描顺序。
 * @throws 当语料为空时抛错，否则门禁会因什么都没扫描而通过。
 */
export function scanRepository(): DispatcherViolation[] {
  const files = [
    ...globSync('packages/*/*/src/**/*.ts', { cwd: root }),
    ...globSync('apps/*/src/**/*.ts', { cwd: root }),
  ]
  if (files.length === 0) throw new Error('verify-no-bare-dispatcher: scanned an empty corpus; the globs no longer match.')
  return files.flatMap(file => findDispatcherViolations(file, readFileSync(resolve(root, file), 'utf8')))
}

function main(): void {
  const violations = scanRepository()
  if (violations.length === 0) {
    console.log(`verify-no-bare-dispatcher: no bare dispatcher outside ${DISPATCHER_OWNER}.`)
    return
  }
  console.error('verify-no-bare-dispatcher: a dispatcher built outside @deepseek-ai/dsh-http-proxy bypasses the configured proxy.\n')
  for (const violation of violations) {
    console.error(`  ${relative('.', violation.file)}:${String(violation.line)} ${violation.what}`)
    console.error(`    ${violation.text}`)
  }
  console.error('\nUse `proxyRouteFor(url)` from @deepseek-ai/dsh-http-proxy, or annotate the line')
  console.error(`with a \`${ALLOW_MARKER} <reason>\` comment when the request must genuinely ignore the proxy.`)
  process.exit(1)
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) main()
