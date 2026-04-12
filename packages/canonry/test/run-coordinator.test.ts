import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, onTestFinished } from 'vitest'
import { createClient, migrate, projects, runs, keywords, querySnapshots, healthSnapshots } from '@ainyc/canonry-db'
import { Notifier } from '../src/notifier.js'
import { IntelligenceService } from '../src/intelligence-service.js'
import { RunCoordinator } from '../src/run-coordinator.js'

function createTempDb(prefix: string) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)
  return { db, tmpDir }
}

function seedFixture(db: ReturnType<typeof createClient>) {
  const now = new Date().toISOString()
  const projectId = crypto.randomUUID()

  db.insert(projects).values({
    id: projectId,
    name: 'coord-test',
    displayName: 'Coord Test',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    providers: '["gemini"]',
    createdAt: now,
    updatedAt: now,
  }).run()

  const kwId = crypto.randomUUID()
  db.insert(keywords).values({
    id: kwId,
    projectId,
    keyword: 'test keyword',
    createdAt: now,
  }).run()

  const runId = crypto.randomUUID()
  db.insert(runs).values({
    id: runId,
    projectId,
    status: 'completed',
    providers: '["gemini"]',
    createdAt: now,
    finishedAt: now,
  }).run()

  db.insert(querySnapshots).values({
    id: crypto.randomUUID(),
    runId,
    keywordId: kwId,
    provider: 'gemini',
    model: 'test-model',
    citationState: 'cited',
    citedDomains: '["example.com"]',
    competitorOverlap: '[]',
    groundingSources: '[]',
    searchQueries: '[]',
    createdAt: now,
  }).run()

  return { projectId, runId }
}

function createMockNotifier(): Pick<Notifier, 'onRunCompleted'> {
  return {
    onRunCompleted: vi.fn().mockResolvedValue(undefined),
  }
}

describe('RunCoordinator', () => {
  it('calls both intelligence and notifier on run completion', async () => {
    const { db } = createTempDb('coord-both-')
    const { projectId, runId } = seedFixture(db)

    const notifier = createMockNotifier()
    const service = new IntelligenceService(db)
    const coordinator = new RunCoordinator(notifier as Notifier, service)

    await coordinator.onRunCompleted(runId, projectId)

    // Intelligence should have persisted results
    const healthRows = db.select().from(healthSnapshots).all()
    expect(healthRows).toHaveLength(1)

    // Notifier should have been called
    expect(notifier.onRunCompleted).toHaveBeenCalledWith(runId, projectId)
  })

  it('calls notifier even when intelligence fails', async () => {
    const { db } = createTempDb('coord-intel-fail-')
    const { projectId, runId } = seedFixture(db)

    const notifier = createMockNotifier()
    const service = new IntelligenceService(db)
    // Sabotage the service
    vi.spyOn(service, 'analyzeAndPersist').mockImplementation(() => {
      throw new Error('analysis exploded')
    })

    const coordinator = new RunCoordinator(notifier as Notifier, service)
    await coordinator.onRunCompleted(runId, projectId)

    // Notifier should still be called despite intelligence failure
    expect(notifier.onRunCompleted).toHaveBeenCalledWith(runId, projectId)
  })

  it('does not throw when notifier fails', async () => {
    const { db } = createTempDb('coord-notify-fail-')
    const { projectId, runId } = seedFixture(db)

    const notifier = createMockNotifier()
    notifier.onRunCompleted.mockRejectedValue(new Error('webhook down'))

    const service = new IntelligenceService(db)
    const coordinator = new RunCoordinator(notifier as Notifier, service)

    // Should not throw
    await expect(coordinator.onRunCompleted(runId, projectId)).resolves.toBeUndefined()

    // Intelligence should still have persisted
    const healthRows = db.select().from(healthSnapshots).all()
    expect(healthRows).toHaveLength(1)
  })

  it('awaits intelligence before calling notifier (regression: missing await)', async () => {
    const { db } = createTempDb('coord-await-')
    const { projectId, runId } = seedFixture(db)

    let intelligenceFinished = false
    const notifier = {
      onRunCompleted: vi.fn().mockImplementation(async () => {
        // At the point notifier runs, intelligence must have already completed
        expect(intelligenceFinished).toBe(true)
      }),
    }
    const service = new IntelligenceService(db)
    vi.spyOn(service, 'analyzeAndPersist').mockImplementation(() => {
      // analyzeAndPersist is synchronous — mark completion before returning
      intelligenceFinished = true
      return null
    })

    const coordinator = new RunCoordinator(notifier as Notifier, service)
    await coordinator.onRunCompleted(runId, projectId)

    expect(notifier.onRunCompleted).toHaveBeenCalled()
    expect(intelligenceFinished).toBe(true)
  })

  it('intelligence runs before notifier', async () => {
    const { db } = createTempDb('coord-order-')
    const { projectId, runId } = seedFixture(db)

    const callOrder: string[] = []
    const notifier = {
      onRunCompleted: vi.fn().mockImplementation(async () => {
        callOrder.push('notifier')
      }),
    }
    const service = new IntelligenceService(db)
    const origAnalyze = service.analyzeAndPersist.bind(service)
    vi.spyOn(service, 'analyzeAndPersist').mockImplementation((...args) => {
      callOrder.push('intelligence')
      return origAnalyze(...args)
    })

    const coordinator = new RunCoordinator(notifier as Notifier, service)
    await coordinator.onRunCompleted(runId, projectId)

    expect(callOrder).toEqual(['intelligence', 'notifier'])
  })
})
