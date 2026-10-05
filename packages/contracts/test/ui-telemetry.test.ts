import { describe, expect, it } from 'vitest'
import {
  isUiApiRouteTemplate,
  uiPageFromRoutePath,
  uiProjectTabFromPage,
  uiTelemetryEventSchema,
} from '../src/ui-telemetry.js'

const ids = { eventId: '30ed4717-c740-433f-9d37-05421e3f1a75', uiSessionId: '02db91c9-98d6-4826-b2cf-a9d4bec84768' }

describe('uiTelemetryEventSchema', () => {
  it('accepts each event shape', () => {
    for (const event of [
      { ...ids, event: 'ui.page_viewed', page: '/projects/:projectName/report', tab: 'report' },
      { ...ids, event: 'ui.action', page: '/projects/:projectName/settings', action: 'integration.connect', integration: 'ga' },
      { ...ids, event: 'ui.error', page: '/runs', kind: 'api', route: '/api/v1/projects/{name}/runs', method: 'POST', statusClass: '5xx', status: 503 },
      { ...ids, event: 'ui.error', page: '/', kind: 'render', component: 'root', errorName: 'TypeError' },
      { ...ids, event: 'ui.vitals', page: '/', metric: 'LCP', rating: 'good' },
    ]) {
      expect(uiTelemetryEventSchema.safeParse(event).success, JSON.stringify(event)).toBe(true)
    }
  })

  it('rejects free text, real paths, unknown keys and unknown enums', () => {
    for (const event of [
      { ...ids, event: 'ui.page_viewed', page: '/projects/acme-co/report' },
      { ...ids, event: 'ui.action', page: '/', action: 'clicked the blue button' },
      { ...ids, event: 'ui.error', page: '/', kind: 'render', message: 'Cannot read property x of undefined' },
      { ...ids, event: 'ui.error', page: '/', kind: 'render', errorName: 'Cannot read property' },
      { ...ids, event: 'ui.error', page: '/', kind: 'api', route: '/api/v1/projects/acme-co/runs' },
      { ...ids, event: 'ui.error', page: '/', kind: 'api', route: '/api/v1/runs/30ed4717-c740-433f-9d37-05421e3f1a75' },
      { ...ids, event: 'ui.error', page: '/', kind: 'render', component: 'Root Layout!' },
      { ...ids, event: 'ui.vitals', page: '/', metric: 'LCP', rating: 'good', value: 2400 },
      { event: 'ui.page_viewed', page: '/' },
    ]) {
      expect(uiTelemetryEventSchema.safeParse(event).success, JSON.stringify(event)).toBe(false)
    }
  })
})

describe('page and tab normalization', () => {
  it('maps router patterns to pages without ever carrying a real name', () => {
    expect(uiPageFromRoutePath('/projects/$projectName/')).toBe('/projects/:projectName')
    expect(uiPageFromRoutePath('/projects/$projectName/search-console')).toBe('/projects/:projectName/search-console')
    expect(uiPageFromRoutePath('/traffic/$projectName/$sourceId')).toBe('/traffic/:projectName/:sourceId')
    expect(uiPageFromRoutePath('/')).toBe('/')
    expect(uiPageFromRoutePath('*')).toBe('not-found')
    expect(uiPageFromRoutePath('/*')).toBe('not-found')
    expect(uiPageFromRoutePath('/$')).toBe('not-found')
    expect(uiPageFromRoutePath('/projects/acme-co')).toBe('other')
    expect(uiPageFromRoutePath(undefined)).toBe('other')
  })

  it('derives the project tab', () => {
    expect(uiProjectTabFromPage('/projects/:projectName')).toBe('overview')
    expect(uiProjectTabFromPage('/projects/:projectName/properties/:targetKey')).toBe('properties')
    expect(uiProjectTabFromPage('/runs')).toBeUndefined()
  })

  it('tells a route template from a real path', () => {
    expect(isUiApiRouteTemplate('/api/v1/projects/{name}/queries/generate')).toBe(true)
    expect(isUiApiRouteTemplate('/api/v1/runs/{id}/cancel')).toBe(true)
    expect(isUiApiRouteTemplate('/api/v1/projects/acme/queries')).toBe(false)
    expect(isUiApiRouteTemplate('https://evil.example/api/v1/x')).toBe(false)
  })
})
