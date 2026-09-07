// @vitest-environment jsdom
/** `mcp.json` editor: formatting, in-place validation, the save gate, and the
 * caret-stays-aligned guarantees the highlight layer depends on (a `<div>`
 * instead of `<pre>`, a trailing newline sentinel, and a ResizeObserver that
 * keeps the highlight's height pinned to the textarea's). */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { McpJsonEditor } from '../src/client/McpJsonEditor.tsx'
import type { McpKey } from '../src/client/locales.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t: (key: McpKey) => string = key => zh[key]

/** A `ResizeObserver` shim that exposes a single `fire` hook so a test can
 *  pin the textarea's height change to a known value and observe the highlight
 *  layer respond. jsdom has no real ResizeObserver. */
class ResizeObserverStub {
  #cb: ResizeObserverCallback
  static fire: (() => void) | null = null
  constructor(cb: ResizeObserverCallback) { this.#cb = cb }
  observe(): void { ResizeObserverStub.fire = () => { this.#cb([], this) } }
  unobserve(): void {}
  disconnect(): void { ResizeObserverStub.fire = null }
}

beforeEach(() => {
  ResizeObserverStub.fire = null
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
})

function renderEditor(props: Partial<Parameters<typeof McpJsonEditor>[0]> = {}) {
  const onSave = vi.fn()
  const onClose = vi.fn()
  render(
    <McpJsonEditor
      text={props.text ?? '{"mcpServers":{}}'}
      opening={props.opening ?? false}
      error={props.error ?? null}
      onSave={props.onSave ?? onSave}
      onClose={props.onClose ?? onClose}
      t={t}
    />,
  )
  return { onSave: props.onSave ?? onSave, onClose: props.onClose ?? onClose }
}

describe('McpJsonEditor', () => {
  it('renders the initial text in the editor', () => {
    renderEditor({ text: '{"mcpServers":{"a":{}}}' })
    expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe('{"mcpServers":{"a":{}}}')
  })

  it('formats the draft when the format action is clicked', () => {
    renderEditor({ text: '{"mcpServers":{}}' })
    fireEvent.click(screen.getByRole('button', { name: '格式化' }))
    expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe('{\n  "mcpServers": {}\n}\n')
  })

  it('refuses to save an invalid document and shows the error', () => {
    const { onSave } = renderEditor({ text: '{"mcpServers": ' })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('JSON 语法错误')
  })

  it('saves a valid document through onSave', () => {
    const { onSave } = renderEditor({ text: '{"mcpServers":{"a":{"command":"echo"}}}' })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(onSave).toHaveBeenCalledWith('{"mcpServers":{"a":{"command":"echo"}}}')
  })

  it('renders the highlight layer as a div, not a pre', () => {
    renderEditor({ text: '{"mcpServers":{}}' })
    // The textarea is the only role=textbox; the highlight must not be one.
    expect(screen.queryAllByRole('textbox')).toHaveLength(1)
    // The sentinel `<div>` carries the highlight class; `<pre>` would surface
    // a trailing newline row the textarea never reserves, drifting the caret.
    const highlight = screen.getByTestId('mcp-json-highlight')
    expect(highlight.tagName).toBe('DIV')
    expect(highlight.previousElementSibling).toBeNull()
  })

  it('appends a trailing newline sentinel when the draft has no trailing newline', () => {
    renderEditor({ text: '{"mcpServers":{}}' })
    const highlight = screen.getByTestId('mcp-json-highlight')
    // A `[data-sentinel]` span is appended so the highlight's last row aligns
    // with the textarea's reserved caret row, even when the document ends
    // without a newline.
    expect(highlight.querySelector('[data-sentinel]')).not.toBeNull()
  })

  it('omits the trailing newline sentinel when the draft already ends in one', () => {
    renderEditor({ text: '{"mcpServers":{}}\n' })
    const highlight = screen.getByTestId('mcp-json-highlight')
    // A source that already ends in `\n` has no reserved caret row to
    // compensate for, so the classifier never appends an extra sentinel.
    expect(highlight.querySelector('[data-sentinel]')).toBeNull()
  })

  it('pins the highlight height to the textarea when a resize fires', () => {
    renderEditor({ text: '{"mcpServers":{}}' })
    const textarea = screen.getByRole<HTMLTextAreaElement>('textbox')
    const highlight = screen.getByTestId('mcp-json-highlight')
    Object.defineProperty(textarea, 'clientHeight', { configurable: true, value: 480 })
    act(() => { ResizeObserverStub.fire?.() })
    expect(highlight.style.height).toBe('480px')
  })

  it('re-mirrors the textarea scroll when the caret moves via keyboard or click', () => {
    renderEditor({ text: '{"mcpServers":{"a":{}}}\n{"mcpServers":{"b":{}}}\n{"mcpServers":{"c":{}}}' })
    const textarea = screen.getByRole<HTMLTextAreaElement>('textbox')
    const highlight = screen.getByTestId('mcp-json-highlight')
    Object.defineProperty(textarea, 'scrollTop', { configurable: true, value: 80 })
    Object.defineProperty(textarea, 'scrollLeft', { configurable: true, value: 12 })
    // Wheel and scroll-bar drags land on `onScroll`; arrow keys / clicks land
    // on `onKeyUp` / `onClick`. All three must drive the mirror so the caret
    // stays aligned with the colored text after a non-scrolling cursor move.
    fireEvent.click(textarea)
    expect(highlight.scrollTop).toBe(80)
    expect(highlight.scrollLeft).toBe(12)
    fireEvent.keyUp(textarea, { key: 'End' })
    expect(highlight.scrollTop).toBe(80)
    fireEvent.scroll(textarea)
    expect(highlight.scrollTop).toBe(80)
  })
})
