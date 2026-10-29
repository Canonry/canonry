import { z } from 'zod'

const nonempty = z.string().trim().min(1)
const identifier = z.string().regex(/^[a-z0-9][\w-]{0,127}$/i)
const url = z.url().refine(value => {
  const parsed = new URL(value)
  return !parsed.username && !parsed.password && !parsed.hash && !parsed.search
}, 'URLs must not contain credentials, fragments, or query strings')

export const gatewayTenantSchema = z.object({
  id: identifier,
  displayName: nonempty.max(200),
  origin: url,
  issuer: url,
  resource: url,
  mcpUrl: url,
  enabled: z.boolean(),
  allowPrivateNetwork: z.boolean().default(false),
  protocolVersions: z.array(nonempty).min(1),
  catalogVersion: z.literal('canonry-readonly-v1'),
  upstreamClientId: nonempty.optional(),
}).strict()

export type GatewayTenant = z.infer<typeof gatewayTenantSchema>

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]']

const clientSchema = z.object({
  client_id: identifier,
  client_name: nonempty.max(200),
  /**
   * `native` is a CLI or desktop app that receives the code on a loopback port it
   * picks per sign-in (RFC 8252 section 7.3). oidc-provider matches its loopback
   * redirects on any port, so they are registered without one.
   */
  application_type: z.enum(['web', 'native']).default('web'),
  redirect_uris: z.array(z.url()).min(1),
  token_endpoint_auth_method: z.literal('none').default('none'),
  grant_types: z.array(z.enum(['authorization_code', 'refresh_token'])).default(['authorization_code', 'refresh_token']),
  response_types: z.tuple([z.literal('code')]).default(['code']),
}).strict()

/** Host-controlled routing only. A user or MCP argument can never add a destination. */
export const gatewayConfigSchema = z.object({
  issuer: url,
  development: z.boolean().default(false),
  host: nonempty.default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(4101),
  databasePath: nonempty,
  clients: z.array(clientSchema).min(1),
  tenants: z.array(gatewayTenantSchema).min(1),
  requestTimeoutMs: z.number().int().min(100).max(120_000).default(30_000),
  trustedProxyAddresses: z.array(z.union([z.ipv4(), z.ipv6()])).default([]),
  rateLimitPerMinute: z.number().int().min(1).max(100_000).default(120),
  maxBodyBytes: z.number().int().min(1024).max(10 * 1024 * 1024).default(1024 * 1024),
  domainVerificationToken: z.string().regex(/^[\w-]{1,1024}$/).optional(),
}).strict().superRefine((config, ctx) => {
  const checkTransport = (value: string, path: (string | number)[]) => {
    const parsed = new URL(value)
    const loopback = LOOPBACK_HOSTS.includes(parsed.hostname)
    if (parsed.protocol !== 'https:' && !(config.development && loopback && parsed.protocol === 'http:')) {
      ctx.addIssue({ code: 'custom', path, message: 'HTTPS is required except explicit development on loopback' })
    }
  }
  checkTransport(config.issuer, ['issuer'])
  const issuer = new URL(config.issuer)
  if (issuer.pathname !== '/' || config.issuer.endsWith('/')) {
    ctx.addIssue({ code: 'custom', path: ['issuer'], message: 'Gateway issuer must be an origin without a trailing slash' })
  }
  if (!config.development && config.databasePath === ':memory:') {
    ctx.addIssue({ code: 'custom', path: ['databasePath'], message: 'Production requires a durable database path' })
  }
  const tenantIds = new Set<string>()
  config.tenants.forEach((tenant, index) => {
    if (tenantIds.has(tenant.id)) ctx.addIssue({ code: 'custom', path: ['tenants', index, 'id'], message: 'Tenant IDs must be unique' })
    tenantIds.add(tenant.id)
    if (new URL(tenant.origin).origin !== tenant.origin) {
      ctx.addIssue({ code: 'custom', path: ['tenants', index, 'origin'], message: 'Tenant origin must be an origin without a path or trailing slash' })
    }
    for (const field of ['origin', 'issuer', 'resource', 'mcpUrl'] as const) {
      checkTransport(tenant[field], ['tenants', index, field])
      if (new URL(tenant[field]).origin !== tenant.origin) {
        ctx.addIssue({ code: 'custom', path: ['tenants', index, field], message: 'Tenant endpoints must belong to the provisioned origin' })
      }
    }
    if (!new URL(tenant.mcpUrl).pathname.endsWith('/api/v1/mcp/readonly')) {
      ctx.addIssue({ code: 'custom', path: ['tenants', index, 'mcpUrl'], message: 'Only the Canonry read-only MCP endpoint is permitted' })
    }
    if (!new URL(tenant.resource).pathname.endsWith('/api/v1/mcp')) {
      ctx.addIssue({ code: 'custom', path: ['tenants', index, 'resource'], message: 'Canonical MCP resource must end in /api/v1/mcp' })
    }
  })
  const clientIds = new Set<string>()
  config.clients.forEach((client, index) => {
    if (clientIds.has(client.client_id)) ctx.addIssue({ code: 'custom', path: ['clients', index, 'client_id'], message: 'Client IDs must be unique' })
    clientIds.add(client.client_id)
    client.redirect_uris.forEach((redirect, redirectIndex) => {
      const parsed = new URL(redirect)
      if (client.application_type === 'web') checkTransport(redirect, ['clients', index, 'redirect_uris', redirectIndex])
      else if (parsed.protocol !== 'http:' || !LOOPBACK_HOSTS.includes(parsed.hostname) || parsed.port) {
        ctx.addIssue({ code: 'custom', path: ['clients', index, 'redirect_uris', redirectIndex], message: 'Native clients register loopback HTTP redirects without a port' })
      }
      if (parsed.username || parsed.password || parsed.hash) {
        ctx.addIssue({ code: 'custom', path: ['clients', index, 'redirect_uris', redirectIndex], message: 'Redirects cannot contain credentials or fragments' })
      }
    })
  })
})

export type GatewayConfig = z.infer<typeof gatewayConfigSchema>

/** Secrets are separate from routing JSON and never read from the operator's Canonry config. */
export function readGatewayEnv(env: NodeJS.ProcessEnv): {
  configPath: string
  vaultKey: Buffer
  cookieKeys: string[]
} {
  const configPath = nonempty.parse(env.CANONRY_GATEWAY_CONFIG)
  const encodedKey = z.string().regex(/^[a-z0-9+/]{43}=$/i).parse(env.CANONRY_GATEWAY_VAULT_KEY)
  const vaultKey = Buffer.from(encodedKey, 'base64')
  if (vaultKey.length !== 32 || vaultKey.toString('base64') !== encodedKey) {
    throw new Error('CANONRY_GATEWAY_VAULT_KEY must be a canonical base64-encoded 32-byte key')
  }
  let rawCookieKeys: unknown
  try { rawCookieKeys = JSON.parse(env.CANONRY_GATEWAY_COOKIE_KEYS ?? 'null') as unknown }
  catch { throw new Error('CANONRY_GATEWAY_COOKIE_KEYS must be a JSON array of cookie signing keys') }
  const cookieKeys = z.array(z.string().min(32)).min(1).parse(rawCookieKeys)
  return { configPath, vaultKey, cookieKeys }
}
