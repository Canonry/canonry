import { createLogger } from './logger.js'
import { asRecord, describeError, inclusiveDayCount, reportMonthsForDoctor } from '@ainyc/canonry-contracts'

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
 * How an integration's sync endpoint finishes. `synchronous` endpoints (GA)
 * fetch and store before they answer, so a resolved call is a completed sync.
 * `queued` endpoints only insert a run row and hand it to a background
 * executor: a resolved call proves the run was accepted, and its real outcome
 * lands later on that run row. The `<integration>.sync.recent-failures` doctor
 * checks grade the run rows of Google Ads, GTM, GBP, GSC and GA. Bing
 * `bing-inspect-sitemap` runs are not graded, and OpenAI Ads is covered only
 * by `ads.data.recent-sync`.
 */
type RefreshCompletion = 'synchronous' | 'queued'

/** The run a queued endpoint answered with: a `RunDto` carries `id`, the GBP and OpenAI Ads responses `runId`. */
function queuedRun(result: unknown): { runId: string | null; runStatus: string | null } {
  const record = asRecord(result)
  const runId = record?.runId ?? record?.id
  const runStatus = record?.status
  return {
    runId: typeof runId === 'string' ? runId : null,
    runStatus: typeof runStatus === 'string' ? runStatus : null,
  }
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
 *
 * Logs `integration.refreshed` only for a sync that completed before its
 * endpoint answered, `integration.queued` (with the run id) for one that was
 * only accepted, and `integration.refresh-failed` for an endpoint that refused.
 */
export async function refreshAllIntegrations(client: DataRefreshClient, projectName: string, now: Date = new Date()): Promise<void> {
  const integrations: Array<{ name: string; completion: RefreshCompletion; run: () => Promise<unknown> }> = [
    { name: 'gsc', completion: 'queued', run: () => client.gscSync(projectName, {}) },
    { name: 'bing', completion: 'queued', run: () => client.bingInspectSitemap(projectName, {}) },
    { name: 'ga', completion: 'synchronous', run: () => client.gaSync(projectName, { days: gaRefreshDays(now) }) },
    { name: 'gbp', completion: 'queued', run: () => client.triggerGbpSync(projectName, {}) },
    // `ads` remains the OpenAI / ChatGPT Ads integration. For scheduled
    // refreshes, Google providers have explicit names and fan out only here.
    { name: 'ads', completion: 'queued', run: () => client.triggerAdsSync(projectName) },
    { name: 'google-ads', completion: 'queued', run: () => client.triggerGoogleAdsSync(projectName) },
    { name: 'gtm', completion: 'queued', run: () => client.triggerGtmSync(projectName) },
  ]

  const results = await Promise.allSettled(integrations.map((i) => i.run()))

  results.forEach((result, idx) => {
    const { name: integration, completion } = integrations[idx]!
    if (result.status === 'rejected') {
      const reason: unknown = result.reason
      const message = describeError(reason)
      log.warn('integration.refresh-failed', { projectName, integration, error: message })
      return
    }
    switch (completion) {
      case 'synchronous':
        log.info('integration.refreshed', { projectName, integration })
        return
      case 'queued':
        log.info('integration.queued', { projectName, integration, ...queuedRun(result.value) })
        return
      default: {
        const _exhaustive: never = completion
        return _exhaustive
      }
    }
  })
}
