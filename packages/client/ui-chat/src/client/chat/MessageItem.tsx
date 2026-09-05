import { memo, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { PendingSubmission, PendingSubmissionPart } from '@deepseek-ai/dsh-api-session-controller/client'
import type { MessageImageSource } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { JsonBlock, projectUserText, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNodeOwnerProps, ChatNodeViewProps, ChatViewSlotProps } from '../contract/slots.ts'
import type { ModelRetryNode, TurnErrorNode, UserMessageNode } from '../contract/snapshot.ts'
import { CompactionItem } from './CompactionItem.tsx'
import { ContextInjectionRow } from './ContextInjectionRow.tsx'
import { MessageIconActions } from './MessageIconActions.tsx'
import css from './MessageItem.module.css'

type UserImage = Extract<UserMessageNode['content'][number], { type: 'image' }>

/** One interleaved run of a user bubble: consecutive text or consecutive images. */
type BubbleRun =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'images'; readonly images: readonly MessageImageSource[] }

/**
 * Commit a pending text run into `runs` and clear `textRun`; an empty run is
 * dropped. Shared by both run-folders so the text-commit step stays one
 * implementation.
 */
function commitTextRun(runs: BubbleRun[], textRun: string): string {
  if (textRun === '') return textRun
  runs.push({ kind: 'text', text: textRun })
  return ''
}

/**
 * Fold one ordered user-message content into interleaved text/image runs and
 * the non-text/image tail, preserving the composer's document order so images
 * render between their surrounding text instead of all before it.
 */
function contentRuns(content: readonly unknown[]): {
  runs: readonly BubbleRun[]
  text: string
  rest: unknown[]
} {
  const runs: BubbleRun[] = []
  const rest: unknown[] = []
  const textParts: string[] = []
  let textRun = ''
  let imageRun: { attachment: UserImage['attachment'] }[] = []
  const flushImages = (): void => {
    if (imageRun.length === 0) return
    runs.push({ kind: 'images', images: imageRun.map(({ attachment }) => ({ attachment })) })
    imageRun = []
  }
  for (const block of content) {
    const b = block as { type?: string; text?: string; attachment?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') {
      flushImages()
      textRun += b.text
      textParts.push(b.text)
    } else if (b.type === 'image' && b.attachment !== undefined) {
      textRun = commitTextRun(runs, textRun)
      imageRun.push({ attachment: (b as UserImage).attachment })
    } else {
      textRun = commitTextRun(runs, textRun)
      flushImages()
      rest.push(block)
    }
  }
  textRun = commitTextRun(runs, textRun)
  flushImages()
  return { runs, text: textParts.join(''), rest }
}

/**
 * Fold a local submission echo's ordered parts into the same interleaved runs
 * the durable user message renders, so the echo and its replacement agree.
 */
function partsRuns(parts: readonly PendingSubmissionPart[]): {
  runs: readonly BubbleRun[]
  text: string
} {
  const runs: BubbleRun[] = []
  const textParts: string[] = []
  let textRun = ''
  let imageRun: MessageImageSource[] = []
  const flushImages = (): void => {
    if (imageRun.length === 0) return
    runs.push({ kind: 'images', images: imageRun })
    imageRun = []
  }
  for (const part of parts) {
    if (part.type === 'text') {
      flushImages()
      textRun += part.text
      textParts.push(part.text)
    } else {
      textRun = commitTextRun(runs, textRun)
      imageRun.push({
        preview: {
          url: part.preview.previewUrl,
          ...(part.preview.name === undefined ? {} : { name: part.preview.name }),
          ...(part.preview.width === undefined ? {} : { width: part.preview.width }),
          ...(part.preview.height === undefined ? {} : { height: part.preview.height }),
        },
      })
    }
  }
  textRun = commitTextRun(runs, textRun)
  flushImages()
  return { runs, text: textParts.join('') }
}

function retrySeconds(milliseconds: number): number {
  return Math.max(1, Math.ceil(milliseconds / 1_000))
}

interface RetryCountdown {
  deadline: number
  seconds: number
}

function failureMessage(
  message: string,
  code: unknown,
  t: ChatViewSlotProps['t'],
): string {
  return code === 'AUTH' ? t('message.failure.auth') : message
}

function ModelRetryItem({ node, active, t }: {
  node: ModelRetryNode
  active: boolean
  t: ChatViewSlotProps['t']
}) {
  // Anchor the host-scheduled delay to this browser's first render of the
  // retry node. Host event time and Date.now() may belong to different clocks.
  const deadline = useMemo(() => Date.now() + node.delayMs, [node.delayMs, node.seq])
  const scheduledSeconds = retrySeconds(node.delayMs)
  const maximum = node.mode === 'normal' ? node.maxRetries : '∞'
  const [countdown, setCountdown] = useState<RetryCountdown>(() => ({
    deadline,
    seconds: retrySeconds(deadline - Date.now()),
  }))
  const remainingSeconds = countdown.deadline === deadline
    ? countdown.seconds
    : retrySeconds(deadline - Date.now())

  useEffect(() => {
    if (!active) return
    const updateCountdown = (): number => {
      const next = retrySeconds(deadline - Date.now())
      setCountdown(current => (
        current.deadline === deadline && current.seconds === next
          ? current
          : { deadline, seconds: next }
      ))
      return next
    }
    if (updateCountdown() === 1) return
    const timer = window.setInterval(() => {
      if (updateCountdown() === 1) window.clearInterval(timer)
    }, 250)
    return () => { window.clearInterval(timer) }
  }, [active, deadline])

  const label = active
    ? t('message.retry.active')
    : node.retryState === 'cancelled'
      ? t('message.retry.cancelled')
      : node.retryState === 'started'
        ? t('message.retry.started')
        : t('message.retry.scheduled')
  const seconds = active ? remainingSeconds : scheduledSeconds

  return (
    <details className={css.retryRow} data-active={active || undefined}>
      <summary className={css.retrySummary}>
        <span className={css.retryText} role="status">
          {t('message.retry.status', { label, retry: node.retry, maximum, seconds })}
        </span>
      </summary>
      <div className={css.retryDetails}>
        <div>
          <span className={css.retryDetailLabel}>{t('message.retry.delay')}</span>
          {t('duration.milliseconds', { milliseconds: Math.round(node.delayMs) })}
        </div>
        <div>
          <span className={css.retryDetailLabel}>{t('message.retry.failure')}</span>
          {failureMessage(node.failure.message, node.failure.code, t)}
        </div>
      </div>
    </details>
  )
}

/** Persistent, turn-positioned feedback for a terminal failure. */
function TurnErrorItem({ node, t }: {
  node: TurnErrorNode
  t: ChatViewSlotProps['t']
}) {
  return (
    <div className={css.turnErrorRow} role="status">
      <StateDot state="error" className={css.turnErrorDot} />
      <div className={css.turnErrorCopy}>
        <span className={css.turnErrorTitle}>{t('message.turnError')}</span>
        <span className={css.turnErrorMessage}>{failureMessage(node.message, node.code, t)}</span>
      </div>
      {node.code !== undefined && <code className={css.turnErrorCode}>{node.code}</code>}
    </div>
  )
}

/** Persistent, turn-positioned notice for a turn ended at the output-token cap. */
function TurnMaxTokensItem({ t }: {
  t: ChatViewSlotProps['t']
}) {
  return (
    <div className={css.turnErrorRow} role="status">
      <StateDot state="warning" className={css.turnErrorDot} />
      <div className={css.turnErrorCopy}>
        <span className={css.maxTokensTitle}>{t('message.maxTokens')}</span>
        <span className={css.turnErrorMessage}>{t('message.maxTokens.hint')}</span>
      </div>
    </div>
  )
}

/** Right-aligned bubble shared by user and steering rows. */
function UserStyleBubble({
  runs, text, rest, renderMessageImages, actions, pending = false, echo = false, referenceLabels = [], reveal = 'always', t,
}: {
  runs: readonly BubbleRun[]
  /** Joined text across all text runs; the actions row receives it. */
  text: string
  /** Non-text/image blocks rendered after the interleaved runs. */
  rest: readonly unknown[]
  renderMessageImages: ChatNodeOwnerProps['renderMessageImages']
  /** Optional IconActions (or similar) below the bubble; receives the joined text. */
  actions?: (text: string) => ReactNode
  /** Whether this is the Host-authoritative pre-admission steering projection. */
  pending?: boolean
  /** Whether this is a local submission echo (invisible marker; the echo renders exactly like its durable replacement). */
  echo?: boolean
  /** Exact session mention labels associated by the adjacent recall node. */
  referenceLabels?: readonly string[]
  /** Whole actions-row visibility: earlier rows reveal on hover, the latest stays shown (turn tails' gate). */
  reveal?: 'always' | 'hover'
  t: ChatViewSlotProps['t']
}): ReactNode {
  const truncated = (total: number): string => t('json.truncated', { total })
  const showTail = rest.length > 0
  return (
    <div
      className={css.userRow}
      data-pending-steering={pending || undefined}
      data-submission-echo={echo || undefined}
      data-actions-reveal={reveal}
    >
      <div className={css.userStack}>
        {runs.map((run, index) => run.kind === 'text'
          ? <div key={`text${index}`} className={css.bubble}>{projectUserText(run.text, referenceLabels)}</div>
          : renderMessageImages({ images: run.images, align: 'end' }))}
        {showTail && <div className={css.bubble}>
          {rest.map((block, i) => <JsonBlock key={i} label={t('message.extraBlock')} payload={block} truncatedLabel={truncated} />)}
        </div>}
        {referenceLabels.length > 0 && (
          <div className={css.referenceSummary}>
            {t('message.referenceSummary', { labels: referenceLabels.join(t('message.referenceSeparator')) })}
          </div>
        )}
      </div>
      {actions?.(text)}
    </div>
  )
}

/**
 * Render one Host-authoritative pending steering item with the same visual
 * language as its eventual durable transcript node.
 * @param props - Pending message content and conversation translator.
 * @returns the pending steering bubble.
 */
export function PendingSteeringBubble({ content, renderMessageImages, t }: {
  content: readonly unknown[]
  renderMessageImages: ChatNodeOwnerProps['renderMessageImages']
  t: ChatViewSlotProps['t']
}): ReactNode {
  const { runs, text, rest } = contentRuns(content)
  return (
    <UserStyleBubble
      runs={runs}
      text={text}
      rest={rest}
      renderMessageImages={renderMessageImages}
      pending
      t={t}
      actions={text => (
        <MessageIconActions
          text={text}
          clock="start"
          className={css.actions}
          t={t}
        />
      )}
    />
  )
}

/**
 * Render one local submission echo with the exact visual language of the
 * durable user node that replaces it: draft text plus object-URL previews,
 * visible from the submit click until the durable `user/message` (or its
 * queue occurrence) renders.
 * @param props - the session snapshot's pending submission and render seats.
 * @returns the echoed user bubble.
 */
export function PendingSubmissionBubble({ submission, renderMessageImages, t }: {
  submission: PendingSubmission
  renderMessageImages: ChatNodeOwnerProps['renderMessageImages']
  t: ChatViewSlotProps['t']
}): ReactNode {
  const { runs, text } = useMemo(() => partsRuns(submission.parts), [submission.parts])
  return (
    <UserStyleBubble
      runs={runs}
      text={text}
      rest={[]}
      renderMessageImages={renderMessageImages}
      echo
      t={t}
      actions={text => (
        <MessageIconActions
          text={text}
          time={submission.time}
          clock="start"
          className={css.actions}
          t={t}
        />
      )}
    />
  )
}

/** User and admitted-steering keyed Chat renderer. */
export const UserMessageNodeView = memo(function UserMessageNodeView({
  node, renderMessageImages, useChat, t,
}: ChatNodeViewProps<'user' | 'steering'>) {
  const data = node.data
  // The transcript's last user-authored row keeps its actions row shown, the
  // same recency gate turn tails use; earlier rows reveal on hover.
  const isLatestUserRow = useChat((snapshot) => {
    for (let index = snapshot.order.length - 1; index >= 0; index -= 1) {
      const candidate = snapshot.nodes.get(snapshot.order[index] ?? '')
      if (candidate?.kind === 'user' || candidate?.kind === 'steering') return candidate.key === node.key
    }
    return true
  })
  const { runs, text, rest } = contentRuns(data.content)
  return (
    <UserStyleBubble
      runs={runs}
      text={text}
      rest={rest}
      renderMessageImages={renderMessageImages}
      {...data.referenceLabels === undefined ? {} : { referenceLabels: data.referenceLabels }}
      reveal={isLatestUserRow ? 'always' : 'hover'}
      t={t}
      actions={text => (
        <MessageIconActions
          text={text}
          time={data.time}
          clock="start"
          className={css.actions}
          t={t}
        />
      )}
    />
  )
})

/** Injected-context keyed Chat renderer. */
export const ContextMessageNodeView = memo(function ContextMessageNodeView({ node, t }: ChatNodeViewProps<'context'>) {
  const data = node.data
  return (
    <ContextInjectionRow
      content={data.content}
      source={data.source}
      provenance={data.provenance}
      form={data.form}
      t={t}
    />
  )
})

/** Automatic compaction keyed Chat renderer. */
export const CompactionNodeView = memo(function CompactionNodeView({ node, t }: ChatNodeViewProps<'compaction'>) {
  return <CompactionItem node={node.data} t={t} />
})

/** Correlated retry-chain keyed Chat renderer. */
export const RetryNodeView = memo(function RetryNodeView({ node, t }: ChatNodeViewProps<'model-retry'>) {
  const data = node.data
  return <ModelRetryItem node={data.current} active={data.current.retryState === 'scheduled'} t={t} />
})

/** Terminal turn-error keyed Chat renderer. */
export const TurnErrorNodeView = memo(function TurnErrorNodeView({ node, t }: ChatNodeViewProps<'turn-error'>) {
  return <TurnErrorItem node={node.data} t={t} />
})

/** Max-tokens turn-end notice keyed Chat renderer. */
export const TurnMaxTokensNodeView = memo(function TurnMaxTokensNodeView({ t }: ChatNodeViewProps<'turn-max-tokens'>) {
  return <TurnMaxTokensItem t={t} />
})

/** Explicit unknown-surface keyed Chat renderer. */
export const UnknownNodeView = memo(function UnknownNodeView({ node, t }: ChatNodeViewProps<'unknown'>) {
  const data = node.data
  return (
    <div className={css.contextRow}>
      <JsonBlock
        label={t('message.unknownSurface', { type: data.type })}
        payload={data.data}
        truncatedLabel={total => t('json.truncated', { total })}
      />
    </div>
  )
})
