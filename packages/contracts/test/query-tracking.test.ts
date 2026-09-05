import { describe, expect, it } from 'vitest'
import {
  queryTrackingCommitRequestSchema,
  queryTrackingPreviewRequestSchema,
  queryTrackingProvenanceSchema,
  queryTrackingWorkspaceResponseSchema,
} from '../src/query-tracking.js'

const WORKSPACE_VERSION = `qtw_${'a'.repeat(64)}`
const PREVIEW_TOKEN = `qtp_${'b'.repeat(64)}`
const REVIEWED_AT = '2026-09-04T12:00:00.000Z'

describe('query tracking contract', () => {
  it('accepts manual, template, saved research, and saved discovery additions', () => {
    const base = {
      expectedWorkspaceVersion: WORKSPACE_VERSION,
      removals: [],
    }

    const sources = [
      { source: 'manual' as const, text: 'best apartments in northbridge' },
      { source: 'template' as const, templateId: 'tpl-market', templateVersion: '3', template: 'best apartments in {market}' },
      { source: 'research' as const, researchRunQueryId: 'research-query-1' },
      { source: 'discovery' as const, discoveryProbeId: 'probe-1' },
    ]

    for (const input of sources) {
      expect(queryTrackingPreviewRequestSchema.parse({
        ...base,
        additions: [{ input }],
      }).additions[0]?.input).toEqual(input)
    }
  })

  it('keeps selection, full context inputs, and the review token distinct', () => {
    const parsed = queryTrackingCommitRequestSchema.parse({
      expectedWorkspaceVersion: WORKSPACE_VERSION,
      previewToken: PREVIEW_TOKEN,
      reviewedAt: REVIEWED_AT,
      additions: [{
        input: { source: 'manual', text: 'Northstar apartments' },
        audience: { targetKeys: ['harbor-point'], groupKeys: ['northbridge'], marketKeys: ['alpha'] },
        contexts: [{
          providers: ['gemini', 'openai'],
          models: { gemini: 'gemini-3-pro', openai: 'gpt-5.4' },
          location: 'northbridge',
        }],
        queryClass: 'branded',
      }],
      removals: [{ queryId: 'q-old', audience: { targetKeys: ['harbor-point'] } }],
    })

    expect(parsed.previewToken).toBe(PREVIEW_TOKEN)
    expect(parsed.reviewedAt).toBe(REVIEWED_AT)
    expect(parsed.additions[0]?.contexts?.[0]?.location).toBe('northbridge')
    expect(parsed.additions[0]?.queryClass).toBe('branded')
    expect(parsed.removals[0]?.audience?.targetKeys).toEqual(['harbor-point'])
  })

  it('requires exactly one removal identity', () => {
    const base = { expectedWorkspaceVersion: WORKSPACE_VERSION, additions: [] }
    expect(queryTrackingPreviewRequestSchema.safeParse({ ...base, removals: [{}] }).success).toBe(false)
    expect(queryTrackingPreviewRequestSchema.safeParse({ ...base, removals: [{ queryId: 'q', queryText: 'query' }] }).success).toBe(false)
  })

  it('requires frozen template details only for a template provenance row', () => {
    expect(queryTrackingProvenanceSchema.safeParse({
      source: 'template', sourceId: 'tpl-market@3', capturedAt: '2026-09-04T00:00:00.000Z',
    }).success).toBe(false)
    expect(queryTrackingProvenanceSchema.parse({
      source: 'template', sourceId: 'tpl-market@3', capturedAt: '2026-09-04T00:00:00.000Z',
      template: {
        templateId: 'tpl-market', templateVersion: '3', template: 'best apartments in {market}',
        bindings: { market: 'Northbridge' }, output: 'best apartments in Northbridge',
      },
    }).template?.output).toBe('best apartments in Northbridge')
    expect(queryTrackingProvenanceSchema.safeParse({
      source: 'manual', sourceId: null, capturedAt: '2026-09-04T00:00:00.000Z',
      template: {
        templateId: 'tpl-market', templateVersion: '3', template: 'x', bindings: {}, output: 'x',
      },
    }).success).toBe(false)
  })

  it('exposes full contexts and exact edge-backed markets in a workspace', () => {
    const workspace = queryTrackingWorkspaceResponseSchema.parse({
      mode: 'advanced',
      workspaceVersion: WORKSPACE_VERSION,
      active: { revision: 4, compiledChecksum: 'c'.repeat(64) },
      defaultContexts: [{
        providers: ['gemini'], models: { gemini: 'gemini-3-pro' },
        location: { label: 'northbridge', city: 'Northbridge', region: 'NB', country: 'US' },
      }],
      targets: [{ stableKey: 'harbor-point', label: 'Harbor Point' }],
      groups: [{ stableKey: 'northbridge', label: 'Northbridge', targetKeys: ['harbor-point'] }],
      markets: [{
        stableKey: 'alpha', label: 'Alpha',
        usageEdges: [{ executionNodeKey: 'exec-1', targetKey: 'harbor-point', queryId: 'q-1' }],
      }],
      tracked: [{
        queryId: 'q-1', queryText: 'best apartments in northbridge', normalizedText: 'best apartments in northbridge',
        provenance: null,
        state: 'awaiting-sweep',
        lastMeasuredAt: null,
        assignments: [{
          targetKey: 'harbor-point', groupKeys: ['northbridge'], marketKeys: ['alpha'],
          queryClass: 'non-brand', classificationSource: 'frozen',
          contexts: [{
            providers: ['gemini'], models: { gemini: 'gemini-3-pro' },
            location: { label: 'northbridge', city: 'Northbridge', region: 'NB', country: 'US' },
          }],
        }],
      }],
      savedSources: { research: [], discovery: [] },
    })

    expect(workspace.markets[0]?.usageEdges[0]?.executionNodeKey).toBe('exec-1')
    expect(workspace.tracked[0]?.assignments[0]?.contexts[0]?.location).toMatchObject({ label: 'northbridge' })
  })
})
