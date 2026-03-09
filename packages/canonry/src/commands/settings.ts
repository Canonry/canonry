import { loadConfig } from '../config.js'
import { ApiClient } from '../client.js'

function getClient(): ApiClient {
  const config = loadConfig()
  return new ApiClient(config.apiUrl, config.apiKey)
}

export async function showSettings(): Promise<void> {
  const client = getClient()
  const settings = await client.getSettings() as {
    provider: { name: string; model: string }
    quota: { maxConcurrency: number; maxRequestsPerMinute: number; maxRequestsPerDay: number }
  }

  console.log('Provider settings:\n')
  console.log(`  Provider: ${settings.provider.name}`)
  console.log(`  Model:    ${settings.provider.model}`)
  console.log('\nQuota policy:\n')
  console.log(`  Max concurrency:        ${settings.quota.maxConcurrency}`)
  console.log(`  Max requests/minute:    ${settings.quota.maxRequestsPerMinute}`)
  console.log(`  Max requests/day:       ${settings.quota.maxRequestsPerDay}`)
}
