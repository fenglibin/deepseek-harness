// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { InlineMessageImage } from '../src/InlineMessageImage.tsx'
import type { MessageImageLabels } from '../src/MessageImage.tsx'

afterEach(cleanup)

const labels: MessageImageLabels = {
  image: '图片',
  open: '查看原图',
  openNamed: label => `${label}，点击查看原图`,
  loading: '图片加载中…',
  loadFailed: '图片加载失败，点击重试',
  lightbox: { dialog: '原图预览', close: '关闭原图预览' },
}

const attachment = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png' as const,
  bytes: 68,
  width: 640,
  height: 320,
  name: 'history.png',
}

describe('InlineMessageImage', () => {
  it('loads a session-authorized URL into an inline thumbnail', async () => {
    const load = vi.fn().mockResolvedValue('blob:inline')
    const view = render(<InlineMessageImage image={{ attachment }} load={load} labels={labels} />)
    await waitFor(() => { expect((view.getByAltText('history.png') as HTMLImageElement).src).toContain('blob:inline') })
    expect(load).toHaveBeenCalledWith(attachment)
  })

  it('shows a hover preview on pointer enter and hides it on leave', async () => {
    const load = vi.fn().mockResolvedValue('blob:inline')
    const view = render(<InlineMessageImage image={{ attachment }} load={load} labels={labels} />)
    await waitFor(() => { expect((view.getByAltText('history.png') as HTMLImageElement).src).toContain('blob:inline') })
    const thumb = view.getByRole('button', { name: 'history.png，点击查看原图' })
    fireEvent.mouseEnter(thumb)
    expect(view.getAllByAltText('history.png')).toHaveLength(2)
    fireEvent.mouseLeave(thumb)
    expect(view.getAllByAltText('history.png')).toHaveLength(1)
  })

  it('opens the original lightbox from the thumbnail', async () => {
    const load = vi.fn().mockResolvedValue('blob:inline')
    const view = render(<InlineMessageImage image={{ attachment }} load={load} labels={labels} />)
    await waitFor(() => { expect(view.getByAltText('history.png')).toBeTruthy() })
    fireEvent.click(view.getByRole('button', { name: 'history.png，点击查看原图' }))
    const dialog = view.getByRole('dialog', { name: '原图预览' })
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe('blob:inline')
  })

  it('surfaces a retry control when durable bytes cannot be read', async () => {
    const load = vi.fn().mockRejectedValue(new Error('denied'))
    const view = render(<InlineMessageImage image={{ attachment }} load={load} labels={labels} />)
    await waitFor(() => { expect(view.getByRole('button', { name: '图片加载失败，点击重试' })).toBeTruthy() })
  })
})
