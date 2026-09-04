import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, expect, test, vi } from 'vitest'
import { createClient, apiKeys, migrate, projects, queries, researchRunQueries, researchRuns, runs } from '@ainyc/canonry-db'
import { engineRouteConfigSchema, normalizeEngineConnection } from '@ainyc/canonry-contracts'
import { loadConfig } from '../src/config.js'
import { JobRunner } from '../src/job-runner.js'
import { createServer } from '../src/server.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('server settings preserve omitted connection secrets and own dynamic route revisions', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-engine-route-server-'))
  temporaryDirectories.push(configDir)
  vi.stubEnv('CANONRY_CONFIG_DIR', configDir)
  vi.stubEnv('CANONRY_TELEMETRY_DISABLED', '1')

  const dbPath = path.join(configDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)
  const apiKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
  db.insert(apiKeys).values({
    id: crypto.randomUUID(),
    name: 'test',
    keyHash: crypto.createHash('sha256').update(apiKey).digest('hex'),
    keyPrefix: apiKey.slice(0, 9),
    scopes: ['*'],
    createdAt: new Date().toISOString(),
  }).run()

  const connection = normalizeEngineConnection({
    id: 'gateway-one', label: 'Gateway one', preset: 'openrouter', apiKey: 'persist-me',
    quota: { maxConcurrency: 2, maxRequestsPerMinute: 20, maxRequestsPerDay: 100 },
  })
  const config = {
    apiUrl: 'http://localhost:4100',
    database: dbPath,
    apiKey,
    providers: {
      openai: {
        apiKey: 'native-openai-key',
        quota: { maxConcurrency: 1, maxRequestsPerMinute: 10, maxRequestsPerDay: 100 },
      },
    },
    engineRoutes: { connections: [connection] },
  }
  fs.writeFileSync(path.join(configDir, 'config.yaml'), JSON.stringify(config), 'utf8')
  const app = await createServer({ config, db, logger: false })
  await app.ready()

  try {
    const connectionUpdate = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/engine-connections/gateway-one',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        label: 'Gateway one updated',
        preset: 'openrouter',
        quota: { maxConcurrency: 1, maxRequestsPerMinute: 10, maxRequestsPerDay: 50 },
      },
    })
    expect(connectionUpdate.statusCode).toBe(200)
    expect(connectionUpdate.body).not.toContain('persist-me')
    expect(config.engineRoutes.connections[0]?.apiKey).toBe('persist-me')
    expect(loadConfig().engineRoutes?.connections?.[0]?.apiKey).toBe('persist-me')

    const createRoute = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/engine-routes/route:gateway-one:gpt',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { label: 'GPT', connectionId: 'gateway-one', modelId: 'openai/gpt-5.4' },
    })
    expect(createRoute.statusCode).toBe(200)
    expect(createRoute.json()).toMatchObject({
      id: 'route:gateway-one:gpt', revision: 1, source: 'configured', capabilities: { kind: 'text-only' },
    })

    const cosmeticUpdate = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/engine-routes/route:gateway-one:gpt',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { label: 'GPT analysis', connectionId: 'gateway-one', modelId: 'openai/gpt-5.4' },
    })
    expect(cosmeticUpdate.statusCode).toBe(200)
    expect(cosmeticUpdate.json()).toMatchObject({ revision: 1 })

    const modelUpdate = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/engine-routes/route:gateway-one:gpt',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { label: 'GPT analysis', connectionId: 'gateway-one', modelId: 'openai/gpt-5.5' },
    })
    expect(modelUpdate.statusCode).toBe(200)
    expect(modelUpdate.json()).toMatchObject({ revision: 2 })

    const rejectedEndpointUpdate = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/engine-connections/gateway-one',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        label: 'Gateway one updated', preset: 'custom-openai-compatible', baseUrl: 'https://gateway.example/v1',
        quota: { maxConcurrency: 1, maxRequestsPerMinute: 10, maxRequestsPerDay: 50 },
      },
    })
    expect(rejectedEndpointUpdate.statusCode).toBe(400)
    expect(rejectedEndpointUpdate.json().error.message).toMatch(/explicit apiKey/i)
    expect(config.engineRoutes.connections[0]).toMatchObject({
      baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'persist-me',
    })

    const endpointUpdate = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/engine-connections/gateway-one',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        label: 'Gateway one updated', preset: 'custom-openai-compatible', baseUrl: 'https://gateway.example/v1',
        apiKey: 'replacement-secret',
        quota: { maxConcurrency: 1, maxRequestsPerMinute: 10, maxRequestsPerDay: 50 },
      },
    })
    expect(endpointUpdate.statusCode).toBe(200)
    expect(config.engineRoutes.connections[0]?.apiKey).toBe('replacement-secret')

    const settings = await app.inject({
      method: 'GET',
      url: '/api/v1/settings',
      headers: { authorization: `Bearer ${apiKey}` },
    })
    expect(settings.statusCode).toBe(200)
    expect(settings.body).not.toContain('persist-me')
    expect(settings.body).not.toContain('replacement-secret')
    expect(settings.json().engineConnections).toEqual([
      expect.objectContaining({ id: 'gateway-one', secretConfigured: true }),
    ])
    expect(settings.json().engineRoutes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'route:gateway-one:gpt', revision: 3, capabilities: { kind: 'text-only' } }),
      expect.objectContaining({
        id: 'native:openai',
        source: 'implicit-native',
        capabilities: {
          kind: 'verified-measurement',
          retrieval: true,
          citations: true,
          location: true,
          servedModel: true,
          fallback: 'disabled',
        },
      }),
    ]))
  } finally {
    await app.close()
  }
})

test('native endpoint changes create a new queue-time execution identity without credential churn', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-native-endpoint-identity-'))
  temporaryDirectories.push(configDir)
  vi.stubEnv('CANONRY_CONFIG_DIR', configDir)
  vi.stubEnv('CANONRY_TELEMETRY_DISABLED', '1')

  const dbPath = path.join(configDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)
  const apiKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
  db.insert(apiKeys).values({
    id: crypto.randomUUID(), name: 'test', keyHash: crypto.createHash('sha256').update(apiKey).digest('hex'),
    keyPrefix: apiKey.slice(0, 9), scopes: ['*'], createdAt: new Date().toISOString(),
  }).run()
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: 'native-endpoint-project', name: 'native-endpoint', displayName: 'Native endpoint', canonicalDomain: 'example.com',
    country: 'US', language: 'en', providers: ['openai'], createdAt: now, updatedAt: now,
  }).run()
  db.insert(queries).values({
    id: 'native-endpoint-query', projectId: 'native-endpoint-project', query: 'Who sells widgets?', createdAt: now,
  }).run()

  const config = {
    apiUrl: 'http://localhost:4100', database: dbPath, apiKey,
    providers: {
      openai: {
        apiKey: 'native-secret-before', baseUrl: 'https://gateway-one.example/v1', model: 'gpt-5.4',
        quota: { maxConcurrency: 1, maxRequestsPerMinute: 10, maxRequestsPerDay: 100 },
      },
    },
  }
  fs.writeFileSync(path.join(configDir, 'config.yaml'), JSON.stringify(config), 'utf8')
  const executeRun = vi.spyOn(JobRunner.prototype, 'executeRun').mockResolvedValue(undefined)
  const app = await createServer({ config, db, logger: false })
  await app.ready()

  const queueRun = () => app.inject({
    method: 'POST', url: '/api/v1/projects/native-endpoint/runs', headers: { authorization: `Bearer ${apiKey}` },
  })
  try {
    const firstResponse = await queueRun()
    expect(firstResponse.statusCode).toBe(201)
    const first = db.select().from(runs).all().find(row => row.id === firstResponse.json().id)!
    expect(first.measurementExecutionIdentity).toMatchObject({
      schemaVersion: 2,
      routes: { openai: { routeId: 'native:openai', routeRevision: 1 } },
    })
    db.update(runs).set({ status: 'completed' }).where(eq(runs.id, first.id)).run()

    const endpointUpdate = await app.inject({
      method: 'PUT', url: '/api/v1/settings/providers/openai', headers: { authorization: `Bearer ${apiKey}` },
      payload: { apiKey: 'native-secret-after', baseUrl: 'https://gateway-two.example/v1', model: 'gpt-5.4' },
    })
    expect(endpointUpdate.statusCode).toBe(200)

    const secondResponse = await queueRun()
    expect(secondResponse.statusCode).toBe(201)
    const second = db.select().from(runs).all().find(row => row.id === secondResponse.json().id)!
    expect(second.measurementExecutionIdentity).toMatchObject({
      schemaVersion: 2,
      routes: { openai: { routeId: 'native:openai', routeRevision: 1 } },
    })
    expect(second.measurementExecutionIdentity!.routes.openai!.policyFingerprint)
      .not.toBe(first.measurementExecutionIdentity!.routes.openai!.policyFingerprint)
    expect(second.measurementExecutionIdentity!.checksum).not.toBe(first.measurementExecutionIdentity!.checksum)
    expect(JSON.stringify(second.measurementExecutionIdentity)).not.toContain('native-secret-after')
    db.update(runs).set({ status: 'completed' }).where(eq(runs.id, second.id)).run()

    const credentialOnlyUpdate = await app.inject({
      method: 'PUT', url: '/api/v1/settings/providers/openai', headers: { authorization: `Bearer ${apiKey}` },
      payload: { apiKey: 'native-secret-rotated', baseUrl: 'https://gateway-two.example/v1', model: 'gpt-5.4' },
    })
    expect(credentialOnlyUpdate.statusCode).toBe(200)

    const thirdResponse = await queueRun()
    expect(thirdResponse.statusCode).toBe(201)
    const third = db.select().from(runs).all().find(row => row.id === thirdResponse.json().id)!
    expect(third.measurementExecutionIdentity!.routes.openai!.policyFingerprint)
      .toBe(second.measurementExecutionIdentity!.routes.openai!.policyFingerprint)
    expect(third.measurementExecutionIdentity!.checksum).toBe(second.measurementExecutionIdentity!.checksum)
    expect(executeRun).toHaveBeenCalledTimes(3)
  } finally {
    executeRun.mockRestore()
    await app.close()
  }
})

test('server model catalog route uses only GET /models against the configured gateway', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-engine-route-catalog-'))
  temporaryDirectories.push(configDir)
  vi.stubEnv('CANONRY_CONFIG_DIR', configDir)
  vi.stubEnv('CANONRY_TELEMETRY_DISABLED', '1')

  const requests: Array<{ method?: string; url?: string; authorization?: string; body: string }> = []
  const gateway = http.createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body })
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ data: [{ id: 'openai/gpt-5.4', owned_by: 'openai' }] }))
  })
  await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve))
  const address = gateway.address()
  if (!address || typeof address === 'string') throw new Error('Expected fake gateway TCP address')

  const dbPath = path.join(configDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)
  const apiKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
  db.insert(apiKeys).values({
    id: crypto.randomUUID(), name: 'test', keyHash: crypto.createHash('sha256').update(apiKey).digest('hex'),
    keyPrefix: apiKey.slice(0, 9), scopes: ['*'], createdAt: new Date().toISOString(),
  }).run()
  const config = {
    apiUrl: 'http://localhost:4100', database: dbPath, apiKey, providers: {},
    engineRoutes: { connections: [normalizeEngineConnection({
      id: 'gateway-one', label: 'Gateway', preset: 'custom-openai-compatible',
      baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'catalog-secret',
      quota: { maxConcurrency: 1, maxRequestsPerMinute: 10, maxRequestsPerDay: 100 },
    })] },
  }
  const app = await createServer({ config, db, logger: false })
  await app.ready()
  try {
    const response = await app.inject({
      method: 'GET', url: '/api/v1/settings/engine-connections/gateway-one/models',
      headers: { authorization: `Bearer ${apiKey}` },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      connectionId: 'gateway-one', state: 'available', manualModelIdAllowed: true,
      models: [{ id: 'openai/gpt-5.4', provider: 'openai' }],
    })
    expect(response.body).not.toContain('catalog-secret')
    expect(requests).toEqual([{
      method: 'GET', url: '/v1/models', authorization: 'Bearer catalog-secret', body: '',
    }])
  } finally {
    await app.close()
    await new Promise<void>((resolve, reject) => gateway.close(error => error ? reject(error) : resolve()))
  }
})

test('research API selects a persisted text route and stores no invented evidence', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-engine-route-research-'))
  temporaryDirectories.push(configDir)
  vi.stubEnv('CANONRY_CONFIG_DIR', configDir)
  vi.stubEnv('CANONRY_TELEMETRY_DISABLED', '1')

  const calls: Array<{ method?: string; url?: string; model?: string }> = []
  const gateway = http.createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const parsed = body ? JSON.parse(body) as { model?: string } : {}
    calls.push({ method: request.method, url: request.url, model: parsed.model })
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: {"id":"fake-response","choices":[{"delta":{"content":"Acme is a text answer"},"finish_reason":null}]}\n\n')
    response.write('data: {"id":"fake-response","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
    response.end('data: [DONE]\n\n')
  })
  await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve))
  const address = gateway.address()
  if (!address || typeof address === 'string') throw new Error('Expected fake gateway TCP address')

  const dbPath = path.join(configDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)
  const apiKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
  db.insert(apiKeys).values({
    id: crypto.randomUUID(), name: 'test', keyHash: crypto.createHash('sha256').update(apiKey).digest('hex'),
    keyPrefix: apiKey.slice(0, 9), scopes: ['*'], createdAt: new Date().toISOString(),
  }).run()
  const connection = normalizeEngineConnection({
    id: 'gateway-one', label: 'Gateway', preset: 'custom-openai-compatible',
    baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'route-secret',
    quota: { maxConcurrency: 1, maxRequestsPerMinute: 10, maxRequestsPerDay: 100 },
  })
  const route = engineRouteConfigSchema.parse({
    id: 'route:gateway-one:fake', label: 'Fake route', connectionId: connection.id, modelId: 'fake-model',
    revision: 1, source: 'configured', capabilities: { kind: 'text-only' },
  })
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: 'project-one', name: 'acme', displayName: 'Acme', canonicalDomain: 'acme.example', country: 'US', language: 'en',
    researchProvider: route.id, createdAt: now, updatedAt: now,
  }).run()
  const config = {
    apiUrl: 'http://localhost:4100', database: dbPath, apiKey, providers: {},
    engineRoutes: { connections: [connection], routes: [route] },
  }
  const app = await createServer({ config, db, logger: false })
  await app.ready()
  try {
    const created = await app.inject({
      method: 'POST', url: '/api/v1/projects/acme/research/runs', headers: { authorization: `Bearer ${apiKey}` },
      payload: { queries: ['Explain Acme'] },
    })
    expect(created.statusCode).toBe(202)
    const runId = created.json().id as string
    for (let attempt = 0; attempt < 50; attempt++) {
      if (db.select().from(researchRuns).all().find(row => row.id === runId)?.status === 'completed') break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    const run = db.select().from(researchRuns).all().find(row => row.id === runId)!
    const [answer] = db.select().from(researchRunQueries).all().filter(row => row.researchRunId === runId)
    expect(run.status).toBe('completed')
    expect(answer).toMatchObject({
      answerText: 'Acme is a text answer', groundingSources: [], citedDomains: [], searchQueries: [],
      citedCompetitorDomains: [], citationState: null, servedModel: null,
    })
    expect(calls).toEqual([{ method: 'POST', url: '/v1/chat/completions', model: 'fake-model' }])
  } finally {
    await app.close()
    await new Promise<void>((resolve, reject) => gateway.close(error => error ? reject(error) : resolve()))
  }
})
