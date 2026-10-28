import { describe, expect, it } from 'vitest'
import { gatewayConfigSchema, readGatewayEnv } from '../src/mcp-gateway.js'

const tenant = {
  id: 'example', displayName: 'Example workspace', origin: 'https://example.canonry.ai',
  issuer: 'https://example.canonry.ai', resource: 'https://example.canonry.ai/api/v1/mcp',
  mcpUrl: 'https://example.canonry.ai/api/v1/mcp/readonly', enabled: true,
  protocolVersions: ['2025-03-26'], catalogVersion: 'canonry-readonly-v1',
}
const config = {
  issuer: 'https://mcp.canonry.ai', databasePath: '/data/gateway.sqlite',
  tenants: [tenant], clients: [{ client_id: 'chatgpt', client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/connector/callback'] }],
}

describe('gateway host configuration', () => {
  it('requires production HTTPS, durable storage and provisioned same-origin read-only routing', () => {
    expect(gatewayConfigSchema.parse(config).tenants[0]?.allowPrivateNetwork).toBe(false)
    for (const patch of [
      { issuer: 'http://mcp.canonry.ai' },
      { databasePath: ':memory:' },
      { tenants: [{ ...tenant, mcpUrl: 'https://example.canonry.ai/api/v1/mcp' }] },
      { tenants: [{ ...tenant, resource: tenant.mcpUrl }] },
      { tenants: [{ ...tenant, mcpUrl: 'https://other.canonry.ai/api/v1/mcp/readonly' }] },
      { tenants: [tenant, tenant] },
      { clients: [config.clients[0], config.clients[0]] },
      { clients: [{ ...config.clients[0], redirect_uris: ['https://chatgpt.com/callback#fragment'] }] },
    ]) expect(gatewayConfigSchema.safeParse({ ...config, ...patch }).success).toBe(false)
  })

  it('allows explicit loopback development without permitting arbitrary HTTP origins', () => {
    const development = {
      ...config, development: true, issuer: 'http://127.0.0.1:4101', databasePath: ':memory:',
      tenants: [{ ...tenant, origin: 'http://127.0.0.1:4100', issuer: 'http://127.0.0.1:4100', resource: 'http://127.0.0.1:4100/api/v1/mcp', mcpUrl: 'http://127.0.0.1:4100/api/v1/mcp/readonly' }],
      clients: [{ ...config.clients[0], redirect_uris: ['http://localhost:5100/callback'] }],
    }
    expect(gatewayConfigSchema.safeParse(development).success).toBe(true)
    expect(gatewayConfigSchema.safeParse({ ...development, development: false }).success).toBe(false)
    expect(gatewayConfigSchema.safeParse({ ...development, issuer: 'http://example.com' }).success).toBe(false)
  })

  it('requires separate explicit vault and cookie secrets with no fallback', () => {
    const env = {
      CANONRY_GATEWAY_CONFIG: '/run/secrets/gateway.json',
      CANONRY_GATEWAY_VAULT_KEY: Buffer.alloc(32, 17).toString('base64'),
      CANONRY_GATEWAY_COOKIE_KEYS: JSON.stringify(['cookie-secret-with-at-least-32-characters']),
    }
    expect(readGatewayEnv(env).vaultKey).toEqual(Buffer.alloc(32, 17))
    expect(readGatewayEnv(env).configPath).toBe('/run/secrets/gateway.json')
    for (const key of Object.keys(env)) expect(() => readGatewayEnv({ ...env, [key]: undefined })).toThrow()
    expect(() => readGatewayEnv({ ...env, CANONRY_GATEWAY_COOKIE_KEYS: '["short"]' })).toThrow()
    expect(() => readGatewayEnv({ ...env, CANONRY_GATEWAY_VAULT_KEY: Buffer.alloc(16).toString('base64') })).toThrow()
    expect(() => readGatewayEnv({ ...env, CANONRY_GATEWAY_COOKIE_KEYS: 'unquoted-secret-value' })).toThrow('must be a JSON array')
  })
})
