/** `delivery` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'level.l0': 'L0',
  'level.l1': 'L1',
  'level.l2': 'L2',
  'phase.created': '已创建',
  'phase.designed': '已设计',
  'phase.specified': '已拆分',
  'phase.implemented': '已实现',
  'phase.verified': '已验证',
  'phase.accepted': '已验收',
  'artifacts.label': '{count} 个产物',
  'gate.change': '下一步需要变更记录',
  'gate.design': '下一步需要设计记录',
  'gate.spec': '下一步需要 spec 记录',
  'task.title': '交付任务',
  'task.summary': '变更 {changeCount} · 设计 {designCount} · 拆分 {specCount}',
  'task.status.accepted': '已验收',
  'task.status.cleared': '已清除',
  'event.create': '创建任务',
  'event.advance': '推进到 {phase}',
  'event.record-change': '记录变更',
  'event.record-design': '记录设计',
  'event.record-spec': '记录拆分',
  'event.clear': '清除任务',
} satisfies Record<string, string>

/** The delivery namespace key union. */
export type DeliveryKey = keyof typeof zh
