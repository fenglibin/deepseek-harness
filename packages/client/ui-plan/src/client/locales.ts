/** `plan` namespace dictionaries (the composer plan chip's copy). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'chip.label': 'Plan',
  'chip.on.aria': 'plan mode 已开启，按下关闭',
  'chip.on.title': 'plan mode 已开启 — 点击关闭（/plan off）',
  'chip.off.aria': 'plan mode 已关闭，按下开启',
  'chip.off.title': 'plan mode 已关闭 — 点击开启（/plan）',
  'chip.exitFailed': '退出 plan mode 失败',
} satisfies Record<string, string>

/** The plan namespace key union. */
export type PlanKey = keyof typeof zh
