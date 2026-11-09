/**
 * Coverage rates over the answers that could be checked.
 *
 * A saved answer can be unreadable for one signal while it is fine for the
 * other: its mention may name a Property it cannot be tied to
 * (`unattributed`), its source-link capture may be incomplete (`unchecked`),
 * or its engine may return no sources at all (`citationNotMeasured`, a local
 * model with no web access). Such an answer is neither a positive nor a
 * measured negative, so it leaves BOTH the numerator and the denominator and
 * is counted beside the rate under the field for its reason. Refusing the
 * whole population instead let one such answer in thousands blank the number.
 *
 * This is not the rule for a MISSING answer (an expected slot with no saved
 * observation). The caller still withholds the rate for that, before it gets
 * here.
 */

/**
 * The count a left-out answer is reported under: `unattributed` for mention;
 * `unchecked` (sources partly saved) or `citationNotMeasured` (no sources
 * returned) for citation.
 */
export type ExcludedAnswerField = 'unattributed' | 'unchecked' | 'citationNotMeasured'

export interface CheckedRate {
  numerator: number
  denominator: number
  rate: number
}

/** A checked rate, with the left-out answers counted under `F` when there were any. */
export type CheckedRateWith<F extends ExcludedAnswerField> = CheckedRate & { [K in F]?: number }

function assertCount(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer, got ${value}`)
  }
}

/**
 * The rate over `answers - excluded` checked answers.
 *
 * `numerator` counts positives among the CHECKED answers only: a positive seen
 * on a left-out answer is not counted (counting only those positives would bias
 * the rate up). The count is attached under `field` only when it is above zero,
 * so absent is the one encoding of none. Returns `null` when nothing is left to
 * check; the caller names the reason the rate is unavailable.
 */
export function rateOverChecked<F extends ExcludedAnswerField>(
  numerator: number,
  answers: number,
  excluded: number,
  field: F,
): CheckedRateWith<F> | null {
  return rateOverCheckedAnswers<F>(numerator, answers, { [field]: excluded } as Partial<Record<F, number>>)
}

/**
 * `rateOverChecked` for a rate that leaves answers out for more than one
 * reason, such as a citation rate with both `unchecked` and
 * `citationNotMeasured` answers. Each count above zero is attached under its
 * own field; together they leave the denominator.
 */
export function rateOverCheckedAnswers<F extends ExcludedAnswerField>(
  numerator: number,
  answers: number,
  excluded: Partial<Record<F, number>>,
): CheckedRateWith<F> | null {
  assertCount('numerator', numerator)
  assertCount('answers', answers)
  const counts = Object.entries(excluded) as Array<[F, number | undefined]>
  let left = 0
  for (const [field, count] of counts) {
    assertCount(field, count ?? 0)
    left += count ?? 0
  }
  if (left > answers) throw new RangeError(`excluded (${left}) cannot exceed answers (${answers})`)
  const denominator = answers - left
  if (numerator > denominator) {
    throw new RangeError(`numerator (${numerator}) cannot exceed the ${denominator} checked answers`)
  }
  if (denominator === 0) return null
  const rate: CheckedRate = { numerator, denominator, rate: numerator / denominator }
  const attached = Object.fromEntries(counts.filter(([, count]) => (count ?? 0) > 0))
  // TypeScript cannot see that a rate without the optional keys satisfies the
  // mapped type for a generic `F`, nor type computed keys by `F`.
  return { ...rate, ...attached } as CheckedRateWith<F>
}
