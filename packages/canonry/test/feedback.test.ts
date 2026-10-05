import { describe, expect, it, vi } from 'vitest'
import { FEEDBACK_ENDPOINT, FEEDBACK_MAX_BODY_BYTES, sendFeedback } from '../src/feedback.js'

function collector(status: number, body: unknown = { accepted: true, id: 'srv-id' }) {
  const calls: Array<{ url: string; payload: Record<string, unknown> }> = []
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), payload: JSON.parse(String(init?.body)) as Record<string, unknown> })
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }) as unknown as typeof fetch
  return { calls, fetchFn }
}

const ANON = '11111111-2222-4333-8444-555555555555'

describe('sendFeedback', () => {
  it('posts a redacted report with version, source and agent to canonry.ai', async () => {
    const { calls, fetchFn } = collector(202)
    const result = await sendFeedback(
      { kind: 'struggle', summary: 'Gemini 401 with key AIzaSyA1234567890abcdefghijklmnopqrstuv', details: 'apiKey=topsecretvalue then retried' },
      { userAgent: 'canonry-mcp', surface: 'mcp-stdio', agent: 'Claude-Code' },
      { fetch: fetchFn, telemetryEnabled: () => true, anonymousId: () => ANON },
    )

    expect(result).toEqual({ accepted: true, id: 'srv-id' })
    expect(calls).toHaveLength(1)
    const [{ url, payload }] = calls
    expect(url).toBe(FEEDBACK_ENDPOINT)
    expect(payload).toMatchObject({ kind: 'struggle', source: 'mcp', agent: 'claude-code', anonymousId: ANON })
    expect(String(payload.summary)).not.toContain('AIzaSy')
    expect(String(payload.details)).not.toContain('topsecretvalue')
    expect(payload.feedbackId).toMatch(/^[0-9a-f-]{36}$/)
    for (const key of ['version', 'nodeVersion', 'os', 'arch', 'timestamp']) expect(payload[key]).toBeTypeOf('string')
  })

  it('leaves the install id out while telemetry is disabled', async () => {
    const { calls, fetchFn } = collector(202)
    const anonymousId = vi.fn(() => ANON)
    await sendFeedback({ kind: 'improvement', summary: 'skip competitors from the CLI' }, { userAgent: 'canonry-cli/6.3.0' },
      { fetch: fetchFn, telemetryEnabled: () => false, anonymousId })
    expect(calls[0]!.payload).not.toHaveProperty('anonymousId')
    expect(anonymousId).not.toHaveBeenCalled()
    expect(calls[0]!.payload.source).toBe('cli')
  })

  it('maps the dashboard and unknown callers to their sources and drops a "none" agent', async () => {
    const { calls, fetchFn } = collector(202)
    const deps = { fetch: fetchFn, telemetryEnabled: () => false }
    await sendFeedback({ kind: 'other', summary: 'a' }, { userAgent: 'Mozilla/5.0', agent: 'none' }, deps)
    await sendFeedback({ kind: 'other', summary: 'b' }, { userAgent: 'curl/8' }, deps)
    expect(calls.map(c => c.payload.source)).toEqual(['dashboard', 'api'])
    expect(calls[0]!.payload).not.toHaveProperty('agent')
  })

  it('turns collector refusals into Canonry errors', async () => {
    const send = (status: number) => sendFeedback({ kind: 'bug', summary: 'x' }, {}, { fetch: collector(status, { error: 'nope' }).fetchFn, telemetryEnabled: () => false })
    await expect(send(429)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
    await expect(send(400)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(send(500)).rejects.toMatchObject({ code: 'DELIVERY_FAILED' })
  })

  it('reports an unreachable collector as a delivery failure', async () => {
    const fetchFn = vi.fn(async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
    await expect(sendFeedback({ kind: 'bug', summary: 'x' }, {}, { fetch: fetchFn, telemetryEnabled: () => false }))
      .rejects.toMatchObject({ code: 'DELIVERY_FAILED' })
  })

  it('redacts credentials in every free-text field, including area and errorCode', async () => {
    const { calls, fetchFn } = collector(202)
    await sendFeedback(
      { kind: 'bug', summary: 'see command', command: 'cnry settings provider openai --api-key sk-live-1111', area: 'token=abc123', errorCode: 'sk-proj-abcdefghijklmnop1234' },
      {}, { fetch: fetchFn, telemetryEnabled: () => false },
    )
    const sent = JSON.stringify(calls[0]!.payload)
    for (const secret of ['sk-live-1111', 'abc123', 'sk-proj-abcdefghijklmnop1234']) expect(sent).not.toContain(secret)
  })

  it('keeps a valid long non-ASCII report under the collector body limit', async () => {
    const { calls, fetchFn } = collector(202)
    await sendFeedback(
      { kind: 'struggle', summary: '首次运行失败'.repeat(80), details: '日本語の詳細'.repeat(666) + '詳細' },
      {}, { fetch: fetchFn, telemetryEnabled: () => false },
    )
    const body = String((fetchFn as unknown as { mock: { calls: Array<[unknown, RequestInit]> } }).mock.calls[0]![1].body)
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(FEEDBACK_MAX_BODY_BYTES)
    expect(String(calls[0]!.payload.summary).length).toBe(480)
    expect(String(calls[0]!.payload.details).length).toBeGreaterThan(1000)
  })

  it('treats the "none" agent sentinel as absent so the MCP client still names the agent', async () => {
    const { calls, fetchFn } = collector(202)
    await sendFeedback({ kind: 'other', summary: 'x' }, { surface: 'mcp-stdio', agent: 'none', mcpClient: 'claude-desktop' },
      { fetch: fetchFn, telemetryEnabled: () => false })
    expect(calls[0]!.payload.agent).toBe('claude-desktop')
  })
})
