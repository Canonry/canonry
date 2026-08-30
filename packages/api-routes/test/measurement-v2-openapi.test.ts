import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { createClient, migrate } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'

interface SpecParameter {
  name?: string
  in?: string
  required?: boolean
  description?: string
  schema?: { type?: string; enum?: string[]; default?: string }
}

interface SpecOperation {
  description?: string
  parameters?: SpecParameter[]
  requestBody?: { content?: Record<string, { schema?: { $ref?: string } }> }
  responses?: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }>
}

interface Spec {
  components?: { schemas?: Record<string, { properties?: Record<string, unknown>; required?: string[] }> }
  paths: Record<string, Record<string, SpecOperation>>
}

const cleanups: Array<() => void> = []

afterEach(async () => {
  for (const fn of cleanups.splice(0)) fn()
})

async function spec(): Promise<Spec> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-measurement-v2-spec-'))
  cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)

  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  await app.ready()
  cleanups.push(() => void app.close())

  const response = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })
  expect(response.statusCode).toBe(200)
  return response.json() as Spec
}

const DRAFT = '/api/v1/projects/{name}/measurement-plan/draft'
const OVERVIEW = '/api/v1/projects/{name}/measurement-overview'
const QUERY_STATUSES = '/api/v1/projects/{name}/measurement-query-statuses'
const OVERVIEW_SORTS = [
  'label-asc',
  'label-desc',
  'citationCoverage-asc',
  'citationCoverage-desc',
  'mentionCoverage-asc',
  'mentionCoverage-desc',
]

describe('advanced measurement v2 openapi surface', () => {
  it('publishes the typed tracked-query status read', async () => {
    const document = await spec()
    const operation = document.paths[QUERY_STATUSES]?.get

    expect(operation?.responses?.['200']?.content?.['application/json']?.schema?.$ref)
      .toBe('#/components/schemas/MeasurementQueryStatusesResponse')
    expect(JSON.stringify(document.components?.schemas?.MeasurementQueryStatusesResponse))
      .toContain('awaiting_first_sweep')
    const schema = JSON.stringify(document.components?.schemas?.MeasurementQueryStatusesResponse)
    expect(schema).toContain('assignmentScope')
    expect(schema).toContain('activePlanOrphans')
    expect(schema).toContain('advanced_assigned')
    expect(schema).toContain('mixed')
  })

  it('types every draft action against a contract, not a loose object', async () => {
    const document = await spec()
    const cases: Array<[string, string]> = [
      ['create', 'MeasurementDraftCreateRequest'],
      ['import-sitemap', 'MeasurementDraftImportSitemapRequest'],
      ['apply-sitemap-selection', 'MeasurementDraftApplySitemapSelectionRequest'],
      ['upsert-target', 'MeasurementDraftUpsertTargetRequest'],
      ['rename-target', 'MeasurementDraftRenameTargetRequest'],
      ['merge-targets', 'MeasurementDraftMergeTargetsRequest'],
      ['exclude-target', 'MeasurementDraftExcludeTargetRequest'],
      ['rebind-target', 'MeasurementDraftRebindTargetRequest'],
      ['apply-assignments', 'MeasurementDraftApplyAssignmentsRequest'],
      ['preview-assignments', 'MeasurementDraftPreviewAssignmentsRequest'],
      ['replace-assignments', 'MeasurementDraftReplaceAssignmentsRequest'],
      ['replace-query', 'MeasurementDraftReplaceQueryRequest'],
      ['remove-assignment', 'MeasurementDraftRemoveAssignmentRequest'],
      ['clear-assignments', 'MeasurementDraftClearAssignmentsRequest'],
      ['classify-assignments', 'MeasurementDraftClassifyAssignmentsRequest'],
      ['upsert-group', 'MeasurementDraftUpsertGroupRequest'],
      ['remove-group', 'MeasurementDraftRemoveGroupRequest'],
      ['preview-group-membership', 'MeasurementDraftPreviewGroupMembershipRequest'],
      ['apply-group-membership', 'MeasurementDraftApplyGroupMembershipRequest'],
      ['upsert-competitor', 'MeasurementDraftUpsertCompetitorRequest'],
      ['remove-competitor', 'MeasurementDraftRemoveCompetitorRequest'],
      ['publish', 'MeasurementDraftPublishRequest'],
    ]
    for (const [action, schemaName] of cases) {
      const operation = document.paths[`${DRAFT}/actions/${action}`]?.post
      expect(operation, `${action} is not documented`).toBeDefined()
      expect(
        operation!.requestBody?.content?.['application/json']?.schema?.$ref,
        `${action} request body`,
      ).toBe(`#/components/schemas/${schemaName}`)
    }
  })

  it('demands the ETag and idempotency guards on a mutation but not on a preview', async () => {
    const document = await spec()
    const headers = (action: string) => (document.paths[`${DRAFT}/actions/${action}`]?.post?.parameters ?? [])
      .filter(parameter => parameter.in === 'header')
      .map(parameter => `${parameter.name}:${parameter.required === true}`)
      .sort()

    expect(headers('publish')).toEqual(['Idempotency-Key:true', 'If-Match:true'])
    expect(headers('upsert-target')).toEqual(['Idempotency-Key:true', 'If-Match:true'])
    // Creating a draft has no draft ETag yet, but it is still idempotent.
    expect(headers('create')).toEqual(['Idempotency-Key:true'])
    expect(document.paths[`${DRAFT}/actions/create`]?.post?.responses?.['412']).toBeUndefined()
    expect(document.paths[`${DRAFT}/actions/create`]?.post?.responses?.['428']).toBeUndefined()
    // Compiling the stored draft writes nothing, so it carries neither guard.
    expect(headers('compile-preview')).toEqual([])
    expect(headers('diff-preview')).toEqual([])
    expect(headers('preview-assignments')).toEqual([])
    expect(headers('preview-group-membership')).toEqual([])
    expect(headers('replace-assignments')).toEqual(['Idempotency-Key:true', 'If-Match:true'])
    expect(headers('replace-query')).toEqual(['Idempotency-Key:true', 'If-Match:true'])
    expect(headers('apply-group-membership')).toEqual(['Idempotency-Key:true', 'If-Match:true'])
  })

  it('documents the bounded CSV transport and typed preview/apply responses', async () => {
    const document = await spec()
    const preview = document.paths[`${DRAFT}/actions/preview-group-membership`]?.post
    const apply = document.paths[`${DRAFT}/actions/apply-group-membership`]?.post

    expect(preview?.responses?.['200']?.content?.['application/json']?.schema?.$ref)
      .toBe('#/components/schemas/MeasurementDraftPreviewGroupMembershipResponse')
    expect(apply?.responses?.['200']?.content?.['application/json']?.schema?.$ref)
      .toBe('#/components/schemas/MeasurementDraftApplyGroupMembershipResponse')
    expect(preview?.responses?.['413']).toBeDefined()
    expect(apply?.responses?.['413']).toBeDefined()
    expect(preview?.responses?.['429']).toBeDefined()
    expect(document.paths[`${DRAFT}/actions/preview-assignments`]?.post?.responses?.['429']).toBeDefined()
  })

  it('types a query replacement as a new catalog identity rather than a generic rename', async () => {
    const document = await spec()
    const operation = document.paths[`${DRAFT}/actions/replace-query`]?.post

    expect(operation?.responses?.['200']?.content?.['application/json']?.schema?.$ref)
      .toBe('#/components/schemas/MeasurementDraftReplaceQueryResponse')
    const request = document.components?.schemas?.MeasurementDraftReplaceQueryRequest
    const response = document.components?.schemas?.MeasurementDraftReplaceQueryResponse
    expect(request?.required).toEqual(expect.arrayContaining(['queryId', 'queryText']))
    expect(response?.required).toEqual(expect.arrayContaining(['previousQueryId', 'replacementQuery']))
  })

  it('documents draft creation as idempotency-only while ordinary mutations require the draft ETag', async () => {
    const document = await spec()
    const operation = (action: string) => document.paths[`${DRAFT}/actions/${action}`]?.post
    const headers = (action: string) => (operation(action)?.parameters ?? [])
      .filter(parameter => parameter.in === 'header')
      .map(parameter => `${parameter.name}:${parameter.required === true}`)
      .sort()
    const errorStatuses = (action: string) => Object.keys(operation(action)?.responses ?? {})
      .filter(status => Number(status) >= 400)
      .sort()

    expect.soft(headers('create')).toEqual(['Idempotency-Key:true'])
    expect.soft(errorStatuses('create')).toEqual(['400', '403', '404', '409'])

    expect.soft(headers('upsert-target')).toEqual(['Idempotency-Key:true', 'If-Match:true'])
    expect.soft(errorStatuses('upsert-target')).toEqual(['400', '403', '404', '409', '412', '428'])
  })

  it('types active and revision-detail plan reads as schema v1 or v2', async () => {
    const document = await spec()
    const active = JSON.stringify(document.components?.schemas?.MeasurementPlanResponse)
    const detail = JSON.stringify(document.components?.schemas?.MeasurementPlanVersionResponse)

    for (const schema of [active, detail]) {
      expect(schema).toContain('"enum":[1]')
      expect(schema).toContain('"enum":[2]')
    }
  })

  it('publishes the compiled checksum on every contract that reviews or guards content', async () => {
    const document = await spec()
    const compile = document.components?.schemas?.MeasurementDraftCompilePreviewResponse
    const publishRequest = document.components?.schemas?.MeasurementDraftPublishRequest
    const publishResponse = document.components?.schemas?.MeasurementPlanV2PublishResponse

    expect(JSON.stringify(compile)).toContain('compiledChecksum')
    expect(publishRequest?.required).toEqual(
      expect.arrayContaining(['expectedActiveRevision', 'expectedCompiledChecksum']),
    )
    expect(JSON.stringify(publishResponse)).toContain('compiledChecksum')
  })

  it('documents atomic Property cleanup and complete group replacement', async () => {
    const document = await spec()
    const excludeSchema = document.components?.schemas?.MeasurementDraftExcludeTargetRequest
    const groupSchema = document.components?.schemas?.MeasurementDraftUpsertGroupRequest
    const group = groupSchema?.properties?.group as {
      properties?: Record<string, unknown>
      required?: string[]
    } | undefined

    expect(JSON.stringify(excludeSchema)).toContain('assignments-and-group-memberships')
    expect(excludeSchema?.required).not.toContain('cleanup')
    expect(group?.properties).toHaveProperty('competitors')
    expect(group?.required).not.toContain('competitors')
  })

  it('emits brandPresence and documents sov as its deprecated alias', async () => {
    const document = await spec()
    const overview = document.components?.schemas?.MeasurementOverviewResponse
    const metrics = overview?.properties?.metrics as {
      required?: string[]
      properties?: Record<string, { description?: string }>
    } | undefined

    expect(metrics?.required).toEqual(expect.arrayContaining(['brandPresence', 'sov']))
    expect(metrics?.properties?.sov?.description).toMatch(/deprecated/i)
  })

  it('documents the cross-revision run rejection on the overview', async () => {
    const document = await spec()
    const overview = document.paths[OVERVIEW]?.get
    const runId = overview?.parameters?.find(parameter => parameter.name === 'runId')

    expect(runId).toMatchObject({ in: 'query' })
    expect(overview?.responses?.['422']).toBeDefined()
    expect(overview?.responses?.['200']?.content?.['application/json']?.schema?.$ref)
      .toBe('#/components/schemas/MeasurementOverviewResponse')
  })

  it('exposes sort-aware snapshot ranking without implying a trend', async () => {
    const document = await spec()
    const overview = document.paths[OVERVIEW]?.get
    const sort = overview?.parameters?.find(parameter => parameter.name === 'sort')
    const cursor = overview?.parameters?.find(parameter => parameter.name === 'cursor')

    expect(sort).toMatchObject({
      in: 'query',
      schema: { type: 'string', enum: OVERVIEW_SORTS, default: 'label-asc' },
    })
    expect(sort?.description).toMatch(/unavailable rows form the first bucket/i)
    expect(overview?.description).toMatch(/one revision-pinned run snapshot/i)
    expect(overview?.description).toMatch(/never infers a trend/i)
    expect(overview?.description).toMatch(/across revisions/i)
    expect(cursor?.description).toMatch(/sort-aware/i)
    expect(cursor?.description).toMatch(/pins pagination to.*run/i)
    expect(cursor?.description).toMatch(/same filters/i)
    expect(cursor?.description).toMatch(/legacy label cursor works only when sort is omitted/i)
  })
})
