import { test, expect, onTestFinished, beforeEach, afterEach } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { getPlatformEnv } from '@ainyc/canonry-config'
import { PROVIDER_NAMES } from '@ainyc/canonry-contracts'
import { createClient, migrate, apiKeys, queries, runs } from '@ainyc/canonry-db'

import { buildApp, cloudEngineRouteCapabilities } from '../src/app.js'
import { loadApiEnv } from '../src/plugins/env.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(__dirname, '..', '..', '..')

const ORIGINAL_CANONRY_TRUST_PROXY = process.env.CANONRY_TRUST_PROXY

beforeEach(() => {
  // Every test below exercises `buildApp` over `.inject()`, which never
  // touches a real socket — declare this deployment has nothing in front of
  // it so those tests stay about what they say they're about. The one test
  // that IS about this requirement removes it again itself.
  process.env.CANONRY_TRUST_PROXY = 'false'
})

afterEach(() => {
  if (ORIGINAL_CANONRY_TRUST_PROXY === undefined) delete process.env.CANONRY_TRUST_PROXY
  else process.env.CANONRY_TRUST_PROXY = ORIGINAL_CANONRY_TRUST_PROXY
})

/**
 * The provider names in `API_ADAPTERS` + `BROWSER_ADAPTERS`
 * (`packages/canonry/src/server.ts`) — the registry local `canonry serve`
 * validates writes against — read from source rather than imported.
 *
 * apps/api deliberately does not depend on `@ainyc/canonry`: importing
 * `server.ts` pulls every provider SDK graph, which is the whole reason the
 * cloud catalog in `src/app.ts` is hand-mirrored in the first place. A
 * test-only workspace dependency would drag the same graphs into CI. So the
 * registry is parsed as text, the same technique as
 * `packages/api-routes/test/no-new-loose-routes.test.ts`.
 *
 * Every step asserts it matched, so a refactor that moves or reshapes the
 * registry fails this test loudly instead of silently pinning nothing.
 */
function registeredAdapterNames(): string[] {
  const server = fs.readFileSync(
    path.join(REPO_ROOT, 'packages', 'canonry', 'src', 'server.ts'),
    'utf8',
  )

  const identifiers: string[] = []
  for (const arrayName of ['API_ADAPTERS', 'BROWSER_ADAPTERS']) {
    const declaration = server.match(
      new RegExp(`const ${arrayName}: ProviderAdapter\\[\\] = \\[([^\\]]*)\\]`),
    )
    expect(
      declaration,
      `${arrayName} was not found in packages/canonry/src/server.ts — the adapter registry moved, update this pin`,
    ).not.toBeNull()
    identifiers.push(
      ...declaration![1]!.split(',').map(entry => entry.trim()).filter(Boolean),
    )
  }
  expect(identifiers.length).toBeGreaterThan(0)

  return identifiers.map(identifier => {
    // e.g. `import { openaiAdapter } from "@ainyc/canonry-provider-openai";`
    // (the gemini import is a multi-name block, hence the `[^}]*` on both sides).
    const importSite = server.match(
      new RegExp(
        `import\\s*\\{[^}]*\\b${identifier}\\b[^}]*\\}\\s*from\\s*["']@ainyc/canonry-provider-([\\w-]+)["']`,
      ),
    )
    expect(
      importSite,
      `could not resolve which provider package ${identifier} comes from`,
    ).not.toBeNull()
    const packageDir = `provider-${importSite![1]!}`
    const adapter = fs.readFileSync(
      path.join(REPO_ROOT, 'packages', packageDir, 'src', 'adapter.ts'),
      'utf8',
    )
    const name = adapter.match(/^ {0,4}name: '([^']+)',$/m)
    expect(name, `no adapter name literal in packages/${packageDir}/src/adapter.ts`).not.toBeNull()
    return name![1]!
  })
}

test('buildApp refuses to start when CANONRY_TRUST_PROXY is not set', () => {
  // A cloud deployment always sits behind at least one load balancer, so
  // leaving this unset does not mean "no proxy" — it means every caller
  // resolves to the load balancer's own address and every per-caller
  // rate-limit / login budget collapses into one shared bucket. That must be
  // an explicit operator decision, not a silent default.
  delete process.env.CANONRY_TRUST_PROXY
  const env = getPlatformEnv({})
  expect(() => buildApp(env)).toThrow(/CANONRY_TRUST_PROXY/)
})

test('cloud route policy treats compatibility providers as text-only unless the server owns verified evidence', () => {
  expect(cloudEngineRouteCapabilities('openai')).toMatchObject({
    kind: 'verified-measurement', retrieval: true, citations: true, location: true, servedModel: true,
  })
  expect(cloudEngineRouteCapabilities('local')).toEqual({ kind: 'text-only' })
  expect(cloudEngineRouteCapabilities('future-gateway')).toEqual({ kind: 'text-only' })
})

test('buildApp registers health and API routes', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-test-'))
  const dbPath = path.join(tmpDir, 'test.db')

  onTestFinished(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // Pre-create and migrate the database
  const db = createClient(dbPath)
  migrate(db)

  const env = getPlatformEnv({
    DATABASE_URL: dbPath,
    API_PORT: '3000',
    WORKER_PORT: '3001',
    GOOGLE_STATE_SECRET: 'test-only-google-state-secret-32b',
  })
  const app = buildApp(env)

  onTestFinished(async () => {
    await app.close()
  })

  const healthResponse = await app.inject({
    method: 'GET',
    url: '/health',
  })
  expect(healthResponse.statusCode).toBe(200)
  expect(healthResponse.json()).toMatchObject({
    service: 'canonry',
    status: 'ok',
    version: '0.1.0',
    port: 3000,
    basePath: '/',
    databaseUrlConfigured: true,
  })
  expect(healthResponse.json().lastHeartbeatAt).toBeDefined()

  // API routes are registered — projects endpoint is available
  const projectsResponse = await app.inject({
    method: 'GET',
    url: '/api/v1/projects',
  })
  // Auth or success — either way, the route exists (not 404)
  expect(
    [200, 401].includes(projectsResponse.statusCode),
  ).toBeTruthy()

  const openApiResponse = await app.inject({
    method: 'GET',
    url: '/api/v1/openapi.json',
  })
  expect(openApiResponse.statusCode).toBe(200)
  expect(openApiResponse.json().info.version).toBe('0.1.0')
})

test('PROVIDER_NAMES enumerates exactly the registered execution adapters', () => {
  // The missing hop. `cloud accepts every registered provider name` (below)
  // pins the cloud catalog against `PROVIDER_NAMES`; without this test
  // `PROVIDER_NAMES` itself was pinned against nothing, so adding an adapter
  // to `API_ADAPTERS` / `BROWSER_ADAPTERS` and forgetting the contract would
  // leave the whole chain green while Cloud rejected the new provider. The two
  // tests together are what makes "the cloud list names every registered
  // adapter" an enforced invariant rather than a comment.
  expect([...registeredAdapterNames()].sort()).toEqual([...PROVIDER_NAMES].sort())
})

test('cloud accepts every registered provider name', async () => {
  // The cloud provider catalog is hand-mirrored (apps/api must not pull the
  // provider SDK graphs), and `apiRoutes` turns its NAMES into the allowlist
  // enforced on project / query / run / apply / schedule writes. A name missing
  // here silently makes that provider unwritable on Cloud while local `canonry
  // serve` — which validates against all registered adapters — still accepts
  // it. Pin the catalog against `PROVIDER_NAMES` so a future hand-edit cannot
  // reintroduce the drift; the test above pins `PROVIDER_NAMES` against the
  // adapter registry, which is what closes the chain back to `canonry serve`.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-providers-test-'))
  const dbPath = path.join(tmpDir, 'test.db')

  onTestFinished(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const db = createClient(dbPath)
  migrate(db)

  const rawKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
  db.insert(apiKeys).values({
    id: crypto.randomUUID(),
    name: 'test',
    keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'),
    keyPrefix: rawKey.slice(0, 9),
    scopes: ['*'],
    createdAt: new Date().toISOString(),
  }).run()

  const app = buildApp(getPlatformEnv({
    DATABASE_URL: dbPath,
    API_PORT: '3000',
    WORKER_PORT: '3001',
    GOOGLE_STATE_SECRET: 'test-only-google-state-secret-32b',
  }))

  onTestFinished(async () => {
    await app.close()
  })

  const settings = await app.inject({
    method: 'GET',
    url: '/api/v1/settings',
    headers: { authorization: `Bearer ${rawKey}` },
  })
  expect(settings.statusCode).toBe(200)
  const catalogNames = settings.json().providerCatalog.map((entry: { name: string }) => entry.name)
  expect([...catalogNames].sort()).toEqual([...PROVIDER_NAMES].sort())

  // The allowlist is what actually 400s a write, so exercise it end to end.
  const upsert = await app.inject({
    method: 'PUT',
    url: '/api/v1/projects/acme',
    headers: { authorization: `Bearer ${rawKey}` },
    payload: {
      displayName: 'Acme',
      canonicalDomain: 'acme.example',
      country: 'US',
      language: 'en',
      providers: [...PROVIDER_NAMES],
    },
  })
  expect(upsert.statusCode).toBe(201)
  expect(upsert.json().providers).toEqual([...PROVIDER_NAMES])
})

test('loadApiEnv delegates to shared platform config', () => {
  const env = loadApiEnv({
    DATABASE_URL: 'postgresql://aeo:aeo@localhost:5432/aeo_platform',
    API_PORT: '4100',
    WORKER_PORT: '4101',
    WEB_PORT: '4173',
    CANONRY_BASE_PATH: '/canonry',
    BOOTSTRAP_SECRET: 'secret',
    GEMINI_API_KEY: 'gemini-key',
    GEMINI_MAX_CONCURRENCY: '4',
    GEMINI_MAX_REQUESTS_PER_MINUTE: '15',
    GEMINI_MAX_REQUESTS_PER_DAY: '500',
  })

  expect(env.apiPort).toBe(4100)
  expect(env.workerPort).toBe(4101)
  expect(env.basePath).toBe('/canonry')
  expect(env.bootstrapSecret).toBe('secret')
  expect(env.providers.gemini).toBeTruthy()
  expect(env.providers.gemini!.quota).toEqual({
    maxConcurrency: 4,
    maxRequestsPerMinute: 15,
    maxRequestsPerDay: 500,
  })
})

test('a plan-pinned run queued on Cloud freezes the inherited provider model into its execution identity', async () => {
  // No GEMINI_MODEL is set here — gemini is configured only via its API key,
  // so the model that will actually answer is the adapter's own inherited
  // default. That inherited value is exactly what `getEffectiveProviderModels`
  // exists to surface at queue time; if the callback is never wired up, the
  // model half of the run's execution identity comes back empty on Cloud
  // even though the provider roster half is populated.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-identity-test-'))
  const dbPath = path.join(tmpDir, 'test.db')

  onTestFinished(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const db = createClient(dbPath)
  migrate(db)

  const rawKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
  db.insert(apiKeys).values({
    id: crypto.randomUUID(),
    name: 'test',
    keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'),
    keyPrefix: rawKey.slice(0, 9),
    scopes: ['*'],
    createdAt: new Date().toISOString(),
  }).run()

  const app = buildApp(getPlatformEnv({
    DATABASE_URL: dbPath,
    API_PORT: '3000',
    WORKER_PORT: '3001',
    GOOGLE_STATE_SECRET: 'test-only-google-state-secret-32b',
    GEMINI_API_KEY: 'gemini-test-key',
  }))

  onTestFinished(async () => {
    await app.close()
  })

  const auth = { authorization: `Bearer ${rawKey}` }

  const upsert = await app.inject({
    method: 'PUT',
    url: '/api/v1/projects/cloud-identity',
    headers: auth,
    payload: {
      displayName: 'Location 001',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
      providers: ['gemini'],
    },
  })
  expect(upsert.statusCode).toBe(201)

  const trackedQuery = await app.inject({
    method: 'POST',
    url: '/api/v1/projects/cloud-identity/queries',
    headers: auth,
    payload: { queries: ['widget pricing'] },
  })
  expect(trackedQuery.statusCode).toBe(200)
  const queryId = db.select({ id: queries.id }).from(queries).all()[0]!.id

  const published = await app.inject({
    method: 'PUT',
    url: '/api/v1/projects/cloud-identity/measurement-plan',
    headers: auth,
    payload: {
      expectedActiveRevision: null,
      plan: {
        schemaVersion: 1,
        targets: [{
          stableKey: 'main',
          label: 'Main',
          urls: [{ kind: 'prefix', host: 'example.com', pathPrefix: '/', pathCase: 'insensitive' }],
          aliases: ['Main Branch'],
        }],
        groups: [{ stableKey: 'all', label: 'All', targetKeys: ['main'] }],
        targetQuerySelections: [{ targetKey: 'main', queryIds: [queryId] }],
      },
    },
  })
  expect(published.statusCode).toBe(201)

  const triggered = await app.inject({
    method: 'POST',
    url: '/api/v1/projects/cloud-identity/runs',
    headers: auth,
  })
  expect(triggered.statusCode).toBe(201)
  const runId = (triggered.json() as { id: string }).id

  const run = db.select().from(runs).all().find(row => row.id === runId)!
  expect(run.measurementExecutionIdentity).not.toBeNull()
  expect(run.measurementExecutionIdentity!.providers).toEqual(['gemini'])
  // The inherited default, not an empty object — this is the assertion that
  // fails when apps/api omits `getEffectiveProviderModels`.
  expect(run.measurementExecutionIdentity!.models).toEqual({ gemini: 'gemini-2.5-flash' })
  expect(run.measurementExecutionIdentity).toMatchObject({
    schemaVersion: 2,
    routes: {
      gemini: {
        routeId: 'native:gemini',
        routeRevision: 1,
        requestedProvider: 'gemini',
        requestedModel: 'gemini-2.5-flash',
        policyFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    },
  })
})
