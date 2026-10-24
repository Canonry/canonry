import { afterEach, expect, it, vi } from 'vitest'
import { normalizeContext } from '@earendil-works/pi-ai'
import { aeroStreamFn, completeOnce } from '../src/agent/pi-models.js'
import { resolveModelForProvider } from '../src/agent/providers.js'
import { getSharedProviderExecutionGate, resetSharedProviderExecutionGates } from '../src/provider-execution-gate.js'
import { openRouterCompletionsReply, openRouterMessagesReply } from './openrouter-pi-fixture.js'

afterEach(() => { vi.unstubAllGlobals(); resetSharedProviderExecutionGates() })

const DEFAULT_MODEL = 'openai/gpt-6-luna'
const MESSAGES_MODEL = 'anthropic/claude-haiku-4.5'

it('holds one OpenRouter connection through streaming, shares it across models and cancels queued generation', async () => {
  getSharedProviderExecutionGate('openrouter', 1, 60)
  const dispatched: string[] = []
  let release!: () => void
  // pi calls the default model through OpenRouter's chat completions API and
  // the Anthropic model through its messages API; both share one connection.
  vi.stubGlobal('fetch', async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(url, init)
    const body = await request.json() as { model: string }
    dispatched.push(body.model)
    const text = dispatched.length === 1 ? 'Streaming answer.' : 'Next answer.'
    let reply: string
    if (body.model === DEFAULT_MODEL) {
      expect(request.url).toBe('https://openrouter.ai/api/v1/chat/completions')
      expect(request.headers.get('authorization')).toBe('Bearer shared-key')
      reply = openRouterCompletionsReply(body.model, text)
    } else {
      expect(request.url).toBe('https://openrouter.ai/api/v1/messages?beta=true')
      expect(request.headers.get('x-api-key')).toBe('shared-key')
      reply = openRouterMessagesReply(text)
    }
    const bytes = new TextEncoder().encode(reply)
    if (dispatched.length > 1) return new Response(bytes, { headers: { 'content-type': 'text/event-stream' } })
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { release = () => { controller.enqueue(bytes); controller.close() } } }), { headers: { 'content-type': 'text/event-stream' } })
  })
  const context = { messages: [{ role: 'user' as const, content: 'Synthetic query.', timestamp: 1 }] }
  const first = await aeroStreamFn(resolveModelForProvider('openrouter'), normalizeContext(context), { apiKey: 'shared-key' })
  await vi.waitFor(() => expect(dispatched).toEqual([DEFAULT_MODEL]))
  const nextModel = resolveModelForProvider('openrouter', MESSAGES_MODEL)
  const next = completeOnce(nextModel, context, { apiKey: 'shared-key' })
  const controller = new AbortController()
  const canceled = completeOnce(nextModel, context, { apiKey: 'shared-key', signal: controller.signal })
  controller.abort()
  await expect(canceled).rejects.toMatchObject({ name: 'AbortError' })
  expect(dispatched).toHaveLength(1)
  release()
  expect(await first.result()).toMatchObject({ stopReason: 'stop', content: [{ type: 'text', text: 'Streaming answer.' }] })
  expect(await next).toMatchObject({ stopReason: 'stop', content: [{ type: 'text', text: 'Next answer.' }] })
  expect(dispatched).toEqual([DEFAULT_MODEL, MESSAGES_MODEL])
})
