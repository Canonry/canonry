import crypto from 'node:crypto'
import { eq, and, desc, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { googleConnections, gscSearchData, gscUrlInspections, runs } from '@ainyc/canonry-db'
import { validationError, notFound } from '@ainyc/canonry-contracts'
import { resolveProject, writeAuditLog } from './helpers.js'
import {
  getAuthUrl,
  exchangeCode,
  refreshAccessToken,
  listSites,
  inspectUrl as gscInspectUrl,
  GSC_SCOPE,
} from '@ainyc/canonry-integration-google'

export interface GoogleRoutesOptions {
  googleClientId?: string
  googleClientSecret?: string
  googleStateSecret?: string
  onGscSyncRequested?: (runId: string, projectId: string, opts?: { days?: number; full?: boolean }) => void
}

function signState(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex')
}

function buildSignedState(data: Record<string, unknown>, secret: string): string {
  const payload = JSON.stringify(data)
  const sig = signState(payload, secret)
  return Buffer.from(JSON.stringify({ payload, sig })).toString('base64url')
}

function verifySignedState(encoded: string, secret: string): Record<string, unknown> | null {
  try {
    const { payload, sig } = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as { payload: string; sig: string }
    const expected = signState(payload, secret)
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null
    return JSON.parse(payload) as Record<string, unknown>
  } catch {
    return null
  }
}

async function getValidToken(
  app: FastifyInstance,
  domain: string,
  connectionType: string,
  clientId: string,
  clientSecret: string,
): Promise<{ accessToken: string; connectionId: string; propertyId: string | null }> {
  const conn = app.db
    .select()
    .from(googleConnections)
    .where(and(eq(googleConnections.domain, domain), eq(googleConnections.connectionType, connectionType)))
    .get()

  if (!conn) {
    throw notFound('Google connection', connectionType)
  }

  if (!conn.accessToken || !conn.refreshToken) {
    throw validationError('Google connection is incomplete — please reconnect')
  }

  const expiresAt = conn.tokenExpiresAt ? new Date(conn.tokenExpiresAt).getTime() : 0
  const fiveMinutes = 5 * 60 * 1000
  if (Date.now() > expiresAt - fiveMinutes) {
    const tokens = await refreshAccessToken(clientId, clientSecret, conn.refreshToken)
    const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    app.db
      .update(googleConnections)
      .set({
        accessToken: tokens.access_token,
        tokenExpiresAt: newExpiresAt,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(googleConnections.id, conn.id))
      .run()
    return { accessToken: tokens.access_token, connectionId: conn.id, propertyId: conn.propertyId }
  }

  return { accessToken: conn.accessToken, connectionId: conn.id, propertyId: conn.propertyId }
}

export async function googleRoutes(app: FastifyInstance, opts: GoogleRoutesOptions) {
  const { googleClientId, googleClientSecret } = opts
  const stateSecret = opts.googleStateSecret ?? 'insecure-default-secret'

  // GET /projects/:name/google/connections
  app.get<{ Params: { name: string } }>('/projects/:name/google/connections', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const conns = app.db
      .select({
        id: googleConnections.id,
        domain: googleConnections.domain,
        connectionType: googleConnections.connectionType,
        propertyId: googleConnections.propertyId,
        scopes: googleConnections.scopes,
        createdAt: googleConnections.createdAt,
        updatedAt: googleConnections.updatedAt,
      })
      .from(googleConnections)
      .where(eq(googleConnections.domain, project.canonicalDomain))
      .all()

    return conns.map((c) => ({
      ...c,
      scopes: JSON.parse(c.scopes),
    }))
  })

  // POST /projects/:name/google/connect
  app.post<{
    Params: { name: string }
    Body: { type: string; propertyId?: string }
  }>('/projects/:name/google/connect', async (request, reply) => {
    if (!googleClientId || !googleClientSecret) {
      const err = validationError('Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables.')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const { type, propertyId } = request.body ?? {}
    if (!type || (type !== 'gsc' && type !== 'ga4')) {
      const err = validationError('type must be "gsc" or "ga4"')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const project = resolveProject(app.db, request.params.name)

    const proto = request.headers['x-forwarded-proto'] ?? 'http'
    const host = request.headers.host ?? 'localhost:4100'
    const redirectUri = `${proto}://${host}/api/v1/projects/${encodeURIComponent(request.params.name)}/google/callback`

    const scopes = type === 'gsc' ? [GSC_SCOPE] : []
    const stateEncoded = buildSignedState(
      { domain: project.canonicalDomain, type, propertyId, redirectUri },
      stateSecret,
    )

    const authUrl = getAuthUrl(googleClientId, redirectUri, scopes, stateEncoded)
    return { authUrl }
  })

  // GET /projects/:name/google/callback — OAuth redirect target (excluded from auth middleware)
  app.get<{
    Params: { name: string }
    Querystring: { code?: string; state?: string; error?: string }
  }>('/projects/:name/google/callback', async (request, reply) => {
    if (!googleClientId || !googleClientSecret) {
      return reply.status(500).send('Google OAuth not configured')
    }

    const { code, state, error } = request.query
    if (error) {
      const safeError = String(error).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
      return reply.type('text/html').send(`<html><body><h2>Authorization failed</h2><p>${safeError}</p><p>You can close this tab.</p></body></html>`)
    }

    if (!code || !state) {
      return reply.status(400).send('Missing code or state parameter')
    }

    const stateData = verifySignedState(state, stateSecret)
    if (!stateData) {
      return reply.status(400).send('Invalid or tampered state parameter')
    }

    const { domain, type, propertyId, redirectUri } = stateData as {
      domain: string
      type: string
      propertyId?: string
      redirectUri: string
    }

    const tokens = await exchangeCode(googleClientId, googleClientSecret, code, redirectUri)
    const now = new Date().toISOString()
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString()

    const existing = app.db
      .select()
      .from(googleConnections)
      .where(and(eq(googleConnections.domain, domain), eq(googleConnections.connectionType, type)))
      .get()

    if (existing) {
      app.db
        .update(googleConnections)
        .set({
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token ?? existing.refreshToken,
          tokenExpiresAt: expiresAt,
          propertyId: propertyId ?? existing.propertyId,
          scopes: JSON.stringify(tokens.scope?.split(' ') ?? []),
          updatedAt: now,
        })
        .where(eq(googleConnections.id, existing.id))
        .run()
    } else {
      app.db.insert(googleConnections).values({
        id: crypto.randomUUID(),
        domain,
        connectionType: type,
        propertyId: propertyId ?? null,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? null,
        tokenExpiresAt: expiresAt,
        scopes: JSON.stringify(tokens.scope?.split(' ') ?? []),
        createdAt: now,
        updatedAt: now,
      }).run()
    }

    writeAuditLog(app.db, {
      projectId: null,
      actor: 'oauth',
      action: 'google.connected',
      entityType: 'google_connection',
      entityId: type,
      diff: { domain, type, propertyId },
    })

    return reply.type('text/html').send(
      `<html><body style="font-family:system-ui;text-align:center;padding:60px">
        <h2>Connected successfully!</h2>
        <p>Google ${type.toUpperCase()} has been linked to your domain.</p>
        <p style="color:#888">You can close this tab.</p>
      </body></html>`,
    )
  })

  // DELETE /projects/:name/google/connections/:type
  app.delete<{ Params: { name: string; type: string } }>('/projects/:name/google/connections/:type', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const deleted = app.db
      .delete(googleConnections)
      .where(and(eq(googleConnections.domain, project.canonicalDomain), eq(googleConnections.connectionType, request.params.type)))
      .run()

    if (deleted.changes === 0) {
      const err = notFound('Google connection', request.params.type)
      return reply.status(err.statusCode).send(err.toJSON())
    }

    writeAuditLog(app.db, {
      projectId: project.id,
      actor: 'api',
      action: 'google.disconnected',
      entityType: 'google_connection',
      entityId: request.params.type,
    })

    return reply.status(204).send()
  })

  // GET /projects/:name/google/properties
  app.get<{ Params: { name: string } }>('/projects/:name/google/properties', async (request, reply) => {
    if (!googleClientId || !googleClientSecret) {
      const err = validationError('Google OAuth is not configured')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const project = resolveProject(app.db, request.params.name)
    const { accessToken } = await getValidToken(app, project.canonicalDomain, 'gsc', googleClientId, googleClientSecret)
    const sites = await listSites(accessToken)
    return { sites }
  })

  // POST /projects/:name/google/gsc/sync
  app.post<{
    Params: { name: string }
    Body: { days?: number; full?: boolean }
  }>('/projects/:name/google/gsc/sync', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const conn = app.db
      .select()
      .from(googleConnections)
      .where(and(eq(googleConnections.domain, project.canonicalDomain), eq(googleConnections.connectionType, 'gsc')))
      .get()
    if (!conn) {
      const err = validationError('No GSC connection found for this domain. Run "canonry google connect" first.')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const now = new Date().toISOString()
    const runId = crypto.randomUUID()
    app.db.insert(runs).values({
      id: runId,
      projectId: project.id,
      kind: 'gsc-sync',
      status: 'queued',
      trigger: 'manual',
      createdAt: now,
    }).run()

    const { days, full } = request.body ?? {}
    if (opts.onGscSyncRequested) {
      opts.onGscSyncRequested(runId, project.id, { days, full })
    }

    const run = app.db.select().from(runs).where(eq(runs.id, runId)).get()
    return run
  })

  // GET /projects/:name/google/gsc/performance
  app.get<{
    Params: { name: string }
    Querystring: { startDate?: string; endDate?: string; query?: string; page?: string; limit?: string }
  }>('/projects/:name/google/gsc/performance', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const { startDate, endDate, query, page, limit } = request.query

    const conditions = [eq(gscSearchData.projectId, project.id)]
    if (startDate) conditions.push(sql`${gscSearchData.date} >= ${startDate}`)
    if (endDate) conditions.push(sql`${gscSearchData.date} <= ${endDate}`)
    if (query) conditions.push(sql`${gscSearchData.query} LIKE ${'%' + query + '%'}`)
    if (page) conditions.push(sql`${gscSearchData.page} LIKE ${'%' + page + '%'}`)

    const rows = app.db
      .select()
      .from(gscSearchData)
      .where(and(...conditions))
      .orderBy(desc(gscSearchData.date))
      .limit(parseInt(limit ?? '500', 10))
      .all()

    return rows.map((r) => ({
      date: r.date,
      query: r.query,
      page: r.page,
      country: r.country,
      device: r.device,
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: parseFloat(r.ctr),
      position: parseFloat(r.position),
    }))
  })

  // POST /projects/:name/google/gsc/inspect
  app.post<{
    Params: { name: string }
    Body: { url: string }
  }>('/projects/:name/google/gsc/inspect', async (request, reply) => {
    if (!googleClientId || !googleClientSecret) {
      const err = validationError('Google OAuth is not configured')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const project = resolveProject(app.db, request.params.name)
    const { url } = request.body ?? {}
    if (!url) {
      const err = validationError('url is required')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const { accessToken, propertyId } = await getValidToken(app, project.canonicalDomain, 'gsc', googleClientId, googleClientSecret)
    if (!propertyId) {
      const err = validationError('No GSC property configured for this connection')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const result = await gscInspectUrl(accessToken, url, propertyId)
    const ir = result.inspectionResult
    const idx = ir.indexStatusResult
    const mob = ir.mobileUsabilityResult
    const rich = ir.richResultsResult

    const now = new Date().toISOString()
    const id = crypto.randomUUID()

    app.db.insert(gscUrlInspections).values({
      id,
      projectId: project.id,
      syncRunId: null,
      url,
      indexingState: idx?.indexingState ?? null,
      verdict: idx?.verdict ?? null,
      coverageState: idx?.coverageState ?? null,
      pageFetchState: idx?.pageFetchState ?? null,
      robotsTxtState: idx?.robotsTxtState ?? null,
      crawlTime: idx?.lastCrawlTime ?? null,
      lastCrawlResult: idx?.crawlResult ?? null,
      isMobileFriendly: mob?.verdict === 'PASS' ? 1 : mob?.verdict === 'FAIL' ? 0 : null,
      richResults: JSON.stringify(rich?.detectedItems?.map((d) => d.richResultType) ?? []),
      referringUrls: JSON.stringify(idx?.referringUrls ?? []),
      inspectedAt: now,
      createdAt: now,
    }).run()

    return {
      id,
      url,
      indexingState: idx?.indexingState,
      verdict: idx?.verdict,
      coverageState: idx?.coverageState,
      pageFetchState: idx?.pageFetchState,
      robotsTxtState: idx?.robotsTxtState,
      crawlTime: idx?.lastCrawlTime,
      lastCrawlResult: idx?.crawlResult,
      isMobileFriendly: mob?.verdict === 'PASS',
      richResults: rich?.detectedItems?.map((d) => d.richResultType) ?? [],
      referringUrls: idx?.referringUrls ?? [],
      inspectedAt: now,
    }
  })

  // GET /projects/:name/google/gsc/inspections
  app.get<{
    Params: { name: string }
    Querystring: { url?: string; limit?: string }
  }>('/projects/:name/google/gsc/inspections', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const { url, limit } = request.query

    const conditions = [eq(gscUrlInspections.projectId, project.id)]
    if (url) conditions.push(eq(gscUrlInspections.url, url))

    const rows = app.db
      .select()
      .from(gscUrlInspections)
      .where(and(...conditions))
      .orderBy(desc(gscUrlInspections.inspectedAt))
      .limit(parseInt(limit ?? '100', 10))
      .all()

    return rows.map((r) => ({
      id: r.id,
      url: r.url,
      indexingState: r.indexingState,
      verdict: r.verdict,
      coverageState: r.coverageState,
      pageFetchState: r.pageFetchState,
      robotsTxtState: r.robotsTxtState,
      crawlTime: r.crawlTime,
      lastCrawlResult: r.lastCrawlResult,
      isMobileFriendly: r.isMobileFriendly === 1 ? true : r.isMobileFriendly === 0 ? false : null,
      richResults: JSON.parse(r.richResults),
      referringUrls: JSON.parse(r.referringUrls),
      inspectedAt: r.inspectedAt,
    }))
  })

  // GET /projects/:name/google/gsc/deindexed
  app.get<{ Params: { name: string } }>('/projects/:name/google/gsc/deindexed', async (request) => {
    const project = resolveProject(app.db, request.params.name)

    const allInspections = app.db
      .select()
      .from(gscUrlInspections)
      .where(eq(gscUrlInspections.projectId, project.id))
      .orderBy(desc(gscUrlInspections.inspectedAt))
      .all()

    const byUrl = new Map<string, typeof allInspections>()
    for (const row of allInspections) {
      const existing = byUrl.get(row.url)
      if (existing) {
        existing.push(row)
      } else {
        byUrl.set(row.url, [row])
      }
    }

    const deindexed: Array<{
      url: string
      previousState: string | null
      currentState: string | null
      transitionDate: string
    }> = []

    for (const [url, inspections] of byUrl) {
      if (inspections.length < 2) continue
      const latest = inspections[0]!
      const previous = inspections[1]!

      if (
        previous.indexingState?.toUpperCase() === 'INDEXED' &&
        latest.indexingState?.toUpperCase() !== 'INDEXED'
      ) {
        deindexed.push({
          url,
          previousState: previous.indexingState,
          currentState: latest.indexingState,
          transitionDate: latest.inspectedAt,
        })
      }
    }

    return deindexed
  })

  // PUT /projects/:name/google/connections/:type/property
  app.put<{
    Params: { name: string; type: string }
    Body: { propertyId: string }
  }>('/projects/:name/google/connections/:type/property', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const { propertyId } = request.body ?? {}
    if (!propertyId) {
      const err = validationError('propertyId is required')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const conn = app.db
      .select()
      .from(googleConnections)
      .where(and(eq(googleConnections.domain, project.canonicalDomain), eq(googleConnections.connectionType, request.params.type)))
      .get()

    if (!conn) {
      const err = notFound('Google connection', request.params.type)
      return reply.status(err.statusCode).send(err.toJSON())
    }

    app.db
      .update(googleConnections)
      .set({ propertyId, updatedAt: new Date().toISOString() })
      .where(eq(googleConnections.id, conn.id))
      .run()

    return { propertyId }
  })
}
