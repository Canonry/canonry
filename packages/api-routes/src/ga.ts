import crypto from 'node:crypto'
import { eq, desc, and, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { gaTrafficSnapshots } from '@ainyc/canonry-db'
import { validationError, notFound } from '@ainyc/canonry-contracts'
import { resolveProject, writeAuditLog } from './helpers.js'
import {
  getAccessToken,
  fetchTrafficByLandingPage,
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

    // Delete traffic data along with connection
    app.db.delete(gaTrafficSnapshots)
      .where(eq(gaTrafficSnapshots.projectId, project.id))
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
      .select({ syncedAt: gaTrafficSnapshots.syncedAt })
      .from(gaTrafficSnapshots)
      .where(eq(gaTrafficSnapshots.projectId, project.id))
      .orderBy(desc(gaTrafficSnapshots.syncedAt))
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
    try {
      rows = await fetchTrafficByLandingPage(accessToken, conn.propertyId, days)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      gaLog('error', 'sync.fetch-failed', { projectId: project.id, error: msg })
      throw e
    }

    const now = new Date().toISOString()

    // Clear old data for this project in the synced date range, then insert fresh
    // Wrapped in a transaction to ensure atomicity — a crash mid-insert won't lose data
    if (rows.length > 0) {
      const dates = rows.map((r: { date: string }) => r.date)
      const minDate = dates.reduce((a: string, b: string) => (a < b ? a : b))
      const maxDate = dates.reduce((a: string, b: string) => (a > b ? a : b))

      app.db.transaction((tx) => {
        tx.delete(gaTrafficSnapshots)
          .where(
            and(
              eq(gaTrafficSnapshots.projectId, project.id),
              sql`${gaTrafficSnapshots.date} >= ${minDate}`,
              sql`${gaTrafficSnapshots.date} <= ${maxDate}`,
            ),
          )
          .run()

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
      })
    }

    gaLog('info', 'sync.complete', { projectId: project.id, rowCount: rows.length, days })

    return {
      synced: true,
      rowCount: rows.length,
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

    // Compute totals across ALL pages (not limited by the topPages cap)
    const totals = app.db
      .select({
        totalSessions: sql<number>`SUM(${gaTrafficSnapshots.sessions})`,
        totalOrganicSessions: sql<number>`SUM(${gaTrafficSnapshots.organicSessions})`,
        totalUsers: sql<number>`SUM(${gaTrafficSnapshots.users})`,
      })
      .from(gaTrafficSnapshots)
      .where(eq(gaTrafficSnapshots.projectId, project.id))
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

    const latestSync = app.db
      .select({ syncedAt: gaTrafficSnapshots.syncedAt })
      .from(gaTrafficSnapshots)
      .where(eq(gaTrafficSnapshots.projectId, project.id))
      .orderBy(desc(gaTrafficSnapshots.syncedAt))
      .limit(1)
      .get()

    return {
      totalSessions: totals?.totalSessions ?? 0,
      totalOrganicSessions: totals?.totalOrganicSessions ?? 0,
      totalUsers: totals?.totalUsers ?? 0,
      topPages: rows.map((r) => ({
        landingPage: r.landingPage,
        sessions: r.sessions ?? 0,
        organicSessions: r.organicSessions ?? 0,
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
