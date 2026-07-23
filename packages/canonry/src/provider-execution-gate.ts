/**
 * Per-provider in-process concurrency and rolling-minute dispatch guard.
 * Daily quota is persisted separately because it must survive restarts.
 */
export class ProviderExecutionGate {
  private readonly window: number[] = []
  private readonly waiters: Array<() => void> = []
  private rateLimitChain = Promise.resolve()
  private inFlight = 0

  constructor(private readonly maxConcurrency: number, private readonly maxPerMinute: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      await this.waitForRateLimit()
      return await task()
    } finally {
      this.release()
    }
  }

  private async acquire(): Promise<void> {
    if (this.inFlight < Math.max(1, this.maxConcurrency)) { this.inFlight++; return }
    await new Promise<void>(resolve => this.waiters.push(resolve))
    this.inFlight++
  }
  private release(): void { this.inFlight = Math.max(0, this.inFlight - 1); this.waiters.shift()?.() }
  private async waitForRateLimit(): Promise<void> {
    let releaseChain: (() => void) | undefined
    const previousChain = this.rateLimitChain
    this.rateLimitChain = new Promise<void>(resolve => { releaseChain = resolve })
    await previousChain
    try {
      const now = Date.now(); const windowStart = now - 60_000
      while (this.window.length > 0 && this.window[0]! < windowStart) this.window.shift()
      if (this.window.length >= this.maxPerMinute) {
        await new Promise(resolve => setTimeout(resolve, this.window[0]! + 60_000 - now + 50))
        const nextWindowStart = Date.now() - 60_000
        while (this.window.length > 0 && this.window[0]! < nextWindowStart) this.window.shift()
      }
      this.window.push(Date.now())
    } finally { releaseChain?.() }
  }
}
