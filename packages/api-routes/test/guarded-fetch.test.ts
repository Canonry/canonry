import type { AddressInfo } from 'node:net'
import tls from 'node:tls'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createGuardedFetch, EgressFailedError, EgressRefusedError, GUARDED_FETCH_MAX_REDIRECTS } from '../src/guarded-fetch.js'
import { resolveWebhookTarget, type ResolveWebhookTargetResult } from '../src/webhooks.js'
import { startRecordingSite, type RecordingSite } from './recording-site-fixture.js'

/**
 * Every test talks to a real socket. `site.example.test` never resolves in
 * real DNS, so a request that reaches the fixture under that name proves the
 * connection went to the address the policy checked.
 */
const PUBLIC_SITE = 'site.example.test'

/**
 * Treats the fixture as the public site `site.example.test` and judges every
 * other hop by the real policy, with loopback refused as on a cloud deployment.
 */
async function publicFixturePolicy(url: string): Promise<ResolveWebhookTargetResult> {
  const parsed = new URL(url)
  if (parsed.hostname === PUBLIC_SITE) return { ok: true, target: { url: parsed, address: '127.0.0.1', family: 4 } }
  return resolveWebhookTarget(url)
}

let site: RecordingSite | undefined
let otherSite: RecordingSite | undefined

afterEach(async () => {
  await site?.close()
  await otherSite?.close()
  site = undefined
  otherSite = undefined
})

describe('createGuardedFetch', () => {
  test('dials the checked address and follows a same-origin redirect with its credentials', async () => {
    site = await startRecordingSite((request, response) => {
      if (request.path === '/wp-json') {
        response.writeHead(301, { Location: '/wp-json/' }).end()
        return
      }
      response.writeHead(200, { 'Content-Type': 'text/plain' }).end('routes')
    })
    const guardedFetch = createGuardedFetch({ resolveTarget: publicFixturePolicy })

    const response = await guardedFetch(`http://${PUBLIC_SITE}:${site.port}/wp-json`, {
      headers: { Authorization: 'Basic d3A6cGFzcw==' },
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('routes')
    expect(site.requests.map(({ path, headers }) => ({ path, host: headers.host, authorization: headers.authorization }))).toEqual([
      { path: '/wp-json', host: `${PUBLIC_SITE}:${site.port}`, authorization: 'Basic d3A6cGFzcw==' },
      { path: '/wp-json/', host: `${PUBLIC_SITE}:${site.port}`, authorization: 'Basic d3A6cGFzcw==' },
    ])
  })

  test('offers the hostname, not the pinned address, as the TLS server name', async () => {
    // The endpoint records the server name the client offers and ends the
    // handshake right there, so no certificate is needed to see it.
    const offered: string[] = []
    const server = tls.createServer({
      SNICallback: (servername, callback) => {
        offered.push(servername)
        callback(new Error('the fixture ends the handshake'))
      },
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo

    try {
      await expect(createGuardedFetch({ resolveTarget: publicFixturePolicy })(`https://${PUBLIC_SITE}:${port}/`)).rejects.toThrow()
      expect(offered).toEqual([PUBLIC_SITE])
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test('refuses a first hop the policy refuses without dialing it', async () => {
    site = await startRecordingSite((_request, response) => response.writeHead(200).end('internal'))

    await expect(createGuardedFetch()(`http://127.0.0.1:${site.port}/`))
      .rejects.toThrow(new EgressRefusedError(`Refused to connect to 127.0.0.1:${site.port}: must not resolve to a private or loopback address`))
    expect(site.requests).toEqual([])
  })

  test.each([
    ['an IPv4 loopback literal', (port: number) => `http://127.0.0.1:${port}/internal`, 'must not resolve to a private or loopback address'],
    ['an IPv6 loopback literal', (port: number) => `http://[::1]:${port}/internal`, 'must not resolve to a private or loopback address'],
    ['the unspecified address, which reaches this host', (port: number) => `http://0.0.0.0:${port}/internal`, 'must not resolve to a private or loopback address'],
    ['the metadata address', () => 'http://169.254.169.254/latest/meta-data/', 'must not resolve to a private or loopback address'],
    ['a file URL', () => 'file:///etc/passwd', 'must use http or https scheme'],
  ])('refuses a redirect to %s without dialing it', async (_name, location, reason) => {
    site = await startRecordingSite((request, response, port) => {
      if (request.path === '/start') {
        response.writeHead(302, { Location: location(port) }).end()
        return
      }
      response.writeHead(200).end('internal')
    })
    const guardedFetch = createGuardedFetch({ resolveTarget: publicFixturePolicy })

    const refused = guardedFetch(`http://${PUBLIC_SITE}:${site.port}/start`)

    await expect(refused).rejects.toBeInstanceOf(EgressRefusedError)
    await expect(refused).rejects.toThrow(reason)
    expect(site.requests.map(({ path }) => path)).toEqual(['/start'])
  })

  test('reports a name with no address as a failure to reach the site, not a refusal', async () => {
    const guardedFetch = createGuardedFetch({
      resolveTarget: (url) => resolveWebhookTarget(url, { resolveAddresses: async () => [] }),
    })

    const failed = guardedFetch('https://gone.example.test:8443/wp-json/')

    await expect(failed).rejects.toBeInstanceOf(EgressFailedError)
    await expect(failed).rejects.toThrow('Could not resolve gone.example.test')
  })

  test('checks the name again on every request, so a name that rebinds to private space is refused', async () => {
    site = await startRecordingSite((_request, response) => response.writeHead(200).end('ok'))
    const answers = [{ address: '127.0.0.1', family: 4 as const }, { address: '10.0.0.5', family: 4 as const }]
    const guardedFetch = createGuardedFetch({
      resolveTarget: (url) => resolveWebhookTarget(url, { allowLoopback: true, resolveAddresses: async () => [answers.shift()!] }),
    })

    expect((await guardedFetch(`http://${PUBLIC_SITE}:${site.port}/a`)).status).toBe(200)
    await expect(guardedFetch(`http://${PUBLIC_SITE}:${site.port}/b`))
      .rejects.toThrow(new EgressRefusedError(`Refused to connect to ${PUBLIC_SITE}:${site.port}: must not resolve to a private or loopback address`))
    expect(site.requests.map(({ path }) => path)).toEqual(['/a'])
  })

  test('falls back to the next checked address when the first does not answer', async () => {
    // The fixture listens on 127.0.0.1 only, so the name's first address
    // (::1) refuses the connection, or is unreachable on a host without IPv6.
    site = await startRecordingSite((_request, response) => response.writeHead(200).end('ok'))
    const guardedFetch = createGuardedFetch({
      resolveTarget: (url) => resolveWebhookTarget(url, {
        allowLoopback: true,
        resolveAddresses: async () => [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }],
      }),
    })

    const response = await guardedFetch(`http://${PUBLIC_SITE}:${site.port}/dual-stack`)

    expect(await response.text()).toBe('ok')
    expect(site.requests.map(({ path, headers }) => ({ path, host: headers.host }))).toEqual([
      { path: '/dual-stack', host: `${PUBLIC_SITE}:${site.port}` },
    ])
  })

  test('drops credentials on a cross-origin redirect and keeps the method and body of a 307', async () => {
    otherSite = await startRecordingSite((_request, response) => response.writeHead(200).end('landed'))
    const landing = `http://127.0.0.1:${otherSite.port}/landing`
    site = await startRecordingSite((_request, response) => response.writeHead(307, { Location: landing }).end())
    const guardedFetch = createGuardedFetch({ allowLoopback: true })

    const response = await guardedFetch(`http://127.0.0.1:${site.port}/start`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic d3A6cGFzcw==',
        Cookie: 'session=1',
        'Proxy-Authorization': 'Basic cHJveHk=',
        'Content-Type': 'application/json',
      },
      body: '{"a":1}',
    })

    expect(await response.text()).toBe('landed')
    expect(site.requests[0]!.headers.authorization).toBe('Basic d3A6cGFzcw==')
    const [landed] = otherSite.requests
    expect({
      method: landed!.method,
      body: landed!.body,
      contentType: landed!.headers['content-type'],
      authorization: landed!.headers.authorization,
      cookie: landed!.headers.cookie,
      proxyAuthorization: landed!.headers['proxy-authorization'],
    }).toEqual({
      method: 'POST',
      body: '{"a":1}',
      contentType: 'application/json',
      authorization: undefined,
      cookie: undefined,
      proxyAuthorization: undefined,
    })
  })

  test.each([
    [301, 'POST', 'GET', ''],
    [302, 'POST', 'GET', ''],
    [303, 'PUT', 'GET', ''],
    [302, 'PUT', 'PUT', '{"a":1}'],
    [308, 'PUT', 'PUT', '{"a":1}'],
  ])('follows a %i after a %s as a %s', async (status, method, followedMethod, followedBody) => {
    site = await startRecordingSite((request, response) => {
      if (request.path === '/start') {
        response.writeHead(status, { Location: '/next' }).end()
        return
      }
      response.writeHead(200).end('ok')
    })
    const guardedFetch = createGuardedFetch({ allowLoopback: true })

    await guardedFetch(`http://127.0.0.1:${site.port}/start`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: '{"a":1}',
    })

    const followed = site.requests[1]!
    expect({ method: followed.method, body: followed.body, contentType: followed.headers['content-type'] }).toEqual({
      method: followedMethod,
      body: followedBody,
      contentType: followedBody ? 'application/json' : undefined,
    })
  })

  test("gives up on a slow name lookup when the caller's signal times out", async () => {
    let lateAnswer: ReturnType<typeof setTimeout> | undefined
    const guardedFetch = createGuardedFetch({
      // A resolver that answers long after the caller's timeout.
      resolveTarget: () => new Promise((resolve) => {
        lateAnswer = setTimeout(() => resolve({ ok: false, message: '"url" hostname could not be resolved' }), 2_000)
      }),
    })

    try {
      await expect(guardedFetch(`http://${PUBLIC_SITE}/slow`, { signal: AbortSignal.timeout(20) }))
        .rejects.toMatchObject({ name: 'TimeoutError' })
    } finally {
      clearTimeout(lateAnswer)
    }
  })

  test('looks nothing up for a signal that has already aborted', async () => {
    const reason = new Error('caller gave up')
    const resolveTarget = vi.fn(publicFixturePolicy)

    await expect(createGuardedFetch({ resolveTarget })(`http://${PUBLIC_SITE}/`, { signal: AbortSignal.abort(reason) }))
      .rejects.toBe(reason)
    expect(resolveTarget).not.toHaveBeenCalled()
  })

  test(`stops after ${GUARDED_FETCH_MAX_REDIRECTS} redirects`, async () => {
    site = await startRecordingSite((_request, response) => {
      response.writeHead(302, { Location: `/hop-${site!.requests.length}` }).end()
    })
    const guardedFetch = createGuardedFetch({ allowLoopback: true })

    // A redirect loop is the site's failure, not a refused target.
    const failed = guardedFetch(`http://127.0.0.1:${site.port}/hop-0`)
    await expect(failed).rejects.toBeInstanceOf(EgressFailedError)
    await expect(failed).rejects.toThrow(`127.0.0.1:${site.port} redirected more than ${GUARDED_FETCH_MAX_REDIRECTS} times`)
    expect(site.requests).toHaveLength(GUARDED_FETCH_MAX_REDIRECTS + 1)
  })
})
