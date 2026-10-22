import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PROVIDER_ROUTE_FAMILIES,
  isConcreteProviderName,
  isRouteAvailable,
  OPENROUTER_ROUTE_FAMILY,
  profileRouteFamily,
  providerRouteName,
  resolveProviderRoute,
  routeConnectionName,
  routeFamiliesOf,
} from '../src/provider-routes.js'
import { adapterConnectionName, isProviderAvailable, isSweepProvider, providerConnectionName } from '../src/provider.js'

const service = profileRouteFamily('acme-answers', ['fast', 'deep'])
const families = [...DEFAULT_PROVIDER_ROUTE_FAMILIES, service]

describe('provider route families', () => {
  it('resolves a profile route to its connection and keeps the bare connection out of measurement', () => {
    expect(resolveProviderRoute('acme-answers:deep', families)).toMatchObject({ connection: 'acme-answers', selection: 'deep' })
    expect(routeConnectionName('acme-answers:deep', families)).toBe('acme-answers')
    expect(isConcreteProviderName('acme-answers:deep', families)).toBe(true)
    expect(isConcreteProviderName('acme-answers', families)).toBe(false)
    // A profile the descriptor does not declare is a malformed route, never a target.
    expect(isConcreteProviderName('acme-answers:turbo', families)).toBe(false)
    expect(resolveProviderRoute('acme-answers:turbo', families)).toBeUndefined()
  })

  it('makes a route available only through its configured connection', () => {
    expect(isRouteAvailable('acme-answers:fast', ['gemini', 'acme-answers'], families)).toBe(true)
    expect(isRouteAvailable('acme-answers:fast', ['gemini'], families)).toBe(false)
    expect(isRouteAvailable('gemini', ['gemini'], families)).toBe(true)
  })

  it('builds route names only for declared selections', () => {
    expect(providerRouteName(service, 'fast')).toBe('acme-answers:fast')
    expect(() => providerRouteName(service, 'turbo')).toThrow('not a valid profile')
    expect(providerRouteName(OPENROUTER_ROUTE_FAMILY, 'google/gemini-2.5-flash')).toBe('openrouter:google/gemini-2.5-flash')
  })

  it('collects families from adapters with OpenRouter always first and no duplicates', () => {
    const collected = routeFamiliesOf([{ routes: service }, {}, { routes: OPENROUTER_ROUTE_FAMILY }])
    expect(collected.map(family => family.connection)).toEqual(['openrouter', 'acme-answers'])
    expect(routeFamiliesOf(undefined).map(family => family.connection)).toEqual(['openrouter'])
  })

  it('reads a registered adapter connection from the family it declares', () => {
    expect(adapterConnectionName({ name: 'acme-answers:deep', routes: service })).toBe('acme-answers')
    expect(adapterConnectionName({ name: 'openrouter:google/gemini-2.5-flash' })).toBe('openrouter')
    expect(adapterConnectionName({ name: 'gemini' })).toBe('gemini')
  })
})

describe('compat helpers without families keep their OpenRouter-only behavior', () => {
  // Existing callers pass no families; every answer must match what they returned before.
  it.each([
    ['gemini', true, 'gemini'],
    ['openrouter', false, 'openrouter'],
    ['openrouter:google/gemini-2.5-flash', true, 'openrouter'],
    ['openrouter:openrouter/auto', false, 'openrouter:openrouter/auto'],
    ['cdp:chatgpt', true, 'cdp:chatgpt'],
    ['acme-answers:deep', true, 'acme-answers:deep'],
  ])('%s', (name, sweep, connection) => {
    expect(isSweepProvider(name)).toBe(sweep)
    expect(providerConnectionName(name)).toBe(connection)
  })

  it('treats an unknown family route as a plain name until its family is passed', () => {
    expect(isProviderAvailable('acme-answers:deep', ['acme-answers'])).toBe(false)
    expect(isProviderAvailable('acme-answers:deep', ['acme-answers'], families)).toBe(true)
    expect(isSweepProvider('acme-answers')).toBe(true)
    expect(isSweepProvider('acme-answers', families)).toBe(false)
  })
})
