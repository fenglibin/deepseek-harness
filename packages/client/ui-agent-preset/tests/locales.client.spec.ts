/** Web-localized copy for the four shipped presets and file copy for every other row. */

import { describe, expect, it } from 'vitest'
import { zh, presetDisplayText } from '../src/client/locales.ts'

const translate = (bundle: typeof zh) => (key: keyof typeof zh): string => bundle[key]

describe('preset display copy', () => {
  it.each([
    ['standard', 'presetStandardName', 'presetStandardDescription'],
    ['ptc', 'presetPtcName', 'presetPtcDescription'],
    ['minimal', 'presetMinimalName', 'presetMinimalDescription'],
    ['cordis', 'presetCordisName', 'presetCordisDescription'],
  ] as const)('localizes the shipped %s preset in English and Chinese', (id, nameKey, descriptionKey) => {
    const preset = { id, trust: 'system' as const, name: 'file name', description: 'file description' }

    expect(presetDisplayText(preset, translate(zh)))
      .toEqual({ name: zh[nameKey], description: zh[descriptionKey] })
    expect(presetDisplayText(preset, translate(zh)))
      .toEqual({ name: zh[nameKey], description: zh[descriptionKey] })
  })

  it('keeps file metadata for user and unknown system presets', () => {
    const fileCopy = { name: '我的标准', description: '团队自己的 preset。' }

    expect(presetDisplayText({ id: 'standard', trust: 'user', ...fileCopy }, translate(zh)))
      .toEqual(fileCopy)
    expect(presetDisplayText({ id: 'deployment-extra', trust: 'system', ...fileCopy }, translate(zh)))
      .toEqual(fileCopy)
    expect(presetDisplayText({ id: 'bare', trust: 'user' }, translate(zh)))
      .toEqual({ name: 'bare' })
  })
})
