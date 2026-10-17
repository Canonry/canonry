import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REGISTERED_CLI_COMMANDS } from '../src/cli-commands.js'
import { runCli } from '../src/cli.js'
import * as telemetry from '../src/telemetry.js'
import * as updates from '../src/update-check.js'
import * as skills from '../src/skills-autosync.js'
import * as clients from '../src/client.js'

const logs: string[] = []
const errors: string[] = []
beforeEach(() => {
  logs.length = 0
  errors.length = 0
  vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')) })
  vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args.join(' ')) })
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { logs.push(String(chunk).trimEnd()); return true })
  vi.spyOn(telemetry, 'isTelemetryEnabled').mockReturnValue(true)
  vi.spyOn(telemetry, 'isFirstRun').mockReturnValue(false)
  vi.spyOn(telemetry, 'trackEvent').mockImplementation(() => {})
  vi.spyOn(telemetry, 'trackCliCommandFinished').mockImplementation(() => {})
  vi.spyOn(telemetry, 'detectAndTrackUpgrade').mockImplementation(() => {})
  vi.spyOn(updates, 'readCachedUpdateAvailable').mockReturnValue(null)
  vi.spyOn(updates, 'checkLatestVersionForCli').mockResolvedValue(null)
  vi.spyOn(skills, 'autoSyncSkills').mockResolvedValue({ ran: false, reason: 'skipped', updated: [], conflicts: [], targets: [] })
  vi.spyOn(clients, 'createApiClient').mockImplementation(() => { throw new Error('Help must not connect to a server') })
})
afterEach(() => vi.restoreAllMocks())

async function invoke(args: string[]) {
  logs.length = 0
  errors.length = 0
  const code = await runCli(args)
  return { code, stdout: logs.join('\n'), stderr: errors.join('\n') }
}

describe('generated CLI help', () => {
  it('lists every registered root, including alias groups, in top-level text', async () => {
    const result = await invoke(['--help'])
    expect(result.code).toBe(0)
    for (const root of new Set(REGISTERED_CLI_COMMANDS.map(spec => spec.path[0]!))) {
      expect(result.stdout, root).toMatch(new RegExp(`^  ${root}(?: |$)`, 'm'))
    }
    for (const section of ['Setup', 'Page Health', 'Projects', 'Monitoring', 'Config-as-Code', 'Integrations', 'Automation', 'Admin']) expect(result.stdout).toContain(`${section}:`)
  })

  it('returns one complete catalog for help and --help', async () => {
    const direct = await invoke(['help', '--format', 'json'])
    expect(direct.code, direct.stderr).toBe(0)
    const catalog = JSON.parse(direct.stdout)
    expect(catalog.groups).toHaveLength(new Set(REGISTERED_CLI_COMMANDS.map(spec => spec.path[0])).size)
    expect(catalog.groups.flatMap((group: { commands: unknown[] }) => group.commands)).toHaveLength(REGISTERED_CLI_COMMANDS.length)
    expect(await invoke(['--help', '--format', 'json'])).toEqual(direct)
    expect(await invoke(['--help', '--format=json'])).toEqual(direct)
  })

  it('filters a group and emits self-contained JSONL commands', async () => {
    const direct = await invoke(['help', 'ga', '--format', 'json'])
    expect(direct.code, direct.stderr).toBe(0)
    expect(await invoke(['ga', '--help', '--format', 'json'])).toEqual(direct)
    const jsonl = await invoke(['help', 'ga', '--format', 'jsonl'])
    expect(jsonl.code, jsonl.stderr).toBe(0)
    const rows = jsonl.stdout.split('\n').map(line => JSON.parse(line))
    expect(rows).toHaveLength(REGISTERED_CLI_COMMANDS.filter(spec => spec.path[0] === 'ga').length)
    for (const row of rows) expect(row).toMatchObject({ root: 'ga', id: expect.any(String), usage: expect.any(String) })
  })

  it('returns a structured usage error for unknown groups', async () => {
    const result = await invoke(['help', 'nosuch', '--format', 'json'])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr).error).toMatchObject({ code: 'CLI_USAGE_ERROR', message: expect.stringContaining('nosuch') })
  })

  it.each([['help'], ['help', 'ga'], ['--help'], ['ga', '--help']])('has no telemetry, update checks, skill sync or API calls for %j', async (...args) => {
    expect((await invoke(args)).code).toBe(0)
    expect(telemetry.trackEvent).not.toHaveBeenCalled()
    expect(telemetry.trackCliCommandFinished).not.toHaveBeenCalled()
    expect(updates.readCachedUpdateAvailable).not.toHaveBeenCalled()
    expect(updates.checkLatestVersionForCli).not.toHaveBeenCalled()
    expect(skills.autoSyncSkills).not.toHaveBeenCalled()
    expect(clients.createApiClient).not.toHaveBeenCalled()
  })
})

// The table is deliberate prose; the registry is the executable source of truth.
describe('CLI catalog drift guard', () => {
  it('covers every root and command exactly once, with no phantom summaries', async () => {
    const { buildCliCatalog, CLI_ROOT_SUMMARIES, renderTopLevelHelp } = await import('../src/cli-catalog.js')
    const { cliCatalogSchema } = await import('@canonry/canonry-contracts')
    const roots = [...new Set(REGISTERED_CLI_COMMANDS.map(spec => spec.path[0]!))].sort()
    expect(Object.keys(CLI_ROOT_SUMMARIES).sort()).toEqual(roots)
    const catalog = cliCatalogSchema.parse(buildCliCatalog(REGISTERED_CLI_COMMANDS))
    const ids = catalog.groups.flatMap(group => group.commands.map(command => command.id))
    expect(new Set(ids).size).toBe(REGISTERED_CLI_COMMANDS.length)
    expect(ids.sort()).toEqual(REGISTERED_CLI_COMMANDS.map(spec => spec.path.join('.')).sort())
    for (const root of roots) expect(renderTopLevelHelp(catalog)).toMatch(new RegExp(`^  ${root}(?: |$)`, 'm'))
    expect(() => buildCliCatalog([{ path: ['unlisted-root'], usage: 'canonry unlisted-root', run: () => {} }])).toThrow('Missing CLI root summary: unlisted-root')
  })

  it('includes effective flags and window choices without guessing from usage text', async () => {
    const { buildCliCatalog } = await import('../src/cli-catalog.js')
    const catalog = buildCliCatalog(REGISTERED_CLI_COMMANDS)
    const commands = catalog.groups.flatMap(group => group.commands)
    const search = commands.find(command => command.id === 'ga.search-landing-pages')!
    expect(search.windows).toEqual(['7d', '28d', '90d'])
    expect(search.usage).toContain('--window 7d|28d|90d')
    expect(search.options).toContainEqual({ name: 'window', type: 'string', multiple: false })
    const traffic = commands.find(command => command.id === 'traffic.analytics')!
    expect(traffic.options).toEqual(expect.arrayContaining([
      { name: 'window', type: 'string', multiple: false },
      { name: 'period', type: 'string', multiple: false },
    ]))
    for (const spec of REGISTERED_CLI_COMMANDS) {
      expect(commands.find(command => command.id === spec.path.join('.'))?.supportsDryRun).toBe(spec.supportsDryRun ?? false)
    }
  })
})
