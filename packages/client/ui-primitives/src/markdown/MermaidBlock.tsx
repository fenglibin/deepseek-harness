/**
 * One Mermaid diagram, rendered from a fenced ```mermaid block.
 *
 * Mermaid is a large runtime, so it is imported only once a document actually
 * carries a diagram; a message or README without one never pays for it. The
 * SVG is injected as markup because Mermaid owns that rendering, and a diagram
 * that fails to parse falls back to its source rather than taking the document
 * down with it.
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import css from './MermaidBlock.module.css'

/** One rendering attempt's outcome. */
type DiagramState =
  | { readonly status: 'pending' }
  | { readonly status: 'ready'; readonly svg: string }
  | { readonly status: 'failed'; readonly reason: string }

/** Mermaid's render entry, narrowed to what this renderer calls. */
interface MermaidModule {
  render: (id: string, text: string) => Promise<{ readonly svg: string }>
}

let loading: Promise<MermaidModule> | undefined

/**
 * Load the Mermaid runtime once per document tree.
 * @returns the module, cached for every later diagram on the page.
 */
function mermaid(): Promise<MermaidModule> {
  loading ??= import('mermaid').then(({ default: module }) => ({
    render: async (id, text) => await module.render(id, text),
  }))
  return loading
}

/**
 * Render one Mermaid diagram.
 * @param props.code - the fence's source, without its info string.
 * @param props.errorLabel - localized prefix for the fallback's reason.
 * @returns the diagram, a pending placeholder, or the source plus the failure.
 */
export function MermaidBlock({ code, errorLabel }: {
  readonly code: string
  readonly errorLabel: string
}): ReactNode {
  const [state, setState] = useState<DiagramState>({ status: 'pending' })
  useEffect(() => {
    let current = true
    void mermaid().then(
      async (module) => {
        try {
          // A unique id per attempt: Mermaid keys its internal state by it, and
          // two diagrams sharing one would render the same SVG twice.
          const { svg } = await module.render(`dsh-mermaid-${Math.random().toString(36).slice(2)}`, code)
          if (current) setState({ status: 'ready', svg })
        } catch (error) {
          if (current) setState({ status: 'failed', reason: error instanceof Error ? error.message : String(error) })
        }
      },
      (error: unknown) => {
        if (current) {
          setState({ status: 'failed', reason: error instanceof Error ? error.message : String(error) })
        }
      },
    )
    return () => { current = false }
  }, [code])

  if (state.status === 'ready') {
    return <div className={css.diagram} dangerouslySetInnerHTML={{ __html: state.svg }} />
  }
  return (
    <pre className={css.fallback}>
      <code>{state.status === 'failed' ? `${errorLabel}: ${state.reason}\n\n${code}` : code}</code>
    </pre>
  )
}
