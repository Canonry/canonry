import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { desc, eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildProviderRunError,
  canonicalMeasurementPlanJson,
  compileMeasurementPlan,
  PROVIDER_ACCOUNT_FAILURE_STREAK,
  PROVIDER_ACCOUNT_RETRY_HOURS,
  serializeRunError,
} from '@ainyc/canonry-contracts'
import { auditLog, createClient, measurementPlans, measurementPlanVersions, migrate, projects, queries, querySnapshots, runs } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'

/**
 * One install ran 7,000 answer-visibility runs over four months against
 * providers whose keys were dead or out of credit, every one of them failing
 * the same way. Run admission now refuses a run once the project's last
 * PROVIDER_ACCOUNT_FAILURE_STREAK runs all failed on provider accounts, backs
 * off to one run per PROVIDER_ACCOUNT_RETRY_HOURS, and lets anything short of
 * that through.
 */

const BILLING = '[provider-claude] 400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'
const AUTH = '[provider-openai] 401 Incorrect API key provided'
const RATE_LIMIT = `[provider-gemini] ${JSON.stringify({ error: { code: 429, message: 'You exceeded your current quota, please check your plan and billing details.', status: 'RESOURCE_EXHAUSTED' } })}`
const GEMINI_BAD_KEY = `[provider-gemini] ${JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } })}`
const NOT_ON_HOST = 'No perplexity provider was available to this worker, so 2 expected measurement(s) did not run.'
const HOUR = 3_600_000

type Outcome = {
  status: 'failed' | 'partial' | 'completed'
  errors?: Array<[string, string]>
  legacy?: boolean
  trigger?: 'scheduled' | 'probe'
  /** Providers that answered: a completed or partial run stores their snapshots. */
  answered?: string[]
}

const harnesses: Array<{ close: () => Promise<void> }> = []
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close()
})

async function harness(options: { locations?: boolean; projectProviders?: string[] } = {}) {
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
      displayName: 'Acme', canonicalDomain: 'acme.example', country: 'US', language: 'en',
      providers: options.projectProviders ?? ['claude', 'openai'],
      ...(options.locations ? { locations: [{ label: 'north', city: 'North City', region: 'NC', country: 'US' }] } : {}),
    },
  })
  expect(project.statusCode).toBe(201)
  expect((await app.inject({ method: 'POST', url: '/api/v1/projects/acme/queries', payload: { queries: ['best widget'] } })).statusCode).toBe(200)
  const projectId = db.select({ id: projects.id }).from(projects).where(eq(projects.name, 'acme')).get()!.id

  /**
   * Store finished runs the way the job runner does, oldest first, one minute
   * apart, the newest `newestAgoMs` before now.
   */
  const seed = (outcomes: Outcome[], newestAgoMs = 60_000) => {
    const newest = Date.now() - newestAgoMs
    outcomes.forEach((outcome, index) => {
      const errors = outcome.errors ?? []
      const error = errors.length === 0
        ? null
        : outcome.legacy
          // Stored before errors carried a code: the shape without `code`.
          ? JSON.stringify({ providers: Object.fromEntries(errors.map(([name, msg]) => [name, { message: msg }])) })
          : serializeRunError(buildProviderRunError(errors))
      const runId = crypto.randomUUID()
      const createdAt = new Date(newest - (outcomes.length - 1 - index) * 60_000).toISOString()
      db.insert(runs).values({
        id: runId, projectId, kind: 'answer-visibility', status: outcome.status,
        trigger: outcome.trigger ?? 'scheduled', error, createdAt,
      }).run()
      for (const provider of outcome.answered ?? []) {
        db.insert(querySnapshots).values({ id: crypto.randomUUID(), runId, provider, citationState: 'not-cited', createdAt }).run()
      }
    })
    return new Date(newest).toISOString()
  }
  const accountFailures = (count: number, errors: Array<[string, string]> = [['claude', BILLING], ['openai', AUTH]]): Outcome[] =>
    Array.from({ length: count }, () => ({ status: 'failed', errors }))
  const trigger = (body: Record<string, unknown> = {}) => app.inject({ method: 'POST', url: '/api/v1/projects/acme/runs', payload: body })

  return { app, db, projectId, created, seed, accountFailures, trigger }
}

type Harness = Awaited<ReturnType<typeof harness>>

describe('run admission after provider account failures', () => {
  it('refuses a run once every provider failed each of the last runs on its account, and force overrides', async () => {
    const h = await harness()
    const newest = h.seed(h.accountFailures(PROVIDER_ACCOUNT_FAILURE_STREAK))

    const refused = await h.trigger()
    expect(refused.statusCode).toBe(422)
    expect(refused.json().error).toMatchObject({
      code: 'PROVIDERS_FAILING',
      details: {
        consecutiveRuns: PROVIDER_ACCOUNT_FAILURE_STREAK,
        retryAfter: new Date(Date.parse(newest) + PROVIDER_ACCOUNT_RETRY_HOURS * HOUR).toISOString(),
        providers: { claude: 'PROVIDER_BILLING', openai: 'PROVIDER_AUTH' },
      },
    })
    expect(refused.json().error.message).toMatch(/--force/)
    expect(h.created).toEqual([])

    const forced = await h.trigger({ force: true })
    expect(forced.statusCode).toBe(201)
    expect(h.created).toEqual([forced.json().id])
  })

  it('refuses even when the project lists a provider this host cannot run', async () => {
    // The runner drops perplexity without recording an error, so it never
    // appears among the failures; it must not keep the run admissible.
    const h = await harness({ projectProviders: ['claude', 'openai', 'perplexity'] })
    h.seed(h.accountFailures(PROVIDER_ACCOUNT_FAILURE_STREAK))
    const refused = await h.trigger()
    expect(refused.statusCode).toBe(422)
    expect(refused.json().error.details.providers).toEqual({ claude: 'PROVIDER_BILLING', openai: 'PROVIDER_AUTH' })
  })

  it('refuses for a dead Gemini key, which Gemini reports as a 400', async () => {
    const h = await harness({ projectProviders: ['gemini'] })
    h.seed(h.accountFailures(PROVIDER_ACCOUNT_FAILURE_STREAK, [['gemini', GEMINI_BAD_KEY]]))
    const refused = await h.trigger()
    expect(refused.statusCode).toBe(422)
    expect(refused.json().error.details.providers).toEqual({ gemini: 'PROVIDER_AUTH' })
  })

  it.each<{ name: string; setup: (h: Harness) => void }>([
    {
      // A narrower run calls only some providers; it neither resets nor counts
      // toward the others' streaks.
      name: 'a failed single-provider probe after the streak',
      setup: h => { h.seed([...h.accountFailures(PROVIDER_ACCOUNT_FAILURE_STREAK), { status: 'failed', trigger: 'probe', errors: [['openai', AUTH]] }]) },
    },
    {
      name: 'a quota-only settings change',
      setup: h => {
        h.seed(h.accountFailures(PROVIDER_ACCOUNT_FAILURE_STREAK))
        const summary = { configured: true, model: 'gpt-5', baseUrl: null }
        h.db.insert(auditLog).values({
          id: crypto.randomUUID(), projectId: h.projectId, actor: 'api', action: 'provider.updated', entityType: 'provider', entityId: 'openai',
          diff: JSON.stringify({ before: { ...summary, quota: { maxRequestsPerDay: 500 } }, after: { ...summary, quota: { maxRequestsPerDay: 100 } } }),
          createdAt: new Date().toISOString(),
        }).run()
      },
    },
    {
      // Created long ago, finished an hour ago (a batch run waits on its batch):
      // the retry interval runs from when it failed.
      name: 'a newest failure that finished within the retry interval',
      setup: h => {
        h.seed(h.accountFailures(PROVIDER_ACCOUNT_FAILURE_STREAK), PROVIDER_ACCOUNT_RETRY_HOURS * HOUR + HOUR)
        const newest = h.db.select({ id: runs.id }).from(runs).orderBy(desc(runs.createdAt)).limit(1).get()!
        h.db.update(runs).set({ finishedAt: new Date(Date.now() - HOUR).toISOString() }).where(eq(runs.id, newest.id)).run()
      },
    },
  ])('still refuses after $name', async ({ setup }) => {
    const h = await harness()
    setup(h)
    expect((await h.trigger()).json().error?.code).toBe('PROVIDERS_FAILING')
  })

  it.each<{ name: string; setup: (h: Harness) => void; body?: Record<string, unknown> }>([
    { name: 'one run short of the streak', setup: h => { h.seed(h.accountFailures(PROVIDER_ACCOUNT_FAILURE_STREAK - 1)) } },
    {
      name: 'a partial run inside the streak',
      setup: h => {
        h.seed([
          ...h.accountFailures(PROVIDER_ACCOUNT_FAILURE_STREAK - 1),
          { status: 'partial', errors: [['openai', AUTH]], answered: ['claude'] },
          ...h.accountFailures(1),
        ])
      },
    },
    {
      // Gemini's key was dead in every earlier run; the newest failure is its
      // rate limit, worded as an exceeded quota, which must not read as an
      // exhausted account. The run asks for all three.
      name: 'a rate limit among the newest failures',
      setup: h => {
        h.seed([
          ...h.accountFailures(PROVIDER_ACCOUNT_FAILURE_STREAK - 1, [['claude', BILLING], ['openai', AUTH], ['gemini', GEMINI_BAD_KEY]]),
          { status: 'failed', errors: [['claude', BILLING], ['openai', AUTH], ['gemini', RATE_LIMIT]] },
        ])
      },
      body: { providers: ['claude', 'openai', 'gemini'] },
    },
    {
      // Claude failed once, in the newest run; the nine before it only tried openai.
      name: 'a provider that failed only the newest run',
      setup: h => {
        h.seed([
          ...h.accountFailures(PROVIDER_ACCOUNT_FAILURE_STREAK - 1, [['openai', AUTH]]),
          ...h.accountFailures(1),
        ])
      },
    },
    {
      name: 'errors stored before they carried a code',
      setup: h => { h.seed(h.accountFailures(PROVIDER_ACCOUNT_FAILURE_STREAK).map(run => ({ ...run, legacy: true }))) },
    },
    {
      name: 'a probe that succeeded after the failures',
      setup: h => { h.seed([...h.accountFailures(PROVIDER_ACCOUNT_FAILURE_STREAK), { status: 'completed', trigger: 'probe', answered: ['claude', 'openai'] }]) },
    },
    {
      name: 'the retry interval elapsed since the newest failure',
      setup: h => { h.seed(h.accountFailures(PROVIDER_ACCOUNT_FAILURE_STREAK), PROVIDER_ACCOUNT_RETRY_HOURS * HOUR + 60_000) },
    },
    {
      name: 'a probe, which is never refused',
      setup: h => { h.seed(h.accountFailures(PROVIDER_ACCOUNT_FAILURE_STREAK)) },
      body: { trigger: 'probe' },
    },
    {
      name: 'a request for a provider that has not been failing',
      setup: h => { h.seed(h.accountFailures(PROVIDER_ACCOUNT_FAILURE_STREAK)) },
      body: { providers: ['gemini'] },
    },
  ])('lets the run through with $name', async ({ setup, body }) => {
    const h = await harness()
    setup(h)
    expect((await h.trigger(body)).statusCode).toBe(201)
  })

  it('gives a provider its next run once its settings are saved', async () => {
    const h = await harness()
    h.seed(h.accountFailures(PROVIDER_ACCOUNT_FAILURE_STREAK))
    h.db.insert(auditLog).values({
      id: crypto.randomUUID(), projectId: h.projectId, actor: 'api', action: 'provider.updated', entityType: 'provider',
      entityId: 'openai', diff: JSON.stringify({ apiKeyRotated: true }), createdAt: new Date().toISOString(),
    }).run()
    expect((await h.trigger()).statusCode).toBe(201)
  })

  it('refuses a run of a published measurement plan the same way', async () => {
    // The plan expects perplexity too, which this host cannot run: the runner
    // records its slots as not run (UNKNOWN), and that must not keep the run admissible.
    const h = await harness({ projectProviders: ['claude', 'openai', 'perplexity'] })
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
      trackedQueries: [{ id: query.id, query: query.query }], expectedSnapshots: 3,
    })
    const canonicalJson = canonicalMeasurementPlanJson(plan)
    const versionId = crypto.randomUUID()
    const at = new Date(Date.now() - 48 * HOUR).toISOString()
    h.db.insert(measurementPlanVersions).values({
      id: versionId, projectId: h.projectId, revision: 1, canonicalJson,
      checksum: crypto.createHash('sha256').update(canonicalJson).digest('hex'), createdAt: at,
    }).run()
    h.db.insert(measurementPlans).values({ projectId: h.projectId, activeVersionId: versionId, createdAt: at, updatedAt: at }).run()
    h.seed(h.accountFailures(PROVIDER_ACCOUNT_FAILURE_STREAK, [['claude', BILLING], ['openai', AUTH], ['perplexity', NOT_ON_HOST]]))

    const refused = await h.trigger()
    expect(refused.statusCode).toBe(422)
    expect(refused.json().error.details.providers).toEqual({ claude: 'PROVIDER_BILLING', openai: 'PROVIDER_AUTH' })
    expect((await h.trigger({ force: true })).statusCode).toBe(201)
  })

  it('refuses an all-locations fan-out the same way', async () => {
    const h = await harness({ locations: true })
    h.seed(h.accountFailures(PROVIDER_ACCOUNT_FAILURE_STREAK))
    const refused = await h.trigger({ allLocations: true })
    expect(refused.statusCode).toBe(422)
    expect(refused.json().error.code).toBe('PROVIDERS_FAILING')
    expect(h.created).toEqual([])
  })

  it('reports the refusal as that project\'s row when triggering every project', async () => {
    const h = await harness()
    h.seed(h.accountFailures(PROVIDER_ACCOUNT_FAILURE_STREAK))
    const response = await h.app.inject({ method: 'POST', url: '/api/v1/runs', payload: {} })
    expect(response.statusCode).toBe(207)
    expect(response.json()).toMatchObject([{ projectName: 'acme', status: 'error', errorCode: 'PROVIDERS_FAILING' }])
    expect(h.created).toEqual([])
  })
})
