import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient, measurementPlans, measurementPlanVersions, migrate, projects, queries, type DatabaseClient } from '@ainyc/canonry-db'
import { aeroProjectShapePrompt } from '../src/agent/project-shape.js'

describe('aeroProjectShapePrompt', () => {
  let tmpDir: string
  let db: DatabaseClient

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-project-shape-'))
    db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)
    const now = new Date().toISOString()
    db.insert(projects).values({
      id: 'proj_acme', name: 'acme', displayName: 'acme', canonicalDomain: 'acme.example.com', country: 'US', language: 'en', createdAt: now, updatedAt: now,
    }).run()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('describes a Simple project by its tracked queries', () => {
    const now = new Date().toISOString()
    for (const [id, query] of [['q1', 'best dentist'], ['q2', 'emergency dentist']]) {
      db.insert(queries).values({ id, projectId: 'proj_acme', query, createdAt: now }).run()
    }
    const prompt = aeroProjectShapePrompt(db, 'proj_acme', { progressive: false })

    expect(prompt).toContain('a Simple project with 2 tracked queries and no measurement plan')
    expect(prompt).toContain('canonry_visibility_report')
    expect(prompt).not.toContain('toolkit')
  })

  it('describes an Advanced portfolio by its Properties, groups and classed queries, naming toolkits when they load progressively', () => {
    const now = new Date().toISOString()
    const plan = {
      schemaVersion: 2,
      targets: [{ stableKey: 'harbor' }, { stableKey: 'bayside' }, { stableKey: 'cedar' }],
      groups: [{ stableKey: 'metro' }, { stableKey: 'market-a', parentGroupKey: 'metro' }, { stableKey: 'market-b', parentGroupKey: 'metro' }],
      assignments: [
        { targetKey: 'harbor', queryId: 'b1', queryClass: 'branded' },
        { targetKey: 'bayside', queryId: 'b2', queryClass: 'branded' },
        // One non-brand query shared by two Properties counts once.
        { targetKey: 'harbor', queryId: 'n1', queryClass: 'non-brand' },
        { targetKey: 'bayside', queryId: 'n1', queryClass: 'non-brand' },
        { targetKey: 'cedar', queryId: 'n2', queryClass: 'non-brand' },
      ],
    }
    db.insert(measurementPlanVersions).values({
      id: 'v7', projectId: 'proj_acme', revision: 7, canonicalJson: JSON.stringify(plan), checksum: 'c', schemaVersion: 2, createdAt: now,
    }).run()
    db.insert(measurementPlans).values({ projectId: 'proj_acme', activeVersionId: 'v7', createdAt: now, updatedAt: now }).run()

    const progressive = aeroProjectShapePrompt(db, 'proj_acme', { progressive: true })
    expect(progressive).toContain('an Advanced Measurement portfolio (plan revision 7) with 3 Properties in 3 groups (1 top-level, 2 nested), 2 branded and 2 non-brand queries')
    expect(progressive).toContain('never pool branded and non-brand')
    expect(progressive).toContain('canonry_measurement_portfolio_summary (toolkit "monitoring")')

    const full = aeroProjectShapePrompt(db, 'proj_acme', { progressive: false })
    expect(full).toContain('canonry_measurement_portfolio_summary (weakest-first')
    expect(full).not.toContain('toolkit')
  })

  it('never blocks a turn when the project cannot be read', () => {
    const broken = { select: () => { throw new Error('database is locked') } } as unknown as DatabaseClient
    expect(aeroProjectShapePrompt(broken, 'proj_acme', { progressive: true })).toBe('')
  })
})
