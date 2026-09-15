import { describe, expect, it, vi } from 'vitest'
import {
  probeSiteReachability,
  type SiteHopResolution,
  type SiteReachabilityResult,
  type SiteStatusResponse,
} from '../src/site-reachability.js'
import { SITE_REACHABILITY_CHECKS, SITE_REACHABILITY_CHECK_ID } from '../src/doctor/checks/site-reachability.js'
import type { DoctorContext } from '../src/doctor/types.js'

// "Down" has to mean down. A page for a site that was serving people, or a
// probe that could be pointed at this host's own network, would each teach
// operators to distrust the channel. These pin both edges.

const publicHop = async (url: string): Promise<SiteHopResolution> =>
  ({ ok: true, target: { url: new URL(url), address: '93.184.216.34', family: 4 } })

type Scripted = SiteStatusResponse | Error
function scriptedTransport(script: Record<string, Scripted[]>) {
  const calls: string[] = []
  const transport = vi.fn(async (target: { url: URL }) => {
    const key = target.url.toString()
    calls.push(key)
    const queue = script[key]
    if (!queue || queue.length === 0) throw new Error(`unscripted request to ${key}`)
    const next = queue.length > 1 ? queue.shift()! : queue[0]!
    if (next instanceof Error) throw next
    return next
  })
  return { transport, calls }
}
const noSleep = vi.fn(async () => {})
const ok = (status: number, location: string | null = null): SiteStatusResponse => ({ status, location })

describe('probeSiteReachability', () => {
  it('is up on a normal answer', async () => {
    const { transport } = scriptedTransport({ 'https://client.example/': [ok(200)] })
    const result = await probeSiteReachability('https://client.example/', { resolveHop: publicHop, transport, sleep: noSleep })
    expect(result).toMatchObject({ state: 'up', httpStatus: 200, attempts: 1 })
  })

  it('counts a bot challenge as up, because the site is serving people', async () => {
    for (const status of [403, 429, 404]) {
      const { transport } = scriptedTransport({ 'https://client.example/': [ok(status)] })
      expect(await probeSiteReachability('https://client.example/', { resolveHop: publicHop, transport, sleep: noSleep }))
        .toMatchObject({ state: 'up', httpStatus: status })
    }
  })

  it('follows a redirect to www and reports where it landed', async () => {
    const { transport } = scriptedTransport({
      'https://client.example/': [ok(301, 'https://www.client.example/')],
      'https://www.client.example/': [ok(200)],
    })
    expect(await probeSiteReachability('https://client.example/', { resolveHop: publicHop, transport, sleep: noSleep }))
      .toMatchObject({ state: 'up', finalUrl: 'https://www.client.example/' })
  })

  it('only calls a site down when a second attempt agrees', async () => {
    const { transport, calls } = scriptedTransport({ 'https://client.example/': [ok(503), ok(200)] })
    const sleep = vi.fn(async () => {})
    const result = await probeSiteReachability('https://client.example/', { resolveHop: publicHop, transport, sleep, retryDelayMs: 1234 })
    expect(result).toMatchObject({ state: 'up', attempts: 2 })
    expect(sleep).toHaveBeenCalledWith(1234)
    expect(calls).toHaveLength(2)
  })

  it('is down on a server error that repeats', async () => {
    const { transport } = scriptedTransport({ 'https://client.example/': [ok(502)] })
    expect(await probeSiteReachability('https://client.example/', { resolveHop: publicHop, transport, sleep: noSleep }))
      .toMatchObject({ state: 'down', httpStatus: 502, reason: 'HTTP 502', attempts: 2 })
  })

  it('is down when nothing answers, and says why', async () => {
    const { transport } = scriptedTransport({ 'https://client.example/': [new Error('connect ECONNREFUSED 93.184.216.34:443')] })
    const result = await probeSiteReachability('https://client.example/', { resolveHop: publicHop, transport, sleep: noSleep })
    expect(result).toMatchObject({ state: 'down', httpStatus: null, attempts: 2 })
    expect((result as Extract<SiteReachabilityResult, { state: 'down' }>).reason).toContain('ECONNREFUSED')
  })

  it('is down on a redirect loop', async () => {
    const { transport } = scriptedTransport({
      'https://client.example/': [ok(302, 'https://client.example/a')],
      'https://client.example/a': [ok(302, 'https://client.example/')],
    })
    expect(await probeSiteReachability('https://client.example/', { resolveHop: publicHop, transport, sleep: noSleep, maxRedirects: 3 }))
      .toMatchObject({ state: 'down', reason: 'more than 3 redirects' })
  })

  it('is down when the name no longer resolves', async () => {
    const { transport } = scriptedTransport({})
    const resolveHop = async (): Promise<SiteHopResolution> => ({ ok: false, message: 'client.example does not resolve', unresolved: true })
    expect(await probeSiteReachability('https://client.example/', { resolveHop, transport, sleep: noSleep }))
      .toMatchObject({ state: 'down', reason: 'client.example does not resolve' })
    expect(transport).not.toHaveBeenCalled()
  })

  it('never dials an address the egress policy refuses, and does not call that down', async () => {
    const { transport } = scriptedTransport({})
    const resolveHop = async (): Promise<SiteHopResolution> => ({ ok: false, message: 'client.example resolves to 10.0.0.5, a private address', unresolved: false })
    expect(await probeSiteReachability('https://client.example/', { resolveHop, transport, sleep: noSleep }))
      .toMatchObject({ state: 'blocked' })
    expect(transport).not.toHaveBeenCalled()
  })

  it('re-checks every redirect hop against the policy', async () => {
    const { transport } = scriptedTransport({ 'https://client.example/': [ok(302, 'http://169.254.169.254/latest/meta-data/')] })
    const resolveHop = async (url: string): Promise<SiteHopResolution> => url.includes('169.254')
      ? { ok: false, message: '169.254.169.254 is link-local', unresolved: false }
      : publicHop(url)
    expect(await probeSiteReachability('https://client.example/', { resolveHop, transport, sleep: noSleep }))
      .toMatchObject({ state: 'blocked' })
  })
})

describe('site.reachability check', () => {
  const check = SITE_REACHABILITY_CHECKS.find(c => c.id === SITE_REACHABILITY_CHECK_ID)!
  const project = { id: 'p1', name: 'client', canonicalDomain: 'client.example', displayName: 'Client' }
  const ctx = (result: SiteReachabilityResult | (() => never), overrides: Partial<DoctorContext> = {}): DoctorContext => ({
    db: {} as DoctorContext['db'],
    project,
    probeSiteReachability: typeof result === 'function' ? result : async () => result,
    ...overrides,
  })

  it('probes the https homepage of the project domain', async () => {
    const probe = vi.fn(async (url: string): Promise<SiteReachabilityResult> => ({ state: 'up', url, finalUrl: url, httpStatus: 200, attempts: 1, durationMs: 80 }))
    const result = await check.run({ db: {} as DoctorContext['db'], project, probeSiteReachability: probe })
    expect(probe).toHaveBeenCalledWith('https://client.example/')
    expect(result).toMatchObject({ status: 'ok', code: 'site.reachability.up' })
  })

  it('fails with the reason when the site is down', async () => {
    const result = await check.run(ctx({ state: 'down', url: 'https://client.example/', finalUrl: 'https://client.example/', httpStatus: 503, reason: 'HTTP 503', attempts: 2, durationMs: 2100 }))
    expect(result).toMatchObject({ status: 'fail', code: 'site.reachability.down', details: { httpStatus: 503, attempts: 2 } })
    expect(result.summary).toContain('HTTP 503')
  })

  it('skips, rather than fails, a domain the egress policy will not probe', async () => {
    expect(await check.run(ctx({ state: 'blocked', url: 'https://client.example/', reason: 'resolves to 10.0.0.5, a private address' })))
      .toMatchObject({ status: 'skipped', code: 'site.reachability.blocked-address' })
  })

  it('skips without probing when there is no project', async () => {
    const probe = vi.fn()
    expect(await check.run({ db: {} as DoctorContext['db'], project: null, probeSiteReachability: probe }))
      .toMatchObject({ status: 'skipped', code: 'site.reachability.no-project' })
    expect(probe).not.toHaveBeenCalled()
  })
})
