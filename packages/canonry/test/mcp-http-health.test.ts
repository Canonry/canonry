import Fastify from 'fastify'
import { expect, it, onTestFinished } from 'vitest'
import { mcpHttpHealth, mcpTransportPaths } from '../src/mcp-http.js'

function mountTransport(app: ReturnType<typeof Fastify>, prefix: string): void {
  for (const url of mcpTransportPaths()) {
    for (const method of ['POST', 'GET', 'DELETE'] as const) {
      app.route({ method, url: `${prefix}${url}`, handler: async () => ({}) })
    }
  }
}

it.each(['/api/v1', '/canonry/api/v1'])('checks all MCP segments under %s', async prefix => {
  const app = Fastify()
  onTestFinished(() => app.close())
  expect(mcpHttpHealth(app, prefix)).toEqual({ status: 'unavailable' })
  for (const url of mcpTransportPaths()) {
    app.post(`${prefix}${url}`, async () => ({}))
    app.get(`${prefix}${url}`, async () => ({}))
  }
  expect(mcpHttpHealth(app, prefix)).toEqual({ status: 'unavailable' })
  for (const url of mcpTransportPaths()) app.delete(`${prefix}${url}`, async () => ({}))
  await app.ready()
  expect(mcpHttpHealth(app, prefix)).toEqual({ status: 'available' })
  expect(mcpHttpHealth(app, '/wrong-prefix')).toEqual({ status: 'unavailable' })
})

it.each(['/', '/canonry/'])('reports hosted prerequisites and the exact instance URL under %s', async basePath => {
  const app = Fastify()
  onTestFinished(() => app.close())
  const prefix = `${basePath}api/v1`
  const authorizationPath = `${basePath}oauth/authorize`
  const hosted = { publicUrl: `https://tenant.example${basePath}`, hasAccounts: true, authorizationPath }
  expect(mcpHttpHealth(app, prefix, hosted)).toEqual({
    status: 'unavailable', hosted: { status: 'unavailable', reason: 'transport-unavailable' },
  })
  mountTransport(app, prefix)
  expect(mcpHttpHealth(app, prefix, hosted)).toEqual({
    status: 'available', hosted: { status: 'unavailable', reason: 'oauth-unavailable' },
  })
  app.get(authorizationPath, async () => ({}))
  for (const url of [authorizationPath, '/oauth/token', '/oauth/register']) app.post(url, async () => ({}))
  app.get('/.well-known/oauth-authorization-server', async () => ({}))
  app.get(`/.well-known/oauth-protected-resource${prefix}/mcp`, async () => ({}))
  // A sign-in page and token endpoint without the consent POST cannot authorize a client.
  expect(mcpHttpHealth(app, prefix, hosted)).toEqual({
    status: 'available', hosted: { status: 'unavailable', reason: 'oauth-unavailable' },
  })
  app.post(`${authorizationPath}/consent`, async () => ({}))
  await app.ready()
  expect(mcpHttpHealth(app, prefix, { ...hosted, hasAccounts: false })).toEqual({
    status: 'available', hosted: { status: 'unavailable', reason: 'account-required' },
  })
  expect(mcpHttpHealth(app, prefix, hosted)).toEqual({
    status: 'available', hosted: { status: 'ready', url: `https://tenant.example${prefix}/mcp` },
  })
  expect(mcpHttpHealth(app, prefix, { ...hosted, publicUrl: 'https://tenant.example/different-prefix/' })).toEqual({
    status: 'available', hosted: { status: 'unavailable', reason: 'public-path-mismatch' },
  })
})

it.each([
  [undefined, 'public-url-required'],
  ['not-a-url', 'public-url-required'],
  ['https://user:secret@tenant.example/canonry/', 'public-url-required'],
  ['https://tenant.example/canonry/?key=secret', 'public-url-required'],
  ['https://tenant.example/canonry/#secret', 'public-url-required'],
  ['http://tenant.example/canonry/', 'https-required'],
  ['https://localhost/canonry/', 'public-host-required'],
  ['https://private.localhost/canonry/', 'public-host-required'],
  ['https://private.local/canonry/', 'public-host-required'],
  ['https://private/canonry/', 'public-host-required'],
  ['https://127.0.0.1/canonry/', 'public-host-required'],
  ['https://[::1]/canonry/', 'public-host-required'],
  ['https://192.168.1.10/canonry/', 'public-host-required'],
] as const)('does not advertise hosted readiness for %s', async (publicUrl, reason) => {
  const app = Fastify()
  onTestFinished(() => app.close())
  mountTransport(app, '/canonry/api/v1')
  await app.ready()
  const actual = mcpHttpHealth(app, '/canonry/api/v1', { publicUrl, hasAccounts: true, authorizationPath: '/canonry/oauth/authorize' })
  expect(actual).toEqual({ status: 'available', hosted: { status: 'unavailable', reason } })
})
