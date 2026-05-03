/**
 * Pure insight collapsing.
 *
 * Multiple runs can produce the same insight for the same (keyword, provider, type)
 * tuple — e.g. "new perplexity citation for 'HVAC lead generation software'"
 * fired twice in two days. Every consumer of the insight stream — the report
 * renderer (consuming `ReportInsight`), the CLI list view (`InsightDto`),
 * the dashboard, Aero — wants to dedupe rather than render the same line N
 * times. Generic over the row shape so each consumer keeps its own type.
 */

/** Minimal shape required to dedupe. Both `Insight` and `ReportInsight` satisfy it. */
export interface InsightLike {
  keyword: string
  provider: string
  type: string
  createdAt: string
}

export interface GroupedInsight<T extends InsightLike = InsightLike> {
  /** Most-recent insight in the group (used as the display row). */
  representative: T
  /** Number of insights in this group. */
  count: number
  /** All insights in the group, sorted oldest → newest. */
  instances: T[]
  /** Latest createdAt across instances (mirror of `representative.createdAt`). */
  latest: string
}

/**
 * Group insights by an arbitrary key. Default key tuples on the natural
 * dedup dimensions: (keyword, provider, type).
 *
 * Group order is the order of first appearance in the input.
 * Within each group, instances are sorted oldest → newest by createdAt
 * (lexicographic ISO timestamp comparison).
 */
export function groupInsights<T extends InsightLike>(
  insights: T[],
  keyFn: (i: T) => string = (i) => `${i.keyword} ${i.provider} ${i.type}`,
): GroupedInsight<T>[] {
  const order: string[] = []
  const buckets = new Map<string, T[]>()

  for (const i of insights) {
    const key = keyFn(i)
    const bucket = buckets.get(key)
    if (bucket) {
      bucket.push(i)
    } else {
      buckets.set(key, [i])
      order.push(key)
    }
  }

  return order.map((key) => {
    const sorted = [...buckets.get(key)!].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const representative = sorted[sorted.length - 1]!
    return {
      representative,
      count: sorted.length,
      instances: sorted,
      latest: representative.createdAt,
    }
  })
}
