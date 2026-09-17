import { and, desc, eq, inArray } from 'drizzle-orm'
import { CheckCategories, CheckScopes, CheckStatuses, formatIsoDateInTimeZone } from '@ainyc/canonry-contracts'
import { gaDailyTotals, gscDailyTotals, gscDataWatermarks, runs } from '@ainyc/canonry-db'
import type { CheckDefinition, CheckOutput, DoctorContext } from '../types.js'

/**
 * Is daily data still ARRIVING, not just "is the connection valid"?
 *
 * The auth checks prove a token works. They cannot see a sync that succeeds and
 * returns nothing: a GA4 tag removed from a site left ga-sync completing with
 * zero new rows for two weeks while every check stayed green.
 *
 * Three things keep this from crying wolf:
 *  - Both APIs omit days with no data, so a quiet week looks identical to a dead
 *    tag from MAX(date) alone. Search Console keeps a monotonic watermark that
 *    advances anyway, and that is read in preference to the newest row.
 *  - If nothing has synced recently, the finding is that nobody is syncing, not
 *    that the site lost its tag: a different code and a different remediation.
 *  - These stay `warn`. A broken credential is a `fail` in the auth category and
 *    must keep the headline; stale data is the downstream symptom, and it used
 *    to outrank its own cause and send a second alert pointing at the wrong fix.
 */
export const GA_DATA_AGING_DAYS = 3
export const GA_DATA_STALE_DAYS = 5
export const GSC_DATA_AGING_DAYS = 5
export const GSC_DATA_STALE_DAYS = 7
/** No successful sync in this window means the pipeline is idle, not that data stopped. */
export const SYNC_IDLE_DAYS = 3
/** Search Console reports on Pacific dates, so a UTC "today" reads a day high for most of the UTC morning. */
export const GSC_REPORTING_TIME_ZONE = 'America/Los_Angeles'

const DAY_MS = 24 * 60 * 60 * 1000
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

function utcFromIsoDate(date: string): number | null {
  const match = ISO_DATE.exec(date)
  if (!match) return null
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

/** Whole calendar days between two `YYYY-MM-DD` dates. Null when either is not a date. */
export function daysBetweenIsoDates(from: string, to: string): number | null {
  const start = utcFromIsoDate(from)
  const end = utcFromIsoDate(to)
  if (start === null || end === null) return null
  return Math.floor((end - start) / DAY_MS)
}

/** Whole days since a stored `YYYY-MM-DD`, counted in the source's own reporting time zone. */
export function daysSinceDate(date: string, now: Date = new Date(), timeZone?: string): number | null {
  const today = timeZone
    ? formatIsoDateInTimeZone(now.toISOString(), timeZone)
    : `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`
  return daysBetweenIsoDates(date, today)
}

interface FreshnessSpec {
  source: 'ga' | 'gsc'
  label: string
  agingDays: number
  staleDays: number
  timeZone?: string
  syncKinds: string[]
  syncCommand: (projectName: string) => string
  quietExplanation: string
  brokenExplanation: string
}

function skipped(code: string, summary: string): CheckOutput {
  return { status: CheckStatuses.skipped, code, summary, remediation: null }
}

/** Has anything actually synced lately? Without this, "no data" reads as breakage on a project nobody syncs. */
function lastSyncAgeDays(ctx: DoctorContext, kinds: string[]): number | null {
  const row = ctx.db
    .select({ createdAt: runs.createdAt })
    .from(runs)
    .where(and(eq(runs.projectId, ctx.project!.id), inArray(runs.kind, kinds), eq(runs.status, 'completed')))
    .orderBy(desc(runs.createdAt))
    .limit(1)
    .get()
  if (!row?.createdAt) return null
  const age = Math.floor((Date.now() - Date.parse(row.createdAt)) / DAY_MS)
  return Number.isFinite(age) ? age : null
}

function grade(ctx: DoctorContext, spec: FreshnessSpec, newestDate: string | undefined): CheckOutput {
  const projectName = ctx.project!.name
  const code = (suffix: string) => `${spec.source}.data.${suffix}`
  const sync = spec.syncCommand(projectName)
  const syncAge = lastSyncAgeDays(ctx, spec.syncKinds)
  const syncIdle = syncAge === null || syncAge >= SYNC_IDLE_DAYS

  if (!newestDate) {
    return {
      status: CheckStatuses.warn,
      code: code('never-synced'),
      summary: `${spec.label} is connected but no daily data has been stored yet.`,
      remediation: `Run \`${sync}\`, or set a data-refresh schedule so it keeps itself current.`,
      details: { lastSyncAgeDays: syncAge },
    }
  }
  const age = daysSinceDate(newestDate, new Date(), spec.timeZone)
  if (age === null) {
    return {
      status: CheckStatuses.warn,
      code: code('unreadable-date'),
      summary: `Newest stored ${spec.label} date "${newestDate}" is not a calendar date.`,
      remediation: null,
      details: { newestDate },
    }
  }
  const details = { newestDate, ageDays: age, agingDays: spec.agingDays, staleDays: spec.staleDays, lastSyncAgeDays: syncAge }
  if (age < spec.agingDays) {
    return {
      status: CheckStatuses.ok,
      code: code('fresh'),
      summary: `${spec.label} data is current through ${newestDate}.`,
      remediation: null,
      details,
    }
  }
  // Nothing has run, so the honest finding is an idle pipeline. Saying "check
  // your tag" here sends the operator after a fault that does not exist.
  if (syncIdle) {
    return {
      status: CheckStatuses.warn,
      code: code('not-syncing'),
      summary: `No ${spec.label} sync has completed in ${syncAge === null ? 'any recorded run' : `${syncAge} days`}, and stored data ends ${newestDate}.`,
      remediation: `Run \`${sync}\`, or set a data-refresh schedule: \`canonry schedule set ${projectName} --kind data-refresh --preset daily\`.`,
      details,
    }
  }
  // Syncs are running and still bringing nothing back.
  const remediation = `${spec.quietExplanation} ${spec.brokenExplanation}`
  return {
    status: CheckStatuses.warn,
    code: code(age >= spec.staleDays ? 'stale' : 'aging'),
    summary: `${spec.label} syncs are running but have stored nothing newer than ${newestDate} (${age} days).`,
    remediation,
    details,
  }
}

const GA_SPEC: FreshnessSpec = {
  source: 'ga',
  label: 'GA4',
  agingDays: GA_DATA_AGING_DAYS,
  staleDays: GA_DATA_STALE_DAYS,
  syncKinds: ['ga-sync'],
  syncCommand: name => `canonry ga sync ${name}`,
  quietExplanation: 'GA4 omits days with no sessions, so a genuinely quiet period clears itself on the next visit.',
  brokenExplanation: 'If the site did have visitors, check that the GA4 tag or its Tag Manager container is still on the live site.',
}

const GSC_SPEC: FreshnessSpec = {
  source: 'gsc',
  label: 'Search Console',
  agingDays: GSC_DATA_AGING_DAYS,
  staleDays: GSC_DATA_STALE_DAYS,
  timeZone: GSC_REPORTING_TIME_ZONE,
  syncKinds: ['gsc-sync'],
  syncCommand: name => `canonry google sync ${name}`,
  quietExplanation: 'Search Console omits days with no impressions and reports two to three days behind, so a quiet period clears itself.',
  brokenExplanation: 'If the site did have impressions, check that the property still lists this site and the connected account still has access.',
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
    return grade(ctx, GA_SPEC, newest?.date)
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
    // The watermark advances even when Search Analytics omits a zero-impression
    // day, so it is the honest freshness signal; the newest row is the fallback
    // for databases written before the watermark existed.
    const watermark = ctx.db
      .select({ dataThroughDate: gscDataWatermarks.dataThroughDate })
      .from(gscDataWatermarks)
      .where(eq(gscDataWatermarks.projectId, ctx.project.id))
      .get()
    if (watermark?.dataThroughDate) return grade(ctx, GSC_SPEC, watermark.dataThroughDate)
    const newest = ctx.db
      .select({ date: gscDailyTotals.date })
      .from(gscDailyTotals)
      .where(eq(gscDailyTotals.projectId, ctx.project.id))
      .orderBy(desc(gscDailyTotals.date))
      .limit(1)
      .get()
    return grade(ctx, GSC_SPEC, newest?.date)
  },
}

export const DATA_FRESHNESS_CHECKS: readonly CheckDefinition[] = [gaRecentDataCheck, gscRecentDataCheck]
