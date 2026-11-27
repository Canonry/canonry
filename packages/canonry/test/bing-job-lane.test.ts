import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient, migrate, projects } from '@canonry/canonry-db'
import * as bingModule from '@canonry/canonry-integration-bing'
import { BING_LANE_MAX_COOLDOWN_WAIT_MS, __resetBingJobLanesForTest, runBingJob, runInBingLane } from '../src/bing-job-lane.js'
import type { CanonryConfig } from '../src/config.js'

/** A job the test finishes by hand, recording when it started. */
function heldJob(name: string, started: string[]) {
  let finish!: () => void
  let fail!: (err: Error) => void
  const done = new Promise<string>((resolve, reject) => {
    finish = () => resolve(name)
    fail = reject
  })
  return {
    work: () => {
      started.push(name)
      return done
    },
    finish,
    fail,
  }
}

/** Lets queued promise callbacks run. */
const settle = () => new Promise((resolve) => setImmediate(resolve))

describe('Bing job lane', () => {
  beforeEach(() => {
    __resetBingJobLanesForTest()
    vi.spyOn(bingModule, 'bingThrottleCooldownRemainingMs').mockReturnValue(0)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    __resetBingJobLanesForTest()
  })

  it('runs one job at a time per key, and a waiting sync before an earlier waiting inspection', async () => {
    const started: string[] = []
    const first = heldJob('first inspection', started)
    const second = heldJob('second inspection', started)
    const sync = heldJob('sync', started)

    const results = [
      runInBingLane('shared-key', 'inspect', first.work),
      runInBingLane('shared-key', 'inspect', second.work),
      runInBingLane('shared-key', 'sync', sync.work),
    ]
    await settle()
    expect(started).toEqual(['first inspection'])

    first.finish()
    await settle()
    // The sync queued last but carries the search data, so it goes next.
    expect(started).toEqual(['first inspection', 'sync'])

    sync.finish()
    await settle()
    expect(started).toEqual(['first inspection', 'sync', 'second inspection'])
    second.finish()
    await expect(Promise.all(results)).resolves.toEqual(['first inspection', 'second inspection', 'sync'])
  })

  it('runs jobs on different keys side by side', async () => {
    const started: string[] = []
    const one = heldJob('account one', started)
    const two = heldJob('account two', started)

    const results = [runInBingLane('key-one', 'sync', one.work), runInBingLane('key-two', 'sync', two.work)]
    await settle()

    expect(started).toEqual(['account one', 'account two'])
    one.finish()
    two.finish()
    await Promise.all(results)
  })

  it('hands the lane on when a job fails', async () => {
    const started: string[] = []
    const failing = heldJob('failing', started)
    const next = heldJob('next', started)

    const failed = runInBingLane('shared-key', 'sync', failing.work)
    const after = runInBingLane('shared-key', 'inspect', next.work)
    failing.fail(new Error('Bing said no'))

    await expect(failed).rejects.toThrow('Bing said no')
    await settle()
    expect(started).toEqual(['failing', 'next'])
    next.finish()
    await expect(after).resolves.toBe('next')
  })

  it('waits out an open throttle cooldown before starting, up to a bound', async () => {
    vi.mocked(bingModule.bingThrottleCooldownRemainingMs).mockReturnValue(420_000)
    const sleep = vi.fn(async () => {})
    const work = vi.fn(async () => 'ran')

    await expect(runInBingLane('shared-key', 'sync', work, { sleep })).resolves.toBe('ran')
    expect(sleep).toHaveBeenCalledWith(420_000)
    expect(sleep.mock.invocationCallOrder[0]!).toBeLessThan(work.mock.invocationCallOrder[0]!)

    // A Retry-After of hours does not hold the queue that long.
    vi.mocked(bingModule.bingThrottleCooldownRemainingMs).mockReturnValue(3 * 60 * 60 * 1000)
    sleep.mockClear()
    await runInBingLane('shared-key', 'sync', work, { sleep })
    expect(sleep).toHaveBeenCalledWith(BING_LANE_MAX_COOLDOWN_WAIT_MS)
  })

  describe('runBingJob', () => {
    let tmpDir: string
    let db: ReturnType<typeof createClient>

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bing-job-lane-'))
      db = createClient(path.join(tmpDir, 'test.db'))
      migrate(db)
    })

    afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

    function project(domain: string): string {
      const id = crypto.randomUUID()
      const now = new Date().toISOString()
      db.insert(projects).values({
        id, name: domain, displayName: domain, canonicalDomain: domain, country: 'US', language: 'en',
        providers: [], createdAt: now, updatedAt: now,
      } as typeof projects.$inferInsert).run()
      return id
    }

    const connection = (domain: string, apiKey: string) => ({
      domain, apiKey, siteUrl: `https://${domain}/`, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    })

    it('queues two projects on one Bing key, and runs a project without a connection at once', async () => {
      const alpha = project('alpha.example')
      const beta = project('beta.example')
      const loose = project('loose.example')
      const config = {
        apiUrl: 'http://localhost:4100', database: '/tmp/test.db', apiKey: 'cnry_test',
        bing: { connections: [connection('alpha.example', 'shared-key'), connection('beta.example', 'shared-key')] },
      } as CanonryConfig
      const started: string[] = []
      const alphaJob = heldJob('alpha', started)
      const betaJob = heldJob('beta', started)
      const looseJob = heldJob('loose', started)

      const results = [
        runBingJob(db, config, alpha, 'inspect', alphaJob.work),
        runBingJob(db, config, beta, 'sync', betaJob.work),
        runBingJob(db, config, loose, 'sync', looseJob.work),
      ]
      await settle()
      // Beta shares alpha's key and waits; the unconnected project does not.
      expect([...started].sort()).toEqual(['alpha', 'loose'])

      alphaJob.finish()
      await settle()
      expect(started.at(-1)).toBe('beta')
      betaJob.finish()
      looseJob.finish()
      await Promise.all(results)
    })
  })
})
