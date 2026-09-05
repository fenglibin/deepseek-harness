// @vitest-environment jsdom
/**
 * ImageChipNode semantics: the display cache it carries, its zero-length text
 * projection, JSON round-trip, clone identity, host element, and decorator
 * face. A headless editor drives the node cases; the chip's visual face has
 * its own component spec.
 */
import { describe, expect, it } from 'vitest'
import { createHeadlessEditor } from '@lexical/headless'
import type { LexicalEditor, NodeKey } from 'lexical'
import { $createTextNode } from 'lexical'
import { ImageChip } from '../src/client/input/editor/ImageChip.tsx'
import type { ImageChipProps } from '../src/client/input/editor/ImageChip.tsx'
import {
  $createImageChipNode, $isImageChipNode, ImageChipNode,
} from '../src/client/input/editor/image-node.tsx'
import type { SerializedImageChipNode } from '../src/client/input/editor/image-node.tsx'
import type { DraftAttachmentId, DraftImageInsert } from '../src/client/contract/input.ts'

const INSERT: DraftImageInsert = {
  attachmentId: 'draft-1' as DraftAttachmentId,
  previewUrl: 'blob:preview-draft-1',
  name: 'shot.png',
  width: 640,
  height: 480,
}

const LABELS = {
  removeLabel: 'Remove image shot.png',
  pendingAlt: 'Pending images',
  lightboxDialog: 'Original image preview',
  lightboxClose: 'Close original image preview',
}

function makeEditor(): LexicalEditor {
  return createHeadlessEditor({
    namespace: 'image-node-spec',
    nodes: [ImageChipNode],
    onError: (error) => { throw error },
  })
}

describe('ImageChipNode', () => {
  it('carries the display cache and answers an empty text projection', () => {
    const editor = makeEditor()
    editor.update(() => {
      const chip = $createImageChipNode(INSERT, LABELS, () => {})
      expect(chip.getAttachmentId()).toBe('draft-1')
      expect(chip.getTextContent()).toBe('')
      expect(chip.isInline()).toBe(true)
      expect(chip.isKeyboardSelectable()).toBe(false)
      expect($isImageChipNode(chip)).toBe(true)
      expect($isImageChipNode($createTextNode('x'))).toBe(false)
    }, { discrete: true })
  })

  it('round-trips JSON with and without intrinsic dimensions', () => {
    const editor = makeEditor()
    editor.update(() => {
      const sized = $createImageChipNode(INSERT, LABELS, () => {}).exportJSON()
      expect(sized.attachmentId).toBe('draft-1')
      expect(sized.previewUrl).toBe('blob:preview-draft-1')
      expect(sized.name).toBe('shot.png')
      expect(sized.width).toBe(640)
      expect(sized.height).toBe(480)
      const back = ImageChipNode.importJSON(sized)
      expect(back.getAttachmentId()).toBe('draft-1')
      expect(back.getTextContent()).toBe('')

      const bare = $createImageChipNode(
        { attachmentId: 'draft-2' as DraftAttachmentId, previewUrl: 'blob:preview-draft-2' },
        LABELS,
        () => {},
      ).exportJSON()
      expect('width' in bare).toBe(false)
      expect('height' in bare).toBe(false)
      const backBare = ImageChipNode.importJSON(bare)
      expect(backBare.getAttachmentId()).toBe('draft-2')
    }, { discrete: true })
  })

  it('imports a nameless chip from JSON', () => {
    const editor = makeEditor()
    editor.update(() => {
      const json: SerializedImageChipNode = {
        ...$createImageChipNode(INSERT, LABELS, () => {}).exportJSON(),
        name: '',
      }
      const chip = ImageChipNode.importJSON(json)
      expect(chip.getTextContent()).toBe('')
      expect(chip.getAttachmentId()).toBe('draft-1')
    }, { discrete: true })
  })

  it('clones with the same NodeKey, labels, and remove callback', () => {
    const editor = makeEditor()
    let key = '' as NodeKey
    editor.update(() => {
      const chip = $createImageChipNode(INSERT, LABELS, (id) => { void id })
      key = chip.getKey()
      const copy = ImageChipNode.clone(chip)
      expect(copy.getKey()).toBe(key)
      expect(copy.getAttachmentId()).toBe('draft-1')
      expect(copy.getTextContent()).toBe('')
    }, { discrete: true })
    expect(key).not.toBe('')
  })

  it('mounts a non-editable inline host carrying the composer anchor', () => {
    const editor = makeEditor()
    editor.update(() => {
      const chip = $createImageChipNode(INSERT, LABELS, () => {})
      const el = chip.createDOM({ namespace: 'image-node-spec', theme: {} })
      expect(el.getAttribute('data-composer-image-chip')).toBe('')
      expect(el.getAttribute('contenteditable')).toBe('false')
      expect(chip.updateDOM()).toBe(false)
    }, { discrete: true })
  })

  it('decorates to an ImageChip element forwarding the cache, labels, and callback', () => {
    const editor = makeEditor()
    editor.update(() => {
      const onRemove = (id: DraftAttachmentId): void => { void id }
      const chip = $createImageChipNode(INSERT, LABELS, onRemove)
      const element = chip.decorate()
      expect(element.type).toBe(ImageChip)
      const props = element.props as ImageChipProps
      expect(props.attachmentId).toBe('draft-1')
      expect(props.previewUrl).toBe('blob:preview-draft-1')
      expect(props.name).toBe('shot.png')
      expect(props.width).toBe(640)
      expect(props.height).toBe(480)
      expect(props.removeLabel).toBe(LABELS.removeLabel)
      expect(props.pendingAlt).toBe(LABELS.pendingAlt)
      expect(props.onRemove).toBe(onRemove)
    }, { discrete: true })
  })
})
