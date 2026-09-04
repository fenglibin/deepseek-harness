/** `session-changes` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'title': '本次修改的文件',
  'summary': '{count} 处变更',
  'accept': '接受',
  'acceptAll': '全部接受',
  'operation.write': '写入',
  'operation.edit': '修改',
} satisfies Record<string, string>

/** The session-changes namespace key union. */
export type SessionChangesKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'title': 'Changed files',
  'summary': '{count} change(s)',
  'accept': 'Accept',
  'acceptAll': 'Accept all',
  'operation.write': 'write',
  'operation.edit': 'edit',
} satisfies Record<SessionChangesKey, string>
