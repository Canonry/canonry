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
