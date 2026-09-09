import Fastify from 'fastify'
import { expect, it, onTestFinished } from 'vitest'
import { mcpHttpHealth, mcpTransportPaths } from '../src/mcp-http.js'

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
