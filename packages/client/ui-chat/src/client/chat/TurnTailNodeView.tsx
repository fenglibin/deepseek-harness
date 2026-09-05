import { memo, type ReactNode } from 'react'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the `turnUsage` projection key merge (whole-log per-turn usage).
import type {} from '@deepseek-ai/dsh-token-meter/client'
import type { ChatNodeViewProps, TurnTailOwnerProps } from '../contract/slots.ts'
import { MessageIconActions } from './MessageIconActions.tsx'
import { TurnTimePanel, TurnUsagePanel } from './TurnUsagePanel.tsx'
import { assistantText } from './turn-assistant.ts'
import css from './TurnTailNodeView.module.css'

type TurnTailNodeViewProps = ChatNodeViewProps<'turn-tail'>
  & PropsRenderSlots<'conversation.chat.turnTail' | 'conversation.chat.assistant-actions'>

/** Turn-local actions and feature tail over the Location index, independent of Assistant placement. */
export const TurnTailNodeView = memo(function TurnTailNodeView({
  node, openFile, forkAt, renderSlot, renderSlotChain, t, useChat, useProjection,
}: TurnTailNodeViewProps) {
  const data = node.data
  // Whole-log per-turn usage wins over the window fold: a turn whose
  // `turn/start` is paged out still discloses its billed usage from the
  // projection, while an assembly without the unit falls back to the
  // window-derived value.
  const projectedUsage = useProjection('turnUsage')
  const tokenUsage = projectedUsage?.turns[String(data.turn)] ?? data.tokenUsage
  const hasLaterChatNode = useChat(snapshot =>
    snapshot.locations.getTurn(data.turn).at(-1) !== node.key)
  // Turn-tail rows always disclose their actions: a past turn's billed usage,
  // copy, feedback and wall-time must stay legible without forcing the user to
  // chase the row with the cursor. The recency gate still applies to the last
  // user-authored row (rendered by UserMessageNodeView).
  const turn = node.location.kind === 'turn' || node.location.kind === 'step'
    ? node.location.turn
    : undefined
  if (turn === undefined) return null
  const closing = data.closing
  const owner: TurnTailOwnerProps = { turn, seq: closing?.finalNode.seq ?? data.seq, openFile }
  const tail = renderSlotChain('conversation.chat.turnTail', owner)
  const runMs = turn.start === undefined || turn.end === undefined
    ? undefined
    : Math.max(0, turn.end.time - turn.start.time)
  // Usage + time pills survive a turn with no text-bearing Assistant (the
  // error/abort path). They are the only artefacts that disclose without an
  // Assistant text to copy, branch from, or annotate; the parent TurnError
  // node already carries the failure surface for that case.
  const usageBlock: ReactNode = (tokenUsage === undefined && runMs === undefined)
    ? null
    : (
      <>
        {tokenUsage !== undefined && <TurnUsagePanel usage={tokenUsage} t={t} />}
        {runMs !== undefined && (
          <TurnTimePanel
            runMs={runMs}
            tokensPerSecond={data.tokensPerSecond}
            ttftMs={data.ttftMs}
            t={t}
          />
        )}
      </>
    )
  // A turn with no closing Assistant (turn-end reason: error or aborted before
  // any text finalized) renders only the usage pills: there is no Assistant
  // text to copy, branch from, or annotate. The icon row still mounts so the
  // pills keep their row alignment with the normal-footprint turns below.
  if (closing === null) {
    if (usageBlock === null) return tail === null ? null : <div className={css.root}>{tail}</div>
    return (
      <div
        className={css.root}
        data-turn-tail={data.turn}
        data-actions-reveal="always"
      >
        {tail}
        <MessageIconActions
          text=""
          time={data.time}
          clock="end"
          className={css.actions}
          usageAction={usageBlock}
          t={t}
        />
      </div>
    )
  }
  // Interruption-frozen partials carry no messageId, so they address no
  // durable message and contribute no per-message actions.
  const messageId = closing.finalNode.messageId
  const assistantActions = messageId === undefined
    ? null
    : renderSlot('conversation.chat.assistant-actions', { messageId })
  return (
    <div
      className={css.root}
      data-turn-tail={data.turn}
      data-actions-reveal="always"
    >
      {tail}
      <MessageIconActions
        text={assistantText(closing.blocks)}
        time={closing.time}
        clock="end"
        onBranch={() => { forkAt(closing.finalNode.seq) }}
        branchUnavailable={data.branchUnavailable || hasLaterChatNode}
        className={css.actions}
        extraActions={assistantActions}
        usageAction={usageBlock}
        t={t}
      />
    </div>
  )
})
