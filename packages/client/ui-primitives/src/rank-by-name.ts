/**
 * `/` 菜单候选的共享排序：查询必须是不区分大小写的、候选名称的有序子序列，
 * 若候选带本地化标题，也可命中该标题。前缀命中排在最前，其次是两键上更强的
 * 对齐得分，最后是输入的源序。
 */

/** 一条命中及其稳定的源位置。 */
interface Ranked<T> {
  readonly item: T
  readonly index: number
  readonly prefix: boolean
  readonly score: number
}

/** 名称起始与分隔边界处的额外加权。 */
function boundaryBonus(name: string, index: number): number {
  return index === 0 || name.charAt(index - 1) === '-' || name.charAt(index - 1) === '_' ? 8 : 0
}

/**
 * 以 O(name × query) 计算最强的有序子序列对齐得分。
 * 边界与相邻命中加权，跳过与前导字符扣分。查询不是名称的子序列时返回 undefined。
 */
function alignmentScore(name: string, query: string): number | undefined {
  if (query.length > name.length) return undefined
  const noMatch = Number.NEGATIVE_INFINITY
  let previous = Array<number>(name.length).fill(noMatch)
  for (let index = 0; index < name.length; index++) {
    if (name.charAt(index) === query.charAt(0)) previous[index] = 1 + boundaryBonus(name, index) - index
  }
  for (let queryIndex = 1; queryIndex < query.length; queryIndex++) {
    const current = Array<number>(name.length).fill(noMatch)
    // Sweep the previous row once: `left` is its score one character back
    // (the adjacent continuation), `leftLeft` two back (the earliest gapped one).
    let left = noMatch
    let leftLeft = noMatch
    let bestGapped = noMatch
    for (const [index, prior] of previous.entries()) {
      if (leftLeft !== noMatch) bestGapped = Math.max(bestGapped, leftLeft + index - 2)
      if (name.charAt(index) === query.charAt(queryIndex)) {
        const bonus = 1 + boundaryBonus(name, index)
        let score = noMatch
        if (left !== noMatch) score = left + bonus + 4
        if (bestGapped !== noMatch) score = Math.max(score, bestGapped + bonus + 1 - index)
        current[index] = score
      }
      leftLeft = left
      left = prior
    }
    previous = current
  }
  let best = noMatch
  for (const score of previous) best = Math.max(best, score)
  return best === noMatch ? undefined : best
}

/**
 * 按菜单查询为具名候选排序。
 * @param items - 源序候选（先是 host 目录，然后是客户端贡献）；候选可选的 `title` 是名称之外的第二搜索键。
 * @param rawQuery - 触发符之后输入的文本，按不区分大小写匹配。
 * @returns 命中的候选：前缀命中在前，其次按对齐得分，最后按源序；查询为空时返回输入列表本身。
 */
export function rankByName<T extends { readonly name: string; readonly title?: string }>(
  items: readonly T[],
  rawQuery: string,
): readonly T[] {
  const query = rawQuery.toLowerCase()
  if (query === '') return items
  const ranked: Ranked<T>[] = []
  items.forEach((item, index) => {
    const keys = item.title === undefined ? [item.name] : [item.name, item.title]
    let prefix = false
    let score: number | undefined
    for (const key of keys) {
      const lower = key.toLowerCase()
      const keyScore = alignmentScore(lower, query)
      if (keyScore === undefined) continue
      prefix ||= lower.startsWith(query)
      score = score === undefined ? keyScore : Math.max(score, keyScore)
    }
    if (score !== undefined) ranked.push({ item, index, prefix, score })
  })
  ranked.sort((left, right) =>
    Number(right.prefix) - Number(left.prefix) || right.score - left.score || left.index - right.index)
  return ranked.map(match => match.item)
}
