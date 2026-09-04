import { describe, expect, it } from 'vitest'
import { MCP_OPENAPI_OPERATION_CLASSIFICATIONS } from '../src/mcp/openapi-classification.js'

const advancedMeasurementV2Operations = [
  'GET /api/v1/projects/{name}/measurement-setup',
  'GET /api/v1/projects/{name}/measurement-plan/draft',
  'GET /api/v1/projects/{name}/measurement-plan/draft/targets',
  'GET /api/v1/projects/{name}/measurement-plan/draft/assignments',
  'GET /api/v1/projects/{name}/measurement-plan/draft/groups',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/create',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/import-sitemap',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/apply-sitemap-selection',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/upsert-target',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/rename-target',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/merge-targets',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/exclude-target',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/rebind-target',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/apply-assignments',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/preview-assignments',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/replace-assignments',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/apply-paired-assignments',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/remove-assignment',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/clear-assignments',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/classify-assignments',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/upsert-group',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/remove-group',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/preview-group-membership',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/apply-group-membership',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/upsert-competitor',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/remove-competitor',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/pin-competitor',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/compile-preview',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/diff-preview',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/publish',
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/discard',
  'POST /api/v1/projects/{name}/measurement-plan/actions/deactivate',
  'GET /api/v1/projects/{name}/measurement-overview',
  'GET /api/v1/projects/{name}/measurement-property-evidence',
  'GET /api/v1/projects/{name}/measurement-portfolio-summary',
  'GET /api/v1/projects/{name}/measurement-property-questions',
  'GET /api/v1/projects/{name}/measurement-question-result',
  'GET /api/v1/projects/{name}/measurement-property-competitors',
  'GET /api/v1/projects/{name}/measurement-changes',
  'GET /api/v1/projects/{name}/measurement-data-quality',
  'GET /api/v1/projects/{name}/measurement-query-sets',
  'GET /api/v1/projects/{name}/measurement-query-sets/{setId}',
  'PUT /api/v1/projects/{name}/measurement-query-sets/{setId}',
  'DELETE /api/v1/projects/{name}/measurement-query-sets/{setId}',
  'GET /api/v1/projects/{name}/measurement-query-templates',
  'PUT /api/v1/projects/{name}/measurement-query-templates/{templateId}',
  'DELETE /api/v1/projects/{name}/measurement-query-templates/{templateId}',
  'POST /api/v1/projects/{name}/measurement-query-templates/{templateId}/apply',
] as const

const deferredAdvancedMeasurementV2Operations = new Set<string>([
  // Agents already pin through the generic draft-action tool. Keep the
  // convenience HTTP mutation out of the MCP catalog to avoid two write paths.
  'POST /api/v1/projects/{name}/measurement-plan/draft/actions/pin-competitor',
])

function isAdvancedMeasurementV2Operation(operation: string): boolean {
  return operation.includes('/measurement-setup')
    || operation.includes('/measurement-plan/draft')
    || operation === 'POST /api/v1/projects/{name}/measurement-plan/actions/deactivate'
    || operation.includes('/measurement-overview')
    || operation.includes('/measurement-property-evidence')
    || operation.includes('/measurement-portfolio-summary')
    || operation.includes('/measurement-property-questions')
    || operation.includes('/measurement-question-result')
    || operation.includes('/measurement-property-competitors')
    || operation.includes('/measurement-changes')
    || operation.includes('/measurement-data-quality')
    || operation.includes('/measurement-query-sets')
    || operation.includes('/measurement-query-templates')
}

describe('Advanced Measurement v2 MCP OpenAPI classification', () => {
  it('lists every exposed operation', () => {
    expect(advancedMeasurementV2Operations).toHaveLength(48)

    const classifiedOperations = Object.keys(MCP_OPENAPI_OPERATION_CLASSIFICATIONS)
      .filter(isAdvancedMeasurementV2Operation)
      .sort()

    expect(classifiedOperations).toEqual([...advancedMeasurementV2Operations].sort())
  })

  it.each(advancedMeasurementV2Operations.filter(operation => !deferredAdvancedMeasurementV2Operations.has(operation)))('%s is included', operation => {
    expect(MCP_OPENAPI_OPERATION_CLASSIFICATIONS[operation]).toBe('included')
  })

  it.each([...deferredAdvancedMeasurementV2Operations])('%s is deferred', operation => {
    expect(MCP_OPENAPI_OPERATION_CLASSIFICATIONS[operation]).toBe('deferred')
  })
})
