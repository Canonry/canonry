import crypto from 'node:crypto'
import { eq, and, desc, sql, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { gscSearchData, gscUrlInspections, gscCoverageSnapshots, gbpLocations, gbpDailyMetrics, gbpKeywordImpressions, gbpKeywordMonthly, gbpPlaceActions, gbpLodgingSnapshots, gbpAttributesSnapshots, gbpPlaceDetails, runs, projects, type DatabaseClient } from '@ainyc/canonry-db'
import {
  validationError, notFound, normalizeProjectDomain, parseWindow, windowCutoff,
  authRequired, forbidden, quotaExceeded, providerError, escapeLikePattern, AppError,
  type GoogleConnectionType,
  gbpDiscoverRequestSchema, gbpLocationSelectionRequestSchema, gbpSyncRequestSchema,
  type GbpLocationDto, type GbpLocationListResponse, type GbpAccountListResponse,
  type GbpPlaceDetailsListResponse,
} from '@ainyc/canonry-contracts'
import { extractPlaceAmenities, type PlaceDetails } from '@ainyc/canonry-integration-google-places'
import { buildGbpSummary } from './gbp-summary.js'
import { mergeGscDailyTotalsWithFallback, readGscDailyTotals } from './gsc-totals.js'
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
  GoogleApiError,
  GoogleAuthError,
} from '@ainyc/canonry-integration-google'
import { GA4_SCOPE } from '@ainyc/canonry-integration-google-analytics'
import {
  GBP_SCOPE,
  GbpApiError,
  listAccounts as gbpListAccounts,
  listLocations as gbpListLocations,
  formatStorefrontAddress,
  buildLocationProfileFields,
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
  onGbpSyncRequested?: (runId: string, projectId: string, opts?: { locationNames?: string[]; daysOfMetrics?: number; monthsOfKeywords?: number }) => void
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

/**
 * When a self-hosted operator uses their own Google OAuth client, the single
 * most common live-GSC failure is the Search Console API simply not being
 * enabled on that OAuth client's Google Cloud project. Google returns a 403
 * whose body names the GCP project number and a deep link to enable it. Detect
 * that exact shape and lift the project number + enable links into structured
 * fields so the dashboard can render a one-click "Action needed" remediation
 * (and the CLI/agents get a machine-readable `reason`). Returns null when the
 * 403 is some other forbidden (e.g. the account just lacks property access).
 */
function parseGscApiDisabled(
  message: string,
): { projectNumber: string | null; enableUrl: string; indexingApiUrl: string } | null {
  if (!/accessNotConfigured|SERVICE_DISABLED|has not been used in project|is disabled/i.test(message)) {
    return null
  }
  // Prefer the project number from Google's own enable URL; fall back to the
  // "...in project <N>..." prose. Project numbers are bare integers.
  const projectNumber = message.match(/[?&]project=(\d+)/)?.[1] ?? message.match(/project\s+(\d+)/i)?.[1] ?? null
  const base = 'https://console.developers.google.com/apis/api'
  const qs = projectNumber ? `?project=${projectNumber}` : ''
  return {
    projectNumber,
    enableUrl: `${base}/searchconsole.googleapis.com/overview${qs}`,
    indexingApiUrl: `${base}/indexing.googleapis.com/overview${qs}`,
  }
}

/**
 * Recover the upstream HTTP status from a GoogleAuthError thrown by
 * refreshAccessToken / exchangeCode. Those set `.statusCode` only for the 429
 * rate-limit case; every other failure embeds the status in the message
 * ("Token refresh failed (400): …"). We deliberately do NOT widen `.statusCode`
 * at the throw site: the global error handler (index.ts) forwards any
 * non-AppError's `.statusCode` as the HTTP response, so populating it would flip
 * the UNWRAPPED GBP/GSC endpoints from a 500 to a raw upstream 4xx — and a
 * leaked 401 would force a dashboard logout, the very bug this path prevents.
 * Reading it back out here keeps the status confined to the wrapped GSC routes.
 */
function googleAuthErrorStatus(err: GoogleAuthError): number | null {
  if (err.statusCode != null) return err.statusCode
  const match = err.message.match(/failed \((\d{3})\)/)
  return match ? Number(match[1]) : null
}

/**
 * Map a failure from a LIVE Google Search Console call into a canonry AppError.
 *
 * The GSC proxy routes (`/google/properties`, `/google/gsc/sitemaps`, …) are a
 * gateway: canonry calls Google on the operator's behalf, so a Google failure
 * is the UPSTREAM's fault, not a canonry-auth failure. The mapping is chosen so
 * the HTTP status carries the right *actionability* signal to every client:
 *
 *   - A config problem that the operator must fix and that a retry will NOT
 *     resolve (Search Console API not enabled, no property access, revoked
 *     credentials) → `forbidden` (403, FORBIDDEN). Non-retryable → CLI exit
 *     code 1 (user error). The dashboard renders these inline; it only forces
 *     logout on a genuine canonry 401, never on a FORBIDDEN carrying a provider
 *     message, so a Google permission error no longer boots the operator.
 *   - A transient upstream failure a retry MIGHT fix (rate limit, 5xx) →
 *     `quotaExceeded` (429) / `providerError` (502). Retryable → CLI exit 2.
 *
 * Crucially this NEVER returns 401: a leaked Google 401 would be
 * indistinguishable from a canonry session expiry and would log the operator
 * out. AppErrors raised before the network call (e.g. `notFound` /
 * `validationError` from `getValidToken`) are genuine canonry-side errors and
 * pass through unchanged.
 */
function gscErrorToAppError(err: unknown, context: string): AppError {
  if (err instanceof AppError) return err

  if (err instanceof GoogleApiError) {
    if (err.status === 429) {
      return quotaExceeded('Google Search Console API (rate limited; retries exhausted)')
    }
    if (err.status === 403) {
      const disabled = parseGscApiDisabled(err.message)
      if (disabled) {
        const inProject = disabled.projectNumber ? ` (project ${disabled.projectNumber})` : ''
        return forbidden(
          `${context}: the Google Search Console API is not enabled for your Google Cloud project${inProject}. `
            + `Enable the Search Console API and the Indexing API, wait ~2–5 minutes, then retry: ${disabled.enableUrl}`,
          { reason: 'gsc-api-disabled', upstreamStatus: 403, ...disabled },
        )
      }
      return forbidden(
        `${context}: the connected Google account does not have access to a verified Search Console property `
          + 'for this domain. Connect the account that owns the property.',
        { reason: 'gsc-no-property-access', upstreamStatus: 403 },
      )
    }
    if (err.status === 401) {
      return forbidden(
        `${context}: the Google connection has expired or was revoked. Reconnect Google Search Console.`,
        { reason: 'gsc-reconnect', upstreamStatus: 401 },
      )
    }
    return providerError(`${context}: ${err.message}`, { upstreamStatus: err.status })
  }

  if (err instanceof GoogleAuthError) {
    // Token exchange/refresh failed. A 4xx (typically invalid_grant on a
    // revoked refresh token) is a non-retryable reconnect signal; a 429 is a
    // rate limit; anything else is treated as a transient upstream error.
    const status = googleAuthErrorStatus(err)
    if (status === 429) return quotaExceeded('Google OAuth token refresh (rate limited)')
    if (status != null && status >= 400 && status < 500) {
      return forbidden(
        `${context}: the stored Google credentials are no longer valid (token refresh failed). `
          + 'Reconnect Google Search Console.',
        { reason: 'gsc-reconnect', upstreamStatus: status },
      )
    }
    return providerError(
      `${context}: ${err.message}. Reconnect Google Search Console if this persists.`,
      status != null ? { upstreamStatus: status } : undefined,
    )
  }

  return providerError(`${context}: ${err instanceof Error ? err.message : String(err)}`)
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
    try {
      const { accessToken } = await getValidToken(store, project.canonicalDomain, 'gsc', googleClientId, googleClientSecret)
      const sites = await listSites(accessToken)
      return { sites }
    } catch (err) {
      throw gscErrorToAppError(err, 'Failed to list Search Console properties')
    }
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
    // Escape LIKE wildcards so a literal `%`/`_` in the filter matches itself
    // instead of acting as a wildcard (a `%` filter would otherwise match every
    // row — wrong results + a needless full scan). The value is already bound.
    if (query) conditions.push(sql`${gscSearchData.query} LIKE ${'%' + escapeLikePattern(query) + '%'} ESCAPE '\\'`)
    if (page) conditions.push(sql`${gscSearchData.page} LIKE ${'%' + escapeLikePattern(page) + '%'} ESCAPE '\\'`)

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
  // Returns one row per date with the property-level clicks + impressions for
  // the window, plus window totals. Sourced from the un-dimensioned daily-totals
  // table (matches Google's property total); falls back to summing the
  // dimensioned `gsc_search_data` rows by date for projects not yet re-synced.
  // The chart and headline metrics in the dashboard render from this — never
  // recomputed from the paged /performance rows, which only cover one page.
  app.get<{
    Params: { name: string }
    Querystring: { startDate?: string; endDate?: string; window?: string }
  }>('/projects/:name/google/gsc/performance/daily', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const { startDate, endDate } = request.query
    const cutoffDate = !startDate ? windowCutoff(parseWindow(request.query.window))?.slice(0, 10) ?? null : null

    // Prefer the property-level daily totals on dates where they exist (match
    // Google's property total). Fall back to summing `gsc_search_data` for
    // missing dates so upgraded installs do not shorten longer/custom windows
    // after their first post-migration sync.
    const windowStart = startDate ?? cutoffDate ?? ''
    const windowEnd = endDate ?? '9999-12-31'
    const dailyTotals = readGscDailyTotals(app.db, project.id, windowStart, windowEnd)

    const conditions = [eq(gscSearchData.projectId, project.id)]
    if (startDate) conditions.push(sql`${gscSearchData.date} >= ${startDate}`)
    else if (cutoffDate) conditions.push(sql`${gscSearchData.date} >= ${cutoffDate}`)
    if (endDate) conditions.push(sql`${gscSearchData.date} <= ${endDate}`)

    const dimensionedRows = app.db
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

    const daily = mergeGscDailyTotalsWithFallback(
      dailyTotals,
      dimensionedRows.map((r) => ({
        date: r.date,
        clicks: r.clicks,
        impressions: r.impressions,
        position: 0,
      })),
    ).map((d) => ({
      date: d.date,
      clicks: d.clicks,
      impressions: d.impressions,
      ctr: d.impressions > 0 ? d.clicks / d.impressions : 0,
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

    let result
    try {
      const { accessToken, propertyId } = await getValidToken(store, project.canonicalDomain, 'gsc', googleClientId, googleClientSecret)
      if (!propertyId) {
        throw validationError('No GSC property configured for this connection')
      }
      result = await gscInspectUrl(accessToken, url, propertyId)
    } catch (err) {
      throw gscErrorToAppError(err, 'Failed to inspect URL in Search Console')
    }
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
    try {
      const { accessToken, propertyId } = await getValidToken(store, project.canonicalDomain, 'gsc', googleClientId, googleClientSecret)
      if (!propertyId) {
        throw validationError('No GSC property configured for this connection. Set one with "canonry google set-property".')
      }

      const sitemaps = await listSitemaps(accessToken, propertyId)
      return { sitemaps }
    } catch (err) {
      throw gscErrorToAppError(err, 'Failed to list Search Console sitemaps')
    }
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

    let sitemaps
    try {
      const { accessToken } = await getValidToken(store, project.canonicalDomain, 'gsc', googleClientId, googleClientSecret)
      sitemaps = await listSitemaps(accessToken, conn.propertyId)
    } catch (err) {
      throw gscErrorToAppError(err, 'Failed to discover Search Console sitemaps')
    }

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
      placeId: row.placeId ?? null,
      mapsUri: row.mapsUri ?? null,
      additionalCategories: row.additionalCategories ?? [],
      description: row.description ?? null,
      serviceArea: row.serviceArea ?? null,
      regularHours: row.regularHours ?? null,
      primaryPhone: row.primaryPhone ?? null,
      openStatus: row.openStatus ?? null,
      openingDate: row.openingDate ?? null,
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

  // Clear a project's entire GBP footprint inside a transaction: discovered
  // locations + every synced surface. Used by disconnect and by an account
  // switch (where the old account's data must not linger). These data tables
  // cascade only on PROJECT deletion, so they have to be cleared explicitly.
  function clearGbpProjectData(tx: Pick<DatabaseClient, 'delete'>, projectId: string): void {
    tx.delete(gbpDailyMetrics).where(eq(gbpDailyMetrics.projectId, projectId)).run()
    tx.delete(gbpKeywordImpressions).where(eq(gbpKeywordImpressions.projectId, projectId)).run()
    tx.delete(gbpKeywordMonthly).where(eq(gbpKeywordMonthly.projectId, projectId)).run()
    tx.delete(gbpPlaceActions).where(eq(gbpPlaceActions.projectId, projectId)).run()
    tx.delete(gbpLodgingSnapshots).where(eq(gbpLodgingSnapshots.projectId, projectId)).run()
    tx.delete(gbpLocations).where(eq(gbpLocations.projectId, projectId)).run()
  }

  // The account a project currently tracks, derived from its locations (they
  // all share one account under the one-account-per-project model). Null before
  // the first discover.
  function currentProjectAccount(projectId: string): string | null {
    const row = app.db.select({ accountName: gbpLocations.accountName })
      .from(gbpLocations)
      .where(eq(gbpLocations.projectId, projectId))
      .limit(1)
      .get()
    return row?.accountName ?? null
  }

  // POST /projects/:name/gbp/locations/discover
  // Re-discover locations from Google and upsert them. New rows get
  // `selected = body.selectAllNew`. Existing rows keep their selected state.
  // Account selection is per project: an explicit `accountName` discovers that
  // account's locations; omitting it reuses the account the project already
  // tracks (falling back to the first visible account on the first discover).
  // Pointing a project at a DIFFERENT account is destructive and requires
  // `switchAccount: true`.
  app.post<{
    Params: { name: string }
    Body: { selectAllNew?: boolean; accountName?: string; switchAccount?: boolean }
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
    const { selectAllNew, accountName: requestedAccount, switchAccount } = parsed.data

    const { accessToken } = await getValidToken(
      store, project.canonicalDomain, 'gbp', googleClientId, googleClientSecret,
    )

    const fetchAccounts = async () => {
      try {
        return await gbpListAccounts(accessToken)
      } catch (err) {
        if (err instanceof GbpApiError) throw gbpErrorToAppError(err, 'list accounts')
        throw err
      }
    }

    // Resolve the account this discover should target. Source of truth for a
    // project's current account is its existing locations (they all share one);
    // the connection's gbpAccountName is only a last-used cache.
    const conn = store.getConnection(project.canonicalDomain, 'gbp')
    const current = currentProjectAccount(project.id)
    let accountName: string
    if (requestedAccount) {
      // Validate the explicit account is one the OAuth user can actually see —
      // otherwise gbpListLocations would 403/404 with a less helpful message.
      const accounts = await fetchAccounts()
      if (!accounts.some((a) => a.name === requestedAccount)) {
        throw validationError(`GBP account "${requestedAccount}" is not accessible to this connection. Run "canonry gbp accounts <project>" to list available accounts.`)
      }
      accountName = requestedAccount
    } else {
      const remembered = current ?? conn?.gbpAccountName ?? null
      if (remembered) {
        accountName = remembered
      } else {
        const accounts = await fetchAccounts()
        if (accounts.length === 0) {
          throw validationError('No GBP accounts are visible to this OAuth user. Confirm the user has manager/owner access on the target Business Profile.')
        }
        accountName = accounts[0]!.name
      }
    }

    // Switching a project to a different account is destructive — it drops the
    // old account's locations + synced data. Require explicit opt-in.
    const switching = current !== null && current !== accountName
    if (switching && !switchAccount) {
      throw validationError(`This project currently tracks GBP account "${current}". Re-pointing it at "${accountName}" would replace its locations and all synced data. Pass switchAccount=true (CLI: --switch-account) to confirm, or run "canonry gbp disconnect <project>" first.`)
    }

    let remoteLocations
    try {
      remoteLocations = await gbpListLocations(accessToken, accountName)
    } catch (err) {
      if (err instanceof GbpApiError) throw gbpErrorToAppError(err, 'list locations')
      throw err
    }

    // Remember the resolved account on the connection as a last-used cache.
    store.updateConnection(project.canonicalDomain, 'gbp', {
      gbpAccountName: accountName,
      updatedAt: new Date().toISOString(),
    })

    const now = new Date().toISOString()
    app.db.transaction((tx) => {
      // On an account switch, clear the old account's footprint first so its
      // locations + synced data don't linger alongside the new account's.
      if (switching) clearGbpProjectData(tx, project.id)
      for (const remote of remoteLocations) {
        const existing = tx.select()
          .from(gbpLocations)
          .where(and(eq(gbpLocations.projectId, project.id), eq(gbpLocations.locationName, remote.name)))
          .get()
        // Owner-content profile fields (categories, description, hours, service
        // area, phone, open state), derived once and applied to both branches.
        const profile = buildLocationProfileFields(remote)
        if (existing) {
          tx.update(gbpLocations).set({
            accountName,
            displayName: remote.title ?? existing.displayName,
            primaryCategoryDisplayName: remote.categories?.primaryCategory?.displayName ?? null,
            storefrontAddress: formatStorefrontAddress(remote),
            websiteUri: remote.websiteUri ?? null,
            placeId: remote.metadata?.placeId ?? null,
            mapsUri: remote.metadata?.mapsUri ?? null,
            ...profile,
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
            placeId: remote.metadata?.placeId ?? null,
            mapsUri: remote.metadata?.mapsUri ?? null,
            ...profile,
            selected: selectAllNew,
            createdAt: now,
            updatedAt: now,
          }).run()
        }
      }
      writeAuditLog(tx, {
        projectId: project.id,
        actor: 'api',
        action: switching ? 'gbp.account.switched' : 'gbp.locations.discovered',
        entityType: 'gbp_locations',
        diff: { account: accountName, switchedFrom: switching ? current : null, count: remoteLocations.length, selectAllNew },
      })
    })

    return listSelectionResponse(project.id)
  })

  // GET /projects/:name/gbp/accounts — accounts the OAuth user can access, so
  // the operator can pick which one a project tracks (discover --account).
  app.get<{ Params: { name: string } }>('/projects/:name/gbp/accounts', async (request) => {
    const { clientId: googleClientId, clientSecret: googleClientSecret } = getAuthConfig()
    if (!googleClientId || !googleClientSecret) {
      throw validationError('Google OAuth is not configured')
    }
    const project = resolveProject(app.db, request.params.name)
    const store = requireConnectionStore()
    const conn = store.getConnection(project.canonicalDomain, 'gbp')
    if (!conn) {
      throw validationError('No GBP connection found for this project. Run "canonry gbp connect" first.')
    }
    const { accessToken } = await getValidToken(
      store, project.canonicalDomain, 'gbp', googleClientId, googleClientSecret,
    )
    let accounts
    try {
      accounts = await gbpListAccounts(accessToken)
    } catch (err) {
      if (err instanceof GbpApiError) throw gbpErrorToAppError(err, 'list accounts')
      throw err
    }
    const response: GbpAccountListResponse = {
      accounts: accounts.map((a) => ({
        name: a.name,
        accountName: a.accountName ?? null,
        type: a.type ?? null,
        role: a.role ?? null,
      })),
      total: accounts.length,
    }
    return response
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
  // Removes the OAuth connection + every GBP row for the project: locations and
  // all synced performance data. These data tables only cascade on project
  // deletion, so disconnect must clear them explicitly — otherwise reads
  // (metrics / keywords / place-actions / lodging / summary) keep returning
  // stale data after a disconnect, and reconnecting a different account mixes
  // the old account's rows into the project-scoped aggregates.
  app.delete<{ Params: { name: string } }>('/projects/:name/gbp/connection', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const store = requireConnectionStore()

    app.db.transaction((tx) => {
      clearGbpProjectData(tx, project.id)
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

  // POST /projects/:name/gbp/sync — trigger a gbp-sync run (performance data).
  app.post<{
    Params: { name: string }
    Body: { locationNames?: string[]; daysOfMetrics?: number; monthsOfKeywords?: number }
  }>('/projects/:name/gbp/sync', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const store = requireConnectionStore()
    const conn = store.getConnection(project.canonicalDomain, 'gbp')
    if (!conn) {
      throw validationError('No GBP connection found for this project. Run "canonry gbp connect" first.')
    }

    const parsed = gbpSyncRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      throw validationError(parsed.error.issues[0]?.message ?? 'Invalid sync request')
    }

    const now = new Date().toISOString()
    const runId = crypto.randomUUID()
    app.db.insert(runs).values({
      id: runId,
      projectId: project.id,
      kind: 'gbp-sync',
      status: 'queued',
      trigger: 'manual',
      createdAt: now,
    }).run()

    opts.onGbpSyncRequested?.(runId, project.id, parsed.data)
    return { runId, status: 'running' }
  })

  // GET /projects/:name/gbp/metrics — stored daily performance metrics.
  app.get<{
    Params: { name: string }
    Querystring: { locationName?: string; metric?: string }
  }>('/projects/:name/gbp/metrics', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const conditions = [eq(gbpDailyMetrics.projectId, project.id)]
    if (request.query.locationName) conditions.push(eq(gbpDailyMetrics.locationName, request.query.locationName))
    if (request.query.metric) conditions.push(eq(gbpDailyMetrics.metric, request.query.metric))
    const rows = app.db.select().from(gbpDailyMetrics)
      .where(and(...conditions))
      .orderBy(desc(gbpDailyMetrics.date))
      .all()
    return {
      metrics: rows.map((r) => ({ locationName: r.locationName, date: r.date, metric: r.metric, value: r.value })),
      total: rows.length,
    }
  })

  // GET /projects/:name/gbp/keywords — stored keyword impressions (each row
  // is one keyword aggregated over its [periodStart, periodEnd] window).
  app.get<{
    Params: { name: string }
    Querystring: { locationName?: string }
  }>('/projects/:name/gbp/keywords', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const conditions = [eq(gbpKeywordImpressions.projectId, project.id)]
    if (request.query.locationName) conditions.push(eq(gbpKeywordImpressions.locationName, request.query.locationName))
    const rows = app.db.select().from(gbpKeywordImpressions)
      .where(and(...conditions))
      .all()
    // Lead with exact-value keywords (highest impressions first); thresholded
    // rows have no exact count so they sort last.
    rows.sort((a, b) => (b.valueCount ?? -1) - (a.valueCount ?? -1))
    const thresholded = rows.filter((r) => r.valueThreshold !== null).length
    return {
      keywords: rows.map((r) => ({
        locationName: r.locationName,
        periodStart: r.periodStart,
        periodEnd: r.periodEnd,
        keyword: r.keyword,
        valueCount: r.valueCount ?? null,
        valueThreshold: r.valueThreshold ?? null,
      })),
      total: rows.length,
      thresholdedPct: rows.length ? Math.round((thresholded / rows.length) * 100) : 0,
    }
  })

  // GET /projects/:name/gbp/place-actions — stored booking / reservation CTAs.
  app.get<{
    Params: { name: string }
    Querystring: { locationName?: string }
  }>('/projects/:name/gbp/place-actions', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const conditions = [eq(gbpPlaceActions.projectId, project.id)]
    if (request.query.locationName) conditions.push(eq(gbpPlaceActions.locationName, request.query.locationName))
    const rows = app.db.select().from(gbpPlaceActions).where(and(...conditions)).all()
    return {
      placeActions: rows.map((r) => ({
        locationName: r.locationName,
        placeActionLinkName: r.placeActionLinkName,
        placeActionType: r.placeActionType,
        uri: r.uri ?? null,
        isPreferred: Boolean(r.isPreferred),
        providerType: r.providerType ?? null,
      })),
      total: rows.length,
    }
  })

  // GET /projects/:name/gbp/lodging — latest lodging snapshot per location.
  app.get<{
    Params: { name: string }
    Querystring: { locationName?: string }
  }>('/projects/:name/gbp/lodging', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const conditions = [eq(gbpLodgingSnapshots.projectId, project.id)]
    if (request.query.locationName) conditions.push(eq(gbpLodgingSnapshots.locationName, request.query.locationName))
    const rows = app.db.select().from(gbpLodgingSnapshots)
      .where(and(...conditions))
      .orderBy(desc(gbpLodgingSnapshots.syncedAt))
      .all()
    // Collapse to the latest snapshot per location.
    const latestByLocation = new Map<string, typeof rows[number]>()
    for (const row of rows) {
      if (!latestByLocation.has(row.locationName)) latestByLocation.set(row.locationName, row)
    }
    const lodging = [...latestByLocation.values()].map((r) => ({
      locationName: r.locationName,
      populatedGroupCount: r.populatedGroupCount,
      syncedAt: r.syncedAt,
      attributes: r.attributes,
    }))
    return { lodging, total: lodging.length }
  })

  // GET /projects/:name/gbp/attributes — latest owner-set attributes snapshot
  // per location. Generic across business categories (distinct from the
  // hotels-only /gbp/lodging and the public-side /gbp/places).
  app.get<{
    Params: { name: string }
    Querystring: { locationName?: string }
  }>('/projects/:name/gbp/attributes', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const conditions = [eq(gbpAttributesSnapshots.projectId, project.id)]
    if (request.query.locationName) conditions.push(eq(gbpAttributesSnapshots.locationName, request.query.locationName))
    const rows = app.db.select().from(gbpAttributesSnapshots)
      .where(and(...conditions))
      .orderBy(desc(gbpAttributesSnapshots.syncedAt))
      .all()
    // Collapse to the latest snapshot per location.
    const latestByLocation = new Map<string, typeof rows[number]>()
    for (const row of rows) {
      if (!latestByLocation.has(row.locationName)) latestByLocation.set(row.locationName, row)
    }
    type StoredGbpAttribute = {
      name: string
      valueType: string
      values: (boolean | string)[]
      unsetValues?: string[]
      uris: string[]
    }
    const attributes = [...latestByLocation.values()].map((r) => ({
      locationName: r.locationName,
      attributeCount: r.attributeCount,
      syncedAt: r.syncedAt,
      attributes: (r.attributes as StoredGbpAttribute[]).map((attr) => ({
        ...attr,
        unsetValues: attr.unsetValues ?? [],
      })),
    }))
    return { attributes, total: attributes.length }
  })

  // GET /projects/:name/gbp/places — latest Places (New) rendered-listing
  // snapshot per location, with the server-derived `amenities` cross-reference
  // signal (#648). Mirrors /gbp/lodging: collapses to the latest snapshot.
  app.get<{
    Params: { name: string }
    Querystring: { locationName?: string }
  }>('/projects/:name/gbp/places', async (request): Promise<GbpPlaceDetailsListResponse> => {
    const project = resolveProject(app.db, request.params.name)
    const conditions = [eq(gbpPlaceDetails.projectId, project.id)]
    if (request.query.locationName) conditions.push(eq(gbpPlaceDetails.locationName, request.query.locationName))
    const rows = app.db.select().from(gbpPlaceDetails)
      .where(and(...conditions))
      .orderBy(desc(gbpPlaceDetails.syncedAt))
      .all()
    const latestByLocation = new Map<string, typeof rows[number]>()
    for (const row of rows) {
      if (!latestByLocation.has(row.locationName)) latestByLocation.set(row.locationName, row)
    }
    const places = [...latestByLocation.values()].map((r) => ({
      locationName: r.locationName,
      placeId: r.placeId,
      tier: r.tier,
      // Derived server-side so agents/UI consume the same amenity list.
      amenities: extractPlaceAmenities(r.attributes as PlaceDetails),
      syncedAt: r.syncedAt,
      place: r.attributes,
    }))
    return { places, total: places.length }
  })

  // GET /projects/:name/gbp/summary — composite, all derived numbers server-side.
  app.get<{
    Params: { name: string }
    Querystring: { locationName?: string }
  }>('/projects/:name/gbp/summary', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const locationName = request.query.locationName ?? null

    // The summary describes the locations the project actually tracks. With no
    // explicit location it covers the SELECTED locations only — a deselected
    // location's stale synced rows must not pollute the aggregates, and the
    // reported locationCount has to match the data the numbers came from. An
    // explicit locationName narrows to that one location regardless of its
    // selection state (operator inspecting a specific location).
    const locationNames = locationName
      ? [locationName]
      : app.db.select({ n: gbpLocations.locationName })
          .from(gbpLocations)
          .where(and(eq(gbpLocations.projectId, project.id), eq(gbpLocations.selected, true)))
          .all().map((r) => r.n)

    const today = new Date().toISOString().slice(0, 10)
    if (locationNames.length === 0) {
      return buildGbpSummary({
        locationName, locationCount: 0, asOfDate: today,
        dailyMetrics: [], keywords: [], placeActions: [], lodging: [], locationProfiles: [],
      })
    }

    const metricRows = app.db.select().from(gbpDailyMetrics)
      .where(and(eq(gbpDailyMetrics.projectId, project.id), inArray(gbpDailyMetrics.locationName, locationNames))).all()
    const keywordRows = app.db.select().from(gbpKeywordImpressions)
      .where(and(eq(gbpKeywordImpressions.projectId, project.id), inArray(gbpKeywordImpressions.locationName, locationNames))).all()
    const placeActionRows = app.db.select().from(gbpPlaceActions)
      .where(and(eq(gbpPlaceActions.projectId, project.id), inArray(gbpPlaceActions.locationName, locationNames))).all()
    const lodgingRows = app.db.select().from(gbpLodgingSnapshots)
      .where(and(eq(gbpLodgingSnapshots.projectId, project.id), inArray(gbpLodgingSnapshots.locationName, locationNames)))
      .orderBy(desc(gbpLodgingSnapshots.syncedAt))
      .all()
    const latestLodgingByLocation = new Map<string, { locationName: string; populatedGroupCount: number }>()
    for (const row of lodgingRows) {
      if (!latestLodgingByLocation.has(row.locationName)) {
        latestLodgingByLocation.set(row.locationName, { locationName: row.locationName, populatedGroupCount: row.populatedGroupCount })
      }
    }
    // Owner-content profile completeness over the in-scope locations.
    const profileRows = app.db.select({
      additionalCategories: gbpLocations.additionalCategories,
      description: gbpLocations.description,
      serviceArea: gbpLocations.serviceArea,
      regularHours: gbpLocations.regularHours,
      primaryPhone: gbpLocations.primaryPhone,
      openStatus: gbpLocations.openStatus,
    }).from(gbpLocations)
      .where(and(eq(gbpLocations.projectId, project.id), inArray(gbpLocations.locationName, locationNames))).all()

    // Pass the server "today"; buildGbpSummary derives the complete-day anchor
    // from the data (latest non-zero day) so the reporting-lag tail never
    // contaminates the recent-vs-prior deltas, and reports freshness explicitly.
    return buildGbpSummary({
      locationName,
      locationCount: locationNames.length,
      asOfDate: today,
      dailyMetrics: metricRows.map((r) => ({ metric: r.metric, date: r.date, value: r.value })),
      keywords: keywordRows.map((r) => ({ valueCount: r.valueCount ?? null, valueThreshold: r.valueThreshold ?? null })),
      placeActions: placeActionRows.map((r) => ({ placeActionType: r.placeActionType, providerType: r.providerType ?? null })),
      lodging: [...latestLodgingByLocation.values()],
      locationProfiles: profileRows,
    })
  })

}
