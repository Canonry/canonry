import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createClient, migrate, projects, providerBatches, runs, type DatabaseClient } from '@ainyc/canonry-db'
import { ProviderBatchStatuses, RunStatuses } from '@ainyc/canonry-contracts'
import { claudeAdapter } from '@ainyc/canonry-provider-claude'
import type { CanonryConfig } from '../src/config.js'
import { loadConfigRaw, saveConfig, saveConfigPatch } from '../src/config.js'
import { getGoogleAdsConnection, upsertGoogleAdsConnection } from '../src/google-ads-config.js'
import { createServer } from '../src/server.js'

// Deleting a project cascades away its provider batch rows, the only record of
// the provider's batch id. The server stops each outstanding batch at the
// provider first, through the same job-runner path a run cancel uses.

const NOW = '2026-09-24T00:00:00.000Z'
const previousConfigDir = process.env.CANONRY_CONFIG_DIR

let tmpDir: string
let db: DatabaseClient
let apiKey: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-project-delete-batches-'))
  const dbPath = path.join(tmpDir, 'test.db')
  db = createClient(dbPath)
  migrate(db)
  apiKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
  process.env.CANONRY_CONFIG_DIR = tmpDir
})

afterEach(() => {
  vi.restoreAllMocks()
  if (previousConfigDir === undefined) delete process.env.CANONRY_CONFIG_DIR
  else process.env.CANONRY_CONFIG_DIR = previousConfigDir
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

async function serverWithBatchPendingProject() {
  const config: CanonryConfig = {
    apiUrl: 'http://localhost:4100',
    database: path.join(tmpDir, 'test.db'),
    apiKey,
    providers: { claude: { apiKey: 'sk-ant-test', batch: { enabled: true } } },
  }
  saveConfig(config)
  const app = await createServer({ config, db, logger: false })
  const created = await app.inject({
    method: 'PUT',
    url: '/api/v1/projects/acme',
    headers: { authorization: `Bearer ${apiKey}` },
    payload: { displayName: 'Acme', canonicalDomain: 'acme.com', country: 'US', language: 'en', providers: ['claude'] },
  })
  expect(created.statusCode).toBe(201)
  const projectId = (created.json() as { id: string }).id
  const runId = crypto.randomUUID()
  db.insert(runs).values({ id: runId, projectId, kind: 'answer-visibility', status: RunStatuses.running, trigger: 'scheduled', createdAt: NOW }).run()
  db.insert(providerBatches).values({
    id: crypto.randomUUID(), projectId, runId, provider: 'claude', model: 'claude-sonnet-4-6', providerBatchId: 'msgbatch_live',
    status: ProviderBatchStatuses.submitted, requestCount: 20_000, quotaScope: `${projectId}:claude`, quotaPeriod: '2026-09-24',
    quotaReserved: 20_000, deadlineAt: '2026-09-25T00:00:00.000Z', submittedAt: NOW, createdAt: NOW, updatedAt: NOW,
  }).run()
  return { app, projectId, config }
}

describe('project delete with an outstanding provider batch', () => {
  it('cancels the batch at the provider with its stored provider batch id', async () => {
    const cancel = vi.spyOn(claudeAdapter.batch!, 'cancel').mockResolvedValue(undefined)
    const { app, projectId } = await serverWithBatchPendingProject()
    try {
      const deleted = await app.inject({ method: 'DELETE', url: '/api/v1/projects/acme', headers: { authorization: `Bearer ${apiKey}` } })

      expect(deleted.statusCode).toBe(204)
      expect(cancel).toHaveBeenCalledTimes(1)
      expect(cancel).toHaveBeenCalledWith('msgbatch_live', expect.objectContaining({ provider: 'claude', apiKey: 'sk-ant-test' }))
      expect(db.select().from(projects).where(eq(projects.id, projectId)).get()).toBeUndefined()
      expect(db.select().from(providerBatches).all()).toEqual([])
    } finally {
      await app.close()
    }
  })

  // The cancel awaits the provider, and JobRunner.cancelRunBatches marks the
  // batch cancelled before it does, so a second DELETE of the project finds
  // nothing to wait on and commits first. The first must then answer 404 and
  // leave config.yaml alone: before the fix it failed its own transaction and
  // ran the credential compensator, writing the deleted project's Google Ads
  // OAuth connection back into config.yaml.
  it('keeps a deleted project\'s Google Ads connection out of config.yaml when two deletes race', async () => {
    let answerProvider!: () => void
    const providerAnswered = new Promise<void>((resolve) => { answerProvider = resolve })
    const cancel = vi.spyOn(claudeAdapter.batch!, 'cancel').mockImplementation(() => providerAnswered)
    const { app, projectId, config } = await serverWithBatchPendingProject()
    try {
      upsertGoogleAdsConnection(config, {
        projectId, projectName: 'acme', refreshToken: 'ads-refresh-private-fixture', createdAt: NOW, updatedAt: NOW,
      })
      saveConfigPatch({ googleAds: config.googleAds })

      let settled = 0
      const inFlight = [1, 2].map(() => app.inject({
        method: 'DELETE', url: '/api/v1/projects/acme', headers: { authorization: `Bearer ${apiKey}` },
      }).finally(() => { settled += 1 }))
      await vi.waitFor(() => {
        expect(cancel).toHaveBeenCalledTimes(1)
        expect(settled).toBe(1)
      })
      answerProvider()
      const statuses = (await Promise.all(inFlight)).map(response => response.statusCode).sort()

      expect(loadConfigRaw()?.googleAds?.connections ?? []).toEqual([])
      expect(getGoogleAdsConnection(config, projectId)).toBeUndefined()
      expect(statuses).toEqual([204, 404])
      expect(db.select().from(projects).where(eq(projects.id, projectId)).get()).toBeUndefined()
    } finally {
      await app.close()
    }
  })

  it('still deletes the project when the provider refuses the cancel', async () => {
    const cancel = vi.spyOn(claudeAdapter.batch!, 'cancel')
      .mockRejectedValue(new Error('[provider-claude] batch cancel failed: 529 overloaded'))
    const { app, projectId } = await serverWithBatchPendingProject()
    try {
      const deleted = await app.inject({ method: 'DELETE', url: '/api/v1/projects/acme', headers: { authorization: `Bearer ${apiKey}` } })

      expect(deleted.statusCode).toBe(204)
      expect(cancel).toHaveBeenCalledWith('msgbatch_live', expect.anything())
      expect(db.select().from(projects).where(eq(projects.id, projectId)).get()).toBeUndefined()
      expect(db.select().from(runs).all()).toEqual([])
    } finally {
      await app.close()
    }
  })
})
