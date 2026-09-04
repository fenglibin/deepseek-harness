/** Locale namespace owned by Session export browser feedback. */
export const NS = 'session-log-download'

/** Simplified-Chinese Session export strings. */
export const zh = {
  'header.action': 'Session 日志',
  'header.menu': '更多导出选项',
  'header.scopeCurrent': '仅当前 Session',
  'header.scopeTree': '包含子 Session',
  'dialog.errorTitle': 'Session 导出失败',
  'dialog.close': '关闭',
  'dialog.commandFailed': '无法启动 Session 导出。',
} as const

/** English Session export strings. */
export const en: Record<keyof typeof zh, string> = {
  'header.action': 'Session log',
  'header.menu': 'More export options',
  'header.scopeCurrent': 'Current Session only',
  'header.scopeTree': 'Include sub-Sessions',
  'dialog.errorTitle': 'Session export failed',
  'dialog.close': 'Close',
  'dialog.commandFailed': 'Could not start the Session export.',
}

/** Stable locale keys consumed by the shared modal. */
export type SessionLogDownloadKey = keyof typeof zh
