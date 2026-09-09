import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PluginDescribeResult, PluginInventorySnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconChevronDownOutline14,
  IconSearchOutline16,
  Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PluginInventoryLocaleKey } from './locales.ts'
import { ReadmeDialog, type ReadmeDocument } from './ReadmeDialog.tsx'
import css from './PluginInventorySettingsTab.module.css'

type PluginInventoryEntry = PluginInventorySnapshot['entries'][number]
type AgentPresetGroup = NonNullable<PluginInventorySnapshot['agentPresets']>[number]
type AgentPresetRow = AgentPresetGroup['rows'][number]

/** Registration-side Remote face used by the section. */
export interface PluginInventorySettingsTabInjected {
  /** Read a current Host inventory snapshot. */
  list: () => Promise<PluginInventorySnapshot>
  /**
   * Enable or disable one global-plane entry, persisted by the tree that owns
   * it. Rejects when the Host refuses the write.
   */
  setEnabled: (entryId: PluginInventoryEntry['entryId'], enabled: boolean) => Promise<void>
  /**
   * Enable or disable one row of a locally authored preset's composition,
   * addressed by the id the composition file declares. Rejects for a shipped
   * preset, an unnamed row, or a row the deployment gates by expression.
   */
  setPresetRowDisabled: (agentPreset: string, entryId: string, disabled: boolean) => Promise<void>
  /**
   * Read the whole README one plugin module's package ships. Resolves to
   * undefined when the module publishes none, and rejects when the Host
   * refuses the read.
   */
  readme: (moduleName: string) => Promise<ReadmeDocument | undefined>
  /**
   * Read one plugin module's short description and README name on demand,
   * fetched only when a reader expands the card. Omits either key when the
   * package publishes none, and rejects when the Host refuses the read.
   */
  describe: (moduleName: string) => Promise<PluginDescribeResult>
  /**
   * Display name for one preset: shipped presets resolve through the
   * agent-preset dictionaries, user-authored ones keep their own metadata.
   */
  presetName: (preset: AgentPresetGroup) => string
}
type PluginFiberPhase = PluginInventoryEntry['fiberPhase']

/** Full component props assembled by the Settings slot renderer. */
export type PluginInventorySettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.pluginInventory'>
  & InjectFace<PluginInventorySettingsTabInjected>

type Translate = PluginInventorySettingsTabProps['t']

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly snapshot: PluginInventorySnapshot }

const PHASE_KEYS = {
  pending: 'pending',
  loading: 'loadingPhase',
  active: 'active',
  failed: 'failed',
  unloading: 'unloading',
} satisfies Record<Exclude<PluginFiberPhase, null>, PluginInventoryLocaleKey>

/** Localized accessible label for one root Fiber phase. */
function phaseLabel(phase: PluginFiberPhase, t: Translate): string {
  return phase === null ? t('unobserved') : t(PHASE_KEYS[phase])
}

/** Compact a module specifier without guessing whether its Loader id was generated. */
function moduleShortName(moduleName: string): string {
  const unscoped = moduleName.startsWith('@') ? moduleName.slice(moduleName.indexOf('/') + 1) : moduleName
  return unscoped
    .replace(/^cordis:/, '')
    .replace(/^cordis-plugin-/, '')
    .replace(/^dsh-(?:host-|client-)?/, '')
}

/** Whether one row's module name or entry id matches the catalog query. */
function matches(moduleName: string, entryId: string | null, normalizedQuery: string): boolean {
  if (normalizedQuery.length === 0) return true
  return [moduleName, ...entryId === null ? [] : [entryId]]
    .some(value => value.toLocaleLowerCase().includes(normalizedQuery))
}

/** The roster row shown when the preset switcher has no explicit choice. */
function fallbackPreset(presets: readonly AgentPresetGroup[]): AgentPresetGroup | undefined {
  return presets.find(preset => preset.isDefault) ?? presets[0]
}

/** The switcher's display label for one preset. */
function presetLabel(preset: AgentPresetGroup, t: Translate, presetName: (preset: AgentPresetGroup) => string): string {
  const name = presetName(preset)
  if (preset.broken !== undefined) return t('presetOptionBroken', { name })
  if (preset.isDefault) return t('presetOptionDefault', { name })
  return name
}

/** One expandable plugin card; the caller owns the trailing status content. */
function PluginCard({ rowKey, moduleName, entryId, trailing, ariaLabel, failed, expanded, onToggle, children }: {
  readonly rowKey: string
  readonly moduleName: string
  readonly entryId: string | null
  readonly trailing: ReactNode
  readonly ariaLabel: string
  readonly failed: boolean
  readonly expanded: string | null
  readonly onToggle: (key: string) => void
  readonly children: ReactNode
}): ReactNode {
  const open = expanded === rowKey
  const detailId = `plugin-details-${encodeURIComponent(rowKey)}`
  return (
    <li
      className={css.card}
      data-plugin-entry={entryId ?? undefined}
      data-plugin-module={moduleName}
      data-failed={failed ? 'true' : undefined}
      data-open={open ? 'true' : undefined}
    >
      <button
        className={css.cardContent}
        type="button"
        aria-expanded={open}
        aria-controls={detailId}
        aria-label={ariaLabel}
        onClick={() => { onToggle(rowKey) }}
      >
        <strong className={css.cardTitle} title={moduleName}>{moduleShortName(moduleName)}</strong>
        <span className={css.cardTrailing}>
          {trailing}
          <IconChevronDownOutline14 className={css.chevron} size={12} aria-hidden="true" />
        </span>
      </button>
      {open ? <div className={css.cardDetails} id={detailId}>{children}</div> : null}
    </li>
  )
}

/** On-demand description read for one expanded card. */
type DescribeState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly description?: string; readonly readme?: string }

/** Detail rows shared by every card: what the plugin is, then labeled facts. */
function CardFacts({ moduleName, moduleLabel, entryId, describe, onReadme, readmeLabel, facts }: {
  readonly moduleName: string
  readonly moduleLabel: string
  readonly entryId: string | null
  /** Fetch the short description and README name on demand, once the card opens. */
  readonly describe: (moduleName: string) => Promise<PluginDescribeResult>
  /** Open the whole README, named by the README file the describe returned. */
  readonly onReadme: ((readmeName: string) => void) | undefined
  /** Localized link text. */
  readonly readmeLabel: string
  readonly facts: readonly (readonly [label: string, value: ReactNode])[]
}): ReactNode {
  // The description is fetched only while the card is expanded, because
  // CardFacts mounts exactly when its card opens and unmounts when it closes.
  const [detail, setDetail] = useState<DescribeState>({ status: 'loading' })
  useEffect(() => {
    let current = true
    setDetail({ status: 'loading' })
    void describe(moduleName).then(
      (result) => { if (current) setDetail({ status: 'ready', ...result }) },
      () => { if (current) setDetail({ status: 'error' }) },
    )
    return () => { current = false }
  }, [describe, moduleName])

  const description = detail.status === 'ready' ? detail.description : undefined
  const readmeName = detail.status === 'ready' ? detail.readme : undefined
  return (
    <>
      {description === undefined
        ? null
        : <p className={css.description} data-plugin-description>{description}</p>}
      {readmeName === undefined || onReadme === undefined ? null : (
        <button
          type="button"
          className={css.readmeLink}
          data-plugin-readme={readmeName}
          onClick={() => { onReadme(readmeName) }}
        >
          {readmeLabel}
        </button>
      )}
      {entryId === null ? null : <code className={css.entryValue} data-loader-entry>{entryId}</code>}
      <dl className={css.details}>
        <div>
          <dt>{moduleLabel}</dt>
          <dd>{moduleName}</dd>
        </div>
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </>
  )
}

/** Status dot naming a live root-fiber phase; rows with no live fiber show none. */
function PhaseDot({ phase, t }: { readonly phase: NonNullable<PluginFiberPhase>; readonly t: Translate }): ReactNode {
  const status = phaseLabel(phase, t)
  return (
    <span
      className={css.statusDot}
      data-phase={phase}
      role="img"
      aria-label={status}
      title={status}
    />
  )
}

/** Enablement tag; `kind` selects the palette. */
function StateTag({ kind, label }: { readonly kind: string; readonly label: string }): ReactNode {
  return <span className={css.configTag} data-kind={kind}>{label}</span>
}

/** Enablement switch for one row; disabled while any write is in flight. */
function StateToggle({ label, enabled, busy, onToggle }: {
  readonly label: string
  readonly enabled: boolean
  readonly busy: boolean
  readonly onToggle: () => void
}): ReactNode {
  return (
    <div className={css.toggleRow}>
      <span className={css.toggleLabel}>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={label}
        className={enabled ? `${css.switch} ${css.switchOn}` : css.switch}
        disabled={busy}
        onClick={onToggle}
      >
        <span className={css.thumb} />
      </button>
    </div>
  )
}

/** Render the read-only plugin inventory: agent presets first, then the global plane. */
export function PluginInventorySettingsTab({
  list, setEnabled, setPresetRowDisabled, readme, describe, presetName, t,
}: PluginInventorySettingsTabProps): ReactNode {
  const sectionId = useId()
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const [request, setRequest] = useState(0)
  const [pendingEntry, setPendingEntry] = useState<string | null>(null)
  const [toggleFailed, setToggleFailed] = useState(false)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [chosenPreset, setChosenPreset] = useState<string | null>(null)
  const [readmeTarget, setReadmeTarget] = useState<{ moduleName: string; readmeName: string } | null>(null)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [presetOpen, setPresetOpen] = useState<boolean | null>(null)
  const [globalOpen, setGlobalOpen] = useState<boolean | null>(null)
  const [state, setState] = useState<ViewState>({ status: 'loading' })

  useEffect(() => {
    let current = true
    void Promise.resolve().then(() => list()).then(
      (snapshot) => { if (current) setState({ status: 'ready', snapshot }) },
      () => { if (current) setState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [list, request])

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const searching = normalizedQuery.length > 0
  const snapshot = state.status === 'ready' ? state.snapshot : undefined
  const presets = snapshot?.agentPresets ?? []
  const selected = presets.find(preset => preset.id === chosenPreset) ?? fallbackPreset(presets)

  /** Presets that actually enable a module, keyed by module name. */
  const enabledIn = useMemo(() => {
    const found = new Map<string, [AgentPresetGroup, ...AgentPresetGroup[]]>()
    for (const preset of presets) {
      for (const row of preset.rows) {
        if (row.enabled !== true) continue
        const groups = found.get(row.moduleName)
        if (groups === undefined) found.set(row.moduleName, [preset])
        else if (!groups.includes(preset)) groups.push(preset)
      }
    }
    return found
  }, [presets])

  const entries = snapshot?.entries ?? []
  const failedEntries: PluginInventoryEntry[] = []
  const regularEntries: PluginInventoryEntry[] = []
  for (const entry of entries) {
    if (entry.fiberPhase === 'failed') failedEntries.push(entry)
    else regularEntries.push(entry)
  }

  const entryMatch = (entry: PluginInventoryEntry): boolean => matches(entry.moduleName, entry.entryId, normalizedQuery)
  const rowMatch = (row: AgentPresetRow): boolean => matches(row.moduleName, row.entryId, normalizedQuery)
  const filteredFailed = failedEntries.filter(entryMatch)
  const filteredRegular = regularEntries.filter(entryMatch)
  const globalCount = filteredFailed.length + filteredRegular.length
  const selectedRows = selected === undefined ? [] : selected.rows.filter(rowMatch)
  const otherPresetMatches = searching
    ? presets.filter(preset => preset !== selected && preset.rows.some(rowMatch))
    : []
  const otherMatchCount = otherPresetMatches
    .reduce((total, preset) => total + preset.rows.filter(rowMatch).length, 0)

  const presetEffectiveOpen = searching || (presetOpen ?? true)
  const globalEffectiveOpen = searching || (globalOpen ?? presets.length === 0)
  const nothingMatches = searching && globalCount === 0 && selectedRows.length === 0
    && otherPresetMatches.length === 0

  const retry = (): void => {
    setState({ status: 'loading' })
    setRequest(value => value + 1)
  }
  const toggleRow = (key: string): void => {
    setExpanded(current => current === key ? null : key)
  }

  /**
   * Write one entry's enablement, then re-read: only a fresh snapshot knows
   * the row's effective state and its root-fiber phase after the change.
   */
  const applyToggle = async (rowKey: string, write: () => Promise<void>): Promise<void> => {
    setPendingEntry(rowKey)
    setToggleFailed(false)
    let refused = false
    try {
      await write()
    } catch {
      refused = true
    }
    // A write that settles after unmount has no screen left to report to.
    if (!mounted.current) return
    setPendingEntry(null)
    if (refused) {
      setToggleFailed(true)
      return
    }
    try {
      setState({ status: 'ready', snapshot: await list() })
    } catch {
      setState({ status: 'error' })
    }
  }

  /** Trailing status and detail facts for one row of the selected preset. */
  const presetRowCard = (preset: AgentPresetGroup, row: AgentPresetRow, index: number): ReactNode => {
    const key = `preset:${preset.id}:${String(index)}`
    const title = moduleShortName(row.moduleName)
    const rowId: string | null = row.entryId
    // A const binding keeps the `boolean` narrowing inside the toggle callback,
    // where a property read on `row` would re-widen to `boolean | 'conditional'`.
    const rowEnabled = row.enabled
    const failed = row.fiberPhase === 'failed'
    const stateText = failed
      ? t('failedTag')
      : row.enabled === true ? t('enabledTag') : row.enabled === false ? t('disabledTag') : t('conditionalTag')
    const kind = failed ? 'failed' : row.enabled === true ? 'enabled' : row.enabled === false ? 'disabled' : 'conditional'
    return (
      <PluginCard
        key={key}
        rowKey={key}
        moduleName={row.moduleName}
        entryId={row.entryId}
        failed={failed}
        expanded={expanded}
        onToggle={toggleRow}
        ariaLabel={`${title}, ${stateText}`}
        trailing={(
          <>
            {row.enabled === true && !failed && row.fiberPhase !== null
              ? <PhaseDot phase={row.fiberPhase} t={t} />
              : null}
            <StateTag kind={kind} label={stateText} />
          </>
        )}
      >
        <CardFacts
          moduleName={row.moduleName}
          moduleLabel={t('moduleLabel')}
          entryId={row.entryId}
          describe={describe}
          onReadme={(readmeName) => { setReadmeTarget({ moduleName: row.moduleName, readmeName }) }}
          readmeLabel={t('readmeMore')}
          facts={[
            [t('fromPreset'), presetName(preset)],
            [t('configuration'), stateText],
            ...row.fiberPhase === null ? [] : [[t('runtime'), phaseLabel(row.fiberPhase, t)] as const],
            ...row.condition === undefined ? [] : [[t('condition'), <code key="condition">{row.condition}</code>] as const],
          ]}
        />
        {/* A row the file names, a boolean enablement, and a row with no `!!js`
            gate give a switch something to write — the preset's trust does not,
            because stopping one row of a shipped composition is the same edit as
            stopping one row of the user's own. The third argument is the
            `disabled` flag, so flipping a row writes its current enablement: an
            enabled row is stopped, a disabled one is started. */}
        {rowId !== null && rowEnabled !== 'conditional' && row.condition === undefined
          ? (
            <StateToggle
              label={t('toggleLabel')}
              enabled={rowEnabled}
              busy={pendingEntry !== null}
              onToggle={() => {
                void applyToggle(key, () => setPresetRowDisabled(preset.id, rowId, rowEnabled))
              }}
            />
          )
          : null}
      </PluginCard>
    )
  }

  /** One global-plane row; a preset-provided row carries the presets that enable it. */
  const globalRowCard = (
    entry: PluginInventoryEntry,
    providers?: readonly [AgentPresetGroup, ...AgentPresetGroup[]],
  ): ReactNode => {
    const key = `global:${entry.entryId}`
    const title = moduleShortName(entry.moduleName)
    const failed = entry.fiberPhase === 'failed'
    const stateText = failed
      ? t('failedTag')
      : providers !== undefined ? t('presetEnabledTag') : t(entry.enabled ? 'enabledTag' : 'disabledTag')
    const kind = failed ? 'failed' : providers !== undefined ? 'preset' : entry.enabled ? 'enabled' : 'disabled'
    return (
      <PluginCard
        key={key}
        rowKey={key}
        moduleName={entry.moduleName}
        entryId={entry.entryId}
        failed={failed}
        expanded={expanded}
        onToggle={toggleRow}
        ariaLabel={`${title}, ${stateText}`}
        trailing={(
          <>
            {entry.enabled && !failed && entry.fiberPhase !== null
              ? <PhaseDot phase={entry.fiberPhase} t={t} />
              : null}
            <StateTag kind={kind} label={stateText} />
          </>
        )}
      >
        <CardFacts
          moduleName={entry.moduleName}
          moduleLabel={t('moduleLabel')}
          entryId={entry.entryId}
          describe={describe}
          onReadme={(readmeName) => { setReadmeTarget({ moduleName: entry.moduleName, readmeName }) }}
          readmeLabel={t('readmeMore')}
          facts={providers !== undefined
            ? [
              [t('configuration'), t('presetProvidedDetail')],
              [t('enabledIn'), (
                <span className={css.enabledIn}>
                  <span>{providers.map(preset => presetName(preset)).join(' · ')}</span>
                  <button
                    type="button"
                    className={css.jumpLink}
                    onClick={() => { setChosenPreset(providers[0].id) }}
                  >
                    {t('viewInPreset')}
                  </button>
                </span>
              )],
            ]
            : [
              [t('configuration'), t(entry.enabled ? 'enabledTag' : 'disabledTag')],
              ...entry.enabled ? [[t('runtime'), phaseLabel(entry.fiberPhase, t)] as const] : [],
            ]}
        />
        <StateToggle
          label={t('toggleLabel')}
          enabled={entry.enabled}
          busy={pendingEntry !== null}
          onToggle={() => { void applyToggle(key, () => setEnabled(entry.entryId, !entry.enabled)) }}
        />
      </PluginCard>
    )
  }

  return (
    <div className={css.section} aria-busy={state.status === 'loading'}>
      {state.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
      {toggleFailed ? <p className={css.toggleFailure} role="alert">{t('toggleError')}</p> : null}
      {state.status === 'error' ? (
        <div className={css.failure}>
          <p role="alert">{t('error')}</p>
          <button type="button" onClick={retry}>{t('retry')}</button>
        </div>
      ) : null}
      {snapshot !== undefined ? (
        <div className={css.catalog}>
          <label className={css.search}>
            <IconSearchOutline16 aria-hidden="true" />
            <span className={css.visuallyHidden}>{t('search')}</span>
            <input
              type="search"
              value={query}
              placeholder={t('search')}
              aria-label={t('search')}
              onChange={(event) => { setQuery(event.currentTarget.value) }}
            />
          </label>
          {entries.length === 0 && presets.length === 0 ? <p className={css.status}>{t('empty')}</p> : null}
          {nothingMatches ? <p className={css.status}>{t('emptySearch')}</p> : null}

          {selected !== undefined ? (
            <section className={css.group} data-plugin-scope="preset" data-preset-id={selected.id}>
              <div className={css.groupTitleRow}>
                <button
                  type="button"
                  className={css.groupToggle}
                  aria-expanded={presetEffectiveOpen}
                  aria-controls={`${sectionId}-preset`}
                  onClick={() => { setPresetOpen(!presetEffectiveOpen) }}
                >
                  <IconChevronDownOutline14 className={css.chevron} size={12} aria-hidden="true" />
                  <span className={css.groupTitle}>{t('presetTitle')}</span>
                </button>
                <div className={css.headerEnd}>
                  <Menu
                    open={switcherOpen}
                    onClose={() => { setSwitcherOpen(false) }}
                    items={presets.map(preset => ({ id: preset.id, label: presetLabel(preset, t, presetName) }))}
                    selectedId={selected.id}
                    onSelect={(id) => {
                      setSwitcherOpen(false)
                      setChosenPreset(id)
                    }}
                    align="end"
                    portal
                    anchor={(
                      <button
                        type="button"
                        className={css.switcher}
                        aria-haspopup="menu"
                        aria-expanded={switcherOpen}
                        aria-label={t('switcherLabel')}
                        onClick={() => { setSwitcherOpen(value => !value) }}
                      >
                        <span className={css.switcherLabel}>{presetLabel(selected, t, presetName)}</span>
                        <IconChevronDownOutline14 className={css.chevron} aria-hidden="true" />
                      </button>
                    )}
                  />
                </div>
              </div>
              <p className={css.groupSub}>
                {t('presetSubtitle')}
                <span data-preset-plugin-count={selectedRows.length}>
                  {` · ${String(selectedRows.length)} ${t('countUnit')}`}
                </span>
              </p>
              {presetEffectiveOpen ? (
                <div id={`${sectionId}-preset`} className={css.groupBody}>
                  {selected.broken !== undefined ? (
                    <p className={css.brokenNote} role="alert">{selected.broken}</p>
                  ) : null}
                  {selectedRows.length > 0 ? (
                    <ul className={css.cards}>
                      {selectedRows.map((row, index) => presetRowCard(selected, row, index))}
                    </ul>
                  ) : null}
                  {otherMatchCount > 0 ? (
                    <p className={css.hint}>
                      {t('matchesInOtherPresets', { count: String(otherMatchCount) })}
                      {otherPresetMatches.map(preset => (
                        <button
                          key={preset.id}
                          type="button"
                          className={css.jumpLink}
                          onClick={() => { setChosenPreset(preset.id) }}
                        >
                          {presetName(preset)}
                        </button>
                      ))}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </section>
          ) : null}

          {entries.length > 0 ? (
            <section className={css.group} data-plugin-scope="global">
              <div className={css.groupTitleRow}>
                <button
                  type="button"
                  className={css.groupToggle}
                  aria-expanded={globalEffectiveOpen}
                  aria-controls={`${sectionId}-global`}
                  onClick={() => { setGlobalOpen(!globalEffectiveOpen) }}
                >
                  <IconChevronDownOutline14 className={css.chevron} size={12} aria-hidden="true" />
                  <span className={css.groupTitle}>{t('globalTitle')}</span>
                </button>
              </div>
              <p className={css.groupSub}>
                {t('globalSubtitle')}
                <span data-plugin-count={globalCount}>{` · ${String(globalCount)} ${t('countUnit')}`}</span>
                {filteredFailed.length > 0 ? (
                  <span className={css.failedCount}>{filteredFailed.length} {t('failedCountLabel')}</span>
                ) : null}
              </p>
              {globalEffectiveOpen && globalCount > 0 ? (
                <ul className={css.cards} id={`${sectionId}-global`}>
                  {filteredFailed.map(entry => globalRowCard(entry))}
                  {filteredRegular.map(entry => globalRowCard(
                    entry,
                    entry.enabled ? undefined : enabledIn.get(entry.moduleName),
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}
        </div>
      ) : null}
      {readmeTarget === null ? null : (
        <ReadmeDialog
          moduleName={readmeTarget.moduleName}
          readmeName={readmeTarget.readmeName}
          read={readme}
          onClose={() => { setReadmeTarget(null) }}
          t={t}
        />
      )}
    </div>
  )
}
