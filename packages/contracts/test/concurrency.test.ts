import { describe, expect, it } from 'vitest'
import { mapWithConcurrency } from '../src/index.js'

/** A promise whose resolution the test controls explicitly. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Let queued microtasks (and 0ms timers) drain so starts/settles propagate. */
function tick(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

describe('mapWithConcurrency', () => {
  it('returns [] for empty input without invoking fn', async () => {
    let calls = 0
    const result = await mapWithConcurrency([], 4, async () => {
      calls++
      return 1
    })
    expect(result).toEqual([])
    expect(calls).toBe(0)
  })

  it('preserves input order even when items resolve out of order', async () => {
    const items = ['a', 'b', 'c', 'd']
    const gates = items.map(() => deferred<void>())
    const promise = mapWithConcurrency(items, 4, async (item, index) => {
      await gates[index]!.promise
      return `${item}:${index}`
    })
    // Resolve in REVERSE order — completion order must not leak into results.
    gates[3]!.resolve()
    gates[2]!.resolve()
    gates[1]!.resolve()
    gates[0]!.resolve()
    await expect(promise).resolves.toEqual(['a:0', 'b:1', 'c:2', 'd:3'])
  })

  it('never exceeds the concurrency cap and reuses freed slots', async () => {
    const gates = Array.from({ length: 7 }, () => deferred<void>())
    let inFlight = 0
    let maxInFlight = 0
    const started: number[] = []
    const promise = mapWithConcurrency(gates, 3, async (gate, index) => {
      started.push(index)
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await gate.promise
      inFlight--
      return index
    })

    await tick()
    // Only the first `concurrency` items may start before anything settles.
    expect(started).toEqual([0, 1, 2])

    // Freeing one slot admits exactly one more item.
    gates[1]!.resolve()
    await tick()
    expect(started).toEqual([0, 1, 2, 3])

    for (const gate of gates) gate.resolve()
    await expect(promise).resolves.toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(maxInFlight).toBe(3)
  })

  it('concurrency 1 degrades to a strictly serial loop', async () => {
    const order: string[] = []
    await mapWithConcurrency(['a', 'b', 'c'], 1, async (item) => {
      order.push(`start:${item}`)
      await tick()
      order.push(`end:${item}`)
      return item
    })
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c'])
  })

  it('clamps a fractional / sub-1 concurrency to 1', async () => {
    let inFlight = 0
    let maxInFlight = 0
    await mapWithConcurrency([1, 2, 3], 0, async (n) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await tick()
      inFlight--
      return n
    })
    expect(maxInFlight).toBe(1)
  })

  it('propagates the first error, stops claiming new items, and settles in-flight work', async () => {
    const gates = Array.from({ length: 6 }, () => deferred<void>())
    const started: number[] = []
    let settledAfterFailure = false
    const promise = mapWithConcurrency(gates, 2, async (gate, index) => {
      started.push(index)
      if (index === 1) {
        await gate.promise
        throw new Error('probe 1 exploded')
      }
      await gate.promise
      settledAfterFailure = true
      return index
    })
    // Swallow the eventual rejection so the assertion below controls it.
    promise.catch(() => {})

    await tick()
    expect(started).toEqual([0, 1])

    // Fail item 1 (its gate resolves, then the task throws) — the freed
    // worker must NOT claim item 2.
    gates[1]!.resolve()
    await tick()
    expect(started).toEqual([0, 1])

    // The pool waits for the still-in-flight item 0 before rejecting.
    gates[0]!.resolve()
    await expect(promise).rejects.toThrow('probe 1 exploded')
    expect(settledAfterFailure).toBe(true)
    expect(started).toEqual([0, 1])
  })

  it('rethrows a falsy thrown value', async () => {
    const falsy: unknown = null
    await expect(
      mapWithConcurrency([1], 2, async () => { throw falsy }),
    ).rejects.toBeNull()
  })

  it('handles concurrency larger than the item count', async () => {
    const result = await mapWithConcurrency([1, 2], 8, async n => n * 2)
    expect(result).toEqual([2, 4])
  })
})
