import { useState, type KeyboardEvent, type MouseEvent } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import clsx from 'clsx'
import {
  IconApiOutline14, IconChevronDownOutline14, IconInspectOutline12, StateDot, TerminalBlock,
  useLifecycleExpansion,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '../../contract/slots.ts'
import {
  isSettledPersistentShellCall,
  localizeTerminalCardModel,
  terminalBlockLabels,
  terminalCardModel,
  terminalFailed,
} from '../models/terminal-card-model.ts'
import { toolRowModel, type ToolRowState } from '../models/tool-call-model.ts'
import { CONVERSATION_NS as NS } from '../../locale.ts'
import css from './bash-sample.module.css'

type BashRowProps = ToolCallViewProps & PropsLocale<'conversation'>

/**
 * Output-height stages of an OPEN row: ten lines by default, unbounded after
 * the reader asks for the rest. A closed row renders no output at all — it
 * reads as the same one-line summary every other tool row collapses to, so a
 * settled transcript is not a stack of short output boxes. The row's own
 * `data-stage` carries the stage to CSS, which derives the cap from the
 * terminal's line height so the two can never disagree.
 */
type OutputStage = 'full' | 'all'

/** Output rows the ten-line cap shows before the reader asks for the rest. */
const FULL_OUTPUT_LINES = 10

/** Count the rows a command's output occupies, trailing newline excluded. */
function outputLineCount(output: string | undefined): number {
  if (output === undefined || output === '') return 0
  return output.replace(/\n$/u, '').split('\n').length
}

function leadingFor(state: ToolRowState) {
  switch (state) {
    case 'error': return <StateDot state="error" />
    case 'stopped': return <StateDot state="warning" />
    // Running keeps the icon — the row sweep carries the in-flight signal.
    default: return <IconApiOutline14 size={14} />
  }
}

/** Visually hidden status — StateDot is aria-hidden; AT needs a text label. */
function stateStatus(state: ToolRowState, t: BashRowProps['t']): string | null {
  switch (state) {
    case 'running': return t('bash.running')
    case 'error': return t('bash.failed')
    case 'stopped': return t('bash.stopped')
    default: return null
  }
}

/** Renders expandable Bash output with an accessible lifecycle label. */
export function BashRow({ toolName, block, sessionId, useSessions, inspect, t }: BashRowProps) {
  const model = toolRowModel(toolName, block)
  // An omitted shell workdir is the session workspace; relative values resolve
  // against it before reaching the terminal primitive.
  const cwd = useSessions(list => list.byId[sessionId]?.cwd)
  const terminalModel = terminalCardModel(block, cwd)
  const terminal = terminalModel === null ? null : localizeTerminalCardModel(terminalModel, t)
  // A failing exit status is the terminal card's own error signal (the call
  // itself settles isError:false), surfaced as the row's red state dot.
  const state = model.state === 'ok' && terminalModel !== null && terminalFailed(terminalModel)
    ? 'error'
    : model.state
  const status = stateStatus(state, t)
  // A running command opens so the reader watches its output arrive; settling
  // folds the output away behind the one-line summary, like every other row.
  const [expanded, toggleExpanded] = useLifecycleExpansion({ running: state === 'running' })
  // Whether the open row has dropped its height cap for the rest of the output.
  const [unbounded, setUnbounded] = useState(false)
  // Execution failures and persistent-shell results have no terminal card.
  // Keep their recorded args and complete output reachable through the generic
  // body; background acknowledgements and malformed calls remain collapsed.
  const genericBody = terminal === null
    && (model.state === 'error' || isSettledPersistentShellCall(block))
    && (model.body !== null || model.output !== null)
  const expandable = terminal !== null || genericBody
  const open = expanded && expandable
  const failureLine = model.state === 'error' ? model.errorSummary : null
  const stage: OutputStage = unbounded ? 'all' : 'full'
  // Only an output taller than the open cap has a stage past it to reach.
  const outputLines = outputLineCount(terminal?.card.output)
  const showToggle = terminal !== null && outputLines > FULL_OUTPUT_LINES
  const toggleUnbounded = (event: MouseEvent<HTMLButtonElement>) => {
    // The button sits inside the row that expands on its own click; without
    // stopping the event the two handlers would cancel each other out.
    event.stopPropagation()
    // Asking for the rest opens the row first: a closed row shows no output,
    // so the ten-line cap is the next stage, and only from there unbounded.
    if (!expanded) {
      toggleExpanded()
      return
    }
    setUnbounded(v => !v)
  }
  // Keep Enter/Space on the toggle from bubbling to the row's keydown handler,
  // which would preventDefault() the key and expand instead of activating it.
  const stopRowToggle = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
  }
  const toggleFromKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!expandable || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    toggleExpanded()
  }
  const leading = open
    ? <IconChevronDownOutline14 className={css.chevron} />
    : expandable
      ? (
        <>
          <span className={css.iconIdle}>{leadingFor(state)}</span>
          <IconChevronDownOutline14 className={clsx(css.chevron, css.chevronHover)} />
        </>
      )
      : leadingFor(state)
  return (
    <div className={css.card}>
      <div
        className={css.root}
        data-sample="bash"
        data-variant="bash"
        data-state={state}
        data-expandable={expandable || undefined}
        role={expandable ? 'button' : undefined}
        tabIndex={expandable ? 0 : undefined}
        aria-expanded={expandable ? open : undefined}
        onClick={expandable ? toggleExpanded : undefined}
        onKeyDown={expandable ? toggleFromKeyboard : undefined}
      >
        <span className={css.leading}>{leading}</span>
        {status !== null && <span className={css.visuallyHidden}>{status}</span>}
        <span className={css.title}>{t(model.titleKey)}</span>
        <span className={css.sep} aria-hidden />
        <span className={clsx(css.summary, failureLine !== null && css.errorSummary)}>
          {failureLine ?? terminal?.description ?? model.summary}
        </span>
        {showToggle && (
          <button
            type="button"
            className={css.outputToggle}
            data-output-toggle
            onClick={toggleUnbounded}
            onKeyDown={stopRowToggle}
          >
            {t(unbounded ? 'bash.collapseAll' : 'bash.showAll')}
          </button>
        )}
      </div>
      {/* A closed row renders no output at all: a settled transcript is a list
          of one-line summaries, not a stack of short terminal boxes. Opening
          the row is what shows what the command printed, capped at ten lines
          until the reader asks for the rest. */}
      {terminal !== null
        ? open
          ? (
            <>
              <div className={css.terminalWrap} data-stage={stage}>
                <TerminalBlock
                  {...terminal.card}
                  maxLines={Infinity}
                  labels={terminalBlockLabels(t)}
                  className={css.terminal}
                />
              </div>
              {inspect !== undefined && (
                <button type="button" className={css.inspectButton} onClick={inspect}>
                  <IconInspectOutline12 />
                  {t('row.inspect')}
                </button>
              )}
            </>
          )
          : null
        : open
          ? (
            <div className={css.bodyWrap}>
              <div className={css.ioCard}>
                {model.body !== null && (
                  <div className={css.ioSection}>
                    <span className={css.ioLabel}>{t('row.input')}</span>
                    <span className={css.ioText}>{model.body}</span>
                  </div>
                )}
                {model.body !== null && model.output !== null && (
                  <span className={css.ioDivider} aria-hidden />
                )}
                {model.output !== null && (
                  <div className={css.ioSection}>
                    <span className={css.ioLabel}>{t('row.output')}</span>
                    <span className={css.ioText} data-error={state === 'error' || undefined}>
                      {model.output}
                    </span>
                  </div>
                )}
              </div>
              {inspect !== undefined && (
                <button type="button" className={css.inspectButton} onClick={inspect}>
                  <IconInspectOutline12 />
                  {t('row.inspect')}
                </button>
              )}
            </div>
          )
          : null}
    </div>
  )
}

/** Registers the standalone Bash conversation-row sample. */
export const bashToolviewSample = {
  name: 'bash-toolview-sample',
  inject: ['slots'],
  apply(ctx: Context): void {
    ctx.slots.inject('tool.call.toolview', () =>
      ctx.slots.register({ name: 'tool.call.toolview', key: 'bash', locale: NS }, BashRow))
  },
}
