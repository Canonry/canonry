import { test, expect, onTestFinished, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient, migrate, projects } from '@ainyc/canonry-db'
import { runSiteLivenessPass, startSiteLivenessLoop, SITE_LIVENESS_INTERVAL_MS, type SiteLivenessCheckResult } from '../src/site-liveness-loop.js'

// The loop is deliberately not a schedule row: a row carries a kind, and an
// older build would run an unknown kind as a paid answer-visibility sweep after
// a rollback. These pin the behaviour that replaces it.

function harness(names: string[]) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cnry-liveness-loop-'))
  onTestFinished(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const db = createClient(path.join(tmp, 'test.db'))
  migrate(db)
  const now = new Date().toISOString()
  for (const name of names) {
    db.insert(projects).values({
      id: crypto.randomUUID(), name, displayName: name, canonicalDomain: `${name}.example`,
      country: 'US', language: 'en', providers: [], createdAt: now, updatedAt: now,
    }).run()
  }
  return db
}
const upCheck = (): SiteLivenessCheckResult => ({ id: 'site.reachability', status: 'ok', code: 'site.reachability.up', summary: 'up' })

test('one pass probes every project and reports each result', async () => {
  const db = harness(['alpha', 'beta'])
  const probed: string[] = []
  const notified: string[] = []
  const result = await runSiteLivenessPass({
    db,
    probe: async (project) => { probed.push(project.name); return upCheck() },
    notify: async (projectId) => { notified.push(projectId); return null },
  })
  expect(probed.sort()).toEqual(['alpha', 'beta'])
  expect(notified).toHaveLength(2)
  expect(result).toMatchObject({ checked: 2, events: 0 })
})

test('one project failing never stops the others', async () => {
  const db = harness(['alpha', 'beta', 'gamma'])
  const probed: string[] = []
  const result = await runSiteLivenessPass({
    db,
    probe: async (project) => {
      probed.push(project.name)
      if (project.name === 'beta') throw new Error('probe exploded')
      return upCheck()
    },
    notify: async () => null,
  })
  expect(probed).toHaveLength(3)
  expect(result.checked).toBe(2)
})

test('a probe with no result is skipped rather than reported', async () => {
  const db = harness(['alpha'])
  const notify = vi.fn(async () => null)
  const result = await runSiteLivenessPass({ db, probe: async () => null, notify })
  expect(notify).not.toHaveBeenCalled()
  expect(result).toMatchObject({ checked: 0, events: 0 })
})

test('the loop runs on its interval, never at boot, and stops when told', async () => {
  vi.useFakeTimers()
  onTestFinished(() => vi.useRealTimers())
  const db = harness(['alpha'])
  let passes = 0
  const stop = startSiteLivenessLoop({
    db,
    probe: async () => { passes += 1; return upCheck() },
    notify: async () => null,
  }, 1000)
  // A pass during startup would observe a network that is not up yet.
  expect(passes).toBe(0)
  await vi.advanceTimersByTimeAsync(1000)
  expect(passes).toBe(1)
  stop()
  await vi.advanceTimersByTimeAsync(5000)
  expect(passes).toBe(1)
})

test('a slow pass is never overlapped by the next tick', async () => {
  vi.useFakeTimers()
  onTestFinished(() => vi.useRealTimers())
  const db = harness(['alpha'])
  let started = 0
  let release: (() => void) | null = null
  const stop = startSiteLivenessLoop({
    db,
    probe: async () => {
      started += 1
      await new Promise<void>(resolve => { release = resolve })
      return upCheck()
    },
    notify: async () => null,
  }, 1000)
  await vi.advanceTimersByTimeAsync(1000)
  expect(started).toBe(1)
  await vi.advanceTimersByTimeAsync(3000)
  expect(started).toBe(1)
  release?.()
  stop()
})

test('the shipped interval is the documented ten minutes', () => {
  expect(SITE_LIVENESS_INTERVAL_MS).toBe(10 * 60_000)
})
