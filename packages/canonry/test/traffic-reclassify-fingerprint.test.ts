import { afterEach, describe, expect, it, vi } from 'vitest'

type IntegrationTraffic = typeof import('@canonry/canonry-integration-traffic')

/** The pass's fingerprint, with the browser-agent request rules changed as given. */
async function fingerprintWith(change: (traffic: IntegrationTraffic) => Record<string, unknown>): Promise<string> {
  vi.resetModules()
  vi.doMock('@canonry/canonry-integration-traffic', async (importOriginal) => {
    const traffic = await importOriginal<IntegrationTraffic>()
    return { ...traffic, ...change(traffic) }
  })
  const { trafficClassificationFingerprint } = await import('../src/traffic-reclassify.js')
  return trafficClassificationFingerprint()
}

describe('trafficClassificationFingerprint', () => {
  afterEach(() => {
    vi.doUnmock('@canonry/canonry-integration-traffic')
    vi.resetModules()
  })

  // A change to the browser-agent request rules must run the pass again, so
  // it marks the sources whose hours were counted the older way.
  it('changes with the browser-agent request rules version and the set of browser agents', async () => {
    const current = await fingerprintWith(() => ({}))

    expect(await fingerprintWith(() => ({}))).toBe(current)
    expect(await fingerprintWith(traffic => ({ BROWSER_AGENT_REQUEST_RULES_VERSION: traffic.BROWSER_AGENT_REQUEST_RULES_VERSION + 1 }))).not.toBe(current)
    expect(await fingerprintWith(traffic => ({ BROWSER_AGENT_BOT_IDS: [...traffic.BROWSER_AGENT_BOT_IDS, 'perplexity-user'] }))).not.toBe(current)
  })
})
