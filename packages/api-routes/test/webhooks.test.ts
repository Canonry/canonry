import dns from 'node:dns/promises'
import { afterEach, test, expect, vi } from 'vitest'
import { deliverWebhook, resolveWebhookTarget } from '../src/webhooks.js'
import { startRecordingSite, type RecordingSite } from './recording-site-fixture.js'

let receiver: RecordingSite | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  await receiver?.close()
  receiver = undefined
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

// `localhost` checks as 127.0.0.1 and ::1, and a dev receiver started with
// `listen(port, 'localhost')` binds only one of them (::1 on macOS), so a
// delivery that dials only the first address never arrives.
test('deliverWebhook falls back to the next checked address when the first refuses the connection', async () => {
  // The receiver listens on 127.0.0.1 only, so the first address (::1)
  // refuses the connection, or is unreachable on a host without IPv6.
  receiver = await startRecordingSite((_request, response) => response.writeHead(204).end())
  const check = await resolveWebhookTarget(`http://hooks.example.test:${receiver.port}/hook`, {
    allowLoopback: true,
    resolveAddresses: async () => [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }],
  })
  if (!check.ok) throw new Error(check.message)

  expect(await deliverWebhook(check.target, { event: 'run.completed' }, null)).toEqual({ status: 204, error: null })
  expect(receiver.requests.map(({ method, path, headers, body }) => ({ method, path, host: headers.host, body }))).toEqual([
    { method: 'POST', path: '/hook', host: `hooks.example.test:${receiver.port}`, body: '{"event":"run.completed"}' },
  ])
})
