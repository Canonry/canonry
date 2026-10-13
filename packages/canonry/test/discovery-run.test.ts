import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
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
import { nativeDiscoveryFixture } from './discovery-native-fixture.js'

const trackEvent = vi.hoisted(() => vi.fn())
vi.mock('../src/telemetry.js', () => ({ trackEvent }))
beforeEach(() => trackEvent.mockReset())

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

describe('discovery run outcome telemetry', () => {
  const discovered = { feature: 'discovery', operation: 'run', trigger: 'manual', durationBucket: expect.any(String) }

  it('reports a finished session with the queries it seeded, the probes it saved and the competitor domains it found', async () => {
    const cited = { answerText: 'Acme IQ is a strong option.', citedDomains: ['acme-iq.example.com'] }
    const wasted = { answerText: 'Compare the market.', citedDomains: ['sunplanner.test'] }
    const h = nativeDiscoveryFixture({ providers: { gemini: {
      seed: { answerText: 'a q\nb q\nc q', citedDomains: [] },
      probes: { 'a q': cited, 'b q': wasted, 'c q': { answerText: 'Compare the market.', citedDomains: ['random.com'] } },
      classification: 'sunplanner.test => direct-competitor\nrandom.com => other',
    } } })
    await executeDiscoveryRun(h.runOptions)
    expect(trackEvent.mock.calls).toEqual([
      ['feature.completed', { ...discovered, status: 'succeeded', counts: { queries: 3, snapshots: 3, domains: 2 } }, undefined],
    ])
  })

  it('reports a failed session by the provider failure, and an unconfigured Gemini as not connected', async () => {
    const h = nativeDiscoveryFixture({ providers: { gemini: { seed: new Error('[provider-gemini] 429 RESOURCE_EXHAUSTED for project acme-prod') } } })
    await executeDiscoveryRun(h.runOptions)
    const { db, projectId, sessionId, runId } = setup()
    await executeDiscoveryRun({ db, registry: new ProviderRegistry(), runId, sessionId, projectId, icpDescription: 'AEO test' })

    expect(trackEvent.mock.calls).toEqual([
      ['feature.completed', { ...discovered, status: 'failed', reasonCode: 'RATE_LIMITED', errorName: 'Error' }, { errorCode: 'RATE_LIMITED' }],
      ['feature.completed', { ...discovered, status: 'failed', reasonCode: 'NOT_CONNECTED', errorName: 'Error' }, { errorCode: 'NOT_CONNECTED' }],
    ])
    expect(JSON.stringify(trackEvent.mock.calls)).not.toContain('acme-prod')
  })
})
