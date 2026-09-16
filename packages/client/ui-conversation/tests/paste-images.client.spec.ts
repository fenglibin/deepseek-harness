// @vitest-environment jsdom
/**
 * Clipboard image extraction: the file items a screenshot offers, and — when a
 * browser offers none — the `data:` images of the pasted HTML fragment. Remote
 * sources stay out: retrieving one would be a network request, not a paste.
 */
import { describe, expect, it } from 'vitest'
import {
  clipboardImageFiles, embeddedImageFiles,
} from '../src/client/input/editor/paste-images.ts'

/** Shortest base64 decoding to a PNG signature (8 bytes). */
const PNG = 'iVBORw0KGgo='
/** Six bytes opening a JPEG (SOI + APP0). */
const JPEG = '/9j/4AAQ'

function fileItem(file: File): DataTransferItem {
  return { kind: 'file', type: file.type, getAsFile: () => file } as unknown as DataTransferItem
}

function stringItem(type: string): DataTransferItem {
  return { kind: 'string', type, getAsFile: () => null } as unknown as DataTransferItem
}

function transferWith(items: readonly DataTransferItem[], html: string): DataTransfer {
  return {
    items,
    getData: (type: string) => (type === 'text/html' ? html : ''),
  } as unknown as DataTransfer
}

describe('embeddedImageFiles', () => {
  it('decodes every inline data: image into a named file', () => {
    const files = embeddedImageFiles(
      `<img src="data:image/png;base64,${PNG}"><img src="data:image/jpeg;base64,${JPEG}">`,
    )
    expect(files.map(file => [file.name, file.type])).toEqual([
      ['pasted-image-1.png', 'image/png'],
      ['pasted-image-2.jpg', 'image/jpeg'],
    ])
    expect(files[0]?.size).toBe(8)
  })

  it('skips remote sources, non-image data, malformed base64, and bare tags', () => {
    const html = '<img src="https://example.com/a.png">'
      + '<img src="data:text/plain;base64,aGVsbG8=">'
      + '<img src="data:image/png;base64,A">'
      + '<img>'
    expect(embeddedImageFiles(html)).toEqual([])
  })

  it('answers no files for an empty fragment', () => {
    expect(embeddedImageFiles('')).toEqual([])
  })
})

describe('clipboardImageFiles', () => {
  it('prefers the file items a screenshot offers', () => {
    const image = new File([Uint8Array.of(1)], 'shot.png', { type: 'image/png' })
    const files = clipboardImageFiles(
      transferWith([fileItem(image)], `<img src="data:image/png;base64,${PNG}">`),
    )
    expect(files).toEqual([image])
  })

  it('falls back to the fragment when the clipboard offers no file item', () => {
    const files = clipboardImageFiles(transferWith([], `<img src="data:image/png;base64,${PNG}">`))
    expect(files).toHaveLength(1)
    expect(files[0]?.type).toBe('image/png')
    expect(files[0]?.name).toBe('pasted-image-1.png')
  })

  it('answers no files for a text-only clipboard', () => {
    expect(clipboardImageFiles(transferWith([stringItem('text/plain')], ''))).toEqual([])
  })
})
