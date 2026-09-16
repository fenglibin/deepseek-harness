/**
 * Clipboard image extraction for the composer. A screenshot reaches the
 * browser as a file item; the same image copied out of a page often reaches it
 * as an HTML fragment whose `<img>` carries a `data:` source, and no file item
 * accompanies that form. Remote sources are deliberately left alone: fetching
 * one would turn a paste into a network request.
 */

/** File extension per accepted media type, for the synthesized name. */
const EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
])

/** A `data:` image source carrying base64 bytes of a supported media type. */
const DATA_IMAGE = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/u

/**
 * Decode one `data:` image source into a named file.
 * @param source - an `<img src>` value.
 * @param index - position of the image in its fragment, naming the file.
 * @returns the decoded file, or undefined for any other source form.
 */
function fileFromDataUrl(source: string, index: number): File | undefined {
  const matched = DATA_IMAGE.exec(source)
  const mediaType = matched?.[1]
  const payload = matched?.[2]
  if (mediaType === undefined || payload === undefined) return undefined
  let binary: string
  try {
    binary = atob(payload)
  } catch {
    // A source the character class accepted can still be malformed base64.
    return undefined
  }
  const bytes = new Uint8Array(binary.length)
  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at)
  const extension = EXTENSIONS.get(mediaType) ?? 'png'
  return new File([bytes], `pasted-image-${index + 1}.${extension}`, { type: mediaType })
}

/**
 * Extract the images an HTML clipboard fragment carries as inline `data:`
 * bytes. Remote `<img src>` values are skipped: retrieving one is a network
 * request, not a paste.
 * @param html - the `text/html` clipboard payload; empty answers no files.
 * @returns one file per embedded image, in document order.
 */
export function embeddedImageFiles(html: string): readonly File[] {
  if (html === '') return []
  const document = new DOMParser().parseFromString(html, 'text/html')
  const files: File[] = []
  document.querySelectorAll('img').forEach((image, index) => {
    const file = fileFromDataUrl(image.getAttribute('src') ?? '', index)
    if (file !== undefined) files.push(file)
  })
  return files
}

/**
 * Read the images one paste carries: the file items a screenshot offers, or —
 * when the browser offers none — the `data:` images of the pasted HTML
 * fragment.
 * @param clipboardData - the paste's clipboard payload; null answers no files.
 * @returns the pasted image files, in clipboard order.
 */
export function clipboardImageFiles(clipboardData: DataTransfer | null): readonly File[] {
  if (clipboardData === null) return []
  const items = Array.from(clipboardData.items)
  const fromItems = items
    .filter(item => item.kind === 'file')
    .map(item => item.getAsFile())
    .filter((file): file is File => file !== null)
  if (fromItems.length > 0) return fromItems
  return embeddedImageFiles(clipboardData.getData('text/html'))
}
