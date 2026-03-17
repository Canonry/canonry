import crypto from 'node:crypto'
import { eq, and, desc, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { gscSearchData, gscUrlInspections, gscCoverageSnapshots, runs } from '@ainyc/canonry-db'
import { validationError, notFound } from '@ainyc/canonry-contracts'
import { resolveProject, writeAuditLog } from './helpers.js'
import {
  getAuthUrl,
  exchangeCode,
  refreshAccessToken,
  listSites,
  listSitemaps,
  inspectUrl as gscInspectUrl,
  GSC_SCOPE,
} from '@ainyc/canonry-integration-google'

export interface GoogleConnectionRecord {
  domain: string
  connectionType: 'gsc' | 'ga4'
  propertyId?: string | null
  sitemapUrl?: string | null
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
  publicUrl?: string
  onGscSyncRequested?: (runId: string, projectId: string, opts?: { days?: number; full?: boolean }) => void
  onInspectSitemapRequested?: (runId: string, projectId: string, opts?: { sitemapUrl?: string }) => void
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
      sitemapUrl: connection.sitemapUrl ?? null,
      scopes: connection.scopes ?? [],
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
    }))
  })

  // POST /projects/:name/google/connect
  app.post<{
    Params: { name: string }
    Body: { type: string; propertyId?: string; publicUrl?: string }
  }>('/projects/:name/google/connect', async (request, reply) => {
    const { clientId: googleClientId, clientSecret: googleClientSecret } = getAuthConfig()
    if (!googleClientId || !googleClientSecret) {
      const err = validationError('Google OAuth is not configured. Set Google OAuth credentials in the local Canonry config.')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const { type, propertyId, publicUrl } = request.body ?? {}
    if (!type || (type !== 'gsc' && type !== 'ga4')) {
      const err = validationError('type must be "gsc" or "ga4"')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const project = resolveProject(app.db, request.params.name)

    let redirectUri: string
    if (publicUrl) {
      // CLI override — use the provided public URL as the base
      redirectUri = publicUrl.replace(/\/$/, '') + '/api/v1/google/callback'
    } else if (opts.publicUrl) {
      // Config-level publicUrl — use for all OAuth redirects
      redirectUri = opts.publicUrl.replace(/\/$/, '') + '/api/v1/google/callback'
    } else {
      // Auto-detect from request headers — use legacy per-project URI for backward compat
      const proto = request.headers['x-forwarded-proto'] ?? 'http'
      const host = request.headers.host ?? 'localhost:4100'
      redirectUri = `${proto}://${host}/api/v1/projects/${encodeURIComponent(request.params.name)}/google/callback`
    }

    const scopes = type === 'gsc' ? [GSC_SCOPE] : []
    const stateEncoded = buildSignedState(
      { domain: project.canonicalDomain, type, propertyId, redirectUri },
      stateSecret,
    )

    const authUrl = getAuthUrl(googleClientId, redirectUri, scopes, stateEncoded)
    return { authUrl, redirectUri }
  })

  // Shared OAuth callback handler — used by both legacy per-project and new shared routes
  async function handleOAuthCallback(
    request: { query: { code?: string; state?: string; error?: string } },
    reply: { status: (code: number) => { send: (body: unknown) => unknown }; type: (t: string) => { send: (body: string) => unknown } },
  ) {
    const { clientId: googleClientId, clientSecret: googleClientSecret } = getAuthConfig()
    if (!googleClientId || !googleClientSecret) {
      return reply.status(500).send('Google OAuth not configured')
    }

    const store = requireConnectionStore(reply)
    if (!store) return

    const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

    const { code, state, error } = request.query
    if (error) {
      const safeError = escapeHtml(String(error))
      const errorHtml = error === 'redirect_uri_mismatch'
        ? `<html><body style="font-family:system-ui;padding:40px;max-width:600px;margin:0 auto">
            <h2 style="color:#ef4444">Redirect URI mismatch</h2>
            <p>Google rejected the OAuth callback because the redirect URI is not registered.</p>
            <p><strong>To fix this:</strong></p>
            <ol>
              <li>Go to the <a href="https://console.cloud.google.com/apis/credentials" target="_blank">Google Cloud Console → Credentials</a></li>
              <li>Click your OAuth 2.0 Client ID</li>
              <li>Under "Authorized redirect URIs", add:<br><code style="background:#1e1e1e;color:#e0e0e0;padding:4px 8px;border-radius:4px;display:inline-block;margin-top:4px">${request.query.state ? (() => { try { const s = verifySignedState(request.query.state, stateSecret); return escapeHtml(String(s?.redirectUri ?? 'Could not determine URI')) } catch { return 'Could not determine URI' } })() : 'Could not determine URI'}</code></li>
              <li>Click Save, then retry the connection</li>
            </ol>
            <p style="color:#888">You can close this tab.</p>
          </body></html>`
        : `<html><body style="font-family:system-ui;text-align:center;padding:60px">
            <h2>Authorization failed</h2><p>${safeError}</p><p style="color:#888">You can close this tab.</p>
          </body></html>`
      return reply.type('text/html').send(errorHtml)
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

    let tokens
    try {
      tokens = await exchangeCode(googleClientId, googleClientSecret, code, redirectUri)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.type('text/html').send(
        `<html><body style="font-family:system-ui;padding:40px;max-width:600px;margin:0 auto">
          <h2 style="color:#ef4444">Token exchange failed</h2>
          <p>${escapeHtml(msg)}</p>
          <p><strong>Redirect URI used:</strong><br>
            <code style="background:#1e1e1e;color:#e0e0e0;padding:4px 8px;border-radius:4px">${escapeHtml(redirectUri)}</code>
          </p>
          <p>Ensure this URI is listed in your <a href="https://console.cloud.google.com/apis/credentials" target="_blank">Google Cloud Console</a> OAuth client's authorized redirect URIs.</p>
          <p style="color:#888">You can close this tab.</p>
        </body></html>`,
      )
    }

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
  }

  // GET /google/callback — shared OAuth redirect target (excluded from auth middleware)
  app.get<{
    Querystring: { code?: string; state?: string; error?: string }
  }>('/google/callback', async (request, reply) => {
    return handleOAuthCallback(request, reply)
  })

  // GET /projects/:name/google/callback — legacy per-project OAuth redirect (kept for backward compat)
  app.get<{
    Params: { name: string }
    Querystring: { code?: string; state?: string; error?: string }
  }>('/projects/:name/google/callback', async (request, reply) => {
    return handleOAuthCallback(request, reply)
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
        previous.indexingState === 'INDEXING_ALLOWED' &&
        latest.indexingState !== 'INDEXING_ALLOWED'
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

  // GET /projects/:name/google/gsc/coverage
  app.get<{ Params: { name: string } }>('/projects/:name/google/gsc/coverage', async (request) => {
    const project = resolveProject(app.db, request.params.name)

    // Get the latest inspection per URL
    const allInspections = app.db
      .select()
      .from(gscUrlInspections)
      .where(eq(gscUrlInspections.projectId, project.id))
      .orderBy(desc(gscUrlInspections.inspectedAt))
      .all()

    const latestByUrl = new Map<string, typeof allInspections[number]>()
    const historyByUrl = new Map<string, typeof allInspections>()
    for (const row of allInspections) {
      if (!latestByUrl.has(row.url)) {
        latestByUrl.set(row.url, row)
      }
      const history = historyByUrl.get(row.url)
      if (history) {
        history.push(row)
      } else {
        historyByUrl.set(row.url, [row])
      }
    }

    const indexedUrls: typeof allInspections = []
    const notIndexedUrls: typeof allInspections = []
    let lastInspectedAt: string | null = null

    for (const [, row] of latestByUrl) {
      if (row.indexingState === 'INDEXING_ALLOWED') {
        indexedUrls.push(row)
      } else {
        notIndexedUrls.push(row)
      }
      if (!lastInspectedAt || row.inspectedAt > lastInspectedAt) {
        lastInspectedAt = row.inspectedAt
      }
    }

    // Compute deindexed
    const deindexedUrls: Array<{
      url: string
      previousState: string | null
      currentState: string | null
      transitionDate: string
    }> = []
    for (const [url, history] of historyByUrl) {
      if (history.length < 2) continue
      const latest = history[0]!
      const previous = history[1]!
      if (
        previous.indexingState === 'INDEXING_ALLOWED' &&
        latest.indexingState !== 'INDEXING_ALLOWED'
      ) {
        deindexedUrls.push({
          url,
          previousState: previous.indexingState,
          currentState: latest.indexingState,
          transitionDate: latest.inspectedAt,
        })
      }
    }

    const total = latestByUrl.size
    const indexed = indexedUrls.length
    const notIndexed = notIndexedUrls.length

    const formatRow = (r: typeof allInspections[number]) => ({
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
      inspectedAt: r.inspectedAt,
    })

    // Group not-indexed by coverageState reason
    const reasonMap = new Map<string, typeof allInspections>()
    for (const row of notIndexedUrls) {
      const reason = row.coverageState ?? 'Unknown'
      const existing = reasonMap.get(reason)
      if (existing) {
        existing.push(row)
      } else {
        reasonMap.set(reason, [row])
      }
    }
    const reasonGroups = Array.from(reasonMap.entries())
      .map(([reason, urls]) => ({
        reason,
        count: urls.length,
        urls: urls.map(formatRow),
      }))
      .sort((a, b) => b.count - a.count)

    return {
      summary: {
        total,
        indexed,
        notIndexed,
        deindexed: deindexedUrls.length,
        percentage: total > 0 ? Math.round((indexed / total) * 1000) / 10 : 0,
      },
      lastInspectedAt,
      indexed: indexedUrls.map(formatRow),
      notIndexed: notIndexedUrls.map(formatRow),
      deindexed: deindexedUrls,
      reasonGroups,
    }
  })

  // GET /projects/:name/google/gsc/coverage/history
  app.get<{
    Params: { name: string }
    Querystring: { limit?: string }
  }>('/projects/:name/google/gsc/coverage/history', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const parsed = parseInt(request.query.limit ?? '90', 10)
    const limit = Number.isNaN(parsed) || parsed <= 0 ? 90 : parsed

    const rows = app.db
      .select()
      .from(gscCoverageSnapshots)
      .where(eq(gscCoverageSnapshots.projectId, project.id))
      .orderBy(desc(gscCoverageSnapshots.date))
      .limit(limit)
      .all()

    return rows
      .map((r) => ({
        date: r.date,
        indexed: r.indexed,
        notIndexed: r.notIndexed,
        reasonBreakdown: JSON.parse(r.reasonBreakdown) as Record<string, number>,
      }))
      .reverse()
  })

  // GET /projects/:name/google/gsc/sitemaps
  app.get<{ Params: { name: string } }>('/projects/:name/google/gsc/sitemaps', async (request, reply) => {
    const { clientId: googleClientId, clientSecret: googleClientSecret } = getAuthConfig()
    if (!googleClientId || !googleClientSecret) {
      const err = validationError('Google OAuth is not configured')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const store = requireConnectionStore(reply)
    if (!store) return

    const project = resolveProject(app.db, request.params.name)
    const { accessToken, propertyId } = await getValidToken(store, project.canonicalDomain, 'gsc', googleClientId, googleClientSecret)
    if (!propertyId) {
      const err = validationError('No GSC property configured for this connection. Set one with "canonry google set-property".')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const sitemaps = await listSitemaps(accessToken, propertyId)
    return { sitemaps }
  })

  // POST /projects/:name/google/gsc/discover-sitemaps
  app.post<{ Params: { name: string } }>('/projects/:name/google/gsc/discover-sitemaps', async (request, reply) => {
    const { clientId: googleClientId, clientSecret: googleClientSecret } = getAuthConfig()
    if (!googleClientId || !googleClientSecret) {
      const err = validationError('Google OAuth is not configured')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const store = requireConnectionStore(reply)
    if (!store) return

    const project = resolveProject(app.db, request.params.name)
    const conn = store.getConnection(project.canonicalDomain, 'gsc')
    if (!conn) {
      const err = validationError('No GSC connection found for this domain. Run "canonry google connect" first.')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    if (!conn.propertyId) {
      const err = validationError('No GSC property configured for this connection')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const { accessToken } = await getValidToken(store, project.canonicalDomain, 'gsc', googleClientId, googleClientSecret)
    const sitemaps = await listSitemaps(accessToken, conn.propertyId)

    if (sitemaps.length === 0) {
      const err = validationError('No sitemaps found for this GSC property. Submit a sitemap in Google Search Console first.')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    // Prefer non-index sitemaps, otherwise use the first one
    const primary = sitemaps.find((s) => !s.isSitemapsIndex) ?? sitemaps[0]!
    const sitemapUrl = primary.path

    // Store discovered sitemap URL on the connection
    store.updateConnection(project.canonicalDomain, 'gsc', {
      sitemapUrl,
      updatedAt: new Date().toISOString(),
    })

    // Queue a sitemap inspection run
    const now = new Date().toISOString()
    const runId = crypto.randomUUID()
    app.db.insert(runs).values({
      id: runId,
      projectId: project.id,
      kind: 'inspect-sitemap',
      status: 'queued',
      trigger: 'manual',
      createdAt: now,
    }).run()

    if (opts.onInspectSitemapRequested) {
      opts.onInspectSitemapRequested(runId, project.id, { sitemapUrl })
    }

    const run = app.db.select().from(runs).where(eq(runs.id, runId)).get()
    return { sitemaps, primarySitemapUrl: sitemapUrl, run }
  })

  // POST /projects/:name/google/gsc/inspect-sitemap
  app.post<{
    Params: { name: string }
    Body: { sitemapUrl?: string }
  }>('/projects/:name/google/gsc/inspect-sitemap', async (request, reply) => {
    const store = requireConnectionStore(reply)
    if (!store) return

    const project = resolveProject(app.db, request.params.name)
    const conn = store.getConnection(project.canonicalDomain, 'gsc')
    if (!conn) {
      const err = validationError('No GSC connection found for this domain. Run "canonry google connect" first.')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    if (!conn.propertyId) {
      const err = validationError('No GSC property configured for this connection')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const now = new Date().toISOString()
    const runId = crypto.randomUUID()
    app.db.insert(runs).values({
      id: runId,
      projectId: project.id,
      kind: 'inspect-sitemap',
      status: 'queued',
      trigger: 'manual',
      createdAt: now,
    }).run()

    const { sitemapUrl } = request.body ?? {}
    if (opts.onInspectSitemapRequested) {
      opts.onInspectSitemapRequested(runId, project.id, { sitemapUrl: sitemapUrl ?? undefined })
    }

    const run = app.db.select().from(runs).where(eq(runs.id, runId)).get()
    return run
  })

  // PUT /projects/:name/google/connections/:type/sitemap
  app.put<{
    Params: { name: string; type: string }
    Body: { sitemapUrl: string }
  }>('/projects/:name/google/connections/:type/sitemap', async (request, reply) => {
    const store = requireConnectionStore(reply)
    if (!store) return

    const project = resolveProject(app.db, request.params.name)
    const { sitemapUrl } = request.body ?? {}
    if (!sitemapUrl || !sitemapUrl.trim()) {
      const err = validationError('sitemapUrl is required')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const conn = store.updateConnection(
      project.canonicalDomain,
      request.params.type as 'gsc' | 'ga4',
      { sitemapUrl: sitemapUrl.trim(), updatedAt: new Date().toISOString() },
    )
    if (!conn) {
      const err = notFound('Google connection', request.params.type)
      return reply.status(err.statusCode).send(err.toJSON())
    }

    return { sitemapUrl: sitemapUrl.trim() }
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
