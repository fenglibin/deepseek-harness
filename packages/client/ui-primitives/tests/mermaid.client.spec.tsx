// @vitest-environment jsdom
// The mermaid branch: a ```mermaid fence renders through the Mermaid runtime
// once a surface opts in, the runtime loads lazily, and a failure falls back
// to the source instead of taking the document down.
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownText } from './markdown-test-components.tsx'

afterEach(cleanup)

vi.mock('mermaid', () => ({
  default: { render: vi.fn() },
}))

describe('MarkdownText diagrams', () => {
  it('renders a mermaid fence as a diagram when the surface opts in', async () => {
    const { default: mermaid } = await import('mermaid')
    const renderMock = mermaid.render as ReturnType<typeof vi.fn>
    renderMock.mockResolvedValue({ svg: '<svg><text>flow</text></svg>' })

    const { container } = render(<MarkdownText
      text={'```mermaid\ngraph LR; A-->B\n```'}
      diagrams={{ errorLabel: 'bad diagram' }}
    />)

    expect(await screen.findByText('flow')).toBeTruthy()
    expect(renderMock).toHaveBeenCalledOnce()
    expect(renderMock.mock.calls[0]?.[1]).toBe('graph LR; A-->B')
    // The injected markup is not escaped into text.
    expect(container.querySelector('svg')).toBeTruthy()
  })

  it('falls back to the fence source when mermaid rejects it', async () => {
    const { default: mermaid } = await import('mermaid')
    const renderMock = mermaid.render as ReturnType<typeof vi.fn>
    renderMock.mockRejectedValue(new Error('syntax error'))

    render(<MarkdownText
      text={'```mermaid\nnot a diagram\n```'}
      diagrams={{ errorLabel: '这张图没能渲染出来' }}
    />)

    expect(await screen.findByText(/这张图没能渲染出来: syntax error/)).toBeTruthy()
    expect(screen.getByText(/not a diagram/)).toBeTruthy()
  })
})
