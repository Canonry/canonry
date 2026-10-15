import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  auditLog,
  createClient,
  measurementDiscoveryConfigs,
  measurementPlanDrafts,
  measurementPlanVersions,
  measurementPlans,
  migrate,
  projects,
  runs,
} from '@canonry/canonry-db'
import type { MeasurementDraftAuthoring } from '@canonry/canonry-contracts'
import { apiRoutes } from '../src/index.js'
import type { ApiRoutesOptions } from '../src/index.js'
import { measurementDiscoveryIdentity } from '../src/measurement-discovery-v2.js'

// The route reaches the network through this module. Mocking it keeps the
// happy paths off a socket while leaving the real, hardened implementation
// available to the egress test below.
const fetchSitemap = vi.fn()
vi.mock('../src/measurement-sitemap-fetch.js', async () => {
  const actual = await vi.importActual<typeof import('../src/measurement-sitemap-fetch.js')>('../src/measurement-sitemap-fetch.js')
  return { ...actual, fetchMeasurementSitemap: (...args: unknown[]) => fetchSitemap(...args) }
})

const NOW = '2026-08-01T00:00:00.000Z'
const HOST = 'northstar.example'
const RULE = { primary: { host: HOST, pathTemplate: '/locations/{slug}' } }
const MOVED_RULE = { primary: { host: HOST, pathTemplate: '/areas/{slug}' } }

const emptyAuthoring: MeasurementDraftAuthoring = {
  defaultContext: { providers: ['openai'], locations: [] },
  targets: [],
  assignments: [],
  groups: [],
}

function sitemap(pathTemplate: string, slugs: readonly string[], bytesChecksum = 'a'.repeat(64)) {
  return {
    urls: slugs.map(slug => `https://${HOST}${pathTemplate.replace('{slug}', slug)}`).sort(),
    fetchedSitemaps: 1,
    bytesChecksum,
  }
}

let app: ReturnType<typeof Fastify>
let db: ReturnType<typeof createClient>
let tmpDir: string

function seedDraft(authoring: MeasurementDraftAuthoring = emptyAuthoring, etagVersion = 1) {
  db.delete(measurementPlanDrafts).run()
  const actor = JSON.stringify({ kind: 'system', id: 'system', label: 'system' })
  db.insert(measurementPlanDrafts).values({
    id: 'mpd_1',
    projectId: 'prj_1',
    schemaVersion: 2,
    baseActiveVersionId: null,
    baseActiveRevision: null,
    authoringJson: JSON.stringify(authoring),
    etagVersion,
    createdBy: actor,
    updatedBy: actor,
    createdAt: NOW,
    updatedAt: NOW,
  }).run()
}

function storedAuthoring(): MeasurementDraftAuthoring {
  const row = db.select().from(measurementPlanDrafts).where(eq(measurementPlanDrafts.projectId, 'prj_1')).get()
  return JSON.parse(row!.authoringJson) as MeasurementDraftAuthoring
}

async function post(action: string, payload: unknown, headers: Record<string, string> = {}) {
  return await app.inject({
    method: 'POST',
    url: `/api/v1/projects/northstar/measurement-plan/draft/actions/${action}`,
    headers: { 'if-match': '"mpd_1"', 'idempotency-key': crypto.randomUUID(), ...headers },
    payload,
  })
}

async function importSitemap(payload: unknown = { sitemapUrl: `https://${HOST}/sitemap.xml`, rule: RULE }, headers = {}) {
  return await post('import-sitemap', payload, headers)
}

beforeEach(async () => {
  fetchSitemap.mockReset().mockResolvedValue(sitemap('/locations/{slug}', ['north-park', 'harbour-quay']))
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-measurement-discovery-v2-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  db.insert(projects).values({
    id: 'prj_1',
    name: 'northstar',
    displayName: 'Northstar',
    canonicalDomain: HOST,
    country: 'US',
    language: 'en',
    createdAt: NOW,
    updatedAt: NOW,
  }).run()
  seedDraft()

  app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true } satisfies ApiRoutesOptions)
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('guards', () => {
  test('refuses a mutation that does not state the draft it acted on', async () => {
    const response = await importSitemap(undefined, { 'if-match': '' })
    expect(response.statusCode).toBe(428)
    expect(response.json()).toMatchObject({ error: { code: 'MEASUREMENT_DRAFT_ETAG_REQUIRED' } })
  })

  test('refuses a stale ETag', async () => {
    const response = await importSitemap(undefined, { 'if-match': '"mpd_0"' })
    expect(response.statusCode).toBe(412)
    expect(response.json()).toMatchObject({ error: { code: 'MEASUREMENT_DRAFT_ETAG_STALE' } })
  })

  test('requires an idempotency key', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/northstar/measurement-plan/draft/actions/import-sitemap',
      headers: { 'if-match': '"mpd_1"' },
      payload: { sitemapUrl: `https://${HOST}/sitemap.xml`, rule: RULE },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'MEASUREMENT_IDEMPOTENCY_KEY_REQUIRED' } })
  })

  test('replays a repeated key and refuses the same key over different content', async () => {
    const key = 'import-once'
    const first = await importSitemap(undefined, { 'idempotency-key': key })
    expect(first.statusCode).toBe(200)

    // The ETag has moved on, so a replay that re-ran would fail the ETag guard.
    const replay = await importSitemap(undefined, { 'idempotency-key': key })
    expect(replay.statusCode).toBe(200)
    expect(replay.json()).toEqual(first.json())
    expect(fetchSitemap).toHaveBeenCalledOnce()

    const conflict = await importSitemap(
      { sitemapUrl: `https://${HOST}/other.xml`, rule: RULE },
      { 'idempotency-key': key, 'if-match': '"mpd_2"' },
    )
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json()).toMatchObject({ error: { code: 'MEASUREMENT_IDEMPOTENCY_KEY_CONFLICT' } })
  })

  test('answers 404 for a project with no draft', async () => {
    db.delete(measurementPlanDrafts).run()
    const response = await importSitemap()
    expect(response.statusCode).toBe(404)
  })
})

describe('import', () => {
  test('proposes Targets and neither includes, publishes nor runs anything', async () => {
    const response = await importSitemap()
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      etag: '"mpd_2"',
      changed: true,
      counts: { targets: 2, includedTargets: 0, assignments: 0, groups: 0 },
    })
    expect(response.headers.etag).toBe('"mpd_2"')

    const targets = storedAuthoring().targets
    expect(targets.map(target => target.status)).toEqual(['proposed', 'proposed'])
    expect(targets.map(target => target.stableKey)).toEqual(['target-harbour-quay', 'target-north-park'])
    expect(targets.every(target => target.source === 'sitemap' && Boolean(target.discoveryIdentity))).toBe(true)

    expect(db.select().from(measurementPlanVersions).all()).toEqual([])
    expect(db.select().from(measurementPlans).all()).toEqual([])
    expect(db.select().from(runs).all()).toEqual([])
  })

  test('seeds mention-safe generated Property labels as aliases and compiles them without an alias warning', async () => {
    await importSitemap()

    const imported = storedAuthoring().targets
    expect(imported.map(target => [target.label, target.aliases])).toEqual([
      ['Harbour Quay', ['Harbour Quay']],
      ['North Park', ['North Park']],
    ])

    const selected = await post('apply-sitemap-selection', {
      selections: imported.map(target => ({ discoveryIdentity: target.discoveryIdentity, action: 'create' })),
    }, { 'if-match': '"mpd_2"' })
    expect(selected.statusCode).toBe(200)

    const compiled = await post('compile-preview', {}, { 'if-match': '"mpd_3"' })
    expect(compiled.statusCode).toBe(200)
    expect((compiled.json().checks as Array<{ ruleId: string }>).map(check => check.ruleId))
      .not.toContain('target-without-aliases')
  })

  test('refuses to compile included generated aliases that normalize to one Property identity', async () => {
    fetchSitemap.mockResolvedValue(sitemap('/locations/{slug}', ['north-park', 'north_park']))
    await importSitemap()

    const imported = storedAuthoring().targets
    expect(imported.map(target => [target.stableKey, target.aliases])).toEqual([
      ['target-north-park', ['North Park']],
      ['target-north_park', ['North Park']],
    ])
    const selected = await post('apply-sitemap-selection', {
      selections: imported.map(target => ({ discoveryIdentity: target.discoveryIdentity, action: 'create' })),
    }, { 'if-match': '"mpd_2"' })
    expect(selected.statusCode).toBe(200)

    const compiled = await post('compile-preview', {}, { 'if-match': '"mpd_3"' })
    expect(compiled.statusCode).toBe(200)
    expect(compiled.json()).toMatchObject({
      ok: false,
      checks: expect.arrayContaining([expect.objectContaining({
        ruleId: 'target-alias-ambiguous',
        severity: 'fail',
        path: ['targets', 1, 'aliases', 0],
      })]),
    })
  })

  test('leaves a short generated Property label aliasless', async () => {
    fetchSitemap.mockResolvedValue(sitemap('/locations/{slug}', ['inn']))

    await importSitemap()

    expect(storedAuthoring().targets).toEqual([
      expect.objectContaining({ label: 'Inn', aliases: [] }),
    ])
  })

  test('does not rewrite the generated alias when the operator renames the Property', async () => {
    fetchSitemap.mockResolvedValue(sitemap('/locations/{slug}', ['north-park']))
    await importSitemap()

    const [proposal] = storedAuthoring().targets
    const selected = await post('apply-sitemap-selection', {
      selections: [{
        discoveryIdentity: proposal!.discoveryIdentity,
        action: 'create',
        label: 'North Point',
      }],
    }, { 'if-match': '"mpd_2"' })
    expect(selected.statusCode).toBe(200)
    expect(storedAuthoring().targets).toEqual([
      expect.objectContaining({ label: 'North Point', aliases: ['North Park'] }),
    ])
  })

  test('warns once per proposal so the operator can act on each one', async () => {
    const warnings = (await importSitemap()).json().warnings as Array<{ code: string; path: unknown[] }>
    expect(warnings.map(warning => warning.code)).toEqual([
      'measurement.discovery.proposed_new_target',
      'measurement.discovery.proposed_new_target',
    ])
    expect(warnings.map(warning => warning.path)).toEqual([
      ['targets', 'target-harbour-quay'],
      ['targets', 'target-north-park'],
    ])
  })

  test('records the deterministic discovery inputs once and reruns to a no-op', async () => {
    const first = await importSitemap()
    expect(first.json().changed).toBe(true)

    const rerun = await importSitemap(undefined, { 'if-match': '"mpd_2"' })
    expect(rerun.statusCode).toBe(200)
    expect(rerun.json()).toMatchObject({ changed: false, etag: '"mpd_2"' })
    expect(storedAuthoring().targets).toHaveLength(2)

    const configs = db.select().from(measurementDiscoveryConfigs).all()
    expect(configs).toHaveLength(1)
    expect(configs[0]).toMatchObject({ sitemapUrl: `https://${HOST}/sitemap.xml`, exclusions: [] })
    expect(configs[0]!.inputChecksum).toMatch(/^[a-f0-9]{64}$/)
  })

  test('treats the same URL serving changed bytes as a new input', async () => {
    await importSitemap()
    fetchSitemap.mockResolvedValue(sitemap('/locations/{slug}', ['north-park', 'harbour-quay'], 'b'.repeat(64)))

    const rerun = await importSitemap(undefined, { 'if-match': '"mpd_2"' })
    expect(rerun.json()).toMatchObject({ changed: true, etag: '"mpd_3"' })
    expect(db.select().from(measurementDiscoveryConfigs).all()).toHaveLength(2)
  })

  test('proposes a rebind onto the Target whose URL the restructure moved', async () => {
    await importSitemap()
    const created = await post('apply-sitemap-selection', {
      selections: storedAuthoring().targets.map(target => ({ discoveryIdentity: target.discoveryIdentity, action: 'create' })),
    }, { 'if-match': '"mpd_2"' })
    expect(created.statusCode).toBe(200)

    fetchSitemap.mockResolvedValue(sitemap('/areas/{slug}', ['north-park', 'harbour-quay'], 'c'.repeat(64)))
    const moved = await importSitemap(
      { sitemapUrl: `https://${HOST}/sitemap.xml`, rule: MOVED_RULE },
      { 'if-match': '"mpd_3"' },
    )

    const warnings = moved.json().warnings as Array<{ code: string; path: unknown[] }>
    expect(warnings.map(warning => warning.code)).toEqual([
      'measurement.discovery.proposed_rebind',
      'measurement.discovery.proposed_rebind',
    ])
    expect(warnings.map(warning => warning.path)).toEqual([
      ['targets', 'target-harbour-quay-2', 'rebind', 'target-harbour-quay'],
      ['targets', 'target-north-park-2', 'rebind', 'target-north-park'],
    ])
  })

  test('refuses to dereference an internal URL', async () => {
    const actual = await vi.importActual<typeof import('../src/measurement-sitemap-fetch.js')>('../src/measurement-sitemap-fetch.js')
    fetchSitemap.mockImplementation(actual.fetchMeasurementSitemap)

    const response = await importSitemap({ sitemapUrl: 'http://169.254.169.254/latest/meta-data', rule: RULE })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.message).toContain('Sitemap URL rejected')
    expect(storedAuthoring().targets).toEqual([])
  })
})

describe('selection', () => {
  const northPark = () => measurementDiscoveryIdentity({ host: HOST, pathTemplate: '/locations/{slug}', slug: 'north-park' })

  async function seedIncludedNorthPark() {
    fetchSitemap.mockResolvedValue(sitemap('/locations/{slug}', ['north-park']))
    await importSitemap()
    const response = await post('apply-sitemap-selection', {
      selections: [{ discoveryIdentity: northPark(), action: 'create', label: 'North Park' }],
    }, { 'if-match': '"mpd_2"' })
    expect(response.statusCode).toBe(200)
  }

  test('promotes a proposal the operator accepted and excludes one they ignored', async () => {
    await importSitemap()
    const identities = storedAuthoring().targets.map(target => target.discoveryIdentity!)
    const response = await post('apply-sitemap-selection', {
      selections: [
        { discoveryIdentity: identities[0]!, action: 'ignore' },
        { discoveryIdentity: identities[1]!, action: 'create', label: 'North Park' },
      ],
    }, { 'if-match': '"mpd_2"' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ etag: '"mpd_3"', changed: true, counts: { includedTargets: 1 } })
    expect(storedAuthoring().targets.map(target => [target.stableKey, target.status, target.label])).toEqual([
      ['target-harbour-quay', 'excluded', 'Harbour Quay'],
      ['target-north-park', 'included', 'North Park'],
    ])
  })

  test('applies the complete reviewed Property selection and cleanup in one draft commit', async () => {
    await importSitemap()
    const imported = storedAuthoring()
    const [harbour, north] = imported.targets
    seedDraft({
      ...imported,
      assignments: [
        { targetKey: harbour!.stableKey, queryId: 'qry_1', queryClass: 'non-brand', classificationSource: 'operator' },
        { targetKey: north!.stableKey, queryId: 'qry_1', queryClass: 'non-brand', classificationSource: 'operator' },
      ],
      groups: [{
        stableKey: 'group-metro',
        label: 'Metro',
        targetKeys: [harbour!.stableKey, north!.stableKey],
        competitors: [],
      }],
    }, 2)

    const response = await post('apply-sitemap-selection', {
      selections: imported.targets.map(target => ({ discoveryIdentity: target.discoveryIdentity, action: 'create' })),
      selectedTargetKeys: [north!.stableKey],
    }, { 'if-match': '"mpd_2"' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ etag: '"mpd_3"', counts: { includedTargets: 1, assignments: 1 } })
    expect(storedAuthoring().targets.map(target => [target.stableKey, target.status])).toEqual([
      [harbour!.stableKey, 'excluded'],
      [north!.stableKey, 'included'],
    ])
    expect(storedAuthoring().assignments.map(assignment => assignment.targetKey)).toEqual([north!.stableKey])
    expect(storedAuthoring().groups[0]!.targetKeys).toEqual([north!.stableKey])

    const reinclude = await post('apply-sitemap-selection', {
      selections: [],
      selectedTargetKeys: [harbour!.stableKey, north!.stableKey],
    }, { 'if-match': '"mpd_3"' })
    expect(reinclude.statusCode).toBe(200)
    expect(storedAuthoring().targets.every(target => target.status === 'included')).toBe(true)
  })

  test('rebinds without disturbing the stable key, its assignments or its group membership', async () => {
    await seedIncludedNorthPark()
    const withWork = storedAuthoring()
    seedDraft({
      ...withWork,
      assignments: [{ targetKey: 'target-north-park', queryId: 'qry_1', queryClass: 'non-brand', classificationSource: 'operator' }],
      groups: [{ stableKey: 'group-metro', label: 'Metro', targetKeys: ['target-north-park'], competitors: [] }],
    }, 3)

    fetchSitemap.mockResolvedValue(sitemap('/areas/{slug}', ['north-park'], 'c'.repeat(64)))
    await importSitemap({ sitemapUrl: `https://${HOST}/sitemap.xml`, rule: MOVED_RULE }, { 'if-match': '"mpd_3"' })

    const moved = measurementDiscoveryIdentity({ host: HOST, pathTemplate: '/areas/{slug}', slug: 'north-park' })
    const response = await post('apply-sitemap-selection', {
      selections: [{ discoveryIdentity: moved, action: 'rebind', targetKey: 'target-north-park' }],
    }, { 'if-match': '"mpd_4"' })
    expect(response.statusCode).toBe(200)

    const authoring = storedAuthoring()
    expect(authoring.targets).toHaveLength(1)
    expect(authoring.targets[0]).toMatchObject({
      stableKey: 'target-north-park',
      label: 'North Park',
      status: 'included',
      discoveryIdentity: moved,
      discoveredUrl: `https://${HOST}/areas/north-park`,
    })
    // The URL the evidence was collected against is still matched.
    expect(authoring.targets[0]!.urlMatchers).toEqual([
      `https://${HOST}/areas/north-park`,
      `https://${HOST}/locations/north-park`,
    ])
    expect(authoring.assignments).toEqual([
      { targetKey: 'target-north-park', queryId: 'qry_1', queryClass: 'non-brand', classificationSource: 'operator' },
    ])
    expect(authoring.groups[0]!.targetKeys).toEqual(['target-north-park'])
  })

  test('records where a rebind came from and where it went', async () => {
    await seedIncludedNorthPark()
    fetchSitemap.mockResolvedValue(sitemap('/areas/{slug}', ['north-park'], 'c'.repeat(64)))
    await importSitemap({ sitemapUrl: `https://${HOST}/sitemap.xml`, rule: MOVED_RULE }, { 'if-match': '"mpd_3"' })
    const moved = measurementDiscoveryIdentity({ host: HOST, pathTemplate: '/areas/{slug}', slug: 'north-park' })
    await post('apply-sitemap-selection', {
      selections: [{ discoveryIdentity: moved, action: 'rebind', targetKey: 'target-north-park' }],
    }, { 'if-match': '"mpd_4"' })

    const entry = db.select().from(auditLog).all()
      .filter(row => row.action === 'measurement.discovery.selection_applied').at(-1)
    expect(entry).toBeDefined()
    expect(JSON.parse(entry!.diff!)).toMatchObject({
      applied: [{
        action: 'rebind',
        stableKey: 'target-north-park',
        previousDiscoveryIdentity: northPark(),
        previousDiscoveredUrl: `https://${HOST}/locations/north-park`,
        discoveredUrl: `https://${HOST}/areas/north-park`,
      }],
      previousEtag: '"mpd_4"',
      etag: '"mpd_5"',
    })
  })

  test('refuses a rebind that names no Target and one that names an unknown proposal', async () => {
    await importSitemap()
    const missingTarget = await post('apply-sitemap-selection', {
      selections: [{ discoveryIdentity: northPark(), action: 'rebind' }],
    }, { 'if-match': '"mpd_2"' })
    expect(missingTarget.statusCode).toBe(400)

    const unknown = await post('apply-sitemap-selection', {
      selections: [{ discoveryIdentity: 'sitemap:1:nope:%2Fx%2F%7Bslug%7D:nope', action: 'create' }],
    }, { 'if-match': '"mpd_2"' })
    expect(unknown.statusCode).toBe(404)
  })

  test('refuses a selection that names the same identity twice', async () => {
    await importSitemap()
    const response = await post('apply-sitemap-selection', {
      selections: [
        { discoveryIdentity: northPark(), action: 'create' },
        { discoveryIdentity: northPark(), action: 'ignore' },
      ],
    }, { 'if-match': '"mpd_2"' })
    expect(response.statusCode).toBe(400)
  })
})
