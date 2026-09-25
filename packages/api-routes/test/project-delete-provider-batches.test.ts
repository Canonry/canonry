import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { auditLog, createClient, migrate, projects, providerBatches, runs, type DatabaseClient } from '@ainyc/canonry-db'
import { ProviderBatchStatuses, RunStatuses, type ProviderBatchStatus } from '@ainyc/canonry-contracts'
import { apiRoutes } from '../src/index.js'
import type { ProjectRoutesOptions } from '../src/projects.js'

// Deleting a project cascades away its `provider_batches` rows, and those rows
// are the only record of the provider's batch id. A batch still outstanding at
// the provider must be stopped BEFORE the delete, or it keeps processing and
// billing with nothing left that could cancel it.

const NOW = '2026-09-24T00:00:00.000Z'

let tmpDir: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>

type DeleteHooks = Pick<ProjectRoutesOptions, 'cancelRunProviderBatches' | 'onProjectDeleting' | 'onProjectDeleted'>

async function build(hooks: DeleteHooks = {}) {
  app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true, ...hooks })
  await app.ready()
}

function seedProject(name: string): string {
  const id = crypto.randomUUID()
  db.insert(projects).values({
    id, name, displayName: name, canonicalDomain: `${name}.com`, country: 'US', language: 'en', createdAt: NOW, updatedAt: NOW,
  }).run()
  return id
}

function seedRun(projectId: string, status = RunStatuses.running): string {
  const id = crypto.randomUUID()
  db.insert(runs).values({ id, projectId, kind: 'answer-visibility', status, trigger: 'scheduled', createdAt: NOW }).run()
  return id
}

function seedBatch(projectId: string, runId: string, status: ProviderBatchStatus, providerBatchId: string | null): string {
  const id = crypto.randomUUID()
  db.insert(providerBatches).values({
    id, projectId, runId, provider: 'claude', model: 'claude-sonnet-4-6', providerBatchId, status, requestCount: 3,
    quotaScope: `${projectId}:claude`, quotaPeriod: '2026-09-24', quotaReserved: 3, deadlineAt: '2026-09-25T00:00:00.000Z',
    createdAt: NOW, updatedAt: NOW,
  }).run()
  return id
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-project-delete-batches-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('DELETE /projects/:name with provider batches', () => {
  it('stops each run still waiting on a batch before the cascade removes its provider batch id', async () => {
    const projectId = seedProject('acme')
    const submittedRun = seedRun(projectId)
    seedBatch(projectId, submittedRun, ProviderBatchStatuses.submitted, 'msgbatch_submitted')
    const endedRun = seedRun(projectId)
    seedBatch(projectId, endedRun, ProviderBatchStatuses.ended, 'msgbatch_ended')
    // A run whose batches are all settled has nothing left at the provider.
    const settledRun = seedRun(projectId, RunStatuses.completed)
    seedBatch(projectId, settledRun, ProviderBatchStatuses.ingested, 'msgbatch_ingested')
    seedBatch(projectId, settledRun, ProviderBatchStatuses.cancelled, 'msgbatch_cancelled')
    // Another project's outstanding batch is not this delete's business.
    const otherProjectId = seedProject('other')
    const otherRun = seedRun(otherProjectId)
    seedBatch(otherProjectId, otherRun, ProviderBatchStatuses.submitted, 'msgbatch_other')

    const calls: Array<{ runId: string; projectId: string; providerBatchIds: Array<string | null> }> = []
    await build({ cancelRunProviderBatches: async (runId, calledProjectId) => {
      // Called while the rows (and so the provider's batch id) still exist.
      const providerBatchIds = db.select({ id: providerBatches.providerBatchId }).from(providerBatches)
        .where(eq(providerBatches.runId, runId)).all().map(row => row.id)
      calls.push({ runId, projectId: calledProjectId, providerBatchIds })
    } })

    const response = await app.inject({ method: 'DELETE', url: '/api/v1/projects/acme' })

    expect(response.statusCode).toBe(204)
    expect(calls.sort((a, b) => a.providerBatchIds[0]!.localeCompare(b.providerBatchIds[0]!))).toEqual([
      { runId: endedRun, projectId, providerBatchIds: ['msgbatch_ended'] },
      { runId: submittedRun, projectId, providerBatchIds: ['msgbatch_submitted'] },
    ])
    expect(db.select().from(projects).where(eq(projects.id, projectId)).get()).toBeUndefined()
    expect(db.select({ providerBatchId: providerBatches.providerBatchId }).from(providerBatches).all())
      .toEqual([{ providerBatchId: 'msgbatch_other' }])
  })

  it('still deletes the project when stopping a batch fails', async () => {
    const projectId = seedProject('acme')
    const runId = seedRun(projectId)
    seedBatch(projectId, runId, ProviderBatchStatuses.submitted, 'msgbatch_1')
    const called: string[] = []
    await build({ cancelRunProviderBatches: async (calledRunId) => {
      called.push(calledRunId)
      throw new Error('[provider-claude] batch cancel failed: 503 overloaded')
    } })

    const response = await app.inject({ method: 'DELETE', url: '/api/v1/projects/acme' })

    expect(response.statusCode).toBe(204)
    expect(called).toEqual([runId])
    expect(db.select().from(projects).where(eq(projects.id, projectId)).get()).toBeUndefined()
    expect(db.select().from(providerBatches).all()).toEqual([])
  })

  it('does not call the host for a project with no outstanding batch', async () => {
    const projectId = seedProject('acme')
    const runId = seedRun(projectId, RunStatuses.partial)
    seedBatch(projectId, runId, ProviderBatchStatuses.failed, null)
    const called: string[] = []
    await build({ cancelRunProviderBatches: async (calledRunId) => { called.push(calledRunId) } })

    const response = await app.inject({ method: 'DELETE', url: '/api/v1/projects/acme' })

    expect(response.statusCode).toBe(204)
    expect(called).toEqual([])
  })

  // The cancel is awaited, so a second DELETE of the same project can run
  // while the first waits on the provider. Whichever finishes second must see
  // a project that is already gone: before the fix it wrote its audit row
  // against the deleted project (FK failure, 500) and ran the pre-delete
  // compensator, which in `canonry serve` writes the deleted project's Google
  // Ads / GTM OAuth connections back into config.yaml.
  it.each([
    { host: 'leaves the batch rows until the provider answers', marksBeforeAwait: false, cancelCalls: 2 },
    // JobRunner.cancelRunBatches marks the rows cancelled before it awaits the
    // provider, so the second DELETE finds nothing outstanding and runs through.
    { host: 'marks the batch cancelled before awaiting the provider', marksBeforeAwait: true, cancelCalls: 1 },
  ])('concurrent deletes with a host that $host: one 204, one not-found, no rollback', async ({ marksBeforeAwait, cancelCalls }) => {
    const projectId = seedProject('acme')
    const runId = seedRun(projectId)
    const batchId = seedBatch(projectId, runId, ProviderBatchStatuses.submitted, 'msgbatch_1')

    let answerProvider!: () => void
    const providerAnswered = new Promise<void>((resolve) => { answerProvider = resolve })
    const cancelled: string[] = []
    const deleting: string[] = []
    const rolledBack: string[] = []
    const deleted: string[] = []
    await build({
      cancelRunProviderBatches: async (calledRunId) => {
        cancelled.push(calledRunId)
        if (marksBeforeAwait) {
          db.update(providerBatches).set({ status: ProviderBatchStatuses.cancelled })
            .where(eq(providerBatches.id, batchId)).run()
        }
        await providerAnswered
      },
      onProjectDeleting: (id) => {
        deleting.push(id)
        return () => { rolledBack.push(id) }
      },
      onProjectDeleted: (id) => { deleted.push(id) },
    })

    let settled = 0
    const inFlight = [
      app.inject({ method: 'DELETE', url: '/api/v1/projects/acme' }),
      app.inject({ method: 'DELETE', url: '/api/v1/projects/acme' }),
    ].map(pending => pending.finally(() => { settled += 1 }))
    // Hold the provider until each DELETE is either waiting on it or done.
    await vi.waitFor(() => expect(cancelled.length + settled).toBe(2))
    expect(cancelled).toEqual(Array.from({ length: cancelCalls }, () => runId))
    answerProvider()
    const responses = await Promise.all(inFlight)

    const missing = await app.inject({ method: 'DELETE', url: '/api/v1/projects/acme' })
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toEqual({ error: { code: 'NOT_FOUND', message: "Project 'acme' not found" } })

    const byStatus = [...responses].sort((a, b) => a.statusCode - b.statusCode)
    expect(byStatus.map(response => response.statusCode)).toEqual([204, 404])
    expect(byStatus[1]!.json()).toEqual(missing.json())
    expect(deleting).toEqual([projectId])
    expect(rolledBack).toEqual([])
    expect(deleted).toEqual([projectId])
    expect(db.select().from(projects).all()).toEqual([])
    expect(db.select({ action: auditLog.action, projectId: auditLog.projectId }).from(auditLog)
      .where(eq(auditLog.action, 'project.deleted')).all())
      .toEqual([{ action: 'project.deleted', projectId: null }])
  })

  it('never deletes a project recreated under the name while it waited on the provider', async () => {
    const projectId = seedProject('acme')
    const runId = seedRun(projectId)
    seedBatch(projectId, runId, ProviderBatchStatuses.submitted, 'msgbatch_1')
    let recreatedId: string | undefined
    const deleting: string[] = []
    const rolledBack: string[] = []
    const deleted: string[] = []
    await build({
      cancelRunProviderBatches: async () => {
        // Another caller deletes the project and creates a new one named the
        // same before the provider answers.
        await Promise.resolve()
        db.delete(projects).where(eq(projects.id, projectId)).run()
        recreatedId = seedProject('acme')
      },
      onProjectDeleting: (id) => {
        deleting.push(id)
        return () => { rolledBack.push(id) }
      },
      onProjectDeleted: (id) => { deleted.push(id) },
    })

    const response = await app.inject({ method: 'DELETE', url: '/api/v1/projects/acme' })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ error: { code: 'NOT_FOUND', message: "Project 'acme' not found" } })
    expect(db.select({ id: projects.id }).from(projects).all()).toEqual([{ id: recreatedId }])
    expect(deleting).toEqual([])
    expect(rolledBack).toEqual([])
    expect(deleted).toEqual([])
  })
})
