import { describe, expect, it } from 'vitest'
import { seoInstallConfigSchema } from '../src/seo.js'

const config = {
  enabled: true, fundingMode: 'hosted',
  policy: { maxRunCostMicros: 250_000, accountDailyLimitMicros: 1_000_000, accountMonthlyLimitMicros: 10_000_000, projectMonthlyLimitMicros: 2_000_000 },
  connections: { primary: { provider: 'dataforseo', label: 'SEO', enabled: true, login: 'operator@example.com', password: 'local-secret' } },
}
describe('SEO host policy', () => {
  it('requires explicit funding mode and caps instead of silently enabling uncapped work', () => {
    expect(seoInstallConfigSchema.parse(config).fundingMode).toBe('hosted')
    expect(seoInstallConfigSchema.safeParse({ ...config, fundingMode: undefined }).success).toBe(false)
    expect(seoInstallConfigSchema.safeParse({ ...config, policy: { ...config.policy, maxRunCostMicros: 0 } }).success).toBe(false)
    expect(seoInstallConfigSchema.safeParse({ ...config, policy: { ...config.policy, maxRunCostMicros: 0.5 } }).success).toBe(false)
    expect(seoInstallConfigSchema.safeParse({ ...config, policy: undefined }).success).toBe(false)
  })
  it('rejects unsupported providers and missing credentials before constructing an adapter', () => {
    expect(seoInstallConfigSchema.safeParse({ ...config, connections: { other: { ...config.connections.primary, provider: 'unsupported' } } }).success).toBe(false)
    expect(seoInstallConfigSchema.safeParse({ ...config, connections: { primary: { ...config.connections.primary, password: '' } } }).success).toBe(false)
  })
  it('accepts a cloro connection only with a key and a whole-microUSD price per credit', () => {
    const cloro = { provider: 'cloro', label: 'Search rankings', enabled: true, apiKey: 'local-secret', creditMicros: 800 }
    expect(seoInstallConfigSchema.parse({ ...config, connections: { rankings: cloro } }).connections.rankings).toEqual(cloro)
    for (const change of [{ apiKey: ' ' }, { creditMicros: 0 }, { creditMicros: 0.5 }, { creditMicros: undefined }, { login: 'operator@example.com' }]) {
      expect(seoInstallConfigSchema.safeParse({ ...config, connections: { rankings: { ...cloro, ...change } } }).success).toBe(false)
    }
  })
})
