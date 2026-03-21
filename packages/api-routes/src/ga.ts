import crypto from 'node:crypto'
import { eq, desc, and, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { gaConnections, gaTrafficSnapshots } from '@ainyc/canonry-db'
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

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface GA4RoutesOptions {}

export async function ga4Routes(app: FastifyInstance, _opts: GA4RoutesOptions) {
  // POST /projects/:name/ga/connect
  app.post<{
    Params: { name: string }
    Body: { propertyId: string; keyFile?: string; keyJson?: string }
  }>('/projects/:name/ga/connect', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const { propertyId, keyFile, keyJson } = request.body ?? {}

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
    } else if (keyFile && typeof keyFile === 'string') {
      try {
        const fs = await import('node:fs')
        const content = fs.readFileSync(keyFile, 'utf-8')
        const parsed = JSON.parse(content) as { client_email?: string; private_key?: string }
        if (!parsed.client_email || !parsed.private_key) {
          const err = validationError('Service account JSON file must contain client_email and private_key')
          return reply.status(err.statusCode).send(err.toJSON())
        }
        clientEmail = parsed.client_email
        privateKey = parsed.private_key
      } catch (e) {
        if (e instanceof SyntaxError) {
          const err = validationError('Service account key file contains invalid JSON')
          return reply.status(err.statusCode).send(err.toJSON())
        }
        const msg = e instanceof Error ? e.message : String(e)
        const err = validationError(`Failed to read key file: ${msg}`)
        return reply.status(err.statusCode).send(err.toJSON())
      }
    } else {
      const err = validationError('Either keyJson or keyFile is required')
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
    const existing = app.db
      .select()
      .from(gaConnections)
      .where(eq(gaConnections.projectId, project.id))
      .get()

    if (existing) {
      app.db.update(gaConnections)
        .set({ propertyId, clientEmail, privateKey, updatedAt: now })
        .where(eq(gaConnections.id, existing.id))
        .run()
    } else {
      app.db.insert(gaConnections).values({
        id: crypto.randomUUID(),
        projectId: project.id,
        propertyId,
        clientEmail,
        privateKey,
        createdAt: now,
        updatedAt: now,
      }).run()
    }

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
    const project = resolveProject(app.db, request.params.name)

    const conn = app.db
      .select()
      .from(gaConnections)
      .where(eq(gaConnections.projectId, project.id))
      .get()

    if (!conn) {
      const err = notFound('GA4 connection', project.name)
      return reply.status(err.statusCode).send(err.toJSON())
    }

    // Delete traffic data along with connection
    app.db.delete(gaTrafficSnapshots)
      .where(eq(gaTrafficSnapshots.projectId, project.id))
      .run()

    app.db.delete(gaConnections)
      .where(eq(gaConnections.id, conn.id))
      .run()

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
  app.get<{ Params: { name: string } }>('/projects/:name/ga/status', async (request) => {
    const project = resolveProject(app.db, request.params.name)

    const conn = app.db
      .select()
      .from(gaConnections)
      .where(eq(gaConnections.projectId, project.id))
      .get()

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
    const project = resolveProject(app.db, request.params.name)

    const conn = app.db
      .select()
      .from(gaConnections)
      .where(eq(gaConnections.projectId, project.id))
      .get()

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
    if (rows.length > 0) {
      const dates = rows.map((r) => r.date)
      const minDate = dates.reduce((a, b) => (a < b ? a : b))
      const maxDate = dates.reduce((a, b) => (a > b ? a : b))

      app.db.delete(gaTrafficSnapshots)
        .where(
          and(
            eq(gaTrafficSnapshots.projectId, project.id),
            sql`${gaTrafficSnapshots.date} >= ${minDate}`,
            sql`${gaTrafficSnapshots.date} <= ${maxDate}`,
          ),
        )
        .run()

      for (const row of rows) {
        app.db.insert(gaTrafficSnapshots).values({
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
    const project = resolveProject(app.db, request.params.name)

    const conn = app.db
      .select()
      .from(gaConnections)
      .where(eq(gaConnections.projectId, project.id))
      .get()

    if (!conn) {
      const err = validationError('No GA4 connection found. Run "canonry ga connect <project>" first.')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const limit = Math.max(1, Math.min(parseInt(request.query.limit ?? '50', 10) || 50, 500))

    // Aggregate traffic by landing page across all dates
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

    const totalSessions = rows.reduce((sum, r) => sum + (r.sessions ?? 0), 0)
    const totalOrganicSessions = rows.reduce((sum, r) => sum + (r.organicSessions ?? 0), 0)
    const totalUsers = rows.reduce((sum, r) => sum + (r.users ?? 0), 0)

    return {
      totalSessions,
      totalOrganicSessions,
      totalUsers,
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
    const project = resolveProject(app.db, request.params.name)

    const conn = app.db
      .select()
      .from(gaConnections)
      .where(eq(gaConnections.projectId, project.id))
      .get()

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
