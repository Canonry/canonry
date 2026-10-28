import { lookup } from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { Readable } from 'node:stream'
import type { GatewayTenant } from '@canonry/canonry-config'
import { z } from 'zod'

export class UpstreamError extends Error {
  constructor(readonly status: number) { super('Upstream authorization or service unavailable') }
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
export function tenantFetch(tenant: Pick<GatewayTenant, 'origin' | 'allowPrivateNetwork'>, timeoutMs: number): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.origin !== tenant.origin || url.username || url.password || !['http:', 'https:'].includes(url.protocol)) {
      throw new UpstreamError(403)
    }
    if (isIP(url.hostname.replace(/[[\]]/g, '')) && !tenant.allowPrivateNetwork && !publicAddress(url.hostname.replace(/[[\]]/g, ''))) {
      throw new UpstreamError(403)
    }
    const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined
    return new Promise<Response>((resolve, reject) => {
      const send = url.protocol === 'https:' ? https.request : http.request
      const upstream = send(url, {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        signal: request.signal,
        agent: false,
        lookup: (hostname, options, callback) => {
          lookup(hostname, { ...options, all: true }, (error, addresses) => {
            if (error) return callback(error, [])
            if (!tenant.allowPrivateNetwork && addresses.some(item => !publicAddress(item.address))) {
              return callback(new Error('Unapproved upstream network'), [])
            }
            callback(null, addresses)
          })
        },
      }, response => {
        clearTimeout(timer)
        const status = response.statusCode ?? 502
        if (status >= 300 && status < 400) {
          response.destroy()
          reject(new UpstreamError(502))
          return
        }
        const headers = new Headers()
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) value.forEach(item => headers.append(name, item))
          else if (value !== undefined) headers.set(name, value)
        }
        resolve(new Response([204, 205, 304].includes(status) || request.method === 'HEAD' ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>, { status, headers }))
      })
      const timer = setTimeout(() => upstream.destroy(new Error('Upstream timeout')), timeoutMs)
      upstream.on('error', error => { clearTimeout(timer); reject(error instanceof UpstreamError ? error : new UpstreamError(502)) })
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

async function boundedJson(response: Response, timeoutMs: number): Promise<unknown> {
  if (!response.ok) { await response.body?.cancel(); throw new UpstreamError(response.status) }
  const reader = response.body?.getReader()
  if (!reader) throw new UpstreamError(502)
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
      if (size > 1024 * 1024) { await reader.cancel(); throw new UpstreamError(502) }
      chunks.push(result.value)
    }
    if (deadline.aborted) throw new UpstreamError(502)
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
    catch { throw new UpstreamError(502) }
  } finally { deadline.removeEventListener('abort', cancel) }
}

export async function discoverTenant(tenant: GatewayTenant, timeoutMs: number): Promise<Discovery> {
  const fetcher = tenantFetch(tenant, timeoutMs)
  const metadata = z.object({ resource: z.string(), authorization_servers: z.array(z.string()) }).parse(await boundedJson(await fetcher(`${tenant.origin}/.well-known/oauth-protected-resource${new URL(tenant.mcpUrl).pathname}`), timeoutMs))
  if (metadata.resource !== tenant.resource || !metadata.authorization_servers.includes(tenant.issuer)) throw new UpstreamError(502)
  const discovery = discoverySchema.parse(await boundedJson(await fetcher(`${tenant.issuer}/.well-known/oauth-authorization-server`), timeoutMs))
  if (discovery.issuer !== tenant.issuer) throw new UpstreamError(502)
  for (const url of [discovery.authorization_endpoint, discovery.token_endpoint, discovery.revocation_endpoint]) {
    if (new URL(url).origin !== tenant.origin) throw new UpstreamError(502)
  }
  return discovery
}

export async function exchangeUpstream(tenant: GatewayTenant, discovery: Discovery, params: Record<string, string>, timeoutMs: number): Promise<UpstreamTokens> {
  if (!tenant.upstreamClientId) throw new UpstreamError(503)
  const response = await tenantFetch(tenant, timeoutMs)(discovery.token_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...params, client_id: tenant.upstreamClientId, resource: tenant.resource }),
  })
  const tokens = tokenSchema.parse(await boundedJson(response, timeoutMs))
  const scopes = new Set(tokens.scope.split(/\s+/))
  if (tokens.token_type.toLowerCase() !== 'bearer' || !scopes.has('read') || [...scopes].some(scope => scope !== 'read' && scope !== 'offline_access')) throw new UpstreamError(403)
  return { ...tokens, expiresAt: Date.now() + tokens.expires_in * 1000 }
}

export async function readProfile(tenant: GatewayTenant, token: string, timeoutMs: number): Promise<Profile> {
  const profile = profileSchema.parse(await boundedJson(await tenantFetch(tenant, timeoutMs)(`${tenant.resource}/profile`, { headers: { authorization: `Bearer ${token}` } }), timeoutMs))
  if (profile.instance.issuer !== tenant.issuer || profile.instance.resource !== tenant.resource || !profile.scopes.includes('read')) throw new UpstreamError(403)
  return profile
}

export async function revokeUpstream(tenant: GatewayTenant, discovery: Discovery, token: string, timeoutMs: number): Promise<void> {
  const response = await tenantFetch(tenant, timeoutMs)(discovery.revocation_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token, client_id: tenant.upstreamClientId ?? '' }),
  })
  await response.body?.cancel()
  if (!response.ok) throw new UpstreamError(response.status)
}
