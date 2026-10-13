import net from 'node:net'
import { describe, expect, test, vi } from 'vitest'
import { resolveMeasurementSitemapTarget, type MeasurementSitemapAddress } from '../src/measurement-sitemap-fetch.js'
import { resolveWebhookTarget } from '../src/webhooks.js'
import {
  BLOCKED_ADDRESSES,
  LOOPBACK_ADDRESSES,
  NOT_LOOPBACK_ADDRESSES,
  PUBLIC_ADDRESSES,
  literalHost,
} from './egress-address-fixture.js'

/**
 * Both outbound gates refuse exactly the same addresses. The webhook gate also
 * guards WordPress, traffic sources, site fetches and the site audit, so an
 * address one gate refuses and the other dials is a way around the policy.
 */

type Resolver = (hostname: string) => Promise<readonly MeasurementSitemapAddress[]>

const WEBHOOK_REFUSAL = '"url" must not resolve to a private or loopback address'

/**
 * Each gate with the refusal it gives for a refused address, so a refusal for
 * another reason (a name that does not resolve, a malformed URL) never passes.
 */
const GATES = [
  {
    name: 'webhook gate',
    resolve: (url: string, resolveAddresses?: Resolver) => resolveWebhookTarget(url, { resolveAddresses }),
    refusal: () => ({ ok: false, message: WEBHOOK_REFUSAL, blocked: true }),
  },
  {
    name: 'public-fetch gate',
    resolve: (url: string, resolveAddresses?: Resolver) => resolveMeasurementSitemapTarget(url, { resolveAddresses }),
    refusal: (hostname: string) => ({ ok: false, message: expect.stringContaining(`${hostname} resolves to `) as string }),
  },
] as const

function addressOf(value: string): MeasurementSitemapAddress {
  const family = net.isIP(value)
  if (family !== 4 && family !== 6) throw new Error(`${value} is not an IP literal`)
  return { address: value, family }
}

describe.each(GATES)('the $name', ({ resolve, refusal }) => {
  test.each(BLOCKED_ADDRESSES)('refuses the literal %s', async (address) => {
    const resolveAddresses = vi.fn<Resolver>()
    const url = new URL(`https://${literalHost(address)}/hook`)
    expect(await resolve(url.href, resolveAddresses)).toEqual(refusal(url.hostname.replace(/^\[|\]$/g, '')))
    expect(resolveAddresses).not.toHaveBeenCalled()
  })

  test.each(BLOCKED_ADDRESSES)('refuses a hostname that resolves to %s', async (address) => {
    expect(await resolve('https://lookalike.example.test/hook', async () => [addressOf(address)]))
      .toEqual(refusal('lookalike.example.test'))
  })

  test.each(PUBLIC_ADDRESSES)('admits the literal %s and pins it', async (address) => {
    const result = await resolve(`https://${literalHost(address)}/hook`)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The URL parser writes every IPv6 literal in its canonical form.
    expect(result.target.address).toBe(new URL(`https://${literalHost(address)}/`).hostname.replace(/^\[|\]$/g, ''))
    expect(result.target.family).toBe(net.isIP(address))
  })

  test('admits a hostname whose only AAAA is DNS64-synthesized for a public IPv4 host', async () => {
    const result = await resolve('https://ipv4-only.example.test/hook', async () => [{ address: '64:ff9b::808:808', family: 6 }])
    expect(result).toMatchObject({ ok: true, target: { address: '64:ff9b::808:808', family: 6 } })
    if (result.ok) expect(result.target.url.host).toBe('ipv4-only.example.test')
  })

  test('refuses a hostname whose DNS64 AAAA carries the metadata address, even beside a public A record', async () => {
    expect(await resolve('https://rebind.example.test/hook', async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '64:ff9b::a9fe:a9fe', family: 6 },
    ])).toEqual(refusal('rebind.example.test'))
  })
})

test('the webhook gate never names the refused address', async () => {
  expect(await resolveWebhookTarget('https://rebind.example.test/hook', {
    resolveAddresses: async () => [{ address: '64:ff9b::a9fe:a9fe', family: 6 }],
  })).toEqual({ ok: false, message: WEBHOOK_REFUSAL, blocked: true })
})

test('the public-fetch gate names the IPv4 address a NAT64 address carries', async () => {
  expect(await resolveMeasurementSitemapTarget('https://rebind.example.test/sitemap.xml', {
    resolveAddresses: async () => [{ address: '64:ff9b::a9fe:a9fe', family: 6 }],
  })).toEqual({
    ok: false,
    message: 'rebind.example.test resolves to 64:ff9b::a9fe:a9fe, which is the NAT64 form of 169.254.169.254',
  })
})

describe('allowLoopback', () => {
  test.each(LOOPBACK_ADDRESSES)('admits %s only when asked to', async (address) => {
    const url = `http://${literalHost(address)}/hook`
    expect(await resolveWebhookTarget(url)).toEqual({ ok: false, message: WEBHOOK_REFUSAL, blocked: true })
    expect(await resolveWebhookTarget(url, { allowLoopback: true })).toMatchObject({ ok: true })
  })

  test.each(NOT_LOOPBACK_ADDRESSES)('still refuses %s', async (address) => {
    const url = `http://${literalHost(address)}/hook`
    expect(await resolveWebhookTarget(url)).toEqual({ ok: false, message: WEBHOOK_REFUSAL, blocked: true })
    expect(await resolveWebhookTarget(url, { allowLoopback: true })).toEqual({ ok: false, message: WEBHOOK_REFUSAL, blocked: true })
  })

  test('admits a hostname that resolves to loopback, and nothing that resolves beside it', async () => {
    const loopbackOnly = async () => [{ address: '::1', family: 6 as const }]
    expect(await resolveWebhookTarget('http://localhost.example.test/hook', { allowLoopback: true, resolveAddresses: loopbackOnly }))
      .toMatchObject({ ok: true, target: { address: '::1', family: 6 } })
    expect(await resolveWebhookTarget('http://localhost.example.test/hook', {
      allowLoopback: true,
      resolveAddresses: async () => [{ address: '127.0.0.1', family: 4 }, { address: '10.0.0.1', family: 4 }],
    })).toEqual({ ok: false, message: WEBHOOK_REFUSAL, blocked: true })
  })
})
