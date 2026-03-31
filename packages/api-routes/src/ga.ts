import crypto from 'node:crypto'
import { eq, desc, and, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { gaTrafficSnapshots, gaTrafficSummaries, gaAiReferrals } from '@ainyc/canonry-db'
import { validationError, notFound } from '@ainyc/canonry-contracts'
import { resolveProject, writeAuditLog } from './helpers.js'
import {
  getAccessToken,
  fetchTrafficByLandingPage,
  fetchAggregateSummary,
  fetchAiReferrals,
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

    // Delete traffic data, summaries, and AI referral rows along with the connection.
    app.db.delete(gaTrafficSnapshots)
      .where(eq(gaTrafficSnapshots.projectId, project.id))
      .run()
    app.db.delete(gaTrafficSummaries)
      .where(eq(gaTrafficSummaries.projectId, project.id))
      .run()
    app.db.delete(gaAiReferrals)
      .where(eq(gaAiReferrals.projectId, project.id))
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
  app.post<{
    Params: { name: string }
    Body: { days?: number }
  }>('/projects/:name/ga/sync', async (request, _reply) => {
    const project = resolveProject(app.db, request.params.name)

    const days = request.body?.days ?? 30

    const { accessToken, propertyId } = await resolveGa4AccessToken(opts, project.name, project.canonicalDomain)

    let rows
    let summary
    let aiReferrals
    try {
      ;[rows, summary, aiReferrals] = await Promise.all([
        fetchTrafficByLandingPage(accessToken, propertyId, days),
        fetchAggregateSummary(accessToken, propertyId, days),
        fetchAiReferrals(accessToken, propertyId, days),
      ])
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gaLog('error', 'sync.fetch-failed', { projectId: project.id, error: msg })
      throw e
    }

    const now = new Date().toISOString()

    // Clear old data for this project in the synced date range, then insert fresh
    // Wrapped in a transaction to ensure atomicity — a crash mid-insert won't lose data
    app.db.transaction((tx) => {
      tx.delete(gaTrafficSnapshots)
        .where(
          and(
            eq(gaTrafficSnapshots.projectId, project.id),
            sql`${gaTrafficSnapshots.date} >= ${summary.periodStart}`,
            sql`${gaTrafficSnapshots.date} <= ${summary.periodEnd}`,
          ),
        )
        .run()

      if (rows.length > 0) {
        for (const row of rows) {
          tx.insert(gaTrafficSnapshots).values({
            id: crypto.randomUUID(),
            projectId: project.id,
            date: row.date,
            landingPage: row.landingPage,
            sessions: row.sessions,
            organicSessions: row.organicSessions,
            users: row.users,
            syncedAt: now,
          }).run()
        }
      }

      tx.delete(gaAiReferrals)
        .where(
          and(
            eq(gaAiReferrals.projectId, project.id),
            sql`${gaAiReferrals.date} >= ${summary.periodStart}`,
            sql`${gaAiReferrals.date} <= ${summary.periodEnd}`,
          ),
        )
        .run()

      // Sync AI referrals
      if (aiReferrals.length > 0) {
        for (const row of aiReferrals) {
          tx.insert(gaAiReferrals).values({
            id: crypto.randomUUID(),
            projectId: project.id,
            date: row.date,
            source: row.source,
            medium: row.medium,
            sessions: row.sessions,
            users: row.users,
            syncedAt: now,
          }).run()
        }
      }

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
      }).run()
    })

    gaLog('info', 'sync.complete', {
      projectId: project.id,
      rowCount: rows.length,
      aiReferralCount: aiReferrals.length,
      days,
      totalUsers: summary.totalUsers,
    })

    return {
      synced: true,
      rowCount: rows.length,
      aiReferralCount: aiReferrals.length,
      days,
      syncedAt: now,
    }
  })

  // GET /projects/:name/ga/traffic
  app.get<{
    Params: { name: string }
    Querystring: { limit?: string; days?: string }
  }>('/projects/:name/ga/traffic', async (request, _reply) => {
    const project = resolveProject(app.db, request.params.name)
    requireGa4Connection(opts, project.name, project.canonicalDomain)

    const limit = Math.max(1, Math.min(parseInt(request.query.limit ?? '50', 10) || 50, 500))

    const summary = app.db
      .select({
        totalSessions: gaTrafficSummaries.totalSessions,
        totalOrganicSessions: gaTrafficSummaries.totalOrganicSessions,
        totalUsers: gaTrafficSummaries.totalUsers,
      })
      .from(gaTrafficSummaries)
      .where(eq(gaTrafficSummaries.projectId, project.id))
      .get()

    const rows = app.db
      .select({
        landingPage: gaTrafficSnapshots.landingPage,
        sessions: sql<number>`SUM(${gaTrafficSnapshots.sessions})`,
        organicSessions: sql<number>`SUM(${gaTrafficSnapshots.organicSessions})`,
        users: sql<number>`SUM(${gaTrafficSnapshots.users})`,
      })
      .from(gaTrafficSnapshots)
      .where(eq(gaTrafficSnapshots.projectId, project.id))
      .groupBy(gaTrafficSnapshots.landingPage)
      .orderBy(sql`SUM(${gaTrafficSnapshots.sessions}) DESC`)
      .limit(limit)
      .all()

    const aiReferrals = app.db
      .select({
        source: gaAiReferrals.source,
        medium: gaAiReferrals.medium,
        sessions: sql<number>`SUM(${gaAiReferrals.sessions})`,
        users: sql<number>`SUM(${gaAiReferrals.users})`,
      })
      .from(gaAiReferrals)
      .where(eq(gaAiReferrals.projectId, project.id))
      .groupBy(gaAiReferrals.source, gaAiReferrals.medium)
      .orderBy(sql`SUM(${gaAiReferrals.sessions}) DESC`)
      .all()

    const latestSync = app.db
      .select({ syncedAt: gaTrafficSummaries.syncedAt })
      .from(gaTrafficSummaries)
      .where(eq(gaTrafficSummaries.projectId, project.id))
      .orderBy(desc(gaTrafficSummaries.syncedAt))
      .limit(1)
      .get()

    return {
      totalSessions: summary?.totalSessions ?? 0,
      totalOrganicSessions: summary?.totalOrganicSessions ?? 0,
      totalUsers: summary?.totalUsers ?? 0,
      topPages: rows.map((r) => ({
        landingPage: r.landingPage,
        sessions: r.sessions ?? 0,
        organicSessions: r.organicSessions ?? 0,
        users: r.users ?? 0,
      })),
      aiReferrals: aiReferrals.map((r) => ({
        source: r.source,
        medium: r.medium,
        sessions: r.sessions ?? 0,
        users: r.users ?? 0,
      })),
      lastSyncedAt: latestSync?.syncedAt ?? null,
    }
  })

  // GET /projects/:name/ga/coverage
  app.get<{
    Params: { name: string }
  }>('/projects/:name/ga/coverage', async (request, _reply) => {
    const project = resolveProject(app.db, request.params.name)
    requireGa4Connection(opts, project.name, project.canonicalDomain)

    const trafficPages = app.db
      .select({
        landingPage: gaTrafficSnapshots.landingPage,
        sessions: sql<number>`SUM(${gaTrafficSnapshots.sessions})`,
        organicSessions: sql<number>`SUM(${gaTrafficSnapshots.organicSessions})`,
        users: sql<number>`SUM(${gaTrafficSnapshots.users})`,
      })
      .from(gaTrafficSnapshots)
      .where(eq(gaTrafficSnapshots.projectId, project.id))
      .groupBy(gaTrafficSnapshots.landingPage)
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
