/**
 * Merge an authoritative baseline without moving identities already visible to
 * the client. Baseline-only identities are inserted relative to the nearest
 * following known identity; identities absent from the baseline are removed.
 *
 * @param current - the established client order.
 * @param baseline - the latest authoritative rows.
 * @param keyOf - stable identity selector.
 * @returns baseline-valued rows with the established relative order retained.
 */
export function mergeOrderedBaseline<T>(
  current: readonly T[],
  baseline: readonly T[],
  keyOf: (value: T) => unknown,
): T[] {
  const baselineByKey = new Map<unknown, T>()
  for (const value of baseline) baselineByKey.set(keyOf(value), value)

  // Known rows keep `current`'s relative order and take their values from the
  // baseline; a row the baseline no longer carries is dropped.
  const known: T[] = []
  const knownKeys = new Set<unknown>()
  for (const value of current) {
    const next = baselineByKey.get(keyOf(value))
    if (next === undefined) continue
    known.push(next)
    knownKeys.add(keyOf(value))
  }

  // Each baseline-only row lands immediately before the nearest KNOWN row that
  // follows it, so group those rows by that anchor. One forward pass: a pending
  // run always ends at the known row it belongs in front of, and a run that
  // ends at the baseline's end follows no known row and therefore appends.
  const beforeKnown = new Map<unknown, T[]>()
  let pending: T[] = []
  for (let index = 0; index < baseline.length; index += 1) {
    const value = baseline[index]
    /* v8 ignore next -- dense-array guard: index is bounded by baseline.length. */
    if (value === undefined) continue
    const key = keyOf(value)
    if (knownKeys.has(key)) {
      if (pending.length > 0) {
        beforeKnown.set(key, pending)
        pending = []
      }
      continue
    }
    pending.push(value)
  }
  const trailing = pending

  const merged: T[] = []
  for (const value of known) {
    const group = beforeKnown.get(keyOf(value))
    if (group !== undefined) for (const row of group) merged.push(row)
    merged.push(value)
  }
  for (const row of trailing) merged.push(row)
  return merged
}
