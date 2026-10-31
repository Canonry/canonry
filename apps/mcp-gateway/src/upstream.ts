import { lookup } from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { Readable } from 'node:stream'
import type { GatewayTenant } from '@canonry/canonry-config'
import { z } from 'zod'

export type UpstreamErrorCode = 'request_rejected' | 'invalid_json' | 'invalid_upstream_response'
  | 'upstream_http_error' | 'upstream_network_error' | 'upstream_timeout' | 'upstream_redirect'
  | 'upstream_unapproved_network' | 'upstream_origin_mismatch' | 'upstream_identity_mismatch'
  | 'upstream_scope_mismatch' | 'upstream_body_too_large'

export class UpstreamError extends Error {
  constructor(readonly status: number, readonly code: UpstreamErrorCode = 'request_rejected', readonly tenantId?: string) {
    super('Upstream authorization or service unavailable')
    this.name = 'UpstreamError'
  }
}

type TenantNetwork = Pick<GatewayTenant, 'origin' | 'allowPrivateNetwork'> & { id?: string; tenantId?: string }

/** One gateway owns these pools; origins and network policy never share sockets. */
export class TenantHttpPool {
  private readonly agents = new Map<string, http.Agent | https.Agent>()

  agent(tenant: TenantNetwork, protocol: string): http.Agent | https.Agent {
    const key = JSON.stringify([tenant.id ?? tenant.tenantId ?? tenant.origin, tenant.origin, tenant.allowPrivateNetwork])
    let agent = this.agents.get(key)
    if (!agent) {
      const options = { keepAlive: true, maxSockets: 64, maxTotalSockets: 64, maxFreeSockets: 4, scheduling: 'lifo' as const }
      agent = protocol === 'https:' ? new https.Agent(options) : new http.Agent(options)
      this.agents.set(key, agent)
    }
    return agent
  }

  close(): void {
    for (const agent of this.agents.values()) agent.destroy()
    this.agents.clear()
  }
}

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number)
    return a !== 0 && a !== 10 && a !== 127 && a < 224 && !(a === 169 && b === 254)
      && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168)
      && !(a === 100 && b >= 64 && b <= 127) && !(a === 198 && (b === 18 || b === 19))
  }
  // Global unicast only; reject mapped IPv4 and all local/multicast ranges.
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address)
}

/** Resolve and validate at socket creation, not in a separate DNS preflight. */
export function tenantFetch(tenant: TenantNetwork, timeoutMs: number, pool?: TenantHttpPool): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.origin !== tenant.origin || url.username || url.password || !['http:', 'https:'].includes(url.protocol)) {
      throw new UpstreamError(403, 'upstream_origin_mismatch', tenant.id ?? tenant.tenantId)
    }
    if (isIP(url.hostname.replace(/[[\]]/g, '')) && !tenant.allowPrivateNetwork && !publicAddress(url.hostname.replace(/[[\]]/g, ''))) {
      throw new UpstreamError(403, 'upstream_unapproved_network', tenant.id ?? tenant.tenantId)
    }
    const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined
    return new Promise<Response>((resolve, reject) => {
      const send = url.protocol === 'https:' ? https.request : http.request
      const upstream = send(url, {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        signal: request.signal,
        agent: pool?.agent(tenant, url.protocol) ?? false,
        lookup: (hostname, options, callback) => {
          lookup(hostname, { ...options, all: true }, (error, addresses) => {
            if (error) return callback(error, [])
            if (!tenant.allowPrivateNetwork && addresses.some(item => !publicAddress(item.address))) {
              return callback(new UpstreamError(403, 'upstream_unapproved_network', tenant.id ?? tenant.tenantId), [])
            }
            callback(null, addresses)
          })
        },
      }, response => {
        clearTimeout(timer)
        const status = response.statusCode ?? 502
        if (status < 200 || status > 599) {
          response.destroy()
          reject(new UpstreamError(502, 'invalid_upstream_response', tenant.id ?? tenant.tenantId))
          return
        }
        if (status >= 300 && status < 400) {
          response.destroy()
          reject(new UpstreamError(502, 'upstream_redirect', tenant.id ?? tenant.tenantId))
          return
        }
        const headers = new Headers()
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) value.forEach(item => headers.append(name, item))
          else if (value !== undefined) headers.set(name, value)
        }
        const bodyless = [204, 205, 304].includes(status) || request.method === 'HEAD'
        if (bodyless) response.resume()
        resolve(new Response(bodyless ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>, { status, headers }))
      })
      const timer = setTimeout(() => upstream.destroy(new UpstreamError(502, 'upstream_timeout', tenant.id ?? tenant.tenantId)), timeoutMs)
      upstream.on('error', error => { clearTimeout(timer); reject(error instanceof UpstreamError ? error : new UpstreamError(502, 'upstream_network_error', tenant.id ?? tenant.tenantId)) })
      upstream.end(body)
    })
  }
}

const discoverySchema = z.object({
  issuer: z.string(), authorization_endpoint: z.url(), token_endpoint: z.url(), revocation_endpoint: z.url(),
  authorization_response_iss_parameter_supported: z.boolean().optional(),
})
export type Discovery = z.infer<typeof discoverySchema>
const tokenSchema = z.object({
  access_token: z.string().min(1), refresh_token: z.string().min(1), token_type: z.string(),
  expires_in: z.number().positive(), scope: z.string(),
})
export type UpstreamTokens = z.infer<typeof tokenSchema> & { expiresAt: number }
const profileSchema = z.object({ userId: z.string().min(1), displayName: z.string(), instance: z.object({ issuer: z.string(), resource: z.string() }), scopes: z.array(z.string()) })
export type Profile = z.infer<typeof profileSchema>

async function boundedJson(response: Response, timeoutMs: number, tenantId: string): Promise<unknown> {
  if (!response.ok) { await response.body?.cancel(); throw new UpstreamError(response.status, 'upstream_http_error', tenantId) }
  const reader = response.body?.getReader()
  if (!reader) throw new UpstreamError(502, 'invalid_upstream_response', tenantId)
  const chunks: Uint8Array[] = []
  let size = 0
  const deadline = AbortSignal.timeout(timeoutMs)
  const cancel = () => { void reader.cancel() }
  deadline.addEventListener('abort', cancel, { once: true })
  try {
    for (;;) {
      const result = await reader.read()
      if (result.done) break
      size += result.value.byteLength
      if (size > 1024 * 1024) { await reader.cancel(); throw new UpstreamError(502, 'upstream_body_too_large', tenantId) }
      chunks.push(result.value)
    }
    if (deadline.aborted) throw new UpstreamError(502, 'upstream_timeout', tenantId)
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
    catch { throw new UpstreamError(502, 'invalid_upstream_response', tenantId) }
  } catch (error) {
    if (error instanceof UpstreamError) throw error
    throw new UpstreamError(502, 'upstream_network_error', tenantId)
  } finally { deadline.removeEventListener('abort', cancel) }
}

export async function discoverTenant(tenant: GatewayTenant, timeoutMs: number, pool?: TenantHttpPool): Promise<Discovery> {
  const fetcher = tenantFetch(tenant, timeoutMs, pool)
  const metadata = z.object({ resource: z.string(), authorization_servers: z.array(z.string()) }).safeParse(await boundedJson(await fetcher(`${tenant.origin}/.well-known/oauth-protected-resource${new URL(tenant.mcpUrl).pathname}`), timeoutMs, tenant.id))
  if (!metadata.success) throw new UpstreamError(502, 'invalid_upstream_response', tenant.id)
  if (metadata.data.resource !== tenant.resource || !metadata.data.authorization_servers.includes(tenant.issuer)) throw new UpstreamError(502, 'upstream_identity_mismatch', tenant.id)
  const parsed = discoverySchema.safeParse(await boundedJson(await fetcher(`${tenant.issuer}/.well-known/oauth-authorization-server`), timeoutMs, tenant.id))
  if (!parsed.success) throw new UpstreamError(502, 'invalid_upstream_response', tenant.id)
  const discovery = parsed.data
  if (discovery.issuer !== tenant.issuer) throw new UpstreamError(502, 'upstream_identity_mismatch', tenant.id)
  for (const url of [discovery.authorization_endpoint, discovery.token_endpoint, discovery.revocation_endpoint]) {
    if (new URL(url).origin !== tenant.origin) throw new UpstreamError(502, 'upstream_identity_mismatch', tenant.id)
  }
  return discovery
}

export async function exchangeUpstream(tenant: GatewayTenant, discovery: Discovery, params: Record<string, string>, timeoutMs: number, pool?: TenantHttpPool): Promise<UpstreamTokens> {
  if (!tenant.upstreamClientId) throw new UpstreamError(503)
  const response = await tenantFetch(tenant, timeoutMs, pool)(discovery.token_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...params, client_id: tenant.upstreamClientId, resource: tenant.resource }),
  })
  const parsed = tokenSchema.safeParse(await boundedJson(response, timeoutMs, tenant.id))
  if (!parsed.success) throw new UpstreamError(502, 'invalid_upstream_response', tenant.id)
  const tokens = parsed.data
  const scopes = new Set(tokens.scope.split(/\s+/))
  if (tokens.token_type.toLowerCase() !== 'bearer' || !scopes.has('read') || [...scopes].some(scope => scope !== 'read' && scope !== 'offline_access')) throw new UpstreamError(403, 'upstream_scope_mismatch', tenant.id)
  return { ...tokens, expiresAt: Date.now() + tokens.expires_in * 1000 }
}

export async function readProfile(tenant: GatewayTenant, token: string, timeoutMs: number, pool?: TenantHttpPool): Promise<Profile> {
  const parsed = profileSchema.safeParse(await boundedJson(await tenantFetch(tenant, timeoutMs, pool)(`${tenant.resource}/profile`, { headers: { authorization: `Bearer ${token}` } }), timeoutMs, tenant.id))
  if (!parsed.success) throw new UpstreamError(502, 'invalid_upstream_response', tenant.id)
  const profile = parsed.data
  if (profile.instance.issuer !== tenant.issuer || profile.instance.resource !== tenant.resource || !profile.scopes.includes('read')) throw new UpstreamError(403, 'upstream_identity_mismatch', tenant.id)
  return profile
}

export async function revokeUpstream(tenant: GatewayTenant, discovery: Discovery, token: string, timeoutMs: number, pool?: TenantHttpPool): Promise<void> {
  const response = await tenantFetch(tenant, timeoutMs, pool)(discovery.revocation_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token, client_id: tenant.upstreamClientId ?? '' }),
  })
  await response.body?.cancel()
  if (!response.ok) throw new UpstreamError(response.status, 'upstream_http_error', tenant.id)
}
