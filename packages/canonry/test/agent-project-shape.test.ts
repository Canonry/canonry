import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient, measurementPlans, measurementPlanVersions, migrate, projects, queries, type DatabaseClient } from '@ainyc/canonry-db'
import { aeroProjectShape } from '../src/agent/project-shape.js'

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
    const shape = aeroProjectShape(db, 'proj_acme')

    expect(shape.prompt).toContain('a Simple project with 2 tracked queries and no measurement plan')
    expect(shape.prompt).toContain('canonry_visibility_report')
    expect(shape.pinned).toEqual(['canonry_visibility_report'])
  })

  it('describes an Advanced portfolio by its Properties, groups and classed queries, and pins the tools it names', () => {
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

    const shape = aeroProjectShape(db, 'proj_acme')
    expect(shape.prompt).toContain('an Advanced Measurement portfolio (plan revision 7) with 3 Properties in 3 groups (1 top-level, 2 nested), 2 branded and 2 non-brand queries')
    expect(shape.prompt).toContain('never pool branded and non-brand')
    // Every tool the prompt tells Aero to start with is pinned visible.
    for (const tool of shape.pinned) expect(shape.prompt).toContain(tool)
    expect(shape.pinned).toContain('canonry_measurement_portfolio_summary')
    expect(shape.pinned).toContain('canonry_analytics_sources')
    // Reading rules for the portfolio summary: markets come from the tools,
    // names given instead are answer text, denominators are answers, ties are
    // not ranks, and sources are read per class and run.
    expect(shape.prompt).toContain('Group Properties only by the metro and submarkets the tools return')
    expect(shape.prompt).toContain('written in the answer text, not cited')
    expect(shape.prompt).toContain('Denominators count answers (queries x engines)')
    expect(shape.prompt).toContain('tied at the weakest rate are not ranked')
    expect(shape.prompt).toContain('canonry_analytics_sources with queryClass and runId set')
    expect(shape.prompt).toContain('canonry_measurement_plan_get is plan structure with no metrics')
    expect(shape.prompt).not.toContain('—')
  })

  it('describes a legacy schema-v1 plan without inventing query classes, and names only tools that read it', () => {
    const now = new Date().toISOString()
    // v1 plans carry targets and groups but no classified assignments.
    const plan = { schemaVersion: 1, targets: [{ stableKey: 'harbor' }, { stableKey: 'bayside' }], groups: [{ stableKey: 'metro' }], usageEdges: [{ kind: 'target' }] }
    db.insert(measurementPlanVersions).values({
      id: 'v3', projectId: 'proj_acme', revision: 3, canonicalJson: JSON.stringify(plan), checksum: 'c', schemaVersion: 1, createdAt: now,
    }).run()
    db.insert(measurementPlans).values({ projectId: 'proj_acme', activeVersionId: 'v3', createdAt: now, updatedAt: now }).run()

    const shape = aeroProjectShape(db, 'proj_acme')
    expect(shape.prompt).toContain('legacy schema v1 (plan revision 3) with 2 Properties in 1 groups')
    expect(shape.prompt).toContain('not classified as branded or non-brand')
    expect(shape.prompt).not.toMatch(/\d+ branded and \d+ non-brand queries/)
    expect(shape.pinned).toEqual(['canonry_measurement_overview', 'canonry_measurement_plan_get'])
    expect(shape.pinned).not.toContain('canonry_measurement_portfolio_summary')
  })

  it('never blocks a turn when the project cannot be read', () => {
    const broken = { select: () => { throw new Error('database is locked') } } as unknown as DatabaseClient
    expect(aeroProjectShape(broken, 'proj_acme')).toEqual({ prompt: '', pinned: [] })
  })
})
