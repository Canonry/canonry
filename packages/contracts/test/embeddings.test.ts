import { test, expect } from 'vitest'
import {
  cosineSimilarity,
  clusterByCosine,
  pickClusterRepresentative,
  DISCOVERY_DEFAULT_DEDUP_THRESHOLD,
  computeDedupSimilarityStats,
} from '../src/index.js'

/**
 * Unit vector at `deg` degrees on the unit circle — the pairwise cosine of
 * two such vectors is exactly cos(Δdeg), so tests can construct seed sets
 * with a known pairwise-similarity structure.
 */
function unitVec(deg: number): number[] {
  const rad = (deg * Math.PI) / 180
  return [Math.cos(rad), Math.sin(rad)]
}

test('cosineSimilarity of a vector with itself is 1', () => {
  expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1)
  expect(cosineSimilarity([3, 4], [3, 4])).toBeCloseTo(1)
})

test('cosineSimilarity of orthogonal vectors is 0', () => {
  expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
  expect(cosineSimilarity([1, 0, 0], [0, 0, 1])).toBeCloseTo(0)
})

test('cosineSimilarity of opposite vectors is -1', () => {
  expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1)
})

test('cosineSimilarity returns 0 when either vector is all-zero (avoids NaN)', () => {
  expect(cosineSimilarity([0, 0, 0], [1, 1, 1])).toBe(0)
  expect(cosineSimilarity([1, 1, 1], [0, 0, 0])).toBe(0)
})

test('cosineSimilarity throws on length mismatch', () => {
  expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(/length/i)
})

test('cosineSimilarity throws on empty vectors', () => {
  expect(() => cosineSimilarity([], [])).toThrow(/empty/i)
})

test('clusterByCosine groups two near-identical items at threshold 0.99', () => {
  const items = ['a', 'b']
  const vectors = [
    [1, 0, 0],
    [0.999, 0.001, 0.001],
  ]
  const clusters = clusterByCosine(items, vectors, 0.99)
  expect(clusters).toHaveLength(1)
  expect(clusters[0]).toEqual(['a', 'b'])
})

test('clusterByCosine keeps dissimilar items in separate clusters', () => {
  const items = ['a', 'b']
  const vectors = [
    [1, 0, 0],
    [0, 1, 0],
  ]
  const clusters = clusterByCosine(items, vectors, 0.85)
  expect(clusters).toHaveLength(2)
})

test('clusterByCosine produces a mix when only some pairs cross the threshold', () => {
  const items = ['ai-quoting', 'home-quoting', 'roofing-software']
  const vectors = [
    [1.0, 0.0, 0.0],
    [0.95, 0.05, 0.0],
    [0.0, 0.0, 1.0],
  ]
  const clusters = clusterByCosine(items, vectors, 0.9)
  expect(clusters).toHaveLength(2)
  // Order within a cluster preserves insertion order.
  expect(clusters.find((c) => c.includes('roofing-software'))).toEqual(['roofing-software'])
  expect(clusters.find((c) => c.includes('ai-quoting'))).toEqual(['ai-quoting', 'home-quoting'])
})

test('clusterByCosine returns empty array for empty input', () => {
  expect(clusterByCosine([], [], 0.85)).toEqual([])
})

test('clusterByCosine throws when items and vectors have different lengths', () => {
  expect(() => clusterByCosine(['a', 'b'], [[1, 0]], 0.85)).toThrow(/length/i)
})

test('clusterByCosine throws on out-of-range threshold', () => {
  expect(() => clusterByCosine(['a'], [[1]], 1.5)).toThrow()
  expect(() => clusterByCosine(['a'], [[1]], -0.1)).toThrow()
})

test('clusterByCosine merges existing clusters when a bridge item arrives LAST (true single-link)', () => {
  // Setup: a ≈ b via b as bridge, b ≈ c via b as bridge, a ≢ c directly.
  // Critical: b is inserted LAST so the buggy greedy implementation would
  // merge b into a's cluster and leave c isolated.
  const items = ['a', 'c', 'b']
  const vectors = [
    [1.0, 0.0, 0.0], // a
    [0.5, 0.87, 0.0], // c — sim(a,c) ≈ 0.5
    [0.9, 0.44, 0.0], // b — sim(a,b) ≈ 0.9, sim(b,c) ≈ 0.83
  ]
  // Pin the pair similarities so the test is self-evident.
  expect(cosineSimilarity(vectors[0]!, vectors[1]!)).toBeLessThan(0.8)
  expect(cosineSimilarity(vectors[0]!, vectors[2]!)).toBeGreaterThan(0.8)
  expect(cosineSimilarity(vectors[1]!, vectors[2]!)).toBeGreaterThan(0.8)

  const clusters = clusterByCosine(items, vectors, 0.8)
  // True single-link: all three end up in one cluster via the b-bridge.
  // Greedy-first-match would (incorrectly) return [['a','b'], ['c']].
  expect(clusters).toEqual([['a', 'c', 'b']])
})

test('clusterByCosine merges two pre-existing clusters when a bridge item connects them', () => {
  // Variant: insert two well-separated clusters first, then the bridge.
  // a₁ ≈ a₂ form a cluster; c₁ ≈ c₂ form another; b bridges both.
  const items = ['a1', 'a2', 'c1', 'c2', 'b']
  const vectors = [
    [1.0, 0.0, 0.0, 0.0], // a1
    [0.99, 0.0, 0.0, 0.0], // a2 — sim(a1,a2) ≈ 1
    [0.0, 0.0, 1.0, 0.0], // c1 — sim(a*,c*) ≈ 0
    [0.0, 0.0, 0.99, 0.0], // c2 — sim(c1,c2) ≈ 1
    [0.7, 0.0, 0.7, 0.0], // b — sim(a*,b) ≈ 0.7, sim(c*,b) ≈ 0.7
  ]
  const clusters = clusterByCosine(items, vectors, 0.65)
  expect(clusters).toHaveLength(1)
  expect(clusters[0]).toEqual(['a1', 'a2', 'c1', 'c2', 'b'])
})

// ---------------------------------------------------------------------------
// Seed-dedup band tests. Empirically (gemini-embedding-001, CLUSTERING task,
// 768 dims) distinct buyer intents in a homogeneous local-service vertical
// score ~0.82-0.91 pairwise while true near-duplicate phrasings score
// ~0.987-0.998. The default threshold must sit in the gap between those
// bands or single-link chaining collapses the entire seed set.
// ---------------------------------------------------------------------------

test('distinct-intent band survives dedup at the default threshold while near-dups merge', () => {
  // Four "queries": one true near-dup pair (2° apart, cos ≈ 0.9994) plus two
  // further distinct intents, adjacent pairs 22° apart (cos ≈ 0.927 — inside
  // the distinct-intent band relative to the old 0.85 default).
  const items = ['repair-cost', 'cost-of-repair', 'emergency-repair', 'insurance-coverage']
  const vectors = [unitVec(0), unitVec(2), unitVec(22), unitVec(44)]

  // Pin the pairwise structure so the test is self-evident.
  expect(cosineSimilarity(vectors[0]!, vectors[1]!)).toBeGreaterThan(0.99) // near-dup pair
  expect(cosineSimilarity(vectors[0]!, vectors[2]!)).toBeGreaterThan(0.85) // distinct intents,
  expect(cosineSimilarity(vectors[0]!, vectors[2]!)).toBeLessThan(0.95) //   above the OLD default
  expect(cosineSimilarity(vectors[2]!, vectors[3]!)).toBeGreaterThan(0.85)
  expect(cosineSimilarity(vectors[2]!, vectors[3]!)).toBeLessThan(0.95)

  const clusters = clusterByCosine(items, vectors, DISCOVERY_DEFAULT_DEDUP_THRESHOLD)
  expect(clusters).toEqual([
    ['repair-cost', 'cost-of-repair'], // only the true near-dups merge
    ['emergency-repair'],
    ['insurance-coverage'],
  ])
})

test('a threshold inside the distinct-intent band chain-collapses the whole set (the regression the default avoids)', () => {
  // Same vectors as above at the OLD default (0.85): every adjacent pair
  // (cos ≈ 0.927) is a single-link bridge, so the entire set merges into one
  // cluster even though the endpoints are only cos(44°) ≈ 0.72 apart. This is
  // the degenerate "30 raw seeds → 1 canonical" failure observed on
  // homogeneous local-service verticals.
  const items = ['repair-cost', 'cost-of-repair', 'emergency-repair', 'insurance-coverage']
  const vectors = [unitVec(0), unitVec(2), unitVec(22), unitVec(44)]
  expect(cosineSimilarity(vectors[0]!, vectors[3]!)).toBeLessThan(0.85) // endpoints dissimilar

  const clusters = clusterByCosine(items, vectors, 0.85)
  expect(clusters).toHaveLength(1)
  expect(clusters[0]).toEqual(items)
})

test('DISCOVERY_DEFAULT_DEDUP_THRESHOLD sits in the gap between the measured bands', () => {
  // Distinct intents top out ~0.91; true near-dups bottom out ~0.987. A
  // default below 0.92 re-opens the chain-collapse; above 0.985 it stops
  // merging genuine rephrasings.
  expect(DISCOVERY_DEFAULT_DEDUP_THRESHOLD).toBeGreaterThan(0.92)
  expect(DISCOVERY_DEFAULT_DEDUP_THRESHOLD).toBeLessThan(0.985)
})

test('pickClusterRepresentative returns the shortest member by default', () => {
  expect(pickClusterRepresentative(['best ai home estimating tools for contractors', 'ai quoting'])).toBe(
    'ai quoting',
  )
})

test('pickClusterRepresentative falls back to first member on tie', () => {
  expect(pickClusterRepresentative(['abc', 'def'])).toBe('abc')
})

test('pickClusterRepresentative on single-member cluster returns that member', () => {
  expect(pickClusterRepresentative(['only'])).toBe('only')
})

// ---------------------------------------------------------------------------
// computeDedupSimilarityStats — the calibration diagnostics the 0.95 threshold
// decision needs: per-cluster cohesion and how much pairwise mass sits in the
// ambiguous 0.90-0.97 band.
// ---------------------------------------------------------------------------

/** 2-d vector with a chosen cosine against [1, 0]. */
function vecWithCosine(cos: number): number[] {
  return [cos, Math.sqrt(Math.max(0, 1 - cos * cos))]
}

test('computeDedupSimilarityStats reports the min pairwise cosine per multi-member cluster', () => {
  const vectors = [[1, 0], vecWithCosine(0.99), vecWithCosine(0.96), [0, 1]]
  // Cluster 0 holds indices 0,1,2 (min pair = cos(v1,v2) < 0.96-ish), cluster 1 is a singleton.
  const stats = computeDedupSimilarityStats(vectors, [[0, 1, 2], [3]])
  expect(stats.perClusterMinSimilarity).toHaveLength(1) // singletons carry no pairwise cohesion
  expect(stats.perClusterMinSimilarity[0]!).toBeLessThan(0.97)
  expect(stats.perClusterMinSimilarity[0]!).toBeGreaterThan(0.9)
})

test('computeDedupSimilarityStats measures the 0.90-0.97 band fraction over ALL pairs', () => {
  // Three vectors: cos(0,1)=0.93 (in band), cos(0,2)=0.5 (below), cos(1,2) computed.
  const vectors = [[1, 0], vecWithCosine(0.93), vecWithCosine(0.5)]
  const stats = computeDedupSimilarityStats(vectors, [[0, 1], [2]])
  expect(stats.pairsTotal).toBe(3)
  // Exactly one of the three pairs (0,1) is guaranteed inside [0.90, 0.97).
  expect(stats.bandPairFraction).not.toBeNull()
  expect(stats.bandPairFraction!).toBeCloseTo(1 / 3, 3) // rounded to 4 decimals by contract
})

test('computeDedupSimilarityStats is null-safe for degenerate inputs', () => {
  expect(computeDedupSimilarityStats([], [])).toEqual({
    perClusterMinSimilarity: [],
    bandPairFraction: null,
    pairsTotal: 0,
  })
  expect(computeDedupSimilarityStats([[1, 0]], [[0]])).toEqual({
    perClusterMinSimilarity: [],
    bandPairFraction: null,
    pairsTotal: 0,
  })
})
