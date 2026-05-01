import crypto from 'node:crypto'
import { eq, desc, and, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { gaTrafficSnapshots, gaTrafficSummaries, gaAiReferrals, gaSocialReferrals, runs } from '@ainyc/canonry-db'
import { validationError, notFound, RunKinds, RunStatuses, RunTriggers, parseWindow, windowCutoff, normalizeUrlPath } from '@ainyc/canonry-contracts'
import { resolveProject, writeAuditLog } from './helpers.js'
import {
  getAccessToken,
  fetchTrafficByLandingPage,
  fetchAggregateSummary,
  fetchAiReferrals,
  fetchSocialReferrals,
  verifyConnection,
  verifyConnectionWithToken,
} from '@ainyc/canonry-integration-google-analytics'
import type { GoogleConnectionStore } from './google.js'
import { refreshAccessToken } from '@ainyc/canonry-integration-google'

function gaLog(level: 'info' | 'warn' | 'error', action: string, ctx?: Record<string, unknown>): void {
  const entry = { ts: new Date().toISOString(), level, module: 'GA4Routes', action, ...ctx }
  const stream = level === 'error' ? process.stderr : process.stdout
  stream.write(JSON.stringify(entry) + '\n')
}

// Format a session-share as a display string. Returns "<1%" for non-zero shares
// that round below 1%, so 18 AI sessions out of 6000 reads "<1%" instead of
// "0%" — the display matches the integer pct field exactly otherwise.
//
// When the numerator is positive but the total is zero, the share is
// undefined — typically a partial-sync state where social/AI referral rows
// exist but the traffic snapshots/summary that drive the denominator have not
// been synced. We return "—" rather than "0%" so the UI doesn't claim a 0%
// share for 1.3K social sessions.
function formatSharePct(numerator: number, total: number): string {
  if (numerator > 0 && total <= 0) return '—'
  if (total <= 0 || numerator <= 0) return '0%'
  const pct = (numerator / total) * 100
  const rounded = Math.round(pct)
  if (rounded === 0) return '<1%'
  return `${rounded}%`
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
      'GA4 property ID not set. Run "canonry ga set-property <project> <propertyId>" to configure it.',
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
        const msg = e instanceof Error ? e.message : String(e)
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
      const msg = e instanceof Error ? e.message : String(e)
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

    const days = request.body?.days ?? 30
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

      // Always need summary for date range (periodStart/periodEnd), even for partial sync
      const fetches: Promise<unknown>[] = [fetchAggregateSummary(accessToken, propertyId, days)]
      if (syncTraffic) fetches.push(fetchTrafficByLandingPage(accessToken, propertyId, days))
      if (syncAi) fetches.push(fetchAiReferrals(accessToken, propertyId, days))
      if (syncSocial) fetches.push(fetchSocialReferrals(accessToken, propertyId, days))

      const results = await Promise.all(fetches)
      const summary: Awaited<ReturnType<typeof fetchAggregateSummary>> = results[0] as Awaited<ReturnType<typeof fetchAggregateSummary>>
      let idx = 1
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
              sourceDimension: row.sourceDimension,
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
        }
      })

      app.db.update(runs)
        .set({ status: RunStatuses.completed, finishedAt: now })
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
        totalUsers: summary.totalUsers,
        ...(only ? { only } : {}),
      })

      return {
        synced: true,
        rowCount: rows.length,
        aiReferralCount: aiReferrals.length,
        socialReferralCount: socialReferrals.length,
        days,
        syncedAt: now,
        ...(syncedComponents ? { syncedComponents } : {}),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
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
    Querystring: { limit?: string; days?: string; window?: string }
  }>('/projects/:name/ga/traffic', async (request, _reply) => {
    const project = resolveProject(app.db, request.params.name)
    requireGa4Connection(opts, project.name, project.canonicalDomain)

    const limit = Math.max(1, Math.min(parseInt(request.query.limit ?? '50', 10) || 50, 500))
    const window = parseWindow(request.query.window)
    const cutoff = windowCutoff(window)
    const cutoffDate = cutoff?.slice(0, 10) ?? null

    const snapshotConditions = [eq(gaTrafficSnapshots.projectId, project.id)]
    if (cutoffDate) snapshotConditions.push(sql`${gaTrafficSnapshots.date} >= ${cutoffDate}`)

    const aiConditions = [eq(gaAiReferrals.projectId, project.id)]
    if (cutoffDate) aiConditions.push(sql`${gaAiReferrals.date} >= ${cutoffDate}`)

    const socialConditions = [eq(gaSocialReferrals.projectId, project.id)]
    if (cutoffDate) socialConditions.push(sql`${gaSocialReferrals.date} >= ${cutoffDate}`)

    // When filtering by window, compute totals from snapshots instead of the
    // pre-aggregated summary (which covers the full synced range).
    const summaryRow = cutoffDate
      ? app.db
          .select({
            totalSessions: sql<number>`COALESCE(SUM(${gaTrafficSnapshots.sessions}), 0)`,
            totalOrganicSessions: sql<number>`COALESCE(SUM(${gaTrafficSnapshots.organicSessions}), 0)`,
            totalUsers: sql<number>`COALESCE(SUM(${gaTrafficSnapshots.users}), 0)`,
          })
          .from(gaTrafficSnapshots)
          .where(and(...snapshotConditions))
          .get()
      : app.db
          .select({
            totalSessions: gaTrafficSummaries.totalSessions,
            totalOrganicSessions: gaTrafficSummaries.totalOrganicSessions,
            totalUsers: gaTrafficSummaries.totalUsers,
          })
          .from(gaTrafficSummaries)
          .where(eq(gaTrafficSummaries.projectId, project.id))
          .get()

    // Direct-channel total. Always sourced from gaTrafficSnapshots since
    // gaTrafficSummaries doesn't carry a direct_sessions column. Returns
    // 0 when no rows match (e.g., a project that hasn't synced yet, or
    // legacy rows with null direct_sessions).
    const directTotalRow = app.db
      .select({
        totalDirectSessions: sql<number>`COALESCE(SUM(${gaTrafficSnapshots.directSessions}), 0)`,
      })
      .from(gaTrafficSnapshots)
      .where(and(...snapshotConditions))
      .get()

    // Always fetch period bounds from the summary table (reflects full synced range).
    const summaryMeta = app.db
      .select({
        periodStart: gaTrafficSummaries.periodStart,
        periodEnd: gaTrafficSummaries.periodEnd,
      })
      .from(gaTrafficSummaries)
      .where(eq(gaTrafficSummaries.projectId, project.id))
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

    const aiReferrals = app.db
      .select({
        source: gaAiReferrals.source,
        medium: gaAiReferrals.medium,
        sourceDimension: gaAiReferrals.sourceDimension,
        sessions: sql<number>`SUM(${gaAiReferrals.sessions})`,
        users: sql<number>`SUM(${gaAiReferrals.users})`,
      })
      .from(gaAiReferrals)
      .where(and(...aiConditions))
      .groupBy(gaAiReferrals.source, gaAiReferrals.medium, gaAiReferrals.sourceDimension)
      .orderBy(sql`SUM(${gaAiReferrals.sessions}) DESC`)
      .all()

    const aiReferralLandingPages = app.db
      .select({
        source: gaAiReferrals.source,
        medium: gaAiReferrals.medium,
        sourceDimension: gaAiReferrals.sourceDimension,
        landingPage: sql<string>`COALESCE(${gaAiReferrals.landingPageNormalized}, ${gaAiReferrals.landingPage})`,
        sessions: sql<number>`SUM(${gaAiReferrals.sessions})`,
        users: sql<number>`SUM(${gaAiReferrals.users})`,
      })
      .from(gaAiReferrals)
      .where(and(...aiConditions))
      .groupBy(
        gaAiReferrals.source,
        gaAiReferrals.medium,
        gaAiReferrals.sourceDimension,
        sql`COALESCE(${gaAiReferrals.landingPageNormalized}, ${gaAiReferrals.landingPage})`,
      )
      .orderBy(sql`SUM(${gaAiReferrals.sessions}) DESC`)
      .all()

    // Deduplicated AI totals: sessionSource, firstUserSource, and manualSource are
    // overlapping attribution lenses, not disjoint visits. To avoid double-counting,
    // first sum landing pages within each dimension, then take MAX(sessions) per
    // date+source+medium across dimensions, then sum.
    const aiDeduped = app.db
      .select({
        sessions: sql<number>`COALESCE(SUM(max_sessions), 0)`,
        users: sql<number>`COALESCE(SUM(max_users), 0)`,
      })
      .from(
        sql`(
          SELECT date, source, medium,
                 MAX(dimension_sessions) AS max_sessions,
                 MAX(dimension_users) AS max_users
          FROM (
            SELECT date, source, medium, source_dimension,
                   SUM(sessions) AS dimension_sessions,
                   SUM(users) AS dimension_users
            FROM ga_ai_referrals
            WHERE project_id = ${project.id}${cutoffDate ? sql` AND date >= ${cutoffDate}` : sql``}
            GROUP BY date, source, medium, source_dimension
          )
          GROUP BY date, source, medium
        )`
      )
      .get()

    // Session-source-only AI total: sessions whose CURRENT sessionSource matched
    // an AI engine. Disjoint from sessionDefaultChannelGrouping = 'Direct' (those
    // sessions have no source by definition), so it's safe to display alongside
    // Organic/Social/Direct in a four-channel breakdown without overlap.
    const aiBySession = app.db
      .select({
        sessions: sql<number>`COALESCE(SUM(${gaAiReferrals.sessions}), 0)`,
        users: sql<number>`COALESCE(SUM(${gaAiReferrals.users}), 0)`,
      })
      .from(gaAiReferrals)
      .where(and(...aiConditions, eq(gaAiReferrals.sourceDimension, 'session')))
      .get()

    const socialReferrals = app.db
      .select({
        source: gaSocialReferrals.source,
        medium: gaSocialReferrals.medium,
        channelGroup: gaSocialReferrals.channelGroup,
        sessions: sql<number>`SUM(${gaSocialReferrals.sessions})`,
        users: sql<number>`SUM(${gaSocialReferrals.users})`,
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
        users: sql<number>`SUM(${gaSocialReferrals.users})`,
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

    return {
      totalSessions: total,
      totalOrganicSessions: summaryRow?.totalOrganicSessions ?? 0,
      totalDirectSessions,
      totalUsers: summaryRow?.totalUsers ?? 0,
      topPages: rows.map((r) => ({
        landingPage: r.landingPage,
        sessions: r.sessions ?? 0,
        organicSessions: r.organicSessions ?? 0,
        directSessions: r.directSessions ?? 0,
        users: r.users ?? 0,
      })),
      aiReferrals: aiReferrals.map((r) => ({
        source: r.source,
        medium: r.medium,
        sourceDimension: r.sourceDimension,
        sessions: r.sessions ?? 0,
        users: r.users ?? 0,
      })),
      aiReferralLandingPages: aiReferralLandingPages.map((r) => ({
        source: r.source,
        medium: r.medium,
        sourceDimension: r.sourceDimension,
        landingPage: r.landingPage,
        sessions: r.sessions ?? 0,
        users: r.users ?? 0,
      })),
      aiSessionsDeduped: aiDeduped?.sessions ?? 0,
      aiUsersDeduped: aiDeduped?.users ?? 0,
      aiSessionsBySession: aiBySession?.sessions ?? 0,
      aiUsersBySession: aiBySession?.users ?? 0,
      socialReferrals: socialReferrals.map((r) => ({
        source: r.source,
        medium: r.medium,
        channelGroup: r.channelGroup,
        sessions: r.sessions ?? 0,
        users: r.users ?? 0,
      })),
      socialSessions: socialTotals?.sessions ?? 0,
      socialUsers: socialTotals?.users ?? 0,
      organicSharePct: total > 0 ? Math.round(((summaryRow?.totalOrganicSessions ?? 0) / total) * 100) : 0,
      aiSharePct: total > 0 ? Math.round(((aiDeduped?.sessions ?? 0) / total) * 100) : 0,
      aiSharePctBySession: total > 0 ? Math.round(((aiBySession?.sessions ?? 0) / total) * 100) : 0,
      directSharePct: total > 0 ? Math.round((totalDirectSessions / total) * 100) : 0,
      socialSharePct: total > 0 ? Math.round(((socialTotals?.sessions ?? 0) / total) * 100) : 0,
      organicSharePctDisplay: formatSharePct(summaryRow?.totalOrganicSessions ?? 0, total),
      aiSharePctDisplay: formatSharePct(aiDeduped?.sessions ?? 0, total),
      aiSharePctBySessionDisplay: formatSharePct(aiBySession?.sessions ?? 0, total),
      directSharePctDisplay: formatSharePct(totalDirectSessions, total),
      socialSharePctDisplay: formatSharePct(socialTotals?.sessions ?? 0, total),
      lastSyncedAt: latestSync?.syncedAt ?? null,
      periodStart: (() => {
        const start = cutoffDate ?? summaryMeta?.periodStart ?? null
        const end = summaryMeta?.periodEnd ?? null
        // Clamp: if the cutoff is after the last synced date, use the synced start instead
        if (start && end && start > end) return summaryMeta?.periodStart ?? null
        return start
      })(),
      periodEnd: summaryMeta?.periodEnd ?? null,
    }
  })

  // GET /projects/:name/ga/ai-referral-history
  app.get<{
    Params: { name: string }
    Querystring: { window?: string }
  }>('/projects/:name/ga/ai-referral-history', async (request, _reply) => {
    const project = resolveProject(app.db, request.params.name)
    requireGa4Connection(opts, project.name, project.canonicalDomain)

    const cutoffDate = windowCutoff(parseWindow(request.query.window))?.slice(0, 10) ?? null
    const conditions = [eq(gaAiReferrals.projectId, project.id)]
    if (cutoffDate) conditions.push(sql`${gaAiReferrals.date} >= ${cutoffDate}`)

    const rows = app.db
      .select({
        date: gaAiReferrals.date,
        source: gaAiReferrals.source,
        medium: gaAiReferrals.medium,
        landingPage: sql<string>`COALESCE(${gaAiReferrals.landingPageNormalized}, ${gaAiReferrals.landingPage})`,
        sourceDimension: gaAiReferrals.sourceDimension,
        sessions: sql<number>`SUM(${gaAiReferrals.sessions})`,
        users: sql<number>`SUM(${gaAiReferrals.users})`,
      })
      .from(gaAiReferrals)
      .where(and(...conditions))
      .groupBy(
        gaAiReferrals.date,
        gaAiReferrals.source,
        gaAiReferrals.medium,
        gaAiReferrals.sourceDimension,
        sql`COALESCE(${gaAiReferrals.landingPageNormalized}, ${gaAiReferrals.landingPage})`,
      )
      .orderBy(gaAiReferrals.date)
      .all()

    return rows
  })

  // GET /projects/:name/ga/social-referral-history
  app.get<{
    Params: { name: string }
    Querystring: { window?: string }
  }>('/projects/:name/ga/social-referral-history', async (request, _reply) => {
    const project = resolveProject(app.db, request.params.name)
    requireGa4Connection(opts, project.name, project.canonicalDomain)

    const cutoffDate = windowCutoff(parseWindow(request.query.window))?.slice(0, 10) ?? null
    const conditions = [eq(gaSocialReferrals.projectId, project.id)]
    if (cutoffDate) conditions.push(sql`${gaSocialReferrals.date} >= ${cutoffDate}`)

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

    const pct = (cur: number, prev: number) => prev === 0 ? null : Math.round(((cur - prev) / prev) * 100)

    // Biggest mover: source with largest absolute session change in 7d vs prev 7d
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

    const prevMap = new Map(sourcePrev.map((r) => [r.source, r.sessions]))
    let biggestMover: { source: string; sessions7d: number; sessionsPrev7d: number; changePct: number } | null = null
    let maxDelta = 0
    for (const row of sourceCurrent) {
      const prev = prevMap.get(row.source) ?? 0
      const delta = Math.abs(row.sessions - prev)
      if (delta > maxDelta) {
        maxDelta = delta
        biggestMover = {
          source: row.source,
          sessions7d: row.sessions,
          sessionsPrev7d: prev,
          changePct: pct(row.sessions, prev) ?? (row.sessions > 0 ? 100 : 0),
        }
      }
    }

    return {
      socialSessions7d: current7d?.sessions ?? 0,
      socialSessionsPrev7d: prev7d?.sessions ?? 0,
      trend7dPct: pct(current7d?.sessions ?? 0, prev7d?.sessions ?? 0),
      socialSessions30d: current30d?.sessions ?? 0,
      socialSessionsPrev30d: prev30d?.sessions ?? 0,
      trend30dPct: pct(current30d?.sessions ?? 0, prev30d?.sessions ?? 0),
      biggestMover,
    }
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
    const pct = (cur: number, prev: number) => prev === 0 ? null : Math.round(((cur - prev) / prev) * 100)

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
      return { sessions7d: c7, sessionsPrev7d: p7, trend7dPct: pct(c7, p7), sessions30d: c30, sessionsPrev30d: p30, trend30dPct: pct(c30, p30) }
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

    const findBiggestMover = (
      current: Array<{ source: string; sessions: number }>,
      prev: Array<{ source: string; sessions: number }>,
    ) => {
      const prevMap = new Map(prev.map((r) => [r.source, r.sessions]))
      let mover: { source: string; sessions7d: number; sessionsPrev7d: number; changePct: number } | null = null
      let maxDelta = 0
      for (const row of current) {
        const p = prevMap.get(row.source) ?? 0
        const delta = Math.abs(row.sessions - p)
        if (delta > maxDelta) {
          maxDelta = delta
          mover = { source: row.source, sessions7d: row.sessions, sessionsPrev7d: p, changePct: pct(row.sessions, p) ?? (row.sessions > 0 ? 100 : 0) }
        }
      }
      return mover
    }

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

    return {
      total: buildTrend(sumTotal),
      organic: buildTrend(sumOrganic),
      ai: buildTrend(sumAi),
      social: buildTrend(sumSocial),
      direct: buildTrend(sumDirect),
      aiBiggestMover: findBiggestMover(aiSourceCurrent, aiSourcePrev),
      socialBiggestMover: findBiggestMover(socialSourceCurrent, socialSourcePrev),
    }
  })

  // GET /projects/:name/ga/session-history
  app.get<{
    Params: { name: string }
    Querystring: { window?: string }
  }>('/projects/:name/ga/session-history', async (request, _reply) => {
    const project = resolveProject(app.db, request.params.name)
    requireGa4Connection(opts, project.name, project.canonicalDomain)

    const cutoffDate = windowCutoff(parseWindow(request.query.window))?.slice(0, 10) ?? null
    const conditions = [eq(gaTrafficSnapshots.projectId, project.id)]
    if (cutoffDate) conditions.push(sql`${gaTrafficSnapshots.date} >= ${cutoffDate}`)

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

    return rows.map((r) => ({
      date: r.date,
      sessions: r.sessions ?? 0,
      organicSessions: r.organicSessions ?? 0,
      users: r.users ?? 0,
    }))
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
