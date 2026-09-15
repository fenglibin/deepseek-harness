/**
 * Wire types for the skill management surface.
 *
 * A management surface reads filesystem truth rather than the merged registry
 * catalog: every scanned root, every entry a root holds, and which same-name
 * entry wins. Duplicate names, unloadable files, and absolute paths are the
 * facts an editor needs and the discovery catalog deliberately omits.
 * @module @deepseek-ai/dsh-host-skill-manager/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Identity of one skill entry on disk, stable while its path and name hold. */
export type SkillEntryId = Branded<'SkillEntryId'>

/** On-disk form of one skill entry. */
export type SkillEntryForm = 'bundle' | 'flat'

// This module is the Client-visible vocabulary of the `skillAdmin` namespace,
// so the Client compilation face compiles it; a host package's source is
// unreachable there. The two `dsh-skill` shapes it names are therefore stated
// here, and the host's own values stay assignable at every use site.
/** Discovery source label a root's entries carry. */
export type SkillSource = 'project-dsh' | 'project-agents' | 'runtime' | 'user-dsh' | 'user-agents' | 'custom' | 'bundled' | (string & {})

/** Invocation controls one skill declares. */
export interface SkillInvocationPolicy {
  /** Whether the model may invoke this skill. */
  readonly modelInvocable: boolean
  /** Whether a human may invoke this skill. */
  readonly userInvocable: boolean
}

/** One skill directory bundle or flat file as a management surface reads it. */
export interface SkillAdminEntry {
  /** Identity addressed by read, update, and remove. */
  readonly entryId: SkillEntryId
  /** Kebab-case frontmatter name, or the entry's basename when its frontmatter is unusable. */
  readonly name: string
  /** Absolute path of `SKILL.md` for a bundle, or of the flat `<name>.md` file. */
  readonly path: string
  /** Absolute directory holding the entry: the bundle directory, or the root for a flat file. */
  readonly directory: string
  /** On-disk form. */
  readonly form: SkillEntryForm
  /** Short routing description; empty when the entry's frontmatter is unusable. */
  readonly description: string
  /** Optional extra routing guidance. */
  readonly whenToUse?: string
  /** Resolved invocation controls, defaulted to permissive when frontmatter is unusable. */
  readonly invocation: SkillInvocationPolicy
  /** Why discovery drops this entry, absent while the entry is loadable. */
  readonly invalid?: string
  /** Whether discovery reads this entry; a disabled entry is parked in the root's `.disabled` directory. */
  readonly enabled: boolean
  /** Whether a same-name entry in a higher-precedence root wins over this one. */
  readonly shadowed: boolean
}

/** One scanned root and the entries it holds. */
export interface SkillRootView {
  /** Absolute root directory. */
  readonly path: string
  /** Discovery source label entries from this root carry. */
  readonly source: SkillSource
  /** Precedence rank; a lower rank wins a duplicate skill name. */
  readonly rank: number
  /** Project root this root belongs to, present only for project-scoped roots. */
  readonly projectRoot?: string
  /** Whether this deployment accepts writes into the root. */
  readonly writable: boolean
  /** Why the root refuses writes, absent when it accepts them. */
  readonly readOnlyReason?: string
  /** Every entry the root holds — the ones directly under it plus the disabled ones parked in `.disabled` — in name order. */
  readonly entries: readonly SkillAdminEntry[]
}

/** Complete management view for one workspace selection. */
export interface SkillAdminSnapshot {
  /** Absolute project root the view resolved, present when the request supplied a workspace. */
  readonly projectRoot?: string
  /** Scanned roots in precedence order. */
  readonly roots: readonly SkillRootView[]
}

/** Request for the management view of one workspace. */
export interface SkillAdminListRequest {
  /** Absolute workspace directory whose project roots participate; omit for global roots alone. */
  readonly projectRoot?: string
}

/** Request for one entry's editable document. */
export interface SkillReadRequest {
  /** Entry to read. */
  readonly entryId: SkillEntryId
}

/** One entry's editable document. */
export interface SkillDocument {
  /** Entry this document belongs to. */
  readonly entryId: SkillEntryId
  /** Absolute path of the file the document was read from. */
  readonly path: string
  /** On-disk form, which decides how the entry is written back. */
  readonly form: SkillEntryForm
  /** Complete file text, verbatim. */
  readonly raw: string
  /** Markdown body after the frontmatter block. */
  readonly content: string
  /** Kebab-case frontmatter name. */
  readonly name: string
  /** Short routing description. */
  readonly description: string
  /** Optional extra routing guidance. */
  readonly whenToUse?: string
  /** Resolved invocation controls. */
  readonly invocation: SkillInvocationPolicy
}

/** Request to create one skill entry under a chosen root. */
export interface SkillCreateRequest {
  /** Absolute root directory the entry is created under. */
  readonly rootPath: string
  /** Kebab-case skill name; also the file or directory basename. */
  readonly name: string
  /** Short routing description. */
  readonly description: string
  /** Optional extra routing guidance. */
  readonly whenToUse?: string
  /** Invocation controls to write explicitly. */
  readonly invocation: SkillInvocationPolicy
  /** Markdown body; an empty body writes a frontmatter-only skill. */
  readonly content: string
  /** On-disk form to create. */
  readonly form: SkillEntryForm
  /** Absolute workspace directory whose project roots participate in resolving the target root. */
  readonly projectRoot?: string
}

/** Request to rewrite one entry's frontmatter fields and body. */
export interface SkillUpdateRequest {
  /** Entry to rewrite. */
  readonly entryId: SkillEntryId
  /** Short routing description. */
  readonly description: string
  /** Optional extra routing guidance; omission removes the key. */
  readonly whenToUse?: string
  /** Invocation controls to write explicitly. */
  readonly invocation: SkillInvocationPolicy
  /** Markdown body. */
  readonly content: string
  /** Absolute workspace directory whose project roots participate in locating the entry. */
  readonly projectRoot?: string
}

/** Request to delete one entry. */
export interface SkillDeleteRequest {
  /** Entry to delete. */
  readonly entryId: SkillEntryId
  /** Absolute workspace directory whose project roots participate in locating the entry. */
  readonly projectRoot?: string
}

/** Identity of one staged import preview. */
export type ImportPreviewId = Branded<'ImportPreviewId'>

/** One file a pending import would write, as the preview lists it. */
export interface ImportFilePreview {
  /** Path relative to the skill directory. */
  readonly path: string
  /** Byte count of the file's content. */
  readonly bytes: number
}

/** What a reader approves before an import writes anything. */
export interface ImportPreview {
  /** Identity the commit call addresses. */
  readonly previewId: ImportPreviewId
  /** Where the files came from. */
  readonly origin: string
  /** Absolute root the files will be written under. */
  readonly rootPath: string
  /** Absolute directory the skill's files will occupy. */
  readonly targetPath: string
  /** Kebab-case name from the incoming SKILL.md frontmatter. */
  readonly name: string
  /** Description from the incoming SKILL.md frontmatter. */
  readonly description: string
  /** Complete SKILL.md body, so a reader can judge what they are importing. */
  readonly content: string
  /** Every file the import would write, in archive order. */
  readonly files: readonly ImportFilePreview[]
  /** Total bytes across every file. */
  readonly totalBytes: number
  /** Whether an entry already occupies the target, in which case the commit refueses. */
  readonly replaces: boolean
}

/** Request to resolve an import source into a preview. */
export interface ImportPreviewRequest {
  /** GitHub location (`owner/repo[/path][@ref]`, or a `github.com` URL) or a direct archive URL. */
  readonly source: string
  /** Absolute scanned root the skill would be written under. */
  readonly rootPath: string
  /** Absolute workspace directory whose project roots participate in locating the root. */
  readonly projectRoot?: string
}

/** Request to write a preview that was already approved. */
export interface ImportCommitRequest {
  /** Identity returned by the preview. */
  readonly previewId: ImportPreviewId
}

/** Request for one file of a staged import preview. */
export interface ImportPreviewFileRequest {
  /** Identity returned by the preview. */
  readonly previewId: ImportPreviewId
  /** Forward-slash path relative to the skill directory, exactly as the preview listed it. */
  readonly path: string
}

/**
 * One file of a staged import preview, as the reader inspects it.
 *
 * Content is read one file at a time rather than shipped with the preview: an
 * approved archive may hold megabytes across hundreds of members, and a reader
 * who only needs the file list should not pay for every body in it.
 */
export interface ImportPreviewFile {
  /** Forward-slash path relative to the skill directory. */
  readonly path: string
  /** File text, verbatim; empty when the bytes carry no text to show. */
  readonly text: string
  /** Why there is no text to show, absent while the file has text. */
  readonly unreadableReason?: SkillFileReadOnlyReason
}

/** Request to flip one entry between the scanned set and the root's disabled parking directory. */
export interface SkillSetEnabledRequest {
  /** Entry to move. */
  readonly entryId: SkillEntryId
  /** Whether discovery should read the entry afterwards. */
  readonly enabled: boolean
  /** Absolute workspace directory whose project roots participate in locating the entry. */
  readonly projectRoot?: string
}

/** One file inside a skill entry's own file root. */
export interface SkillFileNode {
  /** Forward-slash path relative to the entry's file root. */
  readonly path: string
  /** Byte count of the file. */
  readonly bytes: number
}

/** Everything the editor's file tree lists for one entry. */
export interface SkillFileTree {
  /** Entry the files belong to. */
  readonly entryId: SkillEntryId
  /** Absolute directory the relative paths resolve against. */
  readonly directory: string
  /** Files under that directory, in path order. */
  readonly files: readonly SkillFileNode[]
  /** Whether a listing bound stopped the walk, so the tree is partial. */
  readonly truncated: boolean
}

/** Why a skill file cannot be written back. */
export type SkillFileReadOnlyReason = 'binary' | 'too-large'

/** Request for one entry's file list. */
export interface SkillFileListRequest {
  /** Entry whose files are listed. */
  readonly entryId: SkillEntryId
  /** Absolute workspace directory whose project roots participate in locating the entry. */
  readonly projectRoot?: string
}

/** Request for one file's text. */
export interface SkillFileReadRequest {
  /** Entry the file belongs to. */
  readonly entryId: SkillEntryId
  /** Forward-slash path relative to the entry's file root. */
  readonly path: string
  /** Absolute workspace directory whose project roots participate in locating the entry. */
  readonly projectRoot?: string
}

/** One file's text as the editor reads it. */
export interface SkillFileDocument {
  /** Entry the file belongs to. */
  readonly entryId: SkillEntryId
  /** Forward-slash path relative to the entry's file root. */
  readonly path: string
  /** File text, verbatim; empty when the file is read-only. */
  readonly text: string
  /** Whether the file can be written back. */
  readonly editable: boolean
  /** Why the file is read-only, absent while it is editable. */
  readonly readOnlyReason?: SkillFileReadOnlyReason
}

/** Request to rewrite one file's text. */
export interface SkillFileWriteRequest {
  /** Entry the file belongs to. */
  readonly entryId: SkillEntryId
  /** Forward-slash path relative to the entry's file root. */
  readonly path: string
  /** Complete replacement text. */
  readonly text: string
  /** Absolute workspace directory whose project roots participate in locating the entry. */
  readonly projectRoot?: string
}

/** Request to resolve an uploaded archive into a preview. */
export interface SkillUploadRequest {
  /** Name of the uploaded file, used only as a container-format hint. */
  readonly fileName: string
  /** Canonical base64 encoding of the archive bytes. */
  readonly data: string
  /** Absolute scanned root the skill would be written under. */
  readonly rootPath: string
  /** Absolute workspace directory whose project roots participate in locating the root. */
  readonly projectRoot?: string
}
