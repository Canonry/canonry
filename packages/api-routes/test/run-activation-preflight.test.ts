import { afterEach, describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { createClient, migrate, projects, runs } from '@canonry/canonry-db'
import { apiRoutes } from '../src/index.js'

interface Harness {
  app: ReturnType<typeof Fastify>
  db: ReturnType<typeof createClient>
  tmpDir: string
  createdRuns: string[]
  setRunnableProviders: (providers: string[]) => void
}

const harnesses: Harness[] = []

async function buildHarness(initialRunnableProviders: string[] = ['gemini']): Promise<Harness> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-run-preflight-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)

  let runnableProviders = initialRunnableProviders
  const createdRuns: string[] = []
  const app = Fastify()
  app.register(apiRoutes, {
    db,
    skipAuth: true,
    getRunnableProviderNames: () => runnableProviders,
    onRunCreated: runId => {
      createdRuns.push(runId)
    },
  })
  await app.ready()

  const harness: Harness = {
    app,
    db,
    tmpDir,
    createdRuns,
    setRunnableProviders: providers => {
      runnableProviders = providers
    },
  }
  harnesses.push(harness)
  return harness
}

async function createProject(
  harness: Harness,
  name: string,
  providerNames: string[] = [],
): Promise<void> {
  const response = await harness.app.inject({
    method: 'PUT',
    url: `/api/v1/projects/${name}`,
    payload: {
      displayName: name,
      canonicalDomain: `${name}.example.com`,
      country: 'US',
      language: 'en',
      providers: providerNames,
    },
  })
  expect(response.statusCode).toBe(201)
}

async function addQueries(harness: Harness, name: string, values = ['best answer engine tool']) {
  const response = await harness.app.inject({
    method: 'POST',
    url: `/api/v1/projects/${name}/queries`,
    payload: { queries: values },
  })
  expect(response.statusCode).toBe(200)
}

afterEach(async () => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop()!
    await harness.app.close()
    fs.rmSync(harness.tmpDir, { recursive: true, force: true })
  }
})

describe('answer-visibility activation preflight', () => {
  it('rejects a normal run with NO_QUERIES before inserting a run', async () => {
    const harness = await buildHarness()
    await createProject(harness, 'empty-basket')

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/projects/empty-basket/runs',
      payload: {},
    })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toEqual({
      error: {
        code: 'NO_QUERIES',
        message: "Project 'empty-basket' has no tracked queries. Add at least one query before starting a run.",
        details: { projectName: 'empty-basket' },
      },
    })
    expect(harness.db.select().from(runs).all()).toEqual([])
    expect(harness.createdRuns).toEqual([])
  })

  it('rejects a normal run with NO_PROVIDER when the registry is empty', async () => {
    const harness = await buildHarness([])
    await createProject(harness, 'no-provider')
    await addQueries(harness, 'no-provider')

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/projects/no-provider/runs',
      payload: {},
    })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({
      error: {
        code: 'NO_PROVIDER',
        details: {
          projectName: 'no-provider',
          availableProviders: [],
          selectedProviders: [],
          selectionSource: 'instance',
        },
      },
    })
    expect(harness.db.select().from(runs).all()).toEqual([])
    expect(harness.createdRuns).toEqual([])
  })

  it('honors project provider selection against the live registry', async () => {
    const harness = await buildHarness(['gemini'])
    await createProject(harness, 'provider-selection', ['openai'])
    await addQueries(harness, 'provider-selection')

    const blocked = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/projects/provider-selection/runs',
      payload: {},
    })
    expect(blocked.statusCode).toBe(503)
    expect(blocked.json()).toMatchObject({
      error: {
        code: 'NO_PROVIDER',
        details: {
          availableProviders: ['gemini'],
          selectedProviders: ['openai'],
          selectionSource: 'project',
        },
      },
    })

    harness.setRunnableProviders(['gemini', 'openai'])
    const accepted = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/projects/provider-selection/runs',
      payload: {},
    })
    expect(accepted.statusCode).toBe(201)
    expect(accepted.json()).toMatchObject({ status: 'queued' })
    expect(harness.createdRuns).toHaveLength(1)
  })

  it('keeps probe runs on the existing operator-test path', async () => {
    const harness = await buildHarness([])
    await createProject(harness, 'probe-only')

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/projects/probe-only/runs',
      payload: { trigger: 'probe' },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({ status: 'queued', trigger: 'probe' })
    expect(harness.createdRuns).toHaveLength(1)
  })

  it('returns per-project structured preflight errors from the batch route', async () => {
    const harness = await buildHarness(['gemini'])
    await createProject(harness, 'batch-ready')
    await addQueries(harness, 'batch-ready')
    await createProject(harness, 'batch-empty')

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      payload: {},
    })

    expect(response.statusCode).toBe(207)
    const body = response.json() as Array<{
      projectName: string
      status: string
      errorCode?: string
    }>
    expect(body).toEqual(expect.arrayContaining([
      expect.objectContaining({ projectName: 'batch-ready', status: 'queued' }),
      expect.objectContaining({
        projectName: 'batch-empty',
        status: 'error',
        errorCode: 'NO_QUERIES',
      }),
    ]))

    const readyProject = harness.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.name, 'batch-ready'))
      .get()!
    const queuedRuns = harness.db
      .select()
      .from(runs)
      .where(eq(runs.projectId, readyProject.id))
      .all()
    expect(queuedRuns).toHaveLength(1)
    expect(harness.createdRuns).toHaveLength(1)
  })
})
