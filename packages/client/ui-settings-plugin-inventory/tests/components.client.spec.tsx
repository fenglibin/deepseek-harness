// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginInventorySettingsTab } from '../src/client/PluginInventorySettingsTab.tsx'
import type {
  PluginInventorySettingsTabInjected,
  PluginInventorySettingsTabProps,
} from '../src/client/PluginInventorySettingsTab.tsx'
import { zh, type PluginInventoryLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

type Snapshot = Awaited<ReturnType<PluginInventorySettingsTabInjected['list']>>
const t = ((key: PluginInventoryLocaleKey, params?: Record<string, string>): string =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, value),
    zh[key],
  )) as PluginInventorySettingsTabProps['t']

function props(
  list: PluginInventorySettingsTabInjected['list'],
  presetName: PluginInventorySettingsTabInjected['presetName'] = preset => preset.name ?? preset.id,
  setEnabled: PluginInventorySettingsTabInjected['setEnabled'] = () => Promise.resolve(),
  setPresetRowDisabled: PluginInventorySettingsTabInjected['setPresetRowDisabled'] = () => Promise.resolve(),
  readme: PluginInventorySettingsTabInjected['readme'] = () => Promise.resolve(undefined),
  describe: PluginInventorySettingsTabInjected['describe'] = () => Promise.resolve({}),
): PluginInventorySettingsTabProps {
  return {
    t,
    list,
    setEnabled,
    setPresetRowDisabled,
    readme,
    describe,
    presetName,
  } as PluginInventorySettingsTabProps
}

/** A deployment with a roster: one failed global row, two preset-provided rows. */
const SNAPSHOT = {
  entries: [
    { entryId: 'telemetry', moduleName: '@fixture/telemetry', enabled: true, fiberPhase: 'failed' },
    {
      entryId: 'timer',
      moduleName: 'cordis:timer',
      enabled: true,
      fiberPhase: 'active',
    },
    { entryId: '8a1b2c3d', moduleName: '@deepseek-ai/cordis-plugin-hmr', enabled: true, fiberPhase: 'active' },
    { entryId: 'unobserved', moduleName: '@fixture/unobserved-name', enabled: true, fiberPhase: null },
    { entryId: 'bash-host', moduleName: '@deepseek-ai/dsh-tool-bash', enabled: false, fiberPhase: null },
    { entryId: 'fs-host', moduleName: '@deepseek-ai/dsh-tool-fs', enabled: false, fiberPhase: null },
    { entryId: 'dormant', moduleName: '@fixture/dormant', enabled: false, fiberPhase: null },
  ],
  agentPresets: [
    {
      id: 'standard',
      trust: 'system',
      name: '标准模式',
      isDefault: true,
      rows: [
        { entryId: 'bash', moduleName: '@deepseek-ai/dsh-tool-bash', enabled: true, fiberPhase: 'active' },
        { entryId: 'fs', moduleName: '@deepseek-ai/dsh-tool-fs', enabled: true, fiberPhase: null },
        {
          entryId: 'pwsh',
          moduleName: '@fixture/pwsh',
          enabled: 'conditional',
          condition: 'process.platform === \'win32\'',
          fiberPhase: null,
        },
        { entryId: 'codex', moduleName: '@fixture/codex', enabled: false, fiberPhase: null },
        { entryId: 'crashy', moduleName: '@fixture/crashy', enabled: true, fiberPhase: 'failed' },
        { entryId: null, moduleName: '@fixture/anonymous', enabled: true, fiberPhase: null },
      ],
    },
    {
      id: 'ptc',
      trust: 'system',
      isDefault: false,
      rows: [
        { entryId: 'bash', moduleName: '@deepseek-ai/dsh-tool-bash', enabled: true, fiberPhase: null },
        { entryId: 'bash-fork', moduleName: '@deepseek-ai/dsh-tool-bash', enabled: true, fiberPhase: null },
        { entryId: 'fs', moduleName: '@deepseek-ai/dsh-tool-fs', enabled: 'conditional', fiberPhase: null },
      ],
    },
    { id: 'shattered', trust: 'user', name: '坏预设', isDefault: false, broken: 'the composition file is missing', rows: [] },
  ],
} as unknown as Snapshot

async function renderReady(snapshot: Snapshot = SNAPSHOT): Promise<ReturnType<typeof render>> {
  const view = render(<PluginInventorySettingsTab {...props(async () => snapshot)} />)
  await screen.findByRole('searchbox', { name: zh.search })
  return view
}

const globalToggle = (): HTMLElement =>
  screen.getByRole('button', { name: (name: string) => name.startsWith(zh.globalTitle) })

describe('PluginInventorySettingsTab', () => {
  it('shows the default preset first and keeps the global plane collapsed', async () => {
    const view = await renderReady()

    const switcher = screen.getByRole('button', { name: zh.switcherLabel })
    expect(switcher.textContent).toBe('标准模式（默认）')
    fireEvent.click(switcher)
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      '标准模式（默认）',
      'ptc',
      '坏预设（加载失败）',
    ])
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0)
    expect(screen.getByText(zh.presetSubtitle)).toBeTruthy()
    expect(view.container.querySelector('[data-preset-plugin-count]')?.getAttribute('data-preset-plugin-count')).toBe('6')

    // Only the preset group lists rows while the global plane stays collapsed.
    expect(screen.getAllByRole('listitem')).toHaveLength(6)
    expect(screen.getAllByText(zh.enabledTag)).toHaveLength(3)
    expect(screen.getByText(zh.conditionalTag)).toBeTruthy()
    expect(screen.getByText(zh.disabledTag)).toBeTruthy()
    expect(screen.getByText(zh.failedTag)).toBeTruthy()
    expect(screen.getByRole('img', { name: '运行中' })).toBeTruthy()
    // No live fiber, no dot: file-state rows carry only their enablement tag.
    expect(screen.queryByRole('img', { name: '未运行' })).toBeNull()

    expect(globalToggle().getAttribute('aria-expanded')).toBe('false')
    expect(view.container.querySelector('[data-plugin-count]')?.getAttribute('data-plugin-count')).toBe('7')
    expect(screen.getByText(`1 ${zh.failedCountLabel}`)).toBeTruthy()

    // A preset row expands into its provenance facts.
    fireEvent.click(screen.getByRole('button', { name: 'pwsh, 条件启用' }))
    expect(screen.getByText(zh.fromPreset)).toBeTruthy()
    expect(screen.getByText('标准模式')).toBeTruthy()
    expect(screen.getByText(zh.condition)).toBeTruthy()
    expect(screen.getByText('process.platform === \'win32\'')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'pwsh, 条件启用' }))
    expect(screen.queryByText(zh.condition)).toBeNull()

    // A failed preset row names its runtime state instead of a condition.
    fireEvent.click(screen.getByRole('button', { name: 'crashy, 启动失败' }))
    // The row's tag and its runtime detail read alike in this locale, so the
    // assertion names the detail's own value.
    expect(screen.getByText(zh.runtime).nextElementSibling?.textContent).toBe('启动失败')

    // A row declaring no id has no Loader identity line, only its module.
    fireEvent.click(screen.getByRole('button', { name: 'anonymous, 已启用' }))
    expect(view.container.querySelector('[data-loader-entry]')).toBeNull()
    expect(screen.getByText(zh.moduleLabel).nextElementSibling?.textContent).toBe('@fixture/anonymous')
  })

  it('fetches a description on demand when a card expands and none for a silent package', async () => {
    const describe = vi.fn(async (moduleName: string): Promise<{ description?: string; readme?: string }> => {
      if (moduleName === '@fixture/pwsh') return { description: 'PowerShell 执行器', readme: 'README.zh.md' }
      if (moduleName === 'cordis:timer') return { description: '计时器能力', readme: 'README.zh.md' }
      return {}
    })
    const view = render(
      <PluginInventorySettingsTab {...props(async () => SNAPSHOT, undefined, undefined, undefined, undefined, describe)} />,
    )
    await screen.findByRole('searchbox', { name: zh.search })

    // Expanding a preset row fetches its description on demand.
    fireEvent.click(screen.getByRole('button', { name: 'pwsh, 条件启用' }))
    expect(await screen.findByText('PowerShell 执行器')).toBeTruthy()
    expect(describe).toHaveBeenCalledWith('@fixture/pwsh')

    // A global row fetches its own description on demand.
    fireEvent.click(globalToggle())
    fireEvent.click(screen.getByRole('button', { name: 'timer, 已启用' }))
    expect(await screen.findByText('计时器能力')).toBeTruthy()

    // A row whose package published nothing renders no description paragraph.
    fireEvent.click(screen.getByRole('button', { name: 'dormant, 已停用' }))
    expect(view.container.querySelector('[data-plugin-description]')).toBeNull()
  })

  it('shows the read-more link only where a README exists, then renders it', async () => {
    const describe = vi.fn(async (moduleName: string) =>
      moduleName === '@fixture/pwsh' ? { readme: 'README.zh.md' } : {})
    const read = vi.fn(async (): Promise<{ name: string; text: string }> => ({
      name: 'README.zh.md',
      text: '# timer\n\n| 列 | 值 |\n|---|---|\n| 1 | 2 |\n',
    }))
    render(
      <PluginInventorySettingsTab {...props(async () => SNAPSHOT, undefined, undefined, undefined, read, describe)} />,
    )
    await screen.findByRole('searchbox', { name: zh.search })

    // A preset row with a README carries the link once the describe returns.
    fireEvent.click(screen.getByRole('button', { name: 'pwsh, 条件启用' }))
    fireEvent.click(await screen.findByRole('button', { name: zh.readmeMore }))
    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect(read).toHaveBeenCalledWith('@fixture/pwsh')
    // The GFM table is rendered as a real table, not pipe text.
    expect(screen.getByRole('table')).toBeTruthy()
    expect(screen.getByRole('cell', { name: '2' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.readmeClose }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('toggles a row the user authored and offers no switch where no write is possible', async () => {
    let rowEnabled = false
    const list = vi.fn(async (): Promise<Snapshot> => ({
      ...SNAPSHOT,
      agentPresets: [{
        id: 'mine',
        trust: 'user',
        isDefault: false,
        rows: [
          { entryId: 'fs', moduleName: '@fixture/fs', enabled: rowEnabled, fiberPhase: null },
          {
            entryId: 'pwsh',
            moduleName: '@fixture/pwsh',
            enabled: 'conditional',
            condition: 'process.platform === \'win32\'',
            fiberPhase: null,
          },
          // An evaluated `!!js` gate still carries its condition, so it is as
          // unwritable as an unevaluated one.
          { entryId: 'gate', moduleName: '@fixture/gate', enabled: false, condition: 'x', fiberPhase: null },
          { entryId: null, moduleName: '@fixture/anon', enabled: true, fiberPhase: null },
        ],
      }],
    }))
    const setPresetRowDisabled = vi.fn<PluginInventorySettingsTabInjected['setPresetRowDisabled']>()
      .mockResolvedValue(undefined)
    render(<PluginInventorySettingsTab {...props(list, undefined, undefined, setPresetRowDisabled)} />)
    await screen.findByRole('searchbox', { name: zh.search })

    // Enabling a stopped row writes `disabled = false` (its current enablement).
    fireEvent.click(screen.getByRole('button', { name: 'fs, 已停用' }))
    expect(screen.getByRole('switch', { name: zh.toggleLabel }).getAttribute('aria-checked')).toBe('false')
    rowEnabled = true
    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: zh.toggleLabel }))
    })
    expect(setPresetRowDisabled).toHaveBeenCalledWith('mine', 'fs', false)
    expect(await screen.findByRole('button', { name: 'fs, 已启用' })).toBeTruthy()

    // Stopping the now-running row writes `disabled = true`.
    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: zh.toggleLabel }))
    })
    expect(setPresetRowDisabled).toHaveBeenLastCalledWith('mine', 'fs', true)

    // A `!!js` gate and an id-less row give a switch nothing to write.
    fireEvent.click(screen.getByRole('button', { name: 'pwsh, 条件启用' }))
    expect(screen.queryByRole('switch')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'gate, 已停用' }))
    expect(screen.queryByRole('switch')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'anon, 已启用' }))
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('offers a switch on a row of a preset the deployment ships', async () => {
    const codexEnabled = false
    const list = vi.fn(async (): Promise<Snapshot> => ({
      ...SNAPSHOT,
      agentPresets: [{
        id: 'standard',
        trust: 'system',
        isDefault: true,
        rows: [{ entryId: 'codex', moduleName: '@fixture/codex', enabled: codexEnabled, fiberPhase: null }],
      }],
    }))
    const setPresetRowDisabled = vi.fn<PluginInventorySettingsTabInjected['setPresetRowDisabled']>()
      .mockResolvedValue(undefined)
    render(<PluginInventorySettingsTab {...props(list, undefined, undefined, setPresetRowDisabled)} />)
    await screen.findByRole('searchbox', { name: zh.search })

    fireEvent.click(screen.getByRole('button', { name: 'codex, 已停用' }))
    const toggle = screen.getByRole('switch', { name: zh.toggleLabel })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    await act(async () => { fireEvent.click(toggle) })
    expect(setPresetRowDisabled).toHaveBeenCalledWith('standard', 'codex', false)
  })

  it('toggles a global plugin and re-reads the snapshot after the write', async () => {
    let dormantEnabled = false
    const list = vi.fn(async (): Promise<Snapshot> => ({
      ...SNAPSHOT,
      entries: SNAPSHOT.entries.map(entry => entry.entryId === 'dormant'
        ? { ...entry, enabled: dormantEnabled }
        : entry),
    }))
    const gate = Promise.withResolvers<undefined>()
    const setEnabled = vi.fn<PluginInventorySettingsTabInjected['setEnabled']>()
      .mockReturnValueOnce(gate.promise)
      .mockResolvedValue(undefined)
    render(<PluginInventorySettingsTab {...props(list, undefined, setEnabled)} />)
    await screen.findByRole('searchbox', { name: zh.search })
    fireEvent.click(globalToggle())
    fireEvent.click(screen.getByRole('button', { name: 'dormant, 已停用' }))

    const toggle = screen.getByRole('switch', { name: zh.toggleLabel })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    dormantEnabled = true
    await act(async () => { fireEvent.click(toggle) })
    expect(setEnabled).toHaveBeenCalledWith('dormant', true)
    // The switch stays put while the write is in flight.
    expect(screen.getByRole('switch', { name: zh.toggleLabel })).toHaveProperty('disabled', true)

    await act(async () => { gate.resolve(undefined) })
    expect(await screen.findByRole('button', { name: 'dormant, 已启用' })).toBeTruthy()

    // Toggling back writes the opposite value against the re-read snapshot.
    dormantEnabled = false
    await act(async () => { fireEvent.click(screen.getByRole('switch', { name: zh.toggleLabel })) })
    expect(setEnabled).toHaveBeenLastCalledWith('dormant', false)
    expect(await screen.findByRole('button', { name: 'dormant, 已停用' })).toBeTruthy()
  })

  it('falls back to the failure state when the re-read after a write fails', async () => {
    let failRead = false
    const list = vi.fn(async (): Promise<Snapshot> => {
      if (failRead) throw new Error('host gone')
      return SNAPSHOT
    })
    const setEnabled = vi.fn<PluginInventorySettingsTabInjected['setEnabled']>().mockResolvedValue(undefined)
    render(<PluginInventorySettingsTab {...props(list, undefined, setEnabled)} />)
    await screen.findByRole('searchbox', { name: zh.search })
    fireEvent.click(globalToggle())
    fireEvent.click(screen.getByRole('button', { name: 'dormant, 已停用' }))

    failRead = true
    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: zh.toggleLabel }))
    })
    expect((await screen.findByRole('alert')).textContent).toBe(zh.error)
  })

  it('drops an enablement write that settles after unmount', async () => {
    const gate = Promise.withResolvers<undefined>()
    const setEnabled = vi.fn<PluginInventorySettingsTabInjected['setEnabled']>()
      .mockReturnValue(gate.promise)
    const view = render(
      <PluginInventorySettingsTab {...props(async () => SNAPSHOT, undefined, setEnabled)} />,
    )
    await screen.findByRole('searchbox', { name: zh.search })
    fireEvent.click(globalToggle())
    fireEvent.click(screen.getByRole('button', { name: 'dormant, 已停用' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: zh.toggleLabel }))
    })
    view.unmount()
    await act(async () => { gate.resolve(undefined) })
  })

  it('reports a refused enablement write and keeps the snapshot it had', async () => {
    const setEnabled = vi.fn<PluginInventorySettingsTabInjected['setEnabled']>()
      .mockRejectedValue(new Error('the tree is read-only'))
    const view = render(<PluginInventorySettingsTab {...props(async () => SNAPSHOT, undefined, setEnabled)} />)
    await screen.findByRole('searchbox', { name: zh.search })
    fireEvent.click(globalToggle())
    fireEvent.click(screen.getByRole('button', { name: 'dormant, 已停用' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: zh.toggleLabel }))
    })

    expect((await screen.findByRole('alert')).textContent).toBe(zh.toggleError)
    expect(screen.getByRole('button', { name: 'dormant, 已停用' })).toBeTruthy()
    expect(view.container.querySelectorAll('[data-plugin-scope="global"] li').length).toBe(7)
  })

  it('expands the global plane with failures first and preset-provided rows inline', async () => {
    const view = await renderReady()

    expect(screen.queryByText(zh.presetEnabledTag)).toBeNull()
    fireEvent.click(globalToggle())
    expect(globalToggle().getAttribute('aria-expanded')).toBe('true')
    const failed = view.container.querySelector('[data-plugin-scope="global"] [data-failed="true"]')
    expect(failed?.getAttribute('data-plugin-entry')).toBe('telemetry')
    // Failures float above the Loader-ordered remainder.
    expect(view.container.querySelector('[data-plugin-scope="global"] li')).toBe(failed)

    // Rows the presets took over sit inline, marked instead of plainly disabled.
    expect(screen.getAllByText(zh.presetEnabledTag)).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: 'tool-bash, 预设中启用' }))
    expect(screen.getByText(zh.presetProvidedDetail)).toBeTruthy()
    expect(screen.getByText(zh.enabledIn)).toBeTruthy()
    expect(screen.getByText('标准模式 · ptc')).toBeTruthy()

    // The failed global card reports its runtime state.
    fireEvent.click(screen.getByRole('button', { name: 'telemetry, 启动失败' }))
    expect(screen.getByText(zh.runtime).nextElementSibling?.textContent).toBe('启动失败')

    // An enabled entry with no live fiber says so in its details, dot-free.
    fireEvent.click(screen.getByRole('button', { name: 'unobserved-name, 已启用' }))
    expect(screen.getByText('未运行')).toBeTruthy()

    // A disabled row outside every preset stays plainly disabled.
    fireEvent.click(screen.getByRole('button', { name: 'dormant, 已停用' }))
    expect(screen.queryByText(zh.presetProvidedDetail)).toBeNull()

    fireEvent.click(globalToggle())
    expect(globalToggle().getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText(zh.presetEnabledTag)).toBeNull()
  })

  it('switches the inspected preset in place, including broken ones', async () => {
    const view = await renderReady()
    const pickPreset = (label: string): void => {
      fireEvent.click(screen.getByRole('button', { name: zh.switcherLabel }))
      fireEvent.click(screen.getByRole('menuitem', { name: label }))
    }

    pickPreset('ptc')
    expect(view.container.querySelector('[data-preset-plugin-count]')?.getAttribute('data-preset-plugin-count')).toBe('3')
    fireEvent.click(screen.getAllByRole('button', { name: 'tool-bash, 已启用' })[0]!)
    // An unnamed preset labels provenance by its id.
    expect(screen.getByText(zh.fromPreset).nextElementSibling?.textContent).toBe('ptc')

    pickPreset('坏预设（加载失败）')
    expect(screen.getByRole('alert').textContent).toBe('the composition file is missing')
    expect(view.container.querySelector('[data-preset-plugin-count]')?.getAttribute('data-preset-plugin-count')).toBe('0')
  })

  it('collapses the preset group until a search forces it open', async () => {
    const view = await renderReady()
    const toggle = screen.getByRole('button', { name: zh.presetTitle })

    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    // The header keeps its count while the rows are folded away.
    expect(view.container.querySelector('[data-preset-plugin-count]')?.getAttribute('data-preset-plugin-count')).toBe('6')
    expect(view.container.querySelectorAll('[data-plugin-scope="preset"] li')).toHaveLength(0)

    fireEvent.change(screen.getByRole('searchbox', { name: zh.search }), { target: { value: 'pwsh' } })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(zh.conditionalTag)).toBeTruthy()

    fireEvent.change(screen.getByRole('searchbox', { name: zh.search }), { target: { value: '' } })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })

  it('routes every preset name through the display resolver', async () => {
    // The resolver stands in for presetDisplayText: shipped presets localize,
    // user-authored ones keep their own metadata.
    const localized: PluginInventorySettingsTabInjected['presetName'] = preset =>
      preset.trust === 'system' ? `Localized ${preset.id}` : preset.name ?? preset.id
    render(<PluginInventorySettingsTab {...props(async () => SNAPSHOT, localized)} />)
    await screen.findByRole('searchbox', { name: zh.search })

    const switcher = screen.getByRole('button', { name: zh.switcherLabel })
    expect(switcher.textContent).toBe('Localized standard（默认）')
    fireEvent.click(switcher)
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      'Localized standard（默认）',
      'Localized ptc',
      '坏预设（加载失败）',
    ])
    fireEvent.keyDown(document, { key: 'Escape' })

    fireEvent.click(screen.getByRole('button', { name: 'pwsh, 条件启用' }))
    expect(screen.getByText(zh.fromPreset).nextElementSibling?.textContent).toBe('Localized standard')

    fireEvent.click(globalToggle())
    fireEvent.click(screen.getByRole('button', { name: 'tool-bash, 预设中启用' }))
    expect(screen.getByText('Localized standard · Localized ptc')).toBeTruthy()
  })

  it('jumps from a preset-provided row to the preset that enables it', async () => {
    await renderReady()
    fireEvent.click(screen.getByRole('button', { name: zh.switcherLabel }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'ptc' }))

    fireEvent.click(globalToggle())
    fireEvent.click(screen.getByRole('button', { name: 'tool-bash, 预设中启用' }))
    fireEvent.click(screen.getByRole('button', { name: zh.viewInPreset }))
    expect(screen.getByRole('button', { name: zh.switcherLabel }).textContent)
      .toBe('标准模式（默认）')
  })

  it('searches across scopes and points at matches in other presets', async () => {
    const view = await renderReady()
    const search = screen.getByRole('searchbox', { name: zh.search })

    fireEvent.change(search, { target: { value: 'tool-bash' } })
    // Searching forces the collapsed global plane and drawer open.
    expect(view.container.querySelector('[data-preset-plugin-count]')?.getAttribute('data-preset-plugin-count')).toBe('1')
    expect(view.container.querySelector('[data-plugin-count]')?.getAttribute('data-plugin-count')).toBe('1')
    expect(screen.getByText(zh.presetEnabledTag)).toBeTruthy()
    expect(screen.queryByText(`1 ${zh.failedCountLabel}`)).toBeNull()
    const hint = screen.getByText((text: string) => text.startsWith('其他预设中还有 2 个匹配'))
    expect(hint).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'ptc' }))
    expect(screen.getByRole('button', { name: zh.switcherLabel }).textContent).toBe('ptc')

    // A match visible only in another preset keeps the pointer without rows.
    fireEvent.change(search, { target: { value: 'crashy' } })
    expect(view.container.querySelector('[data-preset-plugin-count]')?.getAttribute('data-preset-plugin-count')).toBe('0')
    expect(screen.getByText((text: string) => text.startsWith('其他预设中还有 1 个匹配'))).toBeTruthy()
    expect(screen.queryByText(zh.emptySearch)).toBeNull()

    // A match on a Loader entry id only reaches the global plane.
    fireEvent.change(search, { target: { value: '8a1b2c3d' } })
    expect(view.container.querySelector('[data-plugin-count]')?.getAttribute('data-plugin-count')).toBe('1')
    expect(screen.queryByText((text: string) => text.includes('more matches'))).toBeNull()

    fireEvent.change(search, { target: { value: 'not-a-plugin' } })
    expect(screen.getByText(zh.emptySearch)).toBeTruthy()
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
  })

  it('renders a rosterless deployment as one expanded global list', async () => {
    const view = await renderReady({
      entries: [
        { entryId: 'hmr', moduleName: '@deepseek-ai/cordis-plugin-hmr', enabled: true, fiberPhase: 'active' },
        { entryId: 'off', moduleName: '@fixture/off', enabled: false, fiberPhase: null },
      ],
    } as unknown as Snapshot)

    expect(screen.queryByRole('button', { name: zh.switcherLabel })).toBeNull()
    expect(globalToggle().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getAllByRole('listitem')).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: 'hmr, 已启用' }))
    expect(screen.getByText(zh.runtime)).toBeTruthy()
    expect(view.container.querySelector('[data-loader-entry]')?.textContent).toBe('hmr')
    fireEvent.click(screen.getByRole('button', { name: 'off, 已停用' }))
    expect(screen.getAllByText(zh.moduleLabel).length).toBeGreaterThan(0)
    expect(screen.queryByText(zh.runtime)).toBeNull()
  })

  it('renders a preset-only snapshot without the global section', async () => {
    await renderReady({
      entries: [],
      agentPresets: [{
        id: 'solo',
        trust: 'user',
        isDefault: false,
        rows: [{ entryId: 'one', moduleName: '@fixture/one', enabled: true, fiberPhase: null }],
      }],
    })

    expect(screen.queryByRole('button', { name: (name: string) => name.startsWith(zh.globalTitle) })).toBeNull()
    expect(screen.queryByText(zh.empty)).toBeNull()
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
  })

  it('shows a generic failure and retries into the empty state', async () => {
    const list = vi.fn<PluginInventorySettingsTabInjected['list']>()
      .mockRejectedValueOnce(new Error('private transport detail'))
      .mockResolvedValueOnce({ entries: [] })
    render(<PluginInventorySettingsTab {...props(list)} />)

    expect((await screen.findByRole('alert')).textContent).toBe(zh.error)
    expect(screen.queryByText('private transport detail')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    await waitFor(() => { expect(list).toHaveBeenCalledTimes(2) })
    expect(await screen.findByText(zh.empty)).toBeTruthy()
  })

  it('contains a synchronous Remote failure and ignores a result after unmount', async () => {
    const syncFailure = vi.fn(() => { throw new Error('namespace unavailable') }) as PluginInventorySettingsTabInjected['list']
    const failed = render(<PluginInventorySettingsTab {...props(syncFailure)} />)
    expect((await screen.findByRole('alert')).textContent).toBe(zh.error)
    failed.unmount()

    const deferred = Promise.withResolvers<Snapshot>()
    const pending = render(<PluginInventorySettingsTab {...props(() => deferred.promise)} />)
    expect(screen.getByText(zh.loading)).toBeTruthy()
    pending.unmount()
    await act(async () => { deferred.resolve(SNAPSHOT) })

    const deferredFailure = Promise.withResolvers<Snapshot>()
    const pendingFailure = render(<PluginInventorySettingsTab {...props(() => deferredFailure.promise)} />)
    pendingFailure.unmount()
    await act(async () => { deferredFailure.reject(new Error('late failure')) })
  })
})
