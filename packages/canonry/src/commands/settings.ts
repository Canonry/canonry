import { loadConfig, saveConfig, getConfigPath } from '../config.js'
import { ApiClient } from '../client.js'
import { setGoogleAuthConfig } from '../google-config.js'

function getClient(): ApiClient {
  const config = loadConfig()
  return new ApiClient(config.apiUrl, config.apiKey)
}

export async function setProvider(name: string, opts: {
  apiKey?: string
  baseUrl?: string
  model?: string
  quota?: { maxConcurrency?: number; maxRequestsPerMinute?: number; maxRequestsPerDay?: number }
  format?: string
}): Promise<void> {
  const client = getClient()
  const { format, ...payload } = opts
  const result = await client.updateProvider(name, payload) as {
    name: string
    model?: string
    configured: boolean
    quota?: { maxConcurrency: number; maxRequestsPerMinute: number; maxRequestsPerDay: number }
  }

  if (format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
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
  const config = loadConfig()
  const settings = await client.getSettings() as {
    providers: Array<{
      name: string
      model?: string
      configured: boolean
      quota?: { maxConcurrency: number; maxRequestsPerMinute: number; maxRequestsPerDay: number }
    }>
  }

  if (format === 'json') {
    console.log(JSON.stringify({
      ...settings,
      google: {
        configured: Boolean(config.google?.clientId && config.google?.clientSecret),
      },
    }, null, 2))
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

  console.log('\nGoogle OAuth:\n')
  console.log(`  ${config.google?.clientId && config.google?.clientSecret ? 'configured' : 'not configured'}`)
}

export function setGoogleAuth(opts: { clientId: string; clientSecret: string; format?: string }): void {
  const config = loadConfig()
  setGoogleAuthConfig(config, {
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
  })
  saveConfig(config)

  if (opts.format === 'json') {
    console.log(JSON.stringify({
      configured: true,
      configPath: getConfigPath(),
      restartRequired: true,
    }, null, 2))
    return
  }

  console.log(`Google OAuth credentials saved to ${getConfigPath()}.`)
  console.log('Restart the local server if it is already running.')
}
