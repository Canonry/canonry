import { describe, expect, it } from 'vitest'
import { buildOpenApiDocument } from '../src/openapi.js'

describe('agent operations machine contracts', () => {
  it.each([
    ['/api/v1/settings/providers/{name}', 'put', 'ProviderSummaryEntryDto'],
    ['/api/v1/settings/google', 'put', 'IntegrationSettingsSummaryDto'],
    ['/api/v1/telemetry', 'get', 'TelemetryStatusDto'],
    ['/api/v1/telemetry', 'put', 'TelemetryStatusDto'],
    ['/api/v1/operations/logs', 'get', 'OperationalLogListDto'],
  ])('%s %s has a concrete response schema', (path, method, schema) => {
    const doc = buildOpenApiDocument()
    const operation = doc.paths[path]![method] as { responses: Record<string, { content: { 'application/json': { schema: unknown } } }> }
    expect(operation.responses['200']!.content['application/json'].schema).toEqual({ $ref: `#/components/schemas/${schema}` })
    expect(doc.components.schemas).toHaveProperty(schema)
  })
})
