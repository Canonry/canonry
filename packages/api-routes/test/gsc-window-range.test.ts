import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createClient, migrate, projects, runs, gscSearchData, gscDailyTotals, gscDataWatermarks } from '@canonry/canonry-db'

import {
  readEarliestGscDataDate, readLatestGscDataDate, resolveGscWindowDays, resolveGscWindowRange,
} from '../src/gsc-totals.js'
import { assertForwardRange, resolveReportedWindow } from '../src/google.js'

/**
 * Reproduces the real canonry.ai disagreement that motivated the change.
 *
 * On 2026-08-12 the property had published through 2026-08-09 (a 3-day lag).
 * Canonry's now-anchored `30d` covered 07-13..08-09 and reported 1,174
 * impressions; Search Console's `28 days` covered 07-14..08-10 and reported
 * 1,360. Neither range contains the other, so the WIDER window reported FEWER
 * impressions — which is indistinguishable from a real decline.
 */
const TODAY = '2026-08-12'
const LATEST = '2026-08-09'

describe('resolveGscWindowRange', () => {
  it('anchors the range on the last published day, not on today', () => {
    expect(resolveGscWindowRange('30d', LATEST, TODAY)).toEqual({
      startDate: '2026-07-11',
      endDate: '2026-08-09',
      latestDataDate: '2026-08-09',
      daysSinceLatestData: 3,
    })
  })

  it('covers exactly as many calendar days as its label promises', () => {
    // The inclusive range is the bug's whole surface: a now-anchored 30d
    // delivered 28 days of data under a label that said 30.
    for (const [window, days] of [['7d', 7], ['30d', 30], ['90d', 90]] as const) {
      const range = resolveGscWindowRange(window, LATEST, TODAY)
      const spanDays =
        (Date.parse(`${range.endDate!}T00:00:00Z`) - Date.parse(`${range.startDate!}T00:00:00Z`))
        / 86_400_000 + 1
      expect(spanDays).toBe(days)
    }
  })

  it('is monotonic: a wider label always contains a narrower one', () => {
    // This is the property the now-anchored window broke. It has to hold for
    // ANY lag, including a lag longer than the shortest window.
    for (const lagDays of [0, 1, 2, 3, 7, 30]) {
      const latest = new Date(Date.parse(`${TODAY}T00:00:00Z`) - lagDays * 86_400_000)
        .toISOString().slice(0, 10)
      const week = resolveGscWindowRange('7d', latest, TODAY)
      const month = resolveGscWindowRange('30d', latest, TODAY)
      const quarter = resolveGscWindowRange('90d', latest, TODAY)
      expect(month.startDate! <= week.startDate!).toBe(true)
      expect(quarter.startDate! <= month.startDate!).toBe(true)
      // All three end on the same published day, so each is a strict superset.
      expect(week.endDate).toBe(latest)
      expect(month.endDate).toBe(latest)
      expect(quarter.endDate).toBe(latest)
    }
  })

  it('reports the lag it measured', () => {
    expect(resolveGscWindowRange('7d', '2026-08-12', TODAY).daysSinceLatestData).toBe(0)
    expect(resolveGscWindowRange('7d', '2026-08-10', TODAY).daysSinceLatestData).toBe(2)
    // A property that somehow published ahead of today is clamped, not negative.
    expect(resolveGscWindowRange('7d', '2026-08-20', TODAY).daysSinceLatestData).toBe(0)
  })

  it('steps calendar dates, so a month boundary does not lose a day', () => {
    // 7 inclusive days ending 2026-03-02 is 2026-02-24 — only correct if the
    // step is calendar arithmetic rather than a fixed 24h subtraction.
    expect(resolveGscWindowRange('7d', '2026-03-02', '2026-03-04').startDate).toBe('2026-02-24')
    // Across a leap day.
    expect(resolveGscWindowRange('7d', '2028-03-02', '2028-03-04').startDate).toBe('2028-02-25')
  })

  it('leaves `all` unbounded below but still stops at the published day', () => {
    expect(resolveGscWindowRange('all', LATEST, TODAY)).toEqual({
      startDate: null,
      endDate: '2026-08-09',
      latestDataDate: '2026-08-09',
      daysSinceLatestData: 3,
    })
  })

  it('falls back to a now-anchored cutoff when the project has no data at all', () => {
    // With no anchor there is nothing to anchor ON. Returning an unbounded
    // range instead would turn an empty project into a full-history scan.
    expect(resolveGscWindowRange('30d', null, TODAY)).toEqual({
      startDate: '2026-07-13',
      endDate: null,
      latestDataDate: null,
      daysSinceLatestData: null,
    })
  })
})

describe('readLatestGscDataDate', () => {
  let db: ReturnType<typeof createClient>
  let tmpDir: string
  let projectId: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsc-window-test-'))
    db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)
    projectId = crypto.randomUUID()
    const now = '2026-08-12T00:00:00.000Z'
    db.insert(projects).values({
      id: projectId, name: 'perf', displayName: 'Perf', canonicalDomain: 'perf.example.com',
      country: 'US', language: 'en', createdAt: now, updatedAt: now,
    }).run()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function seedDimensioned(date: string) {
    const syncRunId = crypto.randomUUID()
    db.insert(runs).values({
      id: syncRunId, projectId, kind: 'gsc-sync', status: 'completed', trigger: 'manual',
      createdAt: '2026-08-12T00:00:00.000Z',
    }).run()
    db.insert(gscSearchData).values({
      id: crypto.randomUUID(), projectId, syncRunId, date, query: 'q', page: '/p',
      country: 'usa', device: 'DESKTOP', impressions: 10, clicks: 1, ctr: '0.1', position: '5',
      createdAt: '2026-08-12T00:00:00.000Z',
    }).run()
  }

  function seedProperty(date: string) {
    db.insert(gscDailyTotals).values({
      id: crypto.randomUUID(), projectId, date, clicks: 1, impressions: 10, position: '5',
      createdAt: '2026-08-12T00:00:00.000Z',
    }).run()
  }

  it('returns null for a project with no GSC data', () => {
    expect(readLatestGscDataDate(db, projectId)).toBeNull()
  })

  it('reads the property table when it is the only source', () => {
    seedProperty('2026-08-09')
    expect(readLatestGscDataDate(db, projectId)).toBe('2026-08-09')
  })

  it('reads the dimensioned table for a project that predates property totals', () => {
    seedDimensioned('2026-08-08')
    expect(readLatestGscDataDate(db, projectId)).toBe('2026-08-08')
  })

  it('takes the later of the two, so the anchor never sits behind returned data', () => {
    // The two tables sync independently. Anchoring on the property table alone
    // would cut off dimensioned dates the endpoint is about to serve.
    seedProperty('2026-08-05')
    seedDimensioned('2026-08-09')
    expect(readLatestGscDataDate(db, projectId)).toBe('2026-08-09')

    seedProperty('2026-08-11')
    expect(readLatestGscDataDate(db, projectId)).toBe('2026-08-11')
  })
})

/**
 * The floor under any period a surface reaches back to.
 *
 * Search Analytics omits days with no data, so an absent row is only a real
 * zero INSIDE the synced span. Before the earliest row it may equally be a day
 * nobody fetched, and counting those as zero is what lets a half-synced prior
 * period halve its own baseline and print growth that never happened.
 */
describe('readEarliestGscDataDate', () => {
  let db: ReturnType<typeof createClient>
  let tmpDir: string
  let projectId: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsc-earliest-test-'))
    db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)
    projectId = crypto.randomUUID()
    const now = '2026-08-12T00:00:00.000Z'
    db.insert(projects).values({
      id: projectId, name: 'perf', displayName: 'Perf', canonicalDomain: 'perf.example.com',
      country: 'US', language: 'en', createdAt: now, updatedAt: now,
    }).run()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function seedDimensioned(date: string) {
    const syncRunId = crypto.randomUUID()
    db.insert(runs).values({
      id: syncRunId, projectId, kind: 'gsc-sync', status: 'completed', trigger: 'manual',
      createdAt: '2026-08-12T00:00:00.000Z',
    }).run()
    db.insert(gscSearchData).values({
      id: crypto.randomUUID(), projectId, syncRunId, date, query: 'q', page: '/p',
      country: 'usa', device: 'DESKTOP', impressions: 10, clicks: 1, ctr: '0.1', position: '5',
      createdAt: '2026-08-12T00:00:00.000Z',
    }).run()
  }

  function seedProperty(date: string) {
    db.insert(gscDailyTotals).values({
      id: crypto.randomUUID(), projectId, date, clicks: 1, impressions: 10, position: '5',
      createdAt: '2026-08-12T00:00:00.000Z',
    }).run()
  }

  it('returns null for a project with no GSC data', () => {
    expect(readEarliestGscDataDate(db, projectId)).toBeNull()
  })

  it('reads the property table when it is the only source', () => {
    seedProperty('2026-07-01')
    seedProperty('2026-08-09')
    expect(readEarliestGscDataDate(db, projectId)).toBe('2026-07-01')
  })

  it('reads the dimensioned table for a project that predates property totals', () => {
    seedDimensioned('2026-06-02')
    expect(readEarliestGscDataDate(db, projectId)).toBe('2026-06-02')
  })

  /**
   * The mirror of the latest-date rule, and it must take the EARLIER of the
   * two. Reading only the property table would place the frontier after
   * dimensioned history the endpoint can already serve, and refuse comparisons
   * the data supports.
   */
  it('takes the earlier of the two independently synced tables', () => {
    seedProperty('2026-07-01')
    seedDimensioned('2026-05-14')
    expect(readEarliestGscDataDate(db, projectId)).toBe('2026-05-14')
  })

  /**
   * The watermark records only how far FORWARD a sync reached, so it says
   * nothing about where history begins and must not be consulted here. A
   * project whose backfill starts in July does not gain June by having a
   * watermark.
   */
  it('ignores the forward-only watermark', () => {
    seedProperty('2026-07-01')
    db.insert(gscDataWatermarks).values({
      projectId, dataThroughDate: '2026-08-11', syncedThroughDate: '2026-08-11',
      updatedAt: '2026-08-12T00:00:00.000Z',
    }).run()
    expect(readEarliestGscDataDate(db, projectId)).toBe('2026-07-01')
  })

  /**
   * A quiet LEADING stretch walks the frontier forward, which withholds a
   * comparison that could have been made rather than inventing one. Being
   * conservative in that direction is the whole point.
   */
  it('walks forward with a quiet lead rather than assuming unrecorded days', () => {
    seedProperty('2026-07-05')
    expect(readEarliestGscDataDate(db, projectId)).toBe('2026-07-05')
  })
})

describe('resolveGscWindowDays', () => {
  it('anchors a bare day count the same way a label does', () => {
    // The suggested-queries basket hard-codes 28 days to mirror Google's
    // default. Under a 3-day lag the now-anchored version delivered 25.
    expect(resolveGscWindowDays(28, LATEST, TODAY)).toEqual({
      startDate: '2026-07-13',
      endDate: '2026-08-09',
      latestDataDate: '2026-08-09',
      daysSinceLatestData: 3,
    })
  })

  it('agrees with the labelled resolver on the same span', () => {
    expect(resolveGscWindowDays(30, LATEST, TODAY)).toEqual(resolveGscWindowRange('30d', LATEST, TODAY))
    expect(resolveGscWindowDays(7, LATEST, TODAY)).toEqual(resolveGscWindowRange('7d', LATEST, TODAY))
  })

  it('covers exactly the requested number of inclusive days', () => {
    const range = resolveGscWindowDays(28, LATEST, TODAY)
    const spanDays =
      (Date.parse(`${range.endDate!}T00:00:00Z`) - Date.parse(`${range.startDate!}T00:00:00Z`))
      / 86_400_000 + 1
    expect(spanDays).toBe(28)
  })

  it('falls back to a now-anchored cutoff with no data', () => {
    expect(resolveGscWindowDays(28, null, TODAY)).toEqual({
      startDate: '2026-07-15',
      endDate: null,
      latestDataDate: null,
      daysSinceLatestData: null,
    })
  })
})

describe('resolveReportedWindow', () => {
  const resolved = resolveGscWindowRange('30d', LATEST, TODAY)

  it('passes a forward range through untouched', () => {
    expect(resolveReportedWindow(resolved, '2026-07-20', '2026-08-01')).toMatchObject({
      startDate: '2026-07-20', endDate: '2026-08-01',
    })
  })

  it('lets an explicit bound win over the computed one', () => {
    expect(resolveReportedWindow(resolved, '2026-07-20', undefined).startDate).toBe('2026-07-20')
    expect(resolveReportedWindow(resolved, undefined, '2026-08-01').endDate).toBe('2026-08-01')
  })

  it('drops the COMPUTED bound when mixing it with an explicit one would reverse the range', () => {
    // Explicit start past the computed end: report the start, drop the end.
    // Absent is honest about being unspecified; reversed is not.
    const forward = resolveReportedWindow(resolved, '2030-01-01', undefined)
    expect(forward.startDate).toBe('2030-01-01')
    expect(forward.endDate).toBeNull()
    // And the mirror case: explicit end before the computed start.
    const backward = resolveReportedWindow(resolved, undefined, '2020-01-01')
    expect(backward.endDate).toBe('2020-01-01')
    expect(backward.startDate).toBeNull()
  })

  it('never reports a range whose start is after its end, for any combination', () => {
    for (const start of [undefined, '2020-01-01', '2030-01-01']) {
      for (const end of [undefined, '2020-06-01', '2030-06-01']) {
        if (start && end && start > end) continue // refused upstream, see below
        const w = resolveReportedWindow(resolved, start, end)
        if (w.startDate !== null && w.endDate !== null) {
          expect(w.startDate <= w.endDate).toBe(true)
        }
      }
    }
  })
})

describe('assertForwardRange', () => {
  it('refuses a caller range that runs backwards', () => {
    // Both bounds are the caller's own, so the REQUEST is impossible. Returning
    // an empty result would be true and useless.
    expect(() => assertForwardRange('2030-01-01', '2026-01-06')).toThrow(/is after endDate/)
  })

  it('accepts a forward range, equal bounds, and a partial range', () => {
    expect(() => assertForwardRange('2026-01-01', '2026-01-06')).not.toThrow()
    expect(() => assertForwardRange('2026-01-06', '2026-01-06')).not.toThrow()
    expect(() => assertForwardRange('2026-01-06', undefined)).not.toThrow()
    expect(() => assertForwardRange(undefined, '2026-01-06')).not.toThrow()
    expect(() => assertForwardRange(undefined, undefined)).not.toThrow()
  })
})

describe('daysSinceLatestData', () => {
  it('is named for what it measures, not for a lag it cannot observe', () => {
    // Search Analytics omits zero-data days, so a quiet tail is
    // indistinguishable from an unpublished one. The number is still exact as
    // "days since we last recorded traffic" — which is what it now claims.
    const quietTail = resolveGscWindowRange('30d', '2026-08-01', TODAY)
    expect(quietTail.daysSinceLatestData).toBe(11)
    expect(quietTail.endDate).toBe('2026-08-01')
    // And the window still spans its full labelled length off that anchor.
    expect(quietTail.startDate).toBe('2026-07-03')
  })
})

describe('readLatestGscDataDate — monotonic watermark', () => {
  let db: ReturnType<typeof createClient>
  let tmpDir: string
  let projectId: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsc-watermark-test-'))
    db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)
    projectId = crypto.randomUUID()
    const now = '2026-08-12T00:00:00.000Z'
    db.insert(projects).values({
      id: projectId, name: 'wm', displayName: 'WM', canonicalDomain: 'wm.example.com',
      country: 'US', language: 'en', createdAt: now, updatedAt: now,
    }).run()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function seedProperty(date: string) {
    db.insert(gscDailyTotals).values({
      id: crypto.randomUUID(), projectId, date, clicks: 1, impressions: 10, position: '5',
      createdAt: '2026-08-12T00:00:00.000Z',
    }).run()
  }

  function setWatermark(dataThroughDate: string) {
    db.insert(gscDataWatermarks).values({
      projectId, dataThroughDate, syncedThroughDate: '2026-08-12',
      updatedAt: '2026-08-12T00:00:00.000Z',
    }).onConflictDoUpdate({
      target: gscDataWatermarks.projectId,
      set: { dataThroughDate },
    }).run()
  }

  it('holds the frontier when a quiet tail makes the observed max walk backward', () => {
    // THE BUG: Search Analytics omits zero-data days. The property reached
    // 08-09, then went quiet — the newest row is now 08-01. Without the
    // watermark the anchor follows the rows down and every window slides a week
    // into the past, changing totals for a reason unrelated to performance.
    seedProperty('2026-08-01')
    setWatermark('2026-08-09')
    expect(readLatestGscDataDate(db, projectId)).toBe('2026-08-09')

    const window = resolveGscWindowRange('30d', readLatestGscDataDate(db, projectId), TODAY)
    expect(window.endDate).toBe('2026-08-09')
    expect(window.startDate).toBe('2026-07-11')
  })

  it('still advances when real data moves past the stored watermark', () => {
    // Monotonic means "never backward", not "frozen".
    setWatermark('2026-08-05')
    seedProperty('2026-08-09')
    expect(readLatestGscDataDate(db, projectId)).toBe('2026-08-09')
  })

  it('falls back to the observed max for a project that predates the watermark', () => {
    seedProperty('2026-08-09')
    expect(readLatestGscDataDate(db, projectId)).toBe('2026-08-09')
  })

  it('is null for a project with neither', () => {
    expect(readLatestGscDataDate(db, projectId)).toBeNull()
  })
})
