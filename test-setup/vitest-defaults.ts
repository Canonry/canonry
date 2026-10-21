/**
 * Shared vitest setup — runs before each test file's imports.
 *
 * Wired into the root workspace config and every package's `test` script via
 * `vitest.package.config.ts`. Package-local Vitest configs must include the
 * same setup file when they bypass the shared package config.
 *
 * Hardens the test environment against accidental side effects:
 *   1. Disables canonry telemetry. Even packages that don't import the
 *      telemetry module benefit — invokeCli-style tests sometimes pull
 *      in code paths that fire `cli.command` events.
 *   2. Redirects `CANONRY_CONFIG_DIR` and the home directory at throwaway
 *      directories, so no test can write to the operator's real `~/.canonry`.
 *      corepack's download cache keeps its real location.
 *   3. Replaces `globalThis.fetch` with a guard that throws on any
 *      non-localhost request, so a test that forgets to mock fetch
 *      can't silently hit the real internet.
 *   4. Replaces the `resolve4` / `resolve6` DNS queries of `node:dns/promises`
 *      with a guard that rejects every name but `localhost` and
 *      `*.localhost`. The egress gates resolve names with these queries, and
 *      the guarded fetch (`createGuardedFetch` in api-routes) dials what they
 *      return through its own undici agent, which the fetch guard never
 *      sees. A test that needs a name answered stubs it with
 *      `vi.spyOn(dns, 'resolve4')`; restoring the spy puts this guard back.
 *   5. Answers `migrate(db)` on an empty database with the run's migrated
 *      database (`migrated-database.ts`), instead of rerunning every
 *      migration. Custom version lists and non-empty databases still run
 *      the real migrations.
 *
 * Projects with `isolate: false` (vitest.config.ts) run many test files in one
 * worker, and this file runs again before each of them. It first puts back
 * process state a previous file may have left: stubbed globals, the
 * environment and working directory as the worker started, real timers, no
 * pending exit code. The guards always wrap the real fetch and DNS queries
 * saved on the worker's first run, never a previous file's mock.
 *
 * The fetch guard is compatible with the standard save-and-restore
 * pattern (`const orig = globalThis.fetch; globalThis.fetch = mockFn; ...; globalThis.fetch = orig`)
 * — tests capture this guard as `orig`, install their mock, and put
 * the guard back on cleanup. The guard stays in effect between tests.
 */

import dns from 'node:dns/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { inject, vi } from 'vitest'
import { replayingMigrate } from './migrated-database.js'

interface WorkerStart {
  env: NodeJS.ProcessEnv
  cwd: string
  fetch: typeof globalThis.fetch
  resolve4: typeof dns.resolve4
  resolve6: typeof dns.resolve6
}

const workerGlobals = globalThis as typeof globalThis & { __canonryTestWorkerStart?: WorkerStart }
const workerStart = workerGlobals.__canonryTestWorkerStart ??= {
  env: { ...process.env },
  cwd: process.cwd(),
  fetch: globalThis.fetch,
  resolve4: dns.resolve4,
  resolve6: dns.resolve6,
}
vi.unstubAllGlobals()
vi.unstubAllEnvs()
// Vitest sets VITEST_POOL_ID and VITEST_WORKER_ID for each file itself.
for (const key of Object.keys(process.env)) {
  if (!key.startsWith('VITEST') && !(key in workerStart.env)) delete process.env[key]
}
for (const [key, value] of Object.entries(workerStart.env)) {
  if (!key.startsWith('VITEST')) process.env[key] = value
}
if (process.cwd() !== workerStart.cwd) process.chdir(workerStart.cwd)
process.exitCode = undefined
vi.useRealTimers()

process.env.CANONRY_TELEMETRY_DISABLED = '1'

const TELEMETRY_HOSTS = new Set([
  'ainyc.ai',
  'www.ainyc.ai',
  'canonry.ai',
  'www.canonry.ai',
])

const realFetch = workerStart.fetch

function isLocalHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '0.0.0.0' ||
    hostname === '::1' ||
    hostname.endsWith('.localhost')
  )
}

function urlOf(input: string | URL | Request): URL | null {
  try {
    if (typeof input === 'string') return new URL(input)
    if (input instanceof URL) return input
    if (typeof Request !== 'undefined' && input instanceof Request) return new URL(input.url)
  } catch {
    return null
  }
  return null
}

/**
 * Point every test at a throwaway config directory.
 *
 * Several code paths persist to the operator's config as a side effect of
 * ordinary work — `executeGscSync` writes refreshed OAuth tokens back through
 * `saveConfigPatch`, for instance. A test that calls one with fixture
 * credentials will happily overwrite the real `~/.canonry/config.yaml`; on
 * 2026-08-06 that replaced twelve live Google connections with a single
 * `example.com` fixture and broke the operator's Search Console auth.
 *
 * Same reasoning as the network guard below: a unit test must not reach
 * outside its own sandbox, and a config write is a side effect on the
 * developer's machine every bit as real as an HTTP call.
 *
 * An explicitly-set `CANONRY_CONFIG_DIR` is respected — a test that wants a
 * specific directory has already opted in.
 */
if (!process.env.CANONRY_CONFIG_DIR?.trim()) {
  process.env.CANONRY_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-test-config-'))
}

// Files kept under the home directory (`~/.canonry/machine-id`, plugins,
// caches) get the same protection: `os.homedir()` reads these variables.
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-test-home-'))
process.env.HOME = testHome
process.env.USERPROFILE = testHome

// corepack's download cache keeps the real home's location. corepack stores
// the pnpm a `packageManager` field pins under the home directory unless
// COREPACK_HOME, XDG_CACHE_HOME or LOCALAPPDATA moves it, so under a fresh
// home every test file that ran pnpm through corepack
// (test/lint-changed.test.ts) downloaded pnpm again: about 60 MB and 18 s,
// left behind in the temp directory. The variable is set to the path corepack
// uses outside tests. A global pnpm that switches to the pinned version needs
// nothing here: it hands its child processes the switched binary on PATH and
// `npm_config_manage_package_manager_versions=false`.
const realHome = workerStart.env.HOME ?? os.userInfo().homedir
if (!process.env.COREPACK_HOME && !process.env.XDG_CACHE_HOME && !process.env.LOCALAPPDATA) {
  process.env.COREPACK_HOME = path.join(realHome, process.platform === 'win32' ? 'AppData/Local' : '.cache', 'node', 'corepack')
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = urlOf(input)
  if (url) {
    if (TELEMETRY_HOSTS.has(url.hostname)) {
      throw new Error(
        `[test] Blocked telemetry request to ${url.href}. ` +
        `Tests must mock globalThis.fetch when exercising trackEvent — see test-setup/vitest-defaults.ts.`,
      )
    }
    if (!isLocalHost(url.hostname)) {
      throw new Error(
        `[test] Blocked external network request to ${url.href}. ` +
        `Tests must not hit external services. Mock globalThis.fetch or stub the client.`,
      )
    }
  }
  return realFetch(input as Parameters<typeof realFetch>[0], init)
}) as typeof globalThis.fetch

for (const query of ['resolve4', 'resolve6'] as const) {
  const realQuery = workerStart[query].bind(dns) as (hostname: string, ...options: unknown[]) => Promise<unknown>
  Object.assign(dns, {
    [query]: async (hostname: string, ...options: unknown[]) => {
      if (!isLocalHost(hostname)) {
        throw new Error(
          `[test] Blocked external DNS lookup (${query}) of ${hostname}. ` +
          `Tests must not hit external services. Stub it with vi.spyOn(dns, '${query}').`,
        )
      }
      return await realQuery(hostname, ...options)
    },
  })
}

// `vi.doMock`, not the hoisted `vi.mock`, so the mock can depend on the
// provided script; the test file's imports run after this file.
const migratedDatabase = inject('canonryMigratedDatabase')
if (migratedDatabase) {
  vi.doMock('../packages/db/src/migrate.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../packages/db/src/migrate.js')>()
    return { ...actual, migrate: replayingMigrate(actual, migratedDatabase) }
  })
}
