import crypto from 'node:crypto'
import { eq, desc, and, sql } from 'drizzle-orm'
import type { SQL, SQLWrapper } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { gaTrafficSnapshots, gaTrafficSummaries, gaTrafficWindowSummaries, gaDailyTotals, gaAiReferrals, gaSocialReferrals, gaAcquisitionDaily, gaLeadEventsDaily, gaMeasurementSyncStates, runs } from '@ainyc/canonry-db'
import { classifyAiReferralTrafficClass, deltaPercent, formatPercent, percentOf, validationError, notFound, forbidden, quotaExceeded, providerError, AppError, RunKinds, RunStatuses, RunTriggers, resolveDateRange, normalizeUrlPath, describeError, inclusiveDayCount } from '@ainyc/canonry-contracts'
import type { GA4ChannelBreakdownDto, GaAttributionTrendResponse, GaSocialReferralTrendResponse, ResolvedDateRange } from '@ainyc/canonry-contracts'
import { resolveProject, writeAuditLog } from './helpers.js'
import { assertNotProjectScoped } from './auth.js'
import { buildSessionHistory } from './ga-session-history.js'
import { findBiggestMover } from './ga-source-mover.js'
import { buildAiReferralDailySeries, normalizeAiTrafficClass, pickWinningAttributionDimension, summarizeAiReferralCounts } from './ga-ai-referral-aggregation.js'
import {
  getAccessToken,
  fetchTrafficByLandingPage,
  fetchAggregateSummary,
  fetchWindowSummary,
  fetchDailyTotals,
  fetchAiReferrals,
  fetchSocialReferrals,
  fetchAcquisitionByChannel,
  fetchLeadEvents,
  verifyConnection,
  verifyConnectionWithToken,
  resolveGa4SyncDays,
  GA4_MAX_SYNC_DAYS,
  listProperties,
  GA4ApiError,
} from '@ainyc/canonry-integration-google-analytics'
import type { GoogleConnectionStore } from './google.js'
import { refreshAccessToken } from '@ainyc/canonry-integration-google'

function gaLog(level: 'info' | 'warn' | 'error', action: string, ctx?: Record<string, unknown>): void {
  const entry = { ts: new Date().toISOString(), level, module: 'GA4Routes', action, ...ctx }
  const stream = level === 'error' ? process.stderr : process.stdout
  stream.write(JSON.stringify(entry) + '\n')
}

// Format a session-share as a display string through the shared percent rule:
// one decimal from the unrounded ratio, so 18 AI sessions out of 6000 reads
// "0.3%" and a share too small for one decimal reads "<0.1%", never "0%". The
// integer `*SharePct` field beside it stays the rounded wire value.
//
// When the numerator is positive but the total is zero, the share is
// undefined — typically a partial-sync state where social/AI referral rows
// exist but the traffic snapshots/summary that drive the denominator have not
// been synced. We return "—" rather than "0%" so the UI doesn't claim a 0%
// share for 1.3K social sessions.
function formatSharePct(numerator: number, total: number): string {
  if (numerator > 0 && total <= 0) return '—'
  if (total <= 0 || numerator <= 0) return '0%'
  return formatPercent(numerator / total)
}

// Inclusive `date >= start` / `date <= end` predicates for a resolved range.
// Every GA read stores its date as a `YYYY-MM-DD` TEXT column, so the same two
// comparisons work verbatim on each of them.
function dateRangeConditions(column: SQLWrapper, range: ResolvedDateRange): SQL[] {
  const conditions: SQL[] = []
  if (range.startDate) conditions.push(sql`${column} >= ${range.startDate}`)
  if (range.endDate) conditions.push(sql`${column} <= ${range.endDate}`)
  return conditions
}

const SOCIAL_CHANNEL_GROUPS = new Set(['Organic Social', 'Paid Social'])

function buildChannelBreakdown(input: {
  totalSessions: number
  organicSessions: number
  socialSessions: number
  directSessions: number
  aiSessionsByChannelGroup: Map<string, number>
}): GA4ChannelBreakdownDto {
  const aiSessions = [...input.aiSessionsByChannelGroup.values()].reduce((sum, sessions) => sum + sessions, 0)
  const aiOrganicOverlap = Math.min(input.organicSessions, input.aiSessionsByChannelGroup.get('Organic Search') ?? 0)
  const aiSocialOverlap = Math.min(
    input.socialSessions,
    [...input.aiSessionsByChannelGroup.entries()]
      .filter(([channelGroup]) => SOCIAL_CHANNEL_GROUPS.has(channelGroup))
      .reduce((sum, [, sessions]) => sum + sessions, 0),
  )
  const aiDirectOverlap = Math.min(input.directSessions, input.aiSessionsByChannelGroup.get('Direct') ?? 0)

  const organicSessions = Math.max(0, input.organicSessions - aiOrganicOverlap)
  const socialSessions = Math.max(0, input.socialSessions - aiSocialOverlap)
  const directSessions = Math.max(0, input.directSessions - aiDirectOverlap)
  const coveredSessions = organicSessions + socialSessions + directSessions + aiSessions
  const otherSessions = Math.max(0, input.totalSessions - coveredSessions)

  const bucket = (sessions: number) => ({
    sessions,
    sharePct: percentOf(sessions, input.totalSessions) ?? 0,
    sharePctDisplay: formatSharePct(sessions, input.totalSessions),
  })

  return {
    organic: bucket(organicSessions),
    social: bucket(socialSessions),
    direct: bucket(directSessions),
    ai: bucket(aiSessions),
    other: {
      sessions: otherSessions,
      sharePct: percentOf(otherSessions, input.totalSessions) ?? 0,
      sharePctDisplay: input.totalSessions <= 0 && coveredSessions > 0 ? '—' : formatSharePct(otherSessions, input.totalSessions),
    },
  }
}

// For each tuple key, keep the row with the highest sessions and discard the
// others. GA4 returns one row per attribution dimension (session, first_user,
// manual_utm), but those dimensions are overlapping lenses on the same visit
// — summing them across dimensions would double-count. Result is sorted by
// sessions descending.
//
// Callers MUST hand this rows whose landing pages are already summed inside
// each dimension (i.e. landing page absent from the GROUP BY, or present
// because the row IS a per-page breakdown). Feeding it per-landing-page rows
// and treating the result as a total collapses the tuple to one page. See the
// conservation invariant at the top of `ga-ai-referral-aggregation.ts`.
/**
 * Keep every row belonging to the winning attribution lens for each group.
 *
 * The lens is chosen per group by TOTAL sessions across all of that lens's
 * rows, then all of its rows survive. That matters because one lens legitimately
 * emits several rows for a source: organic and paid ChatGPT traffic are separate
 * rows under the same session lens and must both be kept.
 *
 * The group key is the source (plus landing page where the breakdown needs it)
 * and deliberately excludes medium and traffic class. Both are labels the lens
 * assigns rather than properties of the visit, so keying on either splits one
 * visit across groups and lets it survive twice. GA4 reports the manual-UTM lens
 * with medium '(not set)' where the session lens reports 'ai-assistant', which
 * is how one ChatGPT visit came to be counted as two.
 */
function keepWinningDimensionRows<T extends { sessions: number | null, sourceDimension: string }>(
  rows: T[],
  groupKey: (row: T) => string,
): T[] {
  const sessionsByGroupAndDimension = new Map<string, Map<string, number>>()
  for (const row of rows) {
    const key = groupKey(row)
    let byDimension = sessionsByGroupAndDimension.get(key)
    if (!byDimension) {
      byDimension = new Map<string, number>()
      sessionsByGroupAndDimension.set(key, byDimension)
    }
    byDimension.set(
      row.sourceDimension,
      (byDimension.get(row.sourceDimension) ?? 0) + (row.sessions ?? 0),
    )
  }
  const winningDimension = new Map<string, string>()
  for (const [key, byDimension] of sessionsByGroupAndDimension) {
    const winner = pickWinningAttributionDimension(byDimension)
    if (winner) winningDimension.set(key, winner)
  }
  return rows
    .filter((row) => winningDimension.get(groupKey(row)) === row.sourceDimension)
    .sort((a, b) => (b.sessions ?? 0) - (a.sessions ?? 0))
}

type GaDatabase = FastifyInstance['db']

function persistAcquisitionMeasurement(
  db: GaDatabase,
  input: {
    projectId: string
    runId: string
    syncedAt: string
    report: Awaited<ReturnType<typeof fetchAcquisitionByChannel>>
  },
): void {
  const { startDate, endDate } = input.report
  db.transaction((tx) => {
    tx.delete(gaAcquisitionDaily)
      .where(and(
        eq(gaAcquisitionDaily.projectId, input.projectId),
        sql`${gaAcquisitionDaily.date} >= ${startDate}`,
        sql`${gaAcquisitionDaily.date} <= ${endDate}`,
      ))
      .run()

    for (const row of input.report.rows) {
      tx.insert(gaAcquisitionDaily).values({
        id: crypto.randomUUID(),
        projectId: input.projectId,
        date: row.date,
        channelGroup: row.channelGroup,
        source: row.source,
        medium: row.medium,
        hostName: row.hostName,
        landingPage: row.landingPage,
        landingPageNormalized: normalizeUrlPath(row.landingPage),
        sessions: row.sessions,
        syncedAt: input.syncedAt,
        syncRunId: input.runId,
        createdAt: input.syncedAt,
      }).run()
    }

    tx.insert(gaMeasurementSyncStates).values({
      projectId: input.projectId,
      acquisitionStatus: 'ready',
      acquisitionError: null,
      acquisitionSyncedAt: input.syncedAt,
      updatedAt: input.syncedAt,
    }).onConflictDoUpdate({
      target: gaMeasurementSyncStates.projectId,
      set: {
        acquisitionStatus: 'ready',
        acquisitionError: null,
        acquisitionSyncedAt: input.syncedAt,
        updatedAt: input.syncedAt,
      },
    }).run()
  })
}

function persistLeadMeasurement(
  db: GaDatabase,
  input: {
    projectId: string
    runId: string
    syncedAt: string
    report: Awaited<ReturnType<typeof fetchLeadEvents>>
  },
): void {
  const { startDate, endDate } = input.report
  db.transaction((tx) => {
    tx.delete(gaLeadEventsDaily)
      .where(and(
        eq(gaLeadEventsDaily.projectId, input.projectId),
        sql`${gaLeadEventsDaily.date} >= ${startDate}`,
        sql`${gaLeadEventsDaily.date} <= ${endDate}`,
      ))
      .run()

    for (const row of input.report.rows) {
      tx.insert(gaLeadEventsDaily).values({
        id: crypto.randomUUID(),
        projectId: input.projectId,
        date: row.date,
        eventName: row.eventName,
        channelGroup: row.channelGroup,
        source: row.source,
        medium: row.medium,
        hostName: row.hostName,
        landingPage: row.landingPage,
        landingPageNormalized: input.report.attributionScope === 'landing-page'
          ? normalizeUrlPath(row.landingPage)
          : null,
        attributionScope: input.report.attributionScope,
        eventCount: row.eventCount,
        syncedAt: input.syncedAt,
        syncRunId: input.runId,
        createdAt: input.syncedAt,
      }).run()
    }

    tx.insert(gaMeasurementSyncStates).values({
      projectId: input.projectId,
      leadStatus: 'ready',
      leadError: null,
      leadSyncedAt: input.syncedAt,
      leadAttributionScope: input.report.attributionScope,
      updatedAt: input.syncedAt,
    }).onConflictDoUpdate({
      target: gaMeasurementSyncStates.projectId,
      set: {
        leadStatus: 'ready',
        leadError: null,
        leadSyncedAt: input.syncedAt,
        leadAttributionScope: input.report.attributionScope,
        updatedAt: input.syncedAt,
      },
    }).run()
  })
}

function resetLeadMeasurement(db: GaDatabase, projectId: string, updatedAt: string): void {
  db.transaction((tx) => {
    tx.delete(gaLeadEventsDaily).where(eq(gaLeadEventsDaily.projectId, projectId)).run()
    tx.insert(gaMeasurementSyncStates).values({ projectId, leadStatus: 'never-synced', leadError: null, leadSyncedAt: null, leadAttributionScope: null, updatedAt }).onConflictDoUpdate({
      target: gaMeasurementSyncStates.projectId,
      set: { leadStatus: 'never-synced', leadError: null, leadSyncedAt: null, leadAttributionScope: null, updatedAt },
    }).run()
  })
}

function persistMeasurementError(
  db: GaDatabase,
  projectId: string,
  component: 'acquisition' | 'leads',
  message: string,
  updatedAt: string,
): void {
  if (component === 'acquisition') {
    db.insert(gaMeasurementSyncStates).values({
      projectId,
      acquisitionStatus: 'error',
      acquisitionError: message,
      updatedAt,
    }).onConflictDoUpdate({
      target: gaMeasurementSyncStates.projectId,
      set: {
        acquisitionStatus: 'error',
        acquisitionError: message,
        updatedAt,
      },
    }).run()
    return
  }

  db.insert(gaMeasurementSyncStates).values({
    projectId,
    leadStatus: 'error',
    leadError: message,
    updatedAt,
  }).onConflictDoUpdate({
    target: gaMeasurementSyncStates.projectId,
    set: {
      leadStatus: 'error',
      leadError: message,
      updatedAt,
    },
  }).run()
}

export interface Ga4CredentialRecord {
  projectName: string
  propertyId: string
  clientEmail: string
  privateKey: string
  createdAt: string
  updatedAt: string
}

export interface Ga4CredentialStore {
  getConnection: (projectName: string) => Ga4CredentialRecord | undefined
  upsertConnection: (connection: Ga4CredentialRecord) => Ga4CredentialRecord
  deleteConnection: (projectName: string) => boolean
}

export interface GoogleAuthConfig {
  clientId?: string
  clientSecret?: string
}

export interface GA4RoutesOptions {
  ga4CredentialStore?: Ga4CredentialStore
  googleConnectionStore?: GoogleConnectionStore
  getGoogleAuthConfig?: () => GoogleAuthConfig
}

/**
 * Refresh an OAuth token if expired (or within 5 minutes of expiry).
 * Returns the current or refreshed access token.
 */
async function refreshOAuthTokenIfNeeded(
  googleStore: GoogleConnectionStore,
  authConfig: GoogleAuthConfig,
  canonicalDomain: string,
  oauthConn: { accessToken: string; refreshToken: string; tokenExpiresAt?: string | null },
): Promise<string> {
  const expiresAt = oauthConn.tokenExpiresAt ? new Date(oauthConn.tokenExpiresAt).getTime() : 0
  const fiveMinutes = 5 * 60 * 1000
  if (Date.now() > expiresAt - fiveMinutes) {
    if (!authConfig.clientId || !authConfig.clientSecret) {
      throw validationError('Google OAuth client credentials are not configured — cannot refresh GA4 token.')
    }
    const tokens = await refreshAccessToken(authConfig.clientId, authConfig.clientSecret, oauthConn.refreshToken)
    const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    googleStore.updateConnection(canonicalDomain, 'ga4', {
      accessToken: tokens.access_token,
      tokenExpiresAt: newExpiresAt,
      updatedAt: new Date().toISOString(),
    })
    return tokens.access_token
  }
  return oauthConn.accessToken
}

/**
 * Map a GA4 client failure onto a Canonry error.
 *
 * Without this an upstream 401 propagates as-is and a web caller is treated as
 * signed out: Google saying "this refresh token is dead" is a statement about
 * the operator's GOOGLE credential, never about the caller's Canonry session.
 * Mirrors `gscErrorToAppError` in google.ts.
 */
function ga4ErrorToAppError(err: unknown, context: string): AppError {
  if (err instanceof AppError) return err

  if (err instanceof GA4ApiError) {
    if (err.status === 429) {
      return quotaExceeded('Google Analytics Admin API (rate limited; retries exhausted)')
    }
    if (err.status === 401 || err.status === 403) {
      // Deliberately NOT authRequired(): that is a 401 and logs the dashboard
      // caller out. The Canonry request authenticated fine; the stored Google
      // grant is what failed.
      return forbidden(
        `${context}: the connected Google account was rejected by Google (${err.status}). ` +
        'Reconnect with "canonry google connect <project> --type ga4".',
        { reason: 'ga4-upstream-auth', upstreamStatus: err.status },
      )
    }
    return providerError(`${context}: ${err.message}`)
  }

  return providerError(`${context}: ${describeError(err)}`)
}

/**
 * Resolve a valid GA4 access token for a project.
 * Priority: service account (ga4CredentialStore) → OAuth token (googleConnectionStore).
 * Returns the access token and the resolved property ID.
 */
async function resolveGa4AccessToken(
  opts: GA4RoutesOptions,
  projectName: string,
  canonicalDomain: string,
): Promise<{ accessToken: string; propertyId: string }> {
  // 1. Try service account first
  const saConn = opts.ga4CredentialStore?.getConnection(projectName)
  if (saConn?.clientEmail && saConn?.privateKey && saConn?.propertyId) {
    const token = await getAccessToken(saConn.clientEmail, saConn.privateKey)
    return { accessToken: token, propertyId: saConn.propertyId }
  }

  // 2. Fall back to OAuth token from google connect --type ga4
  const googleStore = opts.googleConnectionStore
  const authConfig = opts.getGoogleAuthConfig?.()
  if (!googleStore || !authConfig) {
    throw validationError(
      'No GA4 credentials found. Run "canonry ga connect <project> --key-file <path>" or ' +
      '"canonry google connect <project> --type ga4" to authenticate.',
    )
  }

  const oauthConn = googleStore.getConnection(canonicalDomain, 'ga4')
  if (!oauthConn?.accessToken || !oauthConn?.refreshToken) {
    throw validationError(
      'No GA4 credentials found. Run "canonry ga connect <project> --key-file <path>" or ' +
      '"canonry google connect <project> --type ga4" to authenticate.',
    )
  }

  if (!oauthConn.propertyId) {
    throw validationError(
      'GA4 property ID not set. Run "canonry ga properties <project>" to list the readable properties, ' +
      'then "canonry ga connect <project> --property-id <id>" to select one.',
    )
  }

  const accessToken = await refreshOAuthTokenIfNeeded(googleStore, authConfig, canonicalDomain, {
    accessToken: oauthConn.accessToken,
    refreshToken: oauthConn.refreshToken,
    tokenExpiresAt: oauthConn.tokenExpiresAt,
  })
  return { accessToken, propertyId: oauthConn.propertyId }
}

/**
 * Check that a GA4 connection (service account or OAuth) exists for a project.
 * Throws if no connection is found.
 */
function requireGa4Connection(opts: GA4RoutesOptions, projectName: string, canonicalDomain: string): void {
  const saConn = opts.ga4CredentialStore?.getConnection(projectName)
  const oauthConn = opts.googleConnectionStore?.getConnection(canonicalDomain, 'ga4')
  if (!saConn && !(oauthConn?.accessToken && oauthConn?.propertyId)) {
    throw validationError('No GA4 connection found. Run "canonry ga connect <project>" first.')
  }
}

export async function ga4Routes(app: FastifyInstance, opts: GA4RoutesOptions) {
  // POST /projects/:name/ga/connect
  // Accepts an optional service account key. When omitted, checks for an existing
  // OAuth token from "canonry google connect --type ga4" and registers the property ID.
  app.post<{
    Params: { name: string }
    Body: { propertyId: string; keyJson?: string }
  }>('/projects/:name/ga/connect', async (request, _reply) => {
    const project = resolveProject(app.db, request.params.name)
    const { propertyId, keyJson } = request.body ?? {}

    if (!propertyId || typeof propertyId !== 'string') {
      throw validationError('propertyId is required')
    }

    // --- Service account path ---
    if (keyJson && typeof keyJson === 'string') {
      if (!opts.ga4CredentialStore) {
        throw validationError('GA4 credential storage is not configured for this deployment')
      }

      let parsed: { client_email?: string; private_key?: string }
      try {
        parsed = JSON.parse(keyJson) as { client_email?: string; private_key?: string }
      } catch {
        throw validationError('Invalid JSON in keyJson')
      }

      if (!parsed.client_email || !parsed.private_key) {
        throw validationError('Service account JSON must contain client_email and private_key')
      }
      const clientEmail = parsed.client_email
      const privateKey = parsed.private_key

      try {
        await verifyConnection(clientEmail, privateKey, propertyId)
        gaLog('info', 'connect.verified.service-account', { projectId: project.id, propertyId })
      } catch (e) {
        const msg = describeError(e)
        gaLog('error', 'connect.verify-failed', { projectId: project.id, propertyId, error: msg })
        throw validationError(`Failed to verify GA4 credentials: ${msg}`)
      }

      const now = new Date().toISOString()
      const existing = opts.ga4CredentialStore.getConnection(project.name)
      opts.ga4CredentialStore.upsertConnection({
        projectName: project.name,
        propertyId,
        clientEmail,
        privateKey,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      })

      writeAuditLog(app.db, {
        projectId: project.id,
        actor: 'api',
        action: 'ga4.connected',
        entityType: 'ga_connection',
        entityId: propertyId,
      })

      return { connected: true, propertyId, authMethod: 'service-account', clientEmail }
    }

    // --- OAuth path: no key provided, use existing OAuth token ---
    const googleStore = opts.googleConnectionStore
    const authConfig = opts.getGoogleAuthConfig?.()
    if (!googleStore || !authConfig) {
      throw validationError(
        'No service account key provided and OAuth storage is not configured. ' +
        'Pass --key-file or run "canonry google connect <project> --type ga4" first.',
      )
    }

    const oauthConn = googleStore.getConnection(project.canonicalDomain, 'ga4')
    if (!oauthConn?.accessToken || !oauthConn?.refreshToken) {
      throw validationError(
        'No GA4 OAuth token found. Run "canonry google connect <project> --type ga4" first, ' +
        'or pass --key-file to use a service account.',
      )
    }

    // Get a valid (possibly refreshed) token
    const accessToken = await refreshOAuthTokenIfNeeded(googleStore, authConfig, project.canonicalDomain, {
      accessToken: oauthConn.accessToken,
      refreshToken: oauthConn.refreshToken,
      tokenExpiresAt: oauthConn.tokenExpiresAt,
    })

    // Verify the token works for this property
    try {
      await verifyConnectionWithToken(accessToken, propertyId)
      gaLog('info', 'connect.verified.oauth', { projectId: project.id, propertyId })
    } catch (e) {
      const msg = describeError(e)
      gaLog('error', 'connect.verify-failed.oauth', { projectId: project.id, propertyId, error: msg })
      throw validationError(`Failed to verify GA4 access: ${msg}`)
    }

    // Store the property ID on the OAuth connection record
    googleStore.updateConnection(project.canonicalDomain, 'ga4', {
      propertyId,
      updatedAt: new Date().toISOString(),
    })

    writeAuditLog(app.db, {
      projectId: project.id,
      actor: 'api',
      action: 'ga4.connected',
      entityType: 'ga_connection',
      entityId: propertyId,
    })

    return { connected: true, propertyId, authMethod: 'oauth' }
  })

  // DELETE /projects/:name/ga/disconnect
  app.delete<{ Params: { name: string } }>('/projects/:name/ga/disconnect', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const saConn = opts.ga4CredentialStore?.getConnection(project.name)
    const oauthConn = opts.googleConnectionStore?.getConnection(project.canonicalDomain, 'ga4')

    if (!saConn && !oauthConn) {
      throw notFound('GA4 connection', project.name)
    }

    // Delete traffic data, summaries, AI and social referral rows along with the connection.
    app.db.delete(gaTrafficSnapshots)
      .where(eq(gaTrafficSnapshots.projectId, project.id))
      .run()
    app.db.delete(gaTrafficSummaries)
      .where(eq(gaTrafficSummaries.projectId, project.id))
      .run()
    app.db.delete(gaDailyTotals)
      .where(eq(gaDailyTotals.projectId, project.id))
      .run()
    app.db.delete(gaAiReferrals)
      .where(eq(gaAiReferrals.projectId, project.id))
      .run()
    app.db.delete(gaSocialReferrals)
      .where(eq(gaSocialReferrals.projectId, project.id))
      .run()

    const propertyId = saConn?.propertyId ?? oauthConn?.propertyId ?? null
    opts.ga4CredentialStore?.deleteConnection(project.name)
    opts.googleConnectionStore?.deleteConnection(project.canonicalDomain, 'ga4')

    writeAuditLog(app.db, {
      projectId: project.id,
      actor: 'api',
      action: 'ga4.disconnected',
      entityType: 'ga_connection',
      entityId: propertyId,
    })

    return reply.status(204).send()
  })

  // GET /projects/:name/ga/status
  // GET /projects/:name/ga/properties
  //
  // Deliberately does NOT go through resolveGa4AccessToken: that helper
  // requires a propertyId to already be set, which is the exact thing this
  // route exists to discover. Requiring it here would make the numeric id
  // unobtainable from canonry and force the operator into the GA4 UI.
  app.get<{ Params: { name: string } }>('/projects/:name/ga/properties', async (request) => {
    // The Admin API answers for the OAuth PRINCIPAL, not for this project, so
    // the response names every GA account and property the operator can see —
    // other clients included. A key narrowed to one project must not read it.
    assertNotProjectScoped(request, 'listing GA4 properties')

    const project = resolveProject(app.db, request.params.name)

    const googleStore = opts.googleConnectionStore
    const authConfig = opts.getGoogleAuthConfig?.()
    if (!googleStore || !authConfig) {
      throw validationError(
        'Google OAuth is not configured. Run "canonry google connect <project> --type ga4" first.',
      )
    }

    const oauthConn = googleStore.getConnection(project.canonicalDomain, 'ga4')
    if (!oauthConn?.accessToken || !oauthConn?.refreshToken) {
      throw validationError(
        'No GA4 OAuth connection for this project. Run "canonry google connect <project> --type ga4" first. ' +
        'Service-account connections already carry their property id and do not need this listing.',
      )
    }

    try {
      const accessToken = await refreshOAuthTokenIfNeeded(googleStore, authConfig, project.canonicalDomain, {
        accessToken: oauthConn.accessToken,
        refreshToken: oauthConn.refreshToken,
        tokenExpiresAt: oauthConn.tokenExpiresAt,
      })

      return { properties: await listProperties(accessToken) }
    } catch (err) {
      throw ga4ErrorToAppError(err, 'Failed to list GA4 properties')
    }
  })

  app.get<{ Params: { name: string } }>('/projects/:name/ga/status', async (request, _reply) => {
    const project = resolveProject(app.db, request.params.name)

    const saConn = opts.ga4CredentialStore?.getConnection(project.name)
    const oauthConn = opts.googleConnectionStore?.getConnection(project.canonicalDomain, 'ga4')

    const connected = !!(saConn || (oauthConn?.accessToken && oauthConn?.propertyId))
    if (!connected) {
      return { connected: false, propertyId: null, clientEmail: null, authMethod: null, lastSyncedAt: null }
    }

    const latestSync = app.db
      .select({ syncedAt: gaTrafficSummaries.syncedAt })
      .from(gaTrafficSummaries)
      .where(eq(gaTrafficSummaries.projectId, project.id))
      .orderBy(desc(gaTrafficSummaries.syncedAt))
      .limit(1)
      .get()

    return {
      connected: true,
      propertyId: saConn?.propertyId ?? oauthConn?.propertyId ?? null,
      clientEmail: saConn?.clientEmail ?? null,
      authMethod: saConn ? 'service-account' : 'oauth',
      lastSyncedAt: latestSync?.syncedAt ?? null,
      createdAt: saConn?.createdAt ?? oauthConn?.createdAt ?? null,
      updatedAt: saConn?.updatedAt ?? oauthConn?.updatedAt ?? null,
    }
  })

  // POST /projects/:name/ga/sync
  // The `only` field opts out of AI or social channel breakdowns. The
  // traffic snapshots and aggregate summary are always refreshed regardless
  // — they're the denominator for every share metric in the dashboard, so
  // letting them go stale would make `socialSharePct` etc. compare social
  // sessions in the requested window with a total from a different (older)
  // window. See `share denominator` discussion below.
  //
  // Valid `only` values: "traffic" (foundation only), "ai" (foundation + AI),
  // "social" (foundation + social). Omit for the full set.
  app.post<{
    Params: { name: string }
    Body: { days?: number; only?: string }
  }>('/projects/:name/ga/sync', async (request, _reply) => {
    const project = resolveProject(app.db, request.params.name)

    // Every GA4 fetch bounds its window to [1, GA4_MAX_SYNC_DAYS]. Resolve the
    // bound HERE too, from the same helper, so `days` in the response is the
    // window that was actually written rather than the one that was asked for
    // — a `--days 500` sync writes 90 and used to report 500.
    const { requestedDays, effectiveDays: days, clamped } = resolveGa4SyncDays(request.body?.days)
    const only = request.body?.only

    const validOnlyValues = ['traffic', 'ai', 'social'] as const
    if (only !== undefined && !validOnlyValues.includes(only as typeof validOnlyValues[number])) {
      throw validationError(`Invalid "only" value "${only}". Must be one of: ${validOnlyValues.join(', ')}`)
    }

    // Foundation (traffic snapshots + aggregate summary) always syncs — share
    // metrics depend on a denominator that covers the same window as the
    // social/AI numerators. The `only` flag controls which channel
    // breakdowns are also refreshed.
    const syncTraffic = true
    const syncSummary = true
    const syncAi = !only || only === 'ai'
    const syncSocial = !only || only === 'social'

    const measurementState = app.db.select().from(gaMeasurementSyncStates)
      .where(eq(gaMeasurementSyncStates.projectId, project.id)).get()
    // `days` is already bounded, so an incremental refresh reuses it directly;
    // a first-ever measurement sync backfills the full supported window.
    const acquisitionDays = measurementState?.acquisitionSyncedAt != null ? days : GA4_MAX_SYNC_DAYS
    const leadDays = measurementState?.leadSyncedAt != null ? days : GA4_MAX_SYNC_DAYS
    const leadEventNames = project.measurement.leadEventNames

    const startedAt = new Date().toISOString()
    const runId = crypto.randomUUID()
    app.db.insert(runs).values({
      id: runId,
      projectId: project.id,
      kind: RunKinds['ga-sync'],
      status: RunStatuses.running,
      trigger: RunTriggers.manual,
      startedAt,
      createdAt: startedAt,
    }).run()

    try {
      const { accessToken, propertyId } = await resolveGa4AccessToken(opts, project.name, project.canonicalDomain)

      let rows: Awaited<ReturnType<typeof fetchTrafficByLandingPage>> = []
      let aiReferrals: Awaited<ReturnType<typeof fetchAiReferrals>> = []
      let socialReferrals: Awaited<ReturnType<typeof fetchSocialReferrals>> = []

      // Always need summary for date range (periodStart/periodEnd), even for partial sync.
      // Windowed summaries (7d/30d/90d) are fetched alongside so the dashboard can show
      // deduplicated totalUsers per window without summing per-page snapshots (overcounts).
      const WINDOW_KEYS = ['7d', '30d', '90d'] as const
      // Daily totals carry NO landing-page dimension, so GA deduplicates
      // `users` per day. Fetched unconditionally alongside the summary for the
      // same reason the summary is: the daily series is a foundation read, not
      // a channel breakdown the `only` flag scopes.
      const fetches: Promise<unknown>[] = [
        fetchAggregateSummary(accessToken, propertyId, days),
        ...WINDOW_KEYS.map((w) => fetchWindowSummary(accessToken, propertyId, w)),
        fetchDailyTotals(accessToken, propertyId, days),
      ]
      if (syncTraffic) fetches.push(fetchTrafficByLandingPage(accessToken, propertyId, days))
      if (syncAi) fetches.push(fetchAiReferrals(accessToken, propertyId, days))
      if (syncSocial) fetches.push(fetchSocialReferrals(accessToken, propertyId, days))

      const measurementFetch = Promise.allSettled([
        fetchAcquisitionByChannel(accessToken, propertyId, acquisitionDays),
        leadEventNames.length > 0
          ? fetchLeadEvents(accessToken, propertyId, leadEventNames, leadDays)
          : Promise.resolve(null),
      ])

      const results = await Promise.all(fetches)
      const summary: Awaited<ReturnType<typeof fetchAggregateSummary>> = results[0] as Awaited<ReturnType<typeof fetchAggregateSummary>>
      const windowSummaries = results.slice(1, 1 + WINDOW_KEYS.length) as Array<Awaited<ReturnType<typeof fetchWindowSummary>>>
      const dailyTotals = results[1 + WINDOW_KEYS.length] as Awaited<ReturnType<typeof fetchDailyTotals>>
      let idx = 2 + WINDOW_KEYS.length
      if (syncTraffic) { rows = results[idx++] as typeof rows }
      if (syncAi) { aiReferrals = results[idx++] as typeof aiReferrals }
      if (syncSocial) { socialReferrals = results[idx++] as typeof socialReferrals }

      const now = new Date().toISOString()

      // Clear old data for this project in the synced date range, then insert fresh
      // Wrapped in a transaction to ensure atomicity — a crash mid-insert won't lose data
      app.db.transaction((tx) => {
        if (syncTraffic) {
          tx.delete(gaTrafficSnapshots)
            .where(
              and(
                eq(gaTrafficSnapshots.projectId, project.id),
                sql`${gaTrafficSnapshots.date} >= ${summary.periodStart}`,
                sql`${gaTrafficSnapshots.date} <= ${summary.periodEnd}`,
              ),
            )
            .run()

          for (const row of rows) {
            tx.insert(gaTrafficSnapshots).values({
              id: crypto.randomUUID(),
              projectId: project.id,
              date: row.date,
              landingPage: row.landingPage,
              landingPageNormalized: normalizeUrlPath(row.landingPage),
              sessions: row.sessions,
              organicSessions: row.organicSessions,
              directSessions: row.directSessions,
              users: row.users,
              syncedAt: now,
              syncRunId: runId,
            }).run()
          }
        }

        // Deduplicated per-day totals. Written on every sync (not gated on
        // `syncTraffic`) because they are the honest denominator for the daily
        // series regardless of which breakdowns were refreshed. Delete-range
        // then insert keeps the unique (project, date) index clean when a
        // re-sync covers days that already have a row.
        tx.delete(gaDailyTotals)
          .where(
            and(
              eq(gaDailyTotals.projectId, project.id),
              sql`${gaDailyTotals.date} >= ${summary.periodStart}`,
              sql`${gaDailyTotals.date} <= ${summary.periodEnd}`,
            ),
          )
          .run()

        for (const row of dailyTotals) {
          tx.insert(gaDailyTotals).values({
            id: crypto.randomUUID(),
            projectId: project.id,
            date: row.date,
            sessions: row.sessions,
            users: row.users,
            // Stored as given, nulls included: an absent reading is not a 0%
            // engagement day. No returning-users figure is derived here —
            // it is derived from `users - newUsers` at read time so the stored
            // row keeps only what GA4 actually reported.
            engagementRate: row.engagementRate,
            newUsers: row.newUsers,
            syncedAt: now,
            syncRunId: runId,
            createdAt: now,
          }).run()
        }

        if (syncAi) {
          tx.delete(gaAiReferrals)
            .where(
              and(
                eq(gaAiReferrals.projectId, project.id),
                sql`${gaAiReferrals.date} >= ${summary.periodStart}`,
                sql`${gaAiReferrals.date} <= ${summary.periodEnd}`,
              ),
            )
            .run()

          for (const row of aiReferrals) {
            tx.insert(gaAiReferrals).values({
              id: crypto.randomUUID(),
              projectId: project.id,
              date: row.date,
              source: row.source,
              medium: row.medium,
              trafficClass: row.trafficClass ?? classifyAiReferralTrafficClass({
                source: row.source,
                medium: row.medium,
                channelGroup: row.channelGroup,
                landingPage: row.landingPage,
              }),
              sourceDimension: row.sourceDimension,
              channelGroup: row.channelGroup,
              landingPage: row.landingPage,
              landingPageNormalized: normalizeUrlPath(row.landingPage),
              sessions: row.sessions,
              users: row.users,
              syncedAt: now,
              syncRunId: runId,
            }).run()
          }
        }

        if (syncSocial) {
          tx.delete(gaSocialReferrals)
            .where(
              and(
                eq(gaSocialReferrals.projectId, project.id),
                sql`${gaSocialReferrals.date} >= ${summary.periodStart}`,
                sql`${gaSocialReferrals.date} <= ${summary.periodEnd}`,
              ),
            )
            .run()

          for (const row of socialReferrals) {
            tx.insert(gaSocialReferrals).values({
              id: crypto.randomUUID(),
              projectId: project.id,
              date: row.date,
              source: row.source,
              medium: row.medium,
              channelGroup: row.channelGroup,
              sessions: row.sessions,
              users: row.users,
              syncedAt: now,
              syncRunId: runId,
            }).run()
          }
        }

        if (syncSummary) {
          // Replace aggregate summary for this project — always one row per project.
          tx.delete(gaTrafficSummaries)
            .where(eq(gaTrafficSummaries.projectId, project.id))
            .run()

          tx.insert(gaTrafficSummaries).values({
            id: crypto.randomUUID(),
            projectId: project.id,
            periodStart: summary.periodStart,
            periodEnd: summary.periodEnd,
            totalSessions: summary.totalSessions,
            totalOrganicSessions: summary.totalOrganicSessions,
            totalUsers: summary.totalUsers,
            syncedAt: now,
            syncRunId: runId,
          }).run()

          // Replace windowed summaries — one row per (project, windowKey).
          // Drives the deduplicated totalUsers headline when a window filter
          // is active in /ga/traffic.
          tx.delete(gaTrafficWindowSummaries)
            .where(eq(gaTrafficWindowSummaries.projectId, project.id))
            .run()
          for (const ws of windowSummaries) {
            tx.insert(gaTrafficWindowSummaries).values({
              id: crypto.randomUUID(),
              projectId: project.id,
              windowKey: ws.windowKey,
              periodStart: ws.periodStart,
              periodEnd: ws.periodEnd,
              totalSessions: ws.totalSessions,
              totalOrganicSessions: ws.totalOrganicSessions,
              totalDirectSessions: ws.totalDirectSessions,
              totalUsers: ws.totalUsers,
              syncedAt: now,
              syncRunId: runId,
            }).run()
          }
        }
      })

      const [acquisitionSettled, leadsSettled] = await measurementFetch
      const measurementNow = new Date().toISOString()

      const recordMeasurementFailure = (
        component: 'acquisition' | 'leads',
        reason: unknown,
      ) => {
        const message = describeError(reason)
        gaLog('warn', 'measurement.component-failed', {
          projectId: project.id,
          runId,
          component,
          error: message,
        })
        try {
          persistMeasurementError(app.db, project.id, component, message, measurementNow)
        } catch (stateError) {
          gaLog('error', 'measurement.state-write-failed', {
            projectId: project.id,
            runId,
            component,
            error: describeError(stateError),
          })
        }
        return { status: 'error' as const, days: component === 'acquisition' ? acquisitionDays : leadDays, rowCount: 0, error: message }
      }

      const acquisitionResult = (() => {
        if (acquisitionSettled.status === 'rejected') {
          return recordMeasurementFailure('acquisition', acquisitionSettled.reason)
        }
        try {
          persistAcquisitionMeasurement(app.db, {
            projectId: project.id,
            runId,
            syncedAt: measurementNow,
            report: acquisitionSettled.value,
          })
          return {
            status: 'ready' as const,
            days: acquisitionDays,
            rowCount: acquisitionSettled.value.rows.length,
          }
        } catch (error) {
          return recordMeasurementFailure('acquisition', error)
        }
      })()

      const leadResult = (() => {
        if (leadsSettled.status === 'rejected') {
          return recordMeasurementFailure('leads', leadsSettled.reason)
        }
        if (leadsSettled.value === null) {
          resetLeadMeasurement(app.db, project.id, measurementNow)
          return { status: 'not-configured' as const, days: 0, rowCount: 0 }
        }
        try {
          persistLeadMeasurement(app.db, {
            projectId: project.id,
            runId,
            syncedAt: measurementNow,
            report: leadsSettled.value,
          })
          return {
            status: 'ready' as const,
            days: leadDays,
            rowCount: leadsSettled.value.rows.length,
            attributionScope: leadsSettled.value.attributionScope,
          }
        } catch (error) {
          return recordMeasurementFailure('leads', error)
        }
      })()

      app.db.update(runs)
        .set({ status: RunStatuses.completed, finishedAt: measurementNow })
        .where(eq(runs.id, runId))
        .run()

      // List every component that was actually written this run. Foundation
      // (traffic + summary) always syncs, so it always appears when `only`
      // is set; the requested channel breakdown is appended.
      const syncedComponents = only
        ? [
            ...(syncTraffic ? ['traffic'] : []),
            ...(syncSummary ? ['summary'] : []),
            ...(syncAi ? ['ai'] : []),
            ...(syncSocial ? ['social'] : []),
          ]
        : undefined

      gaLog('info', 'sync.complete', {
        projectId: project.id,
        runId,
        rowCount: rows.length,
        aiReferralCount: aiReferrals.length,
        socialReferralCount: socialReferrals.length,
        days,
        ...(clamped ? { requestedDays, clamped } : {}),
        totalUsers: summary.totalUsers,
        ...(only ? { only } : {}),
      })

      return {
        synced: true,
        rowCount: rows.length,
        aiReferralCount: aiReferrals.length,
        socialReferralCount: socialReferrals.length,
        days,
        requestedDays,
        clamped,
        syncedAt: now,
        measurement: {
          acquisition: acquisitionResult,
          leads: leadResult,
        },
        ...(syncedComponents ? { syncedComponents } : {}),
      }
    } catch (e) {
      const msg = describeError(e)
      gaLog('error', 'sync.fetch-failed', { projectId: project.id, runId, error: msg })
      app.db.update(runs)
        .set({ status: RunStatuses.failed, error: msg, finishedAt: new Date().toISOString() })
        .where(eq(runs.id, runId))
        .run()
      throw e
    }
  })

  // GET /projects/:name/ga/traffic
  app.get<{
    Params: { name: string }
    Querystring: { limit?: string; days?: string; window?: string; startDate?: string; endDate?: string }
  }>('/projects/:name/ga/traffic', async (request, _reply) => {
    const project = resolveProject(app.db, request.params.name)
    requireGa4Connection(opts, project.name, project.canonicalDomain)

    const limit = Math.max(1, Math.min(parseInt(request.query.limit ?? '50', 10) || 50, 500))
    const range = resolveDateRange(request.query)

    // When filtering by window, prefer the per-window summary row populated by
    // /ga/sync — it carries deduplicated totalUsers (no landing-page dimension).
    // Summing gaTrafficSnapshots.users here would double-count users who land
    // on multiple pages (one row per landing page). Falls back to the
    // snapshot SUM for backwards compatibility (projects that haven't synced
    // since the windowed-summary table was introduced).
    //
    // A precomputed row answers exactly one rolling window, so it can only be
    // used when the range IS that window. An explicit calendar range (or a
    // window paired with an endDate) has no precomputed row and must be summed.
    const windowSummaryRow = range.startDate && !range.explicitDates
      ? app.db
          .select({
            periodStart: gaTrafficWindowSummaries.periodStart,
            periodEnd: gaTrafficWindowSummaries.periodEnd,
            totalSessions: gaTrafficWindowSummaries.totalSessions,
            totalOrganicSessions: gaTrafficWindowSummaries.totalOrganicSessions,
            totalDirectSessions: gaTrafficWindowSummaries.totalDirectSessions,
            totalUsers: gaTrafficWindowSummaries.totalUsers,
          })
          .from(gaTrafficWindowSummaries)
          .where(
            and(
              eq(gaTrafficWindowSummaries.projectId, project.id),
              eq(gaTrafficWindowSummaries.windowKey, range.window),
            ),
          )
          .get()
      : null

    const projectSummaryRow = app.db
      .select({
        periodStart: gaTrafficSummaries.periodStart,
        periodEnd: gaTrafficSummaries.periodEnd,
        totalSessions: gaTrafficSummaries.totalSessions,
        totalOrganicSessions: gaTrafficSummaries.totalOrganicSessions,
        totalUsers: gaTrafficSummaries.totalUsers,
      })
      .from(gaTrafficSummaries)
      .where(eq(gaTrafficSummaries.projectId, project.id))
      .get()

    const retainedBounds = [
      app.db
        .select({ min: sql<string | null>`MIN(${gaTrafficSnapshots.date})`, max: sql<string | null>`MAX(${gaTrafficSnapshots.date})` })
        .from(gaTrafficSnapshots)
        .where(eq(gaTrafficSnapshots.projectId, project.id))
        .get(),
      app.db
        .select({ min: sql<string | null>`MIN(${gaAiReferrals.date})`, max: sql<string | null>`MAX(${gaAiReferrals.date})` })
        .from(gaAiReferrals)
        .where(eq(gaAiReferrals.projectId, project.id))
        .get(),
      app.db
        .select({ min: sql<string | null>`MIN(${gaSocialReferrals.date})`, max: sql<string | null>`MAX(${gaSocialReferrals.date})` })
        .from(gaSocialReferrals)
        .where(eq(gaSocialReferrals.projectId, project.id))
        .get(),
    ]
    const retainedDates = retainedBounds.flatMap(bound => [bound?.min, bound?.max]).filter((date): date is string => Boolean(date))
    const projectSummaryCoversAll = Boolean(
      projectSummaryRow?.periodStart
      && projectSummaryRow.periodEnd
      && retainedDates.every(date => date >= projectSummaryRow.periodStart && date <= projectSummaryRow.periodEnd),
    )

    // THE window. Every figure in this response is measured over exactly these
    // dates, and `windowStart` / `windowEnd` / `windowDays` report them.
    //
    // A precomputed summary supplies the denominator (`totalSessions`) and the
    // deduplicated `totalUsers`, and it covers its own period — not the range
    // the caller asked for and not the span retained in the detail tables. The
    // channel counts (direct, social, AI, top pages) are summed from those
    // detail tables, so unless they are bounded to the SAME dates, every share
    // divides one period's numerator by another period's denominator.
    //
    // That shipped. With no window at all, `totalSessions` came from the
    // project summary's 30 days while direct and social summed 90 days of
    // retained rows, and a real 20.6% direct share was reported as 69% —
    // enough to describe a mostly-paid business as a direct/social brand.
    //
    // Both bounds must be present to be usable: `dateRangeConditions` drops a
    // blank bound, so a half-filled period would narrow one end and leave the
    // other open — the mix again, in a shape that looks bounded.
    // Only an exact rolling-window aggregate can supply an un-dimensioned
    // denominator. `all` (including an omitted window) means full retained
    // history, so the latest sync summary must not silently narrow that read.
    const denominatorRow = windowSummaryRow
      ?? (range.window === 'all' && projectSummaryCoversAll ? projectSummaryRow : null)
    const denominatorPeriod = denominatorRow?.periodStart && denominatorRow.periodEnd
      ? { startDate: denominatorRow.periodStart, endDate: denominatorRow.periodEnd }
      : null
    const measuredRange: ResolvedDateRange = denominatorPeriod
      ? { ...range, ...denominatorPeriod }
      : range

    const snapshotConditions = [eq(gaTrafficSnapshots.projectId, project.id), ...dateRangeConditions(gaTrafficSnapshots.date, measuredRange)]
    const aiConditions = [eq(gaAiReferrals.projectId, project.id), ...dateRangeConditions(gaAiReferrals.date, measuredRange)]
    const socialConditions = [eq(gaSocialReferrals.projectId, project.id), ...dateRangeConditions(gaSocialReferrals.date, measuredRange)]

    // Sessions are safe to sum: gaTrafficSnapshots is dimensioned by landing
    // page and a session has exactly one landing page. USERS ARE NOT. GA counts
    // users as a COUNT DISTINCT at the grain requested, so a visitor who read
    // three landing pages is three rows here, and no summation of this table
    // recovers the distinct count.
    //
    // There is no stored un-dimensioned aggregate for an arbitrary calendar
    // range (the window summaries answer exactly one rolling window), so the
    // honest answer for an explicit range is that the figure is unavailable.
    // Emitting the inflated sum would be a plausible wrong number, which is
    // worse than a missing one.
    const snapshotTotalsRow = !denominatorRow
      ? (() => {
        const summed = app.db
          .select({
            totalSessions: sql<number>`COALESCE(SUM(${gaTrafficSnapshots.sessions}), 0)`,
            totalOrganicSessions: sql<number>`COALESCE(SUM(${gaTrafficSnapshots.organicSessions}), 0)`,
            totalUsers: sql<number>`COALESCE(SUM(${gaTrafficSnapshots.users}), 0)`,
          })
          .from(gaTrafficSnapshots)
          .where(and(...snapshotConditions))
          .get()
        return {
          totalSessions: summed?.totalSessions ?? 0,
          totalOrganicSessions: summed?.totalOrganicSessions ?? 0,
          // Unavailable for an explicit or all-history range. The rolling-
          // window fallback keeps its historical summed value for projects
          // that have not yet backfilled window summaries.
          totalUsers: range.explicitDates || range.window === 'all'
            ? null
            : (summed?.totalUsers ?? 0),
        }
      })()
      : null

    const summaryRow = denominatorRow ?? snapshotTotalsRow

    // Direct-channel total. With a window filter, prefer the deduplicated value
    // from gaTrafficWindowSummaries; otherwise fall back to summing snapshots
    // (sessions are dimensioned by landing page but each session has a single
    // landing page, so SUM doesn't overcount sessions — only users).
    const directTotalRow = windowSummaryRow
      ? { totalDirectSessions: windowSummaryRow.totalDirectSessions }
      : app.db
          .select({
            totalDirectSessions: sql<number>`COALESCE(SUM(${gaTrafficSnapshots.directSessions}), 0)`,
          })
          .from(gaTrafficSnapshots)
          .where(and(...snapshotConditions))
          .get()

    // Group by COALESCE(normalized, raw) so click-ID-fragmented variants
    // of the same page collapse, and partially-backfilled state (where
    // older rows have null normalized) still aggregates correctly.
    const rows = app.db
      .select({
        landingPage: sql<string>`COALESCE(${gaTrafficSnapshots.landingPageNormalized}, ${gaTrafficSnapshots.landingPage})`,
        sessions: sql<number>`SUM(${gaTrafficSnapshots.sessions})`,
        organicSessions: sql<number>`SUM(${gaTrafficSnapshots.organicSessions})`,
        directSessions: sql<number>`COALESCE(SUM(${gaTrafficSnapshots.directSessions}), 0)`,
        users: sql<number>`SUM(${gaTrafficSnapshots.users})`,
      })
      .from(gaTrafficSnapshots)
      .where(and(...snapshotConditions))
      .groupBy(sql`COALESCE(${gaTrafficSnapshots.landingPageNormalized}, ${gaTrafficSnapshots.landingPage})`)
      .orderBy(sql`SUM(${gaTrafficSnapshots.sessions}) DESC`)
      .limit(limit)
      .all()

    const aiReferralRows = app.db
      .select({
        source: gaAiReferrals.source,
        medium: gaAiReferrals.medium,
        trafficClass: gaAiReferrals.trafficClass,
        sourceDimension: gaAiReferrals.sourceDimension,
        sessions: sql<number>`SUM(${gaAiReferrals.sessions})`,
      })
      .from(gaAiReferrals)
      .where(and(...aiConditions))
      .groupBy(gaAiReferrals.source, gaAiReferrals.medium, gaAiReferrals.trafficClass, gaAiReferrals.sourceDimension)
      .all()

    const aiReferralLandingPageRows = app.db
      .select({
        source: gaAiReferrals.source,
        medium: gaAiReferrals.medium,
        trafficClass: gaAiReferrals.trafficClass,
        sourceDimension: gaAiReferrals.sourceDimension,
        landingPage: sql<string>`COALESCE(${gaAiReferrals.landingPageNormalized}, ${gaAiReferrals.landingPage})`,
        sessions: sql<number>`SUM(${gaAiReferrals.sessions})`,
      })
      .from(gaAiReferrals)
      .where(and(...aiConditions))
      .groupBy(
        gaAiReferrals.source,
        gaAiReferrals.medium,
        gaAiReferrals.trafficClass,
        gaAiReferrals.sourceDimension,
        sql`COALESCE(${gaAiReferrals.landingPageNormalized}, ${gaAiReferrals.landingPage})`,
      )
      .all()

    // `users` is deliberately not selected. GA counts users DISTINCT at the
    // grain it was asked for, so the stored column cannot be summed at any
    // grain — see the users rule in `ga-ai-referral-aggregation.ts`.
    const aiRowsForTotals = app.db
      .select({
        date: gaAiReferrals.date,
        source: gaAiReferrals.source,
        medium: gaAiReferrals.medium,
        trafficClass: gaAiReferrals.trafficClass,
        sourceDimension: gaAiReferrals.sourceDimension,
        channelGroup: gaAiReferrals.channelGroup,
        sessions: gaAiReferrals.sessions,
      })
      .from(gaAiReferrals)
      .where(and(...aiConditions))
      .all()

    // Dedupe across attribution dimensions: 'session', 'first_user', and
    // 'manual_utm' are overlapping lenses on the same visit, not disjoint
    // events. Returning all three would inflate the row count (e.g. 1 source
    // showing as 6 rows). Keep the winning dimension — the one with the
    // highest session count — per (source, medium) for `aiReferrals` and per
    // (source, medium, landingPage) for `aiReferralLandingPages`. The cross-
    // cutting / session-only totals (`aiSessionsDeduped`, `aiSessionsBySession`)
    // are computed independently below and are unaffected.
    const aiReferrals = keepWinningDimensionRows(aiReferralRows, (r) => r.source)
    const aiReferralLandingPages = keepWinningDimensionRows(
      aiReferralLandingPageRows,
      (r) => `${r.source}\0${r.landingPage}`,
    )

    // SessionSource, firstUserSource, and manual UTM rows are overlapping
    // attribution lenses. Summarize once, keeping the existing combined AI
    // totals while also splitting paid vs organic/non-paid AI traffic.
    const aiSummary = summarizeAiReferralCounts(aiRowsForTotals)

    const socialReferrals = app.db
      .select({
        source: gaSocialReferrals.source,
        medium: gaSocialReferrals.medium,
        channelGroup: gaSocialReferrals.channelGroup,
        // No `users`. ga_social_referrals is keyed
        // (project, date, source, medium, channel_group) and its users column
        // is GA's COUNT DISTINCT at that grain, so summing over the window's
        // dates counts a returning visitor once per day they returned. Same
        // conclusion the AI-referral surfaces reached in 4.135.0.
        sessions: sql<number>`SUM(${gaSocialReferrals.sessions})`,
      })
      .from(gaSocialReferrals)
      .where(and(...socialConditions))
      .groupBy(gaSocialReferrals.source, gaSocialReferrals.medium, gaSocialReferrals.channelGroup)
      .orderBy(sql`SUM(${gaSocialReferrals.sessions}) DESC`)
      .all()

    // Session-scoped totals — no cross-dimension dedup needed since we only
    // query sessionDefaultChannelGroup (single attribution lens).
    const socialTotals = app.db
      .select({
        sessions: sql<number>`SUM(${gaSocialReferrals.sessions})`,
      })
      .from(gaSocialReferrals)
      .where(and(...socialConditions))
      .get()

    const latestSync = app.db
      .select({ syncedAt: gaTrafficSummaries.syncedAt })
      .from(gaTrafficSummaries)
      .where(eq(gaTrafficSummaries.projectId, project.id))
      .orderBy(desc(gaTrafficSummaries.syncedAt))
      .limit(1)
      .get()

    const total = summaryRow?.totalSessions ?? 0
    const totalDirectSessions = directTotalRow?.totalDirectSessions ?? 0
    const totalOrganicSessions = summaryRow?.totalOrganicSessions ?? 0
    const socialSessions = socialTotals?.sessions ?? 0

    const windowStart = measuredRange.startDate
    const windowEnd = measuredRange.endDate
    // Only a CLOSED window has a day count. An open bound means "everything on
    // that side", which is a span nothing here knows, and a number invented for
    // it would be the same kind of confident-and-wrong label this route just
    // stopped emitting.
    const windowDays = windowStart && windowEnd ? inclusiveDayCount(windowStart, windowEnd) : null
    const channelBreakdown = buildChannelBreakdown({
      totalSessions: total,
      organicSessions: totalOrganicSessions,
      socialSessions,
      directSessions: totalDirectSessions,
      aiSessionsByChannelGroup: aiSummary.bySessionChannelGroup,
    })

    return {
      totalSessions: total,
      totalOrganicSessions,
      totalDirectSessions,
      // `null` (not 0) when the range has no un-dimensioned aggregate behind
      // it. GA counts users as a COUNT DISTINCT at the grain requested, so the
      // landing-page dimensioned sum is inflated, and a 0 would read as
      // "nobody visited" rather than "not measurable for this range".
      totalUsers: summaryRow ? summaryRow.totalUsers : null,
      topPages: rows.map((r) => ({
        landingPage: r.landingPage,
        sessions: r.sessions ?? 0,
        organicSessions: r.organicSessions ?? 0,
        directSessions: r.directSessions ?? 0,
        users: r.users ?? 0,
      })),
      // No `users` on either referral row type, and no `ai*Users*` totals: GA
      // reports users as a COUNT DISTINCT at the grain requested, so summing
      // the stored column across landing pages (and, for these rows, across
      // every date in the window) counted one visitor once per row. Withdrawn
      // in 4.135.0; see `ga-ai-referral-aggregation.ts` for why no correct
      // figure can be computed or fetched.
      aiReferrals: aiReferrals.map((r) => ({
        source: r.source,
        medium: r.medium,
        trafficClass: normalizeAiTrafficClass(r.trafficClass),
        sourceDimension: r.sourceDimension,
        sessions: r.sessions ?? 0,
      })),
      aiReferralLandingPages: aiReferralLandingPages.map((r) => ({
        source: r.source,
        medium: r.medium,
        trafficClass: normalizeAiTrafficClass(r.trafficClass),
        sourceDimension: r.sourceDimension,
        landingPage: r.landingPage,
        sessions: r.sessions ?? 0,
      })),
      aiSessionsDeduped: aiSummary.deduped.sessions,
      paidAiSessionsDeduped: aiSummary.paidDeduped.sessions,
      organicAiSessionsDeduped: aiSummary.organicDeduped.sessions,
      aiSessionsBySession: aiSummary.bySession.sessions,
      paidAiSessionsBySession: aiSummary.paidBySession.sessions,
      organicAiSessionsBySession: aiSummary.organicBySession.sessions,
      socialReferrals: socialReferrals.map((r) => ({
        source: r.source,
        medium: r.medium,
        channelGroup: r.channelGroup,
        sessions: r.sessions ?? 0,
      })),
      socialSessions,
      channelBreakdown,
      organicSharePct: percentOf(totalOrganicSessions, total) ?? 0,
      aiSharePct: percentOf(aiSummary.deduped.sessions, total) ?? 0,
      aiSharePctBySession: percentOf(aiSummary.bySession.sessions, total) ?? 0,
      paidAiSharePct: percentOf(aiSummary.paidDeduped.sessions, total) ?? 0,
      paidAiSharePctBySession: percentOf(aiSummary.paidBySession.sessions, total) ?? 0,
      organicAiSharePct: percentOf(aiSummary.organicDeduped.sessions, total) ?? 0,
      organicAiSharePctBySession: percentOf(aiSummary.organicBySession.sessions, total) ?? 0,
      directSharePct: percentOf(totalDirectSessions, total) ?? 0,
      socialSharePct: percentOf(socialSessions, total) ?? 0,
      otherSessions: channelBreakdown.other.sessions,
      otherSharePct: channelBreakdown.other.sharePct,
      otherSharePctDisplay: channelBreakdown.other.sharePctDisplay,
      organicSharePctDisplay: formatSharePct(totalOrganicSessions, total),
      aiSharePctDisplay: formatSharePct(aiSummary.deduped.sessions, total),
      aiSharePctBySessionDisplay: formatSharePct(aiSummary.bySession.sessions, total),
      paidAiSharePctDisplay: formatSharePct(aiSummary.paidDeduped.sessions, total),
      paidAiSharePctBySessionDisplay: formatSharePct(aiSummary.paidBySession.sessions, total),
      organicAiSharePctDisplay: formatSharePct(aiSummary.organicDeduped.sessions, total),
      organicAiSharePctBySessionDisplay: formatSharePct(aiSummary.organicBySession.sessions, total),
      directSharePctDisplay: formatSharePct(totalDirectSessions, total),
      socialSharePctDisplay: formatSharePct(socialSessions, total),
      lastSyncedAt: latestSync?.syncedAt ?? null,
      // The window every figure above was measured over — never a different
      // table's period, and never a fallback that names dates the queries did
      // not use. A `null` bound is genuinely open (all retained history on that
      // side), which is why `windowDays` is null too rather than guessing a
      // span. Read a share against these dates or not at all.
      windowStart,
      windowEnd,
      windowDays,
      // Retained aliases of `windowStart` / `windowEnd`. They previously mixed
      // the requested range with the synced range, which is what let a 30-day
      // total sit under a 90-day channel count with a label that named neither.
      periodStart: windowStart,
      periodEnd: windowEnd,
    }
  })

  // GET /projects/:name/ga/ai-referral-history
  //
  // RAW DETAIL, one row per landing page per attribution dimension. Every row
  // is a fragment of a day, very often worth exactly 1 session. Do not collapse
  // these rows into a per-date or per-source count; that is what
  // /ga/ai-referral-daily below exists for.
  app.get<{
    Params: { name: string }
    Querystring: { window?: string; startDate?: string; endDate?: string }
  }>('/projects/:name/ga/ai-referral-history', async (request, _reply) => {
    const project = resolveProject(app.db, request.params.name)
    requireGa4Connection(opts, project.name, project.canonicalDomain)

    const range = resolveDateRange(request.query)
    const conditions = [eq(gaAiReferrals.projectId, project.id), ...dateRangeConditions(gaAiReferrals.date, range)]

    const rows = app.db
      .select({
        date: gaAiReferrals.date,
        source: gaAiReferrals.source,
        medium: gaAiReferrals.medium,
        trafficClass: gaAiReferrals.trafficClass,
        landingPage: sql<string>`COALESCE(${gaAiReferrals.landingPageNormalized}, ${gaAiReferrals.landingPage})`,
        sourceDimension: gaAiReferrals.sourceDimension,
        // No `users`: ga-ai-referral-aggregation states the rule for this
        // table, that there is no grain at which the stored users column may be
        // added up. ga4AiReferralDtoSchema.users was deprecated for this in
        // 4.135.0; the history endpoint kept emitting one.
        sessions: sql<number>`SUM(${gaAiReferrals.sessions})`,
      })
      .from(gaAiReferrals)
      .where(and(...conditions))
      .groupBy(
        gaAiReferrals.date,
        gaAiReferrals.source,
        gaAiReferrals.medium,
        gaAiReferrals.trafficClass,
        gaAiReferrals.sourceDimension,
        sql`COALESCE(${gaAiReferrals.landingPageNormalized}, ${gaAiReferrals.landingPage})`,
      )
      .orderBy(gaAiReferrals.date)
      .all()

    return rows
  })

  // GET /projects/:name/ga/ai-referral-daily
  //
  // The per-date, per-source AI session series. Reads the same raw rows the
  // traffic totals read and folds them through the same
  // `resolveWinningDimensions` primitive, so this series and the AI cards on
  // /ga/traffic agree by construction: summing `days[].sessions` over a window
  // reproduces that window's `aiSessionsDeduped` exactly.
  app.get<{
    Params: { name: string }
    Querystring: { window?: string; startDate?: string; endDate?: string }
  }>('/projects/:name/ga/ai-referral-daily', async (request, _reply) => {
    const project = resolveProject(app.db, request.params.name)
    requireGa4Connection(opts, project.name, project.canonicalDomain)

    const range = resolveDateRange(request.query)
    const conditions = [eq(gaAiReferrals.projectId, project.id), ...dateRangeConditions(gaAiReferrals.date, range)]

    // Deliberately unaggregated in SQL. Landing pages must be summed inside a
    // dimension and dimensions must not be summed at all, which is not a single
    // GROUP BY, so the raw rows go to the shared aggregator.
    //
    // `users` is deliberately not selected. GA counts users DISTINCT at the
    // grain it was asked for, so this table's user column does not sum across
    // landing pages, sources, or dates, and no un-dimensioned AI-referral fetch
    // exists to get a true one. This series reports sessions only.
    const rows = app.db
      .select({
        date: gaAiReferrals.date,
        source: gaAiReferrals.source,
        medium: gaAiReferrals.medium,
        trafficClass: gaAiReferrals.trafficClass,
        sourceDimension: gaAiReferrals.sourceDimension,
        channelGroup: gaAiReferrals.channelGroup,
        sessions: gaAiReferrals.sessions,
      })
      .from(gaAiReferrals)
      .where(and(...conditions))
      .all()

    return buildAiReferralDailySeries(rows)
  })

  // GET /projects/:name/ga/social-referral-history
  app.get<{
    Params: { name: string }
    Querystring: { window?: string; startDate?: string; endDate?: string }
  }>('/projects/:name/ga/social-referral-history', async (request, _reply) => {
    const project = resolveProject(app.db, request.params.name)
    requireGa4Connection(opts, project.name, project.canonicalDomain)

    const range = resolveDateRange(request.query)
    const conditions = [eq(gaSocialReferrals.projectId, project.id), ...dateRangeConditions(gaSocialReferrals.date, range)]

    const rows = app.db
      .select({
        date: gaSocialReferrals.date,
        source: gaSocialReferrals.source,
        medium: gaSocialReferrals.medium,
        channelGroup: gaSocialReferrals.channelGroup,
        sessions: gaSocialReferrals.sessions,
        users: gaSocialReferrals.users,
      })
      .from(gaSocialReferrals)
      .where(and(...conditions))
      .orderBy(gaSocialReferrals.date)
      .all()

    return rows
  })

  // GET /projects/:name/ga/social-referral-trend
  app.get<{
    Params: { name: string }
  }>('/projects/:name/ga/social-referral-trend', async (request, _reply) => {
    const project = resolveProject(app.db, request.params.name)
    requireGa4Connection(opts, project.name, project.canonicalDomain)

    const today = new Date()
    const fmt = (d: Date) => d.toISOString().split('T')[0]!
    const daysAgo = (n: number) => { const d = new Date(today); d.setDate(d.getDate() - n); return fmt(d) }

    const sumSocial = (from: string, to: string) => app.db
      .select({ sessions: sql<number>`COALESCE(SUM(${gaSocialReferrals.sessions}), 0)` })
      .from(gaSocialReferrals)
      .where(and(
        eq(gaSocialReferrals.projectId, project.id),
        sql`${gaSocialReferrals.date} >= ${from}`,
        sql`${gaSocialReferrals.date} < ${to}`,
      ))
      .get()

    const current7d = sumSocial(daysAgo(7), fmt(today))
    const prev7d = sumSocial(daysAgo(14), daysAgo(7))
    const current30d = sumSocial(daysAgo(30), fmt(today))
    const prev30d = sumSocial(daysAgo(60), daysAgo(30))

    // Biggest mover: the source whose sessions changed most, in either
    // direction, 7d vs prev 7d. See `findBiggestMover`.
    const sourceCurrent = app.db
      .select({
        source: gaSocialReferrals.source,
        sessions: sql<number>`SUM(${gaSocialReferrals.sessions})`,
      })
      .from(gaSocialReferrals)
      .where(and(
        eq(gaSocialReferrals.projectId, project.id),
        sql`${gaSocialReferrals.date} >= ${daysAgo(7)}`,
        sql`${gaSocialReferrals.date} < ${fmt(today)}`,
      ))
      .groupBy(gaSocialReferrals.source)
      .all()

    const sourcePrev = app.db
      .select({
        source: gaSocialReferrals.source,
        sessions: sql<number>`SUM(${gaSocialReferrals.sessions})`,
      })
      .from(gaSocialReferrals)
      .where(and(
        eq(gaSocialReferrals.projectId, project.id),
        sql`${gaSocialReferrals.date} >= ${daysAgo(14)}`,
        sql`${gaSocialReferrals.date} < ${daysAgo(7)}`,
      ))
      .groupBy(gaSocialReferrals.source)
      .all()

    const response: GaSocialReferralTrendResponse = {
      socialSessions7d: current7d?.sessions ?? 0,
      socialSessionsPrev7d: prev7d?.sessions ?? 0,
      trend7dPct: deltaPercent(current7d?.sessions ?? 0, prev7d?.sessions ?? 0),
      socialSessions30d: current30d?.sessions ?? 0,
      socialSessionsPrev30d: prev30d?.sessions ?? 0,
      trend30dPct: deltaPercent(current30d?.sessions ?? 0, prev30d?.sessions ?? 0),
      biggestMover: findBiggestMover(sourceCurrent, sourcePrev),
    }
    return response
  })

  // GET /projects/:name/ga/attribution-trend
  app.get<{
    Params: { name: string }
  }>('/projects/:name/ga/attribution-trend', async (request, _reply) => {
    const project = resolveProject(app.db, request.params.name)
    requireGa4Connection(opts, project.name, project.canonicalDomain)

    const today = new Date()
    const fmt = (d: Date) => d.toISOString().split('T')[0]!
    const daysAgo = (n: number) => { const d = new Date(today); d.setDate(d.getDate() - n); return fmt(d) }
    // --- Total sessions (from gaTrafficSnapshots) ---
    const sumTotal = (from: string, to: string) => app.db
      .select({ sessions: sql<number>`COALESCE(SUM(${gaTrafficSnapshots.sessions}), 0)` })
      .from(gaTrafficSnapshots)
      .where(and(eq(gaTrafficSnapshots.projectId, project.id), sql`${gaTrafficSnapshots.date} >= ${from}`, sql`${gaTrafficSnapshots.date} < ${to}`))
      .get()

    // --- Organic sessions (from gaTrafficSnapshots) ---
    const sumOrganic = (from: string, to: string) => app.db
      .select({ sessions: sql<number>`COALESCE(SUM(${gaTrafficSnapshots.organicSessions}), 0)` })
      .from(gaTrafficSnapshots)
      .where(and(eq(gaTrafficSnapshots.projectId, project.id), sql`${gaTrafficSnapshots.date} >= ${from}`, sql`${gaTrafficSnapshots.date} < ${to}`))
      .get()

    // --- Direct sessions (from gaTrafficSnapshots.directSessions) ---
    const sumDirect = (from: string, to: string) => app.db
      .select({ sessions: sql<number>`COALESCE(SUM(${gaTrafficSnapshots.directSessions}), 0)` })
      .from(gaTrafficSnapshots)
      .where(and(eq(gaTrafficSnapshots.projectId, project.id), sql`${gaTrafficSnapshots.date} >= ${from}`, sql`${gaTrafficSnapshots.date} < ${to}`))
      .get()

    // --- AI sessions (sessionSource only, matching the disjoint Channel Breakdown cell). ---
    // Trend must use the same scope as the displayed AI count, otherwise the row can show
    // 5 sessions with a trend computed off 12 cross-dimensional sessions.
    const sumAi = (from: string, to: string) => app.db
      .select({ sessions: sql<number>`COALESCE(SUM(${gaAiReferrals.sessions}), 0)` })
      .from(gaAiReferrals)
      .where(and(
        eq(gaAiReferrals.projectId, project.id),
        sql`${gaAiReferrals.date} >= ${from}`,
        sql`${gaAiReferrals.date} < ${to}`,
        eq(gaAiReferrals.sourceDimension, 'session'),
      ))
      .get()

    // --- Social sessions ---
    const sumSocial = (from: string, to: string) => app.db
      .select({ sessions: sql<number>`COALESCE(SUM(${gaSocialReferrals.sessions}), 0)` })
      .from(gaSocialReferrals)
      .where(and(eq(gaSocialReferrals.projectId, project.id), sql`${gaSocialReferrals.date} >= ${from}`, sql`${gaSocialReferrals.date} < ${to}`))
      .get()

    const todayStr = fmt(today)

    const buildTrend = (sum: (from: string, to: string) => { sessions: number } | undefined) => {
      const c7 = sum(daysAgo(7), todayStr)?.sessions ?? 0
      const p7 = sum(daysAgo(14), daysAgo(7))?.sessions ?? 0
      const c30 = sum(daysAgo(30), todayStr)?.sessions ?? 0
      const p30 = sum(daysAgo(60), daysAgo(30))?.sessions ?? 0
      return { sessions7d: c7, sessionsPrev7d: p7, trend7dPct: deltaPercent(c7, p7), sessions30d: c30, sessionsPrev30d: p30, trend30dPct: deltaPercent(c30, p30) }
    }

    // --- Biggest movers (AI) — sessionSource-only to match the breakdown cell scope. ---
    const aiSourceCurrent = app.db
      .select({ source: gaAiReferrals.source, sessions: sql<number>`COALESCE(SUM(${gaAiReferrals.sessions}), 0)` })
      .from(gaAiReferrals)
      .where(and(
        eq(gaAiReferrals.projectId, project.id),
        sql`${gaAiReferrals.date} >= ${daysAgo(7)}`,
        sql`${gaAiReferrals.date} < ${todayStr}`,
        eq(gaAiReferrals.sourceDimension, 'session'),
      ))
      .groupBy(gaAiReferrals.source)
      .all()

    const aiSourcePrev = app.db
      .select({ source: gaAiReferrals.source, sessions: sql<number>`COALESCE(SUM(${gaAiReferrals.sessions}), 0)` })
      .from(gaAiReferrals)
      .where(and(
        eq(gaAiReferrals.projectId, project.id),
        sql`${gaAiReferrals.date} >= ${daysAgo(14)}`,
        sql`${gaAiReferrals.date} < ${daysAgo(7)}`,
        eq(gaAiReferrals.sourceDimension, 'session'),
      ))
      .groupBy(gaAiReferrals.source)
      .all()

    // --- Biggest movers (Social) ---
    const socialSourceCurrent = app.db
      .select({ source: gaSocialReferrals.source, sessions: sql<number>`SUM(${gaSocialReferrals.sessions})` })
      .from(gaSocialReferrals)
      .where(and(eq(gaSocialReferrals.projectId, project.id), sql`${gaSocialReferrals.date} >= ${daysAgo(7)}`, sql`${gaSocialReferrals.date} < ${todayStr}`))
      .groupBy(gaSocialReferrals.source)
      .all()

    const socialSourcePrev = app.db
      .select({ source: gaSocialReferrals.source, sessions: sql<number>`SUM(${gaSocialReferrals.sessions})` })
      .from(gaSocialReferrals)
      .where(and(eq(gaSocialReferrals.projectId, project.id), sql`${gaSocialReferrals.date} >= ${daysAgo(14)}`, sql`${gaSocialReferrals.date} < ${daysAgo(7)}`))
      .groupBy(gaSocialReferrals.source)
      .all()

    const response: GaAttributionTrendResponse = {
      total: buildTrend(sumTotal),
      organic: buildTrend(sumOrganic),
      ai: buildTrend(sumAi),
      social: buildTrend(sumSocial),
      direct: buildTrend(sumDirect),
      aiBiggestMover: findBiggestMover(aiSourceCurrent, aiSourcePrev),
      socialBiggestMover: findBiggestMover(socialSourceCurrent, socialSourcePrev),
    }
    return response
  })

  // GET /projects/:name/ga/session-history
  app.get<{
    Params: { name: string }
    Querystring: { window?: string; startDate?: string; endDate?: string }
  }>('/projects/:name/ga/session-history', async (request, _reply) => {
    const project = resolveProject(app.db, request.params.name)
    requireGa4Connection(opts, project.name, project.canonicalDomain)

    const range = resolveDateRange(request.query)
    const conditions = [eq(gaTrafficSnapshots.projectId, project.id), ...dateRangeConditions(gaTrafficSnapshots.date, range)]

    const rows = app.db
      .select({
        date: gaTrafficSnapshots.date,
        sessions: sql<number>`SUM(${gaTrafficSnapshots.sessions})`,
        organicSessions: sql<number>`SUM(${gaTrafficSnapshots.organicSessions})`,
        users: sql<number>`SUM(${gaTrafficSnapshots.users})`,
      })
      .from(gaTrafficSnapshots)
      .where(and(...conditions))
      .groupBy(gaTrafficSnapshots.date)
      .orderBy(gaTrafficSnapshots.date)
      .all()

    // Deduplicated per-day users, where synced. See `buildSessionHistory` for
    // why the landing-page sum cannot be trusted for this metric.
    const totalConditions = [eq(gaDailyTotals.projectId, project.id), ...dateRangeConditions(gaDailyTotals.date, range)]
    const totals = app.db
      .select({ date: gaDailyTotals.date, users: gaDailyTotals.users })
      .from(gaDailyTotals)
      .where(and(...totalConditions))
      .all()

    return buildSessionHistory(
      rows.map((r) => ({
        date: r.date,
        sessions: r.sessions ?? 0,
        organicSessions: r.organicSessions ?? 0,
        users: r.users ?? 0,
      })),
      totals,
    )
  })

  // GET /projects/:name/ga/coverage
  app.get<{
    Params: { name: string }
  }>('/projects/:name/ga/coverage', async (request, _reply) => {
    const project = resolveProject(app.db, request.params.name)
    requireGa4Connection(opts, project.name, project.canonicalDomain)

    // Group by COALESCE(normalized, raw) so click-ID-fragmented variants of
    // the same page collapse — same identity rule as /ga/traffic. Mirrored
    // here so `canonry ga coverage` and the MCP `canonry_ga_coverage` tool
    // see the same canonicalized page list as the dashboard.
    const trafficPages = app.db
      .select({
        landingPage: sql<string>`COALESCE(${gaTrafficSnapshots.landingPageNormalized}, ${gaTrafficSnapshots.landingPage})`,
        sessions: sql<number>`SUM(${gaTrafficSnapshots.sessions})`,
        organicSessions: sql<number>`SUM(${gaTrafficSnapshots.organicSessions})`,
        users: sql<number>`SUM(${gaTrafficSnapshots.users})`,
      })
      .from(gaTrafficSnapshots)
      .where(eq(gaTrafficSnapshots.projectId, project.id))
      .groupBy(sql`COALESCE(${gaTrafficSnapshots.landingPageNormalized}, ${gaTrafficSnapshots.landingPage})`)
      .orderBy(sql`SUM(${gaTrafficSnapshots.sessions}) DESC`)
      .all()

    return {
      pages: trafficPages.map((r) => ({
        landingPage: r.landingPage,
        sessions: r.sessions ?? 0,
        organicSessions: r.organicSessions ?? 0,
        users: r.users ?? 0,
      })),
    }
  })
}
