import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClient, migrate, projects, researchRunQueries, researchRuns } from '@ainyc/canonry-db'
import { ResearchQueryStatuses, ResearchRunStatuses } from '@ainyc/canonry-contracts'
import { createServer, waitForServerRuntimeStartup } from '../src/server.js'

const telemetry = vi.hoisted(() => ({ trackEvent: vi.fn() }))
vi.mock('../src/telemetry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/telemetry.js')>()),
  trackEvent: telemetry.trackEvent,
}))

const cleanup: string[] = []
afterEach(async () => {
  cleanup.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true }))
})

describe('research run recovery', () => {
  it('re-dispatches queued research runs after the server listens', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-research-recovery-'))
    cleanup.push(dir)
    const dbPath = path.join(dir, 'data.db')
    const db = createClient(dbPath)
    migrate(db)
    const now = new Date().toISOString()
    db.insert(projects).values({ id: 'project', name: 'project', displayName: 'Project', canonicalDomain: 'example.com', country: 'US', language: 'en', createdAt: now, updatedAt: now }).run()
    db.insert(researchRuns).values({ id: 'run', projectId: 'project', status: ResearchRunStatuses.queued, provider: 'missing', resolvedModel: 'missing-model', totalQueries: 1, createdAt: now }).run()
    db.insert(researchRunQueries).values({ id: 'query', researchRunId: 'run', position: 0, queryText: 'test query', status: ResearchQueryStatuses.queued, resolvedModel: 'missing-model', groundingSources: [], citedDomains: [], searchQueries: [], createdAt: now }).run()

    const app = await createServer({
      config: { apiUrl: 'http://localhost:0', database: dbPath, providers: {} } as Parameters<typeof createServer>[0]['config'],
      db,
      logger: false,
    })
    try {
      await app.listen({ host: '127.0.0.1', port: 0 })
      await waitForServerRuntimeStartup(app)
      // An unavailable provider fails synchronously after the queued -> running claim.
      await vi.waitFor(() => {
        expect(db.select().from(researchRuns).get()?.status).toBe(ResearchRunStatuses.failed)
        expect(db.select().from(researchRunQueries).get()?.status).toBe(ResearchQueryStatuses.failed)
      })
      // Startup dispatched it, not a request.
      expect(telemetry.trackEvent.mock.calls.filter(([event, properties]) => event === 'feature.completed' && (properties as { feature: string }).feature === 'research')).toEqual([[
        'feature.completed',
        {
          feature: 'research', operation: 'run', status: 'failed', trigger: 'startup', surface: 'system', reasonCode: 'NOT_CONNECTED',
          durationBucket: expect.any(String), counts: { queries: 1, snapshots: 0, failures: 1 },
        },
        { errorCode: 'NOT_CONNECTED' },
      ]])
    } finally {
      await app.close()
    }
  })
})
