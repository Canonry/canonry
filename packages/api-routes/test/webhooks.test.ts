import dns from 'node:dns/promises'
import { afterEach, test, expect, vi } from 'vitest'
import { resolveWebhookTarget } from '../src/webhooks.js'

afterEach(() => {
  vi.restoreAllMocks()
})

test('resolveWebhookTarget rejects private and unspecified literal addresses', async () => {
  for (const url of [
    'http://10.0.0.5/hook',
    'http://192.168.1.10/hook',
    'http://0.0.0.0/hook',
    'http://[fc00::1]/hook',
    'http://[::]/hook',
  ]) {
    const result = await resolveWebhookTarget(url)
    expect(result.ok).toBe(false)
  }
})

test('resolveWebhookTarget rejects loopback literal addresses by default', async () => {
  for (const url of [
    'http://127.0.0.1/hook',
    'http://127.255.255.254/hook',
    'http://[::1]/hook',
    // IPv4-mapped IPv6 loopback
    'http://[::ffff:127.0.0.1]/hook',
  ]) {
    const result = await resolveWebhookTarget(url)
    expect(result.ok, `expected ${url} to be blocked`).toBe(false)
  }
})

test('resolveWebhookTarget accepts loopback when allowLoopback is true', async () => {
  for (const [url, address] of [
    ['http://127.0.0.1/hook', '127.0.0.1'],
    ['http://[::1]/hook', '::1'],
  ] as const) {
    const result = await resolveWebhookTarget(url, { allowLoopback: true })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.target.address).toBe(address)
    }
  }
})

test('resolveWebhookTarget accepts public literal addresses', async () => {
  const result = await resolveWebhookTarget('https://8.8.8.8/hook')
  expect(result.ok).toBe(true)
  if (result.ok) {
    expect(result.target.address).toBe('8.8.8.8')
  }
})

// The DNS queries the gate makes never read the hosts file, and on macOS they
// answer `localhost` with ENOTFOUND. A local WordPress (wp-env) links and
// redirects to http://localhost:8888, so the name must reach loopback anyway.
test.each([
  'http://localhost:8888/about/',
  'http://LOCALHOST./hook',
  'http://wp.localhost/hook',
])('resolveWebhookTarget answers %s as loopback without asking DNS', async (url) => {
  const notFound = Object.assign(new Error('queryA ENOTFOUND'), { code: 'ENOTFOUND' })
  const resolve4 = vi.spyOn(dns, 'resolve4').mockRejectedValue(notFound)
  const resolve6 = vi.spyOn(dns, 'resolve6').mockRejectedValue(notFound)

  expect(await resolveWebhookTarget(url, { allowLoopback: true }))
    .toMatchObject({ ok: true, target: { address: '127.0.0.1', family: 4 } })
  expect(await resolveWebhookTarget(url))
    .toEqual({ ok: false, message: '"url" must not resolve to a private or loopback address' })
  expect(resolve4).not.toHaveBeenCalled()
  expect(resolve6).not.toHaveBeenCalled()
})
