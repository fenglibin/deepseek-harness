// @vitest-environment jsdom
/**
 * ImageChip visual face: thumbnail alt resolution, intrinsic sizing, the
 * absence of a remove control (dropping the chip is the keyboard gesture),
 * and the original-preview lightbox (open, Escape, mask, and close control).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ImageChip } from '../src/client/input/editor/ImageChip.tsx'

// jsdom has no layout, so the size contract is pinned as CSS text: the draft
// thumbnail is a 20px image inside a 22px capsule, and a sent image shows at
// the same size (see ui-attachment's inline-message-image spec for the other
// half of the pair).
const chipCss = readFileSync(
  join(import.meta.dirname, '../src/client/input/editor/ImageChip.module.css'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, ' ')

function chipDeclarations(selector: string): string[] {
  const rule = new RegExp(`(?:^|\\})\\s*\\${selector}\\s*\\{([^{}]*)\\}`).exec(chipCss)
  if (rule === null) throw new Error(`ImageChip.module.css has no \`${selector}\` rule`)
  return (rule[1] ?? '').split(';').map(part => part.trim()).filter(Boolean)
}

function props(over: Partial<Parameters<typeof ImageChip>[0]> = {}) {
  return {
    previewUrl: 'blob:preview-draft-1',
    name: 'shot.png',
    width: 640,
    height: 480,
    pendingAlt: 'Pending images',
    lightboxDialog: 'Original image preview',
    lightboxClose: 'Close original image preview',
    ...over,
  }
}

afterEach(cleanup)

describe('ImageChip', () => {
  it('renders the thumbnail with the file name and intrinsic size', () => {
    render(<ImageChip {...props()} />)
    const img = screen.getByAltText('shot.png')
    expect(img.getAttribute('src')).toBe('blob:preview-draft-1')
    expect(img.getAttribute('width')).toBe('640')
    expect(img.getAttribute('height')).toBe('480')
  })

  it('falls back to the pending alt and omits size without dimensions', () => {
    const { width: _width, height: _height, ...sized } = props()
    render(<ImageChip {...sized} name="" />)
    const img = screen.getByAltText('Pending images')
    expect(img.hasAttribute('width')).toBe(false)
    expect(img.hasAttribute('height')).toBe(false)
  })

  it('ships no remove control: the thumbnail is the chip\'s only button', () => {
    render(<ImageChip {...props()} />)
    expect(screen.getAllByRole('button').map(button => button.getAttribute('aria-label')))
      .toEqual(['Original image preview'])
  })

  it('opens the original preview from the thumbnail and closes it on Escape', () => {
    render(<ImageChip {...props()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Original image preview' }))
    const dialog = screen.getByRole('dialog', { name: 'Original image preview' })
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe('blob:preview-draft-1')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closes the preview from the mask and the close control', () => {
    render(<ImageChip {...props()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Original image preview' }))
    const dialog = screen.getByRole('dialog', { name: 'Original image preview' })
    fireEvent.mouseDown(dialog.querySelector('[aria-hidden="true"]')!)
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Original image preview' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close original image preview' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows a hover preview on pointer enter and hides it on leave', () => {
    render(<ImageChip {...props()} />)
    const thumb = screen.getByRole('button', { name: 'Original image preview' })
    fireEvent.mouseEnter(thumb)
    expect(screen.getAllByAltText('shot.png')).toHaveLength(2)
    fireEvent.mouseLeave(thumb)
    expect(screen.getAllByAltText('shot.png')).toHaveLength(1)
  })

  it('shows the hover preview on focus and hides it on blur', () => {
    render(<ImageChip {...props()} />)
    const thumb = screen.getByRole('button', { name: 'Original image preview' })
    fireEvent.focus(thumb)
    expect(screen.getAllByAltText('shot.png')).toHaveLength(2)
    fireEvent.blur(thumb)
    expect(screen.getAllByAltText('shot.png')).toHaveLength(1)
  })
})

describe('ImageChip size', () => {
  it('shows a 20px thumbnail inside the composer\'s 22px line', () => {
    expect(chipDeclarations('.img')).toContain('width: 20px')
    expect(chipDeclarations('.img')).toContain('height: 20px')
    expect(chipDeclarations('.chip')).toContain('height: 22px')
  })
})
