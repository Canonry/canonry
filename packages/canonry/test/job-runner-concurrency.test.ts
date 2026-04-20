import { test, expect } from 'vitest'
import { runWithConcurrency } from '../src/job-runner.js'

test('runWithConcurrency honors the concurrency cap', async () => {
  const items = Array.from({ length: 20 }, (_, i) => i)
  let active = 0
  let peak = 0

  await runWithConcurrency(items, 3, async () => {
    active++
    peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 5))
    active--
  })

  expect(peak).toBeLessThanOrEqual(3)
  expect(peak).toBeGreaterThan(0)
})

test('runWithConcurrency processes every item exactly once', async () => {
  const items = ['a', 'b', 'c', 'd', 'e']
  const seen: string[] = []

  await runWithConcurrency(items, 2, async (item) => {
    seen.push(item)
  })

  expect(seen.sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
})

test('runWithConcurrency returns immediately for empty input', async () => {
  let called = false
  await runWithConcurrency([], 5, async () => {
    called = true
  })
  expect(called).toBe(false)
})

test('runWithConcurrency clamps cap to item count', async () => {
  const items = [1, 2]
  let peak = 0
  let active = 0

  await runWithConcurrency(items, 100, async () => {
    active++
    peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 5))
    active--
  })

  expect(peak).toBeLessThanOrEqual(2)
})

test('runWithConcurrency propagates worker errors', async () => {
  await expect(
    runWithConcurrency([1, 2, 3], 2, async (item) => {
      if (item === 2) throw new Error('boom')
    }),
  ).rejects.toThrow('boom')
})
