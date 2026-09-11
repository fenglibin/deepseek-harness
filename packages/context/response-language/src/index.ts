/**
 * Deployment-wide response-language directive.
 *
 * The row resolves which language the model must write user-visible prose in
 * and contributes one system-prompt section demanding it. `auto` follows the
 * Web GUI's stored language choice, then the host process's own locale, and
 * keeps the model silent about language when neither names a language this
 * row can direct — a French host should not be told to answer in English.
 *
 * The directive is a section, not a runtime context, so it survives
 * `includeRuntimeContext: false` and reaches subagent children, whose
 * assembly merges the global layer.
 * @module @deepseek-ai/dsh-response-language
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Cordis plugin name. */
export const name = 'response-language'

/** The prompt registry this row contributes to. */
export const inject = ['systemPrompt']

/** The one section this row registers. */
export const RESPONSE_LANGUAGE_SECTION = 'deployment:response-language'

/** How the row chooses the language the model writes in. */
export type ResponseLanguageSetting = 'auto' | 'zh' | 'en' | 'off'

/** Accepted {@link Config.language} values. */
export const RESPONSE_LANGUAGE_SETTINGS = ['auto', 'zh', 'en', 'off'] as const

/**
 * The directive shipped for each language. A language absent from this map
 * gets no section: the model then follows the conversation's own language,
 * which is the only honest instruction for a locale this row cannot name.
 */
const DIRECTIVES = {
  zh: '用简体中文回复用户。凡是人会读到的句子都用中文写：解释、计划、进度更新、总结、提问，以及你撰写的提交信息、报告与文档正文。你自己撰写的注释也用中文，包括行注释、块注释与文档注释（JSDoc、docstring 等）。标识符、关键字、字符串字面量、shell 命令、文件路径、工具名、JSON key、URL，以及引用的用户或工具输出保持原样，不是你撰写的既有注释维持其原有语言，只翻译它们周围的散文。复现标识符、路径、命令或引用的用户/工具输出时不要切换成英文；引文保持引用状态，周围的散文保持中文。即使用户用英文输入，也保持中文回复，除非用户明确要求用其他语言。',
} as const

/** A language this row can direct the model to write in. */
export type ResponseLanguage = keyof typeof DIRECTIVES

/**
 * Settings namespace owned by `@deepseek-ai/dsh-client-locale`.
 *
 * The namespace name is a protocol constant rather than an import: the locale
 * package is a browser package, and a host row that imported it would drag the
 * whole Web client into every composition that mounts this one. The read is
 * tolerant by construction — a settings service returns `undefined` for a
 * namespace nobody registered, which is the ordinary headless case.
 */
const LOCALE_SETTINGS_NAMESPACE = 'locale'

/** Field of that namespace carrying the user's explicit language choice. */
const LOCALE_PREFERENCE_FIELD = 'preference'

/** POSIX variables naming the host's locale, most specific first. */
const LOCALE_ENVIRONMENT_VARIABLES = ['LC_ALL', 'LC_MESSAGES', 'LANG'] as const

/** Locale values that name no language at all. */
const UNSET_LOCALE_VALUES = new Set(['', 'C', 'POSIX'])

/** Plugin config: which language the model writes user-visible prose in. */
export interface Config {
  /**
   * `auto` follows the Web GUI's stored language choice and then the host
   * process's own locale. `zh` pins Chinese, `en` pins English, and `off`
   * registers no section at all. English pins emit no directive because it is
   * the language the model reaches unaided.
   */
  language: ResponseLanguageSetting
}

/** Runtime schema for the response-language row. */
export const Config: z<Config> = z.object({
  language: z.union([...RESPONSE_LANGUAGE_SETTINGS]).default('auto'),
})

/**
 * Reduce one locale tag to its lowercase primary language subtag.
 * @param tag - a BCP 47 tag (`zh-Hans-CN`) or a POSIX locale (`zh_CN.UTF-8`).
 * @returns the leading language subtag, or `undefined` when `tag` has none.
 */
export function primaryLanguage(tag: string): string | undefined {
  const match = /^[A-Za-z]{2,8}/u.exec(tag.trim())
  return match?.[0].toLowerCase()
}

/**
 * Read the host process's own locale.
 * @param env - environment to read; defaults to the process environment.
 * @returns the primary language subtag, or `undefined` when none is set.
 */
export function hostEnvironmentLocale(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const variable of LOCALE_ENVIRONMENT_VARIABLES) {
    const raw = env[variable]
    if (raw === undefined || UNSET_LOCALE_VALUES.has(raw.trim())) continue
    const language = primaryLanguage(raw)
    if (language !== undefined) return language
  }
  return primaryLanguage(new Intl.DateTimeFormat().resolvedOptions().locale)
}

/**
 * Choose the language the model must write in.
 * @param setting - the configured selection.
 * @param signals - auto-mode locale tags, most authoritative first. The first
 * tag naming a language decides: a GUI choice of English on a Chinese host
 * wins, and a language with no shipped directive beats a later one that has
 * one rather than falling through to it.
 * @returns a language this row can direct, or `undefined` for no section.
 */
export function resolveResponseLanguage(
  setting: ResponseLanguageSetting,
  signals: readonly (string | undefined)[],
): ResponseLanguage | undefined {
  if (setting === 'off') return undefined
  if (setting !== 'auto') {
    return setting in DIRECTIVES ? setting as ResponseLanguage : undefined
  }
  for (const tag of signals) {
    const language = tag === undefined ? undefined : primaryLanguage(tag)
    if (language === undefined) continue
    return language in DIRECTIVES ? language as ResponseLanguage : undefined
  }
  return undefined
}

/**
 * The system-prompt text for one resolved language.
 * @param language - the resolved language, or `undefined` for no directive.
 * @returns the directive, or empty text so the registry drops the section.
 */
export function directiveText(language: ResponseLanguage | undefined): string {
  return language === undefined ? '' : DIRECTIVES[language]
}

/**
 * Register the response-language section.
 * @param ctx - Host context carrying the prompt registry.
 * @param config - the language selection.
 */
export function apply(ctx: Context, config: Config): void {
  // The host process's locale is fixed for the process lifetime; the GUI
  // language is a live setting a user can switch mid-session, so it is read
  // at each assembly.
  const environment = hostEnvironmentLocale()
  ctx.effect(() => ctx.systemPrompt.section({
    name: RESPONSE_LANGUAGE_SECTION,
    order: ctx.systemPrompt.getSectionOrder('RESPONSE_LANGUAGE'),
    text: () => directiveText(resolveResponseLanguage(config.language, [localePreference(ctx), environment])),
  }), 'response-language.section()')
}

/**
 * Read the Web GUI's stored language choice.
 * @param ctx - context that may acquire the optional settings service.
 * @returns the stored locale tag, or `undefined` when no choice is recorded.
 */
function localePreference(ctx: Context): string | undefined {
  const section = ctx.get('settings')?.get(LOCALE_SETTINGS_NAMESPACE)
  if (section === null || typeof section !== 'object') return undefined
  const preference = (section as Record<string, unknown>)[LOCALE_PREFERENCE_FIELD]
  return typeof preference === 'string' ? preference : undefined
}
