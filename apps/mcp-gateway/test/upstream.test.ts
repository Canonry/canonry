import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { GatewayTenant } from '@canonry/canonry-config'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverTenant, readProfile, tenantFetch } from '../src/upstream.js'

type Handler = (req: IncomingMessage, res: ServerResponse, tenant: GatewayTenant) => void
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(close => close())) })

/** Socket-level policy fixture only; it does not simulate Canonry business reads. */
async function endpoint(handler: Handler) {
  const paths: string[] = []
  const server = createServer((req, res) => {
    paths.push(req.url ?? '/')
    handler(req, res, tenant)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing ephemeral listener')
  const origin = `http://127.0.0.1:${address.port}`
  const tenant: GatewayTenant = {
    id: 'network-fixture', displayName: 'Network fixture', enabled: true, origin, issuer: origin,
    resource: `${origin}/api/v1/mcp`, mcpUrl: `${origin}/api/v1/mcp/readonly`, allowPrivateNetwork: true,
    protocolVersions: ['2025-11-25'], catalogVersion: 'canonry-readonly-v1', upstreamClientId: 'gateway',
  }
  cleanups.push(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
      server.closeAllConnections()
    })
  })
  return { tenant, paths }
}

function json(res: ServerResponse, value: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

function profile(tenant: GatewayTenant) {
  return { userId: 'network-user', displayName: 'Synthetic reader', instance: { issuer: tenant.issuer, resource: tenant.resource }, scopes: ['read'] }
}

function discovery(tenant: GatewayTenant) {
  return {
    issuer: tenant.issuer,
    authorization_endpoint: `${tenant.origin}/oauth/authorize`,
    token_endpoint: `${tenant.origin}/oauth/token`,
    revocation_endpoint: `${tenant.origin}/oauth/revoke`,
    authorization_response_iss_parameter_supported: true,
  }
}

describe('gateway upstream network boundary', () => {
  it('requires explicit private-network provisioning before contacting loopback', async () => {
    const local = await endpoint((_req, res) => { res.end('approved origin') })
    const unapproved = tenantFetch({ ...local.tenant, allowPrivateNetwork: false }, 1_000)
    await expect(unapproved(`${local.tenant.origin}/stored`)).rejects.toMatchObject({ status: 403 })
    expect(local.paths).toEqual([])
    const allowed = await tenantFetch(local.tenant, 1_000)(`${local.tenant.origin}/stored`)
    expect(await allowed.text()).toBe('approved origin')
    expect(local.paths).toEqual(['/stored'])
  })

  it('rejects destination overrides and redirects without contacting their targets', async () => {
    const destination = await endpoint((_req, res) => { res.end('must not be reached') })
    const source = await endpoint((req, res, tenant) => {
      res.writeHead(302, { location: req.url === '/self' ? `${tenant.origin}/hidden` : `${destination.tenant.origin}/hidden` })
      res.end()
    })
    const fetcher = tenantFetch(source.tenant, 1_000)
    await expect(fetcher(`${destination.tenant.origin}/override`, { headers: { authorization: 'Bearer synthetic-upstream-token' } }))
      .rejects.toMatchObject({ status: 403 })
    expect(source.paths).toEqual([])
    expect(destination.paths).toEqual([])
    await expect(fetcher(`${source.tenant.origin}/redirect`, { redirect: 'follow' })).rejects.toMatchObject({ status: 502 })
    await expect(fetcher(`${source.tenant.origin}/self`, { redirect: 'follow' })).rejects.toMatchObject({ status: 502 })
    expect(source.paths).toEqual(['/redirect', '/self'])
    expect(destination.paths).toEqual([])
  })

  it('bounds the wait for response headers', async () => {
    const local = await endpoint(() => { /* Hold the socket open without response headers. */ })
    await expect(readProfile(local.tenant, 'synthetic-token', 50)).rejects.toMatchObject({ status: 502 })
    expect(local.paths).toEqual(['/api/v1/mcp/profile'])
  }, 2_000)

  it('rejects a body deadline even if received bytes already form valid JSON', async () => {
    const local = await endpoint((_req, res, tenant) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write(JSON.stringify(profile(tenant)))
      // Do not end the response: a complete HTTP body is part of successful delivery.
    })
    await expect(readProfile(local.tenant, 'synthetic-token', 50)).rejects.toMatchObject({ status: 502 })
    expect(local.paths).toEqual(['/api/v1/mcp/profile'])
  }, 2_000)

  it('bounds the JSON response size before accepting a profile', async () => {
    const local = await endpoint((_req, res, tenant) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(`${' '.repeat(1024 * 1024)}${JSON.stringify(profile(tenant))}`)
    })
    await expect(readProfile(local.tenant, 'synthetic-token', 1_000)).rejects.toMatchObject({ status: 502 })
    expect(local.paths).toEqual(['/api/v1/mcp/profile'])
  })

  it('accepts only discovery that matches the provisioned resource, issuer and endpoint origin', async () => {
    type Mismatch = 'resource' | 'authorization-server' | 'issuer' | 'authorization_endpoint' | 'token_endpoint' | 'revocation_endpoint'
    let mismatch: Mismatch | undefined
    const local = await endpoint((req, res, tenant) => {
      if (req.url?.startsWith('/.well-known/oauth-protected-resource')) {
        json(res, {
          resource: mismatch === 'resource' ? tenant.mcpUrl : tenant.resource,
          authorization_servers: [mismatch === 'authorization-server' ? 'https://unapproved.example' : tenant.issuer],
        })
      } else {
        const metadata = discovery(tenant)
        if (mismatch === 'issuer') metadata.issuer = 'https://unapproved.example'
        if (mismatch === 'authorization_endpoint' || mismatch === 'token_endpoint' || mismatch === 'revocation_endpoint') {
          metadata[mismatch] = 'https://unapproved.example/oauth'
        }
        json(res, metadata)
      }
    })
    await expect(discoverTenant(local.tenant, 1_000)).resolves.toEqual(discovery(local.tenant))
    expect(local.paths).toEqual([
      '/.well-known/oauth-protected-resource/api/v1/mcp/readonly',
      '/.well-known/oauth-authorization-server',
    ])
    const mismatches: Mismatch[] = ['resource', 'authorization-server', 'issuer', 'authorization_endpoint', 'token_endpoint', 'revocation_endpoint']
    for (const next of mismatches) {
      mismatch = next
      const before = local.paths.length
      await expect(discoverTenant(local.tenant, 1_000), next).rejects.toMatchObject({ status: 502 })
      expect(local.paths.slice(before)).toEqual(next === 'resource' || next === 'authorization-server'
        ? ['/.well-known/oauth-protected-resource/api/v1/mcp/readonly']
        : ['/.well-known/oauth-protected-resource/api/v1/mcp/readonly', '/.well-known/oauth-authorization-server'])
    }
  })

  it('rejects profiles claiming another instance or lacking read authority', async () => {
    let mismatch: 'issuer' | 'resource' | 'scope' | undefined
    const local = await endpoint((_req, res, tenant) => {
      const identity = profile(tenant)
      if (mismatch === 'issuer') identity.instance.issuer = 'https://unapproved.example'
      if (mismatch === 'resource') identity.instance.resource = `${tenant.origin}/other/api/v1/mcp`
      if (mismatch === 'scope') identity.scopes = []
      json(res, identity)
    })
    await expect(readProfile(local.tenant, 'synthetic-token', 1_000)).resolves.toEqual(profile(local.tenant))
    for (const next of ['issuer', 'resource', 'scope'] as const) {
      mismatch = next
      await expect(readProfile(local.tenant, 'synthetic-token', 1_000), next).rejects.toMatchObject({ status: 403 })
    }
    expect(local.paths).toEqual(Array<string>(4).fill('/api/v1/mcp/profile'))
  })
})
