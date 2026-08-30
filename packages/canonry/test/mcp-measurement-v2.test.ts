import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../src/client.js'
import { canonryMcpTools } from '../src/mcp/tool-registry.js'
import { getCanonryMcpTools } from '../src/mcp/server.js'

const project = 'demo-project'
const etag = '"mpd_7"'
const idempotencyKey = 'request-7'
const checksum = 'a'.repeat(64)

const target = {
  stableKey: 'target-a',
  label: 'Target A',
  status: 'included',
  aliases: ['Target A'],
  urlMatchers: ['https://demo.example/target-a'],
  source: 'manual',
}

const draftActionCasesRaw = [
  {
    action: 'create',
    input: { project, action: 'create', request: { expectedActiveRevision: null }, idempotencyKey },
    method: 'createMeasurementPlanDraft',
    args: [project, { expectedActiveRevision: null }, idempotencyKey],
  },
  {
    action: 'import-sitemap',
    input: {
      project,
      action: 'import-sitemap',
      request: {
        sitemapUrl: 'https://demo.example/sitemap.xml',
        rule: { primary: { host: 'demo.example', pathTemplate: '/locations/{slug}' } },
      },
      etag,
      idempotencyKey,
    },
    method: 'importMeasurementDraftSitemap',
    args: [project, {
      sitemapUrl: 'https://demo.example/sitemap.xml',
      rule: { primary: { host: 'demo.example', pathTemplate: '/locations/{slug}' } },
    }, idempotencyKey, etag],
  },
  {
    action: 'apply-sitemap-selection',
    input: {
      project,
      action: 'apply-sitemap-selection',
      request: { selections: [{ discoveryIdentity: 'page-a', action: 'ignore' }] },
      etag,
      idempotencyKey,
    },
    method: 'applyMeasurementDraftSitemapSelection',
    args: [project, { selections: [{ discoveryIdentity: 'page-a', action: 'ignore' }] }, idempotencyKey, etag],
  },
  {
    action: 'upsert-target',
    input: { project, action: 'upsert-target', request: { target }, etag, idempotencyKey },
    method: 'upsertMeasurementDraftTarget',
    args: [project, { target }, idempotencyKey, etag],
  },
  {
    action: 'rename-target',
    input: { project, action: 'rename-target', request: { targetKey: 'target-a', label: 'Renamed Target' }, etag, idempotencyKey },
    method: 'renameMeasurementDraftTarget',
    args: [project, { targetKey: 'target-a', label: 'Renamed Target' }, idempotencyKey, etag],
  },
  {
    action: 'merge-targets',
    input: { project, action: 'merge-targets', request: { targetKey: 'target-a', mergedKeys: ['target-b'] }, etag, idempotencyKey },
    method: 'mergeMeasurementDraftTargets',
    args: [project, { targetKey: 'target-a', mergedKeys: ['target-b'] }, idempotencyKey, etag],
  },
  {
    action: 'exclude-target',
    input: { project, action: 'exclude-target', request: { targetKey: 'target-a' }, etag, idempotencyKey },
    method: 'excludeMeasurementDraftTarget',
    args: [project, { targetKey: 'target-a' }, idempotencyKey, etag],
  },
  {
    action: 'rebind-target',
    input: {
      project,
      action: 'rebind-target',
      request: { targetKey: 'target-a', discoveryIdentity: 'page-b', discoveredUrl: 'https://demo.example/target-b' },
      etag,
      idempotencyKey,
    },
    method: 'rebindMeasurementDraftTarget',
    args: [project, { targetKey: 'target-a', discoveryIdentity: 'page-b', discoveredUrl: 'https://demo.example/target-b' }, idempotencyKey, etag],
  },
  {
    action: 'apply-assignments',
    input: { project, action: 'apply-assignments', request: { targetKey: 'target-a', queryIds: ['query-a'] }, etag, idempotencyKey },
    method: 'applyMeasurementDraftAssignments',
    args: [project, { targetKey: 'target-a', queryIds: ['query-a'] }, idempotencyKey, etag],
  },
  {
    action: 'preview-assignments',
    input: { project, action: 'preview-assignments', request: { groupKeys: ['group-a'], queryIds: ['query-a'] } },
    method: 'previewMeasurementDraftAssignments',
    args: [project, { groupKeys: ['group-a'], queryIds: ['query-a'] }],
  },
  {
    action: 'replace-assignments',
    input: { project, action: 'replace-assignments', request: { groupKeys: ['group-a'], queryIds: ['query-a'] }, etag, idempotencyKey },
    method: 'replaceMeasurementDraftAssignments',
    args: [project, { groupKeys: ['group-a'], queryIds: ['query-a'] }, idempotencyKey, etag],
  },
  {
    action: 'replace-query',
    input: { project, action: 'replace-query', request: { queryId: 'query-a', queryText: 'Quiet apartments near transit' }, etag, idempotencyKey },
    method: 'replaceMeasurementDraftQuery',
    args: [project, { queryId: 'query-a', queryText: 'Quiet apartments near transit' }, idempotencyKey, etag],
  },
  {
    action: 'apply-paired-assignments',
    input: {
      project,
      action: 'apply-paired-assignments',
      request: { pairs: [{ targetKey: 'target-a', queryId: 'query-a' }] },
      etag,
      idempotencyKey,
    },
    method: 'applyPairedMeasurementDraftAssignments',
    args: [project, { pairs: [{ targetKey: 'target-a', queryId: 'query-a' }] }, idempotencyKey, etag],
  },
  {
    action: 'remove-assignment',
    input: { project, action: 'remove-assignment', request: { targetKey: 'target-a', queryId: 'query-a' }, etag, idempotencyKey },
    method: 'removeMeasurementDraftAssignment',
    args: [project, { targetKey: 'target-a', queryId: 'query-a' }, idempotencyKey, etag],
  },
  {
    action: 'clear-assignments',
    input: { project, action: 'clear-assignments', request: { targetKey: 'target-a' }, etag, idempotencyKey },
    method: 'clearMeasurementDraftAssignments',
    args: [project, { targetKey: 'target-a' }, idempotencyKey, etag],
  },
  {
    action: 'classify-assignments',
    input: {
      project,
      action: 'classify-assignments',
      request: { queryClass: 'branded', assignments: [{ targetKey: 'target-a', queryId: 'query-a' }] },
      etag,
      idempotencyKey,
    },
    method: 'classifyMeasurementDraftAssignments',
    args: [project, { queryClass: 'branded', assignments: [{ targetKey: 'target-a', queryId: 'query-a' }] }, idempotencyKey, etag],
  },
  {
    action: 'upsert-group',
    input: {
      project,
      action: 'upsert-group',
      request: { group: { stableKey: 'group-a', label: 'Group A', targetKeys: ['target-a'] } },
      etag,
      idempotencyKey,
    },
    method: 'upsertMeasurementDraftGroup',
    args: [project, { group: { stableKey: 'group-a', label: 'Group A', targetKeys: ['target-a'] } }, idempotencyKey, etag],
  },
  {
    action: 'remove-group',
    input: { project, action: 'remove-group', request: { groupKey: 'group-a' }, etag, idempotencyKey },
    method: 'removeMeasurementDraftGroup',
    args: [project, { groupKey: 'group-a' }, idempotencyKey, etag],
  },
  {
    action: 'preview-group-membership',
    input: { project, action: 'preview-group-membership', request: { csv: 'property,group\nTarget A,Group A' } },
    method: 'previewMeasurementDraftGroupMembership',
    args: [project, { csv: 'property,group\nTarget A,Group A' }],
  },
  {
    action: 'apply-group-membership',
    input: {
      project,
      action: 'apply-group-membership',
      request: { csv: 'property,group\nTarget A,Group A', sourceChecksum: checksum, previewChecksum: checksum, acceptedRows: [1] },
      etag,
      idempotencyKey,
    },
    method: 'applyMeasurementDraftGroupMembership',
    args: [project, { csv: 'property,group\nTarget A,Group A', sourceChecksum: checksum, previewChecksum: checksum, acceptedRows: [1] }, idempotencyKey, etag],
  },
  {
    action: 'upsert-competitor',
    input: {
      project,
      action: 'upsert-competitor',
      request: { groupKey: 'group-a', competitor: { stableKey: 'rival-a', label: 'Rival A', domain: 'rival.example', aliases: ['Rival A'] } },
      etag,
      idempotencyKey,
    },
    method: 'upsertMeasurementDraftCompetitor',
    args: [project, { groupKey: 'group-a', competitor: { stableKey: 'rival-a', label: 'Rival A', domain: 'rival.example', aliases: ['Rival A'] } }, idempotencyKey, etag],
  },
  {
    action: 'remove-competitor',
    input: { project, action: 'remove-competitor', request: { groupKey: 'group-a', competitorKey: 'rival-a' }, etag, idempotencyKey },
    method: 'removeMeasurementDraftCompetitor',
    args: [project, { groupKey: 'group-a', competitorKey: 'rival-a' }, idempotencyKey, etag],
  },
  {
    action: 'compile-preview',
    input: { project, action: 'compile-preview' },
    method: 'compileMeasurementDraftPreview',
    args: [project],
  },
  {
    action: 'diff-preview',
    input: { project, action: 'diff-preview' },
    method: 'diffMeasurementDraftPreview',
    args: [project],
  },
  {
    action: 'publish',
    input: {
      project,
      action: 'publish',
      request: { expectedActiveRevision: 2, expectedCompiledChecksum: checksum },
      etag,
      idempotencyKey,
    },
    method: 'publishMeasurementDraft',
    args: [project, { expectedActiveRevision: 2, expectedCompiledChecksum: checksum }, idempotencyKey, etag],
  },
  {
    action: 'discard',
    input: { project, action: 'discard', etag, idempotencyKey },
    method: 'discardMeasurementDraft',
    args: [project, idempotencyKey, etag],
  },
] as const

const draftActionCases = draftActionCasesRaw.map(({ input, ...testCase }) => {
  const { project: inputProject, ...operation } = input
  return { ...testCase, input: { project: inputProject, operation } }
})

const readToolCases = [
  {
    name: 'canonry_measurement_setup',
    operation: 'GET /api/v1/projects/{name}/measurement-setup',
    input: { project },
    method: 'getMeasurementSetup',
    args: [project],
  },
  {
    name: 'canonry_measurement_query_statuses',
    operation: 'GET /api/v1/projects/{name}/measurement-query-statuses',
    input: { project },
    method: 'getMeasurementQueryStatuses',
    args: [project],
  },
  {
    name: 'canonry_measurement_overview',
    operation: 'GET /api/v1/projects/{name}/measurement-overview',
    input: { project, scope: 'all', search: 'Target', limit: 25, sort: 'citationCoverage-asc' },
    method: 'getMeasurementOverview',
    args: [project, { scope: 'all', search: 'Target', limit: 25, sort: 'citationCoverage-asc' }],
  },
  {
    name: 'canonry_measurement_draft_get',
    operation: 'GET /api/v1/projects/{name}/measurement-plan/draft',
    input: { project },
    method: 'getMeasurementPlanDraft',
    args: [project],
  },
  {
    name: 'canonry_measurement_draft_targets',
    operation: 'GET /api/v1/projects/{name}/measurement-plan/draft/targets',
    input: { project, search: 'Target', cursor: 'next-page', limit: 25 },
    method: 'getMeasurementDraftTargets',
    args: [project, { search: 'Target', cursor: 'next-page', limit: 25 }],
  },
  {
    name: 'canonry_measurement_draft_assignments',
    operation: 'GET /api/v1/projects/{name}/measurement-plan/draft/assignments',
    input: { project, search: 'query', cursor: 'next-page', limit: 25 },
    method: 'getMeasurementDraftAssignments',
    args: [project, { search: 'query', cursor: 'next-page', limit: 25 }],
  },
  {
    name: 'canonry_measurement_draft_groups',
    operation: 'GET /api/v1/projects/{name}/measurement-plan/draft/groups',
    input: { project, search: 'Group', cursor: 'next-page', limit: 25 },
    method: 'getMeasurementDraftGroups',
    args: [project, { search: 'Group', cursor: 'next-page', limit: 25 }],
  },
  {
    name: 'canonry_measurement_query_sets',
    operation: 'GET /api/v1/projects/{name}/measurement-query-sets',
    input: { project },
    method: 'listMeasurementQuerySets',
    args: [project],
  },
  {
    name: 'canonry_measurement_query_set_get',
    operation: 'GET /api/v1/projects/{name}/measurement-query-sets/{setId}',
    input: { project, setId: 'set-a' },
    method: 'getMeasurementQuerySet',
    args: [project, 'set-a'],
  },
  {
    name: 'canonry_measurement_query_templates',
    operation: 'GET /api/v1/projects/{name}/measurement-query-templates',
    input: { project },
    method: 'listMeasurementQueryTemplates',
    args: [project],
  },
] as const

const writeToolCases = [
  {
    name: 'canonry_measurement_draft_action',
    operation: 'POST /api/v1/projects/{name}/measurement-plan/draft/actions/create',
    input: draftActionCases[0].input,
    method: draftActionCases[0].method,
    args: draftActionCases[0].args,
  },
  {
    name: 'canonry_measurement_plan_deactivate',
    operation: 'POST /api/v1/projects/{name}/measurement-plan/actions/deactivate',
    input: { project, expectedActiveRevision: 2, idempotencyKey },
    method: 'deactivateMeasurementPlan',
    args: [project, { expectedActiveRevision: 2 }, idempotencyKey],
  },
  {
    name: 'canonry_measurement_query_set_upsert',
    operation: 'PUT /api/v1/projects/{name}/measurement-query-sets/{setId}',
    input: { project, setId: 'set-a', request: { name: 'Set A', queryIds: ['query-a'] } },
    method: 'upsertMeasurementQuerySet',
    args: [project, 'set-a', { name: 'Set A', queryIds: ['query-a'] }],
  },
  {
    name: 'canonry_measurement_query_set_delete',
    operation: 'DELETE /api/v1/projects/{name}/measurement-query-sets/{setId}',
    input: { project, setId: 'set-a' },
    method: 'deleteMeasurementQuerySet',
    args: [project, 'set-a'],
  },
  {
    name: 'canonry_measurement_query_template_upsert',
    operation: 'PUT /api/v1/projects/{name}/measurement-query-templates/{templateId}',
    input: { project, templateId: 'template-a', request: { name: 'Template A', pattern: 'best {service}', variables: ['service'] } },
    method: 'upsertMeasurementQueryTemplate',
    args: [project, 'template-a', { name: 'Template A', pattern: 'best {service}', variables: ['service'] }],
  },
  {
    name: 'canonry_measurement_query_template_delete',
    operation: 'DELETE /api/v1/projects/{name}/measurement-query-templates/{templateId}',
    input: { project, templateId: 'template-a' },
    method: 'deleteMeasurementQueryTemplate',
    args: [project, 'template-a'],
  },
  {
    name: 'canonry_measurement_query_template_apply',
    operation: 'POST /api/v1/projects/{name}/measurement-query-templates/{templateId}/apply',
    input: {
      project,
      templateId: 'template-a',
      request: { bindings: [{ service: 'analysis' }], querySetId: 'set-a' },
      idempotencyKey,
    },
    method: 'applyMeasurementQueryTemplate',
    args: [project, 'template-a', { bindings: [{ service: 'analysis' }], querySetId: 'set-a' }, idempotencyKey],
  },
] as const

const allToolCases = [...readToolCases, ...writeToolCases]

function toolFor(name: string) {
  const tool = canonryMcpTools.find(candidate => candidate.name === name)
  if (!tool) throw new Error(`Expected MCP registry to contain ${name}`)
  return tool
}

function makeClient() {
  return {
    getMeasurementSetup: vi.fn().mockResolvedValue({}),
    getMeasurementQueryStatuses: vi.fn().mockResolvedValue({}),
    getMeasurementOverview: vi.fn().mockResolvedValue({}),
    getMeasurementPlanDraft: vi.fn().mockResolvedValue({}),
    getMeasurementDraftTargets: vi.fn().mockResolvedValue({}),
    getMeasurementDraftAssignments: vi.fn().mockResolvedValue({}),
    getMeasurementDraftGroups: vi.fn().mockResolvedValue({}),
    listMeasurementQuerySets: vi.fn().mockResolvedValue({}),
    getMeasurementQuerySet: vi.fn().mockResolvedValue({}),
    listMeasurementQueryTemplates: vi.fn().mockResolvedValue({}),
    createMeasurementPlanDraft: vi.fn().mockResolvedValue({}),
    importMeasurementDraftSitemap: vi.fn().mockResolvedValue({}),
    applyMeasurementDraftSitemapSelection: vi.fn().mockResolvedValue({}),
    upsertMeasurementDraftTarget: vi.fn().mockResolvedValue({}),
    renameMeasurementDraftTarget: vi.fn().mockResolvedValue({}),
    mergeMeasurementDraftTargets: vi.fn().mockResolvedValue({}),
    excludeMeasurementDraftTarget: vi.fn().mockResolvedValue({}),
    rebindMeasurementDraftTarget: vi.fn().mockResolvedValue({}),
    applyMeasurementDraftAssignments: vi.fn().mockResolvedValue({}),
    previewMeasurementDraftAssignments: vi.fn().mockResolvedValue({}),
    replaceMeasurementDraftAssignments: vi.fn().mockResolvedValue({}),
    replaceMeasurementDraftQuery: vi.fn().mockResolvedValue({}),
    applyPairedMeasurementDraftAssignments: vi.fn().mockResolvedValue({}),
    removeMeasurementDraftAssignment: vi.fn().mockResolvedValue({}),
    clearMeasurementDraftAssignments: vi.fn().mockResolvedValue({}),
    classifyMeasurementDraftAssignments: vi.fn().mockResolvedValue({}),
    upsertMeasurementDraftGroup: vi.fn().mockResolvedValue({}),
    removeMeasurementDraftGroup: vi.fn().mockResolvedValue({}),
    previewMeasurementDraftGroupMembership: vi.fn().mockResolvedValue({}),
    applyMeasurementDraftGroupMembership: vi.fn().mockResolvedValue({}),
    upsertMeasurementDraftCompetitor: vi.fn().mockResolvedValue({}),
    removeMeasurementDraftCompetitor: vi.fn().mockResolvedValue({}),
    compileMeasurementDraftPreview: vi.fn().mockResolvedValue({}),
    diffMeasurementDraftPreview: vi.fn().mockResolvedValue({}),
    publishMeasurementDraft: vi.fn().mockResolvedValue({}),
    discardMeasurementDraft: vi.fn().mockResolvedValue({}),
    deactivateMeasurementPlan: vi.fn().mockResolvedValue({}),
    upsertMeasurementQuerySet: vi.fn().mockResolvedValue({}),
    deleteMeasurementQuerySet: vi.fn().mockResolvedValue({}),
    upsertMeasurementQueryTemplate: vi.fn().mockResolvedValue({}),
    deleteMeasurementQueryTemplate: vi.fn().mockResolvedValue({}),
    applyMeasurementQueryTemplate: vi.fn().mockResolvedValue({}),
  }
}

describe('Advanced Measurement v2 MCP tools', () => {
  it.each(allToolCases)('registers $name with the expected access and operation', ({ name, operation }) => {
    const tool = toolFor(name)
    const access = readToolCases.some(candidate => candidate.name === name) ? 'read' : 'write'
    expect(tool).toMatchObject({ access, tier: 'setup', openApiOperations: expect.arrayContaining([operation]) })
  })

  it('has exactly nine read tools and seven write tools', () => {
    expect(readToolCases).toHaveLength(10)
    expect(writeToolCases).toHaveLength(7)
    expect(readToolCases.map(({ name }) => toolFor(name).access)).toEqual(Array(10).fill('read'))
    expect(writeToolCases.map(({ name }) => toolFor(name).access)).toEqual(Array(7).fill('write'))
  })

  it.each([...readToolCases, ...writeToolCases.filter(({ name }) => name !== 'canonry_measurement_draft_action')])(
    'forwards parsed input for $name to $method',
    async ({ name, input, method, args }) => {
      const client = makeClient()
      const tool = toolFor(name)
      const parsed = tool.inputSchema.parse(input)

      await tool.handler(client as unknown as ApiClient, parsed)

      expect(client[method]).toHaveBeenCalledOnce()
      expect(client[method]).toHaveBeenCalledWith(...args)
    },
  )

  it.each(draftActionCases)('forwards draft action $action to $method', async ({ input, method, args }) => {
    const client = makeClient()
    const tool = toolFor('canonry_measurement_draft_action')
    const parsed = tool.inputSchema.parse(input)

    await tool.handler(client as unknown as ApiClient, parsed)

    expect(client[method]).toHaveBeenCalledOnce()
    expect(client[method]).toHaveBeenCalledWith(...args)
  })

  it('exposes sort-aware snapshot ranking through the overview tool', async () => {
    const client = makeClient()
    const tool = toolFor('canonry_measurement_overview')
    const parsed = tool.inputSchema.parse({
      project,
      scope: 'all',
      sort: 'mentionCoverage-desc',
    })

    expect(tool.inputSchema.safeParse({ project, scope: 'all', sort: 'citationCoverage' }).success).toBe(false)
    expect(tool.description).toMatch(/one run snapshot only/i)
    expect(tool.description).toMatch(/never infers a trend/i)
    expect(tool.description).toMatch(/unavailable rows form the first bucket/i)
    expect(tool.description).toMatch(/cursor is sort-aware/i)
    expect(tool.description).toMatch(/pins pagination to.*run/i)
    expect(tool.description).toMatch(/legacy label cursors work only when sort is omitted/i)

    await tool.handler(client as unknown as ApiClient, parsed)

    expect(client.getMeasurementOverview).toHaveBeenCalledWith(project, {
      scope: 'all',
      sort: 'mentionCoverage-desc',
    })
  })

  it('keeps draft action headers action-specific', () => {
    const schema = toolFor('canonry_measurement_draft_action').inputSchema

    expect(schema.safeParse({
      project,
      operation: { action: 'create', request: { expectedActiveRevision: null }, idempotencyKey },
    }).success).toBe(true)
    expect(schema.safeParse({
      project,
      operation: { action: 'create', request: { expectedActiveRevision: null }, etag, idempotencyKey },
    }).success).toBe(false)
    expect(schema.safeParse({
      project,
      operation: { action: 'upsert-target', request: { target }, idempotencyKey },
    }).success).toBe(true)
    expect(schema.safeParse({
      project,
      operation: { action: 'upsert-target', request: { target } },
    }).success).toBe(false)
    expect(schema.safeParse({ project, operation: { action: 'compile-preview' } }).success).toBe(true)
    expect(schema.safeParse({ project, operation: { action: 'compile-preview', etag } }).success).toBe(false)
    expect(schema.safeParse({ project, operation: { action: 'diff-preview', idempotencyKey } }).success).toBe(false)
    expect(schema.safeParse({
      project,
      operation: {
        action: 'create',
        request: { expectedActiveRevision: null, expectedCompiledChecksum: checksum },
        idempotencyKey,
      },
    }).success).toBe(false)
  })

  it('forwards an omitted draft ETag for the API to return a distinct 428 error', async () => {
    const client = makeClient()
    const required = Object.assign(new Error('Draft ETag is required.'), {
      code: 'MEASUREMENT_DRAFT_ETAG_REQUIRED',
      statusCode: 428,
    })
    client.upsertMeasurementDraftTarget.mockRejectedValueOnce(required)
    const tool = toolFor('canonry_measurement_draft_action')
    const parsed = tool.inputSchema.parse({
      project,
      operation: { action: 'upsert-target', request: { target }, idempotencyKey },
    })

    await expect(tool.handler(client as unknown as ApiClient, parsed)).rejects.toBe(required)
    expect(client.upsertMeasurementDraftTarget).toHaveBeenCalledWith(project, { target }, idempotencyKey, undefined)
  })

  it('forwards a stale draft ETag for the API to return a distinct 412 error', async () => {
    const client = makeClient()
    const stale = Object.assign(new Error('Draft changed.'), {
      code: 'MEASUREMENT_DRAFT_ETAG_STALE',
      statusCode: 412,
    })
    client.upsertMeasurementDraftTarget.mockRejectedValueOnce(stale)
    const tool = toolFor('canonry_measurement_draft_action')
    const parsed = tool.inputSchema.parse({
      project,
      operation: { action: 'upsert-target', request: { target }, etag: '"mpd_6"', idempotencyKey },
    })

    await expect(tool.handler(client as unknown as ApiClient, parsed)).rejects.toBe(stale)
    expect(client.upsertMeasurementDraftTarget).toHaveBeenCalledWith(project, { target }, idempotencyKey, '"mpd_6"')
  })

  it('does not expose any v2 writes in the read-only catalog', () => {
    const readOnlyNames = new Set(getCanonryMcpTools('read-only').map(tool => tool.name))

    expect(writeToolCases.map(({ name }) => name).filter(name => readOnlyNames.has(name))).toEqual([])
  })
})
