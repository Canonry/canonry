import {
  DEFAULT_AI_CRAWLER_USER_AGENT_SUBSTRINGS,
  DEFAULT_AI_REFERRER_RULES,
} from '@ainyc/canonry-integration-traffic'
import { describe, expect, it, vi } from 'vitest'
import { canonicalizeCloudflareJson } from '../src/canonical-json.js'
import {
  DEFAULT_BOT_LIST,
  generateWorkerScript,
  generateWranglerToml,
} from '../src/script.js'
import {
  CLOUDFLARE_DIRECT_PUSH_SECRET_BINDINGS,
  CLOUDFLARE_WORKER_BINDINGS,
} from '../src/types.js'
import { verifyRequestSignature } from '../src/verify.js'

const BASE_OPTS = {
  deliveryMode: 'direct-push' as const,
  workerVersion: '1.0.0',
  botList: DEFAULT_BOT_LIST,
}

const WORKER_ENV = {
  CANONRY_DELIVERY_MODE: 'direct-push',
  CANONRY_SOURCE_ID: 'src_abc123',
  CANONRY_INGEST_URL: 'https://canonry.example.com/api/v1/projects/foo/traffic/cloudflare/ingest',
  CANONRY_WORKER_VERSION: '1.0.0',
  CANONRY_BEARER_TOKEN: 'tok_secret_value',
  CANONRY_HMAC_SECRET: 'hmac_secret_value',
}

const BASE_WRANGLER_OPTS = {
  deliveryMode: 'direct-push' as const,
  sourceId: WORKER_ENV.CANONRY_SOURCE_ID,
  hostname: 'example.com',
  ingestUrl: WORKER_ENV.CANONRY_INGEST_URL,
  workerVersion: WORKER_ENV.CANONRY_WORKER_VERSION,
}

const QUEUE_WORKER_ENV = {
  CANONRY_DELIVERY_MODE: 'queue-pull',
  CANONRY_SOURCE_ID: 'src_queue123',
  CANONRY_WORKER_VERSION: '1.0.0',
  CANONRY_TRAFFIC_QUEUE: {
    send: vi.fn(async () => {}),
  },
}

const QUEUE_WRANGLER_OPTS = {
  deliveryMode: 'queue-pull' as const,
  sourceId: QUEUE_WORKER_ENV.CANONRY_SOURCE_ID,
  hostname: 'example.com',
  workerVersion: QUEUE_WORKER_ENV.CANONRY_WORKER_VERSION,
  queueName: 'canonry-traffic-src_queue123',
}

interface GeneratedRequest {
  url: string
  headers: { get(name: string): string | null }
  cf: null
}

interface GeneratedWorker {
  fetch(
    request: Request,
    env: Record<string, unknown>,
    ctx: { waitUntil(task: Promise<unknown>): void },
  ): Promise<Response>
}

function executableModuleSource(script: string): string {
  return script.replace('export default', 'globalThis.generatedWorker =')
}

function generatedShouldForward(): (request: GeneratedRequest) => boolean {
  const scope: {
    generatedWorker?: GeneratedWorker
    shouldForward?: (request: GeneratedRequest) => boolean
  } = {}
  const exposePredicate = new Function(
    'globalThis',
    `${executableModuleSource(generateWorkerScript(BASE_OPTS))}\n` +
      'globalThis.shouldForward = shouldForward',
  )
  exposePredicate(scope)
  return scope.shouldForward!
}

function request(url: string, referer?: string, userAgent = 'Mozilla/5.0'): GeneratedRequest {
  const headers = new Map<string, string>()
  headers.set('user-agent', userAgent)
  if (referer) headers.set('referer', referer)
  return {
    url,
    headers: { get: name => headers.get(name.toLowerCase()) ?? null },
    cf: null,
  }
}

async function runGeneratedWorker(
  ingestStatuses: number[],
  envOverrides: Record<string, string> = {},
): Promise<{
  ingestCalls: number
  ingestInit: RequestInit | undefined
  cancelledBodies: number
  warn: ReturnType<typeof vi.fn>
}> {
  const waitUntilTasks: Promise<unknown>[] = []
  const warn = vi.fn()
  const cancelBody = vi.fn(async () => {})
  let ingestCalls = 0
  let ingestInit: RequestInit | undefined
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input !== 'string') return new Response('origin', { status: 200 })
    ingestCalls += 1
    ingestInit = init
    const status = ingestStatuses.shift() ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      body: { cancel: cancelBody },
    } as unknown as Response
  })
  const immediateTimeout = (callback: () => void): number => {
    callback()
    return 0
  }
  const scope: { generatedWorker?: GeneratedWorker } = {}
  const evaluate = new Function(
    'globalThis',
    'fetch',
    'crypto',
    'console',
    'setTimeout',
    executableModuleSource(generateWorkerScript(BASE_OPTS)),
  )
  evaluate(scope, fetchMock, globalThis.crypto, { warn }, immediateTimeout)

  const generatedRequest = new Request('https://example.com/?utm_source=chatgpt', {
    headers: { 'cf-ray': 'evt_retry_test', 'user-agent': 'Mozilla/5.0' },
  })
  Object.defineProperty(generatedRequest, 'cf', { value: null })
  const response = await scope.generatedWorker!.fetch(
    generatedRequest,
    { ...WORKER_ENV, ...envOverrides },
    { waitUntil: task => { waitUntilTasks.push(task) } },
  )
  expect(await response.text()).toBe('origin')
  await Promise.all(waitUntilTasks)
  return { ingestCalls, ingestInit, cancelledBodies: cancelBody.mock.calls.length, warn }
}

describe('generateWorkerScript', () => {
  it('produces an ES-module Worker', () => {
    const script = generateWorkerScript(BASE_OPTS)
    expect(script).toMatch(/export default\s*\{/)
    expect(script).not.toMatch(/addEventListener\s*\(/)
    expect(script.length).toBeGreaterThan(500)
  })

  it('contains no bearer or HMAC secret values', () => {
    const script = generateWorkerScript(BASE_OPTS)
    expect(script).not.toContain(WORKER_ENV.CANONRY_BEARER_TOKEN)
    expect(script).not.toContain(WORKER_ENV.CANONRY_HMAC_SECRET)
    expect(script).toContain(`env.${CLOUDFLARE_WORKER_BINDINGS.bearerToken}`)
    expect(script).toContain(`env.${CLOUDFLARE_WORKER_BINDINGS.hmacSecret}`)
  })

  it('bakes in the bot UA keywords from the supplied bot list', () => {
    const script = generateWorkerScript(BASE_OPTS)
    for (const keyword of DEFAULT_BOT_LIST.uaKeywords) {
      expect(script).toContain(keyword)
    }
  })

  it('bakes in the canonical AI referrer domains from the supplied bot list', () => {
    const script = generateWorkerScript(BASE_OPTS)
    for (const domain of DEFAULT_BOT_LIST.refererDomains) {
      expect(script).toContain(domain)
    }
  })

  it('forwards every canonical AI referrer domain and its subdomains', () => {
    const shouldForward = generatedShouldForward()
    for (const { domain } of DEFAULT_AI_REFERRER_RULES) {
      expect(shouldForward(request('https://example.com/', `https://${domain}/answer`))).toBe(true)
      expect(shouldForward(request('https://example.com/', `https://chat.${domain}/answer`))).toBe(true)
    }
  })

  it('forwards every canonical crawler and AI user-fetch UA token', () => {
    const shouldForward = generatedShouldForward()
    for (const token of DEFAULT_AI_CRAWLER_USER_AGENT_SUBSTRINGS) {
      expect(shouldForward(request('https://example.com/', undefined, `Mozilla/5.0 ${token}1.0`))).toBe(true)
    }
  })

  it('forwards AI utm_source evidence on the request or same-site referrer URL', () => {
    const shouldForward = generatedShouldForward()
    for (const { domain } of DEFAULT_AI_REFERRER_RULES) {
      const token = domain.split('.')[0]!
      expect(shouldForward(request(`https://example.com/?utm_source=${token}`))).toBe(true)
      expect(shouldForward(request(
        'https://example.com/app.js',
        `https://example.com/landing?utm_source=${domain}`,
      ))).toBe(true)
    }
  })

  it('does not treat unrelated host substrings or UTM sources as AI evidence', () => {
    const shouldForward = generatedShouldForward()
    expect(shouldForward(request('https://example.com/', 'https://mail.google.com/'))).toBe(false)
    expect(shouldForward(request('https://example.com/', 'https://snapchat.com/'))).toBe(false)
    expect(shouldForward(request('https://example.com/?utm_source=newsletter'))).toBe(false)
  })

  it('records the bot list version somewhere the operator or doctor can read it', () => {
    const script = generateWorkerScript({
      ...BASE_OPTS,
      botList: { ...DEFAULT_BOT_LIST, version: '2099-12-31' },
    })
    expect(script).toContain('2099-12-31')
  })

  it('uses ctx.waitUntil so delivery never blocks the origin response', () => {
    const script = generateWorkerScript(BASE_OPTS)
    expect(script).toMatch(/ctx\.waitUntil/)
  })

  it('returns the origin response when edge filtering throws', async () => {
    const warn = vi.fn()
    const fetchMock = vi.fn(async () => new Response('origin', { status: 200 }))
    const scope: { generatedWorker?: GeneratedWorker } = {}
    const evaluate = new Function(
      'globalThis',
      'fetch',
      'crypto',
      'console',
      'setTimeout',
      executableModuleSource(generateWorkerScript(BASE_OPTS)),
    )
    evaluate(scope, fetchMock, globalThis.crypto, { warn }, setTimeout)
    const brokenRequest = {
      url: 'https://example.com/',
      headers: { get: () => { throw new Error('broken header accessor') } },
      cf: null,
    } as unknown as Request

    const response = await scope.generatedWorker!.fetch(
      brokenRequest,
      WORKER_ENV,
      { waitUntil: () => { throw new Error('must not schedule') } },
    )

    expect(await response.text()).toBe('origin')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(
      'Canonry traffic filter failed',
      expect.objectContaining({ sourceId: WORKER_ENV.CANONRY_SOURCE_ID }),
    )
  })

  it('returns the origin response when waitUntil scheduling throws', async () => {
    const warn = vi.fn()
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (typeof input !== 'string') return new Response('origin', { status: 200 })
      return new Response('', { status: 200 })
    })
    const scope: { generatedWorker?: GeneratedWorker } = {}
    const evaluate = new Function(
      'globalThis',
      'fetch',
      'crypto',
      'console',
      'setTimeout',
      executableModuleSource(generateWorkerScript(BASE_OPTS)),
    )
    evaluate(scope, fetchMock, globalThis.crypto, { warn }, setTimeout)
    const generatedRequest = new Request('https://example.com/?utm_source=chatgpt', {
      headers: { 'cf-ray': 'evt_wait_until_failure', 'user-agent': 'Mozilla/5.0' },
    })
    Object.defineProperty(generatedRequest, 'cf', { value: null })

    const response = await scope.generatedWorker!.fetch(
      generatedRequest,
      WORKER_ENV,
      { waitUntil: () => { throw new Error('waitUntil unavailable') } },
    )

    expect(await response.text()).toBe('origin')
    expect(warn).toHaveBeenCalledWith(
      'Canonry traffic delivery scheduling failed',
      expect.objectContaining({ sourceId: WORKER_ENV.CANONRY_SOURCE_ID }),
    )
  })

  it.each([404, 500])('preserves an origin %s response byte for byte', async (status) => {
    const waitUntilTasks: Promise<unknown>[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (typeof input !== 'string') {
        return new Response('origin response body', {
          status,
          headers: { 'x-origin-proof': 'unchanged' },
        })
      }
      return new Response('', { status: 200 })
    })
    const scope: { generatedWorker?: GeneratedWorker } = {}
    const evaluate = new Function(
      'globalThis',
      'fetch',
      'crypto',
      'console',
      'setTimeout',
      executableModuleSource(generateWorkerScript(BASE_OPTS)),
    )
    evaluate(scope, fetchMock, globalThis.crypto, { warn: vi.fn() }, setTimeout)
    const generatedRequest = new Request('https://example.com/?utm_source=chatgpt')
    Object.defineProperty(generatedRequest, 'cf', { value: null })

    const response = await scope.generatedWorker!.fetch(
      generatedRequest,
      WORKER_ENV,
      { waitUntil: task => { waitUntilTasks.push(task) } },
    )

    expect(response.status).toBe(status)
    expect(response.headers.get('x-origin-proof')).toBe('unchanged')
    expect(await response.text()).toBe('origin response body')
    await Promise.all(waitUntilTasks)
  })

  it('keeps filtering/event capture separate from the direct-push delivery adapter', () => {
    const script = generateWorkerScript(BASE_OPTS)
    expect(script).toContain('function buildEdgeEvent(')
    expect(script).toContain('function buildEdgeEventBatch(')
    expect(script).toContain('function deliverViaDirectPush(')
    expect(script).toContain('function deliverEdgeEventBatch(')
  })

  it('forwards with the documented authentication and provenance headers', () => {
    const script = generateWorkerScript(BASE_OPTS)
    expect(script).toContain('Authorization')
    expect(script).toContain('X-Canonry-Timestamp')
    expect(script).toContain('X-Canonry-Signature')
    expect(script).toContain('X-Canonry-Worker-Version')
    expect(script).toContain('X-Canonry-Source-Id')
  })

  it('signs canonical JSON with HMAC-SHA256 via Web Crypto', async () => {
    const result = await runGeneratedWorker([200])
    const body = String(result.ingestInit?.body)
    const payload = JSON.parse(body) as unknown
    expect(body).toBe(canonicalizeCloudflareJson(payload))

    const headers = new Headers(result.ingestInit?.headers)
    const timestamp = headers.get('X-Canonry-Timestamp')!
    expect(verifyRequestSignature({
      timestamp,
      signature: headers.get('X-Canonry-Signature')!,
      payload,
      secret: WORKER_ENV.CANONRY_HMAC_SECRET,
      nowSeconds: Number(timestamp),
      acceptLegacyJson: false,
    })).toEqual({ ok: true })
  })

  it('names itself to the ingest endpoint with its deployed version', async () => {
    const result = await runGeneratedWorker([200], { CANONRY_WORKER_VERSION: '1.0.7' })
    expect(new Headers(result.ingestInit?.headers).get('user-agent')).toBe('canonry-cloudflare-worker/1.0.7')
  })

  it('uses POST as the direct-push method', () => {
    const script = generateWorkerScript(BASE_OPTS)
    expect(script).toMatch(/method\s*:\s*['"]POST['"]/)
  })

  it('retries transient ingest failures without blocking the origin response', async () => {
    const result = await runGeneratedWorker([503, 200])
    expect(result.ingestCalls).toBe(2)
    expect(result.cancelledBodies).toBe(2)
    expect(result.warn).not.toHaveBeenCalled()
  })

  it('does not retry a permanent ingest rejection and logs no secrets', async () => {
    const result = await runGeneratedWorker([401])
    expect(result.ingestCalls).toBe(1)
    expect(result.warn).toHaveBeenCalledOnce()
    expect(JSON.stringify(result.warn.mock.calls)).not.toContain(WORKER_ENV.CANONRY_BEARER_TOKEN)
    expect(JSON.stringify(result.warn.mock.calls)).not.toContain(WORKER_ENV.CANONRY_HMAC_SECRET)
  })

  it('fails delivery closed for an unsupported mode without masking the origin response', async () => {
    const result = await runGeneratedWorker([], { CANONRY_DELIVERY_MODE: 'logpush' })
    expect(result.ingestCalls).toBe(0)
    expect(result.warn).toHaveBeenCalledOnce()
  })

  it('parses as executable JavaScript after replacing only the module export', () => {
    const script = executableModuleSource(generateWorkerScript(BASE_OPTS))
    expect(() => new Function('globalThis', script)).not.toThrow()
  })

  it('treats a custom botScoreMaxForward as the score threshold', () => {
    const script = generateWorkerScript({ ...BASE_OPTS, botScoreMaxForward: 42 })
    expect(script).toContain('42')
  })

  it('sends the same edge batch to the Queue binding inside waitUntil', async () => {
    const queueSend = vi.fn(async () => {})
    const scope: { generatedWorker?: GeneratedWorker } = {}
    const evaluate = new Function(
      'globalThis',
      'fetch',
      'crypto',
      'console',
      'setTimeout',
      executableModuleSource(generateWorkerScript({ ...BASE_OPTS, deliveryMode: 'queue-pull' })),
    )
    evaluate(scope, vi.fn(async () => new Response('origin')), globalThis.crypto, { warn: vi.fn() }, setTimeout)

    const waitUntilTasks: Promise<unknown>[] = []
    const generatedRequest = new Request('https://example.com/?utm_source=chatgpt', {
      headers: { 'cf-ray': 'evt_queue_test', 'user-agent': 'Mozilla/5.0' },
    })
    Object.defineProperty(generatedRequest, 'cf', { value: null })
    const response = await scope.generatedWorker!.fetch(
      generatedRequest,
      { ...QUEUE_WORKER_ENV, CANONRY_TRAFFIC_QUEUE: { send: queueSend } },
      { waitUntil: task => { waitUntilTasks.push(task) } },
    )

    expect(await response.text()).toBe('origin')
    await Promise.all(waitUntilTasks)
    expect(queueSend).toHaveBeenCalledWith(expect.objectContaining({
      schemaVersion: 1,
      workerVersion: '1.0.0',
      events: [expect.objectContaining({ eventId: 'evt_queue_test' })],
    }), { contentType: 'json' })
  })

  it('does not emit direct-push secrets or ingest configuration for queue workers', () => {
    const script = generateWorkerScript({ ...BASE_OPTS, deliveryMode: 'queue-pull' })
    expect(script).toContain(`env.${CLOUDFLARE_WORKER_BINDINGS.trafficQueue}`)
    expect(script).not.toContain(`env.${CLOUDFLARE_WORKER_BINDINGS.ingestUrl}`)
    expect(script).not.toContain(`env.${CLOUDFLARE_WORKER_BINDINGS.bearerToken}`)
    expect(script).not.toContain(`env.${CLOUDFLARE_WORKER_BINDINGS.hmacSecret}`)
  })
})

describe('DEFAULT_BOT_LIST', () => {
  it('includes the canonical AI UA tokens', () => {
    expect(DEFAULT_BOT_LIST.uaKeywords).toEqual(
      expect.arrayContaining(DEFAULT_AI_CRAWLER_USER_AGENT_SUBSTRINGS),
    )
  })

  it('includes the canonical AI referer hosts', () => {
    expect(DEFAULT_BOT_LIST.refererDomains).toEqual(
      expect.arrayContaining(DEFAULT_AI_REFERRER_RULES.map(rule => rule.domain)),
    )
  })

  it('has a non-empty, dated version string so the staleness check can compare', () => {
    expect(DEFAULT_BOT_LIST.version).toMatch(/\d{4}-\d{2}-\d{2}/)
  })
})

describe('generateWranglerToml', () => {
  it('emits module metadata and non-secret direct-push vars', () => {
    const toml = generateWranglerToml(BASE_WRANGLER_OPTS)
    expect(toml).toMatch(/^name\s*=\s*"canonry-traffic-src_abc123"/m)
    expect(toml).toMatch(/^main\s*=/m)
    expect(toml).toContain('[vars]')
    expect(toml).toContain('CANONRY_DELIVERY_MODE = "direct-push"')
    expect(toml).toContain('CANONRY_SOURCE_ID = "src_abc123"')
    expect(toml).toContain(`CANONRY_INGEST_URL = "${WORKER_ENV.CANONRY_INGEST_URL}"`)
    expect(toml).toContain('CANONRY_WORKER_VERSION = "1.0.0"')
  })

  it('emits the Cloudflare account id as top-level Wrangler configuration', () => {
    const toml = generateWranglerToml({
      ...BASE_WRANGLER_OPTS,
      accountId: 'account_123',
    })
    expect(toml).toMatch(/^account_id = "account_123"$/m)
    expect(toml.indexOf('account_id')).toBeLessThan(toml.indexOf('[vars]'))
  })

  it('omits account_id when connect did not receive one', () => {
    expect(generateWranglerToml(BASE_WRANGLER_OPTS)).not.toMatch(/^account_id\s*=/m)
  })

  it('names required secret bindings without containing their values', () => {
    const toml = generateWranglerToml(BASE_WRANGLER_OPTS)
    expect(toml).toContain('[secrets]')
    expect(toml).toContain('required = ["CANONRY_BEARER_TOKEN", "CANONRY_HMAC_SECRET"]')
    for (const binding of CLOUDFLARE_DIRECT_PUSH_SECRET_BINDINGS) {
      expect(toml).toContain(`wrangler secret put ${binding}`)
    }
    expect(toml).not.toContain(WORKER_ENV.CANONRY_BEARER_TOKEN)
    expect(toml).not.toContain(WORKER_ENV.CANONRY_HMAC_SECRET)
  })

  it('sets compatibility_date to a recent ISO date', () => {
    const toml = generateWranglerToml(BASE_WRANGLER_OPTS)
    expect(toml).toMatch(/compatibility_date\s*=\s*"\d{4}-\d{2}-\d{2}"/)
  })

  it('leaves route attachment manual and gives the exact safe Dashboard steps', () => {
    const toml = generateWranglerToml({
      ...BASE_WRANGLER_OPTS,
      hostname: 'www.example.com',
      zoneId: 'zone_123',
    })
    expect(toml).toContain('workers_dev = false')
    expect(toml).not.toContain('[[routes]]')
    expect(toml).not.toMatch(/^pattern\s*=/m)
    expect(toml).not.toMatch(/^zone_id\s*=/m)
    expect(toml).toContain('www.example.com/*')
    expect(toml).toContain('Target zone id: "zone_123"')
    expect(toml).toContain('Set the route Request limit failure mode to Fail open')
    expect(toml).toContain('Wrangler cannot configure this route toggle')
  })

  it('keeps routing dashboard-managed when zoneId is omitted', () => {
    const toml = generateWranglerToml(BASE_WRANGLER_OPTS)
    expect(toml).toContain('workers_dev = false')
    expect(toml).not.toContain('[[routes]]')
    expect(toml).toContain('example.com/*')
    expect(toml).toContain('Target zone id was not provided')
    expect(toml).not.toContain('wrangler route add')
  })

  it('emits a Queue producer binding without ingest vars or direct-push secrets', () => {
    const toml = generateWranglerToml(QUEUE_WRANGLER_OPTS)
    expect(toml).toContain('CANONRY_DELIVERY_MODE = "queue-pull"')
    expect(toml).toContain('[[queues.producers]]')
    expect(toml).toContain('queue = "canonry-traffic-src_queue123"')
    expect(toml).toContain(`binding = "${CLOUDFLARE_WORKER_BINDINGS.trafficQueue}"`)
    expect(toml).not.toContain('CANONRY_INGEST_URL')
    expect(toml).not.toContain('[secrets]')
    for (const binding of CLOUDFLARE_DIRECT_PUSH_SECRET_BINDINGS) {
      expect(toml).not.toContain(binding)
    }
  })
})
