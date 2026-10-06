import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { createClient, migrate, projects, competitors, discoverySessions, runs } from '@ainyc/canonry-db'
import type { ProviderAdapter, ProviderConfig, RawQueryResult, NormalizedQueryResult, TrackedQueryInput } from '@ainyc/canonry-contracts'
import { ProviderRegistry } from '../src/provider-registry.js'

export interface LiteralAnswer { answerText: string; citedDomains: string[]; searchQueries?: string[] }
export interface LiteralProvider { seed: LiteralAnswer | Error; probes?: Record<string, LiteralAnswer>; classification?: string | Error }
export type EmbeddingReply = 'success' | 'hang' | 'network' | 400 | 429 | 503
const embeddingBody = z.object({ requests: z.array(z.object({ content: z.object({ parts: z.array(z.object({ text: z.string() })) }) })) })
const BASIS = [[1, 0, 0, 0, 0, 0], [0, 1, 0, 0, 0, 0], [0, 0, 1, 0, 0, 0], [0, 0, 0, 1, 0, 0], [0, 0, 0, 0, 1, 0], [0, 0, 0, 0, 0, 1]]

export function nativeDiscoveryFixture(options: {
  providers?: Record<string, LiteralProvider>
  project?: { name?: string; displayName?: string; domain?: string; ownedDomains?: string[]; aliases?: string[] }
  competitorDomains?: string[]
  embeddingReplies?: EmbeddingReply[]
  vectors?: number[][]
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-native-discovery-'))
  const db = createClient(path.join(dir, 'native.sqlite'))
  migrate(db)
  onTestFinished(() => { db.$client.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  const projectId = crypto.randomUUID(), runId = crypto.randomUUID(), sessionId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(projects).values({ id: projectId, name: options.project?.name ?? 'acme-iq', displayName: options.project?.displayName ?? 'Acme IQ', canonicalDomain: options.project?.domain ?? 'acme-iq.example.com', ownedDomains: options.project?.ownedDomains ?? [], aliases: options.project?.aliases ?? [], country: 'US', language: 'en', createdAt: now, updatedAt: now }).run()
  for (const domain of options.competitorDomains ?? ['sunplanner.test']) db.insert(competitors).values({ id: crypto.randomUUID(), projectId, domain, provenance: 'cli', createdAt: now }).run()
  db.insert(discoverySessions).values({ id: sessionId, projectId, runId, status: 'queued', icpDescription: 'AEO test', competitorMap: [], createdAt: now }).run()
  db.insert(runs).values({ id: runId, projectId, kind: 'aeo-discover-probe', status: 'queued', trigger: 'manual', createdAt: now }).run()
  const registry = new ProviderRegistry()
  const tracked: Array<{ provider: string; input: TrackedQueryInput; config: ProviderConfig }> = []
  const classification: Array<{ provider: string; prompt: string; config: ProviderConfig }> = []
  const embeddingRequests: Array<{ url: string; method: string; apiKey: string | null; queries: string[]; at: number }> = []
  const release: Array<() => void> = []
  const rawResponses = new Map<RawQueryResult, NormalizedQueryResult>()
  for (const [name, responses] of Object.entries(options.providers ?? { gemini: { seed: { answerText: '', citedDomains: [] } } })) {
    let seedQuery: string | undefined
    const raw = (answer: LiteralAnswer): RawQueryResult => {
      const result: RawQueryResult = { provider: name, model: name + '-fixture', rawResponse: { answerText: answer.answerText, citedDomains: answer.citedDomains }, groundingSources: [], searchQueries: answer.searchQueries ?? [], retrievalStatus: 'used', retrievalContract: 'search-required-v1' }
      rawResponses.set(result, { provider: name, answerText: answer.answerText, citedDomains: answer.citedDomains, searchQueries: answer.searchQueries ?? [], groundingSources: [], retrievalStatus: 'used' })
      return result
    }
    const adapter: ProviderAdapter = {
      name, displayName: name, mode: 'api', supportsLocationContext: true,
      modelRegistry: { defaultModel: name + '-fixture', knownModels: [], validationPattern: /.+/, validationHint: 'fixture model' },
      validateConfig: () => ({ ok: true, provider: name, message: 'fixture' }),
      healthcheck: async () => ({ ok: true, provider: name, message: 'fixture' }),
      async executeTrackedQuery(input, config) {
        tracked.push({ provider: name, input: structuredClone(input), config: structuredClone(config) })
        seedQuery ??= input.query
        if (input.query === seedQuery) { if (responses.seed instanceof Error) throw responses.seed; return raw(responses.seed) }
        const answer = responses.probes?.[input.query]
        if (!answer) throw new Error('Unexpected native probe: ' + input.query)
        return raw(answer)
      },
      normalizeResult(result) { const normalized = rawResponses.get(result); if (!normalized) throw new Error('Unrecognized raw fixture response'); return structuredClone(normalized) },
      async generateText(prompt, config) {
        classification.push({ provider: name, prompt, config: structuredClone(config) })
        if (responses.classification instanceof Error) throw responses.classification
        return responses.classification ?? ''
      },
    }
    registry.register(adapter, { provider: name, apiKey: name + '-fixture-key', baseUrl: 'https://embedding.fixture.invalid/discovery/', quotaPolicy: { maxConcurrency: 1, maxRequestsPerMinute: 60, maxRequestsPerDay: 1000 } })
  }
  vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', 'false')
  vi.stubEnv('GOOGLE_GEMINI_BASE_URL', '')
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init)
    const body = embeddingBody.parse(await request.json())
    const queries = body.requests.map(row => row.content.parts.map(part => part.text).join(''))
    embeddingRequests.push({ url: request.url, method: request.method, apiKey: request.headers.get('x-goog-api-key'), queries, at: Date.now() })
    const response = () => new Response(JSON.stringify({ embeddings: (options.vectors ?? BASIS.slice(0, queries.length)).map(values => ({ values })) }), { status: 200, headers: { 'content-type': 'application/json' } })
    const reply = options.embeddingReplies?.[embeddingRequests.length - 1] ?? 'success'
    if (reply === 'hang') return new Promise<Response>(resolve => release.push(() => resolve(response())))
    if (reply === 'network') throw new TypeError('fetch failed')
    if (typeof reply === 'number') return new Response(JSON.stringify({ error: { code: reply, message: 'native embedding refusal ' + reply, status: reply === 400 ? 'INVALID_ARGUMENT' : 'UNAVAILABLE' } }), { status: reply, headers: { 'content-type': 'application/json' } })
    return response()
  })
  onTestFinished(() => { for (const resolve of release) resolve(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); vi.restoreAllMocks() })
  return { db, projectId, runId, sessionId, registry, tracked, classification, embeddingRequests, release, runOptions: { db, projectId, runId, sessionId, registry, icpDescription: 'AEO test' } }
}
