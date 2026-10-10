import { beforeEach, describe, expect, it, vi } from 'vitest'

const trackEvent = vi.hoisted(() => vi.fn())
const telemetryOn = vi.hoisted(() => ({ value: false }))
vi.mock('../src/telemetry.js', () => ({ trackEvent, isTelemetryEnabled: () => telemetryOn.value }))

const {
  createOutcomeSampler,
  handleRouteOutcome,
  outcomeAttribution,
  outcomeFailure,
  trackFeatureCompleted,
  trackInstallState,
  trackIntegrationConnection,
  resetOutcomeMilestonesForTest,
} = await import('../src/outcome-telemetry.js')

beforeEach(() => trackEvent.mockReset())

describe('outcome attribution', () => {
  it('reads a request the way api.request does, and no request as the server acting alone', () => {
    expect(outcomeAttribution(undefined)).toEqual({ surface: 'system' })
    expect(outcomeAttribution({ userAgent: 'canonry-cli/7.21.0' })).toEqual({ surface: 'cli' })
    expect(outcomeAttribution({ userAgent: 'Mozilla/5.0' })).toEqual({ surface: 'dashboard' })
    expect(outcomeAttribution({ userAgent: 'canonry-mcp', agentLabel: 'Claude Code' })).toEqual({ surface: 'mcp-stdio', agent: 'claude-code' })
    expect(outcomeAttribution({ userAgent: 'curl/8', surfaceLabel: 'aero' })).toEqual({ surface: 'aero' })
    expect(outcomeAttribution({ userAgent: 'curl/8' })).toEqual({ surface: 'api' })
  })
})

describe('sending outcomes', () => {
  it('sends a valid connection attempt with its reason as the envelope error code', () => {
    trackIntegrationConnection({ integration: 'gsc', action: 'connect', status: 'failed', reasonCode: 'PERMISSION_MISSING', surface: 'dashboard' })
    expect(trackEvent).toHaveBeenCalledWith(
      'integration.connection',
      { integration: 'gsc', action: 'connect', status: 'failed', reasonCode: 'PERMISSION_MISSING', surface: 'dashboard' },
      { errorCode: 'PERMISSION_MISSING' },
    )
  })

  it('drops undefined fields instead of sending null', () => {
    trackFeatureCompleted({ feature: 'ga4', operation: 'sync', status: 'succeeded', counts: { rows: 3 }, reasonCode: undefined })
    expect(trackEvent).toHaveBeenCalledWith('feature.completed', { feature: 'ga4', operation: 'sync', status: 'succeeded', counts: { rows: 3 } }, undefined)
  })

  it('throws on an invalid payload under test, so schema drift cannot ship silently', () => {
    expect(() => trackFeatureCompleted({ feature: 'ga4', operation: 'turn', status: 'succeeded' } as never)).toThrow(/invalid feature.completed/)
    expect(() => trackInstallState({ providers: ['gemini'], integrations: ['provider'], counts: {}, usage24h: {} } as never)).toThrow(/invalid install.state/)
    expect(trackEvent).not.toHaveBeenCalled()
  })

  it('attributes a route outcome from its request unless the route already said', () => {
    handleRouteOutcome({
      event: 'feature.completed',
      properties: { feature: 'backlinks', operation: 'install', status: 'succeeded' },
      attribution: { userAgent: 'canonry-mcp', agentLabel: 'codex' },
    })
    expect(trackEvent).toHaveBeenLastCalledWith(
      'feature.completed',
      { feature: 'backlinks', operation: 'install', status: 'succeeded', surface: 'mcp-stdio', agent: 'codex' },
      undefined,
    )
    handleRouteOutcome({
      event: 'integration.connection',
      properties: { integration: 'webhook', action: 'test', status: 'failed', reasonCode: 'HTTP_5XX', target: 'slack', surface: 'dashboard' },
      errorCode: 'HTTP_5XX',
      attribution: { userAgent: 'canonry-cli/7.21.0' },
    })
    expect(trackEvent).toHaveBeenLastCalledWith(
      'integration.connection',
      { integration: 'webhook', action: 'test', status: 'failed', reasonCode: 'HTTP_5XX', target: 'slack', surface: 'dashboard' },
      { errorCode: 'HTTP_5XX' },
    )
  })

  it('turns a caught error into a reason and class name, never its message', () => {
    const err = Object.assign(new Error('token for https://acme.example rejected'), { status: 401 })
    expect(outcomeFailure(err)).toEqual({ reasonCode: 'INVALID_CREDENTIALS', errorName: 'Error' })
    expect(outcomeFailure(err, 'AUTH_DENIED').reasonCode).toBe('AUTH_DENIED')
  })
})

describe('outcome sampler', () => {
  it('passes a burst, then one per refill, and reports what it dropped', () => {
    let t = 0
    const sample = createOutcomeSampler({ burst: 2, refillMs: 1_000, now: () => t })
    expect(sample('webhooks.deliver')).toEqual({ send: true })
    expect(sample('webhooks.deliver')).toEqual({ send: true })
    expect(sample('webhooks.deliver')).toEqual({ send: false })
    expect(sample('webhooks.deliver')).toEqual({ send: false })
    // Keys are independent.
    expect(sample('server_traffic.ingest')).toEqual({ send: true })
    t = 1_000
    expect(sample('webhooks.deliver')).toEqual({ send: true, droppedBefore: 2 })
    expect(sample('webhooks.deliver')).toEqual({ send: false })
  })
})

describe('first-success flags', () => {
  it('mark the install\'s first success of each kind once, and only while telemetry is on', async () => {
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-milestones-'))
    const saved = process.env.CANONRY_CONFIG_DIR
    process.env.CANONRY_CONFIG_DIR = dir
    try {
      resetOutcomeMilestonesForTest()
      telemetryOn.value = true
      trackFeatureCompleted({ feature: 'ga4', operation: 'sync', status: 'failed', reasonCode: 'NETWORK' })
      trackFeatureCompleted({ feature: 'ga4', operation: 'sync', status: 'succeeded' })
      trackFeatureCompleted({ feature: 'ga4', operation: 'sync', status: 'succeeded' })
      trackIntegrationConnection({ integration: 'provider', provider: 'gemini', action: 'connect', status: 'succeeded' })
      trackIntegrationConnection({ integration: 'provider', provider: 'openai', action: 'connect', status: 'succeeded' })
      trackIntegrationConnection({ integration: 'provider', provider: 'gemini', action: 'test', status: 'succeeded' })
      const firsts = trackEvent.mock.calls.map(c => (c[1] as { first?: boolean }).first === true)
      expect(firsts).toEqual([false, true, false, true, true, false])
      // A new process reads the milestones back from disk.
      resetOutcomeMilestonesForTest()
      trackEvent.mockReset()
      trackFeatureCompleted({ feature: 'ga4', operation: 'sync', status: 'succeeded' })
      expect((trackEvent.mock.calls[0]![1] as { first?: boolean }).first).toBeUndefined()
      // Telemetry off: nothing is read or written.
      telemetryOn.value = false
      resetOutcomeMilestonesForTest()
      trackFeatureCompleted({ feature: 'gbp', operation: 'sync', status: 'succeeded' })
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'telemetry-milestones.json'), 'utf8')).keys).not.toContain('feature:gbp.sync')
    } finally {
      telemetryOn.value = false
      if (saved === undefined) delete process.env.CANONRY_CONFIG_DIR
      else process.env.CANONRY_CONFIG_DIR = saved
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
