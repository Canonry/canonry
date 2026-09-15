import { desc, eq } from 'drizzle-orm'
import { CheckCategories, CheckScopes, CheckStatuses } from '@ainyc/canonry-contracts'
import { gaDailyTotals, gscDailyTotals } from '@ainyc/canonry-db'
import type { CheckDefinition, CheckOutput, DoctorContext } from '../types.js'

/**
 * Is daily data still ARRIVING, not just "is the connection valid"?
 *
 * The auth checks prove a token works. They cannot see a sync that succeeds
 * and returns nothing: a client's GA4 tag vanished from their site, ga-sync
 * kept completing with zero new rows for two weeks, and every check stayed
 * green. The only honest signal is the newest stored date, so these read it.
 *
 * Thresholds sit above each source's normal lag. GA4 reports yesterday, so
 * three days without a new date is already unusual. Search Console runs two to
 * three days behind, so it gets two more. `aging` warns and already notifies
 * through health.degraded; `stale` escalates the same alert to fail.
 */
export const GA_DATA_AGING_DAYS = 3
export const GA_DATA_STALE_DAYS = 5
export const GSC_DATA_AGING_DAYS = 5
export const GSC_DATA_STALE_DAYS = 7

const DAY_MS = 24 * 60 * 60 * 1000

/** Whole UTC days between a stored `YYYY-MM-DD` and today. Null when unparseable. */
export function daysSinceDate(date: string, now: Date = new Date()): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) return null
  const stored = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return Math.floor((today - stored) / DAY_MS)
}

interface FreshnessSpec {
  source: 'ga' | 'gsc'
  label: string
  agingDays: number
  staleDays: number
  syncCommand: (projectName: string) => string
  whenSilent: string
}

function grade(spec: FreshnessSpec, projectName: string, newestDate: string | undefined): CheckOutput {
  const code = (suffix: string) => `${spec.source}.data.${suffix}`
  const sync = spec.syncCommand(projectName)
  if (!newestDate) {
    return {
      status: CheckStatuses.warn,
      code: code('never-synced'),
      summary: `${spec.label} is connected but no daily data has been stored yet.`,
      remediation: `Run \`${sync}\`, or wait for the next scheduled data refresh.`,
    }
  }
  const age = daysSinceDate(newestDate)
  if (age === null) {
    return {
      status: CheckStatuses.warn,
      code: code('unreadable-date'),
      summary: `Newest stored ${spec.label} date "${newestDate}" is not a calendar date.`,
      remediation: null,
      details: { newestDate },
    }
  }
  const details = { newestDate, ageDays: age, agingDays: spec.agingDays, staleDays: spec.staleDays }
  const remediation = `${spec.whenSilent} Then run \`${sync}\`.`
  if (age >= spec.staleDays) {
    return {
      status: CheckStatuses.fail,
      code: code('stale'),
      summary: `No ${spec.label} data newer than ${newestDate} (${age} days).`,
      remediation,
      details,
    }
  }
  if (age >= spec.agingDays) {
    return {
      status: CheckStatuses.warn,
      code: code('aging'),
      summary: `No ${spec.label} data newer than ${newestDate} (${age} days).`,
      remediation,
      details,
    }
  }
  return {
    status: CheckStatuses.ok,
    code: code('fresh'),
    summary: `${spec.label} data is current through ${newestDate}.`,
    remediation: null,
    details,
  }
}

function skipped(code: string, summary: string): CheckOutput {
  return { status: CheckStatuses.skipped, code, summary, remediation: null }
}

const GA_SPEC: FreshnessSpec = {
  source: 'ga',
  label: 'GA4',
  agingDays: GA_DATA_AGING_DAYS,
  staleDays: GA_DATA_STALE_DAYS,
  syncCommand: name => `canonry ga sync ${name}`,
  whenSilent: 'If the site had visitors, check that the GA4 tag or its Tag Manager container is still on the live site.',
}

const GSC_SPEC: FreshnessSpec = {
  source: 'gsc',
  label: 'Search Console',
  agingDays: GSC_DATA_AGING_DAYS,
  staleDays: GSC_DATA_STALE_DAYS,
  syncCommand: name => `canonry google sync ${name}`,
  whenSilent: 'Search Console normally lags two to three days. Check that the property still lists this site and the connected account still has access.',
}

function gaConnected(ctx: DoctorContext): 'connected' | 'not-connected' | 'store-unavailable' {
  const project = ctx.project!
  if (!ctx.ga4CredentialStore && !ctx.googleConnectionStore) return 'store-unavailable'
  if (ctx.ga4CredentialStore?.getConnection(project.name)) return 'connected'
  if (ctx.googleConnectionStore?.getConnection(project.canonicalDomain, 'ga4')) return 'connected'
  return 'not-connected'
}

const gaRecentDataCheck: CheckDefinition = {
  id: 'ga.data.recent-data',
  category: CheckCategories.integrations,
  scope: CheckScopes.project,
  title: 'GA4 data still arriving',
  run: (ctx) => {
    if (!ctx.project) return skipped('ga.data.no-project', 'Project context required.')
    const connection = gaConnected(ctx)
    if (connection === 'store-unavailable') return skipped('ga.data.store-unavailable', 'No GA4 credential store configured for this deployment.')
    if (connection === 'not-connected') return skipped('ga.data.not-connected', 'GA4 is not connected for this project.')
    const newest = ctx.db
      .select({ date: gaDailyTotals.date })
      .from(gaDailyTotals)
      .where(eq(gaDailyTotals.projectId, ctx.project.id))
      .orderBy(desc(gaDailyTotals.date))
      .limit(1)
      .get()
    return grade(GA_SPEC, ctx.project.name, newest?.date)
  },
}

const gscRecentDataCheck: CheckDefinition = {
  id: 'gsc.data.recent-data',
  category: CheckCategories.integrations,
  scope: CheckScopes.project,
  title: 'Search Console data still arriving',
  run: (ctx) => {
    if (!ctx.project) return skipped('gsc.data.no-project', 'Project context required.')
    if (!ctx.googleConnectionStore) return skipped('gsc.data.store-unavailable', 'No Google connection store configured for this deployment.')
    if (!ctx.googleConnectionStore.getConnection(ctx.project.canonicalDomain, 'gsc')) {
      return skipped('gsc.data.not-connected', 'Search Console is not connected for this project.')
    }
    const newest = ctx.db
      .select({ date: gscDailyTotals.date })
      .from(gscDailyTotals)
      .where(eq(gscDailyTotals.projectId, ctx.project.id))
      .orderBy(desc(gscDailyTotals.date))
      .limit(1)
      .get()
    return grade(GSC_SPEC, ctx.project.name, newest?.date)
  },
}

export const DATA_FRESHNESS_CHECKS: readonly CheckDefinition[] = [gaRecentDataCheck, gscRecentDataCheck]
