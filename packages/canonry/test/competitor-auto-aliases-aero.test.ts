import { describe, expect, it } from 'vitest'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { CompetitorAutoAliasMode } from '@ainyc/canonry-contracts'
import type { ApiClient } from '../src/client.js'
import { CliError } from '../src/cli-error.js'
import { canonryMcpTools } from '../src/mcp/tool-registry.js'
import {
  AERO_EXCLUDED_MCP_TOOLS,
  COMPETITOR_AUTO_ALIAS_MODE_REFUSAL,
  buildMcpAgentTools,
} from '../src/agent/mcp-to-agent-tool.js'

// Applying answer-derived competitor names changes the measured competitor
// identity and restates stored history, so it stays an operator action: Aero
// may preview detection but never apply it.
describe('Aero and answer-derived competitor aliases', () => {
  it('withholds the apply tool from every Aero surface and keeps the dry run', () => {
    expect(AERO_EXCLUDED_MCP_TOOLS.has('canonry_competitors_auto_aliases_apply')).toBe(true)
    const ctx = { client: {} as ApiClient, projectName: 'demo' }
    for (const options of [{}, { readOnly: true }, { managedSweeps: true }]) {
      const visible = buildMcpAgentTools(canonryMcpTools, ctx, options).map(tool => tool.name)
      expect(visible).not.toContain('canonry_competitors_auto_aliases_apply')
      expect(visible).toContain('canonry_competitors_auto_aliases_detect')
    }
  })
})

// The project's mode decides whether detection stores names after sweeps and
// competitor adds, so a project write that switched it to `apply` would get
// around the withheld apply tool.
describe('Aero and the competitor auto-alias mode', () => {
  interface Call { method: string, args: unknown[] }

  /** `stored` undefined means the project does not exist yet. */
  function toolFor(name: string, stored: CompetitorAutoAliasMode | undefined, calls: Call[], options = {}): AgentTool {
    const client = new Proxy({}, {
      get(_target, property) {
        return async (...args: unknown[]) => {
          calls.push({ method: String(property), args })
          if (property === 'getProject') {
            if (stored === undefined) throw new CliError({ code: 'NOT_FOUND', message: `Project '${String(args[0])}' not found` })
            return { name: args[0], competitorAutoAliases: stored }
          }
          return { ok: true }
        }
      },
    }) as ApiClient
    const tool = buildMcpAgentTools(canonryMcpTools, { client, projectName: 'demo' }, options).find(t => t.name === name)
    if (!tool) throw new Error(`${name} missing`)
    return tool
  }

  function applyParams(spec: Record<string, unknown>) {
    return {
      config: {
        apiVersion: 'canonry/v1',
        kind: 'Project',
        metadata: { name: 'demo' },
        spec: { displayName: 'Demo', canonicalDomain: 'demo.example', country: 'US', language: 'en', ...spec },
      },
    }
  }

  it('refuses a project upsert that changes the mode, on every write surface', async () => {
    for (const options of [{}, { managedSweeps: true }]) {
      const calls: Call[] = []
      const upsert = toolFor('canonry_project_upsert', 'preview', calls, options)
      await expect(upsert.execute('call-1', { request: { displayName: 'Demo', competitorAutoAliases: 'apply' } }))
        .rejects.toThrow(COMPETITOR_AUTO_ALIAS_MODE_REFUSAL)
      expect(calls.map(c => c.method)).toEqual(['getProject'])
      expect(calls[0]!.args[0]).toBe('demo')
    }
  })

  it('lets a project upsert omit the mode or restate the stored one', async () => {
    const omitted: Call[] = []
    await toolFor('canonry_project_upsert', 'preview', omitted)
      .execute('call-1', { request: { displayName: 'Demo' } })
    expect(omitted.map(c => c.method)).toEqual(['putProject'])

    const restated: Call[] = []
    await toolFor('canonry_project_upsert', 'apply', restated)
      .execute('call-2', { request: { displayName: 'Demo', competitorAutoAliases: 'apply' } })
    expect(restated.map(c => c.method)).toEqual(['getProject', 'putProject'])
  })

  it('compares a new project with the default mode', async () => {
    const refused: Call[] = []
    await expect(toolFor('canonry_project_upsert', undefined, refused)
      .execute('call-1', { request: { displayName: 'Demo', competitorAutoAliases: 'apply' } }))
      .rejects.toThrow(COMPETITOR_AUTO_ALIAS_MODE_REFUSAL)
    expect(refused.map(c => c.method)).toEqual(['getProject'])

    const created: Call[] = []
    await toolFor('canonry_project_upsert', undefined, created)
      .execute('call-2', { request: { displayName: 'Demo', competitorAutoAliases: 'preview' } })
    expect(created.map(c => c.method)).toEqual(['getProject', 'putProject'])
  })

  it('refuses a config apply that changes the mode and passes one that keeps it', async () => {
    const refused: Call[] = []
    await expect(toolFor('canonry_apply_config', 'off', refused)
      .execute('call-1', applyParams({ competitorAutoAliases: 'apply' })))
      .rejects.toThrow(COMPETITOR_AUTO_ALIAS_MODE_REFUSAL)
    expect(refused.map(c => c.method)).toEqual(['getProject'])

    const kept: Call[] = []
    await toolFor('canonry_apply_config', 'off', kept).execute('call-2', applyParams({ competitorAutoAliases: 'off' }))
    expect(kept.map(c => c.method)).toEqual(['getProject', 'apply'])

    const omitted: Call[] = []
    await toolFor('canonry_apply_config', 'off', omitted).execute('call-3', applyParams({}))
    expect(omitted.map(c => c.method)).toEqual(['apply'])
  })

  it('surfaces a failed mode read instead of writing', async () => {
    const client = new Proxy({}, {
      get(_target, property) {
        return async () => {
          if (property === 'getProject') throw new CliError({ code: 'CONNECTION_ERROR', message: 'offline' })
          throw new Error(`unexpected ${String(property)}`)
        }
      },
    }) as ApiClient
    const upsert = buildMcpAgentTools(canonryMcpTools, { client, projectName: 'demo' })
      .find(t => t.name === 'canonry_project_upsert')!
    await expect(upsert.execute('call-1', { request: { displayName: 'Demo', competitorAutoAliases: 'apply' } }))
      .rejects.toThrow('offline')
  })
})
