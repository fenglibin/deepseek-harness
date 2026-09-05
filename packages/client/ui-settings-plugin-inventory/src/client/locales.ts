/** Copy dictionaries for the plugin inventory Settings section. */

/** Simplified Chinese dictionary and key source of truth. */
export const zh = {
  tab: '插件列表',
  loading: '正在读取插件…',
  error: '暂时无法读取插件。',
  retry: '重试',
  search: '搜索插件',
  empty: '暂无插件。',
  emptySearch: '没有匹配的插件。',
  presetTitle: '会话插件',
  presetSubtitle: '由 Agent 预设按会话组成',
  countUnit: '个',
  switcherLabel: '选择要查看的 Agent 预设',
  presetOptionDefault: '{name}（默认）',
  presetOptionBroken: '{name}（加载失败）',
  globalTitle: '全局插件',
  globalSubtitle: '系统与所有会话共用',
  presetProvidedDetail: '全局已停用，由 Agent 预设按会话提供',
  enabledIn: '启用于',
  viewInPreset: '去预设分组查看',
  matchesInOtherPresets: '其他预设中还有 {count} 个匹配：',
  failedCountLabel: '个失败',
  enabledTag: '已启用',
  disabledTag: '已停用',
  conditionalTag: '条件启用',
  presetEnabledTag: '预设中启用',
  failedTag: '启动失败',
  moduleLabel: '完整名称',
  fromPreset: '来自',
  condition: '禁用条件',
  configuration: '配置状态',
  runtime: '运行状态',
  unobserved: '未运行',
  pending: '等待依赖',
  loadingPhase: '加载中',
  active: '运行中',
  failed: '启动失败',
  unloading: '卸载中',
} satisfies Record<string, string>

/** Plugin inventory locale key union. */
export type PluginInventoryLocaleKey = keyof typeof zh
