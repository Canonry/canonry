import { beforeEach, describe, expect, it, vi } from 'vitest'

const trackEvent = vi.hoisted(() => vi.fn())
vi.mock('../src/telemetry.js', () => ({ trackEvent }))

const {
  createOutcomeSampler,
  handleRouteOutcome,
  outcomeAttribution,
  outcomeFailure,
  trackFeatureCompleted,
  trackInstallState,
  trackIntegrationConnection,
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
      { feature: 'backlinks', operation: 'install', status: 'succeeded', surface: 'mcp-stdio', agent: 'codex', trigger: 'agent' },
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
