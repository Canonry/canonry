import type { ProviderConnectionSettingsDto, SettingsDto } from '@canonry/canonry-contracts'

export function connectionFixture(overrides: Partial<ProviderConnectionSettingsDto> = {}): ProviderConnectionSettingsDto {
  return {
    name: 'openai', displayName: 'OpenAI', kind: 'answer-engine', mode: 'api', configured: true,
    revision: 'saved-revision', impactRevision: 'impact-revision', apiKeyConfigured: true,
    baseUrl: null, model: null, defaultModel: 'gpt-default', effectiveModel: 'gpt-default',
    quota: { defaults: { maxConcurrency: 2, maxRequestsPerMinute: 20, maxRequestsPerDay: 200 }, overrides: {}, effective: { maxConcurrency: 2, maxRequestsPerMinute: 20, maxRequestsPerDay: 200 } },
    capabilities: { apiKey: true, clearApiKey: false, baseUrl: true, resetBaseUrl: true, model: true, quota: true, disconnect: true, reload: true },
    hostManaged: { vertex: null, batch: null, pricing: null }, hostUses: [], blockers: [],
    usage: { projectCount: 0, projects: [] }, ...overrides,
  }
}

export function settingsFixture(connections: ProviderConnectionSettingsDto[]): SettingsDto {
  return {
    providers: connections.map(connection => ({ name: connection.name, displayName: connection.displayName, kind: connection.kind, configured: connection.configured, ...(connection.model ? { model: connection.model } : {}), ...(connection.defaultModel ? { defaultModel: connection.defaultModel } : {}) })),
    providerConnections: connections,
    providerCatalog: connections.map(connection => ({ name: connection.name, displayName: connection.displayName, kind: connection.kind, mode: connection.mode, modelConfigurable: connection.capabilities.model, defaultModel: connection.defaultModel ?? '', knownModels: [{ id: 'custom-model', displayName: 'Custom model', tier: 'standard' }], modelValidationPattern: { source: '.', flags: '' }, modelValidationHint: 'Use a model ID.' })),
    google: { configured: false }, bing: { configured: false },
  }
}
