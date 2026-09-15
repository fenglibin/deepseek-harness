/**
 * Archive unpacking with the integrity checks a preview depends on.
 *
 * A preview is only honest if the file list it shows is the file list that
 * lands on disk, so every member is validated before it is returned: no
 * traversal, no absolute path, no link or device member, and bounded counts
 * and sizes. Encodings that could smuggle a name past those checks — tar PAX
 * records and GNU long-name extensions — are refused outright rather than
 * guessed at, because guessing is what turns a preview into a lie.
 * @module @deepseek-ai/dsh-host-skill-manager/import/archive
 */

import { gunzipSync } from 'node:zlib'
import { unzipSync } from 'fflate'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

/** One archive member accepted for writing, addressed relative to the skill directory. */
export interface UnpackedEntry {
  /** Forward-slash relative path; never absolute and never containing `..`. */
  readonly path: string
  /** Complete file bytes. */
  readonly bytes: Uint8Array
}

/** Bounds applied to a whole archive, never to one member alone. */
export interface UnpackLimits {
  /** Maximum accepted members. */
  readonly maxEntries: number
  /** Maximum bytes in one member. */
  readonly maxFileBytes: number
  /** Maximum bytes across every member. */
  readonly maxTotalBytes: number
}

/** Archive container this module knows how to open. */
export type ArchiveFormat = 'zip' | 'tar' | 'tar.gz'

/** tar header block size. */
const BLOCK = 512

/** Bound applied while inflating a gzip stream, so a bomb fails before it is materialized. */
const GZIP_MAX_OUTPUT_BYTES = 64 * 1024 * 1024

/**
 * Resolve the container an archive uses.
 * @param bytes - the complete downloaded body.
 * @param hint - content type or URL path, used only when the magic bytes are inconclusive.
 * @returns the detected format.
 * @throws {RemoteError} `skill-admin/import-unreadable` when no known container matches.
 */
export function detectFormat(bytes: Uint8Array, hint: string): ArchiveFormat {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) return 'zip'
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return 'tar.gz'
  const lowered = hint.toLowerCase()
  if (lowered.includes('zip')) return 'zip'
  // A bare tar has no magic; the ustar marker at offset 257 is the only signal.
  if (bytes.length > BLOCK && decodeAscii(bytes.subarray(257, 262)) === 'ustar') return 'tar'
  if (lowered.includes('tar')) return 'tar'
  throw new RemoteError('skill-admin/import-unreadable', 'the download is not a zip or tar archive', {
    reason: `unrecognized container (hint ${JSON.stringify(hint)})`,
  })
}

/**
 * Unpack one archive into validated members.
 * @param bytes - the complete downloaded body.
 * @param format - container resolved by {@link detectFormat}.
 * @param limits - counts and sizes the whole archive must stay within.
 * @returns members in archive order, relative to the archive root.
 * @throws {RemoteError} `skill-admin/import-unreadable` for any member or bound the archive violates.
 */
export function unpack(bytes: Uint8Array, format: ArchiveFormat, limits: UnpackLimits): UnpackedEntry[] {
  const entries = format === 'zip' ? unpackZip(bytes, limits) : unpackTar(bytes, format, limits)
  if (entries.length === 0) {
    throw new RemoteError('skill-admin/import-unreadable', 'the archive holds no files', {
      reason: 'no regular file members',
    })
  }
  return entries
}

/**
 * Drop a single wrapper directory every member shares, the shape a hosting
 * service produces (`owner-repo-sha/…`) and a hand-made bundle does not.
 * @param entries - members relative to the archive root.
 * @returns members relative to the skill directory.
 */
export function stripWrapperDirectory(entries: readonly UnpackedEntry[]): UnpackedEntry[] {
  const first = entries[0]?.path.split('/')[0]
  if (first === undefined || first === '') return [...entries]
  const shared = entries.every(entry => entry.path.startsWith(`${first}/`))
  if (!shared) return [...entries]
  return entries.map(entry => ({ ...entry, path: entry.path.slice(first.length + 1) }))
}

/** Unpack a ZIP, rejecting members by their declared size before anything is inflated. */
function unpackZip(bytes: Uint8Array, limits: UnpackLimits): UnpackedEntry[] {
  let total = 0
  let count = 0
  return Object.entries(unzipSync(bytes, {
    filter: (file) => {
      const path = safeEntryPath(file.name)
      const declared = file.originalSize
      if (declared > limits.maxFileBytes) {
        throw new RemoteError('skill-admin/import-unreadable', `archive member ${JSON.stringify(file.name)} is too large`, {
          reason: `${declared} bytes exceeds the ${limits.maxFileBytes}-byte per-file limit`,
        })
      }
      total += declared
      if (total > limits.maxTotalBytes) {
        throw new RemoteError('skill-admin/import-unreadable', 'the archive expands beyond the total size limit', {
          reason: `${total} bytes exceeds the ${limits.maxTotalBytes}-byte total limit`,
        })
      }
      count += 1
      if (count > limits.maxEntries) {
        throw new RemoteError('skill-admin/import-unreadable', 'the archive holds too many members', {
          reason: `more than ${limits.maxEntries} members`,
        })
      }
      void path
      return true
    },
  })).map(([name, member]) => ({ path: safeEntryPath(name), bytes: member }))
}

/** Unpack a tar or tar.gz, refusing every member kind outside plain files and directories. */
function unpackTar(bytes: Uint8Array, format: ArchiveFormat, limits: UnpackLimits): UnpackedEntry[] {
  let tar = bytes
  if (format === 'tar.gz') {
    try {
      tar = new Uint8Array(gunzipSync(bytes, { maxOutputLength: GZIP_MAX_OUTPUT_BYTES }))
    } catch (error: unknown) {
      throw new RemoteError('skill-admin/import-unreadable', 'the gzip stream could not be decompressed', {
        reason: String(error),
      })
    }
  }
  const entries: UnpackedEntry[] = []
  let offset = 0
  let total = 0
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK)
    offset += BLOCK
    // Two consecutive zero blocks end the archive; one is enough to stop.
    if (header.every(byte => byte === 0)) break

    // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded index into the full block the loop just took
    const typeflag = String.fromCharCode(header[156]!)
    const size = tarOctal(header, 124, 12)
    const name = tarName(header)

    switch (typeflag) {
      case '0':
      case '\0':
        break
      case '5':
        offset = skipTo(tar, offset, size)
        continue
      default:
        throw new RemoteError('skill-admin/import-unreadable', `archive member ${JSON.stringify(name)} is not a plain file`, {
          reason: `tar type flag ${JSON.stringify(typeflag)} is refused (links, devices, and extended headers are not unpacked)`,
        })
    }

    const path = safeEntryPath(name)
    if (size > limits.maxFileBytes) {
      throw new RemoteError('skill-admin/import-unreadable', `archive member ${JSON.stringify(name)} is too large`, {
        reason: `${size} bytes exceeds the ${limits.maxFileBytes}-byte per-file limit`,
      })
    }
    total += size
    if (total > limits.maxTotalBytes) {
      throw new RemoteError('skill-admin/import-unreadable', 'the archive expands beyond the total size limit', {
        reason: `${total} bytes exceeds the ${limits.maxTotalBytes}-byte total limit`,
      })
    }
    entries.push({ path, bytes: tar.subarray(offset, offset + size) })
    if (entries.length > limits.maxEntries) {
      throw new RemoteError('skill-admin/import-unreadable', 'the archive holds too many members', {
        reason: `more than ${limits.maxEntries} members`,
      })
    }
    offset = skipTo(tar, offset, size)
  }
  return entries
}

/** Advance past one member's body, rounded up to the next block boundary. */
function skipTo(tar: Uint8Array, offset: number, size: number): number {
  const next = offset + Math.ceil(size / BLOCK) * BLOCK
  return next > tar.length ? tar.length : next
}

/** Read one NUL-terminated tar octal field. */
function tarOctal(header: Uint8Array, start: number, length: number): number {
  const raw = decodeAscii(header.subarray(start, start + length)).replace(/\0.*$/s, '').trim()
  if (raw === '') return 0
  // Base-256 escapes leading high bits and is how writers encode sizes beyond
  // the octal field; this parser refuses it rather than misreading the body.
  // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded index: the field lies inside the header block
  if ((header[start]! & 0x80) !== 0) {
    throw new RemoteError('skill-admin/import-unreadable', 'the archive uses a base-256 size field', {
      reason: 'base-256 numeric encoding is not supported',
    })
  }
  const value = Number.parseInt(raw, 8)
  if (!Number.isFinite(value) || value < 0) {
    throw new RemoteError('skill-admin/import-unreadable', 'the archive carries a malformed size field', {
      reason: `could not read octal ${JSON.stringify(raw)}`,
    })
  }
  return value
}

/** Join a tar member's prefix and name fields into one path. */
function tarName(header: Uint8Array): string {
  const name = decodeAscii(header.subarray(0, 100)).replace(/\0.*$/s, '')
  const prefix = decodeAscii(header.subarray(345, 500)).replace(/\0.*$/s, '')
  return prefix === '' ? name : `${prefix}/${name}`
}

/**
 * Validate one member path against the skill directory it will be written into.
 *
 * Every source funnels through here — archives and repository listings alike —
 * because this is what makes a preview honest: a path that reaches the write
 * step is one the preview already accepted, whichever source produced it.
 * @param name - the raw member name from the archive or listing.
 * @returns the same path once it is known safe.
 * @throws {RemoteError} `skill-admin/import-unreadable` for any path that could escape the directory.
 */
export function safeEntryPath(name: string): string {
  const normalized = name.replaceAll('\\', '/')
  if (normalized.startsWith('/')) {
    throw new RemoteError('skill-admin/import-unreadable', `archive member ${JSON.stringify(name)} is an absolute path`, {
      reason: 'absolute member paths are refused',
    })
  }
  if (/^[A-Za-z]:/.test(normalized)) {
    throw new RemoteError('skill-admin/import-unreadable', `archive member ${JSON.stringify(name)} carries a drive letter`, {
      reason: 'drive-qualified member paths are refused',
    })
  }
  const segments = normalized.split('/')
  if (segments.some(segment => segment === '..')) {
    throw new RemoteError('skill-admin/import-unreadable', `archive member ${JSON.stringify(name)} escapes the skill directory`, {
      reason: 'parent-directory segments are refused',
    })
  }
  if (segments.some(segment => segment === '')) {
    throw new RemoteError('skill-admin/import-unreadable', `archive member ${JSON.stringify(name)} has an empty path segment`, {
      reason: 'empty segments are refused',
    })
  }
  return normalized
}

/** Decode ASCII bytes, mapping every non-ASCII byte to U+FFFD rather than throwing. */
function decodeAscii(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8')
}
