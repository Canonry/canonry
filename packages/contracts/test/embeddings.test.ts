import { test, expect } from 'vitest'
import {
  cosineSimilarity,
  clusterByCosine,
  pickClusterRepresentative,
} from '../src/index.js'

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
