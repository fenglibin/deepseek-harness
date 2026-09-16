/** The delivery-discipline card's staged form over the `delivery` settings namespace. */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  CardForm, booleanField, enumField, listField, numberField,
  type CardActions, type CardFieldState, type CardShell,
} from './card-form.ts'

/**
 * Namespace of the delivery discipline's user-owned settings. Spelled here
 * rather than imported: a client package must not depend on a Host package.
 */
export const DELIVERY_NS = 'delivery'

/** Enforcement levels the Host accepts, in the order the control offers them. */
export const DELIVERY_ENFORCEMENTS: readonly string[] = ['stateful', 'advisory', 'off']

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
  designThreshold?: { todoCount?: number; descriptionChars?: number; touchedFiles?: number }
  /** L2 thresholds. */
  openspecThreshold?: { todoCount?: number; descriptionChars?: number }
  /** Signal vocabularies that raise a request's tier. */
  strongSignals?: readonly string[]
  mediumSignals?: readonly string[]
  weakSignals?: readonly string[]
  /** Commands run before a task may reach verified. */
  postHooks?: readonly string[]
}

/** The field paths this card renders, in display order. */
export const DELIVERY_FIELDS = {
  enforcement: 'enforcement',
  enabled: 'enabled',
  autoDetect: 'autoDetect',
  requireOpenspecForBugs: 'requireOpenspecForBugs',
  maxReviewRounds: 'maxReviewRounds',
  designTodoCount: 'designThreshold.todoCount',
  designChars: 'designThreshold.descriptionChars',
  designFiles: 'designThreshold.touchedFiles',
  specTodoCount: 'openspecThreshold.todoCount',
  specChars: 'openspecThreshold.descriptionChars',
  strongSignals: 'strongSignals',
  mediumSignals: 'mediumSignals',
  weakSignals: 'weakSignals',
  postHooks: 'postHooks',
} as const

/** What the delivery card renders. */
export interface DeliveryCardState extends CardShell {
  enforcement: CardFieldState
  enabled: CardFieldState
  autoDetect: CardFieldState
  requireOpenspecForBugs: CardFieldState
  maxReviewRounds: CardFieldState
  designTodoCount: CardFieldState
  designChars: CardFieldState
  designFiles: CardFieldState
  specTodoCount: CardFieldState
  specChars: CardFieldState
  strongSignals: CardFieldState
  mediumSignals: CardFieldState
  weakSignals: CardFieldState
  postHooks: CardFieldState
}

/** The registration-side face the delivery card's slot entry injects. */
export interface DeliveryCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useDeliveryCard. */
    deliveryCard: SnapshotStore<DeliveryCardState>
  }
}

/** Bridges the `delivery` scope onto the card's staged form. */
export class DeliveryCardController {
  private readonly form: CardForm<DeliverySettings>
  private readonly store: SnapshotStore<DeliveryCardState>

  /** @param scope - the bound settings scope for the `delivery` namespace. */
  constructor(scope: SettingsScope<DeliverySettings>) {
    this.form = new CardForm(scope, [
      enumField(DELIVERY_FIELDS.enforcement, DELIVERY_ENFORCEMENTS),
      booleanField(DELIVERY_FIELDS.enabled),
      booleanField(DELIVERY_FIELDS.autoDetect),
      booleanField(DELIVERY_FIELDS.requireOpenspecForBugs),
      numberField(DELIVERY_FIELDS.maxReviewRounds),
      numberField(DELIVERY_FIELDS.designTodoCount),
      numberField(DELIVERY_FIELDS.designChars),
      numberField(DELIVERY_FIELDS.designFiles),
      numberField(DELIVERY_FIELDS.specTodoCount),
      numberField(DELIVERY_FIELDS.specChars),
      listField(DELIVERY_FIELDS.strongSignals),
      listField(DELIVERY_FIELDS.mediumSignals),
      listField(DELIVERY_FIELDS.weakSignals),
      listField(DELIVERY_FIELDS.postHooks),
    ])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): DeliveryCardState {
    return {
      ...this.form.shell(),
      enforcement: this.form.field(DELIVERY_FIELDS.enforcement),
      enabled: this.form.field(DELIVERY_FIELDS.enabled),
      autoDetect: this.form.field(DELIVERY_FIELDS.autoDetect),
      requireOpenspecForBugs: this.form.field(DELIVERY_FIELDS.requireOpenspecForBugs),
      maxReviewRounds: this.form.field(DELIVERY_FIELDS.maxReviewRounds),
      designTodoCount: this.form.field(DELIVERY_FIELDS.designTodoCount),
      designChars: this.form.field(DELIVERY_FIELDS.designChars),
      designFiles: this.form.field(DELIVERY_FIELDS.designFiles),
      specTodoCount: this.form.field(DELIVERY_FIELDS.specTodoCount),
      specChars: this.form.field(DELIVERY_FIELDS.specChars),
      strongSignals: this.form.field(DELIVERY_FIELDS.strongSignals),
      mediumSignals: this.form.field(DELIVERY_FIELDS.mediumSignals),
      weakSignals: this.form.field(DELIVERY_FIELDS.weakSignals),
      postHooks: this.form.field(DELIVERY_FIELDS.postHooks),
    }
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its form actions.
   */
  inject(): DeliveryCardFace {
    return { hooks: { deliveryCard: this.store }, ...this.form.actions() }
  }
}
