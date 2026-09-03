/** Assistant reasoning disclosure, independent of Tool-call presentation. */
import { useEffect, useRef, useState } from 'react'
import { DisclosureRow, IconThinkOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { useThrottledVisualUpdate } from './use-throttled-visual-update.ts'
import a11yCss from './accessibility.module.css'
import css from './ReasoningRow.module.css'

function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

function latestLine(text: string): string {
  const visible = text.trimEnd()
  const newline = visible.lastIndexOf('\n')
  return newline === -1 ? visible : visible.slice(newline + 1)
}

/** Slack left between the reader's scroll offset and the bottom that still counts as following the tail. */
const FOLLOW_THRESHOLD_PX = 8

/**
 * Render one assistant reasoning block as the Think disclosure row.
 *
 * A streaming block opens on the reasoning itself and folds away the moment it
 * settles; a block that mounts already settled — every replayed history
 * message — stays collapsed behind its first line.
 * @param props.text - complete or streaming reasoning text.
 * @param props.running - whether this block is the streaming tail.
 * @param props.t - conversation locale seat for the running status.
 * @returns the reasoning disclosure.
 */
export function ReasoningRow({ text, running, t }: { text: string; running: boolean; t: ChatViewSlotProps['t'] }) {
  const [expanded, setExpanded] = useState(running)
  const summaryRef = useRef<HTMLSpanElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const wasRunning = useRef(running)
  const followTail = useRef(true)
  const summary = running ? latestLine(text) : firstLine(text)
  const scheduleSummaryScroll = useThrottledVisualUpdate(() => {
    const element = summaryRef.current
    if (element === null) return
    element.scrollLeft = running ? element.scrollWidth - element.clientWidth : 0
  })
  useEffect(() => {
    scheduleSummaryScroll()
  }, [running, scheduleSummaryScroll, summary])
  // Settling folds the block away on its own. Only the running -> settled
  // transition does it, so a reader who reopens a finished thought keeps it
  // open instead of having it snatched shut by the next render.
  useEffect(() => {
    if (wasRunning.current && !running) setExpanded(false)
    wasRunning.current = running
  }, [running])
  useEffect(() => {
    const element = bodyRef.current
    if (element === null || !followTail.current) return
    element.scrollTop = element.scrollHeight
  }, [text, expanded])
  // Scrolling up to re-read releases the tail, so a later chunk never yanks
  // the reader back down mid-sentence.
  const onBodyScroll = () => {
    const element = bodyRef.current
    if (element === null) return
    const remaining = element.scrollHeight - element.scrollTop - element.clientHeight
    followTail.current = remaining <= FOLLOW_THRESHOLD_PX
  }
  // Reopening resumes following: the reader asked to watch the thought again,
  // which for a streaming one means its newest line, not wherever a previous
  // scroll-up had left it.
  const toggleExpanded = () => {
    followTail.current = true
    setExpanded(value => !value)
  }

  return (
    <div className={css.root} data-variant="think" data-state={running ? 'running' : 'ok'}>
      {running && <span className={a11yCss.visuallyHidden}>{t('row.running')}</span>}
      <DisclosureRow
        rowClassName={css.row}
        leadingClassName={css.leading}
        titleClassName={css.title}
        chevronClassName={css.chevron}
        icon={<IconThinkOutline14 size={14} />}
        title={t('message.think')}
        open={expanded}
        expandable
        expandOnRowClick
        onToggle={toggleExpanded}
        collapsedContent={(
          <>
            <span className={css.separator} aria-hidden />
            <span ref={summaryRef} className={css.summary} data-follow-end={running || undefined}>{summary}</span>
          </>
        )}
      >
        <div ref={bodyRef} className={css.thinkBody} onScroll={onBodyScroll}>{text}</div>
      </DisclosureRow>
    </div>
  )
}
