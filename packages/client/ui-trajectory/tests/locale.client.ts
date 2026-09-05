import { zh as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh, type TrajectoryTranslate } from '../src/client/locales.ts'

function translator(dictionary: Record<string, string>): TrajectoryTranslate {
  return (key, params = {}) => {
    const template = dictionary[key] ?? key
    return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
      const value = params[name]
      return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : ''
    })
  }
}

/** English trajectory translator for component and pure-layout tests. */
export const t = translator({ ...commonEn, ...zh })

/** Chinese trajectory translator for real-view fixtures that open in Chinese. */
export const tZh = translator({ ...commonZh, ...zh })
