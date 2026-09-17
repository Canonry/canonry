import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import { RunKinds, RunStatuses } from '@ainyc/canonry-contracts'
import { createClient, migrate, projects, runs } from '@ainyc/canonry-db'
import { JobRunner } from '../src/job-runner.js'
import { ProviderRegistry } from '../src/provider-registry.js'
import { hashDomain } from '../src/run-telemetry.js'

const ENV_KEYS = [
  'CANONRY_ANONYMOUS_ID',
  'CANONRY_TELEMETRY_DISABLED',
  'DO_NOT_TRACK',
  'CI',
  'CANONRY_CONFIG_DIR',
] as const

let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>>
let configDir: string

beforeEach(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    if (process.env[key] !== undefined) savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  process.env.CANONRY_ANONYMOUS_ID = crypto.randomUUID()
  // An empty config dir is the documented no-config state, where telemetry
  // defaults on. Without it the host's own ~/.canonry/config.yaml decides, and
  // an operator machine with telemetry off makes every assertion vacuous.
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-recovery-telemetry-config-'))
  process.env.CANONRY_CONFIG_DIR = configDir
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(configDir, { recursive: true, force: true })
})

function createFixture() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-recovery-telemetry-'))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const now = Date.now()
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString()
  db.insert(projects).values({
    id: 'project', name: 'project', displayName: 'Project', canonicalDomain: 'https://www.example.com/',
    country: 'US', language: 'en', createdAt: iso(0), updatedAt: iso(0),
  }).run()
  db.insert(runs).values([
    {
      id: 'running-audit', projectId: 'project', kind: RunKinds['site-audit'], status: RunStatuses.running,
      trigger: 'scheduled', startedAt: iso(10 * 60_000), createdAt: iso(11 * 60_000),
    },
    {
      id: 'queued-audit', projectId: 'project', kind: RunKinds['site-audit'], status: RunStatuses.queued,
      trigger: 'manual', createdAt: iso(60_000),
    },
    {
      id: 'running-sweep', projectId: 'project', kind: RunKinds['answer-visibility'], status: RunStatuses.running,
      trigger: 'manual', startedAt: iso(60_000), createdAt: iso(60_000),
    },
    {
      id: 'finished-audit', projectId: 'project', kind: RunKinds['site-audit'], status: RunStatuses.completed,
      trigger: 'manual', startedAt: iso(60_000), finishedAt: iso(0), createdAt: iso(60_000),
    },
  ]).run()
  return { runner: new JobRunner(db, new ProviderRegistry()) }
}

async function captureTelemetry(run: () => void) {
  const payloads: Array<Record<string, unknown>> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.body) payloads.push(JSON.parse(String(init.body)))
    return new Response(JSON.stringify({ ok: true }))
  }
  try {
    run()
    await new Promise(resolve => setTimeout(resolve, 30))
    return payloads
  } finally {
    globalThis.fetch = originalFetch
  }
}

describe('site audit restart recovery telemetry', () => {
  it('reports each crawl a restart interrupted as failed with SERVER_RESTARTED, once', async () => {
    const { runner } = createFixture()

    const first = await captureTelemetry(() => runner.recoverStaleRuns())
    // A second boot finds nothing active, so an interrupted crawl is never reported twice.
    const second = await captureTelemetry(() => runner.recoverStaleRuns())

    expect(second).toEqual([])
    // Only site audits: an interrupted answer-visibility sweep and an already
    // finished crawl emit nothing here.
    expect(first.map(payload => payload.event)).toEqual(['site_audit.completed', 'site_audit.completed'])

    const byTrigger = new Map(first.map(payload => [(payload.properties as { trigger: string }).trigger, payload]))
    for (const payload of first) {
      expect(payload.errorCode).toBe('SERVER_RESTARTED')
      // Recovery runs while the server is constructed, before `serve` flips the
      // process source, so the event must name its surface itself.
      expect(payload.source).toBe('cli-server')
      expect(Object.keys(payload.properties as object).sort()).toEqual(['domainHash', 'durationMs', 'status', 'trigger'])
      expect(payload.properties).toMatchObject({ status: 'failed', domainHash: hashDomain('example.com') })
    }

    // Started ten minutes before the restart: the duration spans the downtime.
    const running = byTrigger.get('scheduled')!.properties as { durationMs: number }
    expect(running.durationMs).toBeGreaterThanOrEqual(10 * 60_000)
    expect(running.durationMs).toBeLessThan(11 * 60_000)

    // Never started, so there is no duration to report.
    const queued = byTrigger.get('manual')!.properties as { durationMs: number }
    expect(queued.durationMs).toBeLessThan(1_000)
  })
})
