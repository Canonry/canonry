import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { auditLog, competitors, createClient, measurementPlans, measurementPlanVersions, migrate, projects, queries, querySnapshots, runs, type DatabaseClient } from '@ainyc/canonry-db'
import { canonicalMeasurementPlanV2Json, competitorChangePreviewResponseSchema, measurementPlanV2Schema } from '@ainyc/canonry-contracts'
import { apiRoutes } from '../src/index.js'

const NOW = '2026-08-20T12:00:00.000Z'
let tmpDir: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>
let callbackCounts: { aliases: number; rescan: number }

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-competitor-change-preview-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  db.insert(projects).values({
    id: 'project_preview', name: 'preview', displayName: 'Northwind', canonicalDomain: 'northwind.example',
    ownedDomains: [], country: 'US', language: 'en', providers: ['openai'], locations: [], createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(competitors).values({ id: 'preview_rival', projectId: 'project_preview', domain: 'rival.example', provenance: 'manual', createdAt: NOW }).run()
  db.insert(queries).values({ id: 'preview_query', projectId: 'project_preview', query: 'best homes near here', createdAt: NOW }).run()
  db.insert(runs).values({ id: 'preview_run', projectId: 'project_preview', kind: 'answer-visibility', status: 'completed', trigger: 'manual', location: null, createdAt: NOW }).run()
  db.insert(querySnapshots).values({
    id: 'preview_snapshot', runId: 'preview_run', queryId: 'preview_query', queryText: 'best homes near here', provider: 'openai', citationState: 'not-cited',
    answerMentioned: true, answerText: 'Northwind and Rival are useful choices.', citedDomains: ['rival.example'], citedUrls: null,
    captureStatus: 'complete', competitorOverlap: [], location: null, createdAt: NOW,
  }).run()
  db.insert(querySnapshots).values({
    id: 'preview_untracked', runId: 'preview_run', queryId: 'preview_query', queryText: 'best homes near here', provider: 'openai', citationState: 'not-cited',
    answerMentioned: false, answerText: 'Newrival is another useful choice.', citedDomains: ['newrival.example'], citedUrls: null,
    captureStatus: 'complete', competitorOverlap: [], location: null, createdAt: NOW,
  }).run()
  callbackCounts = { aliases: 0, rescan: 0 }
  app = Fastify()
  app.register(apiRoutes, {
    db,
    skipAuth: true,
    onCompetitorAliasesChanged: () => { callbackCounts.aliases++ },
    onCompetitorAutoAliasRescan: () => { callbackCounts.rescan++ },
  })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('POST /api/v1/projects/:name/competitor-changes/preview', () => {
  it('removes only requested rows without pruning retained legacy aliases', async () => {
    db.update(competitors).set({ aliases: ['Northwind'] }).run()
    const preview = await app.inject({ method: 'POST', url: '/api/v1/projects/preview/competitor-changes/preview', payload: { change: 'remove', competitors: ['missing.example'] } })
    expect(preview.statusCode, preview.body).toBe(200)
    const body = competitorChangePreviewResponseSchema.parse(preview.json())
    expect(body.plan).toMatchObject({ added: [], removed: [], aliasChanges: [], droppedAliases: [], autoAliasChanges: [], droppedAutoAliases: [] })
    expect(body.impact.after).toEqual(body.impact.before)
    const write = await app.inject({ method: 'DELETE', url: '/api/v1/projects/preview/competitors', payload: { competitors: ['missing.example'] } })
    expect(write.statusCode, write.body).toBe(200)
    expect(write.json()[0].aliases).toEqual(['Northwind'])
  })

  it('returns a typed before and after impact without writing an add', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/preview/competitor-changes/preview',
      payload: { change: 'add', competitors: ['newrival.example'] },
    })
    expect(response.statusCode, response.body).toBe(200)
    const body = competitorChangePreviewResponseSchema.parse(response.json())
    expect(body.change).toBe('add')
    expect(body.plan.added).toEqual(['newrival.example'])
    expect(body.impact.before.percent).toBe(50)
    expect(body.impact.after.percent).toBeCloseTo(33.333333, 5)
    expect(body.impact.deltaPercent).toBeCloseTo(-16.666667, 5)
    expect(body.impact.restatesHistory).toBe(true)
    expect(db.select().from(competitors).all().map(row => row.domain)).toEqual(['rival.example'])
  })

  it('marks a measured apply-mode add as awaiting the automatic alias rescan', async () => {
    db.update(projects).set({ competitorAutoAliases: 'apply' }).run()
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/preview/competitor-changes/preview',
      payload: { change: 'add', competitors: ['newrival.example'] },
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().impact.caveats).toContain('auto-alias-rescan-pending')
  })

  it('previews a curated alias set without an implicit write', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/preview/competitor-changes/preview',
      payload: { change: 'aliases', domain: 'rival.example', aliases: ['Rival Co'], mode: 'set' },
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().plan.aliasChanges).toEqual([{ domain: 'rival.example', before: [], after: ['Rival Co'] }])
    expect(db.select().from(competitors).get()?.aliases).toEqual([])
  })

  it('refuses an alias preview for an untracked competitor like the write route', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/preview/competitor-changes/preview',
      payload: { change: 'aliases', domain: 'missing.example', aliases: ['Missing'], mode: 'set' },
    })
    expect(response.statusCode).toBe(404)
    expect(db.select().from(competitors).all()).toHaveLength(1)
  })

  it('keeps remove and replace previews aligned with their domain-only writes', async () => {
    const remove = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/preview/competitor-changes/preview',
      payload: { change: 'remove', competitors: ['rival.example'] },
    })
    expect(remove.statusCode, remove.body).toBe(200)
    const removeBody = competitorChangePreviewResponseSchema.parse(remove.json())
    expect(removeBody.plan.removed).toEqual(['rival.example'])

    const replace = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/preview/competitor-changes/preview',
      payload: { change: 'replace', competitors: ['replacement.example'] },
    })
    expect(replace.statusCode, replace.body).toBe(200)
    const replaceBody = competitorChangePreviewResponseSchema.parse(replace.json())
    expect(replaceBody.plan.removed).toEqual(['rival.example'])
    expect(replaceBody.plan.added).toEqual(['replacement.example'])
  })

  it('previews the exact 40% to 20% change without writes and excludes a probe run', async () => {
    db.delete(querySnapshots).run()
    db.insert(queries).values({ id: 'preview_brand_query', projectId: 'project_preview', query: 'Northwind reviews', createdAt: NOW }).run()
    db.insert(runs).values({ id: 'preview_probe', projectId: 'project_preview', kind: 'answer-visibility', status: 'completed', trigger: 'probe', location: null, createdAt: '2026-08-21T12:00:00.000Z' }).run()
    db.insert(querySnapshots).values([
      ...Array.from({ length: 2 }, (_, index) => ({ id: `north-${index}`, runId: 'preview_run', queryId: 'preview_query', queryText: 'best homes near here', provider: 'openai', citationState: 'not-cited' as const, answerMentioned: true, answerText: `Northwind is useful ${index}.`, citedDomains: ['rival.example'], citedUrls: null, captureStatus: 'complete' as const, competitorOverlap: [], location: null, createdAt: NOW })),
      ...Array.from({ length: 3 }, (_, index) => ({ id: `rival-${index}`, runId: 'preview_run', queryId: 'preview_query', queryText: 'best homes near here', provider: 'openai', citationState: 'not-cited' as const, answerMentioned: false, answerText: `Rival is useful ${index}.`, citedDomains: ['rival.example'], citedUrls: null, captureStatus: 'complete' as const, competitorOverlap: [], location: null, createdAt: NOW })),
      ...Array.from({ length: 5 }, (_, index) => ({ id: `new-rival-${index}`, runId: 'preview_run', queryId: 'preview_query', queryText: 'best homes near here', provider: 'openai', citationState: 'not-cited' as const, answerMentioned: false, answerText: `Newrival is useful ${index}.`, citedDomains: ['newrival.example'], citedUrls: null, captureStatus: 'complete' as const, competitorOverlap: [], location: null, createdAt: NOW })),
      { id: 'brand-only', runId: 'preview_run', queryId: 'preview_brand_query', queryText: 'Northwind reviews', provider: 'openai', citationState: 'not-cited' as const, answerMentioned: true, answerText: 'Northwind and Newrival.', citedDomains: ['newrival.example'], citedUrls: null, captureStatus: 'complete' as const, competitorOverlap: [], location: null, createdAt: NOW },
      { id: 'probe-only', runId: 'preview_probe', queryId: 'preview_query', queryText: 'best homes near here', provider: 'openai', citationState: 'not-cited' as const, answerMentioned: true, answerText: 'Northwind and Newrival probe.', citedDomains: ['newrival.example'], citedUrls: null, captureStatus: 'complete' as const, competitorOverlap: [], location: null, createdAt: '2026-08-21T12:00:00.000Z' },
    ]).run()
    const response = await app.inject({ method: 'POST', url: '/api/v1/projects/preview/competitor-changes/preview', payload: { change: 'add', competitors: ['newrival.example'] } })
    expect(response.statusCode, response.body).toBe(200)
    const body = competitorChangePreviewResponseSchema.parse(response.json())
    expect(body.impact.before).toMatchObject({ projectMentions: 2, competitorMentions: 3, percent: 40 })
    expect(body.impact.after).toMatchObject({ projectMentions: 2, competitorMentions: 8, percent: 20 })
    expect(db.select().from(competitors).all().map(row => row.domain)).toEqual(['rival.example'])
    expect(db.select().from(auditLog).all()).toEqual([])
    expect(callbackCounts).toEqual({ aliases: 0, rescan: 0 })
    expect(body.impact.deltaPercent).toBe(-20)
    expect(body.impact.before.competitorCount).toBe(1)
    expect(body.impact.after.competitorCount).toBe(2)
    expect(body.impact.before.snapshotsWithAnswerText).toBe(10)
    expect(body.impact.runCount).toBe(1)
  })

  it('returns pooled caveat without a brand identity and no-answers availability without inventing zero', async () => {
    db.update(projects).set({ displayName: '', canonicalDomain: '' }).run()
    const pooled = await app.inject({ method: 'POST', url: '/api/v1/projects/preview/competitor-changes/preview', payload: { change: 'add', competitors: ['newrival.example'] } })
    expect(pooled.statusCode, pooled.body).toBe(200)
    expect(pooled.json().impact).toMatchObject({ queryClass: 'pooled', caveats: expect.arrayContaining(['pooled']) })
    db.update(projects).set({ displayName: 'Northwind', canonicalDomain: 'northwind.example' }).run()
    db.delete(querySnapshots).run()
    const empty = await app.inject({ method: 'POST', url: '/api/v1/projects/preview/competitor-changes/preview', payload: { change: 'add', competitors: ['another.example'] } })
    expect(empty.statusCode, empty.body).toBe(200)
    expect(empty.json().impact.before).toMatchObject({ percent: null, reason: 'no-answers' })
    expect(empty.json().impact.after).toMatchObject({ percent: null, reason: 'no-answers' })
    expect(empty.json().impact.deltaPercent).toBeNull()
  })

  it('keeps zero-removal previews read-only and fires no write callbacks or audit rows', async () => {
    const beforeAudit = db.select().from(auditLog).all().length
    const response = await app.inject({ method: 'POST', url: '/api/v1/projects/preview/competitor-changes/preview', payload: { change: 'remove', competitors: ['missing.example'] } })
    expect(response.statusCode, response.body).toBe(200)
    expect(competitorChangePreviewResponseSchema.parse(response.json()).plan.removed).toEqual([])
    expect(callbackCounts).toEqual({ aliases: 0, rescan: 0 })
    expect(db.select().from(auditLog).all()).toHaveLength(beforeAudit)
  })


  it.each(['add', 'remove', 'set', 'append'] as const)('matches the stored landscape before and after a real %s write', async kind => {
    const aliases = ['Newrival']
    const previewRequest = kind === 'add' || kind === 'remove'
      ? { change: kind, competitors: [kind === 'add' ? 'newrival.example' : 'rival.example'] }
      : { change: 'aliases', domain: 'rival.example', aliases, mode: kind === 'set' ? 'set' : 'add' }
    const read = async () => (await app.inject({ method: 'GET', url: '/api/v1/projects/preview/analytics/competitors?queryClass=non-brand&runId=latest' })).json()
    const before = await read()
    const preview = await app.inject({ method: 'POST', url: '/api/v1/projects/preview/competitor-changes/preview', payload: previewRequest })
    expect(preview.statusCode, preview.body).toBe(200)
    const impact = competitorChangePreviewResponseSchema.parse(preview.json()).impact
    expect(impact.before.percent).toBe(before.project.shareOfVoice)
    expect(impact.before.projectMentions + impact.before.competitorMentions).toBe(before.evidence.mentionCredits)
    const write = kind === 'set'
      ? await app.inject({ method: 'PUT', url: '/api/v1/projects/preview/competitors/rival.example/aliases', payload: { aliases } })
      : await app.inject({ method: kind === 'remove' ? 'DELETE' : 'POST', url: '/api/v1/projects/preview/competitors', payload: { competitors: kind === 'append' ? [{ domain: 'rival.example', aliases }] : [kind === 'add' ? 'newrival.example' : 'rival.example'] } })
    expect(write.statusCode, write.body).toBe(200)
    const after = await read()
    expect(impact.after.percent).toBe(after.project.shareOfVoice)
    expect(impact.after.projectMentions + impact.after.competitorMentions).toBe(after.evidence.mentionCredits)
    expect(impact.after.competitorCount).toBe(after.comparison.length)
    if (kind === 'remove') expect(impact.after.percent).toBeNull()
  })

  it.each(['own-site', 'claimed-name', 'duplicate-rows'] as const)('keeps %s refusal identical to the real write', async kind => {
    if (kind === 'claimed-name') db.update(competitors).set({ aliases: ['Newrival'] }).run()
    if (kind === 'duplicate-rows') db.insert(competitors).values({ id: 'duplicate-rival', projectId: 'project_preview', domain: 'www.rival.example', provenance: 'manual', createdAt: NOW }).run()
    const entry = kind === 'own-site' ? 'northwind.example' : kind === 'claimed-name' ? 'newrival.example' : { domain: 'rival.example', aliases: ['Rival Name'] }
    const rows = db.select().from(competitors).all()
    const preview = await app.inject({ method: 'POST', url: '/api/v1/projects/preview/competitor-changes/preview', payload: { change: 'add', competitors: [entry] } })
    const write = await app.inject({ method: 'POST', url: '/api/v1/projects/preview/competitors', payload: { competitors: [entry] } })
    expect(preview.statusCode, preview.body).toBe(400)
    expect(write.statusCode, write.body).toBe(400)
    expect(preview.json().error.code).toBe(write.json().error.code)
    expect(preview.json().error.details).toEqual(write.json().error.details)
    expect(db.select().from(competitors).all()).toEqual(rows)
    expect(db.select().from(auditLog).all()).toEqual([])
    expect(callbackCounts).toEqual({ aliases: 0, rescan: 0 })
  })

  it('reports an Advanced preview against its frozen non-brand execution', async () => {
    const plan = measurementPlanV2Schema.parse({
      schemaVersion: 2,
      identities: { projectBrand: { canonicalHost: 'northwind.example', ownedHosts: ['northwind.example'], names: ['Northwind'] } },
      targets: [{ stableKey: 'preview-target', label: 'Preview Target', aliases: ['Northwind'], urlMatchers: [{ kind: 'host', host: 'northwind.example' }], mentionNotApplicable: false, discoveryIdentity: null }],
      groups: [{ stableKey: 'preview-market', label: 'Preview Market', targetKeys: ['preview-target'], competitors: [{ stableKey: 'rival', label: 'Rival', domain: 'rival.example', aliases: ['Rival'] }] }],
      querySnapshots: [{ queryId: 'preview_query', queryText: 'best homes near here', provenance: { source: 'manual', sourceId: null, capturedAt: NOW } }],
      assignments: [
        { targetKey: 'preview-target', queryId: 'preview_query', queryClass: 'branded', executionNodeKey: 'preview-branded' },
        { targetKey: 'preview-target', queryId: 'preview_query', queryClass: 'non-brand', executionNodeKey: 'preview-non-brand' },
      ],
      executionNodes: [
        { stableKey: 'preview-branded', queryId: 'preview_query', queryText: 'best homes near here', context: { providers: ['openai'], models: {}, location: null }, expectedSnapshots: 1 },
        { stableKey: 'preview-non-brand', queryId: 'preview_query', queryText: 'best homes near here', context: { providers: ['openai'], models: {}, location: null }, expectedSnapshots: 1 },
      ],
      usageEdges: [{ executionNodeKey: 'preview-branded', targetKey: 'preview-target', queryId: 'preview_query' }, { executionNodeKey: 'preview-non-brand', targetKey: 'preview-target', queryId: 'preview_query' }],
      compiledChecksum: 'b'.repeat(64),
    })
    db.insert(measurementPlanVersions).values({ id: 'preview-v2', projectId: 'project_preview', revision: 1, canonicalJson: canonicalMeasurementPlanV2Json(plan), checksum: '1'.repeat(64), schemaVersion: 2, compiledChecksum: plan.compiledChecksum, createdAt: NOW }).run()
    db.insert(measurementPlans).values({ projectId: 'project_preview', activeVersionId: 'preview-v2', createdAt: NOW, updatedAt: NOW }).run()
    db.update(runs).set({ measurementPlanVersionId: 'preview-v2' }).where(eq(runs.id, 'preview_run')).run()
    db.update(querySnapshots).set({ measurementExecutionId: 'preview-branded', answerText: 'Northwind and Rival.', citedDomains: ['rival.example'], answerMentioned: true }).where(eq(querySnapshots.id, 'preview_snapshot')).run()
    db.insert(querySnapshots).values({ id: 'preview-non-brand-answer', runId: 'preview_run', queryId: 'preview_query', queryText: 'best homes near here', provider: 'openai', citationState: 'not-cited', answerMentioned: false, answerText: 'Rival is useful.', citedDomains: ['rival.example'], citedUrls: null, captureStatus: 'complete', competitorOverlap: [], location: null, measurementExecutionId: 'preview-non-brand', createdAt: NOW }).run()
    const response = await app.inject({ method: 'POST', url: '/api/v1/projects/preview/competitor-changes/preview', payload: { change: 'add', competitors: ['newrival.example'] } })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().impact.queryClass).toBe('non-brand')
    expect(response.json().impact.before.projectMentions).toBe(0)
    expect(response.json().impact.after.competitorMentions).toBe(1)
  })
})
