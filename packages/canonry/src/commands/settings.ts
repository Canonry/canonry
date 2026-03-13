import { loadConfig } from '../config.js'
import { ApiClient } from '../client.js'

function getClient(): ApiClient {
  const config = loadConfig()
  return new ApiClient(config.apiUrl, config.apiKey)
}

export async function setProvider(name: string, opts: {
  apiKey?: string
  baseUrl?: string
  model?: string
  quota?: { maxConcurrency?: number; maxRequestsPerMinute?: number; maxRequestsPerDay?: number }
}): Promise<void> {
  const client = getClient()
  const result = await client.updateProvider(name, opts) as {
    name: string
    model?: string
    configured: boolean
    quota?: { maxConcurrency: number; maxRequestsPerMinute: number; maxRequestsPerDay: number }
  }
  console.log(`Provider ${result.name} updated successfully.`)
  if (result.model) {
    console.log(`  Model: ${result.model}`)
  }
  if (result.quota) {
    console.log(`  Quota: ${result.quota.maxConcurrency} concurrent · ${result.quota.maxRequestsPerMinute}/min · ${result.quota.maxRequestsPerDay}/day`)
  }
}

export async function showSettings(format?: string): Promise<void> {
  const client = getClient()
  const settings = await client.getSettings() as {
    providers: Array<{
      name: string
      model?: string
      configured: boolean
      quota?: { maxConcurrency: number; maxRequestsPerMinute: number; maxRequestsPerDay: number }
    }>
  }

  if (format === 'json') {
    console.log(JSON.stringify(settings, null, 2))
    return
  }

  console.log('Provider settings:\n')

  for (const provider of settings.providers) {
    const status = provider.configured ? 'configured' : 'not configured'
    console.log(`  ${provider.name.padEnd(10)} ${status}`)
    if (provider.configured) {
      console.log(`    Model:     ${provider.model ?? '(default)'}`)
      if (provider.quota) {
        console.log(`    Quota:     ${provider.quota.maxConcurrency} concurrent · ${provider.quota.maxRequestsPerMinute}/min · ${provider.quota.maxRequestsPerDay}/day`)
      }
    }
  }
}
