import type { ValTownConfig } from 'npm:@canonry/val-kit@0.2.0/config'
import { type CheckRecord, checkFingerprint, type JobDispatcher } from 'npm:@canonry/val-kit@0.2.0/jobs'
import { LocalBypassHumanVerifier } from 'npm:@canonry/val-kit@0.2.0/security'
import { MemoryCheckStore } from 'npm:@canonry/val-kit@0.2.0/storage'
import { createValTownApp } from '../../src/app/app.ts'
import { CHECK_FINGERPRINT_NAMESPACE, type CheckResult } from '../../src/runtime/check-result.ts'

function equal<T>(actual: T, expected: T, message = 'values differ'): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`)
  }
}

function truthy(value: unknown, message: string): void {
  if (!value) throw new Error(message)
}

function includes(value: string, expected: string, message = 'expected substring'): void {
  if (!value.includes(expected)) throw new Error(`${message}: ${expected}`)
}

/** Indexed access under `noUncheckedIndexedAccess`: assert presence, then use it. */
function at<T>(items: readonly T[], index: number, message = 'missing element'): T {
  const value = items[index]
  if (value === undefined) throw new Error(`${message} at index ${index}`)
  return value
}

const NOW = new Date('2026-03-01T12:00:00.000Z')

function config(overrides: Partial<ValTownConfig> = {}): ValTownConfig {
  return {
    environment: 'test',
    checkTtlMs: 86_400_000,
    perClientDailyLimit: 3,
    globalDailyLimit: 100,
    quotaSalt: 'test-salt',
    humanVerifier: new LocalBypassHumanVerifier(),
    turnstileSiteKey: null,
    humanVerificationStatus: 'not-required',
    geminiApiKey: null,
    geminiModel: null,
    publicChecksEnabled: true,
    publicChecksUnavailableMessage: null,
    mcpStartChecksEnabled: true,
    mcpPerClientDailyLimit: 2,
    ...overrides,
  }
}

/**
 * One completed check with a deliberately mixed result: a mentioned-not-cited
 * row, a cited-not-mentioned row, and a failed row whose signals are null.
 * The failed row is the important one — it is what proves a failure stays
 * unmeasured instead of being reported as a negative observation.
 */
function completedRecord(overrides: Partial<CheckRecord<CheckResult>> = {}): CheckRecord<CheckResult> {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    fingerprint: checkFingerprint(CHECK_FINGERPRINT_NAMESPACE, 'example.com'),
    userQueries: [],
    domain: 'example.com',
    status: 'complete',
    createdAt: '2026-03-01T11:00:00.000Z',
    updatedAt: '2026-03-01T11:00:30.000Z',
    expiresAt: '2026-03-02T11:00:00.000Z',
    errorCode: null,
    errorMessage: null,
    leaseOwner: null,
    leaseUntil: null,
    result: {
      schemaVersion: '1.0',
      domain: 'example.com',
      generatedAt: '2026-03-01T11:00:30.000Z',
      errors: [],
      visibility: {
        schemaVersion: '1',
        domain: 'example.com',
        startedAt: '2026-03-01T11:00:00.000Z',
        completedAt: '2026-03-01T11:00:30.000Z',
        summary: { successfulChecks: 2, failedChecks: 1, mentionRate: 0.5, citationRate: 0.5 },
        evidence: [
          {
            query: 'best example widgets',
            provider: 'gemini',
            requestedModel: 'gemini-test',
            servedModel: 'gemini-test',
            completedAt: '2026-03-01T11:00:10.000Z',
            answerText: 'Example is a widget vendor.',
            mentioned: true,
            matchedTerms: ['Example'],
            cited: false,
            citedDomains: ['other.com'],
            citedUrls: ['https://other.com/a'],
            matchedCitationDomains: [],
            matchedCitationUrls: [],
            sources: [{ url: 'https://other.com/a', title: 'Other' }],
            searchQueries: ['example widgets'],
            namedBrands: null,
            retrievalStatus: 'grounded',
            error: null,
          },
          {
            query: 'widget vendors compared',
            provider: 'gemini',
            requestedModel: 'gemini-test',
            servedModel: 'gemini-test',
            completedAt: '2026-03-01T11:00:20.000Z',
            answerText: 'Several vendors compete here.',
            mentioned: false,
            matchedTerms: [],
            cited: true,
            citedDomains: ['example.com'],
            citedUrls: ['https://example.com/widgets'],
            matchedCitationDomains: ['example.com'],
            matchedCitationUrls: ['https://example.com/widgets'],
            sources: [{ url: 'https://example.com/widgets', title: 'Widgets' }],
            searchQueries: ['widget vendors'],
            namedBrands: null,
            retrievalStatus: 'grounded',
            error: null,
          },
          {
            query: 'widget buying guide',
            provider: 'gemini',
            requestedModel: 'gemini-test',
            servedModel: null,
            completedAt: '2026-03-01T11:00:25.000Z',
            answerText: null,
            mentioned: null,
            matchedTerms: [],
            cited: null,
            citedDomains: [],
            citedUrls: [],
            matchedCitationDomains: [],
            matchedCitationUrls: [],
            sources: [],
            searchQueries: [],
            namedBrands: null,
            retrievalStatus: 'error',
            error: 'provider timeout',
          },
        ],
      },
      siteHealth: {
        schemaVersion: '1',
        label: '5-page Technical AEO sample',
        domain: 'example.com',
        rootUrl: 'https://example.com/',
        finalRootUrl: 'https://example.com/',
        status: 'complete',
        score: 72,
        pagesDiscovered: 5,
        pagesFetched: 5,
        pagesObserved: 5,
        elapsedMs: 4200,
        terminationReason: null,
        warnings: [],
        siteMap: null,
        attemptedHosts: ['example.com'],
        error: null,
        factors: [{ id: 'answerability', name: 'Answerability', averageScore: 68, count: 5 }],
        pages: [
          {
            url: 'https://example.com/',
            status: 'success',
            score: 72,
            depth: 0,
            indexability: 'indexable',
            factors: [
              {
                id: 'answerability',
                name: 'Answerability',
                score: 68,
                applicable: true,
                findings: [],
                recommendations: ['Add a summary'],
              },
            ],
            criticalDefects: [],
            error: null,
          },
        ],
      },
    },
    ...overrides,
  }
}

function createHarness(
  records: CheckRecord<CheckResult>[] = [completedRecord()],
  overrides: Partial<ValTownConfig> = {},
) {
  const store = new MemoryCheckStore<CheckResult>()
  for (const record of records) store.checks.set(record.id, record)
  const dispatched: string[] = []
  const dispatcher: JobDispatcher = {
    dispatch: (checkId) => {
      dispatched.push(checkId)
      return Promise.resolve('completed' as const)
    },
  }
  const app = createValTownApp({
    store,
    config: config(overrides),
    dispatcher,
    renderPage: () => '<!doctype html><title>test</title>',
    assets: { styles: '', script: '', mark: '', glyph: '' },
    now: () => NOW,
  })
  return { app, store, dispatched }
}

interface RpcOptions {
  headers?: Record<string, string>
  method?: string
}

async function rpc(
  app: ReturnType<typeof createHarness>['app'],
  body: unknown,
  options: RpcOptions = {},
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const response = await app.fetch(
    new Request('https://canonry.val.run/mcp', {
      method: options.method ?? 'POST',
      headers: { 'content-type': 'application/json', ...options.headers },
      body: options.method && options.method !== 'POST' ? undefined : JSON.stringify(body),
    }),
  )
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : null }
}

function call(name: string, args: Record<string, unknown> = {}, id = 1) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }
}

/** The JSON payload a tool returns in its single text block. */
function toolPayload(body: Record<string, unknown>): Record<string, unknown> {
  const result = body.result as { content: Array<{ type: string; text: string }>; isError?: boolean }
  return JSON.parse(at(result.content, 0).text) as Record<string, unknown>
}

Deno.test('initialize echoes a protocol version the caller already speaks', async () => {
  const { app } = createHarness()
  const { status, body } = await rpc(app, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  })

  equal(status, 200)
  const result = body?.result as Record<string, unknown>
  equal(result.protocolVersion, '2025-06-18', 'a legacy client must stay in its own era')
  equal(
    (result.serverInfo as Record<string, unknown>).name,
    'ai-visibility-check',
    'must not claim to be the whole platform',
  )
  includes(result.instructions as string, 'mentioned', 'instructions must teach the two signals')
  includes(result.instructions as string, 'cited')
  includes(result.instructions as string, 'open source', 'instructions must point at the real platform')
})

Deno.test('initialize falls back to the newest supported version for an unknown one', async () => {
  const { app } = createHarness()
  const { body } = await rpc(app, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '1999-01-01', capabilities: {} },
  })
  equal((body?.result as Record<string, unknown>).protocolVersion, '2026-07-28')
})

Deno.test('initialize honours a version declared only in the header', async () => {
  const { app } = createHarness()
  // A client that sets MCP-Protocol-Version but omits it from params must not
  // be answered with a newer era than the one it declared.
  const { body } = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} } }, {
    headers: { 'mcp-protocol-version': '2025-06-18' },
  })
  equal((body?.result as Record<string, unknown>).protocolVersion, '2025-06-18')
})

Deno.test('initialize with nothing declared anywhere negotiates the newest version', async () => {
  const { app } = createHarness()
  const { body } = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} } })
  equal((body?.result as Record<string, unknown>).protocolVersion, '2026-07-28')
})

Deno.test('a modern request needs no handshake at all', async () => {
  const { app } = createHarness()
  const { status, body } = await rpc(app, { jsonrpc: '2.0', id: 7, method: 'tools/list' }, {
    headers: { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/list' },
  })
  equal(status, 200)
  const tools = (body?.result as { tools: Array<{ name: string }> }).tools
  equal(tools.length, 7)
  truthy(tools.some((tool) => tool.name === 'get_ai_visibility'), 'visibility tool must be listed')
})

Deno.test('tools/list advertises every tool with an input schema', async () => {
  const { app } = createHarness()
  const { body } = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
  const tools = (body?.result as { tools: Array<{ name: string; description: string; inputSchema: unknown }> }).tools
  equal(
    tools.map((tool) => tool.name).sort().join(','),
    'get_ai_visibility,get_check,get_site_health,list_skills,read_skill,self_host,start_check',
  )
  for (const tool of tools) truthy(tool.inputSchema, `${tool.name} must declare an inputSchema`)
  // The handler returns siteMap; an agent only discovers it by reading this.
  const siteHealth = tools.find((tool) => tool.name === 'get_site_health')
  truthy(siteHealth?.description.includes('siteMap'), 'get_site_health must advertise the link graph it returns')
})

Deno.test('resources/list advertises unique readable documents with entry points first', async () => {
  const { app } = createHarness()
  const { body } = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'resources/list' })
  const resources = (body?.result as { resources: Array<{ uri: string; name: string; mimeType: string }> }).resources

  equal(new Set(resources.map((resource) => resource.uri)).size, resources.length, 'resource URIs must be unique')
  equal(at(resources, 0).uri, 'canonry-skill://aero/SKILL.md')
  equal(at(resources, 1).uri, 'canonry-skill://canonry/SKILL.md')
  truthy(resources.every((resource) => resource.mimeType === 'text/markdown'), 'skills are markdown')
  truthy(
    resources.some((resource) => resource.name === 'canonry/references/canonry-cli.md'),
    'the chunked CLI reference must still appear as one resource',
  )
  truthy(
    resources.some((resource) => resource.uri === 'canonry-skill://aero/references/regression-playbook.md'),
    'the regression reference must be discoverable',
  )
  for (const resource of resources) {
    const { body: readBody } = await rpc(app, {
      jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: resource.uri },
    })
    equal(readBody?.error, undefined, `${resource.uri} must be readable`)
    const content = at((readBody?.result as { contents: Array<{ uri: string; mimeType: string; text: string }> }).contents, 0)
    equal(content.uri, resource.uri)
    equal(content.mimeType, 'text/markdown')
    truthy(content.text.trim(), `${resource.uri} must contain its document`)
  }
})

Deno.test('resources/read returns a whole skill document, including a chunked one', async () => {
  const { app } = createHarness()
  const { body } = await rpc(app, {
    jsonrpc: '2.0',
    id: 1,
    method: 'resources/read',
    params: { uri: 'canonry-skill://canonry/references/canonry-cli.md' },
  })
  const contents = at((body?.result as { contents: Array<{ text: string; mimeType: string }> }).contents, 0)
  equal(contents.mimeType, 'text/markdown')
  includes(contents.text, '# Canonry CLI Reference')
  // Reassembled across the two generated modules the 80,000-char cap forced.
  truthy(contents.text.length > 90_000, `expected the full reference, got ${contents.text.length} characters`)
})

Deno.test('resources/read reports an unknown URI instead of returning empty content', async () => {
  const { app } = createHarness()
  const { body } = await rpc(app, {
    jsonrpc: '2.0',
    id: 1,
    method: 'resources/read',
    params: { uri: 'canonry-skill://aero/nope.md' },
  })
  equal((body?.error as { code: number }).code, -32602)
})

Deno.test('read_skill resolves a bare reference path as well as a full URI', async () => {
  const { app } = createHarness()
  const { body } = await rpc(app, call('read_skill', { uri: 'aero/references/regression-playbook.md' }))
  const result = body?.result as { content: Array<{ text: string }>; isError?: boolean }
  equal(result.isError, undefined)
  truthy(at(result.content, 0).text.length > 1000, 'expected the reference body')
})

Deno.test('get_check reports mention and citation as separate rates with their scope', async () => {
  const { app } = createHarness()
  const { body } = await rpc(app, call('get_check', { checkId: '11111111-2222-4333-8444-555555555555' }))
  const payload = toolPayload(body!)

  equal(payload.domain, 'example.com')
  equal(payload.status, 'complete')
  const visibility = payload.aiVisibility as Record<string, unknown>
  equal(visibility.measured, true)
  equal(visibility.mentionRate, 0.5)
  equal(visibility.citationRate, 0.5)
  equal(visibility.successfulChecks, 2)
  equal(visibility.failedChecks, 1, 'a failed check stays visible rather than vanishing')
  equal(visibility.scope, 'non-brand', 'the query class must travel with the number')
  equal((payload.siteHealth as Record<string, unknown>).score, 72)
})

Deno.test('a check with caller-supplied queries is not labeled non-brand', async () => {
  // Supplied queries may be branded, so the basket is not guaranteed non-brand;
  // labeling it non-brand would break "the class travels with the number".
  const { app } = createHarness([completedRecord({ userQueries: ['is Example the best widget vendor?'] })])
  const { body } = await rpc(app, call('get_check', { checkId: '11111111-2222-4333-8444-555555555555' }))
  const visibility = toolPayload(body!).aiVisibility as Record<string, unknown>

  equal(visibility.scope, 'mixed', 'a mixed basket must not claim to be non-brand')
  truthy(
    !String(visibility.scopeNote).includes('generated non-brand'),
    'the note must not claim generated non-brand queries for a caller-supplied basket',
  )
})

Deno.test('get_check resolves a domain to its cached check', async () => {
  const { app } = createHarness()
  const { body } = await rpc(app, call('get_check', { domain: 'https://EXAMPLE.com' }))
  equal(toolPayload(body!).checkId, '11111111-2222-4333-8444-555555555555')
})

Deno.test('an uncached domain is reported as a miss and starts no paid work', async () => {
  const { app, store } = createHarness()
  const before = store.checks.size
  const { body } = await rpc(app, call('get_check', { domain: 'never-checked.example' }))

  const result = body?.result as { isError?: boolean }
  equal(result.isError, true)
  includes(JSON.stringify(toolPayload(body!)), 'No cached check')
  equal(store.checks.size, before, 'a read must never queue a check')
})

Deno.test('get_ai_visibility keeps a failed check null rather than calling it a miss', async () => {
  const { app } = createHarness()
  const { body } = await rpc(app, call('get_ai_visibility', { domain: 'example.com' }))
  const evidence = toolPayload(body!).evidence as Array<Record<string, unknown>>

  equal(evidence.length, 3)
  equal(at(evidence, 0).mentioned, true)
  equal(at(evidence, 0).cited, false, 'mentioned in the answer, absent from the sources')
  equal(at(evidence, 1).mentioned, false)
  equal(at(evidence, 1).cited, true, 'cited in the sources, absent from the answer')
  equal(at(evidence, 2).mentioned, null, 'a provider failure is unmeasured, not a negative')
  equal(at(evidence, 2).cited, null)
  equal(at(evidence, 2).retrievalStatus, 'error')
})

Deno.test('get_site_health returns per-page findings from the bounded sample', async () => {
  const { app } = createHarness()
  const { body } = await rpc(app, call('get_site_health', { domain: 'example.com' }))
  const payload = toolPayload(body!)

  equal((payload.summary as Record<string, unknown>).label, '5-page Technical AEO sample')
  const pages = payload.pages as Array<Record<string, unknown>>
  equal(pages.length, 1)
  equal(at(pages, 0).url, 'https://example.com/')
})

Deno.test('an expired check is no longer readable over MCP', async () => {
  const { app } = createHarness([completedRecord({ expiresAt: '2026-02-01T00:00:00.000Z' })])
  const { body } = await rpc(app, call('get_check', { checkId: '11111111-2222-4333-8444-555555555555' }))
  equal((body?.result as { isError?: boolean }).isError, true)
})

Deno.test('a running check reports that it is running instead of an empty result', async () => {
  const { app } = createHarness([completedRecord({ status: 'running', result: null, expiresAt: null })])
  const { body } = await rpc(app, call('get_ai_visibility', { checkId: '11111111-2222-4333-8444-555555555555' }))
  const payload = toolPayload(body!)
  equal(payload.measured, false)
  includes(payload.reason as string, 'still running')
})

Deno.test('start_check is advertised only when the host enables it', async () => {
  const enabled = createHarness()
  const names = async (h: ReturnType<typeof createHarness>) => {
    const { body } = await rpc(h.app, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    return (body?.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)
  }
  truthy((await names(enabled)).includes('start_check'), 'expected start_check when enabled')

  const disabled = createHarness([completedRecord()], { mcpStartChecksEnabled: false })
  equal((await names(disabled)).includes('start_check'), false, 'a disabled host must not advertise it')
})

Deno.test('start_check runs a domain that has no cached check', async () => {
  const { app, store, dispatched } = createHarness([])
  const { body } = await rpc(app, call('start_check', { domain: 'fresh.example' }))
  const payload = toolPayload(body!)

  equal(payload.domain, 'fresh.example')
  equal(store.checks.size, 1, 'a record must be admitted')
  equal(dispatched.length, 1, 'the runner must be dispatched exactly once')
})

Deno.test('start_check reuses a cached check instead of spending again', async () => {
  const { app, dispatched } = createHarness()
  const { body } = await rpc(app, call('start_check', { domain: 'example.com' }))
  const payload = toolPayload(body!)

  equal(payload.checkId, '11111111-2222-4333-8444-555555555555')
  equal(payload.reused, true)
  equal(dispatched.length, 0, 'a cached domain must not reach the runner')
})

Deno.test('start_check spends its own bucket, not the browser allowance', async () => {
  const { app, store } = createHarness([], { mcpPerClientDailyLimit: 1, perClientDailyLimit: 3 })
  const first = await rpc(app, call('start_check', { domain: 'one.example' }))
  equal((first.body?.result as { isError?: boolean }).isError, undefined)

  const second = await rpc(app, call('start_check', { domain: 'two.example' }))
  equal((second.body?.result as { isError?: boolean }).isError, true, 'the MCP limit of 1 must bind')

  const subjects = [...store.quota.keys()].join(',')
  truthy(subjects.includes('mcp:'), `expected an mcp-prefixed quota subject, got ${subjects}`)
})

Deno.test('start_check refuses a private or malformed host', async () => {
  const { app, dispatched } = createHarness([])
  for (const domain of ['localhost', '127.0.0.1', 'not a domain']) {
    const { body } = await rpc(app, call('start_check', { domain }))
    equal((body?.result as { isError?: boolean }).isError, true, `${domain} must be refused`)
  }
  equal(dispatched.length, 0, 'a refused domain must never reach the runner')
})

Deno.test('start_check is unavailable when the host disables it', async () => {
  const { app, dispatched } = createHarness([], { mcpStartChecksEnabled: false })
  const { body } = await rpc(app, call('start_check', { domain: 'fresh.example' }))
  equal((body?.result as { isError?: boolean }).isError, true)
  equal(dispatched.length, 0)
})

Deno.test('reads still never reach the runner now that a write tool exists', async () => {
  const { app, store, dispatched } = createHarness()
  await rpc(app, call('get_check', { domain: 'never-checked.example' }))
  await rpc(app, call('get_ai_visibility', { domain: 'never-checked.example' }))
  await rpc(app, call('get_site_health', { domain: 'never-checked.example' }))
  equal(dispatched.length, 0, 'no read may dispatch')
  equal(store.checks.size, 1, 'no read may admit a record')
})

Deno.test('self_host points at the open-source platform without spending', async () => {
  const { app, store, dispatched } = createHarness()
  const { body } = await rpc(app, call('self_host'))
  const payload = toolPayload(body!)

  equal(payload.install, 'npm install -g @canonry/canonry')
  equal(payload.repository, 'https://github.com/Canonry/canonry')
  truthy((payload.whatSelfHostingAdds as string[]).length >= 5, 'expected a real comparison')
  equal(dispatched.length, 0)
  equal(store.checks.size, 1)
})

Deno.test('a notification is accepted with 202 and no body', async () => {
  const { app } = createHarness()
  const { status, body } = await rpc(app, { jsonrpc: '2.0', method: 'notifications/initialized' })
  equal(status, 202)
  equal(body, null)
})

Deno.test('a notification method sent with an id is rejected rather than left hanging', async () => {
  const { app } = createHarness()
  const { status, body } = await rpc(app, { jsonrpc: '2.0', id: 4, method: 'notifications/initialized' })
  equal(status, 400)
  equal((body?.error as { code: number }).code, -32600)
})

Deno.test('a modern request whose headers disagree with its body is refused', async () => {
  const { app } = createHarness()
  const { status, body } = await rpc(app, call('get_check', { domain: 'example.com' }), {
    headers: { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'get_site_health' },
  })
  equal(status, 400)
  equal((body?.error as { code: number }).code, -32020, 'header/body mismatch is HeaderMismatch')
})

Deno.test('a legacy request is not held to the modern mirrored-header rules', async () => {
  const { app } = createHarness()
  const { status, body } = await rpc(app, call('get_check', { domain: 'example.com' }), {
    headers: { 'mcp-protocol-version': '2025-06-18' },
  })
  equal(status, 200)
  equal(toolPayload(body!).domain, 'example.com')
})

Deno.test('a protocol version the server does not speak is refused with its supported list', async () => {
  const { app } = createHarness()
  const { status, body } = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, {
    headers: { 'mcp-protocol-version': '2019-01-01' },
  })
  equal(status, 400)
  const error = body?.error as { code: number; data: { supported: string[] } }
  equal(error.code, -32600)
  truthy(error.data.supported.includes('2026-07-28'), 'the caller must learn what to retry with')
})

Deno.test('an unknown method answers 404 so a client can tell this endpoint from a legacy one', async () => {
  const { app } = createHarness()
  const { status, body } = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'completion/complete' })
  equal(status, 404)
  equal((body?.error as { code: number }).code, -32601)
})

Deno.test('an unknown notification is accepted with 202, never answered with 404', async () => {
  const { app } = createHarness()
  // No id => a notification. Even for an unrecognized method (a roots-capable
  // client's notifications/roots/list_changed), JSON-RPC forbids a reply.
  const { status, body } = await rpc(app, { jsonrpc: '2.0', method: 'notifications/roots/list_changed' })
  equal(status, 202)
  equal(body, null, 'a notification gets no body')
})

Deno.test('the endpoint accepts POST only', async () => {
  const { app } = createHarness()
  const { status } = await rpc(app, null, { method: 'GET' })
  equal(status, 405)
})

Deno.test('a cross-origin browser caller is refused', async () => {
  const { app } = createHarness()
  const { status } = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, {
    headers: { origin: 'https://evil.example' },
  })
  equal(status, 403)
})

Deno.test('a same-origin browser caller is allowed', async () => {
  const { app } = createHarness()
  const { status } = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, {
    headers: { origin: 'https://canonry.val.run' },
  })
  equal(status, 200)
})

Deno.test('a malformed body is a parse error, not a crash', async () => {
  const { app } = createHarness()
  const response = await app.fetch(
    new Request('https://canonry.val.run/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    }),
  )
  equal(response.status, 400)
  const parsed = await response.json() as { error: { code: number } }
  equal(parsed.error.code, -32700)
})

Deno.test('the existing UI and check routes still answer alongside the MCP endpoint', async () => {
  const { app } = createHarness()
  equal((await app.fetch(new Request('https://canonry.val.run/healthz'))).status, 200)
  equal((await app.fetch(new Request('https://canonry.val.run/'))).status, 200)
  equal(
    (await app.fetch(new Request('https://canonry.val.run/api/checks/11111111-2222-4333-8444-555555555555'))).status,
    200,
  )
})
