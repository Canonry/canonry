/**
 * Rounding for a set of numbers that is read as a whole, such as the shares
 * of one total, or a column with a total under it.
 */

/** Removes the float error a scaling leaves (`0.14 * 10` is 1.4000000000000001). */
function cutFloatError(value: number): number {
  return Number(value.toFixed(6))
}

/**
 * Rounds each value to `decimals` places so the rounded values still add up to
 * the sum of the originals, rounded the same way.
 *
 * Rounding each value on its own does not preserve the total: sixteen shares of
 * 100 drawn from weights that sum to 111 come to 99.9, so a column of them never
 * adds up. Largest remainder (Hamilton's method) fixes that: floor every value
 * at the precision, then give one unit of the precision to each value with the
 * largest remainder until the total is met. Every result stays within one unit
 * of its value, and a value that is already exact at the precision is kept.
 *
 * Ties go to the earlier value, so the order the caller passes decides and the
 * result is deterministic. Throws a RangeError for a non-finite value or for a
 * precision that is not a whole number from 0 to 6.
 */
export function roundPreservingTotal(values: readonly number[], decimals = 1): number[] {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 6) {
    throw new RangeError(`roundPreservingTotal needs a whole number of decimals from 0 to 6, got ${decimals}`)
  }
  if (!values.every((value) => Number.isFinite(value))) {
    throw new RangeError('roundPreservingTotal needs finite values')
  }
  const scale = 10 ** decimals
  // Every rounding decision below is taken on values with the float error of
  // `* scale` cut away, as `formatPercent` does, so a remainder never depends on
  // binary noise.
  const scaled = values.map((value) => cutFloatError(value * scale))
  const floors = scaled.map((value) => Math.floor(value))
  const target = Math.round(cutFloatError(scaled.reduce((sum, value) => sum + value, 0)))
  let remaining = target - floors.reduce((sum, value) => sum + value, 0)
  const byRemainder = scaled
    .map((value, index) => ({ index, remainder: cutFloatError(value - (floors[index] ?? 0)) }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index)
  const units = [...floors]
  for (const { index } of byRemainder) {
    if (remaining <= 0) break
    units[index] = (units[index] ?? 0) + 1
    remaining--
  }
  return units.map((unit) => unit / scale)
}
