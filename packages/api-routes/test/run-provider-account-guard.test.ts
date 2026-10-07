import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { buildProviderRunError, canonicalMeasurementPlanJson, compileMeasurementPlan, serializeRunError } from '@ainyc/canonry-contracts'
import { auditLog, createClient, measurementPlans, measurementPlanVersions, migrate, projects, queries, runs } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import { PROVIDER_ACCOUNT_FAILURE_STREAK } from '../src/run-queue.js'

/**
 * One install ran 7,000 answer-visibility runs over four months against
 * providers whose keys were dead or out of credit, every one of them failing
 * the same way. Run admission now refuses a run once the project's last
 * PROVIDER_ACCOUNT_FAILURE_STREAK runs all failed on provider accounts, and
 * lets anything short of that through.
 */

const BILLING = '[provider-claude] 400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'
const AUTH = '[provider-openai] 401 Incorrect API key provided'
const RATE_LIMIT = `[provider-gemini] ${JSON.stringify({ error: { code: 429, message: 'You exceeded your current quota, please check your plan and billing details.', status: 'RESOURCE_EXHAUSTED' } })}`

const harnesses: Array<{ close: () => Promise<void> }> = []
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close()
})

async function harness(options: { locations?: boolean } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-account-guard-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const created: string[] = []
  const app = Fastify()
  app.register(apiRoutes, {
    db,
    skipAuth: true,
    getRunnableProviderNames: () => ['claude', 'gemini', 'openai'],
    onRunCreated: runId => { created.push(runId) },
  })
  await app.ready()
  harnesses.push({ close: async () => { await app.close(); fs.rmSync(tmpDir, { recursive: true, force: true }) } })

  const project = await app.inject({
    method: 'PUT',
    url: '/api/v1/projects/acme',
    payload: {
      displayName: 'Acme', canonicalDomain: 'acme.example', country: 'US', language: 'en', providers: ['claude', 'openai'],
      ...(options.locations ? { locations: [{ label: 'north', city: 'North City', region: 'NC', country: 'US' }] } : {}),
    },
  })
  expect(project.statusCode).toBe(201)
  expect((await app.inject({ method: 'POST', url: '/api/v1/projects/acme/queries', payload: { queries: ['best widget'] } })).statusCode).toBe(200)
  const projectId = db.select({ id: projects.id }).from(projects).where(eq(projects.name, 'acme')).get()!.id

  let minute = 0
  /** Store finished runs the way the job runner does, oldest first. */
  const seed = (...outcomes: Array<{ status: 'failed' | 'partial' | 'completed'; errors?: Array<[string, string]>; legacy?: boolean }>) => {
    for (const outcome of outcomes) {
      minute += 1
      const errors = outcome.errors ?? []
      const error = errors.length === 0
        ? null
        : outcome.legacy
          // Stored before errors carried a code: the shape without `code`.
          ? JSON.stringify({ providers: Object.fromEntries(errors.map(([name, msg]) => [name, { message: msg }])) })
          : serializeRunError(buildProviderRunError(errors))
      db.insert(runs).values({
        id: crypto.randomUUID(), projectId, kind: 'answer-visibility', status: outcome.status, trigger: 'scheduled',
        error, createdAt: new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString(),
      }).run()
    }
  }
  const accountFailures = (count: number) => Array.from({ length: count }, () => ({
    status: 'failed' as const, errors: [['claude', BILLING], ['openai', AUTH]] as Array<[string, string]>,
  }))
  const trigger = (body: Record<string, unknown> = {}) => app.inject({ method: 'POST', url: '/api/v1/projects/acme/runs', payload: body })

  return { app, db, projectId, created, seed, accountFailures, trigger }
}

describe('run admission after provider account failures', () => {
  it('refuses a run once every provider failed the last runs on its account, and force overrides', async () => {
    const h = await harness()
    h.seed(...h.accountFailures(PROVIDER_ACCOUNT_FAILURE_STREAK))

    const refused = await h.trigger()
    expect(refused.statusCode).toBe(422)
    expect(refused.json().error).toMatchObject({
      code: 'PROVIDERS_FAILING',
      details: { consecutiveRuns: PROVIDER_ACCOUNT_FAILURE_STREAK, providers: { claude: 'PROVIDER_BILLING', openai: 'PROVIDER_AUTH' } },
    })
    expect(refused.json().error.message).toMatch(/--force/)
    expect(h.created).toEqual([])

    const forced = await h.trigger({ force: true })
    expect(forced.statusCode).toBe(201)
    expect(h.created).toEqual([forced.json().id])
  })

  it.each([
    { name: 'one run short of the streak', setup: (h: Harness) => h.seed(...h.accountFailures(PROVIDER_ACCOUNT_FAILURE_STREAK - 1)) },
    {
      name: 'a partial run inside the streak',
      setup: (h: Harness) => h.seed(
        ...h.accountFailures(PROVIDER_ACCOUNT_FAILURE_STREAK - 1),
        { status: 'partial', errors: [['openai', AUTH]] },
        ...h.accountFailures(1),
      ),
    },
    {
      // Every provider the run would use failed on its account here too; only
      // Gemini's rate limit, worded as an exceeded quota, keeps this run from
      // being a pure account failure.
      name: 'a rate limit among the newest failures',
      setup: (h: Harness) => h.seed(
        ...h.accountFailures(PROVIDER_ACCOUNT_FAILURE_STREAK - 1),
        { status: 'failed', errors: [['claude', BILLING], ['openai', AUTH], ['gemini', RATE_LIMIT]] },
      ),
    },
    {
      name: 'errors stored before they carried a code',
      setup: (h: Harness) => h.seed(...h.accountFailures(PROVIDER_ACCOUNT_FAILURE_STREAK).map(run => ({ ...run, legacy: true }))),
    },
  ])('lets the run through with $name', async ({ setup }) => {
    const h = await harness()
    setup(h)
    expect((await h.trigger()).statusCode).toBe(201)
  })

  it('lets the run through when it asks for a provider that has not been failing', async () => {
    const h = await harness()
    h.seed(...h.accountFailures(PROVIDER_ACCOUNT_FAILURE_STREAK))
    expect((await h.trigger({ providers: ['gemini'] })).statusCode).toBe(201)
  })

  it('gives a provider its next run once its settings are saved', async () => {
    const h = await harness()
    h.seed(...h.accountFailures(PROVIDER_ACCOUNT_FAILURE_STREAK))
    h.db.insert(auditLog).values({
      id: crypto.randomUUID(), projectId: h.projectId, actor: 'api', action: 'provider.updated', entityType: 'provider',
      entityId: 'openai', diff: JSON.stringify({ apiKeyRotated: true }), createdAt: new Date(Date.UTC(2026, 9, 2)).toISOString(),
    }).run()
    expect((await h.trigger()).statusCode).toBe(201)
  })

  it('refuses a run of a published measurement plan the same way', async () => {
    const h = await harness()
    const query = h.db.select().from(queries).where(eq(queries.projectId, h.projectId)).get()!
    const plan = compileMeasurementPlan({
      schemaVersion: 1,
      targets: [{
        stableKey: 'widgets', label: 'Widgets',
        urls: [{ kind: 'prefix', host: 'acme.example', pathPrefix: '/widgets', pathCase: 'insensitive' }],
        aliases: ['Widgets'],
      }],
      groups: [],
      targetQuerySelections: [{ targetKey: 'widgets', queryIds: [query.id] }],
    }, {
      canonicalDomain: 'acme.example', ownedDomains: [], defaultContext: null, locations: [],
      trackedQueries: [{ id: query.id, query: query.query }], expectedSnapshots: 2,
    })
    const canonicalJson = canonicalMeasurementPlanJson(plan)
    const versionId = crypto.randomUUID()
    const at = new Date(Date.UTC(2026, 8, 1)).toISOString()
    h.db.insert(measurementPlanVersions).values({
      id: versionId, projectId: h.projectId, revision: 1, canonicalJson,
      checksum: crypto.createHash('sha256').update(canonicalJson).digest('hex'), createdAt: at,
    }).run()
    h.db.insert(measurementPlans).values({ projectId: h.projectId, activeVersionId: versionId, createdAt: at, updatedAt: at }).run()
    h.seed(...h.accountFailures(PROVIDER_ACCOUNT_FAILURE_STREAK))

    const refused = await h.trigger()
    expect(refused.statusCode).toBe(422)
    expect(refused.json().error.details.providers).toEqual({ claude: 'PROVIDER_BILLING', openai: 'PROVIDER_AUTH' })
    expect((await h.trigger({ force: true })).statusCode).toBe(201)
  })

  it('refuses an all-locations fan-out the same way', async () => {
    const h = await harness({ locations: true })
    h.seed(...h.accountFailures(PROVIDER_ACCOUNT_FAILURE_STREAK))
    const refused = await h.trigger({ allLocations: true })
    expect(refused.statusCode).toBe(422)
    expect(refused.json().error.code).toBe('PROVIDERS_FAILING')
    expect(h.created).toEqual([])
  })

  it('reports the refusal as that project\'s row when triggering every project', async () => {
    const h = await harness()
    h.seed(...h.accountFailures(PROVIDER_ACCOUNT_FAILURE_STREAK))
    const response = await h.app.inject({ method: 'POST', url: '/api/v1/runs', payload: {} })
    expect(response.statusCode).toBe(207)
    expect(response.json()).toMatchObject([{ projectName: 'acme', status: 'error', errorCode: 'PROVIDERS_FAILING' }])
    expect(h.created).toEqual([])
  })
})

type Harness = Awaited<ReturnType<typeof harness>>
