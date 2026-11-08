import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cliCatalogSchema } from '@canonry/canonry-contracts'
import * as clients from '../src/client.js'
import { buildCliCatalog } from '../src/cli-catalog.js'
import { REGISTERED_CLI_COMMANDS } from '../src/cli-commands.js'
import { dispatchRegisteredCommand } from '../src/cli-dispatch.js'
import { CliError, EXIT_SYSTEM_ERROR, type CliFormat } from '../src/cli-error.js'

// The published contract: canonical `agent-readiness` commands and their access.
const CANONICAL_ACCESS: Record<string, 'stored' | 'write'> = {
  'agent-readiness score': 'stored',
  'agent-readiness page-scores': 'stored',
  'agent-readiness trend': 'stored',
  'agent-readiness run': 'write',
  'agent-readiness progress': 'stored',
  'agent-readiness overview': 'stored',
  'agent-readiness pages': 'stored',
  'agent-readiness page-audit': 'stored',
  'agent-readiness issues': 'stored',
  'agent-readiness issue-pages': 'stored',
  'agent-readiness structure': 'stored',
  'agent-readiness links': 'stored',
  'agent-readiness neighbors': 'stored',
  'agent-readiness dead-links': 'stored',
  'agent-readiness subgraph': 'stored',
  'agent-readiness path': 'stored',
  'agent-readiness changes': 'stored',
}

// Every deprecated name and the canonical command it must keep running.
const DEPRECATED_NAMES: ReadonlyArray<readonly [deprecated: string, canonical: string]> = [
  ['technical-aeo score', 'agent-readiness score'],
  ['technical-aeo pages', 'agent-readiness page-scores'],
  ['technical-aeo trend', 'agent-readiness trend'],
  ['technical-aeo run', 'agent-readiness run'],
  ['technical-aeo progress', 'agent-readiness progress'],
  ['technical-aeo crawl', 'agent-readiness overview'],
  ['technical-aeo crawl-pages', 'agent-readiness pages'],
  ['technical-aeo page-audit', 'agent-readiness page-audit'],
  ['technical-aeo issues', 'agent-readiness issues'],
  ['technical-aeo issue-pages', 'agent-readiness issue-pages'],
  ['technical-aeo structure', 'agent-readiness structure'],
  ['technical-aeo links', 'agent-readiness links'],
  ['technical-aeo links neighbors', 'agent-readiness neighbors'],
  ['technical-aeo dead-links', 'agent-readiness dead-links'],
  ['technical-aeo subgraph', 'agent-readiness subgraph'],
  ['technical-aeo path', 'agent-readiness path'],
  ['technical-aeo changes', 'agent-readiness changes'],
  ['site-health overview', 'agent-readiness overview'],
  ['site-health pages', 'agent-readiness pages'],
  ['site-health page-audit', 'agent-readiness page-audit'],
  ['site-health issues', 'agent-readiness issues'],
  ['site-health issue-pages', 'agent-readiness issue-pages'],
  ['site-health structure', 'agent-readiness structure'],
  ['site-health links', 'agent-readiness links'],
  ['site-health neighbors', 'agent-readiness neighbors'],
  ['site-health dead-links', 'agent-readiness dead-links'],
  ['site-health subgraph', 'agent-readiness subgraph'],
  ['site-health path', 'agent-readiness path'],
  ['site-health changes', 'agent-readiness changes'],
]

const registered = new Map(REGISTERED_CLI_COMMANDS.map(spec => [spec.path.join(' '), spec]))

const SCORE = {
  project: 'acme', hasData: true, runId: 'run-1', runStatus: 'completed',
  sitemapUrl: 'https://acme.test/sitemap.xml', auditedAt: '2026-09-20T12:00:00.000Z',
  aggregateScore: 72, pagesDiscovered: 3, pagesAudited: 2, pagesSkipped: 1, pagesErrored: 0,
  deltaScore: 4, trend: null, previousScore: 68, previousAuditedAt: '2026-09-13T12:00:00.000Z',
  factors: [], crossCuttingIssues: [], prioritizedFixes: ['Add an llms.txt file'],
}

const client = {
  getTechnicalAeoScore: vi.fn(),
  triggerSiteAudit: vi.fn(),
  getTechnicalAeoCrawl: vi.fn(),
}

beforeEach(() => {
  vi.spyOn(clients, 'createApiClient').mockReturnValue(client as unknown as ReturnType<typeof clients.createApiClient>)
})
afterEach(() => {
  vi.restoreAllMocks()
  for (const fn of Object.values(client)) fn.mockReset()
  delete process.env.CANONRY_STORED_ONLY
})

/** Everything one invocation printed, or the error it ended with. */
async function invoke(args: string[], format: CliFormat): Promise<{ output: string; error?: unknown }> {
  const lines: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => { lines.push(values.map(String).join(' ')) })
  try {
    await dispatchRegisteredCommand(args, format, REGISTERED_CLI_COMMANDS)
    return { output: lines.join('\n') }
  } catch (error) {
    return { output: lines.join('\n'), error }
  } finally {
    log.mockRestore()
  }
}

describe('canonical agent-readiness commands', () => {
  it('registers every canonical command with its access level', () => {
    const family = REGISTERED_CLI_COMMANDS.filter(spec => spec.path[0] === 'agent-readiness').map(spec => spec.path.join(' '))
    expect(family.sort()).toEqual(Object.keys(CANONICAL_ACCESS).sort())
    for (const [path, access] of Object.entries(CANONICAL_ACCESS)) {
      const spec = registered.get(path)!
      expect(spec.access, path).toBe(access)
      expect(spec.deprecatedAliasOf, path).toBeUndefined()
      expect(spec.usage.startsWith(`canonry ${path} <project>`), spec.usage).toBe(true)
    }
  })

  it('keeps every deprecated technical-aeo and site-health name on the canonical implementation', () => {
    const deprecated = REGISTERED_CLI_COMMANDS.filter(spec => spec.path[0] === 'technical-aeo' || spec.path[0] === 'site-health')
    expect(deprecated.map(spec => spec.path.join(' ')).sort()).toEqual(DEPRECATED_NAMES.map(([name]) => name).sort())
    for (const [name, canonicalPath] of DEPRECATED_NAMES) {
      const alias = registered.get(name)!
      const canonical = registered.get(canonicalPath)!
      expect(alias.deprecatedAliasOf?.join(' '), name).toBe(canonicalPath)
      expect(alias.access, name).toBe(canonical.access)
      // The same option table object: no flag can drift between the two names.
      expect(alias.options, name).toBe(canonical.options)
      expect(alias.help, name).toBe(canonical.help)
      // The usage line differs only in the command name the caller typed.
      expect(alias.usage, name).toBe(`canonry ${name}${canonical.usage.slice(`canonry ${canonicalPath}`.length)}`)
    }
    expect(registered.get('technical-aeo crawl')!.usage).toBe('canonry technical-aeo crawl <project> [--run-id <id> | --date YYYY-MM-DD] [--format json]')
    expect(registered.get('site-health neighbors')!.usage).toBe('canonry site-health neighbors <project> (--node-key <key>|--url <url>) [--run-id <id>] [--limit <n>] [--format json]')
  })
})

describe('deprecated names run the canonical command', () => {
  it('prints the same score, as JSON and as text, under both names', async () => {
    client.getTechnicalAeoScore.mockResolvedValue(SCORE)
    for (const format of ['json', 'text'] as const) {
      const canonical = await invoke(['agent-readiness', 'score', 'acme'], format)
      const deprecated = await invoke(['technical-aeo', 'score', 'acme'], format)
      expect(canonical.error).toBeUndefined()
      expect(deprecated).toEqual(canonical)
      if (format === 'json') expect(JSON.parse(canonical.output)).toEqual(SCORE)
      else expect(canonical.output.split('\n')[0]).toBe('Agent Readiness: 72/100 (+4 vs prev)')
    }
    expect(client.getTechnicalAeoScore.mock.calls).toEqual(Array.from({ length: 4 }, () => ['acme', { runId: undefined }]))

    client.getTechnicalAeoScore.mockResolvedValue({ ...SCORE, hasData: false })
    const empty = await invoke(['technical-aeo', 'score', 'acme'], 'text')
    expect(empty).toEqual(await invoke(['agent-readiness', 'score', 'acme'], 'text'))
    expect(empty.output).toBe('No Agent Readiness scan yet for "acme". Run `canonry agent-readiness run acme` to start one.')
  })

  it('starts the same scan with the same request and output under both names', async () => {
    client.triggerSiteAudit.mockResolvedValue({ runId: 'run-9', status: 'queued' })
    const flags = ['acme', '--max-pages', '25', '--check-dead-links', '--no-agent-skills']
    for (const format of ['json', 'text'] as const) {
      const canonical = await invoke(['agent-readiness', 'run', ...flags], format)
      const deprecated = await invoke(['technical-aeo', 'run', ...flags], format)
      expect(canonical.error).toBeUndefined()
      expect(deprecated).toEqual(canonical)
    }
    expect((await invoke(['agent-readiness', 'run', ...flags], 'text')).output)
      .toBe('Agent Readiness scan started (run run-9, status queued). Use `canonry agent-readiness progress acme --run-id run-9` to check status, or pass --wait.')
    const request = {
      sitemapUrl: undefined, limit: undefined, maxPages: 25, maxEdges: undefined, maxDepth: undefined,
      checkDeadLinks: true, includeGeo: false, includeAgentSkills: false,
    }
    expect(client.triggerSiteAudit.mock.calls).toEqual(Array.from({ length: 5 }, () => ['acme', request]))
  })

  it('reads the crawl overview as stored data under all three names', async () => {
    const overview = { project: 'acme', hasCrawlData: false, legacyAuditAvailable: false, runId: null }
    client.getTechnicalAeoCrawl.mockResolvedValue(overview)
    const outputs = []
    for (const args of [['agent-readiness', 'overview'], ['technical-aeo', 'crawl'], ['site-health', 'overview']]) {
      const result = await invoke([...args, 'acme', '--date', '2026-09-26', '--stored-only'], 'json')
      expect(result.error, args.join(' ')).toBeUndefined()
      outputs.push(result.output)
    }
    expect(new Set(outputs).size).toBe(1)
    expect(JSON.parse(outputs[0]!)).toEqual(overview)
    expect(client.getTechnicalAeoCrawl.mock.calls).toEqual(Array.from({ length: 3 }, () => ['acme', { runId: undefined, date: '2026-09-26' }]))
  })

  it('passes a failed read through unchanged, so the exit code is the same', async () => {
    const failure = new CliError({ code: 'API_ERROR', message: 'Server unavailable', exitCode: EXIT_SYSTEM_ERROR })
    client.getTechnicalAeoCrawl.mockRejectedValue(failure)
    for (const args of [['agent-readiness', 'overview'], ['technical-aeo', 'crawl'], ['site-health', 'overview']]) {
      expect((await invoke([...args, 'acme'], 'json')).error, args.join(' ')).toBe(failure)
    }
  })

  it('names the usage line the caller typed in a usage error, and otherwise reports the same error', async () => {
    const canonical = (await invoke(['agent-readiness', 'progress', 'acme'], 'json')).error as CliError
    const deprecated = (await invoke(['technical-aeo', 'progress', 'acme'], 'json')).error as CliError
    expect(canonical).toMatchObject({
      code: 'CLI_USAGE_ERROR', message: '--run-id is required', exitCode: 1,
      displayMessage: 'Error: --run-id is required\nUsage: canonry agent-readiness progress <project> --run-id <id> [--format json]',
      details: { command: 'agent-readiness.progress', usage: 'canonry agent-readiness progress <project> --run-id <id> [--format json]' },
    })
    expect(deprecated).toMatchObject({
      code: canonical.code, message: canonical.message, exitCode: canonical.exitCode,
      displayMessage: 'Error: --run-id is required\nUsage: canonry technical-aeo progress <project> --run-id <id> [--format json]',
      details: { command: 'technical-aeo.progress', usage: 'canonry technical-aeo progress <project> --run-id <id> [--format json]' },
    })

    const neighbors = (await invoke(['site-health', 'neighbors', 'acme'], 'json')).error as CliError
    expect(neighbors).toMatchObject({
      code: 'CLI_USAGE_ERROR', message: '--node-key or --url is required', exitCode: 1,
      displayMessage: 'Error: --node-key or --url is required\nUsage: canonry site-health neighbors <project> (--node-key <key>|--url <url>) [--run-id <id>] [--limit <n>] [--format json]',
      details: { command: 'site-health.neighbors' },
    })

    // An unknown flag is rejected by the dispatcher with the deprecated name's own usage too.
    const unknownFlag = (await invoke(['technical-aeo', 'crawl', 'acme', '--bogus'], 'json')).error as CliError
    expect(unknownFlag).toMatchObject({ code: 'CLI_USAGE_ERROR', details: { command: 'technical-aeo.crawl' } })
    expect(unknownFlag.displayMessage).toContain('\nUsage: canonry technical-aeo crawl <project> [--run-id <id> | --date YYYY-MM-DD] [--format json]')
    expect(client.getTechnicalAeoCrawl).not.toHaveBeenCalled()
  })
})

describe('deprecated names in help and the catalog', () => {
  it('points a deprecated command at its canonical command in --help', async () => {
    const help = await invoke(['technical-aeo', 'crawl', '--help'], 'text')
    expect(help.output).toContain('Usage:  canonry technical-aeo crawl <project> [--run-id <id> | --date YYYY-MM-DD] [--format json]')
    expect(help.output).toContain('Deprecated: use canonry agent-readiness overview. This name still works, with the same flags, output and exit codes.')
    const canonical = await invoke(['agent-readiness', 'overview', '--help'], 'text')
    expect(canonical.output).toContain('Usage:  canonry agent-readiness overview <project>')
    expect(canonical.output).not.toContain('Deprecated')
  })

  it('names the replacement of every command in a deprecated group', async () => {
    const lines = (await invoke(['site-health'], 'text')).output.split('\n')
    expect(lines).toContain('Deprecated: use canonry agent-readiness. These names still work, with the same flags, output and exit codes.')
    const overview = lines.findIndex(line => line.startsWith('  [stored] canonry site-health overview <project>'))
    expect(lines[overview + 1]).toBe('      use: canonry agent-readiness overview')
    const neighbors = lines.findIndex(line => line.startsWith('  [stored] canonry site-health neighbors <project>'))
    expect(lines[neighbors + 1]).toBe('      use: canonry agent-readiness neighbors')
    expect((await invoke(['agent-readiness'], 'text')).output).not.toContain('Deprecated')
  })

  it('files the deprecated groups apart in the catalog without changing its contract', () => {
    const catalog = cliCatalogSchema.parse(buildCliCatalog(REGISTERED_CLI_COMMANDS))
    const group = (root: string) => catalog.groups.find(entry => entry.root === root)!
    expect(group('agent-readiness')).toMatchObject({ section: 'Agent Readiness' })
    for (const root of ['technical-aeo', 'site-health']) {
      expect(group(root).section).toBe('Deprecated aliases')
      expect(group(root).summary).toMatch(/^Deprecated name for agent-readiness/)
    }
    const commands = new Map(catalog.groups.flatMap(entry => entry.commands).map(command => [command.path.join(' '), command]))
    for (const [name, canonical] of DEPRECATED_NAMES) {
      expect(commands.get(name)?.access, name).toBe(commands.get(canonical)?.access)
      expect(commands.get(name)?.options, name).toEqual(commands.get(canonical)?.options)
    }
  })
})
