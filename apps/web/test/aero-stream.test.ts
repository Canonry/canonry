import { afterEach, expect, it, vi } from 'vitest'
import { promptAero } from '../src/api-aero.js'

const encode = (event: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)
afterEach(() => vi.unstubAllGlobals())

it('forwards frozen context and accepts a clean stream close', async () => {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(encode({ type: 'stream_close' })))
  vi.stubGlobal('fetch', fetch)
  const onEvent = vi.fn()
  const context = { view: 'site-health' as const, page: { runId: 'scan-1', nodeKey: 'page-2' } }
  await promptAero({ project: 'demo', prompt: 'Explain', scope: 'read-only', context, onEvent })
  expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toMatchObject({ context, scope: 'read-only' })
  expect(onEvent).toHaveBeenCalledExactlyOnceWith({ type: 'stream_close' })
})

it('reports unexpected EOF after delivering partial messages', async () => {
  const partial = { type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'Partial answer' }] } }
  vi.stubGlobal('fetch', vi.fn(async () => new Response(encode(partial))))
  const onEvent = vi.fn()
  await expect(promptAero({ project: 'demo', prompt: 'Explain', onEvent })).rejects.toThrow('Connection ended before Aero finished')
  expect(onEvent).toHaveBeenCalledWith(partial)
})

it('cancels a stalled reader promptly when Stop aborts', async () => {
  const cancelled = vi.fn()
  const controller = new AbortController()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
    start(stream) { stream.enqueue(encode({ type: 'stream_open' })) }, cancel: cancelled,
  }))))
  const request = promptAero({ project: 'demo', prompt: 'Explain', signal: controller.signal, onEvent: () => controller.abort() })
  await expect(request).rejects.toMatchObject({ name: 'AbortError' })
  expect(cancelled).toHaveBeenCalledTimes(1)
})
