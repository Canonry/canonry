import { describe, it, expect } from 'vitest'

/**
 * Verifies the test-environment guards installed by `test/setup.ts`.
 *
 * If any of these regress, individual tests can silently fire real telemetry
 * or hit external services — the original install-count inflation came from
 * exactly that kind of accidental side effect.
 */
describe('test setup hardening', () => {
  it('CANONRY_TELEMETRY_DISABLED is forced to 1 for the whole worker', () => {
    expect(process.env.CANONRY_TELEMETRY_DISABLED).toBe('1')
  })

  it('blocks fetch to the canonry telemetry endpoint with a clear error', async () => {
    await expect(
      globalThis.fetch('https://canonry.ai/api/telemetry', {
        method: 'POST',
        body: JSON.stringify({ event: 'leak' }),
      }),
    ).rejects.toThrow(/Blocked telemetry request/)
  })

  it('blocks fetch to arbitrary external hostnames', async () => {
    await expect(globalThis.fetch('https://example.com/x')).rejects.toThrow(/Blocked external network request/)
    await expect(globalThis.fetch(new URL('https://api.openai.com/v1/responses'))).rejects.toThrow(
      /Blocked external network request/,
    )
  })

  it('allows fetch to localhost and 127.0.0.1 (real Fastify integration tests still work)', async () => {
    // Use a port that nothing is listening on — we just need to confirm the
    // guard does not pre-throw before the request reaches the network layer.
    // A real ECONNREFUSED is fine; a "Blocked …" error is the regression.
    let guardError: unknown
    try {
      await globalThis.fetch('http://127.0.0.1:1/none')
    } catch (err) {
      guardError = err
    }
    expect(String(guardError)).not.toMatch(/Blocked /)
  })
})
