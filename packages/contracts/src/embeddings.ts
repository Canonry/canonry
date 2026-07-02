/**
 * Cosine similarity between two same-length numeric vectors. Returns a value
 * in [-1, 1]. Returns 0 when either vector is all-zero (instead of NaN) so
 * downstream clustering doesn't have to special-case the degenerate case.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) {
    throw new Error('cosineSimilarity: vectors must be non-empty')
  }
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: vector length mismatch (${a.length} vs ${b.length})`)
  }
  let dot = 0
  let magA = 0
  let magB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    magA += a[i]! * a[i]!
    magB += b[i]! * b[i]!
  }
  if (magA === 0 || magB === 0) return 0
  return dot / (Math.sqrt(magA) * Math.sqrt(magB))
}

/**
 * Single-link clustering by cosine similarity (a.k.a. connected components
 * over the similarity graph). Two items end up in the same cluster iff there
 * is a chain `i → j₁ → … → jₖ → k` of pairs each with similarity ≥ threshold.
 * Implementation: union-find over all O(N²) pairs.
 *
 * Single-link (rather than complete-link or average-link) suits the
 * discovery dedup use case: collapse a chain like
 * "ai quoting" ≈ "home quoting" ≈ "instant home estimate" into one cluster
 * even when the endpoints are below threshold.
 *
 * The flip side: chaining is safe only when the threshold sits ABOVE the
 * similarity band of distinct items. Any pair of distinct intents scoring
 * >= threshold becomes a bridge that merges their entire clusters, so a
 * threshold inside that band can collapse the whole input set into one
 * cluster. See `DISCOVERY_DEFAULT_DEDUP_THRESHOLD` (discovery.ts) for how
 * the discovery pipeline calibrates against this.
 *
 * Output ordering:
 *   - Cluster order is the position at which each cluster's first member
 *     appeared in `items` (so the cluster containing items[0] comes first).
 *   - Within a cluster, items preserve their original insertion order.
 *
 * Earlier implementations placed each item in the *first* cluster it
 * matched and broke out — that was greedy, not single-link: a bridge item
 * arriving last would only merge into one of the two clusters it should
 * have joined, leaving the second isolated. Union-find avoids this.
 */
export function clusterByCosine<T>(
  items: T[],
  vectors: number[][],
  threshold: number,
): T[][] {
  if (threshold < 0 || threshold > 1) {
    throw new Error(`clusterByCosine: threshold must be in [0, 1], got ${threshold}`)
  }
  if (items.length !== vectors.length) {
    throw new Error(`clusterByCosine: items/vectors length mismatch (${items.length} vs ${vectors.length})`)
  }
  if (items.length === 0) return []

  const parent: number[] = items.map((_, i) => i)
  const find = (x: number): number => {
    let root = x
    while (parent[root]! !== root) root = parent[root]!
    // path compression
    let cur = x
    while (parent[cur]! !== root) {
      const next = parent[cur]!
      parent[cur] = root
      cur = next
    }
    return root
  }
  const union = (a: number, b: number): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (cosineSimilarity(vectors[i]!, vectors[j]!) >= threshold) {
        union(i, j)
      }
    }
  }

  // Bucket items by their root, preserving insertion order both for cluster
  // emission (the iteration order of the Map) and for items within a cluster.
  const byRoot = new Map<number, number[]>()
  for (let i = 0; i < items.length; i++) {
    const root = find(i)
    const existing = byRoot.get(root)
    if (existing) existing.push(i)
    else byRoot.set(root, [i])
  }
  return Array.from(byRoot.values()).map((indices) => indices.map((idx) => items[idx]!))
}

/**
 * Pick the canonical representative of a cluster of candidate queries.
 * Default policy: shortest string (less likely to over-specify intent),
 * with ties broken by insertion order (first wins).
 */
export function pickClusterRepresentative(cluster: string[]): string {
  if (cluster.length === 0) throw new Error('pickClusterRepresentative: cluster is empty')
  let best = cluster[0]!
  for (let i = 1; i < cluster.length; i++) {
    if (cluster[i]!.length < best.length) best = cluster[i]!
  }
  return best
}

/** Ambiguous-similarity band: pairs here are where a threshold change (0.93 vs
 *  0.95 vs 0.97) actually flips clustering decisions. */
export const DEDUP_SIMILARITY_BAND_LOW = 0.9
export const DEDUP_SIMILARITY_BAND_HIGH = 0.97

export interface DedupSimilarityStats {
  /** Min pairwise cosine within each MULTI-member cluster (singletons carry no
   *  pairwise cohesion). A low value = the cluster likely chained distinct
   *  intents via single-link. */
  perClusterMinSimilarity: number[]
  /** Fraction of ALL candidate pairs with cosine in [BAND_LOW, BAND_HIGH).
   *  Null when there are fewer than 2 candidates. */
  bandPairFraction: number | null
  pairsTotal: number
}

/**
 * Calibration diagnostics for the dedup threshold decision. `indexClusters`
 * holds vector indices grouped as `clusterByCosine` grouped them. Values are
 * rounded to 4 decimals so persisted JSON stays small and stable.
 */
export function computeDedupSimilarityStats(
  vectors: readonly number[][],
  indexClusters: readonly number[][],
): DedupSimilarityStats {
  const n = vectors.length
  if (n < 2) return { perClusterMinSimilarity: [], bandPairFraction: null, pairsTotal: 0 }

  const round = (v: number) => Math.round(v * 10_000) / 10_000

  const perClusterMinSimilarity: number[] = []
  for (const cluster of indexClusters) {
    if (cluster.length < 2) continue
    let min = Infinity
    for (let a = 0; a < cluster.length; a++) {
      for (let b = a + 1; b < cluster.length; b++) {
        min = Math.min(min, cosineSimilarity(vectors[cluster[a]!]!, vectors[cluster[b]!]!))
      }
    }
    perClusterMinSimilarity.push(round(min))
  }

  let inBand = 0
  let pairsTotal = 0
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      pairsTotal++
      const sim = cosineSimilarity(vectors[i]!, vectors[j]!)
      if (sim >= DEDUP_SIMILARITY_BAND_LOW && sim < DEDUP_SIMILARITY_BAND_HIGH) inBand++
    }
  }

  return { perClusterMinSimilarity, bandPairFraction: round(inBand / pairsTotal), pairsTotal }
}
