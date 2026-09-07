// @vitest-environment jsdom
/** `mcp.json` editor: formatting, in-place validation, the save gate, and the
 * highlight layer rendering as a plain `<div>` (not `<pre>`, whose trailing
 * newline row would drift the caret). */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpJsonEditor } from '../src/client/McpJsonEditor.tsx'
import type { McpKey } from '../src/client/locales.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t: (key: McpKey) => string = key => zh[key]

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
    // A `<pre>` would surface a trailing newline row the textarea never
    // reserves, drifting the caret one row up near the document end.
    const highlight = screen.getByTestId('mcp-json-highlight')
    expect(highlight.tagName).toBe('DIV')
  })

  it('updates the draft and highlight when the user types', () => {
    renderEditor({ text: '{"mcpServers":{}}' })
    const textarea = screen.getByRole<HTMLTextAreaElement>('textbox')
    fireEvent.change(textarea, { target: { value: '{"mcpServers":{"a":{}}}' } })
    expect(textarea.value).toBe('{"mcpServers":{"a":{}}}')
    const highlight = screen.getByTestId('mcp-json-highlight')
    expect(highlight.textContent).toBe('{"mcpServers":{"a":{}}}')
  })
})
