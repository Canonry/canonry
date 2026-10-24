import { eq, inArray } from 'drizzle-orm'
import { SeoAdapterOutcomes, SeoProviders, SeoRunStatuses, type SeoAdapter, type SeoAdapterRequest, type SeoAdapterResult } from '@canonry/canonry-contracts'
import type { SeoInstallConfig } from '@canonry/canonry-config'
import { createDataForSeoAdapter } from '@canonry/canonry-integration-dataforseo'
import { SeoRepository, emptySeoResults, seoJobs, seoTasks, type DatabaseClient } from '@canonry/canonry-db'
import { createLogger } from './logger.js'
import type { SeoRoutesOptions } from '@canonry/canonry-api-routes'

type RuntimeSnapshot = ReturnType<NonNullable<SeoRoutesOptions['getSeoRuntime']>>
interface PendingSettlement {
  jobId: string
  owner: string
  result: SeoAdapterResult
  settled: boolean
  heartbeat: ReturnType<typeof setInterval>
}

/** One bounded dispatch loop; every claim is persisted before a paid POST. */
export class SeoRuntime {
  private started = false
  private timer: ReturnType<typeof setInterval> | null = null
  private running: Promise<void> | null = null
  private activeRequest: AbortController | null = null
  private readonly pending = new Map<string, PendingSettlement>()
  private cached: { fingerprint: string; runtime: RuntimeSnapshot } | null = null
  private configUnavailable = false
  private readonly repository: SeoRepository
  constructor(
    private readonly db: DatabaseClient,
    private readonly config: () => SeoInstallConfig | undefined,
    private readonly fingerprint?: () => string,
  ) {
    this.repository = new SeoRepository(db)
  }
  readonly getRuntime: NonNullable<SeoRoutesOptions['getSeoRuntime']> = () => {
    try {
      const fingerprint = this.fingerprint?.()
      if (!this.configUnavailable && fingerprint !== undefined && this.cached?.fingerprint === fingerprint) return this.cached.runtime
      const config = this.config()
      if (fingerprint !== undefined && this.fingerprint?.() !== fingerprint) throw new Error('SEO configuration changed during reload.')
      const runtime: RuntimeSnapshot = config?.enabled ? {
        policy: config.policy,
        connections: Object.entries(config.connections).filter(([, value]) => value.enabled).map(([id, value]) => {
          switch (value.provider) {
            case SeoProviders.dataforseo: return { id, label: value.label, adapter: createDataForSeoAdapter(value) }
          }
        }),
      } : null
      this.configUnavailable = false
      this.cached = fingerprint === undefined ? null : { fingerprint, runtime }
      return runtime
    } catch {
      // A missing or partially written file is not an instruction to cancel accepted work.
      this.configUnavailable = true
      return null
    }
  }
  start(): void {
    if (this.started) return
    this.started = true
    for (const [id, entry] of this.pending) {
      clearInterval(entry.heartbeat)
      entry.heartbeat = this.heartbeat(id, entry.owner)
    }
    this.timer = setInterval(() => this.wake(), 5000)
    this.timer.unref()
    this.wake()
  }
  wake(): void {
    if (!this.started || this.running) return
    this.running = Promise.resolve().then(async () => {
      // A known response must reach storage before stale-lease recovery considers its task.
      if (!this.flushSettlements()) return
      this.repository.recover()
      await this.drain()
    }).catch(() => { createLogger('SeoRuntime').error('seo.dispatch.failed', { message: 'SEO dispatch paused; durable receipts remain available.' }) }).finally(() => { this.running = null })
  }
  async stop(): Promise<void> {
    this.started = false
    if (this.timer) clearInterval(this.timer)
    this.activeRequest?.abort()
    await this.running
    this.flushSettlements()
    for (const entry of this.pending.values()) clearInterval(entry.heartbeat)
    if (this.pending.size) createLogger('SeoRuntime').error('seo.shutdown.unpersisted', { message: 'SEO provider receipts could not be saved before shutdown. Reservations remain held for operator reconciliation.' })
  }
  private heartbeat(taskId: string, owner: string): ReturnType<typeof setInterval> {
    const timer = setInterval(() => {
      try { this.repository.renew(taskId, owner) } catch { createLogger('SeoRuntime').error('seo.lease.failed', { message: 'SEO task lease could not be renewed.' }) }
    }, 30_000)
    timer.unref()
    return timer
  }
  private flushSettlements(): boolean {
    for (const [id, entry] of this.pending) {
      try {
        if (!entry.settled) {
          if (!this.repository.settle(id, entry.result, entry.owner)) {
            createLogger('SeoRuntime').error('seo.receipt.superseded', { message: 'SEO receipt could not replace an already reconciled or differently owned task.' })
            clearInterval(entry.heartbeat)
            this.pending.delete(id)
            continue
          }
          entry.settled = true
        }
        if (entry.result.outcome === SeoAdapterOutcomes.unknown || entry.result.tasks.some(receipt => receipt.costMicros === null) || this.db.select().from(seoTasks).where(eq(seoTasks.id, id)).get()?.status === SeoRunStatuses['reconciliation-required']) this.repository.cancel(entry.jobId)
        clearInterval(entry.heartbeat)
        this.pending.delete(id)
      } catch {
        // Keep the exact financial receipt and evidence; retry storage, never the paid call.
        createLogger('SeoRuntime').error('seo.receipt.persistence-failed', { message: 'SEO receipt persistence will be retried. Further dispatch is paused.' })
        return false
      }
    }
    return true
  }
  private async execute(adapter: SeoAdapter, request: SeoAdapterRequest): Promise<SeoAdapterResult> {
    const controller = new AbortController()
    this.activeRequest = controller
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)])
    const unknown = (): SeoAdapterResult => ({ outcome: SeoAdapterOutcomes.unknown, tasks: [], results: emptySeoResults(), error: null, fetchedAt: new Date().toISOString() })
    let timeout: ReturnType<typeof setTimeout> | undefined
    let onAbort: () => void = () => {}
    const aborted = new Promise<SeoAdapterResult>(resolve => {
      // Give a compliant adapter time to return a known rejection receipt when aborted
      // during backoff. A transport that ignores abort cannot hold shutdown indefinitely.
      onAbort = () => { timeout = setTimeout(() => resolve(unknown()), 500) }
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try { return await Promise.race([adapter.execute(request, { signal }), aborted]) }
    catch { return unknown() }
    finally {
      signal.removeEventListener('abort', onAbort)
      if (timeout) clearTimeout(timeout)
      this.activeRequest = null
    }
  }
  private async drain(): Promise<void> {
    while (this.started) {
      const jobs = this.db.select().from(seoJobs).where(inArray(seoJobs.status, [SeoRunStatuses.queued, SeoRunStatuses.running])).all()
      let progressed = false
      for (const job of jobs) {
        if (!this.started) return
        const runtime = this.getRuntime()
        if (!runtime && this.configUnavailable) return
        const connection = runtime?.connections.find(connection => connection.id === job.connectionId && connection.adapter.accountKey === job.accountKey)
        if (!runtime || !connection || !job.projectId || !job.runId || job.cancelRequested) {
          this.repository.cancel(job.id)
          continue
        }
        const heldTasks = this.db.select().from(seoTasks).where(eq(seoTasks.jobId, job.id)).all()
        let pricesSafe = false
        try { pricesSafe = heldTasks.filter(task => task.status === SeoRunStatuses.queued).every(task => { const estimate = connection.adapter.estimate(task.request); return estimate.maxCostMicros <= task.reservedMicros && estimate.catalogRevision === task.catalogRevision }) } catch { pricesSafe = false }
        if (!pricesSafe) { this.repository.cancel(job.id); continue }
        const task = this.repository.claim(job.id, { ...runtime.policy, accountKey: connection.adapter.accountKey })
        if (!task) continue
        progressed = true
        const owner = task.leaseOwner!
        const heartbeat = this.heartbeat(task.id, owner)
        const result = await this.execute(connection.adapter, task.request)
        this.pending.set(task.id, { jobId: job.id, owner, result, settled: false, heartbeat })
        if (!this.flushSettlements()) return
      }
      if (!progressed) return
    }
  }
}
