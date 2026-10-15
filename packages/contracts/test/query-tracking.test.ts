import { describe, expect, it } from 'vitest'
import {
  QUERY_CLASS_BY_FOCUS,
  QUERY_TEMPLATE_VARIABLE_NAMES,
  expandQueryTemplate,
  queryTemplateBindings,
  queryTemplateVariableKind,
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

  it('reads a template provenance row with or without its frozen details, and refuses them on any other source', () => {
    // A plan published before query control froze the template keeps only the source.
    const bare = { source: 'template', sourceId: 'tpl-market@3', capturedAt: '2026-09-04T00:00:00.000Z' }
    expect(queryTrackingProvenanceSchema.parse(bare)).toEqual(bare)
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
    expect(workspace.tracked[0]?.assignments[0]?.classifiedContexts).toBeUndefined()
  })

  it('preserves optional class and market membership for each exact assignment context', () => {
    const base = advancedWorkspace()
    const row = base.tracked[0]!
    const assignment = row.assignments[0]!
    const context = assignment.contexts[0]!
    const classifiedContexts = [
      { ...context, queryClass: 'branded', marketKeys: [] },
      { ...context, queryClass: 'non-brand', marketKeys: ['alpha'] },
    ]
    const withContexts = (contexts: unknown[]) => ({ ...base, tracked: [{ ...row, assignments: [{ ...assignment, classifiedContexts: contexts }] }] })
    expect(queryTrackingWorkspaceResponseSchema.parse(withContexts(classifiedContexts)).tracked[0]?.assignments[0]?.classifiedContexts)
      .toEqual(classifiedContexts)
    for (const contexts of [[], [{ ...context, marketKeys: [] }], [{ ...context, queryClass: 'all', marketKeys: [] }]]) {
      expect(queryTrackingWorkspaceResponseSchema.safeParse(withContexts(contexts)).success).toBe(false)
    }
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

  it('carries altered and rewordedFrom on a change row exactly as sent, and still parses a row without them', () => {
    const row = {
      queryId: 'q-2', queryText: 'apartments near transit', change: 'reused',
      before: { targetKeys: ['harbor-point'], marketKeys: ['beta'] },
      after: { targetKeys: ['harbor-point'], marketKeys: ['beta'] },
    }
    const changes = [{ ...row, altered: false, rewordedFrom: 'q-1' }, { ...row, queryId: 'q-3', altered: true }]

    expect(queryTrackingPreviewResponseSchema.parse({ ...advancedPreview(), changes }).changes).toEqual(changes)
    const older = queryTrackingPreviewResponseSchema.parse({ ...advancedPreview(), changes: [row] }).changes![0]!
    expect('altered' in older || 'rewordedFrom' in older).toBe(false)
    for (const invalid of [{ ...row, altered: 'no' }, { ...row, rewordedFrom: '' }, { ...row, rewordedFrom: null }]) {
      expect(queryTrackingPreviewResponseSchema.safeParse({ ...advancedPreview(), changes: [invalid] }).success, JSON.stringify(invalid)).toBe(false)
    }
  })

  it('carries type mismatches on a preview exactly as sent, and still parses a preview without them', () => {
    const typeMismatches = [
      {
        queryId: 'q-1', queryText: 'acme homes in lakeshore', focus: { kind: 'market', key: 'lakeshore' },
        expectedQueryClass: 'non-brand', queryClasses: ['non-brand'], brandedWording: true,
      },
      {
        queryId: 'q-2', queryText: 'harbor point pricing', focus: { kind: 'property', key: 'harbor-point' },
        expectedQueryClass: 'branded', queryClasses: ['branded', 'non-brand'], brandedWording: false,
      },
    ]

    expect(queryTrackingPreviewResponseSchema.parse({ ...advancedPreview(), typeMismatches }).typeMismatches).toEqual(typeMismatches)
    expect(queryTrackingPreviewResponseSchema.parse({ ...advancedPreview(), typeMismatches: [] }).typeMismatches).toEqual([])
    expect('typeMismatches' in queryTrackingPreviewResponseSchema.parse(advancedPreview())).toBe(false)
    const [row] = typeMismatches
    const { brandedWording, ...withoutWording } = row!
    expect(brandedWording).toBe(true)
    for (const invalid of [
      withoutWording,
      { ...row, expectedQueryClass: 'mixed' },
      { ...row, queryClasses: ['unknown'] },
      { ...row, focus: { kind: 'market' } },
      { ...row, reason: 'branded-wording' },
    ]) {
      expect(queryTrackingPreviewResponseSchema.safeParse({ ...advancedPreview(), typeMismatches: [invalid] }).success, JSON.stringify(invalid)).toBe(false)
    }
  })

  it('states the Type each Subject takes, and none for a hand-picked query', () => {
    expect(QUERY_CLASS_BY_FOCUS).toEqual({ market: 'non-brand', property: 'branded' })
    expect(Object.keys(QUERY_CLASS_BY_FOCUS)).not.toContain('custom')
  })

  it('carries each market\'s own-query count before and after exactly as sent, and still parses a preview without it', () => {
    const marketQueryChanges = [
      { marketKey: 'alpha', before: { marketQueries: 4 }, after: { marketQueries: 0 } },
      { marketKey: 'beta', before: { marketQueries: 0 }, after: { marketQueries: 2 } },
    ]

    expect(queryTrackingPreviewResponseSchema.parse({ ...advancedPreview(), marketQueryChanges }).marketQueryChanges).toEqual(marketQueryChanges)
    expect('marketQueryChanges' in queryTrackingPreviewResponseSchema.parse(advancedPreview())).toBe(false)
    for (const invalid of [
      { marketKey: 'alpha', before: { marketQueries: 4 } },
      { marketKey: 'alpha', before: { marketQueries: 4 }, after: { marketQueries: -1 } },
      { marketKey: 'alpha', before: { marketQueries: 4 }, after: { marketQueries: 0, propertyQueries: 2 } },
    ]) {
      expect(queryTrackingPreviewResponseSchema.safeParse({ ...advancedPreview(), marketQueryChanges: [invalid] }).success, JSON.stringify(invalid)).toBe(false)
    }
  })

  it('still parses a preview without market changes from an older server or a simple basket', () => {
    expect('marketChanges' in queryTrackingPreviewResponseSchema.parse(advancedPreview())).toBe(false)
  })

  it('carries each market\'s locations before and after on a preview exactly as sent', () => {
    const marketChanges = [
      {
        marketKey: 'alpha', before: { targetKeys: ['harbor-point', 'river-point'] }, after: { targetKeys: ['harbor-point'] },
        removedTargetKeys: ['river-point'], emptied: false,
      },
      {
        marketKey: 'beta', before: { targetKeys: ['harbor-point'] }, after: { targetKeys: [] },
        removedTargetKeys: ['harbor-point'], emptied: true,
      },
    ]

    expect(queryTrackingPreviewResponseSchema.parse({ ...advancedPreview(), marketChanges }).marketChanges).toEqual(marketChanges)
    expect(queryTrackingPreviewResponseSchema.parse({ ...advancedPreview(), marketChanges: [] }).marketChanges).toEqual([])
  })

  it('rejects a market change that is partial, mistyped or carries an unknown key', () => {
    const change = {
      marketKey: 'alpha', before: { targetKeys: ['harbor-point'] }, after: { targetKeys: [] },
      removedTargetKeys: ['harbor-point'], emptied: true,
    }
    const { marketKey, before, after, removedTargetKeys, emptied } = change
    for (const invalid of [
      { marketKey, before, after, removedTargetKeys },
      { marketKey, before, after, emptied },
      { ...change, emptied: 'yes' },
      { ...change, after: { targetKeys: [], marketKeys: [] } },
      { ...change, before: ['harbor-point'] },
      { ...change, addedTargetKeys: [] },
    ]) {
      expect(queryTrackingPreviewResponseSchema.safeParse({
        ...advancedPreview(), marketChanges: [invalid],
      }).success, JSON.stringify(invalid)).toBe(false)
    }
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

  it('carries the room under the limit exactly as sent, and never a negative one', () => {
    const limits = { queries: { current: 1_002, next: 999, max: 1_000, left: { current: 0, next: 1 } } }

    expect(queryTrackingPreviewResponseSchema.parse({ ...previewResponse(), limits }).limits).toEqual(limits)
    expect(queryTrackingWorkspaceResponseSchema.parse({ ...advancedWorkspace(), limits }).limits).toEqual(limits)
    for (const left of [{ current: -2, next: 1 }, { current: 0 }, { current: 0, next: 1, after: 1 }]) {
      expect(queryTrackingPreviewResponseSchema.safeParse({
        ...previewResponse(), limits: { queries: { ...limits.queries, left } },
      }).success, JSON.stringify(left)).toBe(false)
    }
  })

  it('carries the excess over the limit and whether the change is refused exactly as sent', () => {
    const limits = { queries: { current: 935, next: 1_005, max: 1_000, left: { current: 65, next: 0 }, over: { current: 0, next: 5 }, exceeded: true } }

    expect(queryTrackingPreviewResponseSchema.parse({ ...previewResponse(), limits }).limits).toEqual(limits)
    expect(queryTrackingWorkspaceResponseSchema.parse({ ...advancedWorkspace(), limits }).limits).toEqual(limits)
    // A plan already over the limit that shrinks: still over, not refused.
    const shrinking = { queries: { ...limits.queries, current: 1_002, next: 1_001, over: { current: 2, next: 1 }, exceeded: false } }
    expect(queryTrackingPreviewResponseSchema.parse({ ...previewResponse(), limits: shrinking }).limits).toEqual(shrinking)
    for (const invalid of [
      { ...limits.queries, over: { current: 0, next: -5 } },
      { ...limits.queries, over: { next: 5 } },
      { ...limits.queries, exceeded: 'yes' },
    ]) {
      expect(queryTrackingPreviewResponseSchema.safeParse({ ...previewResponse(), limits: { queries: invalid } }).success, JSON.stringify(invalid)).toBe(false)
    }
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

  it('carries the server summary, place counts and each row\'s Type exactly as sent', () => {
    const base = advancedWorkspace()
    const sent = {
      ...base,
      targets: [{ ...base.targets[0]!, marketKeys: ['alpha'], counts: { propertyQueries: 0, marketQueries: 1, customQueries: 0, answersPerSweep: 1 } }],
      groups: [{ ...base.groups[0]!, counts: { queries: 1, markets: 0, answersPerSweep: 1 } }],
      markets: [{ ...base.markets[0]!, targetKeys: ['harbor-point'], counts: { marketQueries: 1, propertyQueries: 0, answersPerSweep: 1 } }],
      tracked: [{ ...base.tracked[0]!, queryClasses: ['branded', 'non-brand'] }],
      summary: {
        asked: 1, notAsked: 0,
        byClass: { branded: 0, nonBrand: 0, mixed: 1, unknown: 0 },
        byFocus: { market: 1, property: 0, company: 0, custom: 0 },
        assignments: { total: 2, branded: 1, nonBrand: 1, unknown: 0 },
        answersPerSweep: 1,
        structure: { targets: 1, markets: 1, groups: 1, topLevelGroups: 1, competitors: 0 },
      },
    }

    expect(queryTrackingWorkspaceResponseSchema.parse(sent)).toEqual(sent)
  })

  it('carries each place\'s queries by Type, a group\'s Subject counts and the patterns compared exactly as sent', () => {
    const base = advancedWorkspace()
    const byClass = { branded: 1, nonBrand: 2, mixed: 1, unknown: 0 }
    const sent = {
      ...base,
      targets: [{ ...base.targets[0]!, counts: { queries: 4, byClass, propertyQueries: 1, marketQueries: 2, customQueries: 1, answersPerSweep: 6 } }],
      groups: [{ ...base.groups[0]!, counts: { queries: 4, byClass, marketQueries: 2, propertyQueries: 1, customQueries: 1, markets: 3, answersPerSweep: 6 } }],
      // A hand-picked query paired inside the market: more queries than its two Subject counts.
      markets: [{ ...base.markets[0]!, counts: { queries: 4, byClass, marketQueries: 2, propertyQueries: 1, answersPerSweep: 5 } }],
      views: {
        noPropertyQueries: { count: 0, targetKeys: [] },
        thinMarkets: { count: 0, floor: 4, marketKeys: [] },
        patternGaps: { count: 0, compared: 2, patterns: [] },
      },
    }

    expect(queryTrackingWorkspaceResponseSchema.parse(sent)).toEqual(sent)
    const { compared, ...olderGaps } = sent.views.patternGaps
    expect(compared).toBe(2)
    expect(queryTrackingWorkspaceResponseSchema.parse({ ...sent, views: { ...sent.views, patternGaps: olderGaps } }).views?.patternGaps).toEqual(olderGaps)
    for (const [name, counts] of Object.entries({
      'missing mixed': { ...sent.targets[0]!.counts, byClass: { branded: 1, nonBrand: 2, unknown: 0 } },
      // One figure for both classes is not a count this contract carries.
      pooled: { ...sent.targets[0]!.counts, byClass: { ...byClass, all: 4 } },
      negative: { ...sent.targets[0]!.counts, queries: -1 },
    })) {
      expect(queryTrackingWorkspaceResponseSchema.safeParse({ ...sent, targets: [{ ...base.targets[0]!, counts }] }).success, name).toBe(false)
    }
  })

  it('still parses a workspace without the summary, limits, place counts or row Types from an older server', () => {
    const workspace = queryTrackingWorkspaceResponseSchema.parse(advancedWorkspace())

    expect('summary' in workspace || 'limits' in workspace).toBe(false)
    expect(workspace.targets[0]).toEqual({ stableKey: 'harbor-point', label: 'Harbor Point' })
    expect('counts' in workspace.groups[0]! || 'counts' in workspace.markets[0]! || 'targetKeys' in workspace.markets[0]!).toBe(false)
    expect('queryClasses' in workspace.tracked[0]!).toBe(false)
  })

  it('rejects a negative, fractional, missing or pooled count and an unknown class', () => {
    const base = advancedWorkspace()
    const summary = {
      asked: 1, notAsked: 0,
      byClass: { branded: 0, nonBrand: 1, mixed: 0, unknown: 0 },
      byFocus: { market: 1, property: 0, company: 0, custom: 0 },
      assignments: { total: 1, branded: 0, nonBrand: 1, unknown: 0 },
      answersPerSweep: 1,
      structure: { targets: 1, markets: 1, groups: 1, topLevelGroups: 1, competitors: 0 },
    }
    expect(queryTrackingWorkspaceResponseSchema.safeParse({ ...base, summary }).success).toBe(true)
    for (const [name, workspace] of Object.entries({
      negative: { ...base, summary: { ...summary, notAsked: -1 } },
      fractional: { ...base, summary: { ...summary, answersPerSweep: 1.5 } },
      'missing mixed': { ...base, summary: { ...summary, byClass: { branded: 0, nonBrand: 1, unknown: 0 } } },
      // One figure for both classes is not a count this contract carries.
      pooled: { ...base, summary: { ...summary, byClass: { ...summary.byClass, all: 1 } } },
      'place count': { ...base, targets: [{ ...base.targets[0]!, counts: { propertyQueries: 0, marketQueries: 1, customQueries: 0 } }] },
      'unknown class': { ...base, tracked: [{ ...base.tracked[0]!, queryClasses: ['mixed'] }] },
    })) {
      expect(queryTrackingWorkspaceResponseSchema.safeParse(workspace).success, name).toBe(false)
    }
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

describe('query pattern variable names', () => {
  it('reads every name by what it fills in, and no name under two kinds', () => {
    expect(QUERY_TEMPLATE_VARIABLE_NAMES).toEqual({
      market: ['market', 'submarket'],
      locationName: ['locationName', 'property', 'propertyBrand'],
      searchLocation: ['searchLocation', 'location'],
    })
    expect(['market', 'submarket', 'locationName', 'property', 'propertyBrand', 'searchLocation', 'location'].map(queryTemplateVariableKind)).toEqual([
      'market', 'market', 'locationName', 'locationName', 'locationName', 'searchLocation', 'searchLocation',
    ])
    const names = Object.values(QUERY_TEMPLATE_VARIABLE_NAMES).flat()
    expect(new Set(names).size).toBe(names.length)
  })

  it('reads no kind for a name nothing binds, whatever its case or shape', () => {
    for (const name of ['city', 'Market', 'LOCATION', 'location ', '', 'constructor', 'toString']) {
      expect(queryTemplateVariableKind(name), name).toBeNull()
    }
  })

  it('binds one value under every name of a kind, so a pattern written with any of them expands the same', () => {
    expect(queryTemplateBindings('market', 'Lakeshore')).toEqual({ market: 'Lakeshore', submarket: 'Lakeshore' })
    expect(queryTemplateBindings('locationName', 'Harbor Point')).toEqual({ locationName: 'Harbor Point', property: 'Harbor Point', propertyBrand: 'Harbor Point' })
    expect(queryTemplateBindings('searchLocation', 'Chicago')).toEqual({ searchLocation: 'Chicago', location: 'Chicago' })
    for (const pattern of ['best homes in {market}', 'best homes in {submarket}']) {
      expect(expandQueryTemplate(pattern, queryTemplateBindings('market', 'Lakeshore'))).toBe('best homes in Lakeshore')
    }
  })
})

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
