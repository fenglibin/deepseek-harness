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
function face(): { state: DeliveryCardState; edit: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn>; discard: ReturnType<typeof vi.fn>; resetField: ReturnType<typeof vi.fn> } {
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
    designChars: field,
    designFiles: field,
    specTodoCount: field,
    specChars: field,
    strongSignals: field,
    mediumSignals: field,
    weakSignals: field,
    postHooks: field,
  }
  return {
    state,
    edit: vi.fn(),
    save: vi.fn(),
    discard: vi.fn(),
    resetField: vi.fn(),
  }
}

/** Render the card with a scripted face and an open disclosure. */
function renderCard() {
  const scripted = face()
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
  } as unknown as DeliveryCardProps
  render(<DeliveryCard {...props} />)
  // The card body renders only once the disclosure is open.
  fireEvent.click(screen.getByRole('button', { name: /交付纪律/ }))
  return scripted
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
      'design-todos', 'design-chars', 'design-files', 'spec-todos', 'spec-chars',
      'strong-signals', 'medium-signals', 'weak-signals', 'post-hooks',
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
