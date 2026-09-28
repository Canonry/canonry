import { createLogger } from './logger.js'
import { describeError, inclusiveDayCount, reportMonthsForDoctor } from '@ainyc/canonry-contracts'

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
  /** OpenAI / ChatGPT Ads — intentionally distinct from Google Ads. */
  triggerAdsSync(project: string): Promise<unknown>
  /** Queues bounded, read-only Google Ads evidence collection. */
  triggerGoogleAdsSync(project: string): Promise<unknown>
  /** Queues bounded, read-only Google Tag Manager evidence collection. */
  triggerGtmSync(project: string): Promise<unknown>
}

/**
 * The GA window a scheduled refresh syncs: the last 30 days, except through
 * UTC day 3, when it reaches back to the first day of the closed month the
 * monthly report is built from. A date inside the latest sync with no GA row
 * then provably had no traffic, instead of reading as unknown.
 */
export function gaRefreshDays(now: Date = new Date()): number {
  const [reportMonth] = reportMonthsForDoctor(undefined, now)
  const reach = inclusiveDayCount(`${reportMonth}-01`, now.toISOString().slice(0, 10)) ?? 0
  return Math.max(30, reach)
}

/**
 * Refresh every data integration for a project in one shot: GSC, Bing, GA,
 * GBP, OpenAI / ChatGPT Ads, Google Ads, and Google Tag Manager.
 *
 * Each integration's sync endpoint owns its own run-row lifecycle and self-gates
 * when that integration isn't connected (a clear error, logged here rather than
 * thrown). Per-integration isolation is via `Promise.allSettled`, so one failure
 * never blocks the others — mirroring the external cron this replaces. This
 * function never rejects: the caller treats it as fire-and-forget.
 */
export async function refreshAllIntegrations(client: DataRefreshClient, projectName: string, now: Date = new Date()): Promise<void> {
  const integrations: Array<{ name: string; run: () => Promise<unknown> }> = [
    { name: 'gsc', run: () => client.gscSync(projectName, {}) },
    { name: 'bing', run: () => client.bingInspectSitemap(projectName, {}) },
    { name: 'ga', run: () => client.gaSync(projectName, { days: gaRefreshDays(now) }) },
    { name: 'gbp', run: () => client.triggerGbpSync(projectName, {}) },
    // `ads` remains the OpenAI / ChatGPT Ads integration. For scheduled
    // refreshes, Google providers have explicit names and fan out only here.
    { name: 'ads', run: () => client.triggerAdsSync(projectName) },
    { name: 'google-ads', run: () => client.triggerGoogleAdsSync(projectName) },
    { name: 'gtm', run: () => client.triggerGtmSync(projectName) },
  ]

  const results = await Promise.allSettled(integrations.map((i) => i.run()))

  results.forEach((result, idx) => {
    const integration = integrations[idx]!.name
    if (result.status === 'fulfilled') {
      log.info('integration.refreshed', { projectName, integration })
    } else {
      const reason: unknown = result.reason
      const message = describeError(reason)
      log.warn('integration.refresh-failed', { projectName, integration, error: message })
    }
  })
}
