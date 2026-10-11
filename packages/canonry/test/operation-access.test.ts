import { describe, expect, it } from 'vitest'
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
    expect(operationAccess('GET', '/api/v1/projects/{name}/competitor-suggestions')).toBe('stored')
    expect(operationAccess('PATCH', '/api/v1/projects/{name}')).toBe('write')
    expect(operationAccess('GET', '/api/v1/doctor')).toBe('live')
    expect(operationAccess('GET', '/api/v1/projects/{name}/bing/coverage')).toBe('write')
    expect(operationAccess('GET', '/api/v1/projects/{name}/bing/performance')).toBe('live')
    expect(operationAccess('GET', '/api/v1/projects/{name}/results/export')).toBe('stored')
    expect(operationAccess('GET', '/api/v1/google/callback')).toBe('write')
    expect(operationAccess('GET', '/api/v1/projects/{name}/google/callback')).toBe('write')
    expect(operationAccess('GET', '/api/v1/google-marketing/callback')).toBe('write')
    expect(operationAccess('POST', '/api/v1/projects/{name}/queries/replace-preview')).toBe('stored')
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
      'competitor.aliases.detect': 'write',
    }
    for (const [id, access] of Object.entries(expected)) {
      expect(REGISTERED_CLI_COMMANDS.find(command => command.path.join('.') === id)?.access, id).toBe(access)
    }
  })
})
