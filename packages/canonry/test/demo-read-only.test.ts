import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { apiRoutes } from '@ainyc/canonry-api-routes'
import { bingUrlInspections, createClient, migrate, projects, type DatabaseClient } from '@ainyc/canonry-db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDemoHttpServer } from '../src/demo/http.js'

const cliMocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  autoSyncSkills: vi.fn(),
  formatAutoSyncNotice: vi.fn(),
  checkLatestVersion: vi.fn(),
  trackEvent: vi.fn(),
  trackFinished: vi.fn(),
  buildSetupState: vi.fn(),
  isTelemetryEnabled: vi.fn(),
  isFirstRun: vi.fn(),
  getOrCreateAnonymousId: vi.fn(),
  showFirstRunNotice: vi.fn(),
  detectAndTrackUpgrade: vi.fn(),
}))

vi.mock('../src/cli-dispatch.js', () => ({ dispatchRegisteredCommand: cliMocks.dispatch }))
vi.mock('../src/skills-autosync.js', () => ({
  autoSyncSkills: cliMocks.autoSyncSkills,
  formatAutoSyncNotice: cliMocks.formatAutoSyncNotice,
}))
vi.mock('../src/update-check.js', () => ({ checkLatestVersionForCli: cliMocks.checkLatestVersion }))
vi.mock('../src/setup-state.js', () => ({ buildSetupState: cliMocks.buildSetupState }))
vi.mock('../src/telemetry.js', () => ({
  trackEvent: cliMocks.trackEvent,
  trackCliCommandFinished: cliMocks.trackFinished,
  isTelemetryEnabled: cliMocks.isTelemetryEnabled,
  isFirstRun: cliMocks.isFirstRun,
  getOrCreateAnonymousId: cliMocks.getOrCreateAnonymousId,
  showFirstRunNotice: cliMocks.showFirstRunNotice,
  detectAndTrackUpgrade: cliMocks.detectAndTrackUpgrade,
}))

const { runCli } = await import('../src/cli.js')

const NOW = '2026-09-09T12:00:00.000Z'
const PROJECT = {
  id: 'demo-simple', name: 'summit-roofing', displayName: 'Summit Roofing',
  canonicalDomain: 'summit-roofing.example', country: 'US', language: 'en',
  createdAt: NOW, updatedAt: NOW,
}

function changes(db: DatabaseClient): number {
  return Number((db.$client.prepare('SELECT total_changes() AS count').get() as { count: number }).count)
}

function insertStoredCoverage(db: DatabaseClient): void {
  db.insert(projects).values(PROJECT).run()
  db.insert(bingUrlInspections).values({
    id: 'demo-bing-inspection', projectId: PROJECT.id, url: 'https://summit-roofing.example/roof-repair',
    httpCode: 200, inIndex: true, lastCrawledDate: '2026-09-08', inIndexDate: '2026-09-08',
    inspectedAt: NOW, syncRunId: null, createdAt: NOW, documentSize: 24_000, anchorCount: 14,
    discoveryDate: '2026-09-01',
  }).run()
}

const bingConnectionStore = {
  getConnection: (domain: string) => ({ domain, siteUrl: 'https://summit-roofing.example/', apiKey: '', createdAt: NOW, updatedAt: NOW }),
  upsertConnection: <T>(connection: T) => connection,
  updateConnection: () => undefined,
  deleteConnection: () => false,
}

function assetsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'canonry-demo-read-only-'))
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head></head><body><div id="root"></div></body></html>')
  return dir
}

describe('public demo read isolation', () => {
  it('serves Bing coverage without the production GET snapshot upsert', async () => {
    const ordinaryDb = createClient(':memory:')
    migrate(ordinaryDb)
    insertStoredCoverage(ordinaryDb)
    const ordinary = Fastify()
    await ordinary.register(apiRoutes, { db: ordinaryDb, skipAuth: true, bingConnectionStore })
    const ordinaryBefore = changes(ordinaryDb)
    try {
      expect((await ordinary.inject('/api/v1/projects/summit-roofing/bing/coverage')).statusCode).toBe(200)
      expect(changes(ordinaryDb)).toBeGreaterThan(ordinaryBefore)
    } finally {
      await ordinary.close()
      ordinaryDb.$client.close()
    }

    const db = createClient(':memory:')
    migrate(db)
    insertStoredCoverage(db)
    const dir = assetsDir()
    const app = await createDemoHttpServer({ db, assetsDir: dir, now: new Date(NOW), readOptions: { bingConnectionStore } })
    const demoBefore = changes(db) // Includes the demo principal created at startup.
    try {
      const response = await app.inject('/api/v1/projects/summit-roofing/bing/coverage')
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({ summary: { total: 1, indexed: 1 } })
      expect(changes(db)).toBe(demoBefore)
    } finally {
      await app.close()
      db.$client.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('demo CLI isolation', () => {
  beforeEach(() => {
    for (const mock of Object.values(cliMocks)) mock.mockReset()
    cliMocks.dispatch.mockResolvedValue(true)
    cliMocks.isTelemetryEnabled.mockReturnValue(true)
    cliMocks.isFirstRun.mockReturnValue(true)
  })

  afterEach(() => vi.restoreAllMocks())

  it('dispatches before config-derived telemetry, skill refresh, and update work', async () => {
    await expect(runCli(['demo', '--format', 'json'])).resolves.toBe(0)

    expect(cliMocks.dispatch).toHaveBeenCalledOnce()
    expect(cliMocks.autoSyncSkills).not.toHaveBeenCalled()
    expect(cliMocks.checkLatestVersion).not.toHaveBeenCalled()
    expect(cliMocks.isTelemetryEnabled).not.toHaveBeenCalled()
    expect(cliMocks.isFirstRun).not.toHaveBeenCalled()
    expect(cliMocks.buildSetupState).not.toHaveBeenCalled()
    expect(cliMocks.trackEvent).not.toHaveBeenCalled()
    expect(cliMocks.trackFinished).not.toHaveBeenCalled()
  })
})
