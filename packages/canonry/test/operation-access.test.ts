import { describe, expect, it, vi } from 'vitest'
import { REGISTERED_CLI_COMMANDS } from '../src/cli-commands.js'
import { buildCliCatalog } from '../src/cli-catalog.js'
import { toolOperationAccess, canonryMcpTools } from '../src/mcp/tool-registry.js'
import { dispatchRegisteredCommand } from '../src/cli-dispatch.js'
import { cliAccessClassificationIds, resolveCliAccess } from '../src/cli-access.js'
import { operationAccess } from '@ainyc/canonry-contracts'

describe('CLI and MCP operation access metadata', () => {
  it('declares access for every CLI command and classifies representative commands', () => {
    expect(REGISTERED_CLI_COMMANDS.every(command => command.access)).toBe(true)
    expect(REGISTERED_CLI_COMMANDS.find(command => command.path.join('.') === 'google.properties')?.access).toBe('live')
    expect(REGISTERED_CLI_COMMANDS.find(command => command.path.join('.') === 'competitor.list')?.access).toBe('stored')
    expect(REGISTERED_CLI_COMMANDS.find(command => command.path.join('.') === 'competitor.add')?.access).toBe('write')
    expect(REGISTERED_CLI_COMMANDS.find(command => command.path.join('.') === 'schedule.set')?.access).toBe('write')
    expect(REGISTERED_CLI_COMMANDS.find(command => command.path.join('.') === 'traffic.sync')?.access).toBe('write')
    expect(REGISTERED_CLI_COMMANDS.find(command => command.path.join('.') === 'ga.acquisition')?.access).toBe('stored')
    expect(REGISTERED_CLI_COMMANDS.find(command => command.path.join('.') === 'agent.memory.set')?.access).toBe('write')
    expect(REGISTERED_CLI_COMMANDS.find(command => command.path.join('.') === 'dashboard.reset-password')?.access).toBe('write')
    expect(REGISTERED_CLI_COMMANDS.find(command => command.path.join('.') === 'demo')?.access).toBe('write')
    expect(REGISTERED_CLI_COMMANDS.find(command => command.path.join('.') === 'run.list')?.access).toBe('stored')
    expect(REGISTERED_CLI_COMMANDS.find(command => command.path.join('.') === 'run.show')?.access).toBe('stored')
    expect(REGISTERED_CLI_COMMANDS.find(command => command.path.join('.') === 'google.set-property')?.access).toBe('write')
    expect(REGISTERED_CLI_COMMANDS.find(command => command.path.join('.') === 'google.submit-sitemap')?.access).toBe('write')
    expect(REGISTERED_CLI_COMMANDS.find(command => command.path.join('.') === 'feedback')?.access).toBe('write')
    expect(REGISTERED_CLI_COMMANDS.find(command => command.path.join('.') === 'settings.provider')?.access).toBe('write')
    expect(REGISTERED_CLI_COMMANDS.find(command => command.path.join('.') === 'settings')?.access).toBe('stored')
    expect(REGISTERED_CLI_COMMANDS.find(command => command.path.join('.') === 'get')?.access).toBe('stored')
    expect(REGISTERED_CLI_COMMANDS.find(command => command.path.join('.') === 'competitor.aliases')?.access).toBe('stored')
    expect(REGISTERED_CLI_COMMANDS.find(command => command.path.join('.') === 'mcp.install')?.supportsDryRun).toBe(true)
    const catalog = buildCliCatalog(REGISTERED_CLI_COMMANDS)
    expect(catalog.groups.flatMap(group => group.commands).every(command => command.access)).toBe(true)
  })

  it('matches MCP open-world annotations to derived live reads', () => {
    for (const tool of canonryMcpTools) {
      const derived = toolOperationAccess(tool)
      if (tool.access === 'read') expect(Boolean(tool.annotations.openWorldHint)).toBe(derived === 'live')
      if (tool.access === 'write') expect(derived).toBe('write')
    }
    expect(toolOperationAccess(canonryMcpTools.find(tool => tool.name === 'canonry_ga_properties')!)).toBe('live')
    const applyPreview = canonryMcpTools.find(tool => tool.name === 'canonry_apply_config_preview')!
    expect(toolOperationAccess(applyPreview)).toBe('live')
    expect(applyPreview.annotations.openWorldHint).toBe(true)
    const bingCoverage = canonryMcpTools.find(tool => tool.name === 'canonry_bing_coverage')!
    expect(bingCoverage.access).toBe('write')
    expect(Boolean(bingCoverage.annotations.openWorldHint)).toBe(false)
    for (const name of ['canonry_gbp_locations_discover', 'canonry_gbp_sync', 'canonry_ads_sync']) {
      expect(canonryMcpTools.find(tool => tool.name === name)?.annotations.openWorldHint, name).toBe(true)
    }
  })

  it('shows access in contextual help while leaving catalog command output typed', async () => {
    const output: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => output.push(args.join(' '))
    try {
      await dispatchRegisteredCommand(['google', 'properties', '--help'], 'text', REGISTERED_CLI_COMMANDS)
    } finally {
      console.log = original
    }
    expect(output.join('\n')).toContain('Access: live (calls a provider now)')
    expect(output.join('\n')).toContain('canonry google properties')
  })

  it('labels the parent command in group help', async () => {
    const output: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => output.push(args.join(' '))
    try {
      await dispatchRegisteredCommand(['run', '--help'], 'text', REGISTERED_CLI_COMMANDS)
    } finally {
      console.log = original
    }
    expect(output.join('\n')).toContain('[write] canonry run <project|--all>')
  })

  it('applies access filters to text, JSON, and --help catalog requests', async () => {
    const output: string[] = []
    const original = console.log
    const stdoutWrite = process.stdout.write
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    }) as typeof process.stdout.write
    console.log = (...args: unknown[]) => output.push(args.join(' '))
    try {
      await dispatchRegisteredCommand(['help', 'ga', '--access', 'live'], 'text', REGISTERED_CLI_COMMANDS)
      expect(output.join('\n')).toContain('[live] canonry ga properties')
      expect(output.join('\n')).not.toContain('[stored]')
      output.length = 0
      await dispatchRegisteredCommand(['ga', '--help', '--access', 'live'], 'jsonl', REGISTERED_CLI_COMMANDS)
    } finally {
      console.log = original
      process.stdout.write = stdoutWrite
    }
    const lines = output.filter(Boolean).map(line => JSON.parse(line) as { access: string; root: string })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ root: 'ga', access: 'live' })
  })

  it('keeps a known empty access-filtered group valid', async () => {
    const output: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => output.push(args.join(' '))
    try {
      await dispatchRegisteredCommand(['help', 'overview', '--access', 'write'], 'json', REGISTERED_CLI_COMMANDS)
    } finally {
      console.log = original
    }
    const catalog = JSON.parse(output.join('')) as { groups: Array<{ root: string; commands: unknown[] }> }
    expect(catalog.groups).toEqual([{ root: 'overview', section: 'Monitoring', summary: 'Show the stored project overview', commands: [] }])
  })

  it('filters top-level --help and rejects --access on normal commands', async () => {
    const output: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => output.push(args.join(' '))
    try {
      await dispatchRegisteredCommand(['help', '--access', 'live'], 'jsonl', REGISTERED_CLI_COMMANDS)
      expect(output.every(line => JSON.parse(line).access === 'live')).toBe(true)
    } finally {
      console.log = original
    }
    await expect(dispatchRegisteredCommand(['ga', 'acquisition', 'demo', '--access', 'live'], 'json', REGISTERED_CLI_COMMANDS)).rejects.toMatchObject({ code: 'CLI_USAGE_ERROR' })
  })

  it('offers group usage for registered roots without a parent spec', async () => {
    const output: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => output.push(args.join(' '))
    try {
      await dispatchRegisteredCommand(['ads'], 'text', REGISTERED_CLI_COMMANDS)
    } finally {
      console.log = original
    }
    expect(output.join('\n')).toContain('canonry ads <command>')
  })

  it('resolves stored-only access from the invocation rather than the default write', async () => {
    const run = vi.fn()
    const spec = {
      path: ['preview-write'], usage: 'canonry preview-write [--dry-run]', access: 'write' as const,
      supportsDryRun: true,
      accessFor: ({ dryRun }: { dryRun: boolean }) => dryRun ? 'stored' as const : 'write' as const,
      run,
    }
    await dispatchRegisteredCommand(['preview-write', '--dry-run', '--stored-only'], 'json', [spec])
    expect(run).toHaveBeenCalledOnce()
    await expect(dispatchRegisteredCommand(['preview-write', '--stored-only'], 'json', [spec])).rejects.toMatchObject({ code: 'STORED_ONLY_REFUSED' })
    expect(run).toHaveBeenCalledOnce()
  })

  it('keeps competitor previews stored while preserving write variants', () => {
    const aliases = REGISTERED_CLI_COMMANDS.find(command => command.path.join('.') === 'competitor.aliases')!
    const detect = REGISTERED_CLI_COMMANDS.find(command => command.path.join('.') === 'competitor.aliases.detect')!
    expect(aliases.accessFor?.({ positionals: ['project', 'example.test'], values: {}, dryRun: false })).toBe('stored')
    expect(aliases.accessFor?.({ positionals: ['project', 'example.test'], values: { set: ['Name'] }, dryRun: false })).toBe('write')
    expect(aliases.accessFor?.({ positionals: ['project', 'example.test'], values: { set: ['Name'] }, dryRun: true })).toBe('stored')
    expect(detect.accessFor?.({ positionals: ['project'], values: {}, dryRun: false })).toBe('stored')
    expect(detect.accessFor?.({ positionals: ['project'], values: { apply: true }, dryRun: false })).toBe('write')
  })

  it('exhaustively classifies every registered command without a stored fallback', () => {
    const registered = REGISTERED_CLI_COMMANDS.map(command => command.path.join('.')).sort()
    expect(cliAccessClassificationIds().sort()).toEqual(registered)
    expect(resolveCliAccess({ path: ['schedule', 'set'], usage: 'x', run: () => undefined })).toBe('write')
    expect(resolveCliAccess({ path: ['ga', 'acquisition'], usage: 'x', run: () => undefined })).toBe('stored')
    expect(resolveCliAccess({ path: ['traffic', 'sync'], usage: 'x', run: () => undefined })).toBe('write')
    expect(() => resolveCliAccess({ path: ['new', 'unclassified'], usage: 'x', run: () => undefined })).toThrow('Missing CLI operation access classification')
  })

  it('classifies added route boundaries by actual effect', () => {
    expect(operationAccess('POST', '/api/v1/apply/preview')).toBe('live')
    expect(operationAccess('POST', '/api/v1/projects/{name}/competitor-changes/preview')).toBe('stored')
    expect(operationAccess('POST', '/api/v1/projects/{name}/queries/replace-preview')).toBe('stored')
    expect(operationAccess('GET', '/api/v1/projects/{name}/competitor-suggestions')).toBe('stored')
    expect(operationAccess('PATCH', '/api/v1/projects/{name}')).toBe('write')
    expect(operationAccess('GET', '/api/v1/doctor')).toBe('live')
    expect(operationAccess('POST', '/api/v1/projects/{name}/measurement-discovery')).toBe('live')
    expect(operationAccess('GET', '/api/v1/projects/{name}/discover/sessions/{id}/harvest')).toBe('live')
    expect(operationAccess('GET', '/api/v1/cdp/status')).toBe('live')
    expect(operationAccess('GET', '/api/v1/projects/{name}/bing/performance')).toBe('live')
    expect(operationAccess('GET', '/api/v1/projects/{name}/bing/coverage')).toBe('write')
    expect(operationAccess('GET', '/api/v1/projects/{name}/results/export')).toBe('stored')
    expect(operationAccess('GET', '/api/v1/google/callback')).toBe('write')
    expect(operationAccess('GET', '/api/v1/projects/{name}/google/callback')).toBe('write')
    expect(operationAccess('GET', '/api/v1/google-marketing/callback')).toBe('write')
  })

  it('covers the known stored GET catalog while keeping unknown GETs live', () => {
    const knownStoredGets = [
      '/api/v1/openapi.json',
      '/api/v1/screenshots/{snapshotId}',
      '/api/v1/projects/{name}/technical-aeo/runs/{runId}/page-health-preview',
    ]
    for (const path of knownStoredGets) expect(operationAccess('GET', path)).toBe('stored')
    expect(operationAccess('GET', '/api/v1/auth/session')).toBe('write')
    expect(operationAccess('GET', '/api/v1/auth/sessions')).toBe('write')
    expect(operationAccess('GET', '/api/v1/projects/{name}/unknown-future-read')).toBe('live')
  })

  it('keeps provider and write-capable CLI paths out of stored-only mode', () => {
    const expected: Record<string, 'stored' | 'live' | 'write'> = {
      'bing.inspect': 'write',
      'bing.inspect-sitemap': 'write',
      'bing.refresh': 'write',
      'cdp.status': 'live',
      'content.brief': 'write',
      'content.dismissals': 'stored',
      'discover.harvest': 'live',
      'discover.probe': 'stored',
      'gbp.locations': 'stored',
      'google.inspect': 'write',
      'google.inspect-sitemap': 'write',
      'google.refresh': 'write',
      'search': 'stored',
      'competitor.aliases.detect': 'stored',
    }
    for (const [id, access] of Object.entries(expected)) {
      expect(REGISTERED_CLI_COMMANDS.find(command => command.path.join('.') === id)?.access, id).toBe(access)
    }
  })
})
