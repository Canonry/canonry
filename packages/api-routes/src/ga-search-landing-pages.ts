import crypto from 'node:crypto'
import { and, asc, count, desc, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  gaMeasurementSyncStates,
  gaSearchLandingPages,
  gaSearchLandingWindows,
} from '@ainyc/canonry-db'
import {
  GA_SEARCH_LANDING_DEFAULT_LIMIT,
  GA_SEARCH_LANDING_DEFAULT_WINDOW,
  GA_SEARCH_LANDING_MAX_LIMIT,
  RatioUnits,
  gaSearchLandingPagesResponseSchema,
  gaSearchLandingWindowSchema,
  inclusiveDayCount,
  roundRatio,
  validationError,
} from '@ainyc/canonry-contracts'
import type {
  GaSearchLandingMetrics,
  GaSearchLandingPagesResponse,
  GaSearchLandingSyncResult,
} from '@ainyc/canonry-contracts'
import type { GA4SearchLandingMetrics, GA4SearchLandingWindowReport } from '@ainyc/canonry-integration-google-analytics'
import type { Ga4CredentialStore } from './ga.js'
import type { GoogleConnectionStore } from './google.js'
import { resolveProject } from './helpers.js'

type Database = FastifyInstance['db']
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

/**
 * Store a complete Search Console landing-page snapshot: every window and its
 * rows replace the project's previous snapshot in one transaction, so a stored
 * snapshot never mixes two syncs, and the state turns `ready`.
 */
export function persistSearchLandingSnapshot(
  db: Database,
  input: {
    projectId: string
    /** GA4 property the windows were read from. */
    propertyId: string
    runId: string
    syncedAt: string
    windows: readonly GA4SearchLandingWindowReport[]
  },
): GaSearchLandingSyncResult {
  db.transaction((tx) => {
    deleteSearchLandingRows(tx, input.projectId)

    for (const window of input.windows) {
      tx.insert(gaSearchLandingWindows).values({
        id: crypto.randomUUID(),
        projectId: input.projectId,
        propertyId: input.propertyId,
        windowKey: window.window,
        periodStart: window.periodStart,
        periodEnd: window.periodEnd,
        timeZone: window.timeZone,
        totalClicks: window.total.clicks,
        totalImpressions: window.total.impressions,
        totalCtr: window.total.ctr,
        totalAveragePosition: window.total.averagePosition,
        totalActiveUsers: window.total.activeUsers,
        reportRowCount: window.reportRowCount,
        rowsCapped: window.rowsCapped,
        subjectToThresholding: window.subjectToThresholding,
        dataLossFromOtherRow: window.dataLossFromOtherRow,
        syncedAt: input.syncedAt,
        syncRunId: input.runId,
        createdAt: input.syncedAt,
      }).run()

      for (const row of window.rows) {
        tx.insert(gaSearchLandingPages).values({
          id: crypto.randomUUID(),
          projectId: input.projectId,
          windowKey: window.window,
          landingPage: row.landingPage,
          clicks: row.clicks,
          impressions: row.impressions,
          ctr: row.ctr,
          averagePosition: row.averagePosition,
          activeUsers: row.activeUsers,
          syncedAt: input.syncedAt,
          syncRunId: input.runId,
          createdAt: input.syncedAt,
        }).run()
      }
    }

    upsertSearchLandingState(tx, input.projectId, {
      searchLandingStatus: 'ready',
      searchLandingError: null,
      searchLandingSyncedAt: input.syncedAt,
      searchLandingAttemptedAt: input.syncedAt,
    }, input.syncedAt)
  })

  const windows = input.windows.map((window) => ({
    window: window.window,
    rowCount: window.rows.length,
    reportRowCount: window.reportRowCount,
    rowsCapped: window.rowsCapped,
  }))
  return {
    status: 'ready',
    windows,
    rowCount: windows.reduce((sum, window) => sum + window.rowCount, 0),
  }
}

/**
 * Record a failed attempt (`unavailable` or `error`) against `propertyId`.
 * A snapshot of the same property stays: it is the last good snapshot,
 * readable beside the status, and its own dates say what it covers. A
 * snapshot of another property (the project was pointed at a new GA4 property
 * since it was stored) is not, so it is dropped in the same transaction.
 */
export function persistSearchLandingFailure(
  db: Database,
  projectId: string,
  propertyId: string,
  status: 'unavailable' | 'error',
  message: string,
  attemptedAt: string,
): void {
  db.transaction((tx) => {
    const storedProperties = tx.selectDistinct({ propertyId: gaSearchLandingWindows.propertyId })
      .from(gaSearchLandingWindows)
      .where(eq(gaSearchLandingWindows.projectId, projectId))
      .all()
    const otherProperty = storedProperties.some((stored) => stored.propertyId !== propertyId)
    if (otherProperty) deleteSearchLandingRows(tx, projectId)
    upsertSearchLandingState(tx, projectId, {
      searchLandingStatus: status,
      searchLandingError: message,
      searchLandingAttemptedAt: attemptedAt,
      ...(otherProperty ? { searchLandingSyncedAt: null } : {}),
    }, attemptedAt)
  })
}

function deleteSearchLandingRows(db: Database | Transaction, projectId: string): void {
  db.delete(gaSearchLandingPages).where(eq(gaSearchLandingPages.projectId, projectId)).run()
  db.delete(gaSearchLandingWindows).where(eq(gaSearchLandingWindows.projectId, projectId)).run()
}

function resetSearchLanding(db: Database | Transaction, projectId: string, updatedAt: string): void {
  deleteSearchLandingRows(db, projectId)
  db.update(gaMeasurementSyncStates)
    .set({
      searchLandingStatus: 'never-synced',
      searchLandingError: null,
      searchLandingSyncedAt: null,
      searchLandingAttemptedAt: null,
      updatedAt,
    })
    .where(eq(gaMeasurementSyncStates.projectId, projectId))
    .run()
}

/** Drop the project's snapshot and reset its state (GA disconnect). */
export function clearSearchLandingSnapshot(db: Database, projectId: string, updatedAt: string): void {
  db.transaction((tx) => resetSearchLanding(tx, projectId, updatedAt))
}

/**
 * GA connect: drop the project's snapshot and reset its state, as disconnect
 * does, when the connect moved the project from one GA4 property to another,
 * or when the stored snapshot names a property other than the one the project
 * resolves to now. Reconnecting to the same property (a rotated key) keeps it.
 * Returns whether the snapshot was cleared.
 */
export function clearSearchLandingSnapshotOnPropertyChange(
  db: Database,
  projectId: string,
  properties: { previousPropertyId: string | null; propertyId: string | null },
  updatedAt: string,
): boolean {
  return db.transaction((tx) => {
    const storedProperties = tx.selectDistinct({ propertyId: gaSearchLandingWindows.propertyId })
      .from(gaSearchLandingWindows)
      .where(eq(gaSearchLandingWindows.projectId, projectId))
      .all()
    const moved = properties.previousPropertyId !== null && properties.previousPropertyId !== properties.propertyId
    const otherProperty = storedProperties.some((stored) => stored.propertyId !== properties.propertyId)
    if (!moved && !otherProperty) return false
    resetSearchLanding(tx, projectId, updatedAt)
    return true
  })
}

/** The connection stores the read resolves a project's current GA4 property from. */
export interface GaSearchLandingRoutesOptions {
  ga4CredentialStore?: Ga4CredentialStore
  googleConnectionStore?: GoogleConnectionStore
}

/**
 * The GA4 property a project resolves to now, in the order the GA sync
 * resolves credentials: the project's service-account connection first, then
 * the domain's OAuth (`ga4`) connection. The same property `GET /ga/status`
 * reports. Reads stored connection records only: no token refresh and no
 * Google call. Null when neither names a property.
 */
export function resolveCurrentGa4PropertyId(
  stores: GaSearchLandingRoutesOptions,
  projectName: string,
  canonicalDomain: string,
): string | null {
  const serviceAccount = stores.ga4CredentialStore?.getConnection(projectName)
  if (serviceAccount?.propertyId) return serviceAccount.propertyId
  return stores.googleConnectionStore?.getConnection(canonicalDomain, 'ga4')?.propertyId ?? null
}

type SearchLandingStateFields = Pick<
  typeof gaMeasurementSyncStates.$inferInsert,
  'searchLandingStatus' | 'searchLandingError' | 'searchLandingSyncedAt' | 'searchLandingAttemptedAt'
>

function upsertSearchLandingState(
  db: Database | Transaction,
  projectId: string,
  fields: SearchLandingStateFields,
  updatedAt: string,
): void {
  db.insert(gaMeasurementSyncStates)
    .values({ projectId, ...fields, updatedAt })
    .onConflictDoUpdate({
      target: gaMeasurementSyncStates.projectId,
      set: { ...fields, updatedAt },
    })
    .run()
}

export interface GaSearchLandingPagesQuery {
  window?: string
  limit?: string | number
  offset?: string | number
}

function parseInteger(value: string | number | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback
  return typeof value === 'number' ? value : Number(value)
}

/** Stored GA4 metrics as they go on the wire: CTR at fraction wire precision. */
function toWireMetrics(metrics: GA4SearchLandingMetrics): GaSearchLandingMetrics {
  return {
    organicGoogleSearchClicks: metrics.clicks,
    organicGoogleSearchImpressions: metrics.impressions,
    organicGoogleSearchClickThroughRate: metrics.ctr === null ? null : roundRatio(metrics.ctr, RatioUnits.fraction),
    organicGoogleSearchAveragePosition: metrics.averagePosition,
    activeUsers: metrics.activeUsers,
  }
}

/**
 * One stored window of GA4's Search Console landing-page report. Reads stored
 * rows only (no Google call): a project that never synced reads
 * `never-synced` with no Total and no rows. `total` is the stored GA4 TOTAL,
 * never a sum of the rows. No `startDate` / `endDate`: every figure is
 * GA4-computed for one of the three stored windows, and a custom range could
 * not be answered exactly (users are distinct per grain; CTR and position are
 * ratios).
 *
 * The stored window must come from the GA4 property the project resolves to
 * now (`resolveCurrentGa4PropertyId`). One read from another property (the
 * project was pointed at a new one and has not synced since) is not this
 * project's report, so it reads exactly like `never-synced`: no status, no
 * Total, no rows. The read writes nothing; the next sync replaces that
 * snapshot, or drops it when the attempt fails.
 */
export function buildGaSearchLandingPages(
  db: Database,
  projectName: string,
  query: GaSearchLandingPagesQuery,
  connections: GaSearchLandingRoutesOptions,
): GaSearchLandingPagesResponse {
  const parsedWindow = gaSearchLandingWindowSchema.safeParse(query.window ?? GA_SEARCH_LANDING_DEFAULT_WINDOW)
  if (!parsedWindow.success) {
    throw validationError('"window" must be one of: 7d, 28d, 90d')
  }
  const limit = parseInteger(query.limit, GA_SEARCH_LANDING_DEFAULT_LIMIT)
  if (!Number.isInteger(limit) || limit < 1 || limit > GA_SEARCH_LANDING_MAX_LIMIT) {
    throw validationError(`"limit" must be an integer between 1 and ${GA_SEARCH_LANDING_MAX_LIMIT}`)
  }
  const offset = parseInteger(query.offset, 0)
  if (!Number.isInteger(offset) || offset < 0) {
    throw validationError('"offset" must be a non-negative integer')
  }

  const project = resolveProject(db, projectName)
  const window = parsedWindow.data
  const storedWindow = db.select().from(gaSearchLandingWindows)
    .where(and(eq(gaSearchLandingWindows.projectId, project.id), eq(gaSearchLandingWindows.windowKey, window)))
    .get()
  const otherProperty = storedWindow !== undefined
    && storedWindow.propertyId !== resolveCurrentGa4PropertyId(connections, project.name, project.canonicalDomain)
  // Another property's snapshot reads as never synced, its state included:
  // every attempt since it was stored was made against that property too (a
  // failed attempt against the current one drops it).
  const stored = otherProperty ? undefined : storedWindow
  const state = otherProperty
    ? undefined
    : db.select().from(gaMeasurementSyncStates)
      .where(eq(gaMeasurementSyncStates.projectId, project.id))
      .get()
  const pageScope = and(eq(gaSearchLandingPages.projectId, project.id), eq(gaSearchLandingPages.windowKey, window))
  const totalRows = otherProperty
    ? 0
    : db.select({ value: count() }).from(gaSearchLandingPages).where(pageScope).get()?.value ?? 0
  const rows = otherProperty
    ? []
    : db.select().from(gaSearchLandingPages)
      .where(pageScope)
      .orderBy(desc(gaSearchLandingPages.clicks), desc(gaSearchLandingPages.impressions), asc(gaSearchLandingPages.landingPage))
      .limit(limit)
      .offset(offset)
      .all()

  return gaSearchLandingPagesResponseSchema.parse({
    source: 'ga4-search-console-link',
    status: state?.searchLandingStatus ?? 'never-synced',
    error: state?.searchLandingError ?? null,
    syncedAt: stored?.syncedAt ?? null,
    attemptedAt: state?.searchLandingAttemptedAt ?? null,
    window,
    windowStart: stored?.periodStart ?? null,
    windowEnd: stored?.periodEnd ?? null,
    windowDays: stored ? inclusiveDayCount(stored.periodStart, stored.periodEnd) : null,
    timeZone: stored?.timeZone ?? null,
    subjectToThresholding: stored?.subjectToThresholding ?? false,
    dataLossFromOtherRow: stored?.dataLossFromOtherRow ?? false,
    total: stored
      ? toWireMetrics({
          clicks: stored.totalClicks,
          impressions: stored.totalImpressions,
          ctr: stored.totalCtr,
          averagePosition: stored.totalAveragePosition,
          activeUsers: stored.totalActiveUsers,
        })
      : null,
    reportRowCount: stored?.reportRowCount ?? null,
    rowsCapped: stored?.rowsCapped ?? false,
    totalRows,
    limit,
    offset,
    rows: rows.map((row) => ({
      landingPage: row.landingPage,
      ...toWireMetrics(row),
    })),
  })
}

export async function gaSearchLandingPagesRoutes(app: FastifyInstance, opts: GaSearchLandingRoutesOptions) {
  app.get<{
    Params: { name: string }
    Querystring: { window?: string; limit?: string; offset?: string }
  }>('/projects/:name/ga/search-landing-pages', (request) => (
    buildGaSearchLandingPages(app.db, request.params.name, request.query, opts)
  ))
}
