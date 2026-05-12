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
 * Greedy single-link clustering by cosine similarity. Each item is assigned
 * to the first existing cluster where any member has similarity ≥ threshold;
 * otherwise it forms its own cluster. Order within a cluster preserves
 * insertion order from `items`.
 *
 * Single-link (rather than complete-link or average-link) suits the
 * discovery dedup use case: we want to collapse a chain like
 * "ai quoting" ≈ "home quoting" ≈ "instant home estimate" into one cluster
 * even when the endpoints are below threshold.
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

  const clusters: number[][] = []
  for (let i = 0; i < items.length; i++) {
    let placed = false
    for (const cluster of clusters) {
      for (const j of cluster) {
        if (cosineSimilarity(vectors[i]!, vectors[j]!) >= threshold) {
          cluster.push(i)
          placed = true
          break
        }
      }
      if (placed) break
    }
    if (!placed) clusters.push([i])
  }
  return clusters.map((indices) => indices.map((idx) => items[idx]!))
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
