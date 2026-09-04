import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as ResponseLanguage from '@deepseek-ai/dsh-response-language'
import { Config } from '@deepseek-ai/dsh-response-language'

/** A settings service resolving one namespace, the way `dsh-settings` serves a registered section. */
function settingsWith(sections: Record<string, unknown>): unknown {
  return { get: (ns: string) => sections[ns] }
}

/** Assemble the sections of a composition mounting only the prompt registry and this row. */
async function assemble(config: ResponseLanguage.Config) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ResponseLanguage, config)
  const assembly = await ctx.systemPrompt.assemble()
  return { ctx, assembly }
}

describe('primaryLanguage', () => {
  it('reduces POSIX and BCP 47 tags to the lowercase primary subtag', () => {
    expect(ResponseLanguage.primaryLanguage('zh_CN.UTF-8')).toBe('zh')
    expect(ResponseLanguage.primaryLanguage('zh-Hans-CN')).toBe('zh')
    expect(ResponseLanguage.primaryLanguage('  EN_US ')).toBe('en')
    expect(ResponseLanguage.primaryLanguage('')).toBeUndefined()
    expect(ResponseLanguage.primaryLanguage('   ')).toBeUndefined()
  })
})

describe('hostEnvironmentLocale', () => {
  it('reads the most specific POSIX variable that names a language', () => {
    expect(ResponseLanguage.hostEnvironmentLocale({ LC_ALL: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' })).toBe('zh')
    expect(ResponseLanguage.hostEnvironmentLocale({ LC_MESSAGES: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' })).toBe('zh')
    expect(ResponseLanguage.hostEnvironmentLocale({ LANG: 'ja_JP.UTF-8' })).toBe('ja')
  })

  it('skips variables naming no language', () => {
    expect(ResponseLanguage.hostEnvironmentLocale({ LC_ALL: 'C', LANG: 'zh_CN.UTF-8' })).toBe('zh')
    expect(ResponseLanguage.hostEnvironmentLocale({ LC_ALL: 'POSIX', LANG: 'zh_CN.UTF-8' })).toBe('zh')
    expect(ResponseLanguage.hostEnvironmentLocale({ LC_ALL: '  ', LANG: 'zh_CN.UTF-8' })).toBe('zh')
    expect(ResponseLanguage.hostEnvironmentLocale({ LC_ALL: '123', LANG: 'zh_CN.UTF-8' })).toBe('zh')
  })

  it('falls back to the ICU default locale when no variable names a language', () => {
    const expected = ResponseLanguage.primaryLanguage(new Intl.DateTimeFormat().resolvedOptions().locale)
    expect(ResponseLanguage.hostEnvironmentLocale({})).toBe(expected)
    expect(ResponseLanguage.hostEnvironmentLocale({ LANG: '' })).toBe(expected)
  })
})

describe('resolveResponseLanguage', () => {
  it('honors a pinned selection', () => {
    expect(ResponseLanguage.resolveResponseLanguage('zh', [])).toBe('zh')
    expect(ResponseLanguage.resolveResponseLanguage('en', ['zh'])).toBeUndefined()
    expect(ResponseLanguage.resolveResponseLanguage('off', ['zh'])).toBeUndefined()
  })

  it('lets the first auto signal naming a language decide', () => {
    expect(ResponseLanguage.resolveResponseLanguage('auto', ['zh'])).toBe('zh')
    expect(ResponseLanguage.resolveResponseLanguage('auto', [undefined, 'zh_CN.UTF-8'])).toBe('zh')
    expect(ResponseLanguage.resolveResponseLanguage('auto', ['en', 'zh'])).toBeUndefined()
    expect(ResponseLanguage.resolveResponseLanguage('auto', ['fr', 'zh'])).toBeUndefined()
  })

  it('stays silent when no signal names a directed language', () => {
    expect(ResponseLanguage.resolveResponseLanguage('auto', ['fr'])).toBeUndefined()
    expect(ResponseLanguage.resolveResponseLanguage('auto', [])).toBeUndefined()
  })
})

describe('directiveText', () => {
  it('names Simplified Chinese for zh and produces empty text otherwise', () => {
    const zh = ResponseLanguage.directiveText('zh')
    expect(zh).toContain('简体中文')
    expect(zh).toContain('Do NOT switch to English')
    expect(zh).toContain('mirror their tone but keep your reply in Chinese')
    expect(ResponseLanguage.directiveText(undefined)).toBe('')
  })
})

describe('the response-language row', () => {
  it('defaults to auto and rejects an unknown language', () => {
    expect(Config()).toEqual({ language: 'auto' })
    expect(() => Config({ language: 'de' } as never)).toThrow()
  })

  it('registers the directive directly after the harness identity', async () => {
    const { ctx, assembly } = await assemble({ language: 'zh' })
    expect(assembly.sections.map(section => section.name)).toEqual([
      'harness:identity',
      'deployment:response-language',
      'deployment:persona',
    ])
    expect(assembly.sections[1]?.text).toBe(ResponseLanguage.directiveText('zh'))
    expect(renderPrompt(assembly)).toBe(
      `You are an AI agent powered by DeepSeek Harness.\n\n${ResponseLanguage.directiveText('zh')}`,
    )
    await ctx.fiber.dispose()
  })

  it('drops the section at render when no directive applies', async () => {
    const { ctx, assembly } = await assemble({ language: 'en' })
    expect(assembly.sections.map(section => section.name)).toContain('deployment:response-language')
    expect(assembly.sections.find(section => section.name === 'deployment:response-language')?.text).toBe('')
    expect(renderPrompt(assembly)).toBe('You are an AI agent powered by DeepSeek Harness.')
    await ctx.fiber.dispose()
  })

  it('removes the section when its fiber is disposed (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    const fiber = await ctx.plugin(ResponseLanguage, { language: 'zh' })
    expect((await ctx.systemPrompt.assemble()).sections.map(section => section.name))
      .toContain('deployment:response-language')
    await fiber.dispose()
    expect((await ctx.systemPrompt.assemble()).sections.map(section => section.name))
      .not.toContain('deployment:response-language')
    await ctx.fiber.dispose()
  })
})

describe('the auto signals', () => {
  it('lets the stored GUI language outrank the host environment', async () => {
    const ctx = new Context()
    ctx.provide('settings', settingsWith({ locale: { preference: 'en' } }))
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ResponseLanguage, { language: 'auto' })
    const assembly = await ctx.systemPrompt.assemble()
    // This host reports zh_CN, so an English GUI choice is only observable as
    // the absence of the Chinese directive the environment alone would produce.
    expect(ResponseLanguage.hostEnvironmentLocale()).toBe('zh')
    expect(assembly.sections.find(section => section.name === 'deployment:response-language')?.text).toBe('')
    await ctx.fiber.dispose()
  })

  it('directs Chinese when the GUI language is Chinese', async () => {
    const ctx = new Context()
    ctx.provide('settings', settingsWith({ locale: { preference: 'zh' } }))
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ResponseLanguage, { language: 'auto' })
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.find(section => section.name === 'deployment:response-language')?.text)
      .toContain('简体中文')
    await ctx.fiber.dispose()
  })

  it('ignores a locale section that stores no preference', async () => {
    const ctx = new Context()
    ctx.provide('settings', settingsWith({ locale: {} }))
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ResponseLanguage, { language: 'auto' })
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.find(section => section.name === 'deployment:response-language')?.text)
      .toBe(ResponseLanguage.directiveText(
        ResponseLanguage.resolveResponseLanguage('auto', [ResponseLanguage.hostEnvironmentLocale()]),
      ))
    await ctx.fiber.dispose()
  })

  it('reads no preference without a settings service', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ResponseLanguage, { language: 'auto' })
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.find(section => section.name === 'deployment:response-language')?.text)
      .toBe(ResponseLanguage.directiveText(
        ResponseLanguage.resolveResponseLanguage('auto', [ResponseLanguage.hostEnvironmentLocale()]),
      ))
    await ctx.fiber.dispose()
  })

  it('tolerates a settings service returning a non-object section', async () => {
    const ctx = new Context()
    ctx.provide('settings', settingsWith({ locale: null }))
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ResponseLanguage, { language: 'auto' })
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.find(section => section.name === 'deployment:response-language')?.text)
      .toBe(ResponseLanguage.directiveText(
        ResponseLanguage.resolveResponseLanguage('auto', [ResponseLanguage.hostEnvironmentLocale()]),
      ))
    await ctx.fiber.dispose()
  })
})
