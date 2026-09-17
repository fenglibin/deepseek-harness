// @vitest-environment jsdom

/**
 * The delivery card rendered from a scripted form face: the Help link reaches
 * the reference dialog, and every field carries its own explanation.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { DeliveryCard, type DeliveryCardProps } from '../src/client/DeliveryCard.tsx'
import { DELIVERY_FIELDS, type DeliveryCardState } from '../src/client/delivery-card-controller.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

/** A field state every control can render. */
const field = { text: '', overridden: false, invalid: false }

/** The card face a registration injects, collapsed to scripted field states. */
function face(): { state: DeliveryCardState; edit: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn>; discard: ReturnType<typeof vi.fn>; resetField: ReturnType<typeof vi.fn>; toggleVerificationCommand: ReturnType<typeof vi.fn>; moveVerificationCommand: ReturnType<typeof vi.fn> } {
  const state: DeliveryCardState = {
    available: true,
    writable: true,
    dirty: false,
    invalid: false,
    saving: false,
    failed: false,
    enforcement: field,
    enabled: field,
    autoDetect: field,
    requireOpenspecForBugs: field,
    maxReviewRounds: field,
    designTodoCount: field,
    designFiles: field,
    specTodoCount: field,
    specChars: field,
    gradingPrompt: field,
    verificationCommands: field,
    verificationSelected: [],
    verificationCandidates: [],
    verificationMissing: [],
  }
  return {
    state,
    edit: vi.fn(),
    save: vi.fn(),
    discard: vi.fn(),
    resetField: vi.fn(),
    toggleVerificationCommand: vi.fn(),
    moveVerificationCommand: vi.fn(),
  }
}

/** Render the card with a scripted face and an open disclosure. */
function renderCard(
  patch: Partial<DeliveryCardState> = {},
  toggle: ReturnType<typeof vi.fn> = vi.fn(),
  move: ReturnType<typeof vi.fn> = vi.fn(),
) {
  const scripted = face()
  Object.assign(scripted.state, patch)
  const store = createSnapshotStore(scripted.state)
  // The spec scripts only the card's own face; the renderer-bound runtime props
  // are absent, so the object is asserted as a whole instead of spread as never.
  const props = {
    t: (key: keyof typeof zh) => zh[key],
    useDeliveryCard: (select: (value: DeliveryCardState) => unknown) => select(store.getSnapshot()),
    edit: scripted.edit,
    save: scripted.save,
    discard: scripted.discard,
    resetField: scripted.resetField,
    toggleVerificationCommand: toggle,
    moveVerificationCommand: move,
  } as unknown as DeliveryCardProps
  const view = render(<DeliveryCard {...props} />)
  // The card body renders only once the disclosure is open.
  fireEvent.click(screen.getByRole('button', { name: /交付纪律/ }))
  return { ...scripted, view }
}

describe('DeliveryCard', () => {
  it('opens the help reference from the Help link', () => {
    renderCard()
    fireEvent.click(screen.getByText(zh.deliveryHelpLink))
    expect(screen.getByText(zh.deliveryHelpTiersHeading)).toBeDefined()
    expect(screen.getByText(zh.deliveryHelpVerifyHeading)).toBeDefined()
  })

  it('gives every configured field its own question mark', () => {
    renderCard()
    const ids = [
      'enforcement', 'enabled', 'auto-detect', 'bugs', 'review-rounds',
      'design-todos', 'design-files', 'spec-todos', 'spec-chars', 'grading-prompt',
      'verification',
    ]
    for (const id of ids) {
      const mark = screen.getByTestId(`field-help-plugin-config-delivery-${id}`)
      // The mark must carry real copy, not an empty placeholder.
      expect((mark.getAttribute('aria-label') ?? '').length).toBeGreaterThan(20)
    }
  })

  it('stages an edit from a control', () => {
    const scripted = renderCard()
    fireEvent.change(screen.getByLabelText(zh.deliveryEnforcement), { target: { value: 'advisory' } })
    expect(scripted.edit).toHaveBeenCalledWith(DELIVERY_FIELDS.enforcement, 'advisory')
  })
})

describe('DeliveryCard chrome and layout', () => {
  it('renders no stray character after the card', () => {
    // 卡片曾把 JSX 之外的一个 `)` 当作文本节点渲染到表单下方。断言必须覆盖整个
    // 渲染容器：游离文本落在卡片元素之外，只看卡片内部不会发现它。
    const { view } = renderCard()
    expect(view.container.textContent ?? '').not.toContain(')')
  })

  it('puts the Help link on the same line as the card description', () => {
    renderCard()
    const description = screen.getByText(zh.deliveryDescription)
    const link = screen.getByText(zh.deliveryHelpLink)
    // 同一条 subline 内相邻，而不是各占一行。
    expect(description.parentElement).toBe(link.parentElement)
    expect(description.parentElement?.className).toMatch(/subline/)
  })

  it('places short controls in the two-column grid and wide controls across it', () => {
    renderCard()
    const grid = screen.getByLabelText(zh.deliveryEnforcement).closest('div[class*="grid"]')
    expect(grid).toBeTruthy()
    const promptField = screen.getByTestId('field-help-plugin-config-delivery-grading-prompt')
    expect(promptField.closest('div[class*="wide"]')).toBeTruthy()
  })
})

describe('DeliveryCard acceptance commands', () => {
  const CANDIDATES = [
    { name: 'smoke', title: '冒烟测试' },
    { name: 'docs' },
  ]

  it('offers only the unselected commands as candidates', () => {
    renderCard({ verificationCandidates: [CANDIDATES[1]!], verificationSelected: ['smoke'] })
    // The selected command lives in the ordered list, not among the candidates:
    // offering it again would let one command be added twice.
    expect(screen.queryByRole('checkbox', { name: /\/smoke/ })).toBeNull()
    expect(screen.getByRole('checkbox', { name: /\/docs/ })).toBeTruthy()
  })

  it('stages a selection through the face action', () => {
    const toggle = vi.fn()
    renderCard({ verificationCandidates: CANDIDATES }, toggle)
    fireEvent.click(screen.getByRole('checkbox', { name: /\/docs/ }))
    expect(toggle).toHaveBeenCalledWith('docs')
  })

  it('renders the selected commands in order with their position', () => {
    renderCard({
      verificationCandidates: [],
      verificationSelected: ['docs', 'smoke'],
      verificationCommands: { text: 'docs\nsmoke', overridden: true, invalid: false },
    })
    const list = screen.getByTestId('delivery-verification-selected')
    const names = [...list.querySelectorAll('li')].map(row => row.textContent ?? '')
    // Array order is the execution order the gate enforces, so the rendered
    // order has to match it rather than any alphabetical or configuration order.
    expect(names[0]).toContain('/docs')
    expect(names[1]).toContain('/smoke')
  })

  it('moves a command with the keyboard-reachable buttons', () => {
    const move = vi.fn()
    renderCard({
      verificationCandidates: [],
      verificationSelected: ['docs', 'smoke'],
      verificationCommands: { text: 'docs\nsmoke', overridden: true, invalid: false },
    }, vi.fn(), move)
    fireEvent.click(screen.getByRole('button', { name: `${zh.deliveryVerificationMoveUp}: /smoke` }))
    expect(move).toHaveBeenCalledWith('smoke', 0)
  })

  it('disables the upward move on the first command', () => {
    renderCard({
      verificationCandidates: [],
      verificationSelected: ['docs', 'smoke'],
      verificationCommands: { text: 'docs\nsmoke', overridden: true, invalid: false },
    })
    expect(screen.getByRole('button', { name: `${zh.deliveryVerificationMoveUp}: /docs` }))
      .toHaveProperty('disabled', true)
  })

  it('removes a selected command through its own control', () => {
    const toggle = vi.fn()
    renderCard({
      verificationCandidates: [],
      verificationSelected: ['docs'],
      verificationCommands: { text: 'docs', overridden: true, invalid: false },
    }, toggle)
    fireEvent.click(screen.getByRole('button', { name: `${zh.deliveryVerificationRemove}: /docs` }))
    expect(toggle).toHaveBeenCalledWith('docs')
  })

  it('guides the user to the prompt-command page when nothing is configured', () => {
    renderCard()
    expect(screen.getByText(zh.deliveryVerificationEmpty)).toBeTruthy()
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it('keeps a selection whose command disappeared, so it stays removable', () => {
    renderCard({
      verificationCandidates: CANDIDATES,
      verificationSelected: ['gone'],
      verificationCommands: { text: 'gone', overridden: true, invalid: false },
      verificationMissing: ['gone'],
    })
    const list = screen.getByTestId('delivery-verification-selected')
    expect(list.textContent ?? '').toContain('/gone')
    expect(screen.getByText(zh.deliveryVerificationMissing)).toBeTruthy()
    // Still removable even though the prompt-command page no longer offers it.
    expect(screen.getByRole('button', { name: `${zh.deliveryVerificationRemove}: /gone` })).toBeTruthy()
  })

  it('disables the checkboxes on a read-only document', () => {
    renderCard({ writable: false, verificationCandidates: CANDIDATES })
    expect(screen.getByRole('checkbox', { name: /\/smoke/ })).toHaveProperty('disabled', true)
  })

  it('disables reordering on a read-only document', () => {
    renderCard({
      writable: false,
      verificationCandidates: [],
      verificationSelected: ['docs', 'smoke'],
      verificationCommands: { text: 'docs\nsmoke', overridden: true, invalid: false },
    })
    expect(screen.getByRole('button', { name: `${zh.deliveryVerificationMoveDown}: /docs` }))
      .toHaveProperty('disabled', true)
  })
})
