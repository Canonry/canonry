import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { apiRoutes, hashApiKey } from '@ainyc/canonry-api-routes'
import { apiKeys, createClient, migrate, projects, runs } from '@ainyc/canonry-db'
import { doctorReportSchema } from '@ainyc/canonry-contracts'
import { ApiClient } from '../src/client.js'
import { createCanonryMcpServer } from '../src/mcp/server.js'
import { dispatchRegisteredCommand } from '../src/cli-dispatch.js'
import { DOCTOR_CLI_COMMANDS } from '../src/cli-commands/doctor.js'

it('smokes report month across authenticated API, CLI dispatch and MCP over a temp database', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-report-smoke-'))
  const database = path.join(dir, 'test.db')
  const db = createClient(database)
  migrate(db)
  const now = new Date().toISOString()
  for (const name of ['demo', 'other']) db.insert(projects).values({ id: name, name, displayName: name, canonicalDomain: `${name}.example`, country: 'US', language: 'en', providers: ['openai'], createdAt: '2026-01-01T00:00:00Z', updatedAt: now }).run()
  const token = 'cnry_report_smoke'
  db.insert(apiKeys).values({ id: 'read-key', name: 'Report reader', keyHash: hashApiKey(token), keyPrefix: 'cnry_repo', scopes: ['read'], projectId: 'demo', createdAt: now }).run()
  const app = Fastify()
  app.register(apiRoutes, { db, routePrefix: '/canonry/api/v1' })
  let mcp: Client | undefined
  let server: ReturnType<typeof createCanonryMcpServer> | undefined
  try {
    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address()
    if (!address || typeof address === 'string') throw new Error('No fixture listener')
    const origin = `http://127.0.0.1:${address.port}`
    const client = new ApiClient(`${origin}/canonry`, token, { skipProbe: true })
    const expected = doctorReportSchema.parse(await client.runDoctor({ project: 'demo', reportMonth: '2026-08', checkIds: ['report.*'] }))
    expect(expected.reportMonths).toEqual(['2026-08'])
    expect(expected.checks.map(check => check.id)).toEqual(['report.sweeps', 'report.models', 'report.daily-data'])
    expect(expected.checks.every(check => check.notificationPolicy === 'silent')).toBe(true)
    expect(expected.checks.find(check => check.id === 'report.sweeps')?.code).toBe('report.sweeps.missing')
    await expect(client.runDoctor({ project: 'other', reportMonth: '2026-08', checkIds: ['report.*'] })).rejects.toMatchObject({ code: 'FORBIDDEN', details: { httpStatus: 403 }, exitCode: 1 })
    for (const reportMonth of ['2026-13', '2026-9', '2999-01']) {
      const response = await app.inject({ method: 'GET', url: `/canonry/api/v1/projects/demo/doctor?check=report.*&reportMonth=${reportMonth}`, headers: { authorization: `Bearer ${token}` } })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
    }
    fs.writeFileSync(path.join(dir, 'config.yaml'), `apiUrl: ${origin}\nbasePath: /canonry/\napiKey: ${token}\ndatabase: ${database}\nproviders: {}\n`)
    vi.stubEnv('CANONRY_CONFIG_DIR', dir)
    vi.stubEnv('CANONRY_BASE_PATH', '/canonry/')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      expect(await dispatchRegisteredCommand(['doctor', '--project', 'demo', '--report-month', '2026-08', '--check', 'report.*', '--format', 'json'], 'json', DOCTOR_CLI_COMMANDS)).toBe(true)
      const output = doctorReportSchema.parse(JSON.parse(String(log.mock.calls.at(-1)?.[0])))
      expect(output.reportMonths).toEqual(expected.reportMonths)
      expect(output.checks.map(check => ({ id: check.id, details: check.details, status: check.status }))).toEqual(expected.checks.map(check => ({ id: check.id, details: check.details, status: check.status })))
    } finally { log.mockRestore() }
    server = createCanonryMcpServer({ clientFactory: () => client, scope: 'read-only', credentialScopes: ['read'] })
    mcp = new Client({ name: 'monthly-report-smoke', version: '1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await mcp.connect(clientTransport)
    const result = await mcp.callTool({ name: 'canonry_doctor', arguments: { project: 'demo', reportMonth: '2026-08', checks: ['report.*'] } })
    expect(result.isError).not.toBe(true)
    const output = doctorReportSchema.parse(result.structuredContent)
    expect(output.reportMonths).toEqual(expected.reportMonths)
    expect(output.checks.map(check => check.code)).toEqual(expected.checks.map(check => check.code))
    const denied = await mcp.callTool({ name: 'canonry_doctor', arguments: { project: 'other', reportMonth: '2026-08', checks: ['report.*'] } })
    expect(denied.isError).toBe(true)
    expect(db.select().from(runs).all()).toEqual([])
  } finally {
    await mcp?.close()
    await server?.close()
    await app.close()
    db.$client.close()
    vi.unstubAllEnvs()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
