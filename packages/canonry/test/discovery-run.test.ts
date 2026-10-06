import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  competitors,
  createClient,
  discoverySessions,
  migrate,
  projects,
  runs,
} from '@ainyc/canonry-db'
import { ProviderRegistry } from '../src/provider-registry.js'
import {
  executeDiscoveryRun,
} from '../src/discovery-run.js'

function setup(): { db: ReturnType<typeof createClient>; projectId: string; sessionId: string; runId: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-disc-run-'))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)

  const projectId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: projectId,
    name: 'acme-iq',
    displayName: 'Acme IQ',
    canonicalDomain: 'acme-iq.example.com',
    country: 'US',
    language: 'en',
    ownedDomains: [],
    createdAt: now,
    updatedAt: now,
  }).run()
  db.insert(competitors).values({
    id: crypto.randomUUID(),
    projectId,
    domain: 'sunplanner.test',
    provenance: 'cli',
    createdAt: now,
  }).run()

  const sessionId = crypto.randomUUID()
  const runId = crypto.randomUUID()
  db.insert(discoverySessions).values({
    id: sessionId,
    projectId,
    status: 'queued',
    icpDescription: 'AEO test',
    competitorMap: [],
    createdAt: now,
  }).run()
  db.insert(runs).values({
    id: runId,
    projectId,
    kind: 'aeo-discover-probe',
    status: 'queued',
    trigger: 'manual',
    createdAt: now,
  }).run()

  return { db, projectId, sessionId, runId }
}

describe('executeDiscoveryRun', () => {
  it('throws when the Gemini provider is missing and no deps override is given', async () => {
    const { db, projectId, sessionId, runId } = setup()

    await executeDiscoveryRun({
      db,
      registry: new ProviderRegistry(), // empty
      runId,
      sessionId,
      projectId,
      icpDescription: 'AEO test',
    })

    const sessionRow = db.select().from(discoverySessions).get()!
    expect(sessionRow.status).toBe('failed')
    expect(sessionRow.error ?? '').toMatch(/Gemini provider/i)

    const runRow = db.select().from(runs).get()!
    expect(runRow.status).toBe('failed')
  })

})
