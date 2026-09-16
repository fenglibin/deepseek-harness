/**
 * ImageChipNode: one inline draft image as an atomic Lexical decorator.
 * The node carries the browser-owned attachment id plus the thumbnail's
 * insert-time display cache, and `getTextContent()` answers '' — the image's
 * text projection is empty, so the persisted draft keeps only typed text
 * (browser-owned image bytes never survive a reload). The detect projection
 * still counts the chip as one U+FFFC, so caret motion treats it atomically.
 */
import type { JSX } from 'react'
import type {
  EditorConfig, LexicalNode, NodeKey, SerializedLexicalNode, Spread,
} from 'lexical'
import { DecoratorNode } from 'lexical'
import type { DraftAttachmentId, DraftImageInsert } from '../../contract/input.ts'
import { ImageChip } from './ImageChip.tsx'

/** Locale-owned chip labels cached at insert time (the decorator has no locale seat). */
export interface ImageChipLabels {
  /** Fallback alt for a nameless image. */
  readonly pendingAlt: string
  /** Preview dialog accessible name. */
  readonly lightboxDialog: string
  /** Preview close-button accessible name. */
  readonly lightboxClose: string
}

/** JSON form of one image chip (locale labels and the remove callback are not serialized). */
export type SerializedImageChipNode = Spread<{
  attachmentId: string
  previewUrl: string
  name: string
  width?: number
  height?: number
}, SerializedLexicalNode>

/** One inline draft image as an atomic decorator node. */
export class ImageChipNode extends DecoratorNode<JSX.Element> {
  /** Browser-owned draft attachment id. */
  __attachmentId: DraftAttachmentId
  /** Object URL the thumbnail renders. */
  __previewUrl: string
  /** Original file name ('' when unnamed). */
  __name: string
  /** Intrinsic pixel width, when the intake probe has resolved it. */
  __width: number | undefined
  /** Intrinsic pixel height, when the intake probe has resolved it. */
  __height: number | undefined
  /** Insert-time cached locale labels (see ImageChipLabels). */
  __labels: ImageChipLabels

  /** Lexical node registry type tag. */
  static override getType(): string {
    return 'image-chip'
  }

  /**
   * Clone with identity (Lexical writable-copy contract).
   * @param node - node to clone.
   * @returns a copy carrying the same NodeKey and labels.
   */
  static override clone(node: ImageChipNode): ImageChipNode {
    return new ImageChipNode(
      {
        attachmentId: node.__attachmentId,
        previewUrl: node.__previewUrl,
        name: node.__name,
        ...(node.__width === undefined ? {} : { width: node.__width }),
        ...(node.__height === undefined ? {} : { height: node.__height }),
      },
      node.__labels,
      node.__key,
    )
  }

  /**
   * Rebuild one chip from its JSON form (no locale labels, no callback; the
   * persisted draft never contains image nodes, so this path stays unreached).
   * @param json - serialized chip.
   * @returns a fresh node (new key).
   */
  static override importJSON(json: SerializedImageChipNode): ImageChipNode {
    return new ImageChipNode(
      {
        attachmentId: json.attachmentId as DraftAttachmentId,
        previewUrl: json.previewUrl,
        name: json.name,
        ...(json.width === undefined ? {} : { width: json.width }),
        ...(json.height === undefined ? {} : { height: json.height }),
      },
      { pendingAlt: '', lightboxDialog: '', lightboxClose: '' },
    )
  }

  /**
   * @param insert - the attachment display cache (browser-owned bytes excluded).
   * @param labels - insert-time cached locale labels.
   * @param key - Lexical clone-path key; absent for fresh nodes.
   */
  constructor(
    insert: Omit<DraftImageInsert, 'name' | 'width' | 'height'> & {
      name?: string
      width?: number
      height?: number
    },
    labels: ImageChipLabels,
    key?: NodeKey,
  ) {
    super(key)
    this.__attachmentId = insert.attachmentId
    this.__previewUrl = insert.previewUrl
    this.__name = insert.name ?? ''
    this.__width = insert.width
    this.__height = insert.height
    this.__labels = labels
  }

  /** Serialize to the JSON node form (locale labels and the callback stay out). */
  override exportJSON(): SerializedImageChipNode {
    return {
      ...super.exportJSON(),
      type: 'image-chip',
      version: 1,
      attachmentId: this.__attachmentId,
      previewUrl: this.__previewUrl,
      name: this.__name,
      ...(this.__width === undefined ? {} : { width: this.__width }),
      ...(this.__height === undefined ? {} : { height: this.__height }),
    }
  }

  /**
   * Mount the chip's host element; the decorator portal renders into it.
   * @returns an inline, non-editable span carrying the test/e2e anchor.
   */
  override createDOM(_config: EditorConfig): HTMLElement {
    const el = document.createElement('span')
    el.setAttribute('data-composer-image-chip', '')
    el.setAttribute('contenteditable', 'false')
    return el
  }

  /** Host element never changes shape. */
  override updateDOM(): boolean {
    return false
  }

  /** Image chips sit in the text line. */
  override isInline(): boolean {
    return true
  }

  /**
   * No keyboard-selected intermediate state: arrows step across the chip in
   * one move and Backspace/Delete remove it whole (same contract as the
   * reference chip; see chip-node.tsx).
   */
  override isKeyboardSelectable(): boolean {
    return false
  }

  /** Clipboard / persistence projection: images carry no text. */
  override getTextContent(): string {
    return ''
  }

  /** Browser-owned draft attachment id. */
  getAttachmentId(): DraftAttachmentId {
    return this.getLatest().__attachmentId
  }

  /** React face rendered into the host element by the decorator portal. */
  override decorate(): JSX.Element {
    return (
      <ImageChip
        previewUrl={this.__previewUrl}
        name={this.__name}
        {...(this.__width === undefined ? {} : { width: this.__width })}
        {...(this.__height === undefined ? {} : { height: this.__height })}
        pendingAlt={this.__labels.pendingAlt}
        lightboxDialog={this.__labels.lightboxDialog}
        lightboxClose={this.__labels.lightboxClose}
      />
    )
  }
}

/**
 * Mint one image chip node from an attachment insert.
 * @param insert - the attachment display cache.
 * @param labels - insert-time cached locale labels.
 * @returns the fresh node.
 */
export function $createImageChipNode(
  insert: Omit<DraftImageInsert, 'name' | 'width' | 'height'> & {
    name?: string
    width?: number
    height?: number
  },
  labels: ImageChipLabels,
): ImageChipNode {
  return new ImageChipNode(insert, labels)
}

/**
 * Image chip type guard.
 * @param node - any node or nullish.
 * @returns whether the node is an ImageChipNode.
 */
export function $isImageChipNode(node: LexicalNode | null | undefined): node is ImageChipNode {
  return node instanceof ImageChipNode
}
