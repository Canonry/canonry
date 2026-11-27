import { describe, it, expect } from 'vitest'
import { buildSystemHealthCards, getLaunchBlockedReason, buildSetupModel, serviceStatusTooltip, systemHealthNeedingAttention } from '../src/lib/health-helpers.js'
import type { HealthSnapshot, SettingsVm, SetupWizardVm } from '../src/view-models.js'

function makeHealth(overrides?: Partial<HealthSnapshot>): HealthSnapshot {
  return {
    apiStatus: { label: 'API', state: 'ok', detail: 'v1.0.0', databaseConfigured: true },
    workerStatus: { label: 'Worker', state: 'ok', detail: 'healthy' },
    ...overrides,
  }
}

function makeSettings(overrides?: Partial<SettingsVm>): SettingsVm {
  return {
    providerStatuses: [{ name: 'gemini', state: 'ready', detail: 'configured' }],
    googleOAuth: { clientId: '', clientSecret: '', configured: false },
    ...overrides,
  } as SettingsVm
}

describe('getLaunchBlockedReason', () => {
  it('returns undefined when all systems are healthy', () => {
    expect(getLaunchBlockedReason(makeHealth(), makeSettings())).toBeUndefined()
  })

  it('blocks when API is not ok', () => {
    const health = makeHealth({ apiStatus: { label: 'API', state: 'error', detail: 'unreachable' } })
    expect(getLaunchBlockedReason(health, makeSettings())).toContain('API')
  })

  it('blocks when database is not configured', () => {
    const health = makeHealth({
      apiStatus: { label: 'API', state: 'ok', detail: 'v1', databaseConfigured: false },
    })
    expect(getLaunchBlockedReason(health, makeSettings())).toContain('database')
  })

  it('blocks when worker is not ok', () => {
    const health = makeHealth({
      workerStatus: { label: 'Worker', state: 'error', detail: 'down' },
    })
    expect(getLaunchBlockedReason(health, makeSettings())).toContain('worker')
  })

  it('blocks when no providers are configured', () => {
    const settings = makeSettings({
      providerStatuses: [{ name: 'gemini', state: 'needs-config', detail: '' }],
    })
    expect(getLaunchBlockedReason(makeHealth(), settings)).toContain('provider')
  })
})

describe('serviceStatusTooltip', () => {
  it('combines detail and troubleshooting hint for failed checks', () => {
    expect(serviceStatusTooltip({
      label: 'API',
      state: 'error',
      detail: 'API 404: Not Found',
      hint: 'Check basePath configuration.',
    })).toBe('API 404: Not Found\nCheck basePath configuration.')
  })
})

describe('buildSetupModel', () => {
  const baseModel: SetupWizardVm = {
    healthChecks: [
      { id: 'api', label: 'API', detail: '', state: 'pending' },
      { id: 'worker', label: 'Worker', detail: '', state: 'pending' },
      { id: 'providers', label: 'Providers', detail: '', state: 'pending' },
    ],
    launchState: {
      enabled: false,
      blockedReason: undefined,
      summary: '',
    },
  }

  it('enables launch when all systems healthy', () => {
    const result = buildSetupModel(baseModel, makeHealth(), makeSettings())
    expect(result.launchState.enabled).toBe(true)
    expect(result.launchState.blockedReason).toBeUndefined()
  })

  it('disables launch and sets reason when API is down', () => {
    const health = makeHealth({ apiStatus: { label: 'API', state: 'error', detail: 'down' } })
    const result = buildSetupModel(baseModel, health, makeSettings())
    expect(result.launchState.enabled).toBe(false)
    expect(result.launchState.blockedReason).toContain('API')
  })

  it('updates health check states from snapshot', () => {
    const result = buildSetupModel(baseModel, makeHealth(), makeSettings())
    const apiCheck = result.healthChecks.find(c => c.id === 'api')
    const workerCheck = result.healthChecks.find(c => c.id === 'worker')
    expect(apiCheck?.state).toBe('ready')
    expect(workerCheck?.state).toBe('ready')
  })

  it('marks provider check as attention when none configured', () => {
    const settings = makeSettings({
      providerStatuses: [{ name: 'gemini', state: 'needs-config', detail: '' }],
    })
    const result = buildSetupModel(baseModel, makeHealth(), settings)
    const provCheck = result.healthChecks.find(c => c.id !== 'api' && c.id !== 'worker')
    expect(provCheck?.state).toBe('attention')
  })

  it('does not mutate the base model', () => {
    const original = JSON.stringify(baseModel)
    buildSetupModel(baseModel, makeHealth(), makeSettings())
    expect(JSON.stringify(baseModel)).toBe(original)
  })
})


describe('MCP system health', () => {
  it.each([
    ['available', 'Available', 'positive'],
    ['unavailable', 'Unavailable', 'negative'],
    ['not-supported', 'Not enabled', 'neutral'],
    [undefined, 'Unknown', 'neutral'],
  ] as const)('reports %s independently of a healthy API', (status, detail, tone) => {
    const health = makeHealth()
    health.apiStatus.mcp = status ? { status } : undefined
    const cards = buildSystemHealthCards([
      { id: 'api', label: 'API', tone: 'neutral', detail: '', meta: '' },
    ], health, makeSettings())
    expect(cards.map(card => card.id)).toEqual(['api', 'mcp'])
    expect(cards[0]?.detail).toBe('Healthy')
    expect(cards[1]).toMatchObject({ label: 'MCP', detail, tone })
    expect(getLaunchBlockedReason(health, makeSettings())).toBeUndefined()
  })

  it('does not claim MCP is available when the health request failed', () => {
    const health = makeHealth()
    health.apiStatus.state = 'error'
    health.apiStatus.mcp = { status: 'available' }
    expect(buildSystemHealthCards([], health, makeSettings())[0]).toMatchObject({ id: 'mcp', detail: 'Unknown' })
  })
})

describe('systemHealthNeedingAttention', () => {
  const cards = [
    { id: 'api', label: 'API', tone: 'neutral' as const, detail: '', meta: '' },
    { id: 'worker', label: 'Worker', tone: 'neutral' as const, detail: '', meta: '' },
    { id: 'provider', label: 'Gemini', tone: 'positive' as const, detail: 'Configured', meta: '' },
  ]
  const attention = (health: HealthSnapshot, settings: SettingsVm) =>
    systemHealthNeedingAttention(buildSystemHealthCards(cards, health, settings), health)
      .map(({ card, serviceStatus }) => [card.label, card.detail, serviceStatus?.state ?? null])

  it('lists nothing while every service is healthy and a provider is ready', () => {
    expect(attention(makeHealth(), makeSettings())).toEqual([])
  })

  it('lists a service that is not healthy, but never one still being checked', () => {
    const health = makeHealth({
      apiStatus: { label: 'API', state: 'checking', detail: 'Checking service health' },
      workerStatus: { label: 'Worker', state: 'error', detail: 'heartbeat stale' },
    })
    expect(attention(health, makeSettings())).toEqual([['Worker', 'Needs attention', 'error']])
    expect(attention(makeHealth({ workerStatus: { label: 'Worker', state: 'disabled', detail: 'off' } }), makeSettings()))
      .toEqual([['Worker', 'Disabled', 'disabled']])
  })

  it('lists unavailable MCP, but not an MCP status the server does not report', () => {
    const unavailable = makeHealth()
    unavailable.apiStatus.mcp = { status: 'unavailable' }
    expect(attention(unavailable, makeSettings())).toEqual([['MCP', 'Unavailable', null]])
    expect(attention(makeHealth(), makeSettings())).toEqual([])
  })

  // Settings still loading (or refused) list no providers: that is unknown, never "none configured".
  it('lists missing providers only once provider settings have loaded', () => {
    expect(attention(makeHealth(), makeSettings({ providerStatuses: [] }))).toEqual([['Providers', '0 of 0 configured', null]])
    expect(attention(makeHealth(), makeSettings({ providerStatuses: [], providersKnown: false }))).toEqual([])
    expect(buildSystemHealthCards(cards, makeHealth(), makeSettings({ providerStatuses: [], providersKnown: false })).find(card => card.id === 'provider'))
      .toMatchObject({ label: 'Providers', tone: 'neutral', detail: 'Unknown' })
  })
})
