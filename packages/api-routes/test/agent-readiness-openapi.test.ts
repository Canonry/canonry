import { describe, expect, it } from 'vitest'
import { OperationAccesses, legacyAgentReadinessPath, matchOperationTemplate, operationAccess } from '@canonry/canonry-contracts'
import { buildOpenApiDocument } from '../src/openapi.js'

interface DocumentedOperation {
  operationId?: string
  deprecated?: boolean
  tags?: string[]
  summary?: string
  description?: string
  parameters?: unknown
  requestBody?: unknown
  responses?: unknown
  'x-canonry-access'?: string
}

const paths = buildOpenApiDocument().paths as Record<string, Record<string, DocumentedOperation>>
const canonicalPaths = Object.entries(paths).filter(([path]) => path.includes('/agent-readiness'))
const operationsAt = (entries: Array<[string, Record<string, DocumentedOperation>]>) =>
  entries.flatMap(([path, methods]) => Object.keys(methods).map(method => `${method.toUpperCase()} ${path}`))

describe('Agent Readiness OpenAPI operations', () => {
  it('documents all twenty operations at the canonical agent-readiness path', () => {
    expect(operationsAt(canonicalPaths)).toHaveLength(20)
    for (const [, methods] of canonicalPaths) {
      for (const operation of Object.values(methods)) {
        expect(operation.deprecated).toBeUndefined()
        expect(operation.tags).toEqual(['agent-readiness'])
        expect(`${operation.summary} ${operation.description ?? ''}`).not.toMatch(/Site Health|Technical AEO|Page Health/)
      }
    }
  })

  it('keeps each technical-aeo path as a deprecated twin with the same contract', () => {
    for (const [path, methods] of canonicalPaths) {
      const legacyPath = legacyAgentReadinessPath(path)
      expect(legacyPath, path).toBe(path.replace('/agent-readiness', '/technical-aeo'))
      for (const [method, operation] of Object.entries(methods)) {
        const twin = paths[legacyPath!]?.[method]
        expect(twin, `${method.toUpperCase()} ${legacyPath}`).toBeDefined()
        expect(twin!.deprecated).toBe(true)
        expect(twin!.parameters).toEqual(operation.parameters)
        expect(twin!.requestBody).toEqual(operation.requestBody)
        expect(twin!.responses).toEqual(operation.responses)
        expect(twin!['x-canonry-access']).toBe(operation['x-canonry-access'])
        expect(twin!.operationId).not.toBe(operation.operationId)
        expect(twin!.description).toContain(`${method.toUpperCase()} ${path}`)
      }
    }
    const legacyEntries = Object.entries(paths).filter(([path]) => path.includes('/technical-aeo'))
    expect(operationsAt(legacyEntries)).toHaveLength(20)
  })

  it('classifies both segments with the same access and matches concrete URLs to their own template', () => {
    for (const segment of ['agent-readiness', 'technical-aeo']) {
      expect(operationAccess('GET', `/api/v1/projects/{name}/${segment}/crawl/pages`)).toBe(OperationAccesses.stored)
      expect(operationAccess('GET', `/api/v1/projects/{name}/${segment}/runs/{runId}/page-health-preview`)).toBe(OperationAccesses.stored)
      expect(operationAccess('POST', `/api/v1/projects/{name}/${segment}/runs`)).toBe(OperationAccesses.write)
      expect(matchOperationTemplate('GET', `/api/v1/projects/acme/${segment}/runs/run-1/progress`))
        .toBe(`GET /api/v1/projects/{name}/${segment}/runs/{runId}/progress`)
    }
  })
})
