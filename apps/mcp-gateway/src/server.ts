import { createHash, randomBytes, generateKeyPairSync } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import { Provider, errors, type KoaContextWithOIDC } from 'oidc-provider'
import { ProtocolError, SdkHttpError } from '@modelcontextprotocol/server'
import type { GatewayConfig, GatewayTenant } from '@canonry/canonry-config'
import { GatewayStore } from './store.js'
import { GatewayProxy } from './proxy.js'
import { consentFont, consentFontPath, renderConsentPage, renderWorkspaceHandoff } from './consent.js'
import { discoverTenant, exchangeUpstream, readProfile, revokeUpstream, UpstreamError, TenantHttpPool, type Discovery, type UpstreamTokens, type UpstreamErrorCode } from './upstream.js'

interface UpstreamAuthorization {
  tenantId: string; discovery: Discovery; tokens: UpstreamTokens; upstreamClientId: string
}
interface Connection extends UpstreamAuthorization {
  userId: string; accountId: string; clientId: string; grantId: string; revoked?: boolean
}
interface PendingAuthorization extends UpstreamAuthorization { grantId?: string }
interface GatewayIdentity { tenantId: string; userId: string; profileId: string }
interface LoginState { uid: string; tenantId: string; verifier: string; nonce: string; discovery: Discovery; upstreamClientId: string }
interface BrowserState { csrf: string; nonce: string }
/** An accepted workspace choice. A resent copy of the same form gets the same handoff. */
interface StartedLogin { csrf: string; nonce: string; selection: string; authorize?: string }
const secret = () => randomBytes(32).toString('base64url')
const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex')
const diagnosticCodes = new Set<UpstreamErrorCode>([
  'request_rejected', 'invalid_json', 'invalid_upstream_response', 'upstream_http_error',
  'upstream_network_error', 'upstream_timeout', 'upstream_redirect', 'upstream_unapproved_network',
  'upstream_origin_mismatch', 'upstream_identity_mismatch', 'upstream_scope_mismatch', 'upstream_body_too_large',
])
const diagnosticMethods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CONNECT', 'TRACE'])
interface ErrorDiagnostic {
  errorClass: 'request' | 'upstream' | 'internal' | 'oauth' | 'mcp'
  code: UpstreamErrorCode | 'internal_error' | 'oidc_server_error' | 'mcp_request_failed'
  tenantId?: string
}
export interface GatewayAuditEvent extends Partial<ErrorDiagnostic> {
  event: string; status: number; durationMs: number; method: string
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}
async function readBody(req: IncomingMessage, max: number): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.length
    if (size > max) throw new UpstreamError(413)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}
function cookie(req: IncomingMessage, name: string): string | undefined {
  return req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`))?.slice(name.length + 1)
}

/** One process owns a persistent volume. Instances retain identity and business authority. */
export function createGateway(config: GatewayConfig, secrets: { vaultKey: Buffer; cookieKeys: string[] }, audit: (event: GatewayAuditEvent) => void = () => {}) {
  const store = new GatewayStore(config.databasePath, secrets.vaultKey)
  const network = new TenantHttpPool()
  const proxy = new GatewayProxy(config.requestTimeoutMs, network, (error, tenantId) => reportBackgroundError(error, Date.now(), tenantId))
  const resource = `${config.issuer}/mcp`
  const activeRefresh = new Map<string, Promise<Connection>>()
  const activeAuthorizations = new Set<string>()
  // A workspace check still running for an interaction. Resolves to the error status the
  // first submit showed, or undefined once its handoff is stored.
  const startingLogins = new Map<string, Promise<number | undefined>>()
  const pending = new Set<Promise<unknown>>()
  const requestDiagnostics = new WeakMap<IncomingMessage, ErrorDiagnostic>()
  const requestTenants = new WeakMap<IncomingMessage, string>()
  const registeredTenantIds = new Set(config.tenants.map(entry => entry.id))
  const track = (promise: Promise<unknown>, tenantId?: string) => {
    const started = Date.now()
    pending.add(promise)
    void promise.finally(() => pending.delete(promise)).catch(error => reportBackgroundError(error, started, tenantId))
  }
  const metrics = { requests: 0, rejected: 0, upstreamErrors: 0 }
  function errorStatus(error: unknown): number {
    const status = error instanceof UpstreamError || error instanceof errors.OIDCProviderError ? error.status : 500
    return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500
  }
  function errorDiagnostic(error: unknown, tenantId?: string, oauth = false): ErrorDiagnostic {
    const trustedTenant = error instanceof UpstreamError && error.tenantId ? error.tenantId : tenantId
    const context = trustedTenant && registeredTenantIds.has(trustedTenant) ? { tenantId: trustedTenant } : {}
    if (error instanceof UpstreamError && diagnosticCodes.has(error.code)) {
      return { errorClass: error.code === 'request_rejected' || error.code === 'invalid_json' ? 'request' : 'upstream', code: error.code, ...context }
    }
    if (error instanceof errors.OIDCProviderError && errorStatus(error) < 500) return { errorClass: 'request', code: 'request_rejected', ...context }
    if (error instanceof ProtocolError || error instanceof SdkHttpError) return { errorClass: 'mcp', code: 'mcp_request_failed', ...context }
    return { errorClass: oauth ? 'oauth' : 'internal', code: oauth ? 'oidc_server_error' : 'internal_error', ...context }
  }
  function recordRequestError(req: IncomingMessage, error: unknown, oauth = false): void {
    if (!requestDiagnostics.has(req)) requestDiagnostics.set(req, errorDiagnostic(error, requestTenants.get(req), oauth))
  }
  function reportBackgroundError(error: unknown, started: number, tenantId?: string): void {
    metrics.upstreamErrors++
    audit({ event: 'gateway_background_error', status: errorStatus(error), durationMs: Date.now() - started, method: 'BACKGROUND', ...errorDiagnostic(error, tenantId) })
  }
  const tenant = (id: string): GatewayTenant => {
    const current = store.get<GatewayTenant>('tenant', id)
    if (!current?.enabled) throw new UpstreamError(403)
    return current
  }
  // IDs never silently move to another origin, issuer or resource on configuration reload.
  for (const entry of config.tenants) {
    const previous = store.get<GatewayTenant>('tenant', entry.id)
    if (previous && ['origin', 'issuer', 'resource', 'mcpUrl'].some(key => previous[key as keyof GatewayTenant] !== entry[key as keyof GatewayTenant])) throw new Error('Registered tenant identity cannot be reassigned')
    store.put('tenant', entry.id, entry)
  }
  for (const entry of store.list<GatewayTenant>('tenant')) {
    registeredTenantIds.add(entry.id)
    if (!config.tenants.some(item => item.id === entry.id)) store.put('tenant', entry.id, { ...entry.value, enabled: false })
  }
  let jwks = store.get<{ keys: Record<string, unknown>[] }>('settings', 'jwks')
  if (!jwks) {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    jwks = { keys: [{ ...privateKey.export({ format: 'jwk' }), kid: secret(), use: 'sig', alg: 'RS256' }] }
    store.put('settings', 'jwks', jwks)
  }

  async function disconnect(grantId: string): Promise<void> {
    const connection = store.get<Connection>('connection', grantId)
    if (!connection) return
    store.put('connection', grantId, { ...connection, revoked: true })
    await proxy.disconnect(grantId)
    // Queue survives outages/restarts. Local denial takes effect before network work.
    store.put('revocation', grantId, connection)
    await drainRevocation(grantId, connection)
  }
  async function drainRevocation(id: string, connection: Connection): Promise<void> {
    const started = Date.now()
    try {
      await revokeAuthorization(connection)
      store.delete('revocation', id)
      store.delete('connection', id)
    } catch (error) { reportBackgroundError(error, started, connection.tenantId) }
  }
  async function revokeAuthorization(authorization: UpstreamAuthorization): Promise<void> {
    const current = store.get<GatewayTenant>('tenant', authorization.tenantId)
    if (!current) throw new UpstreamError(503)
    await revokeUpstream({ ...current, upstreamClientId: authorization.upstreamClientId }, authorization.discovery, authorization.tokens.refresh_token, config.requestTimeoutMs, network)
  }
  async function abandonAuthorization(id: string, authorization: PendingAuthorization): Promise<void> {
    const started = Date.now()
    try {
      if (authorization.grantId) {
        await (await provider.Grant.find(authorization.grantId))?.destroy()
        store.delete('connection', authorization.grantId)
        await proxy.disconnect(authorization.grantId)
      }
      await revokeAuthorization(authorization)
      store.delete('pending-authorization', id)
    } catch (error) { reportBackgroundError(error, started, authorization.tenantId) }
  }
  function recoverPendingAuthorizations(): void {
    for (const item of store.list<PendingAuthorization>('pending-authorization')) {
      if (activeAuthorizations.has(item.id)) continue
      activeAuthorizations.add(item.id)
      track(abandonAuthorization(item.id, item.value).finally(() => activeAuthorizations.delete(item.id)))
    }
  }
  async function refresh(connection: Connection): Promise<Connection> {
    const running = activeRefresh.get(connection.grantId)
    if (running) return running
    const promise = (async () => {
      const lease = store.acquireLease('refresh', connection.grantId, Math.ceil((config.requestTimeoutMs + 30_000) / 1000) + 10)
      if (!lease) throw new UpstreamError(503)
      try {
        const fresh = store.get<Connection>('connection', connection.grantId)
        if (!fresh || fresh.revoked) throw new UpstreamError(401)
        if (fresh.tokens.access_token !== connection.tokens.access_token) return fresh
        const tokens = await exchangeUpstream({ ...tenant(fresh.tenantId), upstreamClientId: fresh.upstreamClientId }, fresh.discovery, { grant_type: 'refresh_token', refresh_token: fresh.tokens.refresh_token }, config.requestTimeoutMs, network)
        const latest = store.get<Connection>('connection', connection.grantId)
        if (!latest || latest.revoked || !await provider.Grant.find(connection.grantId)) {
          const abandoned = { ...fresh, tokens, revoked: true }
          store.put('revocation', connection.grantId, abandoned)
          await drainRevocation(connection.grantId, abandoned)
          throw new UpstreamError(401)
        }
        const updated = { ...fresh, tokens }
        store.put('connection', connection.grantId, updated)
        return updated
      } catch (error) {
        if (error instanceof UpstreamError && (error.status === 400 || error.status === 401)) {
          await disconnect(connection.grantId)
          throw new UpstreamError(401)
        }
        throw error
      } finally { store.releaseLease('refresh', connection.grantId, lease) }
    })()
    activeRefresh.set(connection.grantId, promise)
    try { return await promise } finally { activeRefresh.delete(connection.grantId) }
  }
  async function authorizeConnection(grantId: string): Promise<Connection & { displayName: string; authorityFingerprint: string }> {
    let connection = store.get<Connection>('connection', grantId)
    if (!connection || connection.revoked || !await provider.Grant.find(grantId)) throw new UpstreamError(401)
    const current = tenant(connection.tenantId)
    if (connection.tokens.expiresAt <= Date.now() + 10_000) connection = await refresh(connection)
    let profile
    try { profile = await readProfile(current, connection.tokens.access_token, config.requestTimeoutMs, network) }
    catch (error) {
      if (!(error instanceof UpstreamError) || error.status !== 401) throw error
      connection = await refresh(connection)
      profile = await readProfile(current, connection.tokens.access_token, config.requestTimeoutMs, network)
    }
    if (profile.userId !== connection.userId) throw new UpstreamError(403)
    return { ...connection, displayName: profile.displayName, authorityFingerprint: fingerprint(JSON.stringify([profile.userId, [...profile.scopes].sort()])) }
  }

  const provider = new Provider(config.issuer, {
    adapter: store.oidcAdapter(), jwks,
    clients: config.clients,
    cookies: { keys: secrets.cookieKeys, short: { secure: !config.development, sameSite: 'lax' }, long: { secure: !config.development, sameSite: 'lax' } },
    features: { devInteractions: { enabled: false }, userinfo: { enabled: false }, registration: { enabled: false }, revocation: { enabled: true }, resourceIndicators: {
      enabled: true,
      defaultResource: () => resource,
      useGrantedResource: () => true,
      getResourceServerInfo: (ctx, identifier) => {
        const requested = typeof ctx.oidc.params?.scope === 'string' ? ctx.oidc.params.scope.split(/\s+/) : []
        if (requested.some(scope => scope !== 'read' && scope !== 'offline_access')) throw new errors.InvalidScope('Unsupported scope', 'read offline_access')
        if (identifier !== resource) throw new errors.InvalidTarget()
        return { scope: 'read offline_access', audience: resource, accessTokenFormat: 'opaque', accessTokenTTL: 600 }
      },
    } },
    scopes: ['read', 'offline_access'], responseTypes: ['code'],
    pkce: { required: () => true },
    rotateRefreshToken: true, revokeGrantPolicy: () => true,
    ttl: { AccessToken: 600, AuthorizationCode: 60, RefreshToken: 30 * 24 * 3600, Interaction: 600, Session: 600, Grant: 30 * 24 * 3600 },
    routes: { authorization: '/oauth/authorize', token: '/oauth/token', revocation: '/oauth/revoke', jwks: '/jwks' },
    interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
    // Every new grant selects and authenticates its workspace; never silently reuse a previous workspace login.
    loadExistingGrant: async ctx => ctx.oidc.result?.consent?.grantId ? provider.Grant.find(ctx.oidc.result.consent.grantId) : undefined,
    findAccount: async (ctx, accountId, token) => {
      const identity = store.get<{ tenantId: string; userId: string }>('identity', accountId)
      if (!identity) return undefined
      requestTenants.set(ctx.req, identity.tenantId)
      tenant(identity.tenantId)
      if (token?.grantId) {
        try { await authorizeConnection(token.grantId) }
        catch (error) {
          if (error instanceof UpstreamError && (error.status === 401 || error.status === 403)) return undefined
          throw error
        }
      }
      return { accountId, claims: () => ({ sub: accountId }) }
    },
    renderError: ctx => { ctx.type = 'text/plain'; ctx.body = 'Authorization could not be completed.' },
  })
  // oidc-provider always advertises `openid`, which getResourceServerInfo refuses.
  // Codex requests every advertised scope, so list only the scopes granted here.
  provider.use(async (ctx: KoaContextWithOIDC, next) => {
    await next()
    // Only matched oidc-provider routes define `ctx.oidc`; unknown paths reach here without it.
    if (!Object.hasOwn(ctx, 'oidc') || ctx.oidc.route !== 'discovery') return
    const body: unknown = ctx.body
    if (typeof body !== 'object' || body === null || !('scopes_supported' in body)) return
    const scopes = body.scopes_supported
    if (!Array.isArray(scopes)) return
    const index = scopes.indexOf('openid')
    if (index >= 0) scopes.splice(index, 1)
  })
  // Reverse proxy must overwrite forwarding headers; direct access is loopback/private only.
  provider.proxy = !config.development
  provider.on('grant.revoked', (_ctx: unknown, grantId: string) => { track(disconnect(grantId)) })
  provider.on('server_error', (ctx: { req: IncomingMessage; status: number }, error: unknown) => {
    recordRequestError(ctx.req, error, true)
    ctx.status = errorStatus(error)
  })
  const oidc = provider.callback()
  const buckets = new Map<string, { start: number; count: number }>()
  async function rateLimit(req: IncomingMessage): Promise<boolean> {
    const remote = req.socket.remoteAddress ?? 'unknown'
    const forwarded = req.headers['x-forwarded-for']
    let key = config.trustedProxyAddresses.includes(remote) && typeof forwarded === 'string' && isIP(forwarded) ? forwarded : remote
    const credential = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '')
    if (credential) {
      const token = await provider.AccessToken.find(credential[1])
      if (token?.grantId && token.aud === resource) key = `grant:${token.grantId}`
    }
    const now = Date.now()
    let value = buckets.get(key)
    if (!value && buckets.size >= 10_000) {
      for (const [id, bucket] of buckets) if (now - bucket.start > 60_000) buckets.delete(id)
      if (buckets.size >= 10_000) return false
    }
    if (!value || now - value.start > 60_000) { value = { start: now, count: 0 }; buckets.set(key, value) }
    if (buckets.size > 10_000) for (const [id, bucket] of buckets) if (now - bucket.start > 60_000) buckets.delete(id)
    return ++value.count <= config.rateLimitPerMinute
  }

  const server = createServer((req, res) => { track(handle(req, res).catch(error => {
    metrics.rejected++
    recordRequestError(req, error)
    if (!res.headersSent) json(res, errorStatus(error), { error: 'request_failed' })
    else res.destroy()
  })) })
  server.requestTimeout = config.requestTimeoutMs
  server.headersTimeout = Math.min(config.requestTimeoutMs, 30_000)
  async function outerBearer(req: IncomingMessage): Promise<{ raw: string; connection: Connection }> {
    const match = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '')
    if (!match) throw new UpstreamError(401)
    const token = await provider.AccessToken.find(match[1])
    if (!token || token.aud !== resource || !token.scopes.has('read') || !token.grantId) throw new UpstreamError(401)
    const connection = store.get<Connection>('connection', token.grantId)
    if (!connection || connection.revoked || !await provider.Grant.find(token.grantId)) throw new UpstreamError(401)
    if (connection.accountId !== token.accountId || connection.clientId !== token.clientId) throw new UpstreamError(401)
    requestTenants.set(req, connection.tenantId)
    return { raw: match[1], connection }
  }
  async function bearer(req: IncomingMessage) {
    const authenticated = await outerBearer(req)
    return { ...authenticated, connection: await authorizeConnection(authenticated.connection.grantId) }
  }
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    metrics.requests++
    const started = Date.now()
    let audited = false
    const completed = () => {
      if (audited) return
      audited = true
      audit({ event: 'gateway_request', status: res.statusCode, durationMs: Date.now() - started,
        method: req.method && diagnosticMethods.has(req.method) ? req.method : 'OTHER', ...requestDiagnostics.get(req) })
    }
    res.once('finish', completed)
    res.once('close', completed)
    const url = new URL(req.url ?? '/', config.issuer)
    if (req.headers.host !== new URL(config.issuer).host) throw new UpstreamError(400)
    if (!await rateLimit(req)) { res.setHeader('retry-after', '60'); json(res, 429, { error: 'rate_limited' }); return }
    if (url.pathname === consentFontPath) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new UpstreamError(405)
      res.writeHead(200, { 'content-type': 'font/woff2', 'content-length': consentFont.length, 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' })
      res.end(req.method === 'HEAD' ? undefined : consentFont)
      return
    }
    if (url.pathname === '/health') { json(res, 200, { status: 'ok', service: 'canonry-mcp-gateway' }); return }
    if (url.pathname === '/.well-known/openai-apps-challenge' && config.domainVerificationToken) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(config.domainVerificationToken); return }
    if (['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].includes(url.pathname)) {
      json(res, 200, { resource, authorization_servers: [config.issuer], scopes_supported: ['read', 'offline_access'], bearer_methods_supported: ['header'], resource_name: 'Canonry' }); return
    }
    if (url.pathname === '/disconnect') {
      if (req.method !== 'POST') throw new UpstreamError(405)
      const { connection } = await outerBearer(req)
      await (await provider.Grant.find(connection.grantId))?.destroy()
      await disconnect(connection.grantId)
      json(res, 200, { disconnected: true }); return
    }
    if (url.pathname === '/mcp') {
      let authenticated
      try { authenticated = await bearer(req) }
      catch (error) { if (error instanceof UpstreamError && error.status === 401) res.setHeader('www-authenticate', `Bearer resource_metadata="${config.issuer}/.well-known/oauth-protected-resource/mcp"`); throw error }
      const { connection, raw } = authenticated
      const current = tenant(connection.tenantId)
      const identity = store.get<GatewayIdentity>('identity', connection.accountId)
      if (typeof identity?.profileId !== 'string' || !identity.profileId.trim()) throw new UpstreamError(401)
      if (req.headers.origin && req.headers.origin !== config.issuer) throw new UpstreamError(403)
      let body: unknown
      if (req.method === 'POST') {
        const rawBody = await readBody(req, config.maxBodyBytes)
        try { body = JSON.parse(rawBody) as unknown }
        catch { throw new UpstreamError(400, 'invalid_json', connection.tenantId) }
      }
      await proxy.handle(req, res, body, {
        grantId: connection.grantId, tenantId: connection.tenantId, userId: connection.userId,
        profile: { id: identity.profileId, name: connection.displayName, nickname: current.displayName },
        tokenFingerprint: fingerprint(raw), authorityFingerprint: connection.authorityFingerprint, accessToken: connection.tokens.access_token, mcpUrl: current.mcpUrl,
        origin: current.origin, allowPrivateNetwork: current.allowPrivateNetwork,
        protocolVersions: current.protocolVersions, catalogVersion: current.catalogVersion,
      }, async options => {
        // Admission already read current authority. Long-lived delivery explicitly rechecks it.
        if (options?.fresh) await bearer(req)
      }, error => recordRequestError(req, error))
      return
    }
    const interactionMatch = /^\/interaction\/([^/]+)(?:\/(start|callback))?$/.exec(url.pathname)
    if (interactionMatch) {
      const uid = interactionMatch[1]
      const details = await provider.interactionDetails(req, res)
      if (details.uid !== uid) throw new UpstreamError(403)
      const cookieName = `gateway_${uid}`
      const action = `${config.issuer}/interaction/${uid}`
      const showConsent = async (status = 200, unavailable = false) => {
        const browser = { csrf: secret(), nonce: secret() }
        store.put('browser', uid, browser, 600)
        res.setHeader('set-cookie', `${cookieName}=${browser.nonce}; Path=/interaction/${uid}; HttpOnly; SameSite=Lax; Max-Age=600${config.development ? '' : '; Secure'}`)
        const client = await provider.Client.find(String(details.params.client_id))
        const callbackOrigin = new URL(String(details.params.redirect_uri)).origin
        const nonce = secret()
        res.writeHead(status, {
          'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
          'content-security-policy': `default-src 'none'; style-src 'nonce-${nonce}'; font-src 'self'; form-action 'self' ${callbackOrigin}; frame-ancestors 'none'; base-uri 'none'`,
          'referrer-policy': 'same-origin', 'x-content-type-options': 'nosniff',
        })
        res.end(renderConsentPage({ nonce, clientName: client?.clientName ?? String(details.params.client_id),
          redirectUri: String(details.params.redirect_uri), action: `${action}/start`, csrf: browser.csrf,
          unavailable,
        }))
      }
      const showHandoff = (target: string) => {
        // A new document prevents the original form's CSP from enumerating every workspace origin.
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
          'content-security-policy': "default-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
          'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
        })
        res.end(renderWorkspaceHandoff(target))
      }
      if (!interactionMatch[2] && req.method === 'GET') { await showConsent(); return }
      if (interactionMatch[2] === 'start' && req.method === 'POST') {
        if (req.headers.origin !== config.issuer) throw new UpstreamError(403)
        const form = new URLSearchParams(await readBody(req, config.maxBodyBytes))
        const selection = (form.get('tenant') ?? '').trim()
        const browser = store.take<BrowserState>('browser', uid)
        if (!browser) {
          // A double click sends the accepted form again. Only that browser and form match, and
          // they get the first submit's outcome: no second workspace check or login state.
          const started = store.get<StartedLogin>('started-login', uid)
          if (!started || started.nonce !== cookie(req, cookieName) || form.get('csrf') !== started.csrf || form.get('approve') !== 'yes' || selection !== started.selection) throw new UpstreamError(403)
          const failure = await startingLogins.get(uid)
          const target = store.get<StartedLogin>('started-login', uid)?.authorize
          if (target) { showHandoff(target); return }
          if (failure !== undefined) { await showConsent(failure, true); return }
          throw new UpstreamError(403)
        }
        if (browser.nonce !== cookie(req, cookieName) || form.get('csrf') !== browser.csrf) throw new UpstreamError(403)
        if (form.get('approve') !== 'yes') { await provider.interactionFinished(req, res, { error: 'access_denied' }); return }
        const matches = store.list<GatewayTenant>('tenant').filter(item => item.id === selection || new URL(item.value.origin).host.toLowerCase() === selection.toLowerCase())
        const current = matches.length === 1 ? matches[0]?.value : undefined
        if (!current?.enabled || !current.upstreamClientId) { await showConsent(400, true); return }
        requestTenants.set(req, current.id)
        const accepted = { csrf: browser.csrf, nonce: browser.nonce, selection }
        store.put('started-login', uid, accepted satisfies StartedLogin, 600)
        let settle: (failure: number | undefined) => void = () => undefined
        startingLogins.set(uid, new Promise<number | undefined>(resolve => { settle = resolve }))
        try {
          let discovery: Discovery
          try { discovery = await discoverTenant(current, config.requestTimeoutMs, network) }
          catch (error) {
            store.delete('started-login', uid)
            recordRequestError(req, error)
            settle(errorStatus(error))
            await showConsent(errorStatus(error), true); return
          }
          const state = secret(), verifier = secret()
          store.put('upstream-login', state, { uid, tenantId: current.id, verifier, nonce: browser.nonce, discovery, upstreamClientId: current.upstreamClientId } satisfies LoginState, 600)
          const authorize = new URL(discovery.authorization_endpoint)
          authorize.search = new URLSearchParams({ response_type: 'code', client_id: current.upstreamClientId, redirect_uri: `${action}/callback`, resource: current.resource, scope: 'read offline_access', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString()
          // Upstream redirect URI is fixed; interaction UID travels in durable state, not client registration.
          authorize.searchParams.set('redirect_uri', `${config.issuer}/upstream/callback`)
          store.put('started-login', uid, { ...accepted, authorize: authorize.toString() } satisfies StartedLogin, 600)
          showHandoff(authorize.toString()); return
        } finally {
          settle(undefined)
          startingLogins.delete(uid)
        }
      }
      if (interactionMatch[2] === 'callback' && req.method === 'GET') {
        const state = store.take<LoginState>('upstream-login', url.searchParams.get('state') ?? '')
        if (!state || state.uid !== uid || state.nonce !== cookie(req, cookieName)) throw new UpstreamError(403)
        const current = { ...tenant(state.tenantId), upstreamClientId: state.upstreamClientId }
        requestTenants.set(req, current.id)
        if (url.searchParams.has('error') || !url.searchParams.get('code') || (url.searchParams.has('iss') && url.searchParams.get('iss') !== current.issuer) || (state.discovery.authorization_response_iss_parameter_supported && url.searchParams.get('iss') !== current.issuer)) throw new UpstreamError(403)
        const tokens = await exchangeUpstream(current, state.discovery, { grant_type: 'authorization_code', code: url.searchParams.get('code')!, code_verifier: state.verifier, redirect_uri: `${config.issuer}/upstream/callback` }, config.requestTimeoutMs, network)
        const authorization: PendingAuthorization = { tenantId: current.id, discovery: state.discovery, tokens, upstreamClientId: current.upstreamClientId }
        activeAuthorizations.add(uid)
        try {
          // Persist before profile/setup I/O so failures and process restarts retain revocation authority.
          store.put('pending-authorization', uid, authorization)
          const profile = await readProfile(current, tokens.access_token, config.requestTimeoutMs, network)
          const accountId = JSON.stringify([current.id, profile.userId])
          const previousIdentity = store.get<GatewayIdentity>('identity', accountId)
          if (previousIdentity && (typeof previousIdentity.profileId !== 'string' || !previousIdentity.profileId.trim())) throw new UpstreamError(401)
          store.put('identity', accountId, { tenantId: current.id, userId: profile.userId, profileId: previousIdentity?.profileId ?? secret() } satisfies GatewayIdentity)
          const clientId = String(details.params.client_id)
          const grant = new provider.Grant({ accountId, clientId })
          grant.addOIDCScope('read offline_access')
          grant.addResourceScope(resource, 'read offline_access')
          const grantId = await grant.save()
          authorization.grantId = grantId
          store.put('pending-authorization', uid, authorization)
          store.put('connection', grantId, { ...authorization, userId: profile.userId, accountId, clientId, grantId } satisfies Connection)
          await provider.interactionFinished(req, res, { login: { accountId, remember: false }, consent: { grantId } }, { mergeWithLastSubmission: false })
          store.delete('pending-authorization', uid)
        } catch (error) {
          await abandonAuthorization(uid, authorization)
          throw error
        } finally { activeAuthorizations.delete(uid) }
        return
      }
      throw new UpstreamError(405)
    }
    if (url.pathname === '/upstream/callback' && req.method === 'GET') {
      const state = store.get<LoginState>('upstream-login', url.searchParams.get('state') ?? '')
      if (!state) throw new UpstreamError(403)
      res.writeHead(303, { location: `/interaction/${state.uid}/callback${url.search}`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end(); return
    }
    if (url.pathname === '/oauth/authorize' && req.method === 'GET' && url.searchParams.get('scope')?.split(/\s+/).includes('offline_access') && !url.searchParams.has('prompt')) {
      // The gateway always asks consent; make that policy explicit to the OAuth provider.
      url.searchParams.set('prompt', 'consent')
      req.url = `${url.pathname}${url.search}`
    }
    await oidc(req, res)
  }
  recoverPendingAuthorizations()
  const maintenance = setInterval(() => {
    store.pruneExpired()
    recoverPendingAuthorizations()
    for (const item of store.list<Connection>('revocation')) track(drainRevocation(item.id, item.value))
    for (const item of store.list<Connection>('connection')) {
      track(provider.Grant.find(item.id).then(grant => { if (!grant) return disconnect(item.id) }), item.value.tenantId)
    }
  }, 60_000)
  maintenance.unref()
  return {
    server,
    async close() {
      clearInterval(maintenance)
      await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() })
      await Promise.allSettled([...pending])
      await proxy.close()
      store.close()
    },
  }
}
