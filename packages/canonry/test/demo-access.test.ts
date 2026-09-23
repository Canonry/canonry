import { describe, expect, it } from 'vitest'
import { isDemoApiReadAllowed, listDemoReadRoutes } from '../src/demo/access.js'

describe('public demo read boundary', () => {
  it.each([
    '/api/v1/projects', '/api/v1/projects/:name/overview',
    '/api/v1/projects/:name/visibility-report', '/api/v1/projects/:name/measurement-property-evidence',
    '/api/v1/projects/:name/google/gsc/performance', '/api/v1/projects/:name/ga/traffic',
    '/api/v1/projects/:name/technical-aeo/graph', '/api/v1/projects/:name/ads/summary',
    '/api/v1/projects/:name/conversion-tracking/contracts/:contractId/integrity',
    '/api/v1/keys/self', '/api/v1/auth/session', '/api/v1/projects/:name/agent/preview',
  ])('allows the stored read %s without opening writes', (route) => {
    expect(isDemoApiReadAllowed('GET', route)).toBe(true)
    expect(isDemoApiReadAllowed('HEAD', route)).toBe(true)
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      expect(isDemoApiReadAllowed(method, route)).toBe(false)
    }
  })

  it.each([
    '/api/v1/projects/:name/ads/account', '/api/v1/projects/:name/ads/live-delivery',
    '/api/v1/projects/:name/ads/geo/search', '/api/v1/projects/:name/ads/conversions/pixels',
    '/api/v1/projects/:name/ads/conversions/event-settings', '/api/v1/projects/:name/google/gsc/sitemaps',
    '/api/v1/projects/:name/google/properties', '/api/v1/projects/:name/ga/properties',
    '/api/v1/projects/:name/bing/sites', '/api/v1/projects/:name/gbp/accounts',
    '/api/v1/projects/:name/doctor', '/api/v1/settings', '/api/v1/keys',
    '/api/v1/auth/login', '/api/v1/auth/users', '/api/v1/mcp', '/api/v1/unknown-future-read',
    '/api/v1/projects/:name/unknown-future-read', '/api/v1/projects/:name/google/callback',
    // The live Aero agent stays closed; only the scripted preview above is a read.
    '/api/v1/projects/:name/agent/transcript', '/api/v1/projects/:name/agent/prompt',
    '/api/v1/projects/:name/agent/providers', '/api/v1/projects/:name/agent/conversations',
    '/api/v1/projects/:name/agent/conversations/:id', '/api/v1/projects/:name/agent/memory',
  ])('refuses live, administrative and unreviewed read %s', (route) => {
    expect(isDemoApiReadAllowed('GET', route)).toBe(false)
  })

  it('refuses missing or misleading route identities', () => {
    expect(isDemoApiReadAllowed('GET', undefined)).toBe(false)
    expect(isDemoApiReadAllowed('GET', '/api/v1/projects/:name/overview/extra')).toBe(false)
    expect(isDemoApiReadAllowed('GET', '/api/v1/projects/:name/overview?x=y')).toBe(false)
  })

  it('lists the audited routes as a copy that cannot widen access', () => {
    const routes = listDemoReadRoutes()
    expect(routes).toContain('/api/v1/projects/:name/technical-aeo/graph')
    expect(routes.every(route => route.startsWith('/api/v1/') && isDemoApiReadAllowed('GET', route))).toBe(true)
    routes.push('/api/v1/settings')
    expect(isDemoApiReadAllowed('GET', '/api/v1/settings')).toBe(false)
    expect(listDemoReadRoutes()).not.toContain('/api/v1/settings')
  })
})
