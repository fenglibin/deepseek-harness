/**
 * The skills list for one scope pane.
 *
 * Each skill is a two-line row: its identity and actions share the first line,
 * and the author's description takes the second. A table was the wrong shape
 * once the description became a paragraph — fixed columns either squeezed the
 * description to a few words or pushed the actions off the pane.
 */

import type { ReactNode } from 'react'
import type { SkillAdminEntry, SkillRootView } from '@deepseek-ai/dsh-api-remotes/client'
import type { SkillsLocaleKey } from './locales.ts'
import { SkillDescription } from './SkillDescription.tsx'
import css from './SkillsSection.module.css'

/** Props of {@link SkillsList}. */
export interface SkillsListProps {
  /** Roots in the current scope, in precedence order. */
  readonly roots: readonly SkillRootView[]
  /** Section copy. */
  readonly t: (key: SkillsLocaleKey, params?: Record<string, string>) => string
  /** Whether a write is in flight, which disables every control. */
  readonly busy: boolean
  /** Flip one entry's enabled state. */
  readonly onToggle: (entry: SkillAdminEntry, enabled: boolean) => void
  /** Open the editor on one entry. */
  readonly onEdit: (entry: SkillAdminEntry) => void
  /** Ask to remove one entry. */
  readonly onRemove: (entry: SkillAdminEntry) => void
}

/** The skills list. */
export function SkillsList(props: SkillsListProps): ReactNode {
  const { roots, t, busy, onToggle, onEdit, onRemove } = props
  return (
    <ul className={css.list}>
      {roots.flatMap(root => root.entries.map(entry => (
        // Both classes, never one instead of the other: the frame comes from
        // `row` and only the dimming from `rowDisabled`, so replacing rather
        // than augmenting would take the border with it and leave a parked row
        // looking like it fell out of the list.
        <li
          className={entry.enabled === false ? `${css.row} ${css.rowDisabled}` : css.row}
          key={String(entry.entryId)}
        >
          <div className={css.rowHead}>
            <span className={css.name}>{entry.name}</span>
            {root.writable ? null : <span className={css.badgeMuted}>{t('readOnlyRoot')}</span>}
            {marksOf(entry, t)}
            <span className={css.grow} />
            <div className={css.actions}>
              {root.writable ? (
                <>
                  <button className={css.link} type="button" onClick={() => { onEdit(entry) }}>{t('edit')}</button>
                  <button className={css.link} type="button" onClick={() => { onRemove(entry) }}>{t('remove')}</button>
                </>
              ) : null}
              <label className={css.toggle}>
                <input
                  type="checkbox"
                  checked={entry.enabled !== false}
                  disabled={busy || !root.writable}
                  onChange={(event) => { onToggle(entry, event.target.checked) }}
                />
                <span>{entry.enabled === false ? t('enable') : t('disable')}</span>
              </label>
            </div>
          </div>
          <SkillDescription
            text={entry.description}
            expandLabel={t('expand')}
            collapseLabel={t('collapse')}
            emptyLabel={t('noDescription')}
          />
        </li>
      )))}
    </ul>
  )
}

/**
 * Render one entry's state marks.
 *
 * Shadowing and unloadability are facts discovery never surfaces, so the list
 * is the only place a reader learns either; a parked entry says so as well,
 * because the switch alone does not distinguish "off" from "never on".
 *
 * An entry is parked only when the Host says so explicitly: an absent flag
 * means the answer is unknown, and an entry that a list call returned is one
 * discovery read, which is the state the row would otherwise misreport.
 * @param entry - the row's entry.
 * @param t - section copy.
 * @returns the marks, or nothing while the entry is ordinary.
 */
function marksOf(
  entry: SkillAdminEntry,
  t: (key: SkillsLocaleKey, params?: Record<string, string>) => string,
): ReactNode {
  return (
    <>
      {entry.enabled === false ? <span className={css.badgeMuted}>{t('stateDisabled')}</span> : null}
      {entry.invalid === undefined ? null : <span className={css.badgeWarn} title={entry.invalid}>{t('entryInvalid')}</span>}
      {entry.shadowed ? <span className={css.badgeWarn}>{t('entryShadowed')}</span> : null}
    </>
  )
}
