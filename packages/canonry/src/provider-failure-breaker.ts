import { describeError } from '@canonry/canonry-contracts'

/**
 * Stops calling a provider for the rest of one sweep once its calls keep
 * failing. A call reaches here only after the adapter spent its retries, so a
 * provider that failed `threshold` calls in a row is down or refusing this
 * account (no credits, a revoked key). Each further call would only make the
 * run wait through the same retries before failing the same way.
 */
export class ProviderFailureBreaker {
  private readonly streaks = new Map<string, number>()
  private readonly stopped = new Map<string, string>()

  constructor(private readonly threshold = 2) {}

  /** The error that stopped this provider, or undefined while it may still be called. */
  stoppedBy(provider: string): string | undefined {
    return this.stopped.get(provider)
  }

  succeeded(provider: string): void {
    this.streaks.set(provider, 0)
  }

  failed(provider: string, error: string): void {
    const streak = (this.streaks.get(provider) ?? 0) + 1
    this.streaks.set(provider, streak)
    if (streak >= this.threshold && !this.stopped.has(provider)) this.stopped.set(provider, error)
  }

  /**
   * Makes one call and counts its outcome before returning. Call it inside the
   * provider's execution gate, so the outcome is counted before the gate lets
   * the next waiting call through and that call sees the streak.
   */
  async track<T>(provider: string, call: () => Promise<T>): Promise<T> {
    try {
      const result = await call()
      this.succeeded(provider)
      return result
    } catch (error) {
      this.failed(provider, describeError(error))
      throw error
    }
  }
}
