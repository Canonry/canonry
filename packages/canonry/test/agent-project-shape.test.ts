import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient, measurementPlans, measurementPlanVersions, migrate, projects, queries, type DatabaseClient } from '@ainyc/canonry-db'
import { aeroProjectShape } from '../src/agent/project-shape.js'
import { MAX_VISIBLE_TOOLS } from '../src/agent/runtime.js'
import { canonryMcpTools } from '../src/mcp/tool-registry.js'

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
    // The reads for completeness and for names given instead across the
    // portfolio are pinned too, so the routes below never meet "not found".
    expect(shape.pinned).toEqual(expect.arrayContaining([
      'canonry_measurement_data_quality',
      'canonry_run_completeness',
      'canonry_competitor_landscape',
    ]))
    // Reading rules for the portfolio summary: markets come from the tools,
    // names given instead are answer text, denominators are answers, ties are
    // not ranks, and sources are read per class and run.
    expect(shape.prompt).toContain('Group Properties only by the metro and submarkets the tools return')
    expect(shape.prompt).toContain('written in the answer text, not cited')
    expect(shape.prompt).toContain('Denominators count answers (queries x engines)')
    expect(shape.prompt).toContain('tied at the weakest rate are not ranked')
    expect(shape.prompt).toContain('say how many tie (tiedAtWeakest.count), give tiedAtWeakest.byMetro')
    expect(shape.prompt).toContain('canonry_measurement_plan_get is plan structure with no metrics')
    expect(shape.prompt).not.toContain('—')
  })

  it('routes each Advanced question kind to the read that answers it', () => {
    const now = new Date().toISOString()
    const plan = {
      schemaVersion: 2,
      targets: [{ stableKey: 'harbor' }, { stableKey: 'bayside' }],
      groups: [{ stableKey: 'metro' }],
      assignments: [{ targetKey: 'harbor', queryId: 'n1', queryClass: 'non-brand' }],
    }
    db.insert(measurementPlanVersions).values({
      id: 'v2', projectId: 'proj_acme', revision: 2, canonicalJson: JSON.stringify(plan), checksum: 'c', schemaVersion: 2, createdAt: now,
    }).run()
    db.insert(measurementPlans).values({ projectId: 'proj_acme', activeVersionId: 'v2', createdAt: now, updatedAt: now }).run()

    const { prompt } = aeroProjectShape(db, 'proj_acme')
    const route = (question: string) => prompt.split('\n').find(line => line.startsWith(`- ${question}`)) ?? ''
    // Completeness is read from expected/executed/missing, never a run status.
    expect(route('Is the sweep complete')).toContain('canonry_measurement_data_quality')
    expect(route('Is the sweep complete')).toContain('canonry_run_completeness')
    expect(route('Is the sweep complete')).toContain('expected, executed and missing')
    expect(route('Is the sweep complete')).toContain('A Healthy run status and canonry_doctor are not completeness checks')
    // Portfolio-wide names come from the landscape on the latest sweep, not from a few weak rows.
    expect(route('Which names answers give instead')).toContain('canonry_competitor_landscape with queryClass and runId "latest"')
    expect(route('Which names answers give instead')).toContain('samples')
    expect(route('Where answers get their sources')).toContain('canonry_analytics_sources with queryClass and runId "latest"')
    expect(route('What changed')).toContain('canonry_measurement_changes once per class')
    expect(route('What changed')).toContain('distribution')
    expect(route('Which metros')).toContain('tiedAtWeakest.byMetro')
    // Sweep-over-sweep noise and partial results are hard rules, not hints.
    expect(prompt).toContain('a Property that moved 2 answers or fewer is within noise (withinNoise)')
    expect(prompt).toContain('never call those rows the biggest, all, or the full picture')
    // The runtime's own partial-list field counts as partial too.
    expect(prompt).toContain('__partialLists or __truncation is partial')
    expect(prompt).toContain('This line settles the project type')
    expect(prompt).not.toContain('—')
  })

  it('pins only real read tools, and leaves room for a loaded toolkit under the provider tool limit', () => {
    const now = new Date().toISOString()
    db.insert(measurementPlanVersions).values({
      id: 'v1', projectId: 'proj_acme', revision: 1, canonicalJson: JSON.stringify({ schemaVersion: 2, targets: [], groups: [] }), checksum: 'c', schemaVersion: 2, createdAt: now,
    }).run()
    db.insert(measurementPlans).values({ projectId: 'proj_acme', activeVersionId: 'v1', createdAt: now, updatedAt: now }).run()
    const { pinned } = aeroProjectShape(db, 'proj_acme')

    const byName = new Map(canonryMcpTools.map(tool => [tool.name as string, tool]))
    // A viewer turn only carries read tools, so a pinned write tool would vanish for it.
    for (const name of pinned) expect(byName.get(name)?.access, name).toBe('read')
    // Core tools and pins are never unloaded, so together with the largest
    // toolkit they must fit the limit with room for the Aero-only tools: five
    // skill-doc readers, the view reader and the two toolkit controls.
    const aeroOnlyTools = 8
    const core = canonryMcpTools.filter(tool => tool.tier === 'core').length
    const pinnedOutsideCore = pinned.filter(name => byName.get(name)?.tier !== 'core').length
    const tiers = new Map<string, number>()
    for (const tool of canonryMcpTools) tiers.set(tool.tier, (tiers.get(tool.tier) ?? 0) + 1)
    const largestToolkit = Math.max(...[...tiers].filter(([tier]) => tier !== 'core').map(([, size]) => size))
    expect(core + pinnedOutsideCore + largestToolkit + aeroOnlyTools).toBeLessThanOrEqual(MAX_VISIBLE_TOOLS)
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
    expect(shape.pinned).toEqual(['canonry_measurement_overview', 'canonry_measurement_plan_get', 'canonry_run_completeness'])
    expect(shape.pinned).not.toContain('canonry_measurement_portfolio_summary')
    // v1 plan runs carry a manifest, so completeness is read from their slots.
    expect(shape.prompt).toContain('measurement.displayedRunId to canonry_run_completeness')
    for (const tool of shape.pinned) expect(shape.prompt).toContain(tool)
  })

  it('never blocks a turn when the project cannot be read', () => {
    const broken = { select: () => { throw new Error('database is locked') } } as unknown as DatabaseClient
    expect(aeroProjectShape(broken, 'proj_acme')).toEqual({ prompt: '', pinned: [] })
  })
})
