import net from 'node:net'
import { expect, test, vi } from 'vitest'
import {
  fetchMeasurementSitemap,
  type MeasurementSitemapAddress,
  type MeasurementSitemapHttpResponse,
  type MeasurementSitemapTransport,
} from '../src/measurement-sitemap-fetch.js'
import { BLOCKED_ADDRESSES, literalHost } from './egress-address-fixture.js'

/**
 * The import endpoint dereferences an operator-supplied URL from a host that
 * sits beside internal services, so every rejection class in §0.4 is asserted
 * here rather than inferred from the happy path.
 */

const PUBLIC_ADDRESS: MeasurementSitemapAddress = { address: '198.51.100.10', family: 4 }
const allowPublic = async (): Promise<MeasurementSitemapAddress[]> => [PUBLIC_ADDRESS]
const xml = (body: string): MeasurementSitemapHttpResponse => ({ status: 200, headers: {}, body: Buffer.from(body) })
const urlset = xml('<urlset><url><loc>https://public.example.test/a</loc></url></urlset>')

function addressOf(value: string): MeasurementSitemapAddress {
  const family = net.isIP(value)
  if (family !== 4 && family !== 6) throw new Error(`${value} is not an IP literal`)
  return { address: value, family }
}

test.each(BLOCKED_ADDRESSES)('refuses %s as a literal sitemap host', async (address) => {
  const transport = vi.fn<MeasurementSitemapTransport>()

  await expect(fetchMeasurementSitemap(`http://${literalHost(address)}/sitemap.xml`, { transport }))
    .rejects.toThrow('Sitemap URL rejected')
  expect(transport).not.toHaveBeenCalled()
})

test.each(BLOCKED_ADDRESSES)('refuses a hostname that resolves to %s', async (address) => {
  const transport = vi.fn<MeasurementSitemapTransport>()

  await expect(fetchMeasurementSitemap('http://lookalike.example.test/sitemap.xml', {
    transport,
    resolveAddresses: async () => [addressOf(address)],
  })).rejects.toThrow('Sitemap URL rejected')
  expect(transport).not.toHaveBeenCalled()
})

/** Obfuscated spellings the URL parser folds back to a blocked address before it ever reaches DNS. */
test.each([
  ['http://2130706433/sitemap.xml', 'decimal loopback'],
  ['http://0x7f.0.0.1/sitemap.xml', 'hex-prefixed loopback'],
  ['http://0177.0.0.1/sitemap.xml', 'octal loopback'],
])('refuses %s (%s)', async (raw) => {
  const transport = vi.fn<MeasurementSitemapTransport>()
  await expect(fetchMeasurementSitemap(raw, { transport })).rejects.toThrow('Sitemap URL rejected')
  expect(transport).not.toHaveBeenCalled()
})

/**
 * A resolver may answer with a zone id attached, and `net.isIPv6` accepts one
 * that contains colons. Left on, that text is read as further address groups
 * and shifts the bytes the prefix rules inspect — `2001::1%…` stops looking
 * like Teredo — so the zone is cut off before the address is classified.
 */
test.each([
  ['fe80::1%eth0', 'which is link-local'],
  ['2001::1%0:0:0:0:0:0:0', 'which is a Teredo tunnel'],
])('reads %s past its zone id and refuses it as %s', async (address, reason) => {
  const transport = vi.fn<MeasurementSitemapTransport>()

  await expect(fetchMeasurementSitemap('https://scoped.example.test/sitemap.xml', {
    transport,
    resolveAddresses: async () => [{ address, family: 6 }],
  })).rejects.toThrow(`Sitemap URL rejected: scoped.example.test resolves to ${address}, ${reason}`)
  expect(transport).not.toHaveBeenCalled()
})

test('refuses a hostname when any one of its addresses is blocked', async () => {
  const transport = vi.fn<MeasurementSitemapTransport>()

  await expect(fetchMeasurementSitemap('https://split.example.test/sitemap.xml', {
    transport,
    resolveAddresses: async () => [PUBLIC_ADDRESS, { address: '10.1.2.3', family: 4 }],
  })).rejects.toThrow('Sitemap URL rejected')
  expect(transport).not.toHaveBeenCalled()
})

test('refuses a hostname that resolves to nothing', async () => {
  const transport = vi.fn<MeasurementSitemapTransport>()

  await expect(fetchMeasurementSitemap('https://missing.example.test/sitemap.xml', {
    transport,
    resolveAddresses: async () => [],
  })).rejects.toThrow('Sitemap URL rejected')
  expect(transport).not.toHaveBeenCalled()
})

test.each([
  'ftp://public.example.test/sitemap.xml',
  'file:///etc/passwd',
  'gopher://public.example.test/sitemap.xml',
  'data:text/xml,<urlset/>',
])('refuses the non-http scheme in %s before resolving anything', async (raw) => {
  const transport = vi.fn<MeasurementSitemapTransport>()
  const resolveAddresses = vi.fn(allowPublic)

  await expect(fetchMeasurementSitemap(raw, { transport, resolveAddresses })).rejects.toThrow('Sitemap URL rejected')
  expect(resolveAddresses).not.toHaveBeenCalled()
  expect(transport).not.toHaveBeenCalled()
})

test.each([
  'https://operator:secret@public.example.test/sitemap.xml',
  'https://operator@public.example.test/sitemap.xml',
  'https://:secret@public.example.test/sitemap.xml',
])('refuses embedded credentials in %s', async (raw) => {
  const transport = vi.fn<MeasurementSitemapTransport>()
  const resolveAddresses = vi.fn(allowPublic)

  await expect(fetchMeasurementSitemap(raw, { transport, resolveAddresses })).rejects.toThrow('Sitemap URL rejected')
  expect(resolveAddresses).not.toHaveBeenCalled()
  expect(transport).not.toHaveBeenCalled()
})

test('connects to the address it validated rather than to the hostname', async () => {
  const transport = vi.fn<MeasurementSitemapTransport>(async () => urlset)

  await fetchMeasurementSitemap('https://public.example.test/sitemap.xml', {
    transport,
    resolveAddresses: async () => [PUBLIC_ADDRESS],
  })

  const [target] = transport.mock.calls[0]!
  expect(target.address).toBe('198.51.100.10')
  expect(target.family).toBe(4)
  // The Host header and TLS name still carry the operator's hostname, so
  // pinning the socket to the checked address does not change what is served.
  expect(target.url.host).toBe('public.example.test')
})

/**
 * The rebinding case: the first lookup answers public and the second answers a
 * tailnet address. Pinning means the answer that was checked is the answer that
 * is dialled, and the later answer is refused rather than followed.
 */
test('never dials an address a later lookup substitutes', async () => {
  const answers: MeasurementSitemapAddress[][] = [[PUBLIC_ADDRESS], [{ address: '10.7.0.1', family: 4 }]]
  const dialled: string[] = []
  const transport = vi.fn<MeasurementSitemapTransport>(async (target) => {
    dialled.push(target.address)
    return { status: 302, headers: { location: 'https://public.example.test/moved.xml' }, body: Buffer.alloc(0) }
  })

  await expect(fetchMeasurementSitemap('https://public.example.test/sitemap.xml', {
    transport,
    resolveAddresses: async () => answers.shift() ?? [],
  })).rejects.toThrow('Sitemap URL rejected')
  expect(dialled).toEqual(['198.51.100.10'])
})

test.each([
  ['https://10.0.0.5/sitemap.xml', 'a private hop'],
  ['file:///etc/passwd', 'a scheme change'],
  ['https://operator:secret@public.example.test/sitemap.xml', 'credentials'],
])('re-runs every rule on a redirect to %s (%s)', async (location) => {
  const transport = vi.fn<MeasurementSitemapTransport>(async () => ({
    status: 301,
    headers: { location },
    body: Buffer.alloc(0),
  }))

  await expect(fetchMeasurementSitemap('https://public.example.test/sitemap.xml', {
    transport,
    resolveAddresses: allowPublic,
  })).rejects.toThrow('Sitemap URL rejected')
  expect(transport).toHaveBeenCalledOnce()
})

/**
 * `file:` carries no host, so it is refused for that before its scheme is ever
 * weighed. The hop that pins the resolver's scheme check has to name a host the
 * resolver would otherwise have been willing to look up and dial.
 */
test('refuses a redirect to a host-bearing non-http scheme', async () => {
  const resolveAddresses = vi.fn(allowPublic)
  const transport = vi.fn<MeasurementSitemapTransport>(async () => ({
    status: 301,
    headers: { location: 'gopher://public.example.test/sitemap.xml' },
    body: Buffer.alloc(0),
  }))

  await expect(fetchMeasurementSitemap('https://public.example.test/sitemap.xml', { transport, resolveAddresses }))
    .rejects.toThrow('Sitemap URL rejected: gopher:// is not http or https')
  // One lookup and one request, both for the first hop: the scheme settles the
  // redirect before either happens again.
  expect(resolveAddresses).toHaveBeenCalledOnce()
  expect(transport).toHaveBeenCalledOnce()
})

test('follows three redirects and refuses the fourth', async () => {
  const hops: string[] = []
  const transport = vi.fn<MeasurementSitemapTransport>(async (target) => {
    hops.push(target.url.pathname)
    return { status: 302, headers: { location: `/hop-${hops.length}.xml` }, body: Buffer.alloc(0) }
  })

  await expect(fetchMeasurementSitemap('https://public.example.test/sitemap.xml', {
    transport,
    resolveAddresses: allowPublic,
  })).rejects.toThrow('Sitemap redirect count exceeds the maximum of 3')
  expect(hops).toEqual(['/sitemap.xml', '/hop-1.xml', '/hop-2.xml', '/hop-3.xml'])
})
