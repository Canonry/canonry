import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FastifyListenOptions } from 'fastify'
import { stringify } from 'yaml'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createClient, migrate, projects, runs, type DatabaseClient } from '@ainyc/canonry-db'
import { RunKinds, RunStatuses, RunTriggers, type RunStatus, type RunTrigger } from '@ainyc/canonry-contracts'
import type { CanonryConfig } from '../src/config.js'

const native = vi.hoisted(() => {
  type Server = Awaited<ReturnType<typeof import('../src/server.js').createServer>>
  const apps: Server[] = []
  const databases: DatabaseClient[] = []
  const binds: FastifyListenOptions[] = []
  return { apps, databases, binds, assetsDir: '' }
})

vi.mock('../src/server.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/server.js')>()
  return {
    ...actual,
    createServer: async (options: Parameters<typeof actual.createServer>[0]) => {
      native.databases.push(options.db)
      const app = await actual.createServer({ ...options, logger: false, assetsDir: native.assetsDir })
      native.apps.push(app)
      const listen = app.listen.bind(app)
      type Callback = (error: Error | null, address: string) => void
      function isolatedListen(options: FastifyListenOptions, callback: Callback): void
      function isolatedListen(options?: FastifyListenOptions): Promise<string>
      function isolatedListen(callback: Callback): void
      function isolatedListen(optionsOrCallback?: FastifyListenOptions | Callback, callback?: Callback): void | Promise<string> {
        const options = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback
        native.binds.push({ ...options })
        const completion = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback
        // Keep native listen/onListen/runtime startup; reserve an ephemeral loopback socket.
        const socket = { host: '127.0.0.1', port: 0 }
        return completion ? listen(socket, completion) : listen(socket)
      }
      app.listen = isolatedListen
      return app
    },
  }
})

import { runCli } from '../src/cli.js'

const ENV_KEYS = [
  'CANONRY_PORT', 'CANONRY_HOST', 'CANONRY_BASE_PATH',
  'CANONRY_EMBED', 'CANONRY_EMBED_ORIGINS', 'CANONRY_EMBED_VIEWS', 'CANONRY_EMBED_PROJECT_TABS',
  'CANONRY_TRUST_PROXY', 'CANONRY_EXTERNAL_MCP', 'CANONRY_OPERATOR_KEY_IDS',
  'CANONRY_DASHBOARD_REQUIRE_PASSWORD', 'CANONRY_DASHBOARD_SHOW_RESOURCE_LINKS',
  'CANONRY_DASHBOARD_SHOW_UPDATE_NOTIFICATION', 'CANONRY_DASHBOARD_MANAGED_SWEEPS',
  'CANONRY_DASHBOARD_MANAGED_RUN_KINDS', 'CANONRY_ONBOARDING_MODE',
  'CANONRY_RESEARCH_ALLOW_VIEWERS', 'CANONRY_RESEARCH_VIEWER_DAILY_RUN_LIMIT',
] as const
const WARN = 'First-run dashboard password setup is unauthenticated only on loopback; complete setup from this machine first or use a bearer cnry_... key.'
const OFF = { enabled: false }
const ON = { enabled: true, projectTabs: ['overview'] }
const LIMITED = { enabled: true, views: ['overview', 'project'], projectTabs: ['overview'] }
const TABBED = { enabled: true, views: ['overview', 'project'], projectTabs: ['overview', 'technical-aeo'] }

interface SettingsRow {
  id: string
  args?: string[]
  env?: Record<string, string>
  config?: Partial<CanonryConfig>
  port: number
  host?: string
  url?: string
  prefix?: string
  embed?: typeof ON | typeof LIMITED | typeof TABBED
  csp?: string
  expectedEnv?: Record<string, string>
}
const SETTINGS: SettingsRow[] = [
  { id: 'default-json', port: 4100 },
  { id: 'default-jsonl', args: ['--format', 'jsonl'], port: 4100 },
  { id: 'inherited-port', env: { CANONRY_PORT: '4101' }, port: 4101, expectedEnv: { CANONRY_PORT: '4101' } },
  { id: 'env-before-config-port', env: { CANONRY_PORT: '4101' }, config: { port: 5000 }, port: 4101, expectedEnv: { CANONRY_PORT: '4101' } },
  { id: 'flag-before-env-port', args: ['--port', '4200'], env: { CANONRY_PORT: '4101' }, config: { port: 5000 }, port: 4200, expectedEnv: { CANONRY_PORT: '4200' } },
  { id: 'config-port', config: { port: 5000 }, port: 5000 },
  { id: 'empty-env-config-port', env: { CANONRY_PORT: '' }, config: { port: 5000 }, port: 5000, expectedEnv: { CANONRY_PORT: '' } },
  { id: 'blank-env-config-port', env: { CANONRY_PORT: '   ' }, config: { port: 5000 }, port: 5000, expectedEnv: { CANONRY_PORT: '   ' } },
  { id: 'empty-env-default-port', env: { CANONRY_PORT: '' }, port: 4100, expectedEnv: { CANONRY_PORT: '' } },
  { id: 'inherited-host-path', env: { CANONRY_HOST: '0.0.0.0', CANONRY_BASE_PATH: '/canonry' }, config: { basePath: '/configured' }, port: 4100, host: '0.0.0.0', url: 'http://127.0.0.1:4100', prefix: '/canonry', expectedEnv: { CANONRY_HOST: '0.0.0.0', CANONRY_BASE_PATH: '/canonry' } },
  { id: 'flag-before-env-host-path', args: ['--host', '127.0.0.1', '--base-path', '/x'], env: { CANONRY_HOST: '0.0.0.0', CANONRY_BASE_PATH: '/canonry' }, config: { basePath: '/configured' }, port: 4100, prefix: '/x', expectedEnv: { CANONRY_HOST: '127.0.0.1', CANONRY_BASE_PATH: '/x' } },
  { id: 'embed-flag-no-origins', args: ['--embed'], config: { embed: OFF }, port: 4100, embed: ON, csp: "frame-ancestors 'none'", expectedEnv: { CANONRY_EMBED: '1' } },
  { id: 'inherited-embed', env: { CANONRY_EMBED: '1', CANONRY_EMBED_ORIGINS: 'https://a.com,https://b.com', CANONRY_EMBED_VIEWS: 'overview,project' }, config: { embed: OFF }, port: 4100, embed: LIMITED, csp: 'frame-ancestors https://a.com https://b.com', expectedEnv: { CANONRY_EMBED: '1', CANONRY_EMBED_ORIGINS: 'https://a.com,https://b.com', CANONRY_EMBED_VIEWS: 'overview,project' } },
  { id: 'repeated-embed-flags', args: ['--embed', '--embed-allow-origin', 'https://a.com', '--embed-allow-origin', 'https://b.com', '--embed-view', 'overview', '--embed-view', 'project', '--embed-project-tab', 'overview', '--embed-project-tab', 'technical-aeo'], env: { CANONRY_EMBED: '0', CANONRY_EMBED_ORIGINS: 'https://inherited.example', CANONRY_EMBED_VIEWS: 'settings', CANONRY_EMBED_PROJECT_TABS: 'local' }, config: { embed: { enabled: false, allowOrigins: ['https://configured.example'], views: ['settings'], projectTabs: ['local'] } }, port: 4100, embed: TABBED, csp: 'frame-ancestors https://a.com https://b.com', expectedEnv: { CANONRY_EMBED: '1', CANONRY_EMBED_ORIGINS: 'https://a.com,https://b.com', CANONRY_EMBED_VIEWS: 'overview,project', CANONRY_EMBED_PROJECT_TABS: 'overview,technical-aeo' } },
  { id: 'absent-flags-preserve-config-embed', config: { embed: { enabled: true, allowOrigins: ['https://a.com', 'https://b.com'], views: ['overview', 'project'] } }, port: 4100, embed: LIMITED, csp: 'frame-ancestors https://a.com https://b.com' },
]

interface ProjectSeed { id: string; name: string; createdAt: string }
interface RunSeed { projectId: string; status: RunStatus; trigger?: RunTrigger }
interface BannerRow { id: string; projects: ProjectSeed[]; runs?: RunSeed[]; open: string }
const JAN1 = '2026-01-01T00:00:00.000Z'
const JAN2 = '2026-01-02T00:00:00.000Z'
const JAN3 = '2026-01-03T00:00:00.000Z'
const ALPHA = { id: 'p1', name: 'alpha', createdAt: JAN1 }
const BANNERS: BannerRow[] = [
  { id: 'empty', projects: [], open: 'Open http://127.0.0.1:4100/setup to map your site and run your first Page Health scan.' },
  { id: 'unscanned', projects: [{ id: 'p1', name: 'example-com', createdAt: JAN1 }], open: 'Open http://127.0.0.1:4100/setup?onboarding=site-health&setupProject=example-com to run your first Page Health scan.' },
  { id: 'completed', projects: [ALPHA], runs: [{ projectId: 'p1', status: RunStatuses.completed }], open: 'Open http://127.0.0.1:4100' },
  { id: 'partial', projects: [ALPHA], runs: [{ projectId: 'p1', status: RunStatuses.partial }], open: 'Open http://127.0.0.1:4100' },
  { id: 'probe', projects: [ALPHA], runs: [{ projectId: 'p1', status: RunStatuses.completed, trigger: RunTriggers.probe }], open: 'Open http://127.0.0.1:4100/setup?onboarding=site-health&setupProject=alpha to run your first Page Health scan.' },
  { id: 'unfinished', projects: [ALPHA], runs: [{ projectId: 'p1', status: RunStatuses.running }], open: 'Open http://127.0.0.1:4100/setup?onboarding=site-health&setupProject=alpha to run your first Page Health scan.' },
  { id: 'chronological-unscanned', projects: [{ id: 'p3', name: 'aardvark', createdAt: JAN3 }, { id: 'p2', name: 'bravo', createdAt: JAN2 }, ALPHA], runs: [{ projectId: 'p1', status: RunStatuses.completed }], open: 'Open http://127.0.0.1:4100/setup?onboarding=site-health&setupProject=bravo to run your first Page Health scan.' },
  { id: 'name-tie-unscanned', projects: [{ id: 'p2', name: 'bravo', createdAt: JAN2 }, { id: 'p1', name: 'alpha', createdAt: JAN2 }, { id: 'p3', name: 'zulu', createdAt: JAN1 }], runs: [{ projectId: 'p3', status: RunStatuses.completed }], open: 'Open http://127.0.0.1:4100/setup?onboarding=site-health&setupProject=alpha to run your first Page Health scan.' },
]
const WARNS = [
  { id: 'wildcard-ipv4', host: '0.0.0.0', url: 'http://127.0.0.1:4100', warn: true },
  { id: 'wildcard-ipv6', host: '::', url: 'http://[::1]:4100', warn: true },
  { id: 'bracketed-wildcard-ipv6', host: '[::]', url: 'http://[::1]:4100', warn: true },
  { id: 'lan-ipv4', host: '192.168.1.10', url: 'http://192.168.1.10:4100', warn: true },
  { id: 'loopback-ipv4', host: '127.0.0.1', url: 'http://127.0.0.1:4100', warn: false },
  { id: 'loopback-ipv6', host: '::1', url: 'http://[::1]:4100', warn: false },
  { id: 'localhost', host: 'localhost', url: 'http://localhost:4100', warn: false },
]

async function startNative(input: {
  args?: string[]
  env?: Record<string, string>
  config?: Partial<CanonryConfig>
  seed?: BannerRow
}) {
  native.apps.length = 0
  native.databases.length = 0
  native.binds.length = 0
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-serve-native-'))
  const oldTerm = new Set(process.listeners('SIGTERM'))
  const oldInt = new Set(process.listeners('SIGINT'))
  onTestFinished(async () => {
    try {
      for (const app of native.apps) await app.close()
    } finally {
      for (const db of native.databases) db.$client.close()
      for (const listener of process.listeners('SIGTERM')) if (!oldTerm.has(listener)) process.removeListener('SIGTERM', listener)
      for (const listener of process.listeners('SIGINT')) if (!oldInt.has(listener)) process.removeListener('SIGINT', listener)
      vi.restoreAllMocks()
      vi.unstubAllEnvs()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
  for (const key of ENV_KEYS) vi.stubEnv(key, undefined)
  vi.stubEnv('CANONRY_CONFIG_DIR', dir)
  vi.stubEnv('CANONRY_TELEMETRY_DISABLED', '1')
  vi.stubEnv('CANONRY_NO_AUTO_SKILLS_SYNC', '1')
  vi.stubEnv('CANONRY_DISABLE_UPDATE_CHECK', '1')
  vi.stubEnv('CANONRY_AGENT_DISABLED', '1')
  vi.stubEnv('CI', '1')
  for (const [key, value] of Object.entries(input.env ?? {})) vi.stubEnv(key, value)
  native.assetsDir = path.join(dir, 'assets')
  fs.mkdirSync(native.assetsDir)
  fs.writeFileSync(path.join(native.assetsDir, 'index.html'), '<!doctype html><html><head><title>fixture</title></head><body><div id="root"></div></body></html>')
  const database = path.join(dir, 'data.db')
  const config: CanonryConfig = {
    apiUrl: 'http://127.0.0.1:4100', database, apiKey: 'cnry_native_serve_fixture',
    providers: {}, telemetry: false, updateCheck: false,
    ...input.config,
  }
  fs.writeFileSync(path.join(dir, 'config.yaml'), stringify(config))
  if (input.seed) {
    const db = createClient(database)
    try {
      migrate(db)
      for (const project of input.seed.projects) db.insert(projects).values({
        ...project, displayName: project.name, canonicalDomain: `${project.name}.example`,
        country: 'US', language: 'en', updatedAt: project.createdAt,
      }).run()
      for (const [index, run] of (input.seed.runs ?? []).entries()) db.insert(runs).values({
        id: `r${index}`, projectId: run.projectId, kind: RunKinds['site-audit'],
        status: run.status, trigger: run.trigger ?? RunTriggers.manual, createdAt: JAN1,
      }).run()
    } finally { db.$client.close() }
  }
  const lines: string[] = []
  vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => { lines.push(values.map(String).join(' ')) })
  expect(await runCli(['serve', ...(input.args ?? [])])).toBe(0)
  expect(native.apps).toHaveLength(1)
  const app = native.apps[0]
  if (!app) throw new Error('Expected native server instance')
  const address = app.server.address()
  expect(address).not.toBeNull()
  if (!address || typeof address === 'string') throw new Error('Expected native TCP listener')
  return { app, lines, endpoint: `http://127.0.0.1:${address.port}` }
}

it.each(SETTINGS)('CLI serve resolves settings: $id', async row => {
  const args = row.args?.includes('--format') ? row.args : [...(row.args ?? []), '--format', 'json']
  const { lines, endpoint } = await startNative({ args, env: row.env, config: row.config })
  const host = row.host ?? '127.0.0.1'
  const url = row.url ?? `http://127.0.0.1:${row.port}`
  expect(native.binds).toEqual([{ host, port: row.port }])
  expect(lines).toHaveLength(1)
  const receipt: unknown = JSON.parse(lines[0] ?? '')
  expect(receipt).toEqual({ started: true, host, port: row.port, url })
  for (const key of ENV_KEYS.slice(0, 7)) expect(process.env[key]).toBe(row.expectedEnv?.[key])

  const prefix = row.prefix ?? ''
  const health = await fetch(`${endpoint}${prefix}/health`)
  expect(health.status).toBe(200)
  const healthBody: unknown = await health.json()
  expect(healthBody).toMatchObject({ status: 'ok', service: 'canonry' })
  if (row.prefix) expect(healthBody).toHaveProperty('basePath', row.prefix)
  else expect(healthBody).not.toHaveProperty('basePath')
  const api = await fetch(`${endpoint}${prefix}/api/v1/openapi.json`)
  expect(api.status).toBe(200)
  await api.text()
  if (row.prefix) {
    const unprefixed = await fetch(`${endpoint}/api/v1/openapi.json`)
    expect(unprefixed.status).toBe(404)
    await unprefixed.text()
  }
  const document = await fetch(`${endpoint}${prefix}/`)
  expect(document.status).toBe(200)
  expect(document.headers.get('content-security-policy')).toBe(row.csp ?? null)
  const html = await document.text()
  expect(html).toContain(`<base href="${prefix}/">`)
  const script = html.match(/<script>window\.__CANONRY_CONFIG__=(.*?)<\/script>/)?.[1]
  expect(script).toBeDefined()
  if (script === undefined) throw new Error('Expected native client configuration')
  const browserConfig: unknown = JSON.parse(script)
  if (row.prefix) expect(browserConfig).toHaveProperty('basePath', `${row.prefix}/`)
  else expect(browserConfig).not.toHaveProperty('basePath')
  if (row.embed) expect(browserConfig).toHaveProperty('embed', row.embed)
  else expect(browserConfig).not.toHaveProperty('embed')
}, 20_000)

it.each(BANNERS)('CLI serve reads persisted onboarding state: $id', async row => {
  const { lines, endpoint } = await startNative({ seed: row })
  expect(native.binds).toEqual([{ host: '127.0.0.1', port: 4100 }])
  expect(lines).toEqual(['\nCanonry server running at http://127.0.0.1:4100', row.open, 'Press Ctrl+C to stop.\n'])
  const health = await fetch(`${endpoint}/health`)
  expect(health.status).toBe(200)
  await health.text()
}, 20_000)

it.each(WARNS)('CLI serve reports bind setup guidance: $id', async row => {
  const { lines } = await startNative({ args: ['--host', row.host] })
  expect(native.binds).toEqual([{ host: row.host, port: 4100 }])
  expect(lines).toEqual([
    `\nCanonry server running at ${row.url}`,
    `Open ${row.url}/setup to map your site and run your first Page Health scan.`,
    ...(row.warn ? [WARN] : []),
    'Press Ctrl+C to stop.\n',
  ])
}, 20_000)
