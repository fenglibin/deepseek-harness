/** The delivery-discipline card: how requests are tiered and gated. */

import { useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { DeliveryHelp } from './DeliveryHelp.tsx'
import { ChoiceField, ListField, ValueField } from './fields.tsx'
import { PluginCard } from './PluginCard.tsx'
import type { DeliveryCardFace } from './delivery-card-controller.ts'
import type {} from './slot-contract.ts'

/** Props the renderer binds for the delivery card. */
export type DeliveryCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<DeliveryCardFace>

/**
 * Render the delivery-discipline card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function DeliveryCard(props: DeliveryCardProps) {
  const { t } = props
  const state = props.useDeliveryCard(snapshot => snapshot)
  const [helpOpen, setHelpOpen] = useState(false)
  const disabled = !state.writable

  /** Shared copy every control in this card needs. */
  const shared = {
    overriddenLabel: t('overridden'),
    resetLabel: t('reset'),
    disabled,
  }

  /** Bind one field's state to its control's edit and reset actions. */
  const bind = (field: string, value: typeof state.enforcement) => ({
    ...shared,
    ...value,
    onEdit: (text: string) => { props.edit(field, text) },
    onReset: () => { props.resetField(field) },
  })

  return (
    <>
      <PluginCard
        t={t}
        titleKey="deliveryTitle"
        descriptionKey="deliveryDescription"
        state={state}
        onSave={props.save}
        onDiscard={props.discard}
        onHelp={() => { setHelpOpen(true) }}
      >
        <ChoiceField
          id="plugin-config-delivery-enforcement"
          label={t('deliveryEnforcement')}
          help={t('deliveryHelpEnforcement')}
          hint={t('deliveryEnforcementHint')}
          invalidLabel={t('invalidEnum')}
          clearLabel={t('useDefault')}
          options={['stateful', 'advisory', 'off']}
          {...bind('enforcement', state.enforcement)}
        />
        <ChoiceField
          id="plugin-config-delivery-enabled"
          label={t('deliveryEnabled')}
          help={t('deliveryHelpEnabled')}
          hint={t('deliveryEnabledHint')}
          invalidLabel={t('invalidBoolean')}
          clearLabel={t('useDefault')}
          options={['true', 'false']}
          {...bind('enabled', state.enabled)}
        />
        <ChoiceField
          id="plugin-config-delivery-auto-detect"
          label={t('deliveryAutoDetect')}
          help={t('deliveryHelpAutoDetect')}
          hint={t('deliveryAutoDetectHint')}
          invalidLabel={t('invalidBoolean')}
          clearLabel={t('useDefault')}
          options={['true', 'false']}
          {...bind('autoDetect', state.autoDetect)}
        />
        <ChoiceField
          id="plugin-config-delivery-bugs"
          label={t('deliveryRequireOpenspecForBugs')}
          help={t('deliveryHelpRequireOpenspecForBugs')}
          hint={t('deliveryRequireOpenspecForBugsHint')}
          invalidLabel={t('invalidBoolean')}
          clearLabel={t('useDefault')}
          options={['true', 'false']}
          {...bind('requireOpenspecForBugs', state.requireOpenspecForBugs)}
        />
        <ValueField
          id="plugin-config-delivery-review-rounds"
          label={t('deliveryMaxReviewRounds')}
          help={t('deliveryHelpMaxReviewRounds')}
          hint={t('deliveryMaxReviewRoundsHint')}
          invalidLabel={t('invalidNumber')}
          numeric
          {...bind('maxReviewRounds', state.maxReviewRounds)}
        />
        <ValueField
          id="plugin-config-delivery-design-todos"
          label={t('deliveryDesignTodoCount')}
          help={t('deliveryHelpDesignTodoCount')}
          hint={t('deliveryDesignTodoCountHint')}
          invalidLabel={t('invalidNumber')}
          numeric
          {...bind('designThreshold.todoCount', state.designTodoCount)}
        />
        <ValueField
          id="plugin-config-delivery-design-chars"
          label={t('deliveryDesignChars')}
          help={t('deliveryHelpDesignChars')}
          hint={t('deliveryDesignCharsHint')}
          invalidLabel={t('invalidNumber')}
          numeric
          {...bind('designThreshold.descriptionChars', state.designChars)}
        />
        <ValueField
          id="plugin-config-delivery-design-files"
          label={t('deliveryDesignFiles')}
          help={t('deliveryHelpDesignFiles')}
          hint={t('deliveryDesignFilesHint')}
          invalidLabel={t('invalidNumber')}
          numeric
          {...bind('designThreshold.touchedFiles', state.designFiles)}
        />
        <ValueField
          id="plugin-config-delivery-spec-todos"
          label={t('deliverySpecTodoCount')}
          help={t('deliveryHelpSpecTodoCount')}
          hint={t('deliverySpecTodoCountHint')}
          invalidLabel={t('invalidNumber')}
          numeric
          {...bind('openspecThreshold.todoCount', state.specTodoCount)}
        />
        <ValueField
          id="plugin-config-delivery-spec-chars"
          label={t('deliverySpecChars')}
          help={t('deliveryHelpSpecChars')}
          hint={t('deliverySpecCharsHint')}
          invalidLabel={t('invalidNumber')}
          numeric
          {...bind('openspecThreshold.descriptionChars', state.specChars)}
        />
        <ListField
          id="plugin-config-delivery-strong-signals"
          label={t('deliveryStrongSignals')}
          help={t('deliveryHelpStrongSignals')}
          hint={t('deliveryStrongSignalsHint')}
          invalidLabel={t('listHint')}
          placeholder={t('useDefault')}
          {...bind('strongSignals', state.strongSignals)}
        />
        <ListField
          id="plugin-config-delivery-medium-signals"
          label={t('deliveryMediumSignals')}
          help={t('deliveryHelpMediumSignals')}
          hint={t('deliveryMediumSignalsHint')}
          invalidLabel={t('listHint')}
          placeholder={t('useDefault')}
          {...bind('mediumSignals', state.mediumSignals)}
        />
        <ListField
          id="plugin-config-delivery-weak-signals"
          label={t('deliveryWeakSignals')}
          help={t('deliveryHelpWeakSignals')}
          hint={t('deliveryWeakSignalsHint')}
          invalidLabel={t('listHint')}
          placeholder={t('useDefault')}
          {...bind('weakSignals', state.weakSignals)}
        />
        <ListField
          id="plugin-config-delivery-post-hooks"
          label={t('deliveryPostHooks')}
          help={t('deliveryHelpPostHooks')}
          hint={t('deliveryPostHooksHint')}
          invalidLabel={t('listHint')}
          placeholder={t('useDefault')}
          {...bind('postHooks', state.postHooks)}
        />
      </PluginCard>
      )
      <DeliveryHelp open={helpOpen} onClose={() => { setHelpOpen(false) }} t={t} />
    </>
  )
}
