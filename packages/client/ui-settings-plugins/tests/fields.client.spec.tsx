// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeliveryHelp } from '../src/client/DeliveryHelp.tsx'
import { ChoiceField, ListField, SecretField, ValueField } from '../src/client/fields.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const frame = {
  id: 'field',
  label: 'Command timeout',
  hint: 'How long one command may run.',
  overriddenLabel: 'Overridden',
  resetLabel: 'Reset to default',
  invalidLabel: 'Enter a number.',
  disabled: false,
  overridden: false,
  invalid: false,
}

describe('ValueField', () => {
  it('stages every keystroke without writing', () => {
    const onEdit = vi.fn()
    render(<ValueField {...frame} text="60000" onEdit={onEdit} onReset={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('Command timeout'), { target: { value: '9000' } })

    expect(onEdit).toHaveBeenCalledWith('9000')
  })

  it('renders the staged text it is given rather than a draft of its own', () => {
    const { rerender } = render(<ValueField {...frame} text="60000" onEdit={vi.fn()} onReset={vi.fn()} />)
    expect(screen.getByLabelText('Command timeout')).toHaveProperty('value', '60000')

    rerender(<ValueField {...frame} text="9000" onEdit={vi.fn()} onReset={vi.fn()} />)

    expect(screen.getByLabelText('Command timeout')).toHaveProperty('value', '9000')
  })

  it('offers the reset only while an override would stand', () => {
    const onReset = vi.fn()
    const { rerender } = render(<ValueField {...frame} text="9000" onEdit={vi.fn()} onReset={onReset} />)
    expect(screen.queryByRole('button', { name: 'Reset to default' })).toBeNull()

    rerender(<ValueField {...frame} overridden text="9000" onEdit={vi.fn()} onReset={onReset} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }))

    expect(screen.getByText('Overridden')).toBeTruthy()
    expect(onReset).toHaveBeenCalledOnce()
  })

  it('replaces the hint with the reason an invalid draft cannot be saved', () => {
    render(<ValueField {...frame} invalid text="soon" onEdit={vi.fn()} onReset={vi.fn()} />)

    expect(screen.getByText('Enter a number.')).toBeTruthy()
    expect(screen.queryByText('How long one command may run.')).toBeNull()
    expect(screen.getByLabelText('Command timeout').getAttribute('aria-invalid')).toBe('true')
  })

  it('hints a numeric keypad and renders a placeholder when asked', () => {
    render(
      <ValueField
        {...frame}
        numeric
        placeholder="https://api.deepseek.com"
        text=""
        onEdit={vi.fn()}
        onReset={vi.fn()}
      />,
    )
    const input = screen.getByLabelText('Command timeout')

    expect(input.getAttribute('inputmode')).toBe('numeric')
    expect(input).toHaveProperty('placeholder', 'https://api.deepseek.com')
  })

  it('disables the control and its reset while the document is read-only', () => {
    render(<ValueField {...frame} disabled overridden text="9000" onEdit={vi.fn()} onReset={vi.fn()} />)

    expect(screen.getByLabelText('Command timeout')).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Reset to default' })).toHaveProperty('disabled', true)
  })
})

describe('SecretField', () => {
  const secret = {
    id: 'key',
    label: 'API key',
    hint: 'Stored outside the settings file.',
    disabled: false,
  }

  it('stages the draft and never renders it', () => {
    const onEdit = vi.fn()
    render(
      <SecretField
        {...secret}
        text=""
        configured={false}
        stateLabel="No key is configured."
        onEdit={onEdit}
      />,
    )
    const input = screen.getByLabelText('API key')

    fireEvent.change(input, { target: { value: 'ds-secret' } })

    expect(onEdit).toHaveBeenCalledWith('ds-secret')
    expect(input).toHaveProperty('type', 'password')
  })

  it('reports the configured state the Host holds', () => {
    const { rerender } = render(
      <SecretField
        {...secret}
        text=""
        configured={false}
        stateLabel="No key is configured."
        onEdit={vi.fn()}
      />,
    )
    expect(screen.getByText('No key is configured.')).toBeTruthy()

    rerender(
      <SecretField
        {...secret}
        text="ds-secret"
        configured
        stateLabel="A key is configured."
        onEdit={vi.fn()}
      />,
    )

    expect(screen.getByText('A key is configured.')).toBeTruthy()
    expect(screen.getByLabelText('API key')).toHaveProperty('value', 'ds-secret')
  })

  it('disables the control when it is told to', () => {
    render(
      <SecretField
        {...secret}
        disabled
        text=""
        configured
        stateLabel="A key is configured."
        onEdit={vi.fn()}
      />,
    )

    expect(screen.getByLabelText('API key')).toHaveProperty('disabled', true)
  })
})

describe('field help mark', () => {
  it('renders no question mark when a field has no extra explanation', () => {
    render(<ValueField {...frame} text="60000" onEdit={vi.fn()} onReset={vi.fn()} />)
    expect(screen.queryByTestId('field-help-field')).toBeNull()
  })

  it('renders a question mark carrying the field explanation', () => {
    const help = 'Gate strength: stateful blocks, advisory reminds, off disables.'
    render(
      <ValueField {...frame} text="60000" onEdit={vi.fn()} onReset={vi.fn()} help={help} />,
    )
    const mark = screen.getByTestId('field-help-field')
    expect(mark.getAttribute('aria-label')).toBe(help)
    // A hover affordance inside a label must not add a second tab stop for the
    // field the user is already on.
    expect(mark.tagName).toBe('SPAN')
  })

  it('offers the same mark on the choice and list controls', () => {
    render(
      <ChoiceField
        {...frame}
        id="choice"
        text="stateful"
        options={['stateful', 'off']}
        clearLabel="Use default"
        help="Which gates block."
        onEdit={vi.fn()}
        onReset={vi.fn()}
      />,
    )
    expect(screen.getByTestId('field-help-choice').getAttribute('aria-label')).toBe('Which gates block.')
    cleanup()
    render(
      <ListField
        {...frame}
        id="list"
        text="a"
        help="One entry per line."
        onEdit={vi.fn()}
        onReset={vi.fn()}
      />,
    )
    expect(screen.getByTestId('field-help-list').getAttribute('aria-label')).toBe('One entry per line.')
  })
})

describe('DeliveryHelp', () => {
  /** Copy reader over the real dictionary, so the dialog's keys must exist. */
  const t = (key: keyof typeof zh): string => zh[key]

  it('renders nothing while closed', () => {
    render(<DeliveryHelp open={false} onClose={vi.fn()} t={t as never} />)
    expect(screen.queryByText(zh.deliveryHelpTiersHeading)).toBeNull()
  })

  it('documents every tier, the flow, the artifacts, and the four checks', () => {
    render(<DeliveryHelp open onClose={vi.fn()} t={t as never} />)
    expect(screen.getByText(zh.deliveryHelpTiersHeading)).toBeDefined()
    for (const tier of [zh.deliveryTierL0Name, zh.deliveryTierL1Name, zh.deliveryTierL2Name]) {
      expect(screen.getByText(tier)).toBeDefined()
    }
    expect(screen.getByText(zh.deliveryHelpFlowHeading)).toBeDefined()
    expect(screen.getByText(zh.deliveryHelpArtifactsHeading)).toBeDefined()
    expect(screen.getByText(zh.deliveryHelpVerifyHeading)).toBeDefined()
    for (const step of [zh.deliveryHelpVerifyStep1, zh.deliveryHelpVerifyStep2,
      zh.deliveryHelpVerifyStep3, zh.deliveryHelpVerifyStep4]) {
      expect(screen.getByText(step)).toBeDefined()
    }
    expect(screen.getByText(zh.deliveryHelpCoversHeading)).toBeDefined()
    expect(screen.getByText(zh.deliveryHelpConfigHeading)).toBeDefined()
  })

  it('closes from the footer action', () => {
    const onClose = vi.fn()
    render(<DeliveryHelp open onClose={onClose} t={t as never} />)
    fireEvent.click(screen.getByText(zh.close))
    expect(onClose).toHaveBeenCalled()
  })
})
