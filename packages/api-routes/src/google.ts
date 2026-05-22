import crypto from 'node:crypto'
import { eq, and, desc, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { gscSearchData, gscUrlInspections, gscCoverageSnapshots, gbpLocations, runs, projects } from '@ainyc/canonry-db'
import {
  validationError, notFound, normalizeProjectDomain, parseWindow, windowCutoff,
  authRequired, quotaExceeded, providerError,
  type GoogleConnectionType,
  gbpDiscoverRequestSchema, gbpLocationSelectionRequestSchema,
  type GbpLocationDto, type GbpLocationListResponse,
} from '@ainyc/canonry-contracts'
import { resolveProject, writeAuditLog } from './helpers.js'
import {
  getAuthUrl,
  exchangeCode,
  refreshAccessToken,
  listSites,
  listSitemaps,
  inspectUrl as gscInspectUrl,
  publishUrlNotification,
  GSC_SCOPE,
  INDEXING_SCOPE,
  INDEXING_API_DAILY_LIMIT,
} from '@ainyc/canonry-integration-google'
import { GA4_SCOPE } from '@ainyc/canonry-integration-google-analytics'
import {
  GBP_SCOPE,
  GbpApiError,
  listAccounts as gbpListAccounts,
  listLocations as gbpListLocations,
  formatStorefrontAddress,
} from '@ainyc/canonry-integration-google-business-profile'

/**
 * Scopes requested per connection type. Centralized so all OAuth surface
 * (connect + callback + token refresh) speaks the same language. Add new
 * connection types here, not as inline ternaries.
 */
function scopesForConnectionType(type: GoogleConnectionType): string[] {
  switch (type) {
    case 'gsc': return [GSC_SCOPE, INDEXING_SCOPE]
    case 'ga4': return [GA4_SCOPE]
    case 'gbp': return [GBP_SCOPE]
  }
}

export interface GoogleConnectionRecord {
  domain: string
  connectionType: GoogleConnectionType
  propertyId?: string | null
  sitemapUrl?: string | null
  accessToken?: string
  refreshToken?: string | null
  tokenExpiresAt?: string | null
  scopes?: string[]
  /**
   * Project ID that first established this connection. `null`/`undefined` on
   * legacy rows written before the column existed — treated as "unowned" so
   * the first new connect call can claim them. The OAuth callback refuses to
   * overwrite a row whose owner doesn't match the requesting project, and the
   * DELETE route refuses to remove one for the same reason.
   */
  createdByProjectId?: string | null
  gbpAccountName?: string | null
  createdAt: string
  updatedAt: string
}

export interface GoogleConnectionStore {
  listConnections: (domain: string) => GoogleConnectionRecord[]
  getConnection: (domain: string, connectionType: GoogleConnectionType) => GoogleConnectionRecord | undefined
  upsertConnection: (connection: GoogleConnectionRecord) => GoogleConnectionRecord
  updateConnection: (
    domain: string,
    connectionType: GoogleConnectionType,
    patch: Partial<Omit<GoogleConnectionRecord, 'domain' | 'connectionType' | 'createdAt'>>,
  ) => GoogleConnectionRecord | undefined
  deleteConnection: (domain: string, connectionType: GoogleConnectionType) => boolean
}

export interface GoogleRoutesOptions {
  getGoogleAuthConfig?: () => { clientId?: string; clientSecret?: string }
  googleConnectionStore?: GoogleConnectionStore
  googleStateSecret?: string
  publicUrl?: string
  onGscSyncRequested?: (runId: string, projectId: string, opts?: { days?: number; full?: boolean }) => void
  onInspectSitemapRequested?: (runId: string, projectId: string, opts?: { sitemapUrl?: string }) => void
  /** API route prefix (default: '/api/v1') */
  routePrefix?: string
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
  connectionType: GoogleConnectionType,
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
  // State signing is the only thing keeping an attacker from forging an OAuth
  // callback that lands a connection on an account they control — there is no
  // safe "default" secret. Three states:
  //
  //   - undefined: operator hasn't wired Google at all. Skip route
  //     registration with a warning; Google endpoints respond 404, no attack
  //     surface. Cloud (apps/api) inherits this when GOOGLE_STATE_SECRET is
  //     unset — secure default.
  //
  //   - empty string OR the legacy literal 'insecure-default-secret': active
  //     misconfiguration. Throw at registration so the operator catches it at
  //     boot.
  //
  //   - any other value: register normally.
  if (opts.googleStateSecret === undefined) {
    app.log.warn(
      'googleStateSecret is not configured — Google OAuth routes will not be registered. Set GOOGLE_STATE_SECRET to enable Google integrations.',
    )
    return
  }
  if (opts.googleStateSecret === '') {
    throw new Error(
      'googleStateSecret is empty. Set a non-empty secret (e.g. `openssl rand -hex 32`) via the GOOGLE_STATE_SECRET environment variable.',
    )
  }
  if (opts.googleStateSecret === 'insecure-default-secret') {
    throw new Error(
      'googleStateSecret is set to the legacy insecure default. Generate a real secret (e.g. `openssl rand -hex 32`) and set GOOGLE_STATE_SECRET.',
    )
  }
  const stateSecret = opts.googleStateSecret

  function getAuthConfig() {
    return opts.getGoogleAuthConfig?.() ?? {}
  }

  function requireConnectionStore(): GoogleConnectionStore {
    if (opts.googleConnectionStore) return opts.googleConnectionStore
    throw validationError('Google auth storage is not configured for this deployment')
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
  }>('/projects/:name/google/connect', async (request) => {
    const { clientId: googleClientId, clientSecret: googleClientSecret } = getAuthConfig()
    if (!googleClientId || !googleClientSecret) {
      throw validationError('Google OAuth is not configured. Set Google OAuth credentials in the local Canonry config.')
    }

    const { type, propertyId, publicUrl } = request.body ?? {}
    if (!type || (type !== 'gsc' && type !== 'ga4' && type !== 'gbp')) {
      throw validationError('type must be "gsc", "ga4", or "gbp"')
    }

    const project = resolveProject(app.db, request.params.name)

    let redirectUri: string
    if (publicUrl) {
      // CLI override — user-supplied URL already includes any base path
      redirectUri = publicUrl.replace(/\/$/, '') + '/api/v1/google/callback'
    } else if (opts.publicUrl) {
      // Config-level publicUrl already includes any base path
      redirectUri = opts.publicUrl.replace(/\/$/, '') + '/api/v1/google/callback'
    } else {
      // Auto-detect from request headers — use legacy per-project URI for backward compat
      const proto = request.headers['x-forwarded-proto'] ?? 'http'
      const host = request.headers.host ?? 'localhost:4100'
      redirectUri = `${proto}://${host}${opts.routePrefix ?? '/api/v1'}/projects/${encodeURIComponent(request.params.name)}/google/callback`
    }

    const scopes = scopesForConnectionType(type)
    // Bind the OAuth state to the *initiating project* (by id and name) in
    // addition to the domain. The callback re-validates all three so an
    // attacker can't (a) initiate OAuth from a different project name with a
    // forged state — the HMAC catches that — or (b) cause the callback to
    // attach the resulting tokens to a project they don't own. See the
    // takeover-prevention comment in `handleOAuthCallback`.
    const stateEncoded = buildSignedState(
      {
        projectId: project.id,
        projectName: project.name,
        domain: project.canonicalDomain,
        type,
        propertyId,
        redirectUri,
      },
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

    const store = requireConnectionStore()

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
              <li>Under "Authorized redirect URIs", add:<br><code style="background:#1e1e1e;color:#e0e0e0;padding:4px 8px;border-radius:4px;display:inline-block;margin-top:4px">${request.query.state ? (() => { try { const s = verifySignedState(request.query.state, stateSecret); const uri = s?.redirectUri; return escapeHtml(typeof uri === 'string' ? uri : 'Could not determine URI') } catch { return 'Could not determine URI' } })() : 'Could not determine URI'}</code></li>
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

    const { domain, type, propertyId, redirectUri, projectId, projectName } = stateData as {
      domain: string
      type: string
      propertyId?: string
      redirectUri: string
      projectId?: string
      projectName?: string
    }

    // Signed states minted before `projectId` was added to the payload carry
    // no owner binding. Accepting one here would skip the ownership-mismatch
    // check below (the `projectId &&` clause short-circuits) and let the
    // upsert overwrite the existing project's `accessToken`/`refreshToken`
    // with whatever the OAuth `code` exchanged for. Since signed states
    // have no TTL, a captured pre-upgrade state would otherwise stay
    // replayable. Reject and force a fresh `/google/connect`.
    if (!projectId) {
      return reply.status(400).send('Stale OAuth state — restart the connect flow.')
    }

    // Re-resolve the initiating project at callback time and refuse the
    // attach if the project has been deleted or renamed-against-canonical
    // since the OAuth flow started. This blocks the most direct takeover
    // path — `PUT /projects/<attacker> { canonicalDomain: victim.com }` →
    // start OAuth → callback writes tokens under "victim.com" — by requiring
    // that the project ID in the signed state still maps to a project that
    // owns this canonical domain at attach time.
    const project = app.db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .get()
    if (!project) {
      return reply.status(400).send('Project no longer exists. Restart the connect flow.')
    }
    if (project.canonicalDomain.toLowerCase() !== domain.toLowerCase()) {
      return reply
        .status(400)
        .send(
          `Project "${projectName ?? project.name}" canonical domain changed since this OAuth flow started. ` +
            `Expected "${domain}", got "${project.canonicalDomain}". Restart the connect flow.`,
        )
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
    const existing = store.getConnection(domain, type as GoogleConnectionType)

    // Refuse to overwrite a connection owned by a different project. Legacy
    // rows without an owner (NULL `createdByProjectId`) are claimable; the
    // first connect to land on them sets the owner and locks future writes.
    if (existing && existing.createdByProjectId && existing.createdByProjectId !== projectId) {
      return reply
        .status(403)
        .send(
          `This domain already has a Google ${String(type).toUpperCase()} connection owned by another project. ` +
            `Disconnect it from that project first (DELETE /api/v1/projects/<owner>/google/connections/${escapeHtml(String(type))}) ` +
            `before re-connecting from "${escapeHtml(projectName ?? '')}".`,
        )
    }


    store.upsertConnection({
      domain,
      connectionType: type as GoogleConnectionType,
      propertyId: propertyId ?? existing?.propertyId ?? null,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? existing?.refreshToken ?? null,
      tokenExpiresAt: expiresAt,
      scopes: tokens.scope?.split(' ') ?? [],
      // Stamp ownership on first write; subsequent same-project re-connects
      // preserve it.
      createdByProjectId: existing?.createdByProjectId ?? projectId,
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
    const store = requireConnectionStore()

    const project = resolveProject(app.db, request.params.name)
    const type = request.params.type as GoogleConnectionType

    // Cross-project takeover defense: only the owning project (or no-owner
    // legacy rows) may disconnect. Without this, an attacker who created a
    // rogue project with the victim's canonical_domain could wipe the
    // legitimate connection and re-OAuth into the freed slot.
    const existing = store.getConnection(project.canonicalDomain, type)
    if (!existing) {
      throw notFound('Google connection', type)
    }
    if (existing.createdByProjectId && existing.createdByProjectId !== project.id) {
      throw validationError(
        `This Google ${type.toUpperCase()} connection is owned by a different project. Disconnect from the owning project instead.`,
      )
    }

    const deleted = store.deleteConnection(project.canonicalDomain, type)
    if (!deleted) {
      throw notFound('Google connection', type)
    }

    writeAuditLog(app.db, {
      projectId: project.id,
      actor: 'api',
      action: 'google.disconnected',
      entityType: 'google_connection',
      entityId: type,
    })

    return reply.status(204).send()
  })

  // GET /projects/:name/google/properties
  app.get<{ Params: { name: string } }>('/projects/:name/google/properties', async (request) => {
    const { clientId: googleClientId, clientSecret: googleClientSecret } = getAuthConfig()
    if (!googleClientId || !googleClientSecret) {
      throw validationError('Google OAuth is not configured')
    }

    const store = requireConnectionStore()

    const project = resolveProject(app.db, request.params.name)
    const { accessToken } = await getValidToken(store, project.canonicalDomain, 'gsc', googleClientId, googleClientSecret)
    const sites = await listSites(accessToken)
    return { sites }
  })

  // POST /projects/:name/google/gsc/sync
  app.post<{
    Params: { name: string }
    Body: { days?: number; full?: boolean }
  }>('/projects/:name/google/gsc/sync', async (request) => {
    const store = requireConnectionStore()

    const project = resolveProject(app.db, request.params.name)
    const conn = store.getConnection(project.canonicalDomain, 'gsc')
    if (!conn) {
      throw validationError('No GSC connection found for this domain. Run "canonry google connect" first.')
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
    Querystring: { startDate?: string; endDate?: string; query?: string; page?: string; limit?: string; offset?: string; window?: string }
  }>('/projects/:name/google/gsc/performance', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const { startDate, endDate, query, page, limit, offset } = request.query

    // Window-based filtering: when no explicit startDate is provided,
    // use the window param to compute a cutoff date.
    const cutoffDate = !startDate ? windowCutoff(parseWindow(request.query.window))?.slice(0, 10) ?? null : null

    const conditions = [eq(gscSearchData.projectId, project.id)]
    if (startDate) conditions.push(sql`${gscSearchData.date} >= ${startDate}`)
    else if (cutoffDate) conditions.push(sql`${gscSearchData.date} >= ${cutoffDate}`)
    if (endDate) conditions.push(sql`${gscSearchData.date} <= ${endDate}`)
    if (query) conditions.push(sql`${gscSearchData.query} LIKE ${'%' + query + '%'}`)
    if (page) conditions.push(sql`${gscSearchData.page} LIKE ${'%' + page + '%'}`)

    const limitVal = Math.max(parseInt(limit ?? '500', 10) || 0, 1)
    const offsetVal = Math.max(parseInt(offset ?? '0', 10) || 0, 0)

    // Always chain `.offset()` in a single expression — drizzle 0.45 on
    // better-sqlite3 silently drops `.offset()` when called separately on a
    // saved query builder (issue #470). The single-expression chain matches
    // the working pattern used in backlinks.ts.
    const rows = app.db
      .select()
      .from(gscSearchData)
      .where(and(...conditions))
      .orderBy(desc(gscSearchData.date))
      .limit(limitVal)
      .offset(offsetVal)
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

  // GET /projects/:name/google/gsc/performance/daily
  // Returns one row per date with clicks + impressions summed across every
  // (query, page, country, device) tuple in the window, plus window totals.
  // The chart and headline metrics in the dashboard render from this — never
  // recomputed from the paged /performance rows, which only cover one page.
  app.get<{
    Params: { name: string }
    Querystring: { startDate?: string; endDate?: string; window?: string }
  }>('/projects/:name/google/gsc/performance/daily', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const { startDate, endDate } = request.query
    const cutoffDate = !startDate ? windowCutoff(parseWindow(request.query.window))?.slice(0, 10) ?? null : null

    const conditions = [eq(gscSearchData.projectId, project.id)]
    if (startDate) conditions.push(sql`${gscSearchData.date} >= ${startDate}`)
    else if (cutoffDate) conditions.push(sql`${gscSearchData.date} >= ${cutoffDate}`)
    if (endDate) conditions.push(sql`${gscSearchData.date} <= ${endDate}`)

    const rows = app.db
      .select({
        date: gscSearchData.date,
        clicks: sql<number>`COALESCE(SUM(${gscSearchData.clicks}), 0)`,
        impressions: sql<number>`COALESCE(SUM(${gscSearchData.impressions}), 0)`,
      })
      .from(gscSearchData)
      .where(and(...conditions))
      .groupBy(gscSearchData.date)
      .orderBy(gscSearchData.date)
      .all()

    const daily = rows.map((r) => ({
      date: r.date,
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: r.impressions > 0 ? r.clicks / r.impressions : 0,
    }))
    const totalClicks = daily.reduce((sum, d) => sum + d.clicks, 0)
    const totalImpressions = daily.reduce((sum, d) => sum + d.impressions, 0)
    return {
      totals: {
        clicks: totalClicks,
        impressions: totalImpressions,
        ctr: totalImpressions > 0 ? totalClicks / totalImpressions : 0,
        days: daily.length,
      },
      daily,
    }
  })

  // POST /projects/:name/google/gsc/inspect
  app.post<{
    Params: { name: string }
    Body: { url: string }
  }>('/projects/:name/google/gsc/inspect', async (request) => {
    const { clientId: googleClientId, clientSecret: googleClientSecret } = getAuthConfig()
    if (!googleClientId || !googleClientSecret) {
      throw validationError('Google OAuth is not configured')
    }

    const store = requireConnectionStore()

    const project = resolveProject(app.db, request.params.name)
    const { url } = request.body ?? {}
    if (!url) {
      throw validationError('url is required')
    }

    const { accessToken, propertyId } = await getValidToken(store, project.canonicalDomain, 'gsc', googleClientId, googleClientSecret)
    if (!propertyId) {
      throw validationError('No GSC property configured for this connection')
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
      isMobileFriendly: mob?.verdict === 'PASS' ? true : mob?.verdict === 'FAIL' ? false : null,
      richResults: rich?.detectedItems?.map((d: { richResultType: string }) => d.richResultType) ?? [],
      referringUrls: idx?.referringUrls ?? [],
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
      isMobileFriendly: r.isMobileFriendly,
      richResults: r.richResults,
      referringUrls: r.referringUrls,
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

    // Normalize http:// → https:// so both variants collapse into one entry.
    // Prefer the https inspection; fall back to http if that's all we have.
    const canonicalUrl = (url: string) => url.replace(/^http:\/\//, 'https://')

    const latestByUrl = new Map<string, typeof allInspections[number]>()
    const historyByUrl = new Map<string, typeof allInspections>()
    for (const row of allInspections) {
      const key = canonicalUrl(row.url)
      const existing = latestByUrl.get(key)
      if (!existing) {
        latestByUrl.set(key, row)
      } else if (existing.url.startsWith('http://') && row.url.startsWith('https://')) {
        // Prefer the https variant even if the http one was seen first
        latestByUrl.set(key, row)
      }
      const history = historyByUrl.get(key)
      if (history) {
        history.push(row)
      } else {
        historyByUrl.set(key, [row])
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

    // The most recent coverage snapshot's createdAt records when the sync
    // last wrote data. This is distinct from lastInspectedAt — a sync that
    // re-fetched coverage but found no newly-crawled URLs still updates
    // lastSyncedAt while leaving lastInspectedAt unchanged.
    const latestSnapshot = app.db
      .select({ createdAt: gscCoverageSnapshots.createdAt })
      .from(gscCoverageSnapshots)
      .where(eq(gscCoverageSnapshots.projectId, project.id))
      .orderBy(desc(gscCoverageSnapshots.createdAt))
      .limit(1)
      .get()
    const lastSyncedAt = latestSnapshot?.createdAt ?? null

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
      isMobileFriendly: r.isMobileFriendly,
      richResults: r.richResults,
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
      lastSyncedAt,
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
        reasonBreakdown: r.reasonBreakdown,
      }))
      .reverse()
  })

  // GET /projects/:name/google/gsc/sitemaps
  app.get<{ Params: { name: string } }>('/projects/:name/google/gsc/sitemaps', async (request) => {
    const { clientId: googleClientId, clientSecret: googleClientSecret } = getAuthConfig()
    if (!googleClientId || !googleClientSecret) {
      throw validationError('Google OAuth is not configured')
    }

    const store = requireConnectionStore()

    const project = resolveProject(app.db, request.params.name)
    const { accessToken, propertyId } = await getValidToken(store, project.canonicalDomain, 'gsc', googleClientId, googleClientSecret)
    if (!propertyId) {
      throw validationError('No GSC property configured for this connection. Set one with "canonry google set-property".')
    }

    const sitemaps = await listSitemaps(accessToken, propertyId)
    return { sitemaps }
  })

  // POST /projects/:name/google/gsc/discover-sitemaps
  app.post<{ Params: { name: string } }>('/projects/:name/google/gsc/discover-sitemaps', async (request) => {
    const { clientId: googleClientId, clientSecret: googleClientSecret } = getAuthConfig()
    if (!googleClientId || !googleClientSecret) {
      throw validationError('Google OAuth is not configured')
    }

    const store = requireConnectionStore()

    const project = resolveProject(app.db, request.params.name)
    const conn = store.getConnection(project.canonicalDomain, 'gsc')
    if (!conn) {
      throw validationError('No GSC connection found for this domain. Run "canonry google connect" first.')
    }

    if (!conn.propertyId) {
      throw validationError('No GSC property configured for this connection')
    }

    const { accessToken } = await getValidToken(store, project.canonicalDomain, 'gsc', googleClientId, googleClientSecret)
    const sitemaps = await listSitemaps(accessToken, conn.propertyId)

    if (sitemaps.length === 0) {
      throw validationError('No sitemaps found for this GSC property. Submit a sitemap in Google Search Console first.')
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
  }>('/projects/:name/google/gsc/inspect-sitemap', async (request) => {
    const store = requireConnectionStore()

    const project = resolveProject(app.db, request.params.name)
    const conn = store.getConnection(project.canonicalDomain, 'gsc')
    if (!conn) {
      throw validationError('No GSC connection found for this domain. Run "canonry google connect" first.')
    }

    if (!conn.propertyId) {
      throw validationError('No GSC property configured for this connection')
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
  }>('/projects/:name/google/connections/:type/sitemap', async (request) => {
    const store = requireConnectionStore()

    const project = resolveProject(app.db, request.params.name)
    const { sitemapUrl } = request.body ?? {}
    if (!sitemapUrl || !sitemapUrl.trim()) {
      throw validationError('sitemapUrl is required')
    }

    const conn = store.updateConnection(
      project.canonicalDomain,
      request.params.type as GoogleConnectionType,
      { sitemapUrl: sitemapUrl.trim(), updatedAt: new Date().toISOString() },
    )
    if (!conn) {
      throw notFound('Google connection', request.params.type)
    }

    return { sitemapUrl: sitemapUrl.trim() }
  })

  // PUT /projects/:name/google/connections/:type/property
  app.put<{
    Params: { name: string; type: string }
    Body: { propertyId: string }
  }>('/projects/:name/google/connections/:type/property', async (request) => {
    const store = requireConnectionStore()

    const project = resolveProject(app.db, request.params.name)
    const { propertyId } = request.body ?? {}
    if (!propertyId) {
      throw validationError('propertyId is required')
    }

    const conn = store.updateConnection(
      project.canonicalDomain,
      request.params.type as GoogleConnectionType,
      { propertyId, updatedAt: new Date().toISOString() },
    )
    if (!conn) {
      throw notFound('Google connection', request.params.type)
    }

    return { propertyId }
  })

  // POST /projects/:name/google/indexing/request
  app.post<{
    Params: { name: string }
    Body: { urls: string[]; allUnindexed?: boolean }
  }>('/projects/:name/google/indexing/request', async (request) => {
    const { clientId: googleClientId, clientSecret: googleClientSecret } = getAuthConfig()
    if (!googleClientId || !googleClientSecret) {
      throw validationError('Google OAuth is not configured')
    }

    const store = requireConnectionStore()

    const project = resolveProject(app.db, request.params.name)
    const { accessToken } = await getValidToken(store, project.canonicalDomain, 'gsc', googleClientId, googleClientSecret)

    let urlsToNotify: string[] = request.body?.urls ?? []

    if (request.body?.allUnindexed) {
      // Gather all not-indexed URLs from latest inspections
      const allInspections = app.db
        .select()
        .from(gscUrlInspections)
        .where(eq(gscUrlInspections.projectId, project.id))
        .orderBy(desc(gscUrlInspections.inspectedAt))
        .all()

      const latestByUrl = new Map<string, typeof allInspections[number]>()
      for (const row of allInspections) {
        if (!latestByUrl.has(row.url)) {
          latestByUrl.set(row.url, row)
        }
      }

      const unindexedUrls: string[] = []
      for (const [url, row] of latestByUrl) {
        if (row.indexingState !== 'INDEXING_ALLOWED') {
          unindexedUrls.push(url)
        }
      }

      if (unindexedUrls.length === 0) {
        throw validationError('No unindexed URLs found. Run "canonry google inspect-sitemap" first.')
      }

      urlsToNotify = unindexedUrls
    }

    if (urlsToNotify.length === 0) {
      throw validationError('At least one URL is required (or use allUnindexed: true)')
    }

    if (urlsToNotify.length > INDEXING_API_DAILY_LIMIT) {
      throw validationError(`Cannot request indexing for more than ${INDEXING_API_DAILY_LIMIT} URLs per request (got ${urlsToNotify.length})`)
    }

    // Validate that all URLs belong to the project's canonical domain
    const projectDomain = normalizeProjectDomain(project.canonicalDomain)
    const invalidUrls = urlsToNotify.filter((url) => {
      try {
        const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '')
        return hostname !== projectDomain
      } catch {
        return true
      }
    })
    if (invalidUrls.length > 0) {
      throw validationError(
        `URLs must belong to project domain "${project.canonicalDomain}". Invalid: ${invalidUrls.slice(0, 5).join(', ')}`,
      )
    }

    const results: Array<{
      url: string
      type: string
      notifiedAt: string
      status: 'success' | 'error'
      error?: string
    }> = []

    for (const url of urlsToNotify) {
      try {
        const response = await publishUrlNotification(accessToken, url, 'URL_UPDATED')
        const notifyTime = response.urlNotificationMetadata?.latestUpdate?.notifyTime ?? new Date().toISOString()
        results.push({
          url,
          type: 'URL_UPDATED',
          notifiedAt: notifyTime,
          status: 'success',
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        results.push({
          url,
          type: 'URL_UPDATED',
          notifiedAt: new Date().toISOString(),
          status: 'error',
          error: msg,
        })
      }
    }

    const succeeded = results.filter((r) => r.status === 'success').length
    const failed = results.filter((r) => r.status === 'error').length

    return {
      summary: { total: results.length, succeeded, failed },
      results,
    }
  })

  // ---------------------------------------------------------------------------
  // Google Business Profile — Phase 1 (auth + discovery)
  // ---------------------------------------------------------------------------

  /**
   * Map a `GbpApiError` to the most appropriate `AppError`. The error's
   * structured `reason` field distinguishes scope problems from the 0-QPM
   * access-form gate so the CLI/UI can show a tailored message.
   */
  function gbpErrorToAppError(err: GbpApiError, context: string) {
    if (err.reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT') {
      return validationError(
        `${context}: OAuth token is missing the business.manage scope. Reconnect with "canonry gbp connect".`,
      )
    }
    if (err.reason === 'RATE_LIMIT_EXCEEDED' || /quota/i.test(err.message)) {
      // `quotaLimitValue === 0` is the access-form gate — the project has
      // not been approved by Google yet. Any other value (typically 300)
      // means an approved project briefly exceeded its per-minute cap;
      // gbpFetchGet already retries those with exponential backoff per
      // Google's guidance, so seeing one here means the retries exhausted.
      if (err.quotaLimitValue === 0) {
        return quotaExceeded(
          'Google Business Profile API (0 QPM — access form pending approval). See https://support.google.com/business/contact/api_default',
        )
      }
      return quotaExceeded(
        `Google Business Profile API rate limit exceeded${err.quotaLimitValue ? ` (${err.quotaLimitValue} QPM cap)` : ''}. Retries exhausted; try again shortly.`,
      )
    }
    if (err.reason === 'API_DISABLED' || err.reason === 'CONSUMER_INVALID') {
      return providerError(
        `${context}: required Business Profile API is not enabled on the configured GCP project.`,
        { reason: err.reason, body: err.body },
      )
    }
    if (err.status === 401) return authRequired()
    return providerError(`${context}: ${err.message}`, { reason: err.reason ?? undefined, status: err.status })
  }

  function rowToDto(row: typeof gbpLocations.$inferSelect): GbpLocationDto {
    return {
      id: row.id,
      projectId: row.projectId,
      accountName: row.accountName,
      locationName: row.locationName,
      displayName: row.displayName,
      primaryCategoryDisplayName: row.primaryCategoryDisplayName ?? null,
      storefrontAddress: row.storefrontAddress ?? null,
      websiteUri: row.websiteUri ?? null,
      selected: Boolean(row.selected),
      syncedAt: row.syncedAt ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }

  function listSelectionResponse(projectId: string): GbpLocationListResponse {
    const rows = app.db.select().from(gbpLocations).where(eq(gbpLocations.projectId, projectId)).all()
    const dtos = rows.map(rowToDto)
    return {
      locations: dtos,
      totalDiscovered: dtos.length,
      totalSelected: dtos.filter((d) => d.selected).length,
    }
  }

  // POST /projects/:name/gbp/locations/discover
  // Re-discover locations from Google and upsert them. New rows get
  // `selected = body.selectAllNew`. Existing rows keep their selected state.
  app.post<{
    Params: { name: string }
    Body: { selectAllNew?: boolean }
  }>('/projects/:name/gbp/locations/discover', async (request) => {
    const { clientId: googleClientId, clientSecret: googleClientSecret } = getAuthConfig()
    if (!googleClientId || !googleClientSecret) {
      throw validationError('Google OAuth is not configured')
    }
    const project = resolveProject(app.db, request.params.name)
    const store = requireConnectionStore()

    const parsed = gbpDiscoverRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      throw validationError(parsed.error.issues[0]?.message ?? 'Invalid discover request')
    }
    const { selectAllNew } = parsed.data

    const { accessToken } = await getValidToken(
      store, project.canonicalDomain, 'gbp', googleClientId, googleClientSecret,
    )

    // Resolve the account: prefer the remembered one, otherwise pick the
    // first account visible to the OAuth user.
    const conn = store.getConnection(project.canonicalDomain, 'gbp')
    let accountName = conn?.gbpAccountName ?? null
    if (!accountName) {
      let accounts
      try {
        accounts = await gbpListAccounts(accessToken)
      } catch (err) {
        if (err instanceof GbpApiError) throw gbpErrorToAppError(err, 'list accounts')
        throw err
      }
      if (accounts.length === 0) {
        throw validationError('No GBP accounts are visible to this OAuth user. Confirm the user has manager/owner access on the target Business Profile.')
      }
      accountName = accounts[0]!.name
      // Remember the account for subsequent calls.
      store.updateConnection(project.canonicalDomain, 'gbp', {
        gbpAccountName: accountName,
        updatedAt: new Date().toISOString(),
      })
    }

    let remoteLocations
    try {
      remoteLocations = await gbpListLocations(accessToken, accountName)
    } catch (err) {
      if (err instanceof GbpApiError) throw gbpErrorToAppError(err, 'list locations')
      throw err
    }

    const now = new Date().toISOString()
    app.db.transaction((tx) => {
      for (const remote of remoteLocations) {
        const existing = tx.select()
          .from(gbpLocations)
          .where(and(eq(gbpLocations.projectId, project.id), eq(gbpLocations.locationName, remote.name)))
          .get()
        if (existing) {
          tx.update(gbpLocations).set({
            accountName,
            displayName: remote.title ?? existing.displayName,
            primaryCategoryDisplayName: remote.categories?.primaryCategory?.displayName ?? null,
            storefrontAddress: formatStorefrontAddress(remote),
            websiteUri: remote.websiteUri ?? null,
            updatedAt: now,
          }).where(eq(gbpLocations.id, existing.id)).run()
        } else {
          tx.insert(gbpLocations).values({
            id: crypto.randomUUID(),
            projectId: project.id,
            accountName,
            locationName: remote.name,
            displayName: remote.title ?? remote.name,
            primaryCategoryDisplayName: remote.categories?.primaryCategory?.displayName ?? null,
            storefrontAddress: formatStorefrontAddress(remote),
            websiteUri: remote.websiteUri ?? null,
            selected: selectAllNew,
            createdAt: now,
            updatedAt: now,
          }).run()
        }
      }
      writeAuditLog(tx, {
        projectId: project.id,
        actor: 'api',
        action: 'gbp.locations.discovered',
        entityType: 'gbp_locations',
        diff: { account: accountName, count: remoteLocations.length, selectAllNew },
      })
    })

    return listSelectionResponse(project.id)
  })

  // GET /projects/:name/gbp/locations
  app.get<{
    Params: { name: string }
    Querystring: { selected?: string }
  }>('/projects/:name/gbp/locations', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const response = listSelectionResponse(project.id)
    const filter = request.query.selected
    if (filter === 'true' || filter === 'false') {
      const want = filter === 'true'
      response.locations = response.locations.filter((l) => l.selected === want)
    }
    return response
  })

  // PUT /projects/:name/gbp/locations/:locationName/selection
  // Note: locationName is "locations/{n}" which contains a slash. The CLI
  // and ApiClient URL-encode it.
  app.put<{
    Params: { name: string; locationName: string }
    Body: { selected?: boolean }
  }>('/projects/:name/gbp/locations/:locationName/selection', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const locationName = decodeURIComponent(request.params.locationName)

    const parsed = gbpLocationSelectionRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      throw validationError(parsed.error.issues[0]?.message ?? 'Invalid selection request')
    }
    const { selected } = parsed.data

    const existing = app.db.select().from(gbpLocations)
      .where(and(eq(gbpLocations.projectId, project.id), eq(gbpLocations.locationName, locationName)))
      .get()
    if (!existing) throw notFound('GBP location', locationName)

    const now = new Date().toISOString()
    app.db.transaction((tx) => {
      tx.update(gbpLocations).set({ selected, updatedAt: now }).where(eq(gbpLocations.id, existing.id)).run()
      writeAuditLog(tx, {
        projectId: project.id,
        actor: 'api',
        action: selected ? 'gbp.location.selected' : 'gbp.location.deselected',
        entityType: 'gbp_location',
        entityId: locationName,
      })
    })

    const refreshed = app.db.select().from(gbpLocations).where(eq(gbpLocations.id, existing.id)).get()!
    return rowToDto(refreshed)
  })

  // DELETE /projects/:name/gbp/connection
  // Removes the OAuth connection + all gbp_locations rows for the project.
  app.delete<{ Params: { name: string } }>('/projects/:name/gbp/connection', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const store = requireConnectionStore()

    app.db.transaction((tx) => {
      tx.delete(gbpLocations).where(eq(gbpLocations.projectId, project.id)).run()
      writeAuditLog(tx, {
        projectId: project.id,
        actor: 'api',
        action: 'gbp.disconnected',
        entityType: 'gbp_connection',
      })
    })
    store.deleteConnection(project.canonicalDomain, 'gbp')

    return reply.status(204).send()
  })

}
