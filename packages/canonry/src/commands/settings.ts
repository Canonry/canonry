import { loadConfig, saveConfigPatch, getConfigPath } from '../config.js'
import { createApiClient } from '../client.js'
import { isMachineFormat } from '../cli-error.js'
import { setGoogleAuthConfig } from '../google-config.js'
import type { ProviderConnectionSettingsDto, ProviderSettingsUpdateRequest } from '@canonry/canonry-contracts'

function getClient() {
  return createApiClient()
}

export async function setProvider(name: string, opts: ProviderSettingsUpdateRequest & { format?: string }): Promise<void> {
  const client = getClient()
  const { format, ...payload } = opts
  const result = await client.updateProvider(name, payload)

  if (isMachineFormat(format)) {
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

function printConnection(connection: ProviderConnectionSettingsDto): void {
  console.log(`${connection.displayName}: ${connection.configured ? 'configured' : 'not configured'}`)
  if (connection.baseUrl) console.log(`  Endpoint: ${connection.baseUrl}`)
  console.log(`  API key: ${connection.apiKeyConfigured ? 'saved' : 'not saved'}`)
  if (connection.effectiveModel) console.log(`  Model: ${connection.effectiveModel}${connection.model ? ' (custom)' : ' (inherited)'}`)
  if (connection.capabilities.quota) {
    for (const [key, value] of Object.entries(connection.quota.effective)) {
      console.log(`  ${key}: ${value} (${Object.hasOwn(connection.quota.overrides, key) ? 'custom' : 'inherited'})`)
    }
  }
  console.log(`  Used by ${connection.usage.projectCount} projects:`)
  for (const project of connection.usage.projects) console.log(`    ${project.displayName} (${project.name}): ${project.providers.join(', ')} · ${project.sources.join(', ')}`)
  for (const use of connection.hostUses) console.log(`  Host use: ${use}`)
  for (const blocker of connection.blockers) console.log(`  Blocked: ${blocker.message}`)
  if (connection.hostManaged.vertex) console.log(`  Vertex AI (host managed): ${connection.hostManaged.vertex.project} · ${connection.hostManaged.vertex.region ?? 'default region'}`)
  if (connection.hostManaged.batch) console.log(`  Batch (host managed): ${JSON.stringify(connection.hostManaged.batch)}`)
  if (connection.hostManaged.pricing) console.log(`  Pricing (host managed): ${JSON.stringify(connection.hostManaged.pricing)}`)
  console.log(`  Revision: ${connection.revision}`)
  console.log(`  Impact revision: ${connection.impactRevision}`)
}

export async function showProviderSettings(name: string, format?: string): Promise<void> {
  const connection = await getClient().getProviderSettings(name)
  if (isMachineFormat(format)) console.log(JSON.stringify(connection, null, 2))
  else printConnection(connection)
}

export async function disconnectProvider(name: string, opts: { confirm?: boolean; expectedImpactRevision?: string; format?: string }): Promise<void> {
  const client = getClient()
  const preview = await client.getProviderSettings(name)
  if (!opts.confirm) {
    if (isMachineFormat(opts.format)) console.log(JSON.stringify(preview, null, 2))
    else {
      printConnection(preview)
      console.log('\nDisconnect removes the saved connection. Project selections and history are retained; the vendor key is not revoked.')
      console.log(`Run canonry settings disconnect-provider ${name} --confirm --if-impact-revision ${preview.impactRevision} to disconnect.`)
    }
    return
  }
  const result = await client.disconnectProvider(name, { expectedImpactRevision: opts.expectedImpactRevision ?? preview.impactRevision })
  if (isMachineFormat(opts.format)) console.log(JSON.stringify(result, null, 2))
  else console.log(`Provider ${result.displayName} disconnected. Project selections and history were retained.`)
}

export async function showSettings(format?: string): Promise<void> {
  const client = getClient()
  const settings = await client.getSettings()

  if (isMachineFormat(format)) {
    console.log(JSON.stringify(settings, null, 2))
    return
  }

  console.log('Provider settings:\n')

  for (const provider of settings.providers) {
    const status = provider.configured ? 'configured' : 'not configured'
    console.log(`  ${provider.name.padEnd(10)} ${status}`)
    if (provider.configured) {
      const modelLabel = provider.model
        ? provider.model
        : provider.defaultModel
          ? `${provider.defaultModel} (default)`
          : '(default)'
      console.log(`    Model:     ${modelLabel}`)
      if (provider.quota) {
        console.log(`    Quota:     ${provider.quota.maxConcurrency} concurrent · ${provider.quota.maxRequestsPerMinute}/min · ${provider.quota.maxRequestsPerDay}/day`)
      }
    }
  }

  // Search answer services: a key alone runs nothing; projects pick profiles.
  const services = settings.providerCatalog.filter(entry => entry.kind === 'answer-service' && entry.connection === entry.name)
  if (services.length > 0) {
    console.log('\nSearch answer services (run only where a project or request names a profile):\n')
    for (const service of services) {
      const configured = settings.providers.some(provider => provider.name === service.name && provider.configured)
      const keyEnv = (service.settingsFields ?? []).map(field => field.env).filter((env): env is string => Boolean(env))
      console.log(`  ${service.displayName} (${service.name}): ${configured ? 'configured' : 'not configured'}${service.keyCheck === 'saved-not-verified' ? ', key not verified until first use' : ''}${keyEnv.length > 0 ? `, key from ${keyEnv.join(' or ')} at bootstrap` : ''}`)
      for (const profile of service.profiles ?? []) {
        console.log(`    ${profile.route.padEnd(28)} ${profile.workflows.join(', ')}  ${profile.description}`)
      }
    }
  }

  console.log('\nGoogle OAuth:\n')
  console.log(`  ${settings.google.configured ? 'configured' : 'not configured'}`)
}

export async function reloadProviders(format?: string): Promise<void> {
  const result = await getClient().reloadProviders()
  if (isMachineFormat(format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log('Saved provider configuration is now active on the server.')
  for (const provider of result.providers) {
    console.log(`  ${provider.name}: ${provider.configured ? 'configured' : 'not configured'}`)
  }
}

type GoogleSettingsTarget = 'local' | 'server'

export async function setGoogleAuth(opts: {
  clientId: string
  clientSecret: string
  target?: GoogleSettingsTarget
  format?: string
}): Promise<void> {
  if (opts.target === 'server') {
    const result = await getClient().updateGoogleSettings({
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
    })

    if (isMachineFormat(opts.format)) {
      console.log(JSON.stringify(result, null, 2))
      return
    }

    console.log('Google OAuth credentials updated on the server.')
    return
  }

  const config = loadConfig()
  setGoogleAuthConfig(config, {
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
  })
  saveConfigPatch(config)

  if (isMachineFormat(opts.format)) {
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
