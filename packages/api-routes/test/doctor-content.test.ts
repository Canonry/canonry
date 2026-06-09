import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  createClient,
  migrate,
  projects,
  queries,
  runs,
  querySnapshots,
  domainClassifications,
} from '@ainyc/canonry-db'
import {
  CitationStates,
  DiscoveryCompetitorTypes,
  ProviderNames,
  RunKinds,
  RunStatuses,
  RunTriggers,
} from '@ainyc/canonry-contracts'
import { CONTENT_CHECK_BY_ID } from '../src/doctor/checks/content.js'
import type { DatabaseClient } from '@ainyc/canonry-db'
import type { DoctorContext, ProjectInfo } from '../src/doctor/types.js'

const check = CONTENT_CHECK_BY_ID['content.winnability.coverage']!

describe('content.winnability.coverage', () => {
  let tmpDir: string
  let db: DatabaseClient
  let project: ProjectInfo

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-doctor-content-'))
    db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)
    project = seedProject(db)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('skips without project context', async () => {
    const result = await check.run({ db, project: null })
    expect(result.status).toBe('skipped')
    expect(result.code).toBe('content.winnability.no-project')
  })

  it('skips when recent content evidence has no non-owned cited surface', async () => {
    seedRunWithGrounding(db, project.id, [
      { uri: 'https://example.com/blog/crm', title: 'CRM guide' },
    ])

    const result = await check.run(ctx())

    expect(result.status).toBe('skipped')
    expect(result.code).toBe('content.winnability.no-cited-surface')
    expect(result.details).toMatchObject({ citedSurfaceDomainCount: 0 })
  })

  it('warns and fails open when no cited-surface domain is recognized', async () => {
    // Generic vendor domains the static allow-list does not know and discovery
    // has not classified — nothing is recognized, so the gate fails open.
    seedRunWithGrounding(db, project.id, [
      { uri: 'https://crm-vendor-one.example/guide', title: 'Guide one' },
      { uri: 'https://crm-vendor-two.example/guide', title: 'Guide two' },
    ])

    const result = await check.run(ctx())

    expect(result.status).toBe('warn')
    expect(result.code).toBe('content.winnability.no-classifications')
    expect(result.summary).toContain('winnability gate is failing open')
    expect(result.remediation).toContain('canonry discover run demo --wait')
    expect(result.details).toMatchObject({
      citedSurfaceDomainCount: 2,
      coveredDomainCount: 0,
    })
  })

  it('warns when classification coverage is below the threshold', async () => {
    // Two unrecognized vendor domains; classify only one, leaving 50% recognized.
    seedRunWithGrounding(db, project.id, [
      { uri: 'https://crm-vendor-one.example/guide', title: 'Guide one' },
      { uri: 'https://crm-vendor-two.example/guide', title: 'Guide two' },
    ])
    classify('crm-vendor-one.example', DiscoveryCompetitorTypes['ota-aggregator'])

    const result = await check.run(ctx())

    expect(result.status).toBe('warn')
    expect(result.code).toBe('content.winnability.low-coverage')
    expect(result.summary).toContain('1 of 2 cited-surface domain')
    expect(result.details).toMatchObject({
      citedSurfaceDomainCount: 2,
      coveredDomainCount: 1,
      coverage: 0.5,
      threshold: 0.8,
    })
  })

  it('passes when cited-surface classification coverage is sufficient', async () => {
    seedRunWithGrounding(db, project.id, [
      { uri: 'https://booking.com/crm-guide', title: 'Booking guide' },
      { uri: 'https://forbes.com/crm-guide', title: 'Forbes guide' },
    ])
    classify('booking.com', DiscoveryCompetitorTypes['ota-aggregator'])
    classify('forbes.com', DiscoveryCompetitorTypes['editorial-media'])

    const result = await check.run(ctx())

    expect(result.status).toBe('ok')
    expect(result.code).toBe('content.winnability.covered')
    expect(result.summary).toContain('2 of 2 cited-surface domain')
    expect(result.details).toMatchObject({
      citedSurfaceDomainCount: 2,
      coveredDomainCount: 2,
      coverage: 1,
    })
  })

  it('nudges to set an ICP first when the project has none and coverage is low', async () => {
    db.update(projects).set({ icpDescription: null }).where(eq(projects.id, project.id)).run()
    seedRunWithGrounding(db, project.id, [
      { uri: 'https://crm-vendor-one.example/guide', title: 'Guide one' },
      { uri: 'https://crm-vendor-two.example/guide', title: 'Guide two' },
    ])

    const result = await check.run(ctx())

    expect(result.status).toBe('warn')
    expect(result.remediation).toContain('no ICP')
    expect(result.remediation).toContain('--icp')
  })

  function ctx(): DoctorContext {
    return { db, project }
  }

  function classify(domain: string, competitorType: string): void {
    db.insert(domainClassifications).values({
      id: crypto.randomUUID(),
      projectId: project.id,
      domain,
      competitorType,
      hits: 1,
      sessionId: 'sess_doctor_content',
      updatedAt: '2026-06-01T00:00:00.000Z',
    }).run()
  }
})

function seedProject(db: DatabaseClient): ProjectInfo {
  const id = crypto.randomUUID()
  db.insert(projects).values({
    id,
    name: 'demo',
    displayName: 'Demo',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    icpDescription: 'Teams evaluating CRM software',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
  }).run()
  return { id, name: 'demo', displayName: 'Demo', canonicalDomain: 'example.com' }
}

function seedRunWithGrounding(
  db: DatabaseClient,
  projectId: string,
  groundingSources: Array<{ uri: string; title: string }>,
): void {
  const queryId = crypto.randomUUID()
  const runId = crypto.randomUUID()
  db.insert(queries).values({
    id: queryId,
    projectId,
    query: 'best crm for saas',
    createdAt: '2026-06-01T00:00:00.000Z',
  }).run()
  db.insert(runs).values({
    id: runId,
    projectId,
    kind: RunKinds['answer-visibility'],
    status: RunStatuses.completed,
    trigger: RunTriggers.manual,
    createdAt: '2026-06-01T00:00:00.000Z',
  }).run()
  db.insert(querySnapshots).values({
    id: crypto.randomUUID(),
    runId,
    queryId,
    provider: ProviderNames.gemini,
    citationState: CitationStates['not-cited'],
    competitorOverlap: [],
    rawResponse: JSON.stringify({ groundingSources }),
    createdAt: '2026-06-01T00:00:00.000Z',
  }).run()
}
