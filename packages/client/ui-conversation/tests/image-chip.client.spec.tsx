// @vitest-environment jsdom
/**
 * ImageChip visual face: thumbnail alt resolution, intrinsic sizing, the
 * remove callback, and the original-preview lightbox (open, Escape, mask,
 * and close control).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { DraftAttachmentId } from '../src/client/contract/input.ts'
import { ImageChip } from '../src/client/input/editor/ImageChip.tsx'

const ID = 'draft-1' as DraftAttachmentId

function props(over: Partial<Parameters<typeof ImageChip>[0]> = {}) {
  return {
    attachmentId: ID,
    previewUrl: 'blob:preview-draft-1',
    name: 'shot.png',
    width: 640,
    height: 480,
    removeLabel: 'Remove image shot.png',
    pendingAlt: 'Pending images',
    lightboxDialog: 'Original image preview',
    lightboxClose: 'Close original image preview',
    onRemove: () => {},
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

  it('routes the remove button through the callback', () => {
    const onRemove = vi.fn()
    render(<ImageChip {...props({ onRemove })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove image shot.png' }))
    expect(onRemove).toHaveBeenCalledWith(ID)
  })

  it('tolerates a missing remove callback (deserialized node never mounted)', () => {
    render(<ImageChip {...props({ onRemove: undefined })} />)
    expect(() => fireEvent.click(screen.getByRole('button', { name: 'Remove image shot.png' }))).not.toThrow()
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
