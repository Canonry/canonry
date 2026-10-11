import { and, desc, eq, isNull } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  instanceStatusDtoSchema,
  forbidden,
  RunKinds,
  truncateUtf16,
  type RunKind,
  type InstanceStatusDto,
  type IntegrationStatusRow,
} from '@ainyc/canonry-contracts'
import {
  adsConnections,
  doctorHealthState,
  gaDailyTotals,
  gscDailyTotals,
  gscDataWatermarks,
  projects,
  trafficSources,
} from '@ainyc/canonry-db'
import type { DatabaseClient } from '@ainyc/canonry-db'
import type { GoogleConnectionStore } from './google.js'
import type { BingConnectionStore } from './bing.js'
import type { Ga4CredentialStore } from './ga.js'
import { resolveProject } from './helpers.js'
import {
  gaConnection,
  gbpConnection,
  gscConnection,
  readSyncRunState,
  type Connection,
} from './doctor/checks/integration-sync.js'
import { GBP_NOTHING_TO_SYNC_ERRORS } from './doctor/checks/integration-sync.js'
import { GA_DATA_AGING_DAYS, GSC_DATA_AGING_DAYS, GSC_REPORTING_TIME_ZONE, SYNC_IDLE_DAYS, daysSinceDate } from './doctor/checks/data-freshness.js'
import { ADS_RECENT_SYNC_WARN_DAYS } from './doctor/checks/ads.js'
import { FRESH_SNAPSHOT_WARN_DAYS } from './doctor/checks/google-marketing.js'
import { SYNC_LAG_WARN_MS } from './doctor/checks/traffic-source.js'
import { RECENT_SYNC_WARN_DAYS as GBP_SYNC_STALE_DAYS } from './doctor/checks/gbp-auth.js'
import type { ProjectInfo } from './doctor/types.js'
import type { DoctorRoutesOptions } from './doctor.js'

export interface StatusRoutesOptions {
  db: DatabaseClient
  googleConnectionStore?: GoogleConnectionStore
  bingConnectionStore?: BingConnectionStore
  ga4CredentialStore?: Ga4CredentialStore
  getGoogleMarketingDoctorInput?: DoctorRoutesOptions['getGoogleMarketingDoctorInput']
}

function ageDays(iso: string | null): number | null {
  if (!iso) return null
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  return Math.max(0, Math.floor(ms / 86_400_000))
}

function connected(connection: Connection): connection is Extract<Connection, { state: 'connected' }> {
  return connection.state === 'connected'
}

function projectInfo(row: typeof projects.$inferSelect): ProjectInfo {
  return {
    id: row.id,
    name: row.name,
    displayName: row.displayName,
    canonicalDomain: row.canonicalDomain,
  }
}

function rowState(
  state: ReturnType<typeof readSyncRunState>,
  staleAfterDays: number | null,
  dataAge: number | null,
  dataStaleAfterDays: number | null = staleAfterDays,
): IntegrationStatusRow['state'] {
  if (state.repeatedFailure) return 'failing'
  if (state.latestStatus === null) return 'never-synced'
  const successAge = state.lastSuccessAt ? ageDays(state.lastSuccessAt) : null
  if ((staleAfterDays !== null && successAge !== null && successAge >= staleAfterDays) || (dataStaleAfterDays !== null && dataAge !== null && dataAge >= dataStaleAfterDays)) return 'stale'
  return 'ok'
}

function makeRow(
  integration: IntegrationStatusRow['integration'],
  label: string,
  runKind: RunKind,
  state: ReturnType<typeof readSyncRunState>,
  staleAfterDays: number | null,
  dataThrough: string | null = null,
  sourceId: string | null = null,
  doctorChecks: string[] = [],
  dataStaleAfterDays: number | null = staleAfterDays,
): IntegrationStatusRow {
  const age = dataThrough ? daysSinceDate(dataThrough, new Date(), integration === 'gsc' ? GSC_REPORTING_TIME_ZONE : undefined) : null
  const throughAge = age === null ? null : Math.max(0, age)
  return {
    integration,
    label,
    runKind,
    sourceId,
    state: rowState(state, staleAfterDays, throughAge, dataStaleAfterDays),
    lastSuccessAt: state.lastSuccessAt,
    latestRunAt: state.latestRunAt,
    latestRunId: state.latestRunId,
    latestStatus: state.latestStatus,
    latestTrigger: state.latestTrigger as IntegrationStatusRow['latestTrigger'],
    consecutiveFailures: state.consecutiveFailures,
    latestError: state.latestError ? truncateUtf16(state.latestError, 300) : null,
    dataThrough,
    dataAgeDays: throughAge,
    doctorChecks,
  }
}

function latestDate(db: DatabaseClient, table: typeof gaDailyTotals | typeof gscDailyTotals, projectId: string): string | null {
  const row = db.select({ date: table.date }).from(table).where(eq(table.projectId, projectId)).orderBy(desc(table.date)).limit(1).get()
  return row?.date ?? null
}

function projectRows(opts: StatusRoutesOptions, project: typeof projects.$inferSelect): IntegrationStatusRow[] {
  const info = projectInfo(project)
  const ctx = {
    db: opts.db,
    project: info,
    googleConnectionStore: opts.googleConnectionStore,
    ga4CredentialStore: opts.ga4CredentialStore,
    getGoogleMarketingDoctorInput: opts.getGoogleMarketingDoctorInput,
  }
  const rows: IntegrationStatusRow[] = []
  const gsc = gscConnection(ctx, info)
  if (connected(gsc)) {
    const watermarkRow = opts.db.select({ dataThroughDate: gscDataWatermarks.dataThroughDate }).from(gscDataWatermarks).where(eq(gscDataWatermarks.projectId, project.id)).limit(1).get()
    const state = readSyncRunState(opts.db, project.id, RunKinds['gsc-sync'], { since: gsc.since })
    const dataThrough = watermarkRow?.dataThroughDate ?? latestDate(opts.db, gscDailyTotals, project.id)
    rows.push(makeRow('gsc', 'Search Console', RunKinds['gsc-sync'], state, SYNC_IDLE_DAYS, dataThrough, null, ['gsc.sync.recent-failures'], GSC_DATA_AGING_DAYS))
  }
  const ga = gaConnection(ctx, info)
  if (connected(ga)) {
    const state = readSyncRunState(opts.db, project.id, RunKinds['ga-sync'], { since: ga.since })
    rows.push(makeRow('ga', 'GA4', RunKinds['ga-sync'], state, SYNC_IDLE_DAYS, latestDate(opts.db, gaDailyTotals, project.id), null, ['ga.sync.recent-failures'], GA_DATA_AGING_DAYS))
  }
  const gbp = gbpConnection(ctx, info)
  if (connected(gbp)) rows.push(makeRow('gbp', 'Google Business Profile', RunKinds['gbp-sync'], readSyncRunState(opts.db, project.id, RunKinds['gbp-sync'], { nothingToSyncErrors: GBP_NOTHING_TO_SYNC_ERRORS }), GBP_SYNC_STALE_DAYS, null, null, ['gbp.sync.recent-failures']))
  if (opts.bingConnectionStore?.getConnection(project.canonicalDomain)) rows.push(makeRow('bing', 'Bing Webmaster Tools', RunKinds['bing-inspect-sitemap'], readSyncRunState(opts.db, project.id, RunKinds['bing-inspect-sitemap']), null))
  const ads = opts.db.select({ id: adsConnections.id }).from(adsConnections).where(eq(adsConnections.projectId, project.id)).limit(1).get()
  if (ads) rows.push(makeRow('ads', 'OpenAI Ads', RunKinds['ads-sync'], readSyncRunState(opts.db, project.id, RunKinds['ads-sync']), ADS_RECENT_SYNC_WARN_DAYS, null, null, ['ads.data.recent-sync']))
  const marketing = opts.getGoogleMarketingDoctorInput?.(ctx)
  if (marketing?.googleAds) rows.push(makeRow('google-ads', 'Google Ads', RunKinds['google-ads-sync'], readSyncRunState(opts.db, project.id, RunKinds['google-ads-sync']), FRESH_SNAPSHOT_WARN_DAYS, null, null, ['google-ads.sync.recent-failures']))
  if (marketing?.gtm) rows.push(makeRow('gtm', 'Google Tag Manager', RunKinds['gtm-sync'], readSyncRunState(opts.db, project.id, RunKinds['gtm-sync']), FRESH_SNAPSHOT_WARN_DAYS, null, null, ['gtm.sync.recent-failures']))
  const sources = opts.db.select().from(trafficSources).where(and(eq(trafficSources.projectId, project.id), isNull(trafficSources.archivedAt))).all()
  for (const source of sources) {
    const row = makeRow('traffic', source.displayName, RunKinds['traffic-sync'], readSyncRunState(opts.db, project.id, RunKinds['traffic-sync'], { sourceId: source.id }), null, null, source.id, ['traffic.source.sync-lag', 'traffic.source.recent-data'])
    const lag = source.lastSyncedAt ? Date.now() - Date.parse(source.lastSyncedAt) : Number.POSITIVE_INFINITY
    row.state = row.state === 'failing' || row.state === 'never-synced' ? row.state : lag >= SYNC_LAG_WARN_MS ? 'stale' : 'ok'
    row.dataAgeDays = null
    rows.push(row)
  }
  return rows
}

function projectStatus(opts: StatusRoutesOptions, project: typeof projects.$inferSelect): ReturnType<typeof import('@ainyc/canonry-contracts').projectStatusSchema.parse> {
  const integrations = projectRows(opts, project)
  const healthRow = opts.db.select().from(doctorHealthState).where(eq(doctorHealthState.projectId, project.id)).limit(1).get()
  const health = healthRow ? { status: healthRow.status as 'ok' | 'warn' | 'fail', code: healthRow.code, summary: healthRow.summary, checkedAt: healthRow.checkedAt, notifiedAt: healthRow.notifiedAt } : null
  const rank = { ok: 0, 'never-synced': 1, stale: 2, failing: 3 } as const
  const state = integrations.reduce<IntegrationStatusRow['state']>((worst, row) => rank[row.state] > rank[worst] ? row.state : worst, 'ok')
  return { project: project.name, displayName: project.displayName, state, health, integrations }
}

export async function statusRoutes(app: FastifyInstance, opts: StatusRoutesOptions) {
  app.get<{ Querystring: { project?: string; problems?: string } }>('/status', async (request: FastifyRequest<{ Querystring: { project?: string; problems?: string } }>) => {
    const requested = request.query.project
    const scopedId = request.principal?.projectId ?? request.apiKey?.projectId ?? null
    if (requested) {
      const project = resolveProject(opts.db, requested)
      if (scopedId && project.id !== scopedId) throw forbidden('This project is outside the API key scope.')
      const result = { generatedAt: new Date().toISOString(), summary: { projects: 1, ok: 0, failing: 0, stale: 0, neverSynced: 0 }, projects: [projectStatus(opts, project)] }
      const status = result.projects[0]!.state
      result.summary[status === 'never-synced' ? 'neverSynced' : status]++
      if (request.query.problems === 'true') result.projects = result.projects.map(item => ({ ...item, integrations: item.integrations.filter(row => row.state !== 'ok') })).filter(item => item.state !== 'ok')
      return instanceStatusDtoSchema.parse(result)
    }
    const projectsRows = (scopedId ? opts.db.select().from(projects).where(eq(projects.id, scopedId)) : opts.db.select().from(projects)).all()
    const output: InstanceStatusDto = { generatedAt: new Date().toISOString(), summary: { projects: projectsRows.length, ok: 0, failing: 0, stale: 0, neverSynced: 0 }, projects: projectsRows.map(project => projectStatus(opts, project)) }
    for (const project of output.projects) output.summary[project.state === 'never-synced' ? 'neverSynced' : project.state]++
    if (request.query.problems === 'true') output.projects = output.projects.map(project => ({ ...project, integrations: project.integrations.filter(row => row.state !== 'ok') })).filter(project => project.state !== 'ok')
    return instanceStatusDtoSchema.parse(output)
  })
}
