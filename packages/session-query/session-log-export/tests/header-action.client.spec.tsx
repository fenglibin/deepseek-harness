// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SessionLogDownloadController } from '../src/client/controller.ts'
import { SessionLogDownloadHeaderAction } from '../src/client/HeaderAction.tsx'
import type { SessionLogDownloadDialogProps } from '../src/client/Dialog.tsx'
import { zh } from '../src/client/locales.ts'

const SID = 'session-export-header' as SessionId

function bindSessionExport(controller: SessionLogDownloadController) {
  return function useSessionLogDownload<T>(selector: (state: ReturnType<typeof controller.store.getSnapshot>) => T): T {
    return useSyncExternalStore(
      listener => controller.store.subscribe(listener),
      () => selector(controller.store.getSnapshot()),
    )
  }
}

function bench() {
  const controller = new SessionLogDownloadController(async () => new Response('zip'), vi.fn())
  const request = vi.fn(
    (sessionId: SessionId, includeDescendants?: boolean) => controller.download(sessionId, includeDescendants),
  )
  const dismiss = vi.fn((sessionId: SessionId) => { controller.dismiss(sessionId) })
  const useSessionLogDownload = bindSessionExport(controller)
  const props = {
    sessionId: SID,
    useSessionLogDownload,
    request,
    dismiss,
    t: (key: keyof typeof zh): string => zh[key],
  } as unknown as SessionLogDownloadDialogProps
  const view = render(<SessionLogDownloadHeaderAction {...props} />)
  return { controller, request, view }
}

afterEach(cleanup)

describe('Session export Header action', () => {
  it('renders the 111×32 text capsule and downloads through the shared controller', async () => {
    const b = bench()
    const button = b.view.getByRole('button', { name: 'Session 日志' })
    expect(button.querySelector('svg')).not.toBeNull()
    fireEvent.click(button)
    await waitFor(() => { expect(b.request).toHaveBeenCalledWith(SID) })
    await waitFor(() => { expect(b.controller.store.getSnapshot().bySession[SID]?.status).toBe('success') })
    expect(b.view.queryByRole('dialog')).toBeNull()
  })

  it('opens the failure dialog only when the preflight fails', async () => {
    const controller = new SessionLogDownloadController(
      async () => new Response('endpoint unavailable', { status: 500 }), vi.fn(),
    )
    const useSessionLogDownload = bindSessionExport(controller)
    const view = render(<SessionLogDownloadHeaderAction {...({
      sessionId: SID,
      useSessionLogDownload,
      request: (sessionId: SessionId) => controller.download(sessionId),
      dismiss: (sessionId: SessionId) => { controller.dismiss(sessionId) },
      t: (key: keyof typeof zh): string => zh[key],
    } as unknown as SessionLogDownloadDialogProps)} />)

    fireEvent.click(view.getByRole('button', { name: 'Session 日志' }))
    const dialog = await view.findByRole('dialog', { name: 'Session 导出失败' })
    expect(dialog.textContent).toContain('endpoint unavailable')
  })

  it('disables the capsule while either entry path downloads this Session', async () => {
    const b = bench()
    let release!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => { release = resolve })
    const controller = new SessionLogDownloadController(() => pending, vi.fn())
    const useSessionLogDownload = bindSessionExport(controller)
    b.view.rerender(<SessionLogDownloadHeaderAction {...({
      sessionId: SID,
      useSessionLogDownload,
      request: (sessionId: SessionId) => controller.download(sessionId),
      dismiss: (sessionId: SessionId) => { controller.dismiss(sessionId) },
      t: (key: keyof typeof zh): string => zh[key],
    } as unknown as SessionLogDownloadDialogProps)} />)

    const download = controller.download(SID)
    const button = b.view.getByRole('button', { name: 'Session 日志' })
    await waitFor(() => { expect(button.getAttribute('aria-busy')).toBe('true') })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    release(new Response('zip'))
    await download
    await waitFor(() => { expect(button.getAttribute('aria-busy')).toBe('false') })
  })

  it('exports the descendant tree from the range menu and closes it after the choice', async () => {
    const b = bench()
    const trigger = b.view.getByRole('button', { name: '更多导出选项' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(trigger)
    const tree = await b.view.findByRole('menuitem', { name: '包含子 Session' })
    expect(b.view.getByRole('menuitem', { name: '仅当前 Session' })).toBeTruthy()
    fireEvent.click(tree)

    await waitFor(() => { expect(b.request).toHaveBeenCalledWith(SID, true) })
    await waitFor(() => { expect(trigger.getAttribute('aria-expanded')).toBe('false') })
  })

  it('exports only the current Session when the menu row of that range is chosen', async () => {
    const b = bench()

    fireEvent.click(b.view.getByRole('button', { name: '更多导出选项' }))
    fireEvent.click(await b.view.findByRole('menuitem', { name: '仅当前 Session' }))

    await waitFor(() => { expect(b.request).toHaveBeenCalledWith(SID, false) })
  })

  it('closes the range menu on Escape without exporting', async () => {
    const b = bench()
    const trigger = b.view.getByRole('button', { name: '更多导出选项' })

    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(document, { key: 'Escape' })

    await waitFor(() => { expect(trigger.getAttribute('aria-expanded')).toBe('false') })
    expect(b.request).not.toHaveBeenCalled()
  })
})
