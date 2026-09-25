import crypto from 'node:crypto'
import { eq, and, desc, sql, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { gscSearchData, gscUrlInspections, gscCoverageSnapshots, gbpLocations, gbpDailyMetrics, gbpKeywordImpressions, gbpKeywordMonthly, gbpPlaceActions, gbpLodgingSnapshots, gbpAttributesSnapshots, gbpPlaceDetails, runs, projects, type DatabaseClient } from '@ainyc/canonry-db'
import {
  validationError, notFound, normalizeProjectDomain, parseWindow,
  authRequired, forbidden, quotaExceeded, providerError, escapeLikePattern, AppError,
  hostMatchesDomain,
  hostOf,
  type GoogleConnectionType,
  gbpDiscoverRequestSchema, gbpLocationSelectionRequestSchema, gbpSyncRequestSchema,
  type GbpLocationDto, type GbpLocationListResponse, type GbpAccountListResponse,
  type GbpPlaceDetailsListResponse,
  gscSubmitSitemapsRequestDtoSchema,
  gscPerformanceOrderBySchema,
  formatIsoDateInTimeZone,
  linearTrend,
  calendarDateRange,
  describeError,
  inclusiveDayCount,
  shiftIsoCalendarDate,
} from '@ainyc/canonry-contracts'
import { extractPlaceAmenities, type PlaceDetails } from '@ainyc/canonry-integration-google-places'
import { computeGscPeriodComparison, type GscComparisonBasis } from './gsc-period-comparison.js'
import { buildGbpSummary } from './gbp-summary.js'
import {
  mergeGscDailyTotalsWithFallback, readGscDailyTotals,
  readEarliestGscDataDate, readLatestGscDataDate,
  resolveGscWindowRange, resolveGscWindowDays, type GscWindowRange,
} from './gsc-totals.js'
import { assertNotProjectScoped } from './auth.js'
import { resolveProject, writeAuditLog } from './helpers.js'
import {
  buildSignedGoogleOAuthState,
  verifySignedGoogleOAuthState,
} from './google-oauth-state.js'

/**
 * The window to REPORT, given what the caller actually asked for.
 *
 * An explicit bound always wins over the label's computed one. The two are only
 * combined when the result is a real, forward range; otherwise the computed
 * side is dropped to `null`, because a caller reading `2030-01-01 to
 * 2026-01-06` would be told the data covers a period that runs backwards.
 */
export function resolveReportedWindow(
  resolved: GscWindowRange,
  startDate: string | undefined,
  endDate: string | undefined,
): GscWindowRange {
  const start = startDate ?? resolved.startDate
  const end = endDate ?? resolved.endDate
  if (start === null || end === null || start <= end) {
    return { ...resolved, startDate: start, endDate: end }
  }
  // Reversed, and only ONE side is the caller's (a fully explicit reversed pair
  // is already refused by `assertForwardRange` before we get here). Drop the
  // computed opposite: absent is honest about being unspecified, reversed is
  // not.
  return {
    ...resolved,
    startDate: startDate ? start : null,
    endDate: endDate ? end : null,
  }
}

/**
 * Refuse a caller-supplied range that runs backwards.
 *
 * Answering it with an empty result would be technically true and useless: the
 * caller asked for a period that does not exist, and every route taking
 * explicit bounds should say so rather than return zeros.
 */
export function assertForwardRange(startDate?: string, endDate?: string): void {
  for (const [field, value] of [['startDate', startDate], ['endDate', endDate]] as const) {
    if (value === undefined) continue
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? new Date(`${value}T00:00:00Z`)
      : null
    if (parsed === null || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      throw validationError(`Invalid ${field} "${value}". Expected a calendar date as YYYY-MM-DD.`)
    }
  }
  if (startDate && endDate && startDate > endDate) {
    throw validationError(`startDate "${startDate}" is after endDate "${endDate}".`)
  }
}

/**
 * Today's date on Search Console's own reporting calendar.
 *
 * GSC buckets by Pacific Time, so a UTC `toISOString().slice(0, 10)` names the
 * wrong day between 00:00 and 08:00 UTC and would misreport freshness by a
 * full day for a third of the clock.
 */
function gscToday(): string {
  return formatIsoDateInTimeZone(new Date().toISOString(), GSC_REPORTING_TIME_ZONE)
}
import {
  getAuthUrl,
  exchangeCode,
  refreshAccessToken,
  listSites,
  listSitemaps,
  submitSitemap,
  inspectUrl as gscInspectUrl,
  publishUrlNotification,
  GSC_SCOPE,
  INDEXING_SCOPE,
  INDEXING_API_DAILY_LIMIT,
  GoogleApiError,
  GoogleAuthError,
  GSC_REPORTING_TIME_ZONE,
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

const GOOGLE_OAUTH_COMPLETE_MESSAGE = 'canonry:google-oauth-complete'

export function googleOAuthSuccessHtml(type: GoogleConnectionType): string {
  const message = JSON.stringify({
    type: GOOGLE_OAUTH_COMPLETE_MESSAGE,
    connectionType: type,
  })

  return `<html><body style="font-family:system-ui;text-align:center;padding:60px">
    <h2>Connected successfully!</h2>
    <p>Google ${type.toUpperCase()} has been linked to your domain.</p>
    <p style="color:#888">This window closes automatically.</p>
    <script>
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(${message}, '*')
        window.close()
      }
    </script>
  </body></html>`
}

/**
 * Does a URL sit on the project's canonical host?
 *
 * The Indexing API only accepts URLs on the exact verified host, so a
 * subdomain is as unusable as an unrelated domain even when a `sc-domain:`
 * property covers it. Shared by the request-indexing gather step and its
 * validation so the two can never disagree about what "on the domain" means.
 * `www.` is stripped on both sides; an unparseable URL is not on the domain.
 */
function isOnProjectDomain(url: string, projectDomain: string): boolean {
  const urlHost = hostOf(url)
  const projectHost = hostOf(projectDomain)
  return urlHost !== null && projectHost !== null && urlHost === projectHost
}

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

function isSitemapOwnedByProperty(sitemapUrl: string, propertyId: string, canonicalDomain: string): boolean {
  let sitemap: URL
  try {
    sitemap = new URL(sitemapUrl)
  } catch {
    return false
  }
  if (sitemap.protocol !== 'http:' && sitemap.protocol !== 'https:') return false

  if (/^sc-domain:/i.test(propertyId)) {
    const domain = propertyId.slice('sc-domain:'.length).toLowerCase()
    return hostMatchesDomain(sitemap.hostname, domain)
  }

  if (/^\d+$/.test(propertyId)) {
    return hostOf(sitemap.hostname) === hostOf(canonicalDomain)
  }

  try {
    const property = new URL(propertyId)
    if (property.protocol !== 'http:' && property.protocol !== 'https:') return false
    if (sitemap.origin !== property.origin) return false
    const prefix = property.pathname.endsWith('/') ? property.pathname : `${property.pathname}/`
    return sitemap.pathname === property.pathname || sitemap.pathname.startsWith(prefix)
  } catch {
    return false
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

  return providerError(`${context}: ${describeError(err)}`)
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
    const stateEncoded = buildSignedGoogleOAuthState(
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
              <li>Under "Authorized redirect URIs", add:<br><code style="background:#1e1e1e;color:#e0e0e0;padding:4px 8px;border-radius:4px;display:inline-block;margin-top:4px">${request.query.state ? (() => { try { const s = verifySignedGoogleOAuthState(request.query.state, stateSecret); const uri = s?.redirectUri; return escapeHtml(typeof uri === 'string' ? uri : 'Could not determine URI') } catch { return 'Could not determine URI' } })() : 'Could not determine URI'}</code></li>
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

    const stateData = verifySignedGoogleOAuthState(state, stateSecret)
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
    // with whatever the OAuth `code` exchanged for. The shared verifier now
    // also enforces a short TTL, but a captured pre-upgrade state carries no
    // owner or issued-at binding. Reject it and force a fresh `/google/connect`.
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
      const msg = describeError(err)
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

    return reply.type('text/html').send(googleOAuthSuccessHtml(type as GoogleConnectionType))
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
    // Answers for the OAuth PRINCIPAL, not this project: every verified
    // Search Console property the operator can see, other clients included.
    assertNotProjectScoped(request, 'listing Search Console properties')

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
  //
  // Ordering, not the limit, is what made this read return a single day. The
  // dimensioned table holds hundreds of rows per date (measured: newest day
  // 671 rows, median day 724), so `ORDER BY date DESC LIMIT 500` spent the
  // whole page before the first date boundary. The default order is now
  // clicks descending, `date` stays available for time-series consumers, and
  // the response reports `totalMatching` / `truncated` so a caller can tell a
  // page from a complete answer.
  app.get<{
    Params: { name: string }
    Querystring: { startDate?: string; endDate?: string; days?: string; query?: string; page?: string; limit?: string; offset?: string; window?: string; orderBy?: string }
  }>('/projects/:name/google/gsc/performance', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const { startDate, endDate, query, page, limit, offset } = request.query

    const parsedOrderBy = gscPerformanceOrderBySchema.safeParse(request.query.orderBy ?? 'clicks')
    if (!parsedOrderBy.success) {
      throw validationError(
        `orderBy must be one of: ${gscPerformanceOrderBySchema.options.join(', ')}`,
      )
    }
    const orderBy = parsedOrderBy.data

    // Window-based filtering: when no explicit startDate is provided, resolve
    // the labelled window against the last day Google actually published, not
    // against the clock. See `resolveGscWindowRange`.
    assertForwardRange(startDate, endDate)
    // `days` is a SPAN, resolved HERE against the published frontier. The CLI
    // used to turn `--days N` into client-computed UTC dates and send them as
    // explicit bounds, which the route honours over its own anchor — so the
    // relative window skipped the anchoring entirely, could end a Pacific day
    // in the future, and covered N+1 inclusive dates.
    const daysParam = request.query.days === undefined ? null : Number(request.query.days)
    if (daysParam !== null && (!Number.isInteger(daysParam) || daysParam < 1)) {
      throw validationError('"days" must be a positive integer')
    }
    const latestDataDate = readLatestGscDataDate(app.db, project.id)
    const resolvedWindow = daysParam === null
      ? resolveGscWindowRange(parseWindow(request.query.window), latestDataDate, gscToday())
      : resolveGscWindowDays(daysParam, latestDataDate, gscToday())
    const cutoffDate = startDate ? null : resolvedWindow.startDate
    // A span bounds the TOP of the range too; a label-only request leaves the
    // upper edge to the caller's explicit `endDate`, exactly as before.
    const effectiveEndDate = endDate ?? (daysParam === null ? undefined : resolvedWindow.endDate ?? undefined)

    const conditions = [eq(gscSearchData.projectId, project.id)]
    if (startDate) conditions.push(sql`${gscSearchData.date} >= ${startDate}`)
    else if (cutoffDate) conditions.push(sql`${gscSearchData.date} >= ${cutoffDate}`)
    if (effectiveEndDate) conditions.push(sql`${gscSearchData.date} <= ${effectiveEndDate}`)
    // Escape LIKE wildcards so a literal `%`/`_` in the filter matches itself
    // instead of acting as a wildcard (a `%` filter would otherwise match every
    // row — wrong results + a needless full scan). The value is already bound.
    if (query) conditions.push(sql`${gscSearchData.query} LIKE ${'%' + escapeLikePattern(query) + '%'} ESCAPE '\\'`)
    if (page) conditions.push(sql`${gscSearchData.page} LIKE ${'%' + escapeLikePattern(page) + '%'} ESCAPE '\\'`)

    const limitVal = Math.max(parseInt(limit ?? '500', 10) || 0, 1)
    const offsetVal = Math.max(parseInt(offset ?? '0', 10) || 0, 0)

    // Every ordering carries `date` as a tiebreaker so a page boundary is
    // stable across calls when the metric ties (it ties constantly: most rows
    // have 0 clicks).
    const orderColumns = {
      clicks: [desc(gscSearchData.clicks), desc(gscSearchData.date), gscSearchData.query],
      impressions: [desc(gscSearchData.impressions), desc(gscSearchData.date), gscSearchData.query],
      date: [desc(gscSearchData.date), desc(gscSearchData.clicks), gscSearchData.query],
    }[orderBy]

    // Always chain `.offset()` in a single expression — drizzle 0.45 on
    // better-sqlite3 silently drops `.offset()` when called separately on a
    // saved query builder (issue #470). The single-expression chain matches
    // the working pattern used in backlinks.ts.
    const rows = app.db
      .select()
      .from(gscSearchData)
      .where(and(...conditions))
      .orderBy(...orderColumns)
      .limit(limitVal)
      .offset(offsetVal)
      .all()

    // COUNT over the same WHERE, ignoring limit/offset.
    const totalMatching = app.db
      .select({ total: sql<number>`COUNT(*)` })
      .from(gscSearchData)
      .where(and(...conditions))
      .get()?.total ?? 0

    // MAX(date) for the project, ignoring the date filter. This is what lets a
    // caller say "you asked past the GSC reporting lag" instead of "no data".
    const latestAvailableDate = app.db
      .select({ latest: sql<string | null>`MAX(${gscSearchData.date})` })
      .from(gscSearchData)
      .where(eq(gscSearchData.projectId, project.id))
      .get()?.latest ?? null

    return {
      rows: rows.map((r) => ({
        date: r.date,
        query: r.query,
        page: r.page,
        country: r.country,
        device: r.device,
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: parseFloat(r.ctr),
        position: parseFloat(r.position),
      })),
      totalMatching,
      // Account for the offset: `rows.length < totalMatching` alone reports
      // truncated=true for a page that sits past the end, where there is
      // nothing further to fetch. Truncation means "more rows follow this
      // page", so it has to measure from where this page ends.
      truncated: offsetVal + rows.length < totalMatching,
      latestAvailableDate,
    }
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
    assertForwardRange(startDate, endDate)
    const resolvedWindow = resolveGscWindowRange(
      parseWindow(request.query.window),
      readLatestGscDataDate(app.db, project.id),
      gscToday(),
    )
    const cutoffDate = startDate ? null : resolvedWindow.startDate
    const reportedWindow = resolveReportedWindow(resolvedWindow, startDate, endDate)

    // Prefer the property-level daily totals on dates where they exist (match
    // Google's property total). Fall back to summing `gsc_search_data` for
    // missing dates so upgraded installs do not shorten longer/custom windows
    // after their first post-migration sync.
    const windowStart = startDate ?? cutoffDate ?? ''
    const windowEnd = endDate ?? resolvedWindow.endDate ?? '9999-12-31'

    // The equal-length period immediately BEFORE the selected window — what the
    // tile percentages should be measured against.
    //
    // Pressing `90d` and reading "vs prior 45d" is what happens when the only
    // evidence on hand is the window itself: the comparison has to come from
    // somewhere, so it splits the selection. Reaching one window further back
    // makes the percentage answer the question the button asked.
    //
    // Only a BOUNDED selection has such a period. `window=all` has no lower
    // bound, so there is nothing before it to fetch, and it keeps the split.
    const priorPeriodStart = reportedWindow.startDate !== null && reportedWindow.endDate !== null
      ? (() => {
          const span = inclusiveDayCount(reportedWindow.startDate, reportedWindow.endDate)
          return span !== null && span > 0
            ? shiftIsoCalendarDate(reportedWindow.startDate, -span)
            : null
        })()
      : null

    // A period the sync never reached is not a period of zeroes. Search
    // Analytics omits days with no data, so a prior window that only PARTIALLY
    // predates the earliest stored row aggregates its unsynced days as zero,
    // halves its own baseline, and prints a rise that never happened. The
    // top-end frontier already refuses the mirror case (dates past the last
    // published day cannot support a decline); this is the same refusal at the
    // other end, and it applies ONLY to the days this change newly reaches for.
    // Read only when there is a prior period to validate, so the default
    // unbounded window does not pay for two aggregates it cannot use.
    const earliestDataDate = priorPeriodStart === null
      ? null
      : readEarliestGscDataDate(app.db, project.id)
    const priorWindowIsSynced = priorPeriodStart !== null
      && earliestDataDate !== null
      && priorPeriodStart >= earliestDataDate

    // Read back to the prior period so the comparison has real rows to
    // aggregate. Everything the RESPONSE reports — daily, totals, trends,
    // window — stays scoped to the selected window below.
    const fetchStart = priorWindowIsSynced ? priorPeriodStart : windowStart
    const dailyTotals = readGscDailyTotals(app.db, project.id, fetchStart, windowEnd)

    const conditions = [eq(gscSearchData.projectId, project.id)]
    if (fetchStart) conditions.push(sql`${gscSearchData.date} >= ${fetchStart}`)
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

    // Position exists ONLY on the property-level rows. The dimensioned fallback
    // has no property position to offer (a mean of per-row positions is not the
    // property's mean), so those dates report `null` rather than a `0` that
    // would read as rank #0 on an inverted axis.
    const propertyDates = new Set(dailyTotals.map((d) => d.date))
    // Spans the selected window AND the prior period, so the comparison has
    // both sides to aggregate.
    const comparisonDaily = mergeGscDailyTotalsWithFallback(
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
      position: propertyDates.has(d.date) ? d.position : null,
    }))
    // Everything the response REPORTS covers the selected window only. The
    // prior period is evidence for the percentage, not extra days of chart:
    // widening `daily` would move the totals and the fitted trend too, and the
    // window label above them would then name a shorter range than the data.
    const daily = fetchStart === windowStart
      ? comparisonDaily
      : comparisonDaily.filter((d) => d.date >= windowStart && d.date <= windowEnd)
    const totalClicks = daily.reduce((sum, d) => sum + d.clicks, 0)
    const totalImpressions = daily.reduce((sum, d) => sum + d.impressions, 0)

    // Impression-weighted, because position is non-additive: a day with one
    // impression must not pull the window mean as hard as a day with a thousand.
    // Days with no property position, and days with no impressions to weight by,
    // are excluded from both the numerator and the denominator.
    let positionWeight = 0
    let positionWeighted = 0
    for (const d of daily) {
      if (d.position === null || d.impressions <= 0) continue
      positionWeight += d.impressions
      positionWeighted += d.position * d.impressions
    }

    // Fit over one entry PER CALENDAR DAY, with `null` where a day has no row.
    //
    // `daily` contains only dates that produced data, and Search Analytics omits
    // zero-data days entirely, so consecutive entries are not consecutive dates.
    // Feeding that straight to a fit whose x is the array index compresses every
    // quiet stretch into a single step and overstates the slope: three days
    // falling 100 -> 80 then one day at 70 a week later reads as -10/day
    // compressed and -2.8/day on the real calendar.
    const byDate = new Map(daily.map((d) => [d.date, d]))
    // `calendarDateRange` is shared with the chart so both derive the SAME index
    // space. They used to compute it separately and disagree.
    const denseDates = daily.length === 0
      ? []
      : calendarDateRange(daily[0]!.date, daily[daily.length - 1]!.date)
    const densify = (pick: (d: (typeof daily)[number]) => number | null): (number | null)[] =>
      denseDates.map((date) => {
        const row = byDate.get(date)
        return row ? pick(row) : null
      })
    const comparisonEnd = reportedWindow.endDate ?? daily[daily.length - 1]?.date
    // A missing row INSIDE the monotonic observed-data frontier is a real
    // zero-count day. A date AFTER that frontier is ambiguous: it may be quiet
    // or unpublished, so it cannot support a decline. Do not clip silently,
    // because then the percentage would describe a different period from the
    // requested/reported window.
    const comparisonEndsWithinKnownData = reportedWindow.latestDataDate !== null
      && comparisonEnd <= reportedWindow.latestDataDate

    // The span the comparison divides, tagged with each day's source. Fed from
    // `comparisonDaily` (which reaches back over the prior period); `daily`
    // alone would leave that half empty and read as growth from nothing. The
    // tag is the module's INPUT — `daily` on the wire stays what the DTO says.
    const taggedComparisonDaily = comparisonDaily.map((d) => ({
      ...d,
      fromPropertyTotals: propertyDates.has(d.date),
    }))
    // `prior-window` reaches one window earlier so the halves land on the
    // selection and the period before it; `split-window` divides the selection
    // itself into its own two halves (the `reportedWindow.startDate` fallback,
    // matching an unbounded `window=all` with no lower bound of its own).
    const comparisonFor = (basis: GscComparisonBasis, startDate: string | null | undefined) =>
      startDate && comparisonEnd && comparisonEndsWithinKnownData
        ? computeGscPeriodComparison(taggedComparisonDaily, { startDate, endDate: comparisonEnd, basis })
        : null
    // Prefer the prior-window comparison, but keep it only if it actually
    // COMPARES. Only property-daily (or empty) evidence in the prior period can
    // support the ratio; a prior period that lands on dimensioned-only history
    // comes back non-comparable, and that blank is strictly worse than the
    // number the fully-property-daily selection still yields when split. The
    // `comparable` verdict is the arbiter because the reach test behind
    // `priorWindowIsSynced` reads the observed frontier — which includes the
    // invalid-for-totals dimensioned table — and so cannot see the source.
    const priorWindowComparison = priorWindowIsSynced
      ? comparisonFor('prior-window', priorPeriodStart)
      : null
    const periodComparison = priorWindowComparison?.comparable
      ? priorWindowComparison
      : comparisonFor('split-window', reportedWindow.startDate ?? daily[0]?.date)

    return {
      totals: {
        clicks: totalClicks,
        impressions: totalImpressions,
        ctr: totalImpressions > 0 ? totalClicks / totalImpressions : 0,
        position: positionWeight > 0 ? positionWeighted / positionWeight : null,
        /**
         * How many days actually carried a property-level position. Below
         * `days`, the position figure describes a SUBSET of the window, and a
         * surface must say so rather than present it as the window's average.
         */
        positionDays: daily.filter((d) => d.position !== null).length,
        days: daily.length,
      },
      daily,
      // The period actually returned. An explicit start/end wins over the
      // label, so echo what was used rather than what the window would have
      // chosen — a caller must be able to label the data it got.
      //
      // Mixing one explicit bound with the computed opposite one can invert the
      // range (an explicit `startDate` of 2030-01-01 against a computed
      // `endDate` of 2026-01-06), which would describe a period that cannot
      // contain the rows beside it. When only one side is given, the other is
      // dropped rather than reported reversed: an absent bound is honest about
      // being unspecified, a reversed pair is not.
      window: reportedWindow,
      // Fitted server-side so the dashboard, the CLI, and the report all draw
      // the SAME line (UI/CLI parity — a chart-only regression is invisible to
      // an agent), and fitted over the CALENDAR, not over the rows.
      trends: {
        clicks: linearTrend(densify((d) => d.clicks)),
        impressions: linearTrend(densify((d) => d.impressions)),
        ctr: linearTrend(densify((d) => d.ctr)),
        position: linearTrend(densify((d) => d.position)),
      },
      // The headline percentages come from HERE, not from `trends`. The fitted
      // line answers "which way is it going"; it cannot answer "by how much"
      // without a baseline, and its own start value is not one — unconstrained,
      // it goes negative for a metric that cannot be. Computed server-side for
      // the same UI/CLI parity reason as the fit: a percentage derived in a
      // chart component is invisible to an agent.
      periodComparison,
    }
  })

  // GET /projects/:name/google/gsc/top-pages
  //
  // One row per page, ranked by summed clicks descending. The aggregation runs
  // in SQL (`GROUP BY page`) so the response is bounded by the number of
  // distinct pages, not by the number of dimensioned rows behind them: the
  // previous workaround pulled 18,014 rows over the wire to produce 31.
  //
  // TOTALS ARE NOT A SUM OF THE ROWS. The dimensioned table is valid for
  // RANKING and invalid for TOTALS: Google withholds rare/anonymised queries
  // (clicks under-count) and one impression fans out across every query x page
  // x country x device combination (impressions over-count). Measured on one
  // real property-month: 792 summed clicks vs 1,142 actual, 45,266 summed
  // impressions vs 34,916 actual. `totals` therefore reads the un-dimensioned
  // property-level daily table and says so via `totalsSource`; when that table
  // has no rows in the window it is `null` rather than a plausible wrong number.
  app.get<{
    Params: { name: string }
    Querystring: { startDate?: string; endDate?: string; limit?: string; window?: string }
  }>('/projects/:name/google/gsc/top-pages', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const { startDate, endDate, limit } = request.query
    assertForwardRange(startDate, endDate)
    const resolvedWindow = resolveGscWindowRange(
      parseWindow(request.query.window),
      readLatestGscDataDate(app.db, project.id),
      gscToday(),
    )
    const cutoffDate = startDate ? null : resolvedWindow.startDate

    const conditions = [eq(gscSearchData.projectId, project.id)]
    if (startDate) conditions.push(sql`${gscSearchData.date} >= ${startDate}`)
    else if (cutoffDate) conditions.push(sql`${gscSearchData.date} >= ${cutoffDate}`)
    if (endDate) conditions.push(sql`${gscSearchData.date} <= ${endDate}`)

    const limitVal = Math.max(parseInt(limit ?? '50', 10) || 0, 1)

    const rows = app.db
      .select({
        page: gscSearchData.page,
        clicks: sql<number>`COALESCE(SUM(${gscSearchData.clicks}), 0)`,
        impressions: sql<number>`COALESCE(SUM(${gscSearchData.impressions}), 0)`,
      })
      .from(gscSearchData)
      .where(and(...conditions))
      .groupBy(gscSearchData.page)
      .orderBy(desc(sql`SUM(${gscSearchData.clicks})`), desc(sql`SUM(${gscSearchData.impressions})`))
      .limit(limitVal)
      .all()

    const windowStart = startDate ?? cutoffDate ?? ''
    const windowEnd = endDate ?? resolvedWindow.endDate ?? '9999-12-31'
    const dailyTotals = readGscDailyTotals(app.db, project.id, windowStart, windowEnd)
    const totalClicks = dailyTotals.reduce((sum, d) => sum + d.clicks, 0)
    const totalImpressions = dailyTotals.reduce((sum, d) => sum + d.impressions, 0)

    // The two tables are synced independently and can cover different spans:
    // a normal 30-day sync leaves months of dimensioned rows next to 30 days of
    // property-level totals. Reporting those totals beside a ranking drawn from
    // a longer span reads as one period when it is two, so the covered range is
    // disclosed and `complete` says whether it matches the ranked data.
    const rankedSpan = app.db
      .select({
        first: sql<string | null>`MIN(${gscSearchData.date})`,
        last: sql<string | null>`MAX(${gscSearchData.date})`,
      })
      .from(gscSearchData)
      .where(and(...conditions))
      .get()
    const coveredFrom = dailyTotals.length > 0 ? dailyTotals[0]!.date : null
    const coveredThrough = dailyTotals.length > 0 ? dailyTotals[dailyTotals.length - 1]!.date : null
    const totalsComplete = Boolean(
      coveredFrom && coveredThrough && rankedSpan?.first && rankedSpan?.last
      && coveredFrom <= rankedSpan.first && coveredThrough >= rankedSpan.last,
    )

    return {
      rows: rows.map((r) => ({
        page: r.page,
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.impressions > 0 ? r.clicks / r.impressions : 0,
      })),
      totals: dailyTotals.length > 0
        ? {
          clicks: totalClicks,
          impressions: totalImpressions,
          ctr: totalImpressions > 0 ? totalClicks / totalImpressions : 0,
          days: dailyTotals.length,
          coveredFrom,
          coveredThrough,
          // False when the property-level totals span less than the rows above.
          complete: totalsComplete,
        }
        : null,
      totalsSource: 'property-daily' as const,
      rankedFrom: rankedSpan?.first ?? null,
      rankedThrough: rankedSpan?.last ?? null,
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
        // The coverage donut's two arcs and the CLI summary. Every latest
        // inspection lands in exactly one bucket, so the two shares sum to 1.
        // Unrounded: `percentage` rounds 9,999 of 10,000 up to a false 100.
        indexedShare: total > 0 ? indexed / total : null,
        notIndexedShare: total > 0 ? notIndexed / total : null,
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
        unknownPages: r.unknownPages,
        verifiedByInspection: r.verifiedByInspection,
        derivedFromImpressions: r.derivedFromImpressions,
        reasonBreakdown: r.reasonBreakdown,
      }))
      .reverse()
  })

  // GET /projects/:name/google/gsc/sitemaps
  app.get<{
    Params: { name: string }
    Querystring: { sitemapIndex?: string }
  }>('/projects/:name/google/gsc/sitemaps', async (request) => {
    const { clientId: googleClientId, clientSecret: googleClientSecret } = getAuthConfig()
    if (!googleClientId || !googleClientSecret) {
      throw validationError('Google OAuth is not configured')
    }

    const store = requireConnectionStore()

    const project = resolveProject(app.db, request.params.name)
    const conn = store.getConnection(project.canonicalDomain, 'gsc')
    if (!conn?.propertyId) {
      throw validationError('No GSC property configured for this connection. Set one with "canonry google set-property".')
    }
    const sitemapIndex = request.query.sitemapIndex
    if (sitemapIndex && !isSitemapOwnedByProperty(sitemapIndex, conn.propertyId, project.canonicalDomain)) {
      throw validationError(`sitemapIndex must belong to the configured GSC property "${conn.propertyId}".`)
    }
    try {
      const { accessToken, propertyId } = await getValidToken(store, project.canonicalDomain, 'gsc', googleClientId, googleClientSecret)
      if (!propertyId) {
        throw validationError('No GSC property configured for this connection. Set one with "canonry google set-property".')
      }

      const entries = await listSitemaps(accessToken, propertyId, sitemapIndex)
      const sitemaps = sitemapIndex
        ? entries.map((sitemap) => ({ ...sitemap, parentSitemapUrl: sitemapIndex }))
        : entries
      const indexes = sitemaps.filter((sitemap) => sitemap.isSitemapsIndex).length
      return {
        sitemaps,
        summary: { total: sitemaps.length, indexes, files: sitemaps.length - indexes },
        preferredSubmissionUrls: indexes > 0
          ? sitemaps.filter((sitemap) => sitemap.isSitemapsIndex).map((sitemap) => sitemap.path)
          : sitemaps.map((sitemap) => sitemap.path),
      }
    } catch (err) {
      throw gscErrorToAppError(err, 'Failed to list Search Console sitemaps')
    }
  })

  // POST /projects/:name/google/gsc/sitemaps/submit
  app.post<{
    Params: { name: string }
    Body: { sitemapUrls: string[] }
  }>('/projects/:name/google/gsc/sitemaps/submit', async (request) => {
    const parsed = gscSubmitSitemapsRequestDtoSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      throw validationError('sitemapUrls must contain between 1 and 50 valid sitemap URLs')
    }
    const sitemapUrls = [...new Set(parsed.data.sitemapUrls)]
    const project = resolveProject(app.db, request.params.name)
    const store = requireConnectionStore()
    const conn = store.getConnection(project.canonicalDomain, 'gsc')
    if (!conn) {
      throw validationError('No GSC connection found for this domain. Run "canonry google connect" first.')
    }
    if (!conn.propertyId) {
      throw validationError('No GSC property configured for this connection. Set one with "canonry google set-property".')
    }
    const invalidUrls = sitemapUrls.filter((url) => !isSitemapOwnedByProperty(url, conn.propertyId!, project.canonicalDomain))
    if (invalidUrls.length > 0) {
      throw validationError(`Sitemap URLs must belong to the configured GSC property "${conn.propertyId}". Invalid: ${invalidUrls.slice(0, 5).join(', ')}`)
    }
    if (!(conn.scopes ?? []).includes(GSC_SCOPE)) {
      throw validationError('This GSC connection has the read-only webmasters scope and cannot submit sitemaps. Reconnect with "canonry google connect" to grant the full webmasters scope.')
    }

    const { clientId: googleClientId, clientSecret: googleClientSecret } = getAuthConfig()
    if (!googleClientId || !googleClientSecret) {
      throw validationError('Google OAuth is not configured')
    }
    let accessToken: string
    try {
      ({ accessToken } = await getValidToken(store, project.canonicalDomain, 'gsc', googleClientId, googleClientSecret))
    } catch (err) {
      throw gscErrorToAppError(err, 'Failed to authorize Search Console sitemap submission')
    }

    const results: Array<{ sitemapUrl: string; status: 'accepted' | 'error'; submittedAt?: string; error?: string }> = []
    for (const sitemapUrl of sitemapUrls) {
      try {
        await submitSitemap(accessToken, conn.propertyId, sitemapUrl)
        const submittedAt = new Date().toISOString()
        writeAuditLog(app.db, {
          projectId: project.id,
          actor: 'api',
          action: 'google.sitemap.submitted',
          entityType: 'sitemap',
          entityId: sitemapUrl,
        })
        results.push({ sitemapUrl, status: 'accepted', submittedAt })
      } catch (err) {
        results.push({ sitemapUrl, status: 'error', error: describeError(err) })
      }
    }
    const accepted = results.filter((result) => result.status === 'accepted').length
    return { summary: { total: results.length, accepted, failed: results.length - accepted }, results }
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
      throw validationError(
        `No sitemaps found for this GSC property. Submit one with ` +
        `"canonry google submit-sitemap ${request.params.name} <url>" first.`,
      )
    }

    // A sitemap index gives inspection the complete site surface; use it first.
    const primary = sitemaps.find((s) => s.isSitemapsIndex) ?? sitemaps[0]!
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

      // Inspection history accumulates hosts the Indexing API will not accept:
      // URLs from a previous domain the project has since migrated off, and
      // subdomains that a `sc-domain:` property legitimately reports. Skip them
      // here rather than letting the canonical-domain check below reject the
      // whole batch — one stale row must not make this endpoint unusable.
      const gatherDomain = normalizeProjectDomain(project.canonicalDomain)
      const unindexedUrls: string[] = []
      let skippedOtherHost = 0
      for (const [url, row] of latestByUrl) {
        if (row.indexingState === 'INDEXING_ALLOWED') continue
        if (!isOnProjectDomain(url, gatherDomain)) {
          skippedOtherHost += 1
          continue
        }
        unindexedUrls.push(url)
      }

      if (unindexedUrls.length === 0) {
        throw validationError(
          skippedOtherHost > 0
            ? `No unindexed URLs found on "${project.canonicalDomain}" (skipped ${skippedOtherHost} on other hosts). Run "canonry google inspect-sitemap" first.`
            : 'No unindexed URLs found. Run "canonry google inspect-sitemap" first.',
        )
      }

      urlsToNotify = unindexedUrls
    }

    if (urlsToNotify.length === 0) {
      throw validationError('At least one URL is required (or use allUnindexed: true)')
    }

    if (urlsToNotify.length > INDEXING_API_DAILY_LIMIT) {
      throw validationError(`Cannot request indexing for more than ${INDEXING_API_DAILY_LIMIT} URLs per request (got ${urlsToNotify.length})`)
    }

    // Validate that all URLs belong to the project's canonical domain. Reached
    // only for caller-supplied URLs now — the allUnindexed path filters above,
    // so a stale inspection row cannot fail a request the caller did not make.
    const projectDomain = normalizeProjectDomain(project.canonicalDomain)
    const invalidUrls = urlsToNotify.filter((url) => !isOnProjectDomain(url, projectDomain))
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
        const msg = describeError(err)
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
    // Same boundary: every Business Profile account the OAuth principal can
    // reach, not just this project's.
    assertNotProjectScoped(request, 'listing Business Profile accounts')

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
