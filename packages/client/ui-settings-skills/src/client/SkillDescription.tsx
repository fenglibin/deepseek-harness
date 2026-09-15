/**
 * One skill's description inside the skills list.
 *
 * A description is routing guidance an author writes for the model, so it is
 * often several sentences long. The list clamps it to a few lines so one
 * verbose skill cannot push every other row off the pane, and offers an
 * expander only when the text genuinely overflows — which is a layout fact the
 * component measures rather than guesses from a character count.
 */

import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './SkillsSection.module.css'

/** Props of {@link SkillDescription}. */
export interface SkillDescriptionProps {
  /** The author's description, verbatim. */
  readonly text: string
  /** Copy for the expander that reveals the whole text. */
  readonly expandLabel: string
  /** Copy for the expander once the whole text is showing. */
  readonly collapseLabel: string
  /** Copy shown by the bubble when the entry carries no description at all. */
  readonly emptyLabel: string
}

/** The clamped description with its expander. */
export function SkillDescription({ text, expandLabel, collapseLabel, emptyLabel }: SkillDescriptionProps): ReactNode {
  const ref = useRef<HTMLParagraphElement>(null)
  const [overflowing, setOverflowing] = useState(false)
  const [expanded, setExpanded] = useState(false)

  // Measured only while clamped: the expanded element is taller than its own
  // limit by construction, so re-measuring it would retire the expander that
  // the reader needs to collapse it again.
  useLayoutEffect(() => {
    const node = ref.current
    if (node === null || expanded) return
    setOverflowing(node.scrollHeight > node.clientHeight + 1)
  }, [expanded, text])

  return (
    <div className={css.description}>
      <Tooltip label={() => (text === '' ? emptyLabel : text)} side="bottom" maxWidth={520}>
        <p ref={ref} className={expanded ? css.descriptionFull : css.descriptionClamped}>{text}</p>
      </Tooltip>
      {overflowing ? (
        <button className={css.link} type="button" onClick={() => { setExpanded(!expanded) }}>
          {expanded ? collapseLabel : expandLabel}
        </button>
      ) : null}
    </div>
  )
}
