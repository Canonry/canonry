import { createLogger } from './logger.js'

const log = createLogger('DataRefresh')

/**
 * Minimal structural view of the integration-sync calls a data-refresh needs.
 * `ApiClient` satisfies this, and tests can inject a fake without the full client.
 */
export interface DataRefreshClient {
  gscSync(project: string, body?: { days?: number; full?: boolean }): Promise<unknown>
  bingInspectSitemap(project: string, body?: { sitemapUrl?: string }): Promise<unknown>
  gaSync(project: string, body?: { days?: number; only?: string }): Promise<unknown>
  triggerGbpSync(
    project: string,
    body?: { locationNames?: string[]; daysOfMetrics?: number; monthsOfKeywords?: number },
  ): Promise<unknown>
}

/**
 * Refresh every data integration for a project in one shot: GSC, Bing, GA, GBP.
 *
 * Each integration's sync endpoint owns its own run-row lifecycle and self-gates
 * when that integration isn't connected (a clear error, logged here rather than
 * thrown). Per-integration isolation is via `Promise.allSettled`, so one failure
 * never blocks the others — mirroring the external cron this replaces. This
 * function never rejects: the caller treats it as fire-and-forget.
 */
export async function refreshAllIntegrations(client: DataRefreshClient, projectName: string): Promise<void> {
  const integrations: Array<{ name: string; run: () => Promise<unknown> }> = [
    { name: 'gsc', run: () => client.gscSync(projectName, {}) },
    { name: 'bing', run: () => client.bingInspectSitemap(projectName, {}) },
    { name: 'ga', run: () => client.gaSync(projectName, { days: 30 }) },
    { name: 'gbp', run: () => client.triggerGbpSync(projectName, {}) },
  ]

  const results = await Promise.allSettled(integrations.map((i) => i.run()))

  results.forEach((result, idx) => {
    const integration = integrations[idx]!.name
    if (result.status === 'fulfilled') {
      log.info('integration.refreshed', { projectName, integration })
    } else {
      const reason: unknown = result.reason
      const message = reason instanceof Error ? reason.message : String(reason)
      log.warn('integration.refresh-failed', { projectName, integration, error: message })
    }
  })
}
