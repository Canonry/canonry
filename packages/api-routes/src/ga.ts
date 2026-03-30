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
} from '@ainyc/canonry-integration-google-analytics'

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

export interface GA4RoutesOptions {
  ga4CredentialStore?: Ga4CredentialStore
}

export async function ga4Routes(app: FastifyInstance, opts: GA4RoutesOptions) {
  function requireCredentialStore(reply: { status: (code: number) => { send: (body: unknown) => unknown } }) {
    if (opts.ga4CredentialStore) return opts.ga4CredentialStore
    const err = validationError('GA4 credential storage is not configured for this deployment')
    reply.status(err.statusCode).send(err.toJSON())
    return null
  }

  // POST /projects/:name/ga/connect
  app.post<{
    Params: { name: string }
    Body: { propertyId: string; keyJson?: string }
  }>('/projects/:name/ga/connect', async (request, reply) => {
    const store = requireCredentialStore(reply)
    if (!store) return

    const project = resolveProject(app.db, request.params.name)
    const { propertyId, keyJson } = request.body ?? {}

    if (!propertyId || typeof propertyId !== 'string') {
      const err = validationError('propertyId is required')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    let clientEmail: string
    let privateKey: string

    if (keyJson && typeof keyJson === 'string') {
      try {
        const parsed = JSON.parse(keyJson) as { client_email?: string; private_key?: string }
        if (!parsed.client_email || !parsed.private_key) {
          const err = validationError('Service account JSON must contain client_email and private_key')
          return reply.status(err.statusCode).send(err.toJSON())
        }
        clientEmail = parsed.client_email
        privateKey = parsed.private_key
      } catch {
        const err = validationError('Invalid JSON in keyJson')
        return reply.status(err.statusCode).send(err.toJSON())
      }
    } else {
      const err = validationError('keyJson is required')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    // Verify credentials by running a minimal GA4 report
    try {
      await verifyConnection(clientEmail, privateKey, propertyId)
      gaLog('info', 'connect.verified', { projectId: project.id, propertyId })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gaLog('error', 'connect.verify-failed', { projectId: project.id, propertyId, error: msg })
      const err = validationError(`Failed to verify GA4 credentials: ${msg}`)
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const now = new Date().toISOString()
    const existing = store.getConnection(project.name)

    store.upsertConnection({
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

    return {
      connected: true,
      propertyId,
      clientEmail,
    }
  })

  // DELETE /projects/:name/ga/disconnect
  app.delete<{ Params: { name: string } }>('/projects/:name/ga/disconnect', async (request, reply) => {
    const store = requireCredentialStore(reply)
    if (!store) return

    const project = resolveProject(app.db, request.params.name)

    const conn = store.getConnection(project.name)
    if (!conn) {
      const err = notFound('GA4 connection', project.name)
      return reply.status(err.statusCode).send(err.toJSON())
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

    store.deleteConnection(project.name)

    writeAuditLog(app.db, {
      projectId: project.id,
      actor: 'api',
      action: 'ga4.disconnected',
      entityType: 'ga_connection',
      entityId: conn.propertyId,
    })

    return reply.status(204).send()
  })

  // GET /projects/:name/ga/status
  app.get<{ Params: { name: string } }>('/projects/:name/ga/status', async (request, reply) => {
    const store = requireCredentialStore(reply)
    if (!store) return

    const project = resolveProject(app.db, request.params.name)

    const conn = store.getConnection(project.name)
    if (!conn) {
      return { connected: false, propertyId: null, clientEmail: null, lastSyncedAt: null }
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
      propertyId: conn.propertyId,
      clientEmail: conn.clientEmail,
      lastSyncedAt: latestSync?.syncedAt ?? null,
      createdAt: conn.createdAt,
      updatedAt: conn.updatedAt,
    }
  })

  // POST /projects/:name/ga/sync
  app.post<{
    Params: { name: string }
    Body: { days?: number }
  }>('/projects/:name/ga/sync', async (request, reply) => {
    const store = requireCredentialStore(reply)
    if (!store) return

    const project = resolveProject(app.db, request.params.name)

    const conn = store.getConnection(project.name)
    if (!conn) {
      const err = validationError('No GA4 connection found. Run "canonry ga connect <project>" first.')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const days = request.body?.days ?? 30

    let accessToken: string
    try {
      accessToken = await getAccessToken(conn.clientEmail, conn.privateKey)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gaLog('error', 'sync.auth-failed', { projectId: project.id, error: msg })
      const err = validationError(`GA4 authentication failed: ${msg}`)
      return reply.status(err.statusCode).send(err.toJSON())
    }

    let rows
    let summary
    let aiReferrals
    try {
      ;[rows, summary, aiReferrals] = await Promise.all([
        fetchTrafficByLandingPage(accessToken, conn.propertyId, days),
        fetchAggregateSummary(accessToken, conn.propertyId, days),
        fetchAiReferrals(accessToken, conn.propertyId, days),
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
      // Written even when per-page rows are empty: the property may have traffic
      // that doesn't resolve to a landing page, so aggregate totals are still valid.
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
  }>('/projects/:name/ga/traffic', async (request, reply) => {
    const store = requireCredentialStore(reply)
    if (!store) return

    const project = resolveProject(app.db, request.params.name)

    const conn = store.getConnection(project.name)
    if (!conn) {
      const err = validationError('No GA4 connection found. Run "canonry ga connect <project>" first.')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const limit = Math.max(1, Math.min(parseInt(request.query.limit ?? '50', 10) || 50, 500))

    // Pull aggregate totals from the summary table — these are true unique counts
    // (not inflated by summing non-additive metrics across per-page dimensions).
    const summary = app.db
      .select({
        totalSessions: gaTrafficSummaries.totalSessions,
        totalOrganicSessions: gaTrafficSummaries.totalOrganicSessions,
        totalUsers: gaTrafficSummaries.totalUsers,
      })
      .from(gaTrafficSummaries)
      .where(eq(gaTrafficSummaries.projectId, project.id))
      .get()

    // Top pages by session count (limited)
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

    // AI Referrals
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
  }>('/projects/:name/ga/coverage', async (request, reply) => {
    const store = requireCredentialStore(reply)
    if (!store) return

    const project = resolveProject(app.db, request.params.name)

    const conn = store.getConnection(project.name)
    if (!conn) {
      const err = validationError('No GA4 connection found. Run "canonry ga connect <project>" first.')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    // Get all unique landing pages with traffic
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
