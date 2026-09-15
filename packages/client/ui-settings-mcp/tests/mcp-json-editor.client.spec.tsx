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

  it('uses the default title when none is provided', () => {
    renderEditor()
    expect(screen.getByRole('heading', { name: '编辑 mcp.json' })).toBeTruthy()
  })

  it('renders a custom title when one is provided', () => {
    render(
      <McpJsonEditor
        text="{}"
        opening={false}
        error={null}
        onSave={() => {}}
        onClose={() => {}}
        title="增加 MCP 服务器"
        t={t}
      />,
    )
    expect(screen.getByRole('heading', { name: '增加 MCP 服务器' })).toBeTruthy()
  })
})

describe('editor help', () => {
  it('shows a hint above the editor and opens the help dialog from its link', () => {
    renderEditor()
    // The hint is on screen without any interaction: a user who has never
    // written an entry should not have to find the help link first.
    expect(screen.getByText(zh.editorHint)).toBeDefined()
    expect(screen.queryByText(zh.helpTitle)).toBeNull()
    const link = screen.getByRole('button', { name: zh.help })
    // The link continues the hint rather than sitting under it: one sentence,
    // one line, so the reference reads as part of the guidance.
    const hint = screen.getByText(zh.editorHint)
    expect(hint.parentElement).toBe(link.parentElement)
    expect(hint.parentElement?.tagName).toBe('P')
    fireEvent.click(link)
    expect(screen.getByText(zh.helpTitle)).toBeDefined()
  })

  it('carries the format examples and the OAuth steps', () => {
    renderEditor()
    fireEvent.click(screen.getByRole('button', { name: zh.help }))
    // The three answers a user comes here for: how to write a server, how to
    // write an OAuth one, and which fields are optional.
    expect(screen.getByText(zh.helpBasicStdioNote)).toBeDefined()
    expect(screen.getByText(zh.helpOAuthNote)).toBeDefined()
    expect(screen.getByText(zh.helpOAuthSteps)).toBeDefined()
    expect(screen.getByText(zh.helpOptionalNote)).toBeDefined()
    // The two transports share one heading and are told apart by label, so the
    // heading is stated once rather than repeated per example.
    expect(screen.getAllByText(zh.helpBasicHeading)).toHaveLength(1)
    expect(screen.getByText(zh.helpBasicStdioLabel)).toBeDefined()
    expect(screen.getByText(zh.helpBasicHttpLabel)).toBeDefined()
    // The examples must be present verbatim so they can be pasted as-is. They
    // are matched through the document text because a multi-line `pre` is
    // normalized by the text matcher rather than compared literally.
    const shown = document.body.textContent ?? ''
    expect(shown).toContain(zh.helpOAuthExample)
    expect(shown).toContain(zh.helpBasicStdioExample)
    expect(shown).toContain(zh.helpBasicHttpExample)
    expect(shown).toContain(zh.helpOptionalExample)
  })

  it('closes the help dialog without touching the editor draft', () => {
    renderEditor()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '{"a":{"command":"echo"}}' } })
    fireEvent.click(screen.getByRole('button', { name: zh.help }))
    expect(screen.getByText(zh.helpTitle)).toBeDefined()
    // The help dialog's own Close: the editor dialog must stay open with the
    // user's draft intact.
    const closeButtons = screen.getAllByRole('button', { name: zh.close })
    fireEvent.click(closeButtons[closeButtons.length - 1]!)
    expect(screen.queryByText(zh.helpTitle)).toBeNull()
    expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe('{"a":{"command":"echo"}}')
  })
})
