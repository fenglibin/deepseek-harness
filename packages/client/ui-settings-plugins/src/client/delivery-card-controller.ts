/** The delivery-discipline card's staged form over the `delivery` settings namespace. */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  CardForm, booleanField, enumField, numberField, tagField, textField,
  type CardActions, type CardFieldState, type CardShell,
} from './card-form.ts'

/**
 * Namespace of the delivery discipline's user-owned settings. Spelled here
 * rather than imported: a client package must not depend on a Host package.
 */
export const DELIVERY_NS = 'delivery'

/**
 * Settings namespace owning the prompt-command list the acceptance commands
 * are chosen from. Spelled here for the same reason as {@link DELIVERY_NS}.
 */
export const PROMPT_COMMANDS_NS = 'prompt-commands'

/** Enforcement levels the Host accepts, in the order the control offers them. */
export const DELIVERY_ENFORCEMENTS: readonly string[] = ['stateful', 'advisory', 'off']

/**
 * One command offered as an acceptance command, as the `prompt-commands`
 * section stores it. The card reads `name` and `title`; `prompt` rides along
 * because the scope hands back the whole validated section.
 */
export interface PromptCommandCandidate {
  /** Lowercase command name without the leading slash; the value this card stores. */
  name: string
  /** Localized display title, when the command declares one. */
  title?: string
  /** Prompt body the model carries out; owned by the prompt-commands section. */
  prompt?: string
}

/** The `prompt-commands` section shape this card reads candidates from. */
export interface PromptCommandsSettings {
  commands?: PromptCommandCandidate[]
}

/**
 * The delivery fields this card edits.
 *
 * Dotted names address the nested threshold objects the Host schema declares;
 * every other key sits at the top level of the namespace section.
 */
export interface DeliverySettings {
  /** Whether the delivery tools are registered at all. */
  enabled?: boolean
  /** Gate strength: stateful blocks, advisory reminds, off disables. */
  enforcement?: string
  /** Whether a direct human request creates a task without a tool call. */
  autoDetect?: boolean
  /** Whether a non-trivial bug fix is forced to the OpenSpec tier. */
  requireOpenspecForBugs?: boolean
  /** Review rounds a coverage gap may be released through. */
  maxReviewRounds?: number
  /** L1 thresholds. */
  designThreshold?: { todoCount?: number; touchedFiles?: number }
  /** L2 thresholds. */
  openspecThreshold?: { todoCount?: number; descriptionChars?: number }
  /**
   * The tier rules, sent as the grading call's system prompt. Text rather than
   * a keyword list so retuning what counts as l0/l1/l2 needs no code change.
   */
  gradingPrompt?: string
  /**
   * Names of the prompt commands the model must run before a task may reach
   * verified. Names rather than command text: the prompt body lives in the
   * `prompt-commands` section, so editing a command updates every task that
   * selected it.
   */
  verificationCommands?: readonly string[]
}

/** The field paths this card renders, in display order. */
export const DELIVERY_FIELDS = {
  enforcement: 'enforcement',
  enabled: 'enabled',
  autoDetect: 'autoDetect',
  requireOpenspecForBugs: 'requireOpenspecForBugs',
  maxReviewRounds: 'maxReviewRounds',
  designTodoCount: 'designThreshold.todoCount',
  designFiles: 'designThreshold.touchedFiles',
  specTodoCount: 'openspecThreshold.todoCount',
  specChars: 'openspecThreshold.descriptionChars',
  gradingPrompt: 'gradingPrompt',
  verificationCommands: 'verificationCommands',
} as const

/** What the delivery card renders. */
export interface DeliveryCardState extends CardShell {
  enforcement: CardFieldState
  enabled: CardFieldState
  autoDetect: CardFieldState
  requireOpenspecForBugs: CardFieldState
  maxReviewRounds: CardFieldState
  designTodoCount: CardFieldState
  designFiles: CardFieldState
  specTodoCount: CardFieldState
  specChars: CardFieldState
  gradingPrompt: CardFieldState
  verificationCommands: CardFieldState
  /**
   * The selected acceptance commands, in the order they run. The array order
   * of `verificationCommands` is the execution order the gate enforces, so the
   * card renders this list as the ordered one.
   */
  verificationSelected: readonly string[]
  /**
   * Commands the user may select as acceptance commands, read from the
   * `prompt-commands` section. Empty when that namespace is not served, which
   * is what the card's empty state reports.
   */
  verificationCandidates: readonly PromptCommandCandidate[]
  /** Names held by the draft but no longer offered, so they stay removable. */
  verificationMissing: readonly string[]
}

/** The registration-side face the delivery card's slot entry injects. */
export interface DeliveryCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useDeliveryCard. */
    deliveryCard: SnapshotStore<DeliveryCardState>
  }
  /** 把一个验收命令名加入或移出草稿。 */
  toggleVerificationCommand: (name: string) => void
  /**
   * 把一个已选验收命令移动到目标下标。
   *
   * 拖动与方向键共用这一个动作，两条交互路径因此不会各自演变出不同的顺序
   * 语义；越界或原地移动被忽略，调用方无需先判断边界。
   */
  moveVerificationCommand: (name: string, to: number) => void
}

/** Bridges the `delivery` scope onto the card's staged form. */
export class DeliveryCardController {
  private readonly form: CardForm<DeliverySettings>
  private readonly store: SnapshotStore<DeliveryCardState>

  /**
   * @param scope - the bound settings scope for the `delivery` namespace.
   * @param commands - the bound `prompt-commands` scope the acceptance
   * commands are chosen from; absent when that namespace is not served, in
   * which case the card offers no candidates.
   */
  constructor(
    scope: SettingsScope<DeliverySettings>,
    private readonly commands?: SettingsScope<PromptCommandsSettings>,
  ) {
    this.form = new CardForm(scope, [
      enumField(DELIVERY_FIELDS.enforcement, DELIVERY_ENFORCEMENTS),
      booleanField(DELIVERY_FIELDS.enabled),
      booleanField(DELIVERY_FIELDS.autoDetect),
      booleanField(DELIVERY_FIELDS.requireOpenspecForBugs),
      numberField(DELIVERY_FIELDS.maxReviewRounds),
      numberField(DELIVERY_FIELDS.designTodoCount),
      numberField(DELIVERY_FIELDS.designFiles),
      numberField(DELIVERY_FIELDS.specTodoCount),
      numberField(DELIVERY_FIELDS.specChars),
      // The tier rules are prose, not a list of values, so they edit as text.
      textField(DELIVERY_FIELDS.gradingPrompt),
      tagField(DELIVERY_FIELDS.verificationCommands),
    ])
    // The store exists before anything subscribes: a source that published
    // during subscription would otherwise call `publish()` while `this.store`
    // is still unset.
    this.store = this.form.bind(() => this.projection())
    // The candidate list is another namespace's section, so a change there
    // republishes this card: a command renamed or removed must be reflected
    // before the user saves a selection naming it.
    commands?.subscribe(() => { this.publish() })
  }

  /** 选定验收命令的当前值，按草稿优先。 */
  private selectedCommands(): string[] {
    return this.form.field(DELIVERY_FIELDS.verificationCommands).text
      .split('\n')
      .filter(name => name.length > 0)
  }

  private candidates(): readonly PromptCommandCandidate[] {
    return this.commands?.getSnapshot().value?.commands ?? []
  }

  private projection(): DeliveryCardState {
    const candidates = this.candidates()
    const offered = new Set(candidates.map(command => command.name))
    // The unselected candidates keep their own order, which is the
    // `prompt-commands` order the user already maintains on that page.
    const selected = this.selectedCommands()
    const selectedSet = new Set(selected)
    return {
      ...this.form.shell(),
      enforcement: this.form.field(DELIVERY_FIELDS.enforcement),
      enabled: this.form.field(DELIVERY_FIELDS.enabled),
      autoDetect: this.form.field(DELIVERY_FIELDS.autoDetect),
      requireOpenspecForBugs: this.form.field(DELIVERY_FIELDS.requireOpenspecForBugs),
      maxReviewRounds: this.form.field(DELIVERY_FIELDS.maxReviewRounds),
      designTodoCount: this.form.field(DELIVERY_FIELDS.designTodoCount),
      designFiles: this.form.field(DELIVERY_FIELDS.designFiles),
      specTodoCount: this.form.field(DELIVERY_FIELDS.specTodoCount),
      specChars: this.form.field(DELIVERY_FIELDS.specChars),
      gradingPrompt: this.form.field(DELIVERY_FIELDS.gradingPrompt),
      verificationCommands: this.form.field(DELIVERY_FIELDS.verificationCommands),
      verificationSelected: selected,
      // Only commands not already selected are offered as candidates: a
      // command cannot run twice, so the checkboxes exist to add, and the
      // ordered list above is what removes or reorders.
      verificationCandidates: candidates.filter(command => !selectedSet.has(command.name)),
      // A selected name whose command was deleted still shows, so the user can
      // see and remove the dangling selection instead of it silently riding
      // the next save.
      verificationMissing: selected.filter(name => !offered.has(name)),
    }
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its form actions.
   */
  inject(): DeliveryCardFace {
    return {
      hooks: { deliveryCard: this.store },
      ...this.form.actions(),
      toggleVerificationCommand: (name) => { this.toggleVerificationCommand(name) },
      moveVerificationCommand: (name, to) => { this.moveVerificationCommand(name, to) },
    }
  }

  /** 把一个验收命令名加入或移出草稿，重写整份选择。 */
  private toggleVerificationCommand(name: string): void {
    const selected = this.selectedCommands()
    // A newly selected command runs last: appending keeps the commands the
    // user already ordered in place instead of reshuffling them.
    const next = selected.includes(name)
      ? selected.filter(candidate => candidate !== name)
      : [...selected, name]
    this.form.actions().edit(DELIVERY_FIELDS.verificationCommands, next.join('\n'))
  }

  /**
   * 把一个已选命令移动到目标下标，重写整份选择。
   * @param name - 已选命令名。
   * @param to - 目标下标，调用方按展示位置给出。
   */
  private moveVerificationCommand(name: string, to: number): void {
    const selected = this.selectedCommands()
    const from = selected.indexOf(name)
    if (from < 0) return
    const target = Math.max(0, Math.min(selected.length - 1, Math.trunc(to)))
    if (target === from) return
    const next = [...selected]
    next.splice(from, 1)
    next.splice(target, 0, name)
    this.form.actions().edit(DELIVERY_FIELDS.verificationCommands, next.join('\n'))
  }

  private publish(): void {
    this.store.set(this.projection())
  }
}
