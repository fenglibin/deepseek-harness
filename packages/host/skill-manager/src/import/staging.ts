/**
 * Pending import previews.
 *
 * A preview is approved by a person, so the unpacked files have to survive
 * between two Remote calls — but only briefly and only up to a bound. An
 * abandoned preview must not hold memory forever, and taking a preview
 * consumes it so the same approved file list can never be written twice.
 * @module @deepseek-ai/dsh-host-skill-manager/import/staging
 */

import { randomBytes } from 'node:crypto'
import type { UnpackedEntry } from './archive.ts'

/** Default number of previews kept at once. */
const DEFAULT_MAX_PREVIEWS = 4

/** Default lifetime of one preview. */
const DEFAULT_TTL_MS = 10 * 60 * 1000

/** Identity of one staged preview. */
export type ImportPreviewId = string & { readonly __importPreviewId: unique symbol }

/** One approved import waiting to be written. */
export interface StagedImport {
  /** Validated members, relative to the skill directory. */
  readonly files: readonly UnpackedEntry[]
  /** Where the files came from. */
  readonly origin: string
  /** Absolute root the files will be written under. */
  readonly rootPath: string
  /** Workspace selection the root was resolved under, needed to re-check it at commit. */
  readonly projectRoot?: string
}

/** Bounded, expiring store of approved imports. */
export class ImportStaging {
  private readonly pending = new Map<ImportPreviewId, { staged: StagedImport; expiresAt: number }>()

  /**
   * @param maxPreviews - previews kept at once; the oldest is dropped first.
   * @param ttlMs - lifetime of one preview.
   * @param now - clock, injectable so a test can age a preview without waiting.
   */
  constructor(
    private readonly maxPreviews: number = DEFAULT_MAX_PREVIEWS,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Keep one validated import until it is committed or expires.
   * @param staged - the files, origin, and target root a reader approved.
   * @returns the identity the commit call addresses.
   */
  stage(staged: StagedImport): ImportPreviewId {
    this.sweep()
    while (this.pending.size >= this.maxPreviews) {
      const oldest = this.pending.keys().next().value
      if (oldest === undefined) break
      this.pending.delete(oldest)
    }
    const id = randomBytes(12).toString('hex') as ImportPreviewId
    this.pending.set(id, { staged, expiresAt: this.now() + this.ttlMs })
    return id
  }

  /**
   * Read one preview without consuming it.
   *
   * A reader inspects the staged files one at a time before approving them, and
   * each inspection is its own call. Only {@link take} ends a preview's life, so
   * reading one can never be mistaken for approving it.
   * @param id - identity returned by {@link stage}.
   * @returns the staged import, or undefined when it expired or was already taken.
   */
  peek(id: ImportPreviewId): StagedImport | undefined {
    this.sweep()
    return this.pending.get(id)?.staged
  }

  /**
   * Consume one preview.
   * @param id - identity returned by {@link stage}.
   * @returns the staged import, or undefined when it expired or was already taken.
   */
  take(id: ImportPreviewId): StagedImport | undefined {
    this.sweep()
    const held = this.pending.get(id)
    if (held === undefined) return undefined
    this.pending.delete(id)
    return held.staged
  }

  /** How many previews are still held; the acceptance path reads it. */
  get size(): number {
    this.sweep()
    return this.pending.size
  }

  /** Drop every expired preview. */
  private sweep(): void {
    const cutoff = this.now()
    for (const [id, held] of this.pending) {
      if (held.expiresAt <= cutoff) this.pending.delete(id)
    }
  }
}
