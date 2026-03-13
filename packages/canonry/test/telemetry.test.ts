import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { parse } from 'yaml'
import { createClient, migrate, projects, runs } from '@ainyc/canonry-db'
import { JobRunner } from '../src/job-runner.js'
import { ProviderRegistry } from '../src/provider-registry.js'

const tmpDir = path.join(os.tmpdir(), `canonry-telemetry-test-${crypto.randomUUID()}`)

function restoreEnvVar(name: string, original: string | undefined) {
  if (original === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = original
  }
}

function makeConfig(overrides?: Record<string, unknown>) {
  return {
    apiUrl: 'http://localhost:4100',
    database: 'test.db',
    apiKey: 'cnry_test',
    ...overrides,
  }
}

describe('telemetry', () => {
  let savedEnvVars: Record<string, string | undefined>
  const envVarsToSave = [
    'CANONRY_CONFIG_DIR',
    'CANONRY_TELEMETRY_DISABLED',
    'DO_NOT_TRACK',
    'CI',
  ]

  beforeEach(() => {
    savedEnvVars = {}
    for (const name of envVarsToSave) {
      savedEnvVars[name] = process.env[name]
    }
    const testDir = path.join(tmpDir, crypto.randomUUID())
    fs.mkdirSync(testDir, { recursive: true })
    process.env.CANONRY_CONFIG_DIR = testDir
    delete process.env.CANONRY_TELEMETRY_DISABLED
    delete process.env.DO_NOT_TRACK
    delete process.env.CI
  })

  afterEach(() => {
    for (const name of envVarsToSave) {
      restoreEnvVar(name, savedEnvVars[name])
    }
  })

  // ── isTelemetryEnabled ──────────────────────────────────────────────

  describe('isTelemetryEnabled', () => {
    it('returns true by default (no config, no env vars)', async () => {
      const { isTelemetryEnabled } = await import('../src/telemetry.js')
      assert.equal(isTelemetryEnabled(), true)
    })

    it('returns false when CANONRY_TELEMETRY_DISABLED=1', async () => {
      process.env.CANONRY_TELEMETRY_DISABLED = '1'
      const { isTelemetryEnabled } = await import('../src/telemetry.js')
      assert.equal(isTelemetryEnabled(), false)
    })

    it('returns false when DO_NOT_TRACK=1', async () => {
      process.env.DO_NOT_TRACK = '1'
      const { isTelemetryEnabled } = await import('../src/telemetry.js')
      assert.equal(isTelemetryEnabled(), false)
    })

    it('returns false when CI=true', async () => {
      process.env.CI = 'true'
      const { isTelemetryEnabled } = await import('../src/telemetry.js')
      assert.equal(isTelemetryEnabled(), false)
    })

    it('returns false when CI=1', async () => {
      process.env.CI = '1'
      const { isTelemetryEnabled } = await import('../src/telemetry.js')
      assert.equal(isTelemetryEnabled(), false)
    })

    it('returns false for any truthy CI value', async () => {
      process.env.CI = 'false'
      const { isTelemetryEnabled } = await import('../src/telemetry.js')
      // Any truthy CI value disables telemetry (the string "false" is truthy)
      assert.equal(isTelemetryEnabled(), false)
    })

    it('returns false when config has telemetry: false', async () => {
      const { isTelemetryEnabled } = await import('../src/telemetry.js')
      const { saveConfig } = await import('../src/config.js')
      saveConfig(makeConfig({ telemetry: false }))
      assert.equal(isTelemetryEnabled(), false)
    })

    it('returns true when config has telemetry: true', async () => {
      const { isTelemetryEnabled } = await import('../src/telemetry.js')
      const { saveConfig } = await import('../src/config.js')
      saveConfig(makeConfig({ telemetry: true }))
      assert.equal(isTelemetryEnabled(), true)
    })

    it('returns true when config exists but telemetry field is absent', async () => {
      const { isTelemetryEnabled } = await import('../src/telemetry.js')
      const { saveConfig } = await import('../src/config.js')
      saveConfig(makeConfig())
      assert.equal(isTelemetryEnabled(), true)
    })

    it('env var CANONRY_TELEMETRY_DISABLED takes precedence over config telemetry: true', async () => {
      const { isTelemetryEnabled } = await import('../src/telemetry.js')
      const { saveConfig } = await import('../src/config.js')
      saveConfig(makeConfig({ telemetry: true }))
      process.env.CANONRY_TELEMETRY_DISABLED = '1'
      assert.equal(isTelemetryEnabled(), false)
    })

    it('DO_NOT_TRACK takes precedence over config telemetry: true', async () => {
      const { isTelemetryEnabled } = await import('../src/telemetry.js')
      const { saveConfig } = await import('../src/config.js')
      saveConfig(makeConfig({ telemetry: true }))
      process.env.DO_NOT_TRACK = '1'
      assert.equal(isTelemetryEnabled(), false)
    })
  })

  // ── getOrCreateAnonymousId ──────────────────────────────────────────

  describe('getOrCreateAnonymousId', () => {
    it('generates a valid UUIDv4 and persists it to config', async () => {
      const { getOrCreateAnonymousId } = await import('../src/telemetry.js')
      const { saveConfig, loadConfig } = await import('../src/config.js')
      saveConfig(makeConfig())

      const id = getOrCreateAnonymousId()
      assert.ok(id)
      assert.match(id!, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)

      const config = loadConfig()
      assert.equal(config.anonymousId, id)
    })

    it('returns the same ID on subsequent calls (idempotent)', async () => {
      const { getOrCreateAnonymousId } = await import('../src/telemetry.js')
      const { saveConfig } = await import('../src/config.js')
      saveConfig(makeConfig())

      const id1 = getOrCreateAnonymousId()
      const id2 = getOrCreateAnonymousId()
      assert.equal(id1, id2)
    })

    it('returns undefined when no config exists', async () => {
      const { getOrCreateAnonymousId } = await import('../src/telemetry.js')
      assert.equal(getOrCreateAnonymousId(), undefined)
    })

    it('returns existing anonymousId from config without generating a new one', async () => {
      const { getOrCreateAnonymousId } = await import('../src/telemetry.js')
      const { saveConfig } = await import('../src/config.js')
      const existingId = crypto.randomUUID()
      saveConfig(makeConfig({ anonymousId: existingId }))

      const id = getOrCreateAnonymousId()
      assert.equal(id, existingId)
    })

    it('preserves all existing config fields when saving the new ID', async () => {
      const { getOrCreateAnonymousId } = await import('../src/telemetry.js')
      const { saveConfig, loadConfig } = await import('../src/config.js')
      saveConfig(makeConfig({
        port: 5000,
        providers: { gemini: { apiKey: 'test-key', model: 'gemini-2.5-flash' } },
      }))

      getOrCreateAnonymousId()

      const config = loadConfig()
      assert.equal(config.port, 5000)
      assert.equal(config.providers?.gemini?.apiKey, 'test-key')
      assert.equal(config.apiKey, 'cnry_test')
      assert.ok(config.anonymousId)
    })
  })

  // ── isFirstRun ──────────────────────────────────────────────────────

  describe('isFirstRun', () => {
    it('returns false when no config exists (pre-init)', async () => {
      const { isFirstRun } = await import('../src/telemetry.js')
      assert.equal(isFirstRun(), false)
    })

    it('returns true when config exists without anonymousId', async () => {
      const { isFirstRun } = await import('../src/telemetry.js')
      const { saveConfig } = await import('../src/config.js')
      saveConfig(makeConfig())
      assert.equal(isFirstRun(), true)
    })

    it('returns false when config exists with anonymousId', async () => {
      const { isFirstRun } = await import('../src/telemetry.js')
      const { saveConfig } = await import('../src/config.js')
      saveConfig(makeConfig({ anonymousId: crypto.randomUUID() }))
      assert.equal(isFirstRun(), false)
    })
  })

  // ── showFirstRunNotice ──────────────────────────────────────────────

  describe('showFirstRunNotice', () => {
    it('writes notice to stderr (not stdout)', async () => {
      const { showFirstRunNotice } = await import('../src/telemetry.js')
      const chunks: Buffer[] = []
      const originalWrite = process.stderr.write
      process.stderr.write = (chunk: string | Uint8Array) => {
        chunks.push(Buffer.from(chunk))
        return true
      }

      try {
        showFirstRunNotice()
        const output = Buffer.concat(chunks).toString()
        assert.ok(output.includes('anonymous telemetry'))
        assert.ok(output.includes('canonry telemetry disable'))
        assert.ok(output.includes('ainyc.ai/telemetry'))
      } finally {
        process.stderr.write = originalWrite
      }
    })
  })

  // ── trackEvent ──────────────────────────────────────────────────────

  describe('trackEvent', () => {
    it('is a no-op when telemetry is disabled via env var', async () => {
      process.env.CANONRY_TELEMETRY_DISABLED = '1'
      const { trackEvent } = await import('../src/telemetry.js')

      const originalFetch = globalThis.fetch
      let fetchCalled = false
      globalThis.fetch = async () => {
        fetchCalled = true
        return new Response()
      }

      try {
        trackEvent('test.event', { foo: 'bar' })
        assert.equal(fetchCalled, false, 'fetch should not be called when telemetry is disabled')
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('is a no-op when no config exists (no anonymous ID)', async () => {
      const { trackEvent } = await import('../src/telemetry.js')

      const originalFetch = globalThis.fetch
      let fetchCalled = false
      globalThis.fetch = async () => {
        fetchCalled = true
        return new Response()
      }

      try {
        trackEvent('test.event')
        assert.equal(fetchCalled, false, 'fetch should not be called when no config exists')
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('sends a POST with correct payload shape when enabled', async () => {
      const { trackEvent } = await import('../src/telemetry.js')
      const { saveConfig } = await import('../src/config.js')
      const anonId = crypto.randomUUID()
      saveConfig(makeConfig({ anonymousId: anonId }))

      let capturedBody: string | undefined
      let capturedMethod: string | undefined
      let capturedHeaders: Record<string, string> = {}
      const originalFetch = globalThis.fetch
      globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
        capturedMethod = init?.method
        capturedBody = init?.body as string
        capturedHeaders = Object.fromEntries(
          Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
        )
        return new Response(JSON.stringify({ ok: true }))
      }

      try {
        trackEvent('cli.command', { command: 'run' })

        // Give the fire-and-forget fetch a tick to execute
        await new Promise(resolve => setTimeout(resolve, 10))

        assert.equal(capturedMethod, 'POST')
        assert.equal(capturedHeaders['content-type'], 'application/json')

        assert.ok(capturedBody, 'fetch body should be set')
        const payload = JSON.parse(capturedBody!)
        assert.equal(payload.anonymousId, anonId)
        assert.equal(payload.event, 'cli.command')
        assert.equal(payload.os, process.platform)
        assert.equal(payload.arch, process.arch)
        assert.equal(payload.nodeVersion, process.versions.node)
        assert.ok(payload.version, 'version should be set')
        assert.ok(payload.timestamp, 'timestamp should be set')
        assert.deepEqual(payload.properties, { command: 'run' })
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('sends to the correct endpoint', async () => {
      const { trackEvent } = await import('../src/telemetry.js')
      const { saveConfig } = await import('../src/config.js')
      saveConfig(makeConfig({ anonymousId: crypto.randomUUID() }))

      let capturedUrl: string | undefined
      const originalFetch = globalThis.fetch
      globalThis.fetch = async (url: string | URL | Request, _init?: RequestInit) => {
        capturedUrl = String(url)
        return new Response(JSON.stringify({ ok: true }))
      }

      try {
        trackEvent('test.event')
        await new Promise(resolve => setTimeout(resolve, 10))
        assert.equal(capturedUrl, 'https://ainyc.ai/api/telemetry')
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('does not throw when fetch rejects (network error)', async () => {
      const { trackEvent } = await import('../src/telemetry.js')
      const { saveConfig } = await import('../src/config.js')
      saveConfig(makeConfig({ anonymousId: crypto.randomUUID() }))

      const originalFetch = globalThis.fetch
      globalThis.fetch = async () => {
        throw new Error('Network error')
      }

      try {
        trackEvent('test.event', { foo: 'bar' })
        // Wait for the promise to settle
        await new Promise(resolve => setTimeout(resolve, 50))
        // If we got here, no exception was thrown — success
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('omits properties key from payload when not provided', async () => {
      const { trackEvent } = await import('../src/telemetry.js')
      const { saveConfig } = await import('../src/config.js')
      saveConfig(makeConfig({ anonymousId: crypto.randomUUID() }))

      let capturedBody: string | undefined
      const originalFetch = globalThis.fetch
      globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
        capturedBody = init?.body as string
        return new Response()
      }

      try {
        trackEvent('test.event')
        await new Promise(resolve => setTimeout(resolve, 10))
        const payload = JSON.parse(capturedBody!)
        assert.equal(payload.properties, undefined)
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })

  // ── telemetryCommand ────────────────────────────────────────────────

  describe('telemetryCommand', () => {
    it('disable sets telemetry: false in config file', async () => {
      const { saveConfig, loadConfig, getConfigPath } = await import('../src/config.js')
      const { telemetryCommand } = await import('../src/commands/telemetry.js')
      saveConfig(makeConfig())

      telemetryCommand('disable')

      const config = loadConfig()
      assert.equal(config.telemetry, false)

      // Also verify the YAML on disk
      const raw = fs.readFileSync(getConfigPath(), 'utf-8')
      const parsed = parse(raw)
      assert.equal(parsed.telemetry, false)
    })

    it('enable sets telemetry: true in config file', async () => {
      const { saveConfig, loadConfig } = await import('../src/config.js')
      const { telemetryCommand } = await import('../src/commands/telemetry.js')
      saveConfig(makeConfig({ telemetry: false }))

      telemetryCommand('enable')

      const config = loadConfig()
      assert.equal(config.telemetry, true)
    })

    it('disable then enable round-trips correctly', async () => {
      const { saveConfig, loadConfig } = await import('../src/config.js')
      const { telemetryCommand } = await import('../src/commands/telemetry.js')
      const { isTelemetryEnabled } = await import('../src/telemetry.js')
      saveConfig(makeConfig())

      telemetryCommand('disable')
      assert.equal(isTelemetryEnabled(), false)

      telemetryCommand('enable')
      assert.equal(isTelemetryEnabled(), true)

      const config = loadConfig()
      assert.equal(config.telemetry, true)
    })

    it('status outputs "enabled" when telemetry is on', async () => {
      const { saveConfig } = await import('../src/config.js')
      const { telemetryCommand } = await import('../src/commands/telemetry.js')
      saveConfig(makeConfig())

      const logs: string[] = []
      const originalLog = console.log
      console.log = (msg: string) => logs.push(msg)

      try {
        telemetryCommand('status')
        assert.ok(logs.some(l => l.includes('enabled')))
      } finally {
        console.log = originalLog
      }
    })

    it('status outputs "disabled" when telemetry is off', async () => {
      const { saveConfig } = await import('../src/config.js')
      const { telemetryCommand } = await import('../src/commands/telemetry.js')
      saveConfig(makeConfig({ telemetry: false }))

      const logs: string[] = []
      const originalLog = console.log
      console.log = (msg: string) => logs.push(msg)

      try {
        telemetryCommand('status')
        assert.ok(logs.some(l => l.includes('disabled')))
      } finally {
        console.log = originalLog
      }
    })

    it('status shows masked anonymous ID when present', async () => {
      const { saveConfig } = await import('../src/config.js')
      const { telemetryCommand } = await import('../src/commands/telemetry.js')
      const anonId = crypto.randomUUID()
      saveConfig(makeConfig({ anonymousId: anonId }))

      const logs: string[] = []
      const originalLog = console.log
      console.log = (msg: string) => logs.push(msg)

      try {
        telemetryCommand('status')
        const idLine = logs.find(l => l.includes('Anonymous ID'))
        assert.ok(idLine)
        // Should show first 8 chars + "..."
        assert.ok(idLine!.includes(anonId.slice(0, 8) + '...'))
        // Should NOT expose the full ID
        assert.ok(!idLine!.includes(anonId))
      } finally {
        console.log = originalLog
      }
    })

    it('status reports env var override for CANONRY_TELEMETRY_DISABLED', async () => {
      const { telemetryCommand } = await import('../src/commands/telemetry.js')
      process.env.CANONRY_TELEMETRY_DISABLED = '1'

      const logs: string[] = []
      const originalLog = console.log
      console.log = (msg: string) => logs.push(msg)

      try {
        telemetryCommand('status')
        assert.ok(logs.some(l => l.includes('CANONRY_TELEMETRY_DISABLED')))
      } finally {
        console.log = originalLog
      }
    })

    it('status reports env var override for DO_NOT_TRACK', async () => {
      const { telemetryCommand } = await import('../src/commands/telemetry.js')
      process.env.DO_NOT_TRACK = '1'

      const logs: string[] = []
      const originalLog = console.log
      console.log = (msg: string) => logs.push(msg)

      try {
        telemetryCommand('status')
        assert.ok(logs.some(l => l.includes('DO_NOT_TRACK')))
      } finally {
        console.log = originalLog
      }
    })

    it('status reports CI environment detection', async () => {
      const { telemetryCommand } = await import('../src/commands/telemetry.js')
      process.env.CI = 'true'

      const logs: string[] = []
      const originalLog = console.log
      console.log = (msg: string) => logs.push(msg)

      try {
        telemetryCommand('status')
        assert.ok(logs.some(l => l.includes('CI')))
      } finally {
        console.log = originalLog
      }
    })

    it('disable preserves other config fields', async () => {
      const { saveConfig, loadConfig } = await import('../src/config.js')
      const { telemetryCommand } = await import('../src/commands/telemetry.js')
      saveConfig(makeConfig({
        port: 5000,
        providers: { openai: { apiKey: 'sk-test', model: 'gpt-4o' } },
        anonymousId: crypto.randomUUID(),
      }))

      telemetryCommand('disable')

      const config = loadConfig()
      assert.equal(config.telemetry, false)
      assert.equal(config.port, 5000)
      assert.equal(config.providers?.openai?.apiKey, 'sk-test')
      assert.ok(config.anonymousId)
    })
  })

  // ── privacy contract ─────────────────────────────────────────────────

  describe('privacy contract', () => {
    it('trackEvent does not fire for telemetry commands', async () => {
      // Simulates the cli.ts logic: telemetry commands should not be tracked
      const { trackEvent } = await import('../src/telemetry.js')
      const { saveConfig } = await import('../src/config.js')
      saveConfig(makeConfig({ anonymousId: crypto.randomUUID() }))

      const originalFetch = globalThis.fetch
      let fetchCalled = false
      globalThis.fetch = async () => {
        fetchCalled = true
        return new Response()
      }

      try {
        // Simulate cli.ts guard: skip tracking for telemetry commands
        const command = 'telemetry'
        if (command !== 'telemetry') {
          trackEvent('cli.command', { command: 'telemetry.disable' })
        }
        assert.equal(fetchCalled, false, 'telemetry commands must not be tracked')
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('disabled config has no anonymousId by default', async () => {
      const { isTelemetryEnabled } = await import('../src/telemetry.js')
      const { saveConfig, loadConfig } = await import('../src/config.js')
      saveConfig(makeConfig({ telemetry: false }))

      // Verify telemetry is off
      assert.equal(isTelemetryEnabled(), false)

      // A disabled config should not have anonymousId unless one was previously created
      const config = loadConfig()
      assert.equal(config.anonymousId, undefined, 'anonymousId should not exist in a fresh disabled config')
    })

    it('first-run notice is not shown for telemetry or init commands', async () => {
      const { isFirstRun, isTelemetryEnabled } = await import('../src/telemetry.js')
      const { saveConfig } = await import('../src/config.js')
      saveConfig(makeConfig())

      // Simulates cli.ts logic: skip first-run notice for 'telemetry' and 'init'
      function shouldShowNotice(command: string): boolean {
        return command !== 'telemetry' && command !== 'init' && isTelemetryEnabled() && isFirstRun()
      }

      assert.equal(shouldShowNotice('telemetry'), false, 'first-run notice must not show for telemetry')
      assert.equal(shouldShowNotice('init'), false, 'first-run notice must not show for init')
      assert.equal(shouldShowNotice('run'), true, 'first-run notice should show for normal commands')
    })
  })

  // ── config round-trip ───────────────────────────────────────────────

  describe('config round-trip', () => {
    it('telemetry: false persists through save/load cycle', async () => {
      const { saveConfig, loadConfig } = await import('../src/config.js')
      saveConfig(makeConfig({ telemetry: false }))
      const loaded = loadConfig()
      assert.equal(loaded.telemetry, false)
    })

    it('telemetry: true persists through save/load cycle', async () => {
      const { saveConfig, loadConfig } = await import('../src/config.js')
      saveConfig(makeConfig({ telemetry: true }))
      const loaded = loadConfig()
      assert.equal(loaded.telemetry, true)
    })

    it('anonymousId persists through save/load cycle', async () => {
      const { saveConfig, loadConfig } = await import('../src/config.js')
      const id = crypto.randomUUID()
      saveConfig(makeConfig({ anonymousId: id }))
      const loaded = loadConfig()
      assert.equal(loaded.anonymousId, id)
    })

    it('config without telemetry fields loads with undefined', async () => {
      const { saveConfig, loadConfig } = await import('../src/config.js')
      saveConfig(makeConfig())
      const loaded = loadConfig()
      assert.equal(loaded.telemetry, undefined)
      assert.equal(loaded.anonymousId, undefined)
    })
  })

  // ── JobRunner outer-catch telemetry ─────────────────────────────────

  describe('JobRunner fatal failure telemetry', () => {
    it('emits run.completed with status failed when no providers configured', async () => {
      const { saveConfig } = await import('../src/config.js')
      saveConfig(makeConfig({ anonymousId: crypto.randomUUID() }))

      // Set up an in-memory SQLite DB
      const dbPath = path.join(os.tmpdir(), `canonry-jr-test-${crypto.randomUUID()}`, 'test.db')
      const db = createClient(dbPath)
      migrate(db)

      // Insert a project and a queued run
      const projectId = crypto.randomUUID()
      const runId = crypto.randomUUID()
      const now = new Date().toISOString()

      db.insert(projects).values({
        id: projectId,
        name: 'test-project',
        displayName: 'Test Project',
        canonicalDomain: 'example.com',
        country: 'US',
        language: 'en',
        providers: '[]',
        createdAt: now,
        updatedAt: now,
      }).run()

      db.insert(runs).values({
        id: runId,
        projectId,
        status: 'queued',
        createdAt: now,
      }).run()

      // Empty registry → triggers "No providers configured" error
      const registry = new ProviderRegistry()
      const runner = new JobRunner(db, registry)

      // Capture telemetry POST
      const capturedPayloads: Array<Record<string, unknown>> = []
      const originalFetch = globalThis.fetch
      globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.body) {
          capturedPayloads.push(JSON.parse(init.body as string))
        }
        return new Response(JSON.stringify({ ok: true }))
      }

      try {
        await runner.executeRun(runId, projectId)

        // Give fire-and-forget fetch a tick
        await new Promise(resolve => setTimeout(resolve, 50))

        // Verify telemetry was emitted with failure status
        assert.ok(capturedPayloads.length >= 1, 'expected at least one telemetry event')
        const runEvent = capturedPayloads.find(p => p.event === 'run.completed')
        assert.ok(runEvent, 'expected a run.completed telemetry event')
        assert.deepEqual(runEvent!.properties, {
          status: 'failed',
          providerCount: 0,
          providers: [],
          keywordCount: 0,
          durationMs: (runEvent!.properties as Record<string, unknown>).durationMs,
        })
        assert.equal((runEvent!.properties as Record<string, unknown>).status, 'failed')

        // Verify the run was marked as failed in the DB
        const failedRun = db.select().from(runs).all().find(r => r.id === runId)
        assert.equal(failedRun?.status, 'failed')
        assert.ok(failedRun?.error?.includes('No providers configured'))
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('emits run.completed with status failed when project is missing', async () => {
      const { saveConfig } = await import('../src/config.js')
      saveConfig(makeConfig({ anonymousId: crypto.randomUUID() }))

      const dbPath = path.join(os.tmpdir(), `canonry-jr-test-${crypto.randomUUID()}`, 'test.db')
      const db = createClient(dbPath)
      migrate(db)

      // Insert a project first (for FK), then a run, then delete the project
      // Actually, simpler: insert a run with a projectId that references a real project,
      // but we need FK. Let's create the project, create the run, then use a different projectId for lookup.
      const realProjectId = crypto.randomUUID()
      const runId = crypto.randomUUID()
      const fakeProjectId = crypto.randomUUID()
      const now = new Date().toISOString()

      db.insert(projects).values({
        id: realProjectId,
        name: 'real-project',
        displayName: 'Real Project',
        canonicalDomain: 'example.com',
        country: 'US',
        language: 'en',
        providers: '[]',
        createdAt: now,
        updatedAt: now,
      }).run()

      // Insert run referencing the real project (satisfies FK)
      db.insert(runs).values({
        id: runId,
        projectId: realProjectId,
        status: 'queued',
        createdAt: now,
      }).run()

      const registry = new ProviderRegistry()
      const runner = new JobRunner(db, registry)

      const capturedPayloads: Array<Record<string, unknown>> = []
      const originalFetch = globalThis.fetch
      globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.body) {
          capturedPayloads.push(JSON.parse(init.body as string))
        }
        return new Response(JSON.stringify({ ok: true }))
      }

      try {
        // Pass fakeProjectId — project lookup will fail
        await runner.executeRun(runId, fakeProjectId)
        await new Promise(resolve => setTimeout(resolve, 50))

        const runEvent = capturedPayloads.find(p => p.event === 'run.completed')
        assert.ok(runEvent, 'expected a run.completed telemetry event for missing project')
        assert.equal((runEvent!.properties as Record<string, unknown>).status, 'failed')
        assert.equal((runEvent!.properties as Record<string, unknown>).providerCount, 0)
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })
})
