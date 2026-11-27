import { describe, expect, it } from 'vitest'
import {
  AGENT_READINESS_PATH_SEGMENT,
  AGENT_READINESS_PATH_SEGMENTS,
  LEGACY_AGENT_READINESS_PATH_SEGMENT,
  legacyAgentReadinessPath,
  withLegacyAgentReadinessPaths,
} from '../src/index.js'

describe('Agent Readiness path segments', () => {
  it('lists the canonical segment before its deprecated alias', () => {
    expect(AGENT_READINESS_PATH_SEGMENTS).toEqual([AGENT_READINESS_PATH_SEGMENT, LEGACY_AGENT_READINESS_PATH_SEGMENT])
    expect(AGENT_READINESS_PATH_SEGMENTS).toEqual(['agent-readiness', 'technical-aeo'])
  })
})

describe('legacyAgentReadinessPath', () => {
  it('maps canonical operation keys, OpenAPI templates and Fastify patterns', () => {
    expect(legacyAgentReadinessPath('GET /api/v1/projects/{name}/agent-readiness'))
      .toBe('GET /api/v1/projects/{name}/technical-aeo')
    expect(legacyAgentReadinessPath('/api/v1/projects/{name}/agent-readiness/runs/{runId}/progress'))
      .toBe('/api/v1/projects/{name}/technical-aeo/runs/{runId}/progress')
    expect(legacyAgentReadinessPath('/api/v1/projects/:name/agent-readiness/crawl/pages'))
      .toBe('/api/v1/projects/:name/technical-aeo/crawl/pages')
  })

  it('ignores paths whose project segment is not exactly agent-readiness', () => {
    expect(legacyAgentReadinessPath('/api/v1/projects/{name}/agent-readiness-extra')).toBeUndefined()
    expect(legacyAgentReadinessPath('/api/v1/projects/{name}/technical-aeo')).toBeUndefined()
    expect(legacyAgentReadinessPath('/api/v1/agent-readiness')).toBeUndefined()
    expect(legacyAgentReadinessPath('/api/v1/projects/{name}/queries')).toBeUndefined()
  })
})

describe('withLegacyAgentReadinessPaths', () => {
  it('follows each Agent Readiness path with its twin and passes other paths through once', () => {
    expect(withLegacyAgentReadinessPaths([
      'GET /api/v1/projects/{name}/seo/status',
      'GET /api/v1/projects/{name}/agent-readiness/trend',
      'POST /api/v1/projects/{name}/agent-readiness/runs',
    ])).toEqual([
      'GET /api/v1/projects/{name}/seo/status',
      'GET /api/v1/projects/{name}/agent-readiness/trend',
      'GET /api/v1/projects/{name}/technical-aeo/trend',
      'POST /api/v1/projects/{name}/agent-readiness/runs',
      'POST /api/v1/projects/{name}/technical-aeo/runs',
    ])
  })
})
