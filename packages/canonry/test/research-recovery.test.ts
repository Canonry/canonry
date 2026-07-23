import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createClient, migrate, projects, researchRunQueries, researchRuns } from '@ainyc/canonry-db'
import { ResearchQueryStatuses, ResearchRunStatuses } from '@ainyc/canonry-contracts'
import { createServer } from '../src/server.js'

const cleanup: string[] = []
afterEach(async () => {
  cleanup.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true }))
})

describe('research run recovery', () => {
  it('re-dispatches queued research runs at server boot', async () => {
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
      // An unavailable provider fails synchronously after the queued -> running claim.
      expect(db.select().from(researchRuns).get()?.status).toBe(ResearchRunStatuses.failed)
      expect(db.select().from(researchRunQueries).get()?.status).toBe(ResearchQueryStatuses.failed)
    } finally {
      await app.close()
    }
  })
})
