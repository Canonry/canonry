import type { ProviderConnectionConfigDto, ProviderConnectionSettingsDto } from '@canonry/canonry-contracts'

export const providerConnectionFixture: ProviderConnectionConfigDto = {
  name: 'openai', displayName: 'OpenAI', kind: 'answer-engine', mode: 'api',
  configured: true, revision: 'connection-v1', apiKeyConfigured: true,
  baseUrl: null, model: 'gpt-old', defaultModel: 'gpt-default', effectiveModel: 'gpt-old',
  quota: {
    defaults: { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 100 },
    overrides: { maxRequestsPerDay: 25 },
    effective: { maxConcurrency: 2, maxRequestsPerMinute: 10, maxRequestsPerDay: 25 },
  },
  capabilities: { apiKey: true, clearApiKey: false, baseUrl: false, resetBaseUrl: false, model: true, quota: true, disconnect: true, reload: true },
  hostManaged: { vertex: null, batch: null, pricing: null }, hostUses: [], blockers: [],
}

export const providerSettingsFixture: ProviderConnectionSettingsDto = {
  ...providerConnectionFixture,
  usage: { projectCount: 1, projects: [{ name: 'demo', displayName: 'Demo', providers: ['openai'], sources: ['project'] }] },
  impactRevision: 'impact-v1',
}
