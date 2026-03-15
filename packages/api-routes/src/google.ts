import crypto from 'node:crypto'
import { eq, and, desc, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { gscSearchData, gscUrlInspections, runs } from '@ainyc/canonry-db'
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

export interface GoogleConnectionRecord {
  domain: string
  connectionType: 'gsc' | 'ga4'
  propertyId?: string | null
  accessToken?: string
  refreshToken?: string | null
  tokenExpiresAt?: string | null
  scopes?: string[]
  createdAt: string
  updatedAt: string
}

export interface GoogleConnectionStore {
  listConnections: (domain: string) => GoogleConnectionRecord[]
  getConnection: (domain: string, connectionType: 'gsc' | 'ga4') => GoogleConnectionRecord | undefined
  upsertConnection: (connection: GoogleConnectionRecord) => GoogleConnectionRecord
  updateConnection: (
    domain: string,
    connectionType: 'gsc' | 'ga4',
    patch: Partial<Omit<GoogleConnectionRecord, 'domain' | 'connectionType' | 'createdAt'>>,
  ) => GoogleConnectionRecord | undefined
  deleteConnection: (domain: string, connectionType: 'gsc' | 'ga4') => boolean
}

export interface GoogleRoutesOptions {
  getGoogleAuthConfig?: () => { clientId?: string; clientSecret?: string }
  googleConnectionStore?: GoogleConnectionStore
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
  store: GoogleConnectionStore,
  domain: string,
  connectionType: 'gsc' | 'ga4',
  clientId: string,
  clientSecret: string,
): Promise<{ accessToken: string; connectionId: string; propertyId: string | null }> {
  const conn = store.getConnection(domain, connectionType)

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
    const updated = store.updateConnection(domain, connectionType, {
      accessToken: tokens.access_token,
      tokenExpiresAt: newExpiresAt,
      updatedAt: new Date().toISOString(),
    })
    return {
      accessToken: tokens.access_token,
      connectionId: `${domain}:${connectionType}`,
      propertyId: updated?.propertyId ?? conn.propertyId ?? null,
    }
  }

  return {
    accessToken: conn.accessToken,
    connectionId: `${domain}:${connectionType}`,
    propertyId: conn.propertyId ?? null,
  }
}

export async function googleRoutes(app: FastifyInstance, opts: GoogleRoutesOptions) {
  const stateSecret = opts.googleStateSecret ?? 'insecure-default-secret'

  function getAuthConfig() {
    return opts.getGoogleAuthConfig?.() ?? {}
  }

  function requireConnectionStore(reply: { status: (code: number) => { send: (body: unknown) => unknown } }) {
    if (opts.googleConnectionStore) return opts.googleConnectionStore
    const err = validationError('Google auth storage is not configured for this deployment')
    reply.status(err.statusCode).send(err.toJSON())
    return null
  }

  // GET /projects/:name/google/connections
  app.get<{ Params: { name: string } }>('/projects/:name/google/connections', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const conns = opts.googleConnectionStore?.listConnections(project.canonicalDomain) ?? []
    return conns.map((connection) => ({
      id: `${connection.domain}:${connection.connectionType}`,
      domain: connection.domain,
      connectionType: connection.connectionType,
      propertyId: connection.propertyId ?? null,
      scopes: connection.scopes ?? [],
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
    }))
  })

  // POST /projects/:name/google/connect
  app.post<{
    Params: { name: string }
    Body: { type: string; propertyId?: string }
  }>('/projects/:name/google/connect', async (request, reply) => {
    const { clientId: googleClientId, clientSecret: googleClientSecret } = getAuthConfig()
    if (!googleClientId || !googleClientSecret) {
      const err = validationError('Google OAuth is not configured. Set Google OAuth credentials in the local Canonry config.')
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
    const { clientId: googleClientId, clientSecret: googleClientSecret } = getAuthConfig()
    if (!googleClientId || !googleClientSecret) {
      return reply.status(500).send('Google OAuth not configured')
    }

    const store = requireConnectionStore(reply)
    if (!store) return

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
    const existing = store.getConnection(domain, type as 'gsc' | 'ga4')
    store.upsertConnection({
      domain,
      connectionType: type as 'gsc' | 'ga4',
      propertyId: propertyId ?? existing?.propertyId ?? null,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? existing?.refreshToken ?? null,
      tokenExpiresAt: expiresAt,
      scopes: tokens.scope?.split(' ') ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })

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
    const store = requireConnectionStore(reply)
    if (!store) return

    const project = resolveProject(app.db, request.params.name)
    const deleted = store.deleteConnection(project.canonicalDomain, request.params.type as 'gsc' | 'ga4')
    if (!deleted) {
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
    const { clientId: googleClientId, clientSecret: googleClientSecret } = getAuthConfig()
    if (!googleClientId || !googleClientSecret) {
      const err = validationError('Google OAuth is not configured')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const store = requireConnectionStore(reply)
    if (!store) return

    const project = resolveProject(app.db, request.params.name)
    const { accessToken } = await getValidToken(store, project.canonicalDomain, 'gsc', googleClientId, googleClientSecret)
    const sites = await listSites(accessToken)
    return { sites }
  })

  // POST /projects/:name/google/gsc/sync
  app.post<{
    Params: { name: string }
    Body: { days?: number; full?: boolean }
  }>('/projects/:name/google/gsc/sync', async (request, reply) => {
    const store = requireConnectionStore(reply)
    if (!store) return

    const project = resolveProject(app.db, request.params.name)
    const conn = store.getConnection(project.canonicalDomain, 'gsc')
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
    const { clientId: googleClientId, clientSecret: googleClientSecret } = getAuthConfig()
    if (!googleClientId || !googleClientSecret) {
      const err = validationError('Google OAuth is not configured')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const store = requireConnectionStore(reply)
    if (!store) return

    const project = resolveProject(app.db, request.params.name)
    const { url } = request.body ?? {}
    if (!url) {
      const err = validationError('url is required')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const { accessToken, propertyId } = await getValidToken(store, project.canonicalDomain, 'gsc', googleClientId, googleClientSecret)
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
      richResults: JSON.stringify(rich?.detectedItems?.map((d: { richResultType: string }) => d.richResultType) ?? []),
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
      richResults: rich?.detectedItems?.map((d: { richResultType: string }) => d.richResultType) ?? [],
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
    const store = requireConnectionStore(reply)
    if (!store) return

    const project = resolveProject(app.db, request.params.name)
    const { propertyId } = request.body ?? {}
    if (!propertyId) {
      const err = validationError('propertyId is required')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const conn = store.updateConnection(
      project.canonicalDomain,
      request.params.type as 'gsc' | 'ga4',
      { propertyId, updatedAt: new Date().toISOString() },
    )
    if (!conn) {
      const err = notFound('Google connection', request.params.type)
      return reply.status(err.statusCode).send(err.toJSON())
    }

    return { propertyId }
  })
}
