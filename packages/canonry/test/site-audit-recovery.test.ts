import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { RunKinds, RunStatuses } from '@ainyc/canonry-contracts'
import { createClient, migrate, projects, runs, siteCrawlAttempts } from '@ainyc/canonry-db'
import { createServer } from '../src/server.js'

const cleanup: string[] = []

afterEach(async () => {
  cleanup.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true }))
})

describe('site-audit crash recovery', () => {
  it.each([RunStatuses.queued, RunStatuses.running])('recovers a %s crawl and a batch of other active run kinds at server boot', async (status) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-site-audit-recovery-'))
    cleanup.push(dir)
    const dbPath = path.join(dir, 'data.db')
    const db = createClient(dbPath)
    migrate(db)
    const now = new Date().toISOString()
    db.insert(projects).values({
      id: 'project', name: 'project', displayName: 'Project', canonicalDomain: 'example.com',
      country: 'US', language: 'en', createdAt: now, updatedAt: now,
    }).run()
    db.insert(runs).values({
      id: 'stale-run', projectId: 'project', kind: RunKinds['site-audit'],
      status, trigger: 'manual', startedAt: now, createdAt: now,
    }).run()
    db.insert(siteCrawlAttempts).values({
      id: 'stale-attempt', projectId: 'project', runId: 'stale-run', attemptNumber: 1,
      state: status, startedAt: now, lastEventSequence: 7, createdAt: now, updatedAt: now,
    }).run()

    const otherStaleRuns = Object.values(RunKinds).filter(kind => kind !== RunKinds['site-audit'])
      .map((kind, index) => ({
        id: `stale-${kind}`, projectId: 'project', kind,
        status: index % 2 === 0 ? RunStatuses.queued : RunStatuses.running,
        createdAt: now,
      }))
    db.insert(runs).values(otherStaleRuns).run()
    const terminalRuns = [RunStatuses.completed, RunStatuses.partial, RunStatuses.failed, RunStatuses.cancelled]
      .map(status => ({
        id: `terminal-${status}`, projectId: 'project', kind: RunKinds['answer-visibility'],
        status, finishedAt: now, createdAt: now,
      }))
    db.insert(runs).values(terminalRuns).run()

    // An active-looking attempt on a terminal parent must not be reaped just
    // because it shares the site-audit table; the parent transition is the CAS.
    db.insert(runs).values({
      id: 'terminal-run', projectId: 'project', kind: RunKinds['site-audit'],
      status: RunStatuses.completed, trigger: 'manual', finishedAt: now, createdAt: now,
    }).run()
    db.insert(siteCrawlAttempts).values({
      id: 'terminal-attempt', projectId: 'project', runId: 'terminal-run', attemptNumber: 1,
      state: 'running', startedAt: now, createdAt: now, updatedAt: now,
    }).run()

    const app = await createServer({
      config: { apiUrl: 'http://localhost:0', database: dbPath, providers: {} } as Parameters<typeof createServer>[0]['config'],
      db,
      logger: false,
    })
    try {
      const staleRun = db.select().from(runs).where(eq(runs.id, 'stale-run')).get()
      const staleAttempt = db.select().from(siteCrawlAttempts).where(eq(siteCrawlAttempts.id, 'stale-attempt')).get()
      expect(staleRun).toMatchObject({
        status: RunStatuses.failed,
        error: 'Server restarted while run was in progress',
      })
      expect(staleRun?.finishedAt).toBeTruthy()
      expect(staleAttempt).toMatchObject({
        state: 'failed',
        error: 'Server restarted while run was in progress',
        lastEventSequence: 7,
      })
      expect(staleAttempt?.finishedAt).toBeTruthy()

      for (const run of otherStaleRuns) {
        expect(db.select().from(runs).where(eq(runs.id, run.id)).get()).toMatchObject({
          status: RunStatuses.failed,
          error: 'Server restarted while run was in progress',
          finishedAt: expect.any(String),
        })
      }
      for (const run of terminalRuns) {
        expect(db.select().from(runs).where(eq(runs.id, run.id)).get()).toMatchObject({
          status: run.status, finishedAt: now, error: null,
        })
      }
      expect(db.select().from(runs).where(eq(runs.id, 'terminal-run')).get()?.status).toBe(RunStatuses.completed)
      expect(db.select().from(siteCrawlAttempts).where(eq(siteCrawlAttempts.id, 'terminal-attempt')).get()?.state).toBe('running')
    } finally {
      await app.close()
    }
  })
})
