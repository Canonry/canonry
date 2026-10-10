/**
 * Per-provider in-process concurrency and rolling-minute dispatch guard.
 * Daily quota is persisted separately because it must survive restarts.
 */
export class ProviderExecutionGate {
  private readonly window: number[] = []
  private readonly waiters: Array<() => void> = []
  private rateTimer: ReturnType<typeof setTimeout> | undefined
  private dispatching = false
  private inFlight = 0

  constructor(private maxConcurrency: number, private maxPerMinute: number) {}

  updatePolicy(maxConcurrency: number, maxPerMinute: number): void {
    this.maxConcurrency = maxConcurrency
    this.maxPerMinute = maxPerMinute
    this.dispatchQueued()
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.waiters.push(() => { void this.execute(task, resolve, reject) })
      this.dispatchQueued()
    })
  }

  private async execute<T>(task: () => Promise<T>, resolve: (value: T) => void, reject: (reason: unknown) => void): Promise<void> {
    try {
      resolve(await task())
    } catch (error) {
      reject(error)
    } finally {
      this.inFlight--
      this.dispatchQueued()
    }
  }

  private dispatchQueued(): void {
    if (this.dispatching) return
    if (this.rateTimer !== undefined) {
      clearTimeout(this.rateTimer)
      this.rateTimer = undefined
    }
    this.dispatching = true
    try {
      while (this.waiters.length > 0 && this.inFlight < Math.max(1, this.maxConcurrency)) {
        const now = Date.now(); const windowStart = now - 60_000
        while (this.window.length > 0 && this.window[0]! < windowStart) this.window.shift()
        if (this.window.length >= this.maxPerMinute) break
        // Reserve both budgets at dispatch; a rate waiter holds no active slot.
        this.window.push(now)
        this.inFlight++
        this.waiters.shift()!()
      }
    } finally { this.dispatching = false }
    if (this.waiters.length > 0 && this.inFlight < Math.max(1, this.maxConcurrency)) {
      this.rateTimer = setTimeout(() => {
        this.rateTimer = undefined
        this.dispatchQueued()
      }, this.window[0]! + 60_000 - Date.now() + 50)
    }
  }
}

/**
 * Every gate handed out by `getSharedProviderExecutionGate`, keyed by
 * normalized provider name — one process-wide budget per upstream provider,
 * shared across every concurrent run regardless of which project queued it.
 *
 * A provider's quota policy (concurrency cap, requests/minute) is registered
 * process-wide, alongside its API key (see `ProviderRegistry.register`);
 * it is not a per-run or per-project setting. That is what makes sharing one
 * gate per provider name correct rather than merely convenient — the budget
 * being guarded is the same upstream API key no matter which run is asking.
 */
const sharedGates = new Map<string, ProviderExecutionGate>()

/**
 * The one gate for this provider, process-wide. A registration updates its
 * policy without discarding active calls or dispatch history. A run can still
 * hold its old config after a reload, so lookups never overwrite an existing
 * gate's current policy with those captured values.
 */
export function getSharedProviderExecutionGate(
  providerName: string,
  maxConcurrency: number,
  maxPerMinute: number,
): ProviderExecutionGate {
  const key = providerName.trim().toLocaleLowerCase('en')
  const existing = sharedGates.get(key)
  if (existing) return existing
  const gate = new ProviderExecutionGate(maxConcurrency, maxPerMinute)
  sharedGates.set(key, gate)
  return gate
}

export function updateSharedProviderExecutionGate(
  providerName: string,
  maxConcurrency: number,
  maxPerMinute: number,
): void {
  getSharedProviderExecutionGate(providerName, maxConcurrency, maxPerMinute)
    .updatePolicy(maxConcurrency, maxPerMinute)
}

/**
 * Test-only escape hatch. The shared gates are process-wide singletons on
 * purpose (that is the fix for NEW-3: one real budget per provider, not one
 * per run), but that means their in-flight/rate-limit state persists across
 * `test()` blocks that reuse a provider name with a different quota policy
 * within the same file. Call this between tests that need a clean budget.
 */
export function resetSharedProviderExecutionGates(): void {
  sharedGates.clear()
}
