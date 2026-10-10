import { describe, expect, it } from 'vitest'
import {
  queryTrackingCommitRequestSchema,
  queryTrackingPreviewRequestSchema,
  queryTrackingPreviewResponseSchema,
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

  it('accepts scoped edits without reconstructing execution contexts', () => {
    const edit = { queryId: 'q-shared', audience: { targetKeys: ['harbor-point'] }, text: 'Harbor Point amenities', queryClass: null }
    const parsed = queryTrackingPreviewRequestSchema.parse({
      expectedWorkspaceVersion: WORKSPACE_VERSION, additions: [], removals: [], edits: [edit],
    })
    expect(parsed.edits).toEqual([edit])
  })

  it('rejects empty edits and replacement execution contexts', () => {
    const base = { expectedWorkspaceVersion: WORKSPACE_VERSION, additions: [], removals: [] }
    for (const edit of [
      { queryId: 'q-shared' },
      { queryId: 'q-shared', text: '' },
      { queryId: 'q-shared', text: 'new question', contexts: [] },
    ]) {
      expect(queryTrackingPreviewRequestSchema.safeParse({ ...base, edits: [edit] }).success).toBe(false)
    }
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
    const workspace = queryTrackingWorkspaceResponseSchema.parse(advancedWorkspace())

    expect(workspace.markets[0]?.usageEdges[0]?.executionNodeKey).toBe('exec-1')
    expect(workspace.tracked[0]?.assignments[0]?.contexts[0]?.location).toMatchObject({ label: 'northbridge' })
  })

  it('still parses a workspace without scope options from an older server', () => {
    const workspace = queryTrackingWorkspaceResponseSchema.parse(advancedWorkspace())

    expect('scopeOptions' in workspace).toBe(false)
  })

  it('carries server scope options on the workspace exactly as sent', () => {
    // Tracking-shaped options: no market intersection, so only markets name a parent group.
    const scopeOptions = [
      { id: 'project', label: 'Project', kind: 'project', targetCount: 1 },
      { id: 'northbridge', label: 'Northbridge', kind: 'group', targetCount: 1 },
      { id: 'alpha', label: 'Alpha', kind: 'market', targetCount: 1, parentGroupIds: ['northbridge'] },
      { id: 'harbor-point', label: 'Harbor Point', kind: 'property', targetCount: 1, parentGroupIds: ['northbridge'] },
    ]

    const workspace = queryTrackingWorkspaceResponseSchema.parse({ ...advancedWorkspace(), scopeOptions })

    expect(workspace.scopeOptions).toEqual(scopeOptions)
  })

  it('still parses a preview without per-query changes from an older server', () => {
    const preview = queryTrackingPreviewResponseSchema.parse(advancedPreview())

    expect('changes' in preview).toBe(false)
  })

  it('carries per-query placement before and after on a preview exactly as sent', () => {
    const changes = [
      {
        queryId: 'q-1', queryText: 'best apartments in northbridge', change: 'removed',
        before: { targetKeys: ['harbor-point'], marketKeys: ['alpha', 'beta'] },
        after: { targetKeys: ['harbor-point'], marketKeys: ['beta'] },
      },
      {
        queryId: 'q-2', queryText: 'apartments near transit', change: 'added',
        before: { targetKeys: [], marketKeys: [] },
        after: { targetKeys: ['harbor-point'], marketKeys: ['beta'] },
      },
    ]

    expect(queryTrackingPreviewResponseSchema.parse({ ...advancedPreview(), changes }).changes).toEqual(changes)
    expect(queryTrackingPreviewResponseSchema.safeParse({
      ...advancedPreview(), changes: [{ ...changes[0], change: 'moved' }],
    }).success).toBe(false)
  })

  it('validates workspace scope options with the visibility report option contract', () => {
    const result = queryTrackingWorkspaceResponseSchema.safeParse({
      ...advancedWorkspace(),
      scopeOptions: [{ id: 'alpha', label: 'Alpha', kind: 'region', targetCount: 1 }],
    })

    expect(result.success).toBe(false)
    expect(result.error?.issues).toEqual([
      expect.objectContaining({ code: 'invalid_value', path: ['scopeOptions', 0, 'kind'] }),
    ])
  })

  it('carries the query limit on a preview exactly as sent', () => {
    const limits = { queries: { current: 1_000, next: 1_001, max: 1_000 } }

    expect(queryTrackingPreviewResponseSchema.parse({ ...previewResponse(), limits }).limits).toEqual(limits)
  })

  it('still parses a preview without limits from an older server or a simple basket', () => {
    expect('limits' in queryTrackingPreviewResponseSchema.parse(previewResponse())).toBe(false)
  })

  it('rejects a partial, negative or zero-limit query count', () => {
    for (const limits of [
      { queries: { current: 1, next: 2 } },
      { queries: { current: -1, next: 2, max: 1_000 } },
      { queries: { current: 1, next: 2, max: 0 } },
      { queries: { current: 1, next: 2, max: 1_000, remaining: 998 } },
    ]) {
      expect(queryTrackingPreviewResponseSchema.safeParse({ ...previewResponse(), limits }).success).toBe(false)
    }
  })

  it('carries each tracked row\'s Subject exactly as sent, and tolerates a server without one', () => {
    const focuses = [
      { kind: 'market', key: 'alpha' },
      { kind: 'property', key: 'harbor-point' },
      { kind: 'company' },
      { kind: 'custom' },
      { kind: 'not-asked' },
    ]
    for (const focus of focuses) {
      const workspace = advancedWorkspace()
      const parsed = queryTrackingWorkspaceResponseSchema.parse({ ...workspace, tracked: [{ ...workspace.tracked[0]!, focus }] })
      expect(parsed.tracked[0]?.focus).toEqual(focus)
    }

    expect('focus' in queryTrackingWorkspaceResponseSchema.parse(advancedWorkspace()).tracked[0]!).toBe(false)
  })

  it('rejects an unknown Subject kind, a missing market or location key, and a key on any other kind', () => {
    for (const focus of [
      { kind: 'hand-picked' },
      { kind: 'market' },
      { kind: 'property' },
      { kind: 'company', key: 'northwind' },
      { kind: 'custom', key: 'alpha' },
    ]) {
      const workspace = advancedWorkspace()
      expect(queryTrackingWorkspaceResponseSchema.safeParse({ ...workspace, tracked: [{ ...workspace.tracked[0]!, focus }] }).success, JSON.stringify(focus))
        .toBe(false)
    }
  })

  it('never accepts a Subject on an addition', () => {
    for (const field of ['focus', 'subject']) {
      const result = queryTrackingPreviewRequestSchema.safeParse({
        expectedWorkspaceVersion: WORKSPACE_VERSION,
        additions: [{ input: { source: 'manual', text: 'best apartments in northbridge' }, [field]: { kind: 'market', key: 'alpha' } }],
        removals: [],
      })
      expect(result.success).toBe(false)
      expect(result.error?.issues).toEqual([
        expect.objectContaining({ code: 'unrecognized_keys', keys: [field], path: ['additions', 0] }),
      ])
    }
  })
})

function previewResponse() {
  const workload = {
    existingNodes: 1, existingProviderCalls: 1, nextSweepNodes: 1, nextSweepProviderCalls: 1,
    addedNodes: 0, addedProviderCalls: 0, removedNodes: 0, removedProviderCalls: 0,
  }
  return {
    mode: 'advanced',
    workspaceVersion: WORKSPACE_VERSION,
    previewToken: PREVIEW_TOKEN,
    reviewedAt: REVIEWED_AT,
    active: { revision: 4, compiledChecksum: 'c'.repeat(64) },
    tracked: advancedWorkspace().tracked,
    diff: { added: [], removed: [], reused: [], unchanged: [], noOp: true },
    workload,
  }
}

function advancedPreview() {
  const { mode, workspaceVersion, active, tracked } = advancedWorkspace()
  const unchanged = [{ queryId: 'q-1', queryText: 'best apartments in northbridge', assignmentCount: 1 }]
  return {
    mode, workspaceVersion, previewToken: PREVIEW_TOKEN, reviewedAt: REVIEWED_AT, active, tracked,
    diff: { added: [], removed: [], reused: [], unchanged, noOp: true },
    workload: {
      existingNodes: 1, existingProviderCalls: 1, nextSweepNodes: 1, nextSweepProviderCalls: 1,
      addedNodes: 0, addedProviderCalls: 0, removedNodes: 0, removedProviderCalls: 0,
    },
  }
}

function advancedWorkspace() {
  return {
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
  }
}
