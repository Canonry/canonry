import { describe, expect, it, vi } from 'vitest'
import {
  lookupSiteAddresses,
  probeSiteReachability,
  type SiteAddressLookup,
  type SiteReachabilityResult,
  type SiteStatusResponse,
} from '../src/site-reachability.js'
import { probeHostFromDomain, SITE_REACHABILITY_CHECKS, SITE_REACHABILITY_CHECK_ID } from '../src/doctor/checks/site-reachability.js'
import { ALL_CHECKS } from '../src/doctor/registry.js'
import { runChecks } from '../src/doctor/runner.js'
import type { DoctorContext } from '../src/doctor/types.js'

// "Down" has to mean down. Three things that are NOT an outage each have a test
// here, because each of them would otherwise page every project at once or page
// a site that is serving people: our own resolver failing, one dead address out
// of several, and a certificate chain a browser accepts.

const PUBLIC_V4 = '93.184.216.34'
const PUBLIC_V4_ALT = '93.184.216.35'
const addresses = (...list: string[]): SiteAddressLookup => ({ kind: 'addresses', addresses: list.map(address => ({ address, family: 4 as const })) })
const publicLookup = async (): Promise<SiteAddressLookup> => addresses(PUBLIC_V4)

type Scripted = SiteStatusResponse | Error
function transportFor(script: Record<string, Scripted[]>) {
  const calls: Array<{ url: string; address: string; lenient: boolean }> = []
  const transport = vi.fn(async (target: { url: URL; address: string }, _ms: number, opts?: { lenient?: boolean }) => {
    const key = `${opts?.lenient ? 'lenient ' : ''}${target.url.toString()}@${target.address}`
    calls.push({ url: target.url.toString(), address: target.address, lenient: opts?.lenient === true })
    const queue = script[key] ?? script[target.url.toString()]
    if (!queue || queue.length === 0) throw new Error(`unscripted request to ${key}`)
    const next = queue.length > 1 ? queue.shift()! : queue[0]!
    if (next instanceof Error) throw next
    return next
  })
  return { transport, calls }
}
const noSleep = vi.fn(async () => {})
const ok = (status: number, location: string | null = null): SiteStatusResponse => ({ status, location })
const coded = (code: string, message = code): Error => Object.assign(new Error(message), { code })
const probe = (url: string, opts: Parameters<typeof probeSiteReachability>[1]) =>
  probeSiteReachability(url, { resolveAddresses: publicLookup, sleep: noSleep, ...opts })

describe('probeSiteReachability', () => {
  it('is up on a normal answer', async () => {
    const { transport } = transportFor({ 'https://client.example/': [ok(200)] })
    expect(await probe('https://client.example/', { transport })).toMatchObject({ state: 'up', httpStatus: 200, attempts: 1 })
  })

  it('counts a bot challenge as up, because the site is serving people', async () => {
    for (const status of [403, 429, 404]) {
      const { transport } = transportFor({ 'https://client.example/': [ok(status)] })
      expect(await probe('https://client.example/', { transport })).toMatchObject({ state: 'up', httpStatus: status })
    }
  })

  it('follows a redirect to www and reports where it landed', async () => {
    const { transport } = transportFor({
      'https://client.example/': [ok(301, 'https://www.client.example/')],
      'https://www.client.example/': [ok(200)],
    })
    expect(await probe('https://client.example/', { transport })).toMatchObject({ state: 'up', finalUrl: 'https://www.client.example/' })
  })

  it('follows the multi-hop chains real sites use, not just three', async () => {
    const { transport } = transportFor({
      'https://client.example/': [ok(301, 'https://www.client.example/')],
      'https://www.client.example/': [ok(302, 'https://www.client.example/en-us')],
      'https://www.client.example/en-us': [ok(301, 'https://www.client.example/en-us/')],
      'https://www.client.example/en-us/': [ok(302, 'https://www.client.example/en-us/home')],
      'https://www.client.example/en-us/home': [ok(200)],
    })
    expect(await probe('https://client.example/', { transport })).toMatchObject({ state: 'up', httpStatus: 200 })
  })

  it('is down on a redirect loop that never lands', async () => {
    const { transport } = transportFor({
      'https://client.example/': [ok(302, 'https://client.example/a')],
      'https://client.example/a': [ok(302, 'https://client.example/')],
    })
    expect(await probe('https://client.example/', { transport, maxRedirects: 4 })).toMatchObject({ state: 'down', reason: 'more than 4 redirects' })
  })

  it('only calls a site down when a second attempt agrees', async () => {
    const { transport, calls } = transportFor({ 'https://client.example/': [ok(503), ok(200)] })
    const sleep = vi.fn(async () => {})
    expect(await probe('https://client.example/', { transport, sleep, retryDelayMs: 1234 })).toMatchObject({ state: 'up', attempts: 2 })
    expect(sleep).toHaveBeenCalledWith(1234)
    expect(calls).toHaveLength(2)
  })

  it('is down on a server error that repeats', async () => {
    const { transport } = transportFor({ 'https://client.example/': [ok(502)] })
    expect(await probe('https://client.example/', { transport })).toMatchObject({ state: 'down', httpStatus: 502, reason: 'HTTP 502', attempts: 2 })
  })

  it('tries every approved address before calling it down, the way a browser fails over', async () => {
    const { transport, calls } = transportFor({
      [`https://client.example/@${PUBLIC_V4}`]: [coded('ECONNREFUSED')],
      [`https://client.example/@${PUBLIC_V4_ALT}`]: [ok(200)],
    })
    const result = await probe('https://client.example/', { transport, resolveAddresses: async () => addresses(PUBLIC_V4, PUBLIC_V4_ALT) })
    expect(result).toMatchObject({ state: 'up', attempts: 1 })
    expect(calls.map(c => c.address)).toEqual([PUBLIC_V4, PUBLIC_V4_ALT])
  })

  it('accepts a certificate chain a browser accepts, and records why', async () => {
    const { transport, calls } = transportFor({
      [`https://client.example/@${PUBLIC_V4}`]: [coded('UNABLE_TO_VERIFY_LEAF_SIGNATURE')],
      [`lenient https://client.example/@${PUBLIC_V4}`]: [ok(200)],
    })
    const result = await probe('https://client.example/', { transport })
    expect(result).toMatchObject({ state: 'up', httpStatus: 200 })
    expect((result as Extract<SiteReachabilityResult, { state: 'up' }>).lenient).toContain('UNABLE_TO_VERIFY_LEAF_SIGNATURE')
    expect(calls.filter(c => c.lenient)).toHaveLength(1)
  })

  it('is down when the name has no address at all', async () => {
    const { transport } = transportFor({})
    expect(await probe('https://client.example/', { transport, resolveAddresses: async () => ({ kind: 'no-such-host', reason: 'client.example has no DNS address (ENOTFOUND)' }) }))
      .toMatchObject({ state: 'down', reason: 'client.example has no DNS address (ENOTFOUND)' })
    expect(transport).not.toHaveBeenCalled()
  })

  it('never blames the site when OUR resolver is the thing that failed', async () => {
    const { transport } = transportFor({})
    expect(await probe('https://client.example/', { transport, resolveAddresses: async () => ({ kind: 'resolver-error', reason: 'DNS lookup for client.example failed (ECONNREFUSED)' }) }))
      .toMatchObject({ state: 'unavailable' })
    expect(transport).not.toHaveBeenCalled()
  })

  it('fails, without dialing, a name that resolves only to addresses the policy refuses', async () => {
    const { transport } = transportFor({})
    expect(await probe('https://client.example/', { transport, resolveAddresses: async () => addresses('10.0.0.5', '127.0.0.1') }))
      .toMatchObject({ state: 'unreachable' })
    expect(transport).not.toHaveBeenCalled()
  })

  it('re-checks every redirect hop against the policy', async () => {
    const { transport } = transportFor({ 'https://client.example/': [ok(302, 'http://169.254.169.254/latest/meta-data/')] })
    const resolveAddresses = async (hostname: string): Promise<SiteAddressLookup> =>
      hostname === '169.254.169.254' ? addresses('169.254.169.254') : addresses(PUBLIC_V4)
    expect(await probe('https://client.example/', { transport, resolveAddresses })).toMatchObject({ state: 'unreachable' })
  })
})

describe('lookupSiteAddresses', () => {
  it('returns an address literal without asking a resolver', async () => {
    expect(await lookupSiteAddresses(PUBLIC_V4)).toEqual({ kind: 'addresses', addresses: [{ address: PUBLIC_V4, family: 4 }] })
  })

  it('separates a name with no address from a resolver that did not answer', async () => {
    const missing = await lookupSiteAddresses('nxdomain.invalid')
    expect(missing.kind).toBe('no-such-host')
  })
})

describe('probeHostFromDomain', () => {
  it('keeps www, which hostOf would have stripped', () => {
    expect(probeHostFromDomain('https://www.client.example')).toBe('www.client.example')
    expect(probeHostFromDomain('www.client.example')).toBe('www.client.example')
  })

  it('accepts the raw forms the project upsert and apply can store', () => {
    expect(probeHostFromDomain('client.example')).toBe('client.example')
    expect(probeHostFromDomain('http://client.example/path?x=1')).toBe('client.example')
    expect(probeHostFromDomain('  CLIENT.Example.  ')).toBe('client.example')
  })

  it('refuses anything that is not a probeable hostname', () => {
    for (const value of ['acme', '', '   ', 'localhost', 'box.localhost', null, undefined]) {
      expect(probeHostFromDomain(value)).toBeNull()
    }
  })
})

describe('site.reachability check', () => {
  const check = SITE_REACHABILITY_CHECKS.find(c => c.id === SITE_REACHABILITY_CHECK_ID)!
  const project = { id: 'p1', name: 'client', canonicalDomain: 'client.example', displayName: 'Client' }
  const withProbe = (result: SiteReachabilityResult, overrides: Partial<DoctorContext> = {}): DoctorContext => ({
    db: {} as DoctorContext['db'],
    project,
    probeSiteReachability: async () => result,
    ...overrides,
  })

  it('probes the https homepage of the stored domain', async () => {
    const seen: string[] = []
    const result = await check.run({
      db: {} as DoctorContext['db'],
      project: { ...project, canonicalDomain: 'https://www.client.example' },
      probeSiteReachability: async (url) => { seen.push(url); return { state: 'up', url, finalUrl: url, httpStatus: 200, attempts: 1, durationMs: 80 } },
    })
    expect(seen).toEqual(['https://www.client.example/'])
    expect(result).toMatchObject({ status: 'ok', code: 'site.reachability.up' })
  })

  it('fails with the reason when the site is down', async () => {
    const result = await check.run(withProbe({ state: 'down', url: 'https://client.example/', finalUrl: 'https://client.example/', httpStatus: 503, reason: 'HTTP 503', attempts: 2, durationMs: 2100 }))
    expect(result).toMatchObject({ status: 'fail', code: 'site.reachability.down' })
    expect(result.summary).toContain('HTTP 503')
  })

  it('fails a sinkholed domain instead of going quiet about it', async () => {
    const result = await check.run(withProbe({ state: 'unreachable', url: 'https://client.example/', finalUrl: 'https://client.example/', reason: 'client.example resolves to 127.0.0.1, a loopback address', attempts: 2, durationMs: 40 }))
    expect(result).toMatchObject({ status: 'fail', code: 'site.reachability.refused-address' })
  })

  it('skips, never fails, when this host could not run the probe', async () => {
    expect(await check.run(withProbe({ state: 'unavailable', url: 'https://client.example/', reason: 'DNS lookup failed (ESERVFAIL)' })))
      .toMatchObject({ status: 'skipped', code: 'site.reachability.probe-unavailable' })
  })

  it('skips without probing when there is no project or no probeable domain', async () => {
    const probeSpy = vi.fn()
    expect(await check.run({ db: {} as DoctorContext['db'], project: null, probeSiteReachability: probeSpy }))
      .toMatchObject({ status: 'skipped', code: 'site.reachability.no-project' })
    expect(await check.run({ db: {} as DoctorContext['db'], project: { ...project, canonicalDomain: 'acme' }, probeSiteReachability: probeSpy }))
      .toMatchObject({ status: 'skipped', code: 'site.reachability.no-domain' })
    expect(probeSpy).not.toHaveBeenCalled()
  })

  it('stays out of an unfiltered doctor pass and runs only when named', async () => {
    const ctx = withProbe({ state: 'up', url: 'https://client.example/', finalUrl: 'https://client.example/', httpStatus: 200, attempts: 1, durationMs: 10 })
    const ran = async (checkIds?: string[]) =>
      (await runChecks(ctx, ALL_CHECKS, checkIds ? { checkIds } : {})).checks.some(c => c.id === SITE_REACHABILITY_CHECK_ID)
    expect(await ran()).toBe(false)
    expect(await ran([SITE_REACHABILITY_CHECK_ID])).toBe(true)
    expect(await ran(['site.*'])).toBe(true)
  })
})
