import { test, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { createClient, migrate, projects, schedules, runs, siteCrawlRunRequests } from '@ainyc/canonry-db'
import { SITE_AUDIT_MAX_PAGE_LIMIT, siteAuditRequestIdentity, type SiteAuditScheduleOptions } from '@ainyc/canonry-contracts'
import { Scheduler, type SchedulerCallbacks } from '../src/scheduler.js'

/**
 * Count registered cron tasks, ignoring the health schedule the scheduler seeds
 * for every project on start. These tests are about orphan cleanup and per-kind
 * keying; an absolute size assertion would couple them to how many schedules
 * ship by default.
 */
function taskCount(scheduler: unknown, opts: { includeHealth?: boolean } = {}): number {
  const tasks = (scheduler as { tasks: Map<string, unknown> }).tasks
  if (opts.includeHealth) return tasks.size
  return [...tasks.keys()].filter(key => !key.endsWith('::doctor')).length
}


function createTempDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-scheduler-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)
  return { db, tmpDir }
}

test('scheduler removes orphaned tasks after project deletion', () => {
  const { db, tmpDir } = createTempDb()
  const now = new Date().toISOString()

  db.insert(projects).values({
    id: 'proj_1',
    name: 'scheduled-project',
    displayName: 'Scheduled Project',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()

  db.insert(schedules).values({
    id: 'sched_1',
    projectId: 'proj_1',
    cronExpr: '* * * * *',
    timezone: 'UTC',
    enabled: true,
    providers: [],
    createdAt: now,
    updatedAt: now,
  }).run()

  const createdRunIds: string[] = []
  const scheduler = new Scheduler(db, {
    onRunCreated: (runId) => createdRunIds.push(runId),
  })

  scheduler.start()
  expect(taskCount(scheduler)).toBe(1)

  db.delete(projects).where(eq(projects.id, 'proj_1')).run()
  ;(scheduler as unknown as { triggerRun: (scheduleId: string, projectId: string, kind: 'answer-visibility' | 'traffic-sync') => void })
    .triggerRun('sched_1', 'proj_1', 'answer-visibility')

  expect(createdRunIds.length).toBe(0)
  expect(taskCount(scheduler)).toBe(0)

  scheduler.stop()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('scheduler keys tasks by (projectId, kind) — both kinds can register independently', () => {
  const { db, tmpDir } = createTempDb()
  const now = new Date().toISOString()

  db.insert(projects).values({
    id: 'proj_2',
    name: 'multi-kind',
    displayName: 'Multi Kind',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()

  db.insert(schedules).values([
    {
      id: 'sched_av',
      projectId: 'proj_2',
      kind: 'answer-visibility',
      cronExpr: '* * * * *',
      timezone: 'UTC',
      enabled: true,
      providers: [],
      sourceId: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'sched_ts',
      projectId: 'proj_2',
      kind: 'traffic-sync',
      cronExpr: '*/30 * * * *',
      timezone: 'UTC',
      enabled: true,
      providers: [],
      sourceId: 'src-uuid',
      createdAt: now,
      updatedAt: now,
    },
  ]).run()

  const scheduler = new Scheduler(db, { onRunCreated: () => {} })
  scheduler.start()
  // Both schedules registered.
  expect(taskCount(scheduler)).toBe(2)

  // Remove only the traffic-sync one — the answer-visibility task survives.
  scheduler.remove('proj_2', 'traffic-sync')
  expect(taskCount(scheduler)).toBe(1)

  // removeAllForProject clears both.
  scheduler.removeAllForProject('proj_2')
  expect(taskCount(scheduler)).toBe(0)

  scheduler.stop()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('traffic-sync trigger fires onTrafficSyncRequested with the configured source ID', () => {
  const { db, tmpDir } = createTempDb()
  const now = new Date().toISOString()

  db.insert(projects).values({
    id: 'proj_3',
    name: 'tsync-project',
    displayName: 'Traffic Sync Project',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()
  db.insert(schedules).values({
    id: 'sched_ts2',
    projectId: 'proj_3',
    kind: 'traffic-sync',
    cronExpr: '*/15 * * * *',
    timezone: 'UTC',
    enabled: true,
    providers: [],
    sourceId: 'src-uuid-x',
    createdAt: now,
    updatedAt: now,
  }).run()

  const trafficCalls: Array<{ projectName: string; sourceId: string }> = []
  const runCalls: string[] = []
  const scheduler = new Scheduler(db, {
    onRunCreated: (runId) => runCalls.push(runId),
    onTrafficSyncRequested: (projectName, sourceId) => trafficCalls.push({ projectName, sourceId }),
  })

  ;(scheduler as unknown as {
    triggerRun: (scheduleId: string, projectId: string, kind: 'answer-visibility' | 'traffic-sync') => void
  }).triggerRun('sched_ts2', 'proj_3', 'traffic-sync')

  expect(trafficCalls).toHaveLength(1)
  expect(trafficCalls[0]).toEqual({ projectName: 'tsync-project', sourceId: 'src-uuid-x' })
  // answer-visibility callback must NOT fire for traffic-sync
  expect(runCalls).toHaveLength(0)

  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('gbp-sync trigger creates a run row and fires onGbpSyncRequested', () => {
  const { db, tmpDir } = createTempDb()
  const now = new Date().toISOString()

  db.insert(projects).values({
    id: 'proj_gbp',
    name: 'gbp-project',
    displayName: 'GBP Project',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()
  db.insert(schedules).values({
    id: 'sched_gbp',
    projectId: 'proj_gbp',
    kind: 'gbp-sync',
    cronExpr: '0 6 * * *',
    timezone: 'UTC',
    enabled: true,
    providers: [],
    sourceId: null,
    createdAt: now,
    updatedAt: now,
  }).run()

  const gbpCalls: Array<{ runId: string; projectId: string }> = []
  const runCalls: string[] = []
  const trafficCalls: unknown[] = []
  const scheduler = new Scheduler(db, {
    onRunCreated: (runId) => runCalls.push(runId),
    onTrafficSyncRequested: () => trafficCalls.push(null),
    onGbpSyncRequested: (runId, projectId) => gbpCalls.push({ runId, projectId }),
  })

  ;(scheduler as unknown as {
    triggerRun: (scheduleId: string, projectId: string, kind: 'answer-visibility' | 'traffic-sync' | 'gbp-sync') => void
  }).triggerRun('sched_gbp', 'proj_gbp', 'gbp-sync')

  // The callback fired once with the created run row id.
  expect(gbpCalls).toHaveLength(1)
  expect(gbpCalls[0]!.projectId).toBe('proj_gbp')

  // A gbp-sync run row was created with trigger=scheduled.
  const runRow = db.select().from(runs).where(eq(runs.id, gbpCalls[0]!.runId)).get()
  expect(runRow).toBeDefined()
  expect(runRow!.kind).toBe('gbp-sync')
  expect(runRow!.trigger).toBe('scheduled')
  expect(runRow!.status).toBe('queued')
  expect(runRow!.projectId).toBe('proj_gbp')

  // lastRunAt advanced on the schedule row.
  const sched = db.select().from(schedules).where(eq(schedules.id, 'sched_gbp')).get()
  expect(sched!.lastRunAt).not.toBeNull()

  // The other kinds' callbacks must NOT fire for a gbp-sync trigger.
  expect(runCalls).toHaveLength(0)
  expect(trafficCalls).toHaveLength(0)

  scheduler.stop()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('gbp-sync trigger skips silently when no callback is registered', () => {
  const { db, tmpDir } = createTempDb()
  const now = new Date().toISOString()

  db.insert(projects).values({
    id: 'proj_gbp2',
    name: 'gbp-project-2',
    displayName: 'GBP Project 2',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()
  db.insert(schedules).values({
    id: 'sched_gbp2',
    projectId: 'proj_gbp2',
    kind: 'gbp-sync',
    cronExpr: '0 6 * * *',
    timezone: 'UTC',
    enabled: true,
    providers: [],
    sourceId: null,
    createdAt: now,
    updatedAt: now,
  }).run()

  // No onGbpSyncRequested callback registered.
  const scheduler = new Scheduler(db, { onRunCreated: () => {} })

  ;(scheduler as unknown as {
    triggerRun: (scheduleId: string, projectId: string, kind: 'answer-visibility' | 'traffic-sync' | 'gbp-sync') => void
  }).triggerRun('sched_gbp2', 'proj_gbp2', 'gbp-sync')

  // No orphan run row should be created when the host can't run the sync.
  const runRows = db.select().from(runs).where(eq(runs.projectId, 'proj_gbp2')).all()
  expect(runRows).toHaveLength(0)

  scheduler.stop()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('traffic-sync trigger skips silently when sourceId is missing', () => {
  const { db, tmpDir } = createTempDb()
  const now = new Date().toISOString()

  db.insert(projects).values({
    id: 'proj_4',
    name: 'no-source',
    displayName: 'No Source',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()
  db.insert(schedules).values({
    id: 'sched_nosrc',
    projectId: 'proj_4',
    kind: 'traffic-sync',
    cronExpr: '*/15 * * * *',
    timezone: 'UTC',
    enabled: true,
    providers: [],
    sourceId: null,
    createdAt: now,
    updatedAt: now,
  }).run()

  const trafficCalls: unknown[] = []
  const scheduler = new Scheduler(db, {
    onRunCreated: () => {},
    onTrafficSyncRequested: () => trafficCalls.push(null),
  })

  ;(scheduler as unknown as {
    triggerRun: (scheduleId: string, projectId: string, kind: 'answer-visibility' | 'traffic-sync') => void
  }).triggerRun('sched_nosrc', 'proj_4', 'traffic-sync')

  expect(trafficCalls).toHaveLength(0)
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('data-refresh trigger fires onDataRefreshRequested with the project name only', () => {
  const { db, tmpDir } = createTempDb()
  const now = new Date().toISOString()

  db.insert(projects).values({
    id: 'proj_dr',
    name: 'refresh-project',
    displayName: 'Refresh Project',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()
  db.insert(schedules).values({
    id: 'sched_dr',
    projectId: 'proj_dr',
    kind: 'data-refresh',
    cronExpr: '30 12 * * *',
    timezone: 'UTC',
    enabled: true,
    providers: [],
    createdAt: now,
    updatedAt: now,
  }).run()

  const refreshCalls: string[] = []
  const runCalls: string[] = []
  const trafficCalls: unknown[] = []
  const scheduler = new Scheduler(db, {
    onRunCreated: (runId) => runCalls.push(runId),
    onTrafficSyncRequested: () => trafficCalls.push(null),
    onDataRefreshRequested: (projectName) => refreshCalls.push(projectName),
  })

  ;(scheduler as unknown as {
    triggerRun: (scheduleId: string, projectId: string, kind: 'answer-visibility' | 'traffic-sync' | 'data-refresh') => void
  }).triggerRun('sched_dr', 'proj_dr', 'data-refresh')

  expect(refreshCalls).toEqual(['refresh-project'])
  // Neither the answer-visibility nor the traffic-sync callback fires for data-refresh.
  expect(runCalls).toHaveLength(0)
  expect(trafficCalls).toHaveLength(0)

  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('data-refresh trigger skips silently when no onDataRefreshRequested callback is registered', () => {
  const { db, tmpDir } = createTempDb()
  const now = new Date().toISOString()

  db.insert(projects).values({
    id: 'proj_dr2',
    name: 'refresh-no-cb',
    displayName: 'Refresh No Callback',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()
  db.insert(schedules).values({
    id: 'sched_dr2',
    projectId: 'proj_dr2',
    kind: 'data-refresh',
    cronExpr: '30 12 * * *',
    timezone: 'UTC',
    enabled: true,
    providers: [],
    createdAt: now,
    updatedAt: now,
  }).run()

  const scheduler = new Scheduler(db, { onRunCreated: () => {} })

  expect(() =>
    (scheduler as unknown as {
      triggerRun: (scheduleId: string, projectId: string, kind: 'answer-visibility' | 'traffic-sync' | 'data-refresh') => void
    }).triggerRun('sched_dr2', 'proj_dr2', 'data-refresh'),
  ).not.toThrow()

  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('backlinks-sync trigger fires onBacklinksSyncRequested with the project name and creates no run row', () => {
  const { db, tmpDir } = createTempDb()
  const now = new Date().toISOString()

  db.insert(projects).values({
    id: 'proj_bl',
    name: 'backlinks-project',
    displayName: 'Backlinks Project',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()
  db.insert(schedules).values({
    id: 'sched_bl',
    projectId: 'proj_bl',
    kind: 'backlinks-sync',
    cronExpr: '0 4 * * 1',
    timezone: 'UTC',
    enabled: true,
    providers: [],
    createdAt: now,
    updatedAt: now,
  }).run()

  const backlinksCalls: string[] = []
  const runCalls: string[] = []
  const refreshCalls: unknown[] = []
  const scheduler = new Scheduler(db, {
    onRunCreated: (runId) => runCalls.push(runId),
    onDataRefreshRequested: () => refreshCalls.push(null),
    onBacklinksSyncRequested: (projectName) => backlinksCalls.push(projectName),
  })

  ;(scheduler as unknown as {
    triggerRun: (scheduleId: string, projectId: string, kind: 'answer-visibility' | 'backlinks-sync') => void
  }).triggerRun('sched_bl', 'proj_bl', 'backlinks-sync')

  expect(backlinksCalls).toEqual(['backlinks-project'])

  // Workspace-global sync — the scheduler creates NO per-project run row.
  const runRows = db.select().from(runs).where(eq(runs.projectId, 'proj_bl')).all()
  expect(runRows).toHaveLength(0)

  // lastRunAt advanced on the schedule row.
  const sched = db.select().from(schedules).where(eq(schedules.id, 'sched_bl')).get()
  expect(sched!.lastRunAt).not.toBeNull()

  // Other kinds' callbacks must NOT fire for a backlinks-sync trigger.
  expect(runCalls).toHaveLength(0)
  expect(refreshCalls).toHaveLength(0)

  scheduler.stop()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('backlinks-sync trigger skips silently when no onBacklinksSyncRequested callback is registered', () => {
  const { db, tmpDir } = createTempDb()
  const now = new Date().toISOString()

  db.insert(projects).values({
    id: 'proj_bl2',
    name: 'backlinks-no-cb',
    displayName: 'Backlinks No Callback',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()
  db.insert(schedules).values({
    id: 'sched_bl2',
    projectId: 'proj_bl2',
    kind: 'backlinks-sync',
    cronExpr: '0 4 * * 1',
    timezone: 'UTC',
    enabled: true,
    providers: [],
    createdAt: now,
    updatedAt: now,
  }).run()

  const scheduler = new Scheduler(db, { onRunCreated: () => {} })

  expect(() =>
    (scheduler as unknown as {
      triggerRun: (scheduleId: string, projectId: string, kind: 'answer-visibility' | 'backlinks-sync') => void
    }).triggerRun('sched_bl2', 'proj_bl2', 'backlinks-sync'),
  ).not.toThrow()

  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('ads-sync trigger creates a run row and fires onAdsSyncRequested', () => {
  const { db, tmpDir } = createTempDb()
  const now = new Date().toISOString()

  db.insert(projects).values({
    id: 'proj_ads',
    name: 'ads-project',
    displayName: 'Ads Project',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()
  db.insert(schedules).values({
    id: 'sched_ads',
    projectId: 'proj_ads',
    kind: 'ads-sync',
    cronExpr: '0 5 * * *',
    timezone: 'UTC',
    enabled: true,
    providers: [],
    sourceId: null,
    createdAt: now,
    updatedAt: now,
  }).run()

  const adsCalls: Array<{ runId: string; projectId: string }> = []
  const scheduler = new Scheduler(db, {
    onRunCreated: () => {},
    onAdsSyncRequested: (runId, projectId) => adsCalls.push({ runId, projectId }),
  })

  ;(scheduler as unknown as {
    triggerRun: (scheduleId: string, projectId: string, kind: 'ads-sync') => void
  }).triggerRun('sched_ads', 'proj_ads', 'ads-sync')

  expect(adsCalls).toHaveLength(1)
  const runRow = db.select().from(runs).where(eq(runs.id, adsCalls[0]!.runId)).get()
  expect(runRow!.kind).toBe('ads-sync')
  expect(runRow!.status).toBe('queued')

  scheduler.stop()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('ads-sync trigger skips (no new run, no callback) when one is already in flight', () => {
  const { db, tmpDir } = createTempDb()
  const now = new Date().toISOString()

  db.insert(projects).values({
    id: 'proj_ads2',
    name: 'ads-project-2',
    displayName: 'Ads Project 2',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()
  db.insert(schedules).values({
    id: 'sched_ads2',
    projectId: 'proj_ads2',
    kind: 'ads-sync',
    cronExpr: '0 5 * * *',
    timezone: 'UTC',
    enabled: true,
    providers: [],
    sourceId: null,
    createdAt: now,
    updatedAt: now,
  }).run()
  // A previous ads-sync run is still running.
  db.insert(runs).values({
    id: 'run_inflight',
    projectId: 'proj_ads2',
    kind: 'ads-sync',
    status: 'running',
    trigger: 'scheduled',
    createdAt: now,
  }).run()

  const adsCalls: Array<{ runId: string; projectId: string }> = []
  const scheduler = new Scheduler(db, {
    onRunCreated: () => {},
    onAdsSyncRequested: (runId, projectId) => adsCalls.push({ runId, projectId }),
  })

  ;(scheduler as unknown as {
    triggerRun: (scheduleId: string, projectId: string, kind: 'ads-sync') => void
  }).triggerRun('sched_ads2', 'proj_ads2', 'ads-sync')

  // No second pass stacked: callback never fired, still exactly one ads-sync run.
  expect(adsCalls).toHaveLength(0)
  const adsRuns = db.select().from(runs).where(eq(runs.projectId, 'proj_ads2')).all()
    .filter((r) => r.kind === 'ads-sync')
  expect(adsRuns).toHaveLength(1)

  scheduler.stop()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

type SiteAuditDispatch = { runId: string; projectId: string; opts: Parameters<NonNullable<SchedulerCallbacks['onSiteAuditRequested']>>[2] }

function seedSiteAuditSchedule(siteAuditOptions?: SiteAuditScheduleOptions | null) {
  const { db, tmpDir } = createTempDb()
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: 'proj_site_audit',
    name: 'site-audit-project',
    displayName: 'Site Audit Project',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()
  db.insert(schedules).values({
    id: 'sched_site_audit',
    projectId: 'proj_site_audit',
    kind: 'site-audit',
    cronExpr: '0 5 * * *',
    timezone: 'UTC',
    enabled: true,
    providers: [],
    sourceId: null,
    ...(siteAuditOptions === undefined ? {} : { siteAuditOptions }),
    createdAt: now,
    updatedAt: now,
  }).run()

  const calls: SiteAuditDispatch[] = []
  const scheduler = new Scheduler(db, {
    onRunCreated: () => {},
    onSiteAuditRequested: (runId, projectId, opts) => calls.push({ runId, projectId, opts }),
  })
  ;(scheduler as unknown as {
    triggerRun: (scheduleId: string, projectId: string, kind: 'site-audit') => void
  }).triggerRun('sched_site_audit', 'proj_site_audit', 'site-audit')

  const request = () => db.select().from(siteCrawlRunRequests).where(eq(siteCrawlRunRequests.runId, calls[0]!.runId)).get()
  const cleanup = () => {
    scheduler.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
  return { calls, request, cleanup }
}

test('site-audit schedule with no stored options scans the full site', () => {
  const { calls, request, cleanup } = seedSiteAuditSchedule()

  expect(calls).toHaveLength(1)
  const expected = {
    schemaVersion: 2,
    sitemapUrl: null,
    // The hard page limit, not the 1,000-page manual default: the crawl stops
    // when it runs out of pages, so a scheduled audit covers the whole site.
    maxPages: SITE_AUDIT_MAX_PAGE_LIMIT,
    // Unattended crawls set no edge budget; the engine derives it.
    maxEdges: null,
    maxDepth: null,
    checkDeadLinks: false,
  }
  expect(request()).toMatchObject({
    projectId: 'proj_site_audit',
    effectiveOptions: expected,
    identityKey: siteAuditRequestIdentity(expected),
  })
  // The executor receives what was persisted, so the stored effective options
  // describe the crawl that actually ran.
  expect(calls[0]!.opts).toEqual({
    sitemapUrl: undefined,
    maxPages: SITE_AUDIT_MAX_PAGE_LIMIT,
    maxEdges: undefined,
    maxDepth: undefined,
    checkDeadLinks: false,
  })

  cleanup()
})

test('site-audit schedule runs exactly its stored options', () => {
  const stored = { sitemapUrl: 'https://example.com/sitemap.xml', maxPages: 25_000, maxEdges: 600_000, maxDepth: 6, checkDeadLinks: true }
  const { calls, request, cleanup } = seedSiteAuditSchedule(stored)

  expect(calls).toHaveLength(1)
  const expected = { schemaVersion: 2, ...stored }
  expect(request()).toMatchObject({ effectiveOptions: expected, identityKey: siteAuditRequestIdentity(expected) })
  expect(calls[0]!.opts).toEqual(stored)

  cleanup()
})

test('site-audit schedule with stored options that no longer parse runs the full-site default', () => {
  // Only a hand-edited row can hold this; the route validates every write.
  const { calls, request, cleanup } = seedSiteAuditSchedule({ maxPages: 'lots', maxDepth: 3 } as unknown as SiteAuditScheduleOptions)

  expect(calls).toHaveLength(1)
  expect(request()!.effectiveOptions).toEqual({
    schemaVersion: 2, sitemapUrl: null, maxPages: SITE_AUDIT_MAX_PAGE_LIMIT, maxEdges: null, maxDepth: null, checkDeadLinks: false,
  })

  cleanup()
})

test('site-audit schedule options it does not store keep the full-site default', () => {
  const { calls, request, cleanup } = seedSiteAuditSchedule({ maxDepth: 3 })

  expect(request()!.effectiveOptions).toEqual({
    schemaVersion: 2, sitemapUrl: null, maxPages: SITE_AUDIT_MAX_PAGE_LIMIT, maxEdges: null, maxDepth: 3, checkDeadLinks: false,
  })
  expect(calls[0]!.opts).toMatchObject({ maxPages: SITE_AUDIT_MAX_PAGE_LIMIT, maxDepth: 3, checkDeadLinks: false })

  cleanup()
})
