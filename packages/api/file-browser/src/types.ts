/**
 * Browser-safe vocabulary for the `fileBrowser` Remote namespace and its image
 * bytes route. Types only — a Client consumer reads the very declarations the
 * Host answers, including the `RemoteErrorDetailsMap` codes.
 *
 * @module @deepseek-ai/dsh-api-file-browser/types
 */

import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

export type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

/**
 * One directory entry as the browser tree renders it. `path` is workspace-root
 * relative, so a client never joins host path segments itself and every request
 * it sends back names the same entry.
 */
export interface FileBrowserEntry {
  /** Base name shown in a tree row. */
  readonly name: string
  /** Workspace-root-relative path with `/` separators. */
  readonly path: string
  /** Whether the entry is a regular file or a directory. */
  readonly kind: 'file' | 'directory'
  /** Byte size when the backend reports one cheaply; absent for directories. */
  readonly size?: number
}

/** One directory level's direct children, in stable name order. */
export interface FileBrowserListing {
  /** Workspace-root-relative path of the listed directory; `''` is the root. */
  readonly path: string
  /** Direct children, directories first then files, each name-sorted. */
  readonly entries: readonly FileBrowserEntry[]
  /** True when the level has more children than reported; the tail was cut. */
  readonly truncated: boolean
}

/** Stable media types the browser may render as an image. */
export type FileBrowserImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/**
 * What one file is to the browser. The union is the whole answer to "can this be
 * edited": only the `text` arm carries content into the editor, `image` renders
 * through the bytes route, and the other two arms exist so a refusal is a
 * reported fact rather than a read failure.
 */
export type FileBrowserContent =
  | {
    readonly kind: 'text'
    /** Decoded UTF-8 content. */
    readonly text: string
    /** Freshness token to present on the next write; a mismatch means someone else wrote. */
    readonly version: string
    /** Byte size on disk. */
    readonly size: number
  }
  | {
    readonly kind: 'image'
    readonly mediaType: FileBrowserImageMediaType
    readonly size: number
    /**
     * Absolute URL the browser loads the bytes from. The Host composes it
     * because the route path and its query contract belong to the bytes route
     * this package registers; a client never concatenates the two.
     */
    readonly url: string
  }
  | {
    readonly kind: 'binary'
    readonly size: number
  }
  | {
    readonly kind: 'too-large'
    readonly size: number
    /** The configured inclusive byte limit that refused this file. */
    readonly limit: number
  }

/** One name-search hit: only names match, never content. */
export interface FileBrowserSearchMatch {
  /** Workspace-root-relative path with `/` separators. */
  readonly path: string
  readonly kind: 'file' | 'directory'
}

/** Result of one name search over the workspace root. */
export interface FileBrowserSearchResult {
  readonly matches: readonly FileBrowserSearchMatch[]
  /** True when more entries matched than the reported bound. */
  readonly truncated: boolean
}

/** Listing request: one workspace, one directory level, one hidden-files choice. */
export interface FileBrowserListRequest {
  readonly workspaceId: WorkspaceId
  /** Workspace-root-relative directory; absent or empty lists the root. */
  readonly path?: string
  /** Include dot-prefixed entries and the heavy build directories. */
  readonly showHidden?: boolean
}

/** Read request for one file. */
export interface FileBrowserReadRequest {
  readonly workspaceId: WorkspaceId
  readonly path: string
}

/**
 * Write request. `version` is the token the caller read; supplying it turns the
 * write into a guarded replacement that refuses a target changed since, and
 * omitting it overwrites unconditionally.
 */
export interface FileBrowserWriteRequest {
  readonly workspaceId: WorkspaceId
  readonly path: string
  readonly content: string
  readonly version?: string
}

/** Create request for one new file or directory inside an existing directory. */
export interface FileBrowserCreateRequest {
  readonly workspaceId: WorkspaceId
  /** Workspace-root-relative parent directory; absent or empty means the root. */
  readonly directory?: string
  /** Single non-blank path segment; must not contain a separator or be `.`/`..`. */
  readonly name: string
  readonly kind: 'file' | 'directory'
}

/** Rename request: one entry moves within its own directory. */
export interface FileBrowserRenameRequest {
  readonly workspaceId: WorkspaceId
  readonly path: string
  /** Single non-blank path segment replacing the current base name. */
  readonly name: string
}

/** Delete request for one file or directory. */
export interface FileBrowserDeleteRequest {
  readonly workspaceId: WorkspaceId
  readonly path: string
}

/** Name search request. */
export interface FileBrowserSearchRequest {
  readonly workspaceId: WorkspaceId
  /** Case-insensitive name fragment; a blank query matches nothing. */
  readonly query: string
}

/** Write receipt: the version the write produced, for the next guarded write. */
export interface FileBrowserWriteValue {
  readonly version: string
}

/** Create receipt: the created entry's workspace-relative path. */
export interface FileBrowserCreateValue {
  readonly path: string
}

/** Rename receipt: the entry's workspace-relative path after the move. */
export interface FileBrowserRenameValue {
  readonly path: string
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The resolved target leaves the workspace root (through a symlink included). */
    'file-browser/outside-workspace': { readonly path: string }
    /** The named entry does not exist. */
    'file-browser/not-found': { readonly path: string }
    /** The target changed since the version the caller read. */
    'file-browser/stale': { readonly path: string }
    /** Another entry of that name is already there. */
    'file-browser/exists': { readonly path: string }
    /** The name is not a single non-blank path segment. */
    'file-browser/invalid-name': { readonly name: string }
    /** The target exists but cannot be read or listed. */
    'file-browser/unreadable': { readonly path: string }
    /** The operation is not one this browser performs on that target. */
    'file-browser/unsupported': { readonly path: string; readonly reason: string }
  }
}
