/**
 * Shared form model behind every plugin card.
 *
 * A card stages what the user types and writes it only when they save. Each
 * settings write is a durable, revision-fenced document mutation, so a control
 * that committed as it settled turned one edit into a write the user never
 * asked for and could not preview; staged text makes what is on screen exactly
 * what a save would store.
 *
 * A field shows its effective value — the user layer over the composition
 * layer over the schema default — and whether the user layer carries it. That
 * presence, not a value comparison, is what marks a field overridden: an
 * override equal to the composition default is still an override.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'

/** The write one field's staged text performs when the card is saved. */
export type FieldWrite =
  | { kind: 'set'; value: unknown }
  | { kind: 'clear' }

/** How one section field converts between its stored value and its draft text. */
export interface CardFieldSpec {
  /**
   * Field path inside the namespace section. A dotted path reads and writes a
   * nested key (`designThreshold.todoCount`), which is how the delivery policy
   * groups its thresholds.
   */
  field: string
  /** Render a stored value as draft text; the empty string when the section carries none. */
  format: (value: unknown) => string
  /**
   * The write this draft text stages, or undefined when the text is not a
   * value this field accepts — which blocks the save rather than discarding it.
   */
  parse: (text: string) => FieldWrite | undefined
  /**
   * Which control renders this field. Absent means the plain text input every
   * card started with, so existing cards need no change.
   */
  control?: 'text' | 'number' | 'boolean' | 'enum' | 'tag'
  /** The accepted values of an `enum` control, in the order it should offer them. */
  options?: readonly string[]
}

/**
 * A control whose value is written outside the settings section. A credential
 * literal never rides a response, so its draft has nothing to seed from: it is
 * blank until typed, and a blank draft writes nothing.
 */
export interface CardSecretSpec {
  /** Field name addressing this control inside the card's form. */
  field: string
  /** Write the staged text; resolves to whether the Host accepted it. */
  write: (text: string) => Promise<boolean>
}

/** One field as a card's control renders it. */
export interface CardFieldState {
  /** Draft text the control renders. */
  text: string
  /**
   * Whether saving would leave a user-layer entry for this field. A staged
   * edit answers for itself, so the badge previews the save rather than
   * reporting a state the pending edit already contradicts.
   */
  overridden: boolean
  /** Whether the draft is not a value this field accepts, which blocks saving. */
  invalid: boolean
}

/** Form state every plugin card shares. */
export interface CardShell {
  /** False while the namespace is not served to this client; the card renders nothing. */
  available: boolean
  /** Whether the Host document accepts writes. */
  writable: boolean
  /** Whether the form holds edits that a save would write. */
  dirty: boolean
  /** Whether any staged draft is invalid, which blocks the save. */
  invalid: boolean
  /** Whether a save is crossing the wire. */
  saving: boolean
  /** Whether the last save did not land as staged; cleared by the next edit or save. */
  failed: boolean
}

/** The write actions every plugin card's slot entry injects. */
export interface CardActions {
  /** Stage draft text for one field. */
  edit: (field: string, text: string) => void
  /** Stage a clear, so saving lets the field re-inherit the composition layer. */
  resetField: (field: string) => void
  /** Write every staged edit, then re-seed from what the Host accepted. */
  save: () => void
  /** Drop every staged edit. */
  discard: () => void
}

/** One field's staged edit. */
interface StagedEdit {
  /** Draft text the control renders. */
  text: string
  /** True when this edit clears the field whatever text it shows. */
  clear: boolean
}

/** One staged edit resolved into the write a save performs. */
interface PlannedWrite {
  /** Field this entry writes. */
  field: string
  /**
   * Perform the write and report whether the Host holds the staged value
   * afterwards; undefined when the draft is not a value the field accepts.
   */
  run: (() => Promise<boolean>) | undefined
}

/**
 * A whole-number field. An empty draft clears the field; any other draft that
 * is not a finite number blocks the save.
 * @param field - field name inside the namespace section.
 * @returns the field's conversion spec.
 */
export function numberField(field: string): CardFieldSpec {
  return {
    field,
    // A section that carries no number for this field renders empty rather
    // than as a value nobody chose.
    format: value => typeof value === 'number' ? String(value) : '',
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      const parsed = Number(trimmed)
      return Number.isFinite(parsed) ? { kind: 'set', value: parsed } : undefined
    },
  }
}

/**
 * A free-text field. An empty draft clears the field, so emptying the control
 * and saving is the same gesture as resetting it.
 * @param field - field name inside the namespace section.
 * @returns the field's conversion spec.
 */
export function textField(field: string): CardFieldSpec {
  return {
    field,
    format: value => typeof value === 'string' ? value : '',
    parse: (text) => {
      const trimmed = text.trim()
      return trimmed === '' ? { kind: 'clear' } : { kind: 'set', value: trimmed }
    },
  }
}

/**
 * A boolean field.
 *
 * The draft renders as `true`/`false` and any other draft is rejected, so a
 * section key that holds a boolean cannot be given a string by a mistyped
 * control. An empty draft clears the key, which is distinct from `false`: a
 * cleared key falls back to the schema default while `false` overrides it.
 * @param field - field name inside the namespace section.
 * @returns the field's conversion spec.
 */
export function booleanField(field: string): CardFieldSpec {
  return {
    field,
    format: value => typeof value === 'boolean' ? String(value) : '',
    parse: (text) => {
      const trimmed = text.trim().toLowerCase()
      if (trimmed === '') return { kind: 'clear' }
      if (trimmed === 'true') return { kind: 'set', value: true }
      if (trimmed === 'false') return { kind: 'set', value: false }
      return undefined
    },
    control: 'boolean',
  }
}

/**
 * A field restricted to one of a fixed set of strings.
 *
 * A draft outside the set is rejected rather than written, so the section can
 * never hold a value the Host schema would refuse.
 * @param field - field name inside the namespace section.
 * @param values - the accepted values, in the order a control should offer them.
 * @returns the field's conversion spec.
 */
export function enumField(field: string, values: readonly string[]): CardFieldSpec {
  if (values.length === 0) throw new TypeError(`enumField(${field}) needs at least one value`)
  return {
    field,
    format: value => typeof value === 'string' && values.includes(value) ? value : '',
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      return values.includes(trimmed) ? { kind: 'set', value: trimmed } : undefined
    },
    control: 'enum',
    options: [...values],
  }
}

/**
 * 以「一个值一个可删除标签」的方式编辑的字符串列表。
 *
 * 值形状与其它列表字段相同（`string[]`），因此字段无需为控件改动 schema。草稿中
 * 重复出现的条目会被**拒绝**而不是被去重：词表的
 * 每条独立匹配、重复条目会各计一次，静默丢弃等于隐藏「用户写下的列表已与保存
 * 结果不一致」这一事实。
 * @param field - 命名空间分节内的字段名。
 * @returns 该字段的转换规格。
 */
export function tagField(field: string): CardFieldSpec {
  return {
    field,
    format: value => Array.isArray(value)
      ? value.filter(entry => typeof entry === 'string').join('\n')
      : '',
    parse: (text) => {
      const entries = entriedLines(text)
      if (entries.length === 0) return { kind: 'clear' }
      const unique = new Set(entries)
      if (unique.size !== entries.length) return undefined
      return { kind: 'set', value: entries }
    },
    control: 'tag',
  }
}

/** 一份草稿中按顺序排列的非空去空白行。 */
function entriedLines(text: string): string[] {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
}

/**
 * Stages one card's edits over one settings namespace and writes them on save.
 *
 * The form publishes through a snapshot store because slot components read
 * through a snapshot selector, while both the scope and the local drafts
 * change underneath; every projection is rebuilt from the two together.
 */
export class CardForm<T> {
  private readonly specs: Map<string, CardFieldSpec>
  private readonly secretSpecs: Map<string, CardSecretSpec>
  private readonly staged = new Map<string, StagedEdit>()
  private readonly listeners = new Set<() => void>()
  private saving = false
  private failed = false

  /**
   * @param scope - the bound settings scope for this card's namespace.
   * @param specs - the section fields this card edits.
   * @param secrets - the card's write-only controls, written outside the section.
   */
  constructor(
    private readonly scope: SettingsScope<T>,
    specs: CardFieldSpec[],
    secrets: CardSecretSpec[] = [],
  ) {
    this.specs = new Map(specs.map(spec => [spec.field, spec]))
    this.secretSpecs = new Map(secrets.map(spec => [spec.field, spec]))
    scope.subscribe(() => { this.publish() })
  }

  /**
   * Publish a projection of this form, rebuilt whenever the scope or a draft changes.
   * @param project - build the card's state from the form's current reads.
   * @returns the store the card's component reads through its bound selector.
   */
  bind<S>(project: () => S): SnapshotStore<S> {
    const store = createSnapshotStore(project())
    this.listeners.add(() => { store.set(project()) })
    return store
  }

  /**
   * Read the card-level state: what the Host serves, and what a save would do.
   * @returns the form state every card shares.
   */
  shell(): CardShell {
    const snapshot = this.scope.getSnapshot()
    const plan = this.plan()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: plan.length > 0,
      invalid: plan.some(item => item.run === undefined),
      saving: this.saving,
      failed: this.failed,
    }
  }

  /**
   * Read one control's state.
   * @param field - field name of a section field or of a write-only control.
   * @returns the draft text, whether a save would leave an override, and whether it is invalid.
   */
  field(field: string): CardFieldState {
    const staged = this.staged.get(field)
    if (this.secretSpecs.has(field)) {
      return { text: staged?.text ?? '', overridden: false, invalid: false }
    }
    const spec = this.spec(field)
    if (staged === undefined) {
      return { text: spec.format(this.sectionValue(field)), overridden: this.stored(field), invalid: false }
    }
    const write = staged.clear ? { kind: 'clear' as const } : spec.parse(staged.text)
    return {
      text: staged.text,
      overridden: write?.kind === 'set',
      invalid: write === undefined,
    }
  }

  /**
   * Build the edit, reset, save, and discard actions bound to this form.
   * @returns the actions a card's slot entry injects.
   */
  actions(): CardActions {
    return {
      edit: (field, text) => { this.stage(field, { text, clear: false }) },
      resetField: (field) => {
        this.stage(field, { text: this.spec(field).format(this.baseValue(field)), clear: true })
      },
      save: () => { void this.save() },
      discard: () => {
        if (this.staged.size === 0 && !this.failed) return
        this.staged.clear()
        this.failed = false
        this.publish()
      },
    }
  }

  /**
   * Write every staged edit, then re-seed from what the Host accepted.
   *
   * The Host is the only authority on whether a value was accepted — its
   * validators own the constraints no schema can express — so the outcome is
   * read back from the section rather than predicted here. A save that did not
   * land keeps its drafts, so the user can correct them instead of retyping.
   * @returns settlement after every write and the read-back.
   */
  async save(): Promise<void> {
    const plan = this.plan()
    const writes = plan.flatMap(item => item.run === undefined ? [] : [item.run])
    if (plan.length === 0 || this.saving || writes.length !== plan.length) return
    this.saving = true
    this.failed = false
    this.publish()
    let landed = true
    for (const write of writes) {
      landed = await write() && landed
    }
    if (landed) this.staged.clear()
    this.saving = false
    this.failed = !landed
    this.publish()
  }

  /**
   * Every staged edit a save would write. An entry whose draft is not a value
   * its field accepts carries no write: the form is still dirty, and the save
   * refuses rather than dropping the edit.
   * @returns the planned writes, in the order the fields were staged.
   */
  private plan(): PlannedWrite[] {
    const plan: PlannedWrite[] = []
    for (const [field, staged] of this.staged) {
      const secret = this.secretSpecs.get(field)
      if (secret !== undefined) {
        const value = staged.text.trim()
        if (value !== '') plan.push({ field, run: () => secret.write(value) })
        continue
      }
      const spec = this.spec(field)
      if (staged.clear) {
        if (this.stored(field)) plan.push({ field, run: () => this.clear(field) })
        continue
      }
      if (staged.text === spec.format(this.sectionValue(field))) continue
      const write = spec.parse(staged.text)
      if (write === undefined) plan.push({ field, run: undefined })
      else if (write.kind === 'clear') plan.push({ field, run: () => this.clear(field) })
      else plan.push({ field, run: () => this.store(field, write.value) })
    }
    return plan
  }

  private async clear(field: string): Promise<boolean> {
    const path = fieldPath(field)
    if (path.length === 1) await this.scope.unset(field)
    else await this.scope.mutate([{ op: 'unset', path }])
    return !this.stored(field)
  }

  private async store(field: string, value: unknown): Promise<boolean> {
    const path = fieldPath(field)
    if (path.length === 1) await this.scope.set(field, value)
    else await this.scope.mutate([{ op: 'set', path, value: value as never }])
    return this.userValue(field) === value
  }

  /**
   * The value the user layer holds for one field path.
   *
   * A dotted path walks into the nested object, because the user layer is the
   * plain document the section was stored as.
   * @param field - field path inside the namespace section.
   * @returns the stored value, or undefined when the layer does not carry it.
   */
  private userValue(field: string): unknown {
    const layer = this.userLayer()
    if (layer === undefined) return undefined
    let cursor: unknown = layer
    for (const key of fieldPath(field)) {
      if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) return undefined
      cursor = (cursor as Record<string, unknown>)[key]
    }
    return cursor
  }

  private stage(field: string, edit: StagedEdit): void {
    this.staged.set(field, edit)
    this.failed = false
    this.publish()
  }

  private spec(field: string): CardFieldSpec {
    const spec = this.specs.get(field)
    // Every call site names a field this card declared; a missing one is a
    // wiring mistake that must not degrade into a silently inert control.
    if (spec === undefined) throw new Error(`plugin card has no field ${field}`)
    return spec
  }

  private snapshotOf(): SettingsScopeSnapshot<T> {
    return this.scope.getSnapshot()
  }

  private sectionValue(field: string): unknown {
    return readPath(this.snapshotOf().value, fieldPath(field))
  }

  private baseValue(field: string): unknown {
    return readPath(this.snapshotOf().base, fieldPath(field))
  }

  private userLayer(): Record<string, unknown> | undefined {
    return this.snapshotOf().user as Record<string, unknown> | undefined
  }

  private stored(field: string): boolean {
    const user = this.userLayer()
    if (user === undefined) return false
    // An override is a stored key, walked to the last segment: an intermediate
    // object exists but does not by itself mean this leaf was chosen.
    const path = fieldPath(field)
    const parent = path.length === 1 ? user : readPath(user, path.slice(0, -1))
    if (typeof parent !== 'object' || parent === null || Array.isArray(parent)) return false
    return Object.hasOwn(parent, path[path.length - 1] ?? '')
  }

  private publish(): void {
    for (const listener of this.listeners) listener()
  }
}

/**
 * Split one field spec path into its segments.
 * @param field - field path, dotted for a nested key.
 * @returns the path segments, in order.
 */
function fieldPath(field: string): string[] {
  return field.split('.').filter(segment => segment.length > 0)
}

/**
 * Read one nested value out of a plain document.
 * @param source - document to walk, or undefined.
 * @param path - segments to follow.
 * @returns the value at the path, or undefined when any segment is absent.
 */
function readPath(source: unknown, path: readonly string[]): unknown {
  let cursor = source
  for (const key of path) {
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) return undefined
    cursor = (cursor as Record<string, unknown>)[key]
  }
  return cursor
}
