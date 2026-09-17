// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeliveryHelp } from '../src/client/DeliveryHelp.tsx'
import { ChoiceField, SecretField, TagField, ValueField } from '../src/client/fields.tsx'
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

  it('renders a multi-line control for prose and spans the whole row', () => {
    // A prompt is prose: a one-line input would hide most of it and make
    // editing impractical, so the control is a textarea on the full row.
    const { container } = render(
      <ValueField {...frame} text="answer with l0, l1 or l2" textarea onEdit={vi.fn()} onReset={vi.fn()} />,
    )
    const control = screen.getByLabelText('Command timeout')
    expect(control.tagName).toBe('TEXTAREA')
    expect(control).toHaveProperty('value', 'answer with l0, l1 or l2')
    expect(control.closest('div[class*="wide"]')).toBeTruthy()
    expect(container.querySelector('input')).toBeNull()
  })

  it('keeps the multi-line control editable and staged like the single-line one', () => {
    const onEdit = vi.fn()
    render(<ValueField {...frame} text="old rules" textarea onEdit={onEdit} onReset={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Command timeout'), { target: { value: 'new rules' } })
    expect(onEdit).toHaveBeenCalledWith('new rules')
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

  it('offers the same mark on the choice control', () => {
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
  })

  it('offers the same mark on the tag list control', () => {
    render(
      <TagField
        {...frame}
        id="tags"
        text={'alpha\nbeta'}
        help="One entry per tag."
        addLabel="Add"
        removeLabel="Remove"
        editLabel="Rename"
        duplicateLabel="Already added"
        onEdit={vi.fn()}
        onReset={vi.fn()}
      />,
    )
    expect(screen.getByTestId('field-help-tags').getAttribute('aria-label')).toBe('One entry per tag.')
  })

  it('offers the same mark on the secret control', () => {
    render(
      <SecretField
        id="secret"
        label="API key"
        hint="Stored outside the section."
        text=""
        disabled={false}
        configured={false}
        stateLabel="Not configured"
        help="Written through the credential domain."
        onEdit={vi.fn()}
      />,
    )
    expect(screen.getByTestId('field-help-secret').getAttribute('aria-label'))
      .toBe('Written through the credential domain.')
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

describe('TagField', () => {
  /** 该控件在测试中使用的标签与按钮文案。 */
  const tagFrame = {
    ...frame,
    addLabel: 'Add',
    removeLabel: 'Remove',
    editLabel: 'Rename',
    duplicateLabel: 'Already present.',
    placeholder: 'Type one word',
  }

  it('renders one removable tag per value', () => {
    render(<TagField {...tagFrame} text={'协议\nschema'} onEdit={vi.fn()} onReset={vi.fn()} />)
    expect(screen.getByText('协议')).toBeTruthy()
    expect(screen.getByText('schema')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Remove: 协议' })).toBeTruthy()
  })

  it('stages the whole list when one tag is removed', () => {
    const onEdit = vi.fn()
    render(<TagField {...tagFrame} text={'协议\nschema'} onEdit={onEdit} onReset={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove: 协议' }))
    // 整份列表一次提交，草稿里不会留下半条内容。
    expect(onEdit).toHaveBeenCalledWith('schema')
  })

  it('commits a typed entry on Enter and clears the pending input', () => {
    const onEdit = vi.fn()
    render(<TagField {...tagFrame} text="协议" onEdit={onEdit} onReset={vi.fn()} />)
    const input = screen.getByLabelText('Command timeout')
    fireEvent.change(input, { target: { value: 'schema' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onEdit).toHaveBeenCalledWith('协议\nschema')
    expect(input).toHaveProperty('value', '')
  })

  it('commits a typed entry from the add control', () => {
    const onEdit = vi.fn()
    render(<TagField {...tagFrame} text="" onEdit={onEdit} onReset={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Command timeout'), { target: { value: '协议' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(onEdit).toHaveBeenCalledWith('协议')
  })

  it('refuses a duplicate instead of staging it twice', () => {
    const onEdit = vi.fn()
    render(<TagField {...tagFrame} text="协议" onEdit={onEdit} onReset={vi.fn()} />)
    const input = screen.getByLabelText('Command timeout')
    fireEvent.change(input, { target: { value: '协议' } })
    // 重复条目会被独立计两次，因此拒绝而不是默默去重。
    expect(screen.getByText('Already present.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add' })).toHaveProperty('disabled', true)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onEdit).not.toHaveBeenCalled()
  })

  it('disables every control on a read-only document', () => {
    render(<TagField {...tagFrame} disabled text="协议" onEdit={vi.fn()} onReset={vi.fn()} />)
    expect(screen.getByLabelText('Command timeout')).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Add' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Remove: 协议' })).toHaveProperty('disabled', true)
  })
  it('turns a tag into an input when its text is clicked', () => {
    render(<TagField {...tagFrame} text={'协议\nschema'} onEdit={vi.fn()} onReset={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Rename: 协议' }))
    // 行内改写：原文字被输入框取代，且带入原值。
    const input = screen.getByRole('textbox', { name: 'Rename: 协议' })
    expect(input).toHaveProperty('value', '协议')
  })

  it('stages the renamed value on Enter and leaves edit mode', () => {
    const onEdit = vi.fn()
    render(<TagField {...tagFrame} text={'协议\nschema'} onEdit={onEdit} onReset={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Rename: 协议' }))
    const input = screen.getByRole('textbox', { name: 'Rename: 协议' })
    fireEvent.change(input, { target: { value: 'agreement' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onEdit).toHaveBeenCalledWith('agreement\nschema')
    expect(screen.queryByRole('textbox', { name: 'Rename: 协议' })).toBeNull()
  })

  it('abandons the rename on Escape', () => {
    const onEdit = vi.fn()
    render(<TagField {...tagFrame} text="协议" onEdit={onEdit} onReset={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Rename: 协议' }))
    const input = screen.getByRole('textbox', { name: 'Rename: 协议' })
    fireEvent.change(input, { target: { value: 'discarded' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onEdit).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Rename: 协议' })).toBeTruthy()
  })

  it('refuses a rename that collides with another entry', () => {
    const onEdit = vi.fn()
    render(<TagField {...tagFrame} text={'协议\nschema'} onEdit={onEdit} onReset={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Rename: 协议' }))
    const input = screen.getByRole('textbox', { name: 'Rename: 协议' })
    fireEvent.change(input, { target: { value: 'schema' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    // 重复条目会被独立计两次，因此拒绝写入并留在编辑态。
    expect(onEdit).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: 'Rename: 协议' })).toBeTruthy()
  })

  it('treats an emptied rename as a no-op rather than writing a blank entry', () => {
    const onEdit = vi.fn()
    render(<TagField {...tagFrame} text="协议" onEdit={onEdit} onReset={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Rename: 协议' }))
    const input = screen.getByRole('textbox', { name: 'Rename: 协议' })
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onEdit).not.toHaveBeenCalled()
  })

  it('commits a valid rename on blur', () => {
    const onEdit = vi.fn()
    render(<TagField {...tagFrame} text={'协议\nschema'} onEdit={onEdit} onReset={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Rename: 协议' }))
    const input = screen.getByRole('textbox', { name: 'Rename: 协议' })
    fireEvent.change(input, { target: { value: 'agreement' } })
    fireEvent.blur(input)
    expect(onEdit).toHaveBeenCalledWith('agreement\nschema')
  })

  it('makes the tag text a disabled control on a read-only document', () => {
    render(<TagField {...tagFrame} disabled text="协议" onEdit={vi.fn()} onReset={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Rename: 协议' })).toHaveProperty('disabled', true)
  })
})
