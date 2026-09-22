import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClient, migrate, projects, type DatabaseClient } from '@ainyc/canonry-db'
import { AppError, validationError, agentViewContextSchema } from '@ainyc/canonry-contracts'
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type FauxProviderRegistration } from '@mariozechner/pi-ai'
import { aeroEvidenceFixture } from '../../contracts/test/fixtures/aero-evidence.js'
import { SessionRegistry } from '../src/agent/session-registry.js'
import { registerAgentRoutes } from '../src/agent/agent-routes.js'
import type { ApiClient } from '../src/client.js'
import type { CanonryConfig } from '../src/config.js'

let directory: string
let db: DatabaseClient
let app: FastifyInstance
let registry: SessionRegistry
let faux: FauxProviderRegistration
const read = vi.fn()
const context = agentViewContextSchema.parse({ view: 'property', selection: { scope: 'property', scopeKey: 'hotel', marketKey: 'london', queryClass: 'non-brand', runId: 'run-3' } })

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-turn-'))
  db = createClient(path.join(directory, 'data.db'))
  migrate(db)
  const now = new Date().toISOString()
  db.insert(projects).values({ id: 'demo', name: 'demo', displayName: 'Demo', canonicalDomain: 'demo.example', country: 'US', language: 'en', createdAt: now, updatedAt: now }).run()
  read.mockReset().mockResolvedValue(aeroEvidenceFixture('advanced'))
  registry = new SessionRegistry({ db, client: { getVisibilityReport: read } as unknown as ApiClient, config: { apiKey: 'test', providers: { claude: { apiKey: 'test' } }, basePath: '/canonry/' } as CanonryConfig })
  faux = registerFauxProvider({ api: 'aero-http-test', provider: 'aero-http-test', models: [{ id: 'test' }] })
  registry.getOrCreate('demo').state.model = faux.getModel()
  app = Fastify()
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) return reply.status(error.statusCode).send(error.toJSON())
    return reply.status(500).send(error)
  })
  registerAgentRoutes(app, { db, sessionRegistry: registry })
  await app.ready()
})
afterEach(async () => {
  await app?.close()
  faux.unregister()
  fs.rmSync(directory, { recursive: true, force: true })
})

it('streams evidence with limits, persists view metadata, and clears scope on the next turn', async () => {
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('aero_inspect_view', {}), { stopReason: 'toolUse' }),
    fauxAssistantMessage('The selected evidence is incomplete.'),
  ])
  const response = await app.inject({ method: 'POST', url: '/projects/demo/agent/prompt', payload: { prompt: 'Explain this Property', context, limits: { maxToolCalls: 2, timeoutMs: 10000 } } })
  expect(response.statusCode).toBe(200)
  expect(read).toHaveBeenCalledExactlyOnceWith('demo', context.selection)
  const events = response.body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)))
  expect(events.find(event => event.type === 'tool_execution_start')).toMatchObject({ label: 'Check selected evidence' })
  expect(events.find(event => event.type === 'aero_turn_status').status).toMatchObject({ reason: 'completed', toolCalls: 1, modelCalls: 2, limits: { maxToolCalls: 2, timeoutMs: 10000 } })
  expect(events.at(-1).type).toBe('stream_close')
  const transcript = (await app.inject('/projects/demo/agent/transcript')).json()
  expect(transcript.isStreaming).toBe(false)
  expect(transcript.messages[0]).toMatchObject({ role: 'user', aeroContext: context })
  expect(transcript.messages.find((message: { role: string }) => message.role === 'toolResult')).toMatchObject({ aeroToolLabel: 'Check selected evidence', aeroDurationMs: expect.any(Number) })
  const next = await registry.acquireForTurn('demo', { toolScope: 'read-only' })
  expect(next.state.systemPrompt).not.toContain('Current view (')
  expect(next.state.tools.map(tool => tool.name)).not.toContain('canonry_run_trigger')
})

it('rejects foreign scope before a model call and rejects malformed limits', async () => {
  const generate = vi.fn(() => fauxAssistantMessage('Should not run'))
  faux.setResponses([generate])
  read.mockRejectedValue(validationError('Property belongs to another project'))
  const rejected = await app.inject({ method: 'POST', url: '/projects/demo/agent/prompt', payload: { prompt: 'Explain', context } })
  expect(rejected.statusCode).toBe(400)
  expect(generate).not.toHaveBeenCalled()
  const invalid = await app.inject({ method: 'POST', url: '/projects/demo/agent/prompt', payload: { prompt: 'Explain', limits: { maxToolCalls: 101 } } })
  expect(invalid.statusCode).toBe(400)
  expect(read).toHaveBeenCalledTimes(1)
})

it('reserves the session during context reads and honors cancellation before generation', async () => {
  let release!: () => void
  read.mockImplementation(async () => {
    await new Promise<void>(resolve => { release = resolve })
    return aeroEvidenceFixture('advanced')
  })
  const signal = new AbortController()
  const acquiring = registry.acquireForTurn('demo', { context, signal: signal.signal })
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
  expect(registry.isBusy('demo')).toBe(true)
  await expect(registry.acquireForTurn('demo', { toolScope: 'all' })).rejects.toMatchObject({ code: 'AGENT_BUSY' })
  signal.abort()
  release()
  await expect(acquiring).rejects.toMatchObject({ name: 'AbortError' })
  expect(registry.isBusy('demo')).toBe(false)
})
