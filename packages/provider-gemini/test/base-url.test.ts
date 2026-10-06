import { test, expect, vi, afterEach, onTestFinished } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { geminiAdapter } from '../src/adapter.js'
import { embedQueries } from '../src/embeddings.js'

const quotaPolicy = { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 1000 }

interface SentRequest {
  url: string
  method: string
  body: unknown
  apiKey: string | null
  authorization: string | null
}

function captureRequests(response: object): SentRequest[] {
  const sent: SentRequest[] = []
  vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', 'false')
  vi.stubEnv('GOOGLE_GEMINI_BASE_URL', '')
  vi.stubEnv('GOOGLE_VERTEX_BASE_URL', '')
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init)
    sent.push({
      url: request.url,
      method: request.method,
      body: await request.json(),
      apiKey: request.headers.get('x-goog-api-key'),
      authorization: request.headers.get('authorization'),
    })
    return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  return sent
}

// Real GoogleAuth reads this credential file and exchanges its subject token
// through loopback HTTP. Only the external token service is a fixture.
async function vertexCredentials() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-oauth-'))
  onTestFinished(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const exchanges: Array<{ method: string | undefined; path: string | undefined; body: Record<string, string> }> = []
  const server = http.createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      exchanges.push({ method: request.method, path: request.url, body: Object.fromEntries(new URLSearchParams(body)) })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ access_token: 'fixture-vertex-access', expires_in: 3600, token_type: 'Bearer' }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  onTestFinished(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected loopback OAuth address')
  const subject = path.join(tmp, 'subject.txt')
  const credentials = path.join(tmp, 'credentials.json')
  fs.writeFileSync(subject, 'fixture-subject-token')
  fs.writeFileSync(credentials, JSON.stringify({
    type: 'external_account',
    audience: '//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/test/providers/test',
    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    token_url: `http://127.0.0.1:${address.port}/token`,
    credential_source: { file: subject, format: { type: 'text' } },
  }))
  // Losing the explicit credential path must not pick up an operator's ADC.
  vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', path.join(tmp, 'absent.json'))
  return { credentials, exchanges }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

test('geminiAdapter routes successful tracked requests through configured and default SDK endpoints', async () => {
  const response = {
    candidates: [{ content: { role: 'model', parts: [{ text: 'native routing answer' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
    modelVersion: 'gemini-routing-preview', responseId: 'routing-response',
  }
  const cases = [
    { label: 'AI Studio proxy', baseUrl: 'https://proxy.example.com', url: 'https://proxy.example.com/v1beta/models/gemini-2.5-flash:generateContent' },
    { label: 'AI Studio default', baseUrl: undefined, url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent' },
    { label: 'AI Studio empty endpoint', baseUrl: '', url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent' },
    { label: 'AI Studio prefixed proxy', baseUrl: 'https://proxy.example.com/gemini', url: 'https://proxy.example.com/gemini/v1beta/models/gemini-2.5-flash:generateContent' },
    { label: 'Vertex prefixed proxy', baseUrl: 'https://proxy.example.com/gemini', vertexProject: 'fixture-project', vertexRegion: 'europe-west4', url: 'https://proxy.example.com/gemini/v1beta1/projects/fixture-project/locations/europe-west4/publishers/google/models/gemini-2.5-flash:generateContent' },
    { label: 'Vertex default region', baseUrl: undefined, vertexProject: 'fixture-project', vertexRegion: undefined, url: 'https://us-central1-aiplatform.googleapis.com/v1beta1/projects/fixture-project/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent' },
    { label: 'Vertex explicit region', baseUrl: undefined, vertexProject: 'fixture-project', vertexRegion: 'europe-west4', url: 'https://europe-west4-aiplatform.googleapis.com/v1beta1/projects/fixture-project/locations/europe-west4/publishers/google/models/gemini-2.5-flash:generateContent' },
  ]
  for (const row of cases) {
    const auth = row.vertexProject ? await vertexCredentials() : undefined
    const sent = captureRequests(response)
    const result = await geminiAdapter.executeTrackedQuery(
      { query: 'routing query', canonicalDomains: ['example.com'], competitorDomains: [] },
      { provider: 'gemini', apiKey: auth ? '' : 'tenant-virtual-key', model: 'gemini-2.5-flash', quotaPolicy,
        baseUrl: row.baseUrl, vertexProject: row.vertexProject, vertexRegion: row.vertexRegion, vertexCredentials: auth?.credentials },
    )
    expect(sent, row.label).toEqual([{
      url: row.url, method: 'POST',
      body: { contents: [{ parts: [{ text: 'routing query' }], role: 'user' }], tools: [{ googleSearch: {} }], generationConfig: {} },
      apiKey: auth ? null : 'tenant-virtual-key', authorization: auth ? 'Bearer fixture-vertex-access' : null,
    }])
    expect(result, row.label).toEqual({
      provider: 'gemini', model: 'gemini-2.5-flash', servedModel: 'gemini-routing-preview',
      rawResponse: { candidates: [{ content: { role: 'model', parts: [{ text: 'native routing answer' }] }, finishReason: 'STOP', groundingMetadata: undefined }],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 }, modelVersion: 'gemini-routing-preview', responseId: 'routing-response' },
      groundingSources: [], searchQueries: [], retrievalStatus: 'unknown', retrievalContract: 'native-auto-v1',
      usage: { inputTokens: 2, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 3, searchCount: 0 }, stopReason: 'STOP',
    })
    if (auth) expect(auth.exchanges, row.label).toEqual([{
      method: 'POST', path: '/token', body: {
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        audience: '//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/test/providers/test',
        requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        subject_token: 'fixture-subject-token', subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
        scope: 'https://www.googleapis.com/auth/cloud-platform',
      },
    }])
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  }
})

test('embedQueries preserves the baseUrl path prefix when building embed request URLs', async () => {
  for (const row of [
    { label: 'embedding proxy', baseUrl: 'https://proxy.example.com', url: 'https://proxy.example.com/v1beta/models/gemini-embedding-001:batchEmbedContents' },
    { label: 'embedding default', baseUrl: undefined, url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents' },
    { label: 'embedding empty', baseUrl: '', url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents' },
    { label: 'embedding prefixed proxy', baseUrl: 'https://proxy.example.com/gemini', url: 'https://proxy.example.com/gemini/v1beta/models/gemini-embedding-001:batchEmbedContents' },
  ]) {
    const sent = captureRequests({ embeddings: [{ values: [0.1, 0.2] }] })
    expect(await embedQueries(['routing query'], { apiKey: 'tenant-virtual-key', baseUrl: row.baseUrl }), row.label).toEqual([[0.1, 0.2]])
    expect(sent, row.label).toEqual([{
      url: row.url, method: 'POST', apiKey: 'tenant-virtual-key', authorization: null,
      body: { requests: [{ content: { role: 'user', parts: [{ text: 'routing query' }] }, taskType: 'CLUSTERING', outputDimensionality: 768, model: 'models/gemini-embedding-001' }] },
    }])
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  }
})
