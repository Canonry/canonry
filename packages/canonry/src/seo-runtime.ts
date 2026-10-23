import { eq, inArray } from 'drizzle-orm'
import { SeoAdapterOutcomes, SeoProviders, SeoRunStatuses } from '@canonry/canonry-contracts'
import type { SeoInstallConfig } from '@canonry/canonry-config'
import { createDataForSeoAdapter } from '@canonry/canonry-integration-dataforseo'
import { SeoRepository, emptySeoResults, seoJobs, seoTasks, type DatabaseClient } from '@canonry/canonry-db'
import { createLogger } from './logger.js'
import type { SeoRoutesOptions } from '@canonry/canonry-api-routes'

/** One bounded dispatch loop; every claim is persisted before a paid POST. */
export class SeoRuntime {
  private started = false
  private timer: ReturnType<typeof setInterval> | null = null
  private running: Promise<void> | null = null
  private readonly repository: SeoRepository
  constructor(private readonly db: DatabaseClient, private readonly config: () => SeoInstallConfig | undefined) {
    this.repository = new SeoRepository(db)
  }
  readonly getRuntime: NonNullable<SeoRoutesOptions['getSeoRuntime']> = () => {
    let config: SeoInstallConfig | undefined
    try { config = this.config() } catch { return null }
    if (!config?.enabled) return null
    const connections = Object.entries(config.connections).filter(([, value]) => value.enabled).map(([id, value]) => {
      switch (value.provider) {
        case SeoProviders.dataforseo: return { id, label: value.label, adapter: createDataForSeoAdapter(value) }
      }
    })
    return { policy: config.policy, connections }
  }
  start(): void {
    if (this.started) return
    this.repository.recover()
    this.started = true
    this.timer = setInterval(() => this.wake(), 5000)
    this.timer.unref()
    this.wake()
  }
  wake(): void {
    if (!this.started || this.running) return
    this.running = Promise.resolve().then(async () => { this.repository.recover(); await this.drain() }).catch(() => { createLogger('SeoRuntime').error('seo.dispatch.failed', { message: 'SEO dispatch paused; durable receipts remain available.' }) }).finally(() => { this.running = null })
  }
  async stop(): Promise<void> {
    this.started = false
    if (this.timer) clearInterval(this.timer)
    await this.running
  }
  private async drain(): Promise<void> {
    while (this.started) {
      const jobs = this.db.select().from(seoJobs).where(inArray(seoJobs.status, [SeoRunStatuses.queued, SeoRunStatuses.running])).all()
      let progressed = false
      for (const job of jobs) {
        if (!this.started) return
        const runtime = this.getRuntime()
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
        const heartbeat = setInterval(() => {
          try { this.repository.renew(task.id, task.leaseOwner!) } catch { createLogger('SeoRuntime').error('seo.lease.failed', { message: 'SEO task lease could not be renewed.' }) }
        }, 30_000)
        heartbeat.unref()
        try {
          const result = await connection.adapter.execute(task.request)
          this.repository.settle(task.id, result, task.leaseOwner!)
          if (result.outcome === SeoAdapterOutcomes.unknown || result.tasks.some(receipt => receipt.costMicros === null) || this.db.select().from(seoTasks).where(eq(seoTasks.id, task.id)).get()?.status === SeoRunStatuses['reconciliation-required']) this.repository.cancel(job.id)
        } catch {
          // A thrown transport error cannot prove the paid call was rejected.
          this.repository.settle(task.id, { outcome: SeoAdapterOutcomes.unknown, tasks: [], results: emptySeoResults(), error: null, fetchedAt: new Date().toISOString() }, task.leaseOwner!)
          this.repository.cancel(job.id)
        } finally { clearInterval(heartbeat) }
      }
      if (!progressed) return
    }
  }
}
