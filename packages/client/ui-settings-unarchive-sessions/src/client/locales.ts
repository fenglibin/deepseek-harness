/** 已归档会话设置页的文案词典。 */

/** 简体中文字典，同时是键的唯一真源。 */
export const zh = {
  nav: '已归档会话',
  search: '搜索已归档会话',
  loading: '正在读取会话…',
  empty: '暂无已归档会话。',
  unavailable: '这里没有可恢复的已归档会话。',
  emptySearch: '没有匹配的会话。',
  unarchive: '取消归档',
  unarchiveNamed: '取消归档 {title}',
  ungrouped: '未分组',
  'time.now': '刚刚',
  'time.minutes': '{n}分钟',
  'time.hours': '{n}小时',
  'time.days': '{n}天',
  'time.months': '{n}个月',
  'time.years': '{n}年',
} satisfies Record<string, string>

/** 已归档会话页的 locale 键联合。 */
export type ArchivedSessionsLocaleKey = keyof typeof zh
