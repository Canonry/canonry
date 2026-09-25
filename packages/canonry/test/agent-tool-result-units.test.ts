import { describe, expect, it } from 'vitest'
import { RATIO_UNIT_META_KEY } from '@ainyc/canonry-contracts'
import type { ApiClient } from '../src/client.js'
import { mcpToAgentTool } from '../src/agent/mcp-to-agent-tool.js'
import { renderRatioUnits, responseSchemasFor } from '../src/agent/tool-result-units.js'
import { canonryMcpTools } from '../src/mcp/tool-registry.js'

const fraction = { type: 'number', [RATIO_UNIT_META_KEY]: 'fraction' }
const percent = { type: 'number', [RATIO_UNIT_META_KEY]: 'percent' }

describe('renderRatioUnits', () => {
  it('turns every number the schema declares a ratio into a percent, and leaves counts alone', () => {
    const schema = {
      type: 'object',
      properties: {
        total: { type: 'integer' },
        rows: {
          type: 'array',
          items: { type: 'object', properties: { domain: { type: 'string' }, count: { type: 'integer' }, percentage: fraction, sharePct: percent } },
        },
      },
    }
    const value = { total: 580, rows: [{ domain: 'own.example', count: 12, percentage: 0.0207, sharePct: 2.07 }] }
    expect(renderRatioUnits(schema, value)).toEqual({
      total: 580,
      rows: [{ domain: 'own.example', count: 12, percentage: '2.1%', sharePct: '2.1%' }],
    })
    // The caller's data is never mutated: only the text the model reads changes.
    expect(value.rows[0]!.percentage).toBe(0.0207)
  })

  it('follows $ref, nullable members and record values', () => {
    const components = { Share: { type: 'object', properties: { rate: fraction } } }
    const schema = {
      type: 'object',
      properties: {
        overall: { $ref: '#/components/schemas/Share' },
        maybe: { anyOf: [fraction, { type: 'null' }] },
        legacy: { ...fraction, nullable: true },
        byProvider: { type: 'object', additionalProperties: { $ref: '#/components/schemas/Share' } },
      },
    }
    const value = { overall: { rate: 0.5 }, maybe: null, legacy: 0.9996, byProvider: { claude: { rate: 0.0004 }, gemini: { rate: 1 } } }
    expect(renderRatioUnits(schema, value, components)).toEqual({
      overall: { rate: '50.0%' },
      maybe: null,
      legacy: '>99.9%',
      byProvider: { claude: { rate: '<0.1%' }, gemini: { rate: '100%' } },
    })
  })

  it('renders the member of a union that declares the field', () => {
    const schema = {
      anyOf: [
        { type: 'object', properties: { state: { type: 'string', enum: ['available'] }, value: fraction, numerator: { type: 'integer' } } },
        { type: 'object', properties: { state: { type: 'string', enum: ['unavailable'] }, reason: { type: 'string' } } },
      ],
    }
    expect(renderRatioUnits(schema, { state: 'available', value: 0.25, numerator: 3 })).toEqual({ state: 'available', value: '25.0%', numerator: 3 })
    expect(renderRatioUnits(schema, { state: 'unavailable', reason: 'no_population' })).toEqual({ state: 'unavailable', reason: 'no_population' })
  })

  it('leaves undeclared numbers, unknown keys and a missing schema untouched', () => {
    const schema = { type: 'object', properties: { rate: { type: 'number' } } }
    expect(renderRatioUnits(schema, { rate: 0.5, extra: 0.5 })).toEqual({ rate: 0.5, extra: 0.5 })
    expect(renderRatioUnits(undefined, { rate: 0.5 })).toEqual({ rate: 0.5 })
    // A value that is not a number where the schema expects one stays as it is.
    expect(renderRatioUnits({ type: 'object', properties: { rate: fraction } }, { rate: 'n/a' })).toEqual({ rate: 'n/a' })
  })
})

describe('Aero tool results', () => {
  it('finds the response schema for every tool operation that has one', () => {
    const sources = canonryMcpTools.find(tool => tool.name === 'canonry_analytics_sources')!
    expect(responseSchemasFor(sources.openApiOperations)).toHaveLength(1)
    expect(responseSchemasFor(['GET /api/v1/no-such-route'])).toEqual([])
  })

  it('shows the own-domain source share as a percent, the Aero eval misread', async () => {
    const sources = canonryMcpTools.find(tool => tool.name === 'canonry_analytics_sources')!
    const breakdown = {
      overall: [{ category: 'brand', label: 'Brand', count: 12, percentage: 0.0207, topDomains: [] }],
      ranked: {
        entries: [{ domain: 'own.example', count: 12, percentage: 0.0207, answerShare: 0.0345, category: 'brand', label: 'Brand', surfaceClass: 'own' }],
        surfaceClasses: [{ surfaceClass: 'own', label: 'Your domains', count: 12, percentage: 0.0207, domainCount: 1 }],
        totalCitedSlots: 580,
      },
      byProvider: {},
    }
    const client = { getSourceBreakdown: async () => breakdown } as unknown as ApiClient
    const tool = mcpToAgentTool({ ...sources, handler: async () => breakdown }, { client, projectName: 'demo' })
    const result = await tool.execute('call-1', {})
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('"percentage":"2.1%"')
    expect(text).toContain('"answerShare":"3.5%"')
    expect(text).toContain('"totalCitedSlots":580')
    expect(text).not.toContain('0.0207')
    // Code that reads the result programmatically still gets the raw fraction.
    expect((result.details as typeof breakdown).ranked.entries[0]!.percentage).toBe(0.0207)
  })
})
