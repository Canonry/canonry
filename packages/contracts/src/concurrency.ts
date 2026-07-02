/**
 * Generic bounded-concurrency helpers. Same rationale as `retry.ts`: without a
 * shared home, every package that needs "run these N async tasks, at most K at
 * a time" grows its own subtly different pool (batch-barrier slicing, unbounded
 * `Promise.all`, ad-hoc index juggling). The control flow lives here once;
 * callers supply only the task function.
 */

/**
 * Map `items` through an async `fn` with at most `concurrency` invocations in
 * flight at once. A small worker pool — not batch slicing — so a slow item
 * never barriers the whole batch.
 *
 * Guarantees:
 *   - **Order-preserving results.** `results[i]` is `fn(items[i], i)`'s value
 *     regardless of which item settled first.
 *   - **Bounded.** Never more than `min(concurrency, items.length)` calls are
 *     pending simultaneously. `concurrency` is floored and clamped to >= 1, so
 *     `1` degrades to a strictly serial loop.
 *   - **Fail fast, settle clean.** The FIRST rejection stops workers from
 *     claiming new items; every already-started call is awaited (no orphaned
 *     in-flight promises, no unhandled rejections), then the first error is
 *     rethrown. Partial results are discarded.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []
  const limit = Math.min(Math.max(1, Math.floor(concurrency)), items.length)
  const results = new Array<R>(items.length)
  // Shared mutable pool state. `firstFailure` is boxed so a thrown falsy value
  // is still distinguishable from "no error".
  const state: { nextIndex: number; firstFailure: { err: unknown } | null } = {
    nextIndex: 0,
    firstFailure: null,
  }

  async function worker(): Promise<void> {
    for (;;) {
      if (state.firstFailure) return
      const index = state.nextIndex++
      if (index >= items.length) return
      try {
        results[index] = await fn(items[index]!, index)
      } catch (err) {
        state.firstFailure ??= { err }
        return
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()))
  if (state.firstFailure) throw state.firstFailure.err
  return results
}
