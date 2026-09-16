/** `session-changes` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'title': '修改的文件',
  'summary': '{count} 处变更',
  'summaryAll': '共 {count} 处变更',
  'accept': '接受',
  'acceptAll': '全部接受',
  'accepted': '已接受',
  'view.pending': '当前变更',
  'view.all': '全部变更',
  'open': '打开 {name}',
  'openFailed': '打开失败：{message}',
  'operation.write': '写入',
  'operation.edit': '修改',
} satisfies Record<string, string>

/** The session-changes namespace key union. */
export type SessionChangesKey = keyof typeof zh
