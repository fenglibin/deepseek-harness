// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '../src/client/locale.ts'
import { AssistantMarkdown, type AssistantMarkdownProps } from '../src/client/chat/AssistantMarkdown.tsx'

let nextAnimationFrameId = 1
let animationFrames = new Map<number, FrameRequestCallback>()

function flushAnimationFrames(count: number): void {
  for (let index = 0; index < count; index += 1) {
    const callbacks = [...animationFrames.values()]
    animationFrames.clear()
    for (const callback of callbacks) callback(index)
  }
}

beforeEach(() => {
  nextAnimationFrameId = 1
  animationFrames = new Map()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextAnimationFrameId
    nextAnimationFrameId += 1
    animationFrames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    animationFrames.delete(id)
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const t = makeTranslate(zh, commonZh)
const renderMessageImages: AssistantMarkdownProps['renderMessageImages'] = () => null

describe('ReasoningRow', () => {
  it('follows the latest streaming line, scrolls to its end, then restores the settled first line', () => {
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nNewest reasoning tokens' }]}
        streaming
        renderMessageImages={renderMessageImages}
      />,
    )
    expect(view.getByText('运行中')).toBeTruthy()
    // A streaming block now opens on the reasoning itself; fold it to read the
    // one-line summary that follows the tail.
    fireEvent.click(view.getByText('思考'))
    const summary = view.getByText('Newest reasoning tokens')
    Object.defineProperties(summary, {
      scrollWidth: { configurable: true, value: 300 },
      clientWidth: { configurable: true, value: 100 },
    })

    view.rerender(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nNewest reasoning tokens keep arriving' }]}
        streaming
        renderMessageImages={renderMessageImages}
      />,
    )
    expect(summary.scrollLeft).toBe(0)
    flushAnimationFrames(2)
    expect(summary.scrollLeft).toBe(0)
    flushAnimationFrames(1)
    expect(summary.scrollLeft).toBe(200)
    expect(summary.getAttribute('data-follow-end')).toBe('true')

    view.rerender(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nNewest reasoning tokens keep arriving\n' }]}
        streaming={false}
        renderMessageImages={renderMessageImages}
      />,
    )
    flushAnimationFrames(3)
    expect(view.getByText('Inspect the session')).toBeTruthy()
    expect(view.queryByText('运行中')).toBeNull()
    expect(summary.scrollLeft).toBe(0)
    expect(summary.hasAttribute('data-follow-end')).toBe(false)
  })

  it('opens on the reasoning while streaming and folds away once it settles', () => {
    const blocks = [{ kind: 'reasoning' as const, text: 'First thought\nSecond thought' }]
    const view = render(
      <AssistantMarkdown t={t} blocks={blocks} streaming renderMessageImages={renderMessageImages} />,
    )
    const row = view.getByRole('button')
    // Streaming shows the process rather than only its tail line.
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(view.container.querySelector('[class*="thinkBody"]')).not.toBeNull()

    view.rerender(
      <AssistantMarkdown t={t} blocks={blocks} streaming={false} renderMessageImages={renderMessageImages} />,
    )
    // Settling folds it away with no click.
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(view.container.querySelector('[class*="thinkBody"]')).toBeNull()
  })

  it('opens only the streaming block when one turn carries several', () => {
    const blocks = [
      { kind: 'reasoning' as const, text: 'first thought' },
      { kind: 'reasoning' as const, text: 'second thought still arriving' },
    ]
    const view = render(
      <AssistantMarkdown t={t} blocks={blocks} streaming renderMessageImages={renderMessageImages} />,
    )
    // Only the last block is the streaming tail, so an earlier thought in the
    // same turn must not pop open behind it.
    const rows = view.container.querySelectorAll('[data-disclosure-row]')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.getAttribute('aria-expanded')).toBe('false')
    expect(rows[1]?.getAttribute('aria-expanded')).toBe('true')
  })

  it('stops following the tail once the reader scrolls up', () => {
    const blocks = (text: string) => [{ kind: 'reasoning' as const, text }]
    const view = render(
      <AssistantMarkdown t={t} blocks={blocks('first\nsecond')} streaming renderMessageImages={renderMessageImages} />,
    )
    const body = view.container.querySelector<HTMLElement>('[class*="thinkBody"]')!
    Object.defineProperties(body, {
      scrollHeight: { configurable: true, value: 400 },
      clientHeight: { configurable: true, value: 100 },
      scrollTop: { configurable: true, writable: true, value: 300 },
    })
    // Scrolling up to re-read releases the tail...
    body.scrollTop = 0
    fireEvent.scroll(body)
    // ...so a later chunk leaves the reader where they are instead of yanking
    // them back down mid-sentence. (Reopening re-takes the follow, but that
    // needs a laid-out element — jsdom gives new nodes no scroll geometry.)
    view.rerender(
      <AssistantMarkdown t={t} blocks={blocks('first\nsecond\nthird')} streaming renderMessageImages={renderMessageImages} />,
    )
    expect(body.scrollTop).toBe(0)
  })

  it('follows the tail to the newest line while streaming', () => {
    const blocks = (text: string) => [{ kind: 'reasoning' as const, text }]
    const view = render(
      <AssistantMarkdown t={t} blocks={blocks('first\nsecond')} streaming renderMessageImages={renderMessageImages} />,
    )
    const body = view.container.querySelector<HTMLElement>('[class*="thinkBody"]')!
    Object.defineProperties(body, {
      scrollHeight: { configurable: true, value: 400 },
      clientHeight: { configurable: true, value: 100 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    })
    view.rerender(
      <AssistantMarkdown t={t} blocks={blocks('first\nsecond\nthird')} streaming renderMessageImages={renderMessageImages} />,
    )
    // The open block keeps its newest line in view as chunks arrive.
    expect(body.scrollTop).toBe(400)
  })

  it('keeps a settled block collapsed and leaves a reopened one open', () => {
    const blocks = [{ kind: 'reasoning' as const, text: 'First thought\nSecond thought' }]
    const view = render(
      <AssistantMarkdown t={t} blocks={blocks} streaming={false} renderMessageImages={renderMessageImages} />,
    )
    const row = view.getByRole('button')
    // A block that mounts settled — every replayed history message — never
    // flashes open.
    expect(row.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(view.getByText('思考'))
    expect(row.getAttribute('aria-expanded')).toBe('true')
    // The auto-fold fires on the streaming -> settled transition only, so a
    // finished thought the reader reopened stays open across re-renders.
    view.rerender(
      <AssistantMarkdown t={t} blocks={blocks} streaming={false} renderMessageImages={renderMessageImages} />,
    )
    expect(row.getAttribute('aria-expanded')).toBe('true')
  })

  it('expands from either Think or the reasoning summary', () => {
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nCheck persistence' }]}
        streaming={false}
        renderMessageImages={renderMessageImages}
      />,
    )
    const row = view.getByRole('button')

    fireEvent.click(view.getByText('Inspect the session'))
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(view.getByText(/Check persistence/)).toBeTruthy()

    fireEvent.click(view.getByText('思考'))
    expect(row.getAttribute('aria-expanded')).toBe('false')
  })

  it('expanded Think drops the inline summary and renders plain prose, no IN card', () => {
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nCheck persistence' }]}
        streaming={false}
        renderMessageImages={renderMessageImages}
      />,
    )
    fireEvent.click(view.getByText('思考'))
    expect(view.getAllByText(/Inspect the session/)).toHaveLength(1)
    expect(view.queryByText('IN')).toBeNull()
    expect(view.container.querySelector('[class*="ioCard"]')).toBeNull()
    expect(view.container.querySelector('[class*="thinkBody"]')).not.toBeNull()
  })
})
