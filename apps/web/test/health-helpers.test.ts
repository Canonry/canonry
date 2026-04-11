import { describe, it, expect } from 'vitest'
import { getLaunchBlockedReason, buildSetupModel, serviceStatusTooltip } from '../src/lib/health-helpers.js'
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
      providerStatuses: [{ name: 'gemini', state: 'not-configured', detail: '' }],
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
      providerStatuses: [{ name: 'gemini', state: 'not-configured', detail: '' }],
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
