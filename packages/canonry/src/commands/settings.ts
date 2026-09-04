import { loadConfig, saveConfigPatch, getConfigPath } from '../config.js'
import { createApiClient } from '../client.js'
import type { EngineConnectionUpsertRequest } from '../client.js'
import { isMachineFormat } from '../cli-error.js'
import { setGoogleAuthConfig } from '../google-config.js'
import {
  engineConnectionModelCatalogResponseSchema,
  engineConnectionPublicDtoSchema,
  engineRouteConfigSchema,
  engineRouteSummaryResponseSchema,
  type EngineRouteUpsertInput,
  engineRouteReadiness,
} from '@ainyc/canonry-contracts'

function getClient() {
  return createApiClient()
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

export async function showSettings(format?: string): Promise<void> {
  const client = getClient()
  const config = loadConfig()
  const settings = await client.getSettings() as {
    providers: Array<{
      name: string
      model?: string
      defaultModel?: string
      configured: boolean
      quota?: { maxConcurrency: number; maxRequestsPerMinute: number; maxRequestsPerDay: number }
    }>
  }

  if (isMachineFormat(format)) {
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

  console.log('\nGoogle OAuth:\n')
  console.log(`  ${config.google?.clientId && config.google?.clientSecret ? 'configured' : 'not configured'}`)
}

function printMachineDocument(value: unknown, format: string | undefined): void {
  console.log(JSON.stringify(value, null, format === 'jsonl' ? 0 : 2))
}

/** Lists only server-approved, credential-free route summaries. */
export async function listEngineRoutes(format?: string): Promise<void> {
  const response = engineRouteSummaryResponseSchema.parse(await getClient().getEngineRouteSummaries())

  // The route response is a dependent collection plus its readiness envelope.
  // Keep JSONL as one compact document so an agent cannot lose its readiness.
  if (isMachineFormat(format)) {
    printMachineDocument(response, format)
    return
  }

  if (response.routes.length === 0) {
    console.log('No engine routes are available.')
    console.log('Create a connection, then add a text route with `canonry settings engine-route <route-id>`.')
    return
  }

  console.log('Available engine routes:\n')
  console.log('  ID                                      MODEL                         READINESS          SOURCE')
  console.log('  ──────────────────────────────────────  ────────────────────────────  ─────────────────  ─────────────────')
  for (const route of response.routes) {
    console.log(
      `  ${route.id.slice(0, 38).padEnd(38)}  ${route.modelId.slice(0, 28).padEnd(28)}  ${route.readiness.state.padEnd(17)}  ${route.source}`,
    )
  }
  console.log('\ntext-ready routes support text work such as project researchProvider; only measurement-ready routes can run answer-visibility sweeps.')
}

/** Upserts a connection without ever printing the supplied write-only credential. */
export async function upsertEngineConnection(
  id: string,
  input: EngineConnectionUpsertRequest,
  format?: string,
): Promise<void> {
  const response = engineConnectionPublicDtoSchema.parse(await getClient().upsertEngineConnection(id, input))

  if (isMachineFormat(format)) {
    printMachineDocument(response, format)
    return
  }

  console.log(`Engine connection "${response.label}" saved.`)
  console.log(`  ID:         ${response.id}`)
  console.log(`  Preset:     ${response.preset}`)
  console.log(`  Endpoint:   ${response.baseUrl}`)
  console.log(`  Quota:      ${response.quota.maxConcurrency} concurrent · ${response.quota.maxRequestsPerMinute}/min · ${response.quota.maxRequestsPerDay}/day`)
  console.log(`  Credential: ${response.secretConfigured ? 'configured' : 'not configured'}`)
  console.log('  --api-key is write-only; omitting it on a later update preserves the stored credential.')
}

/** Reads a model catalog without inference; manual model IDs stay valid on normal unavailable states. */
export async function listEngineConnectionModels(connectionId: string, format?: string): Promise<void> {
  const response = engineConnectionModelCatalogResponseSchema.parse(
    await getClient().getEngineConnectionModelCatalog(connectionId),
  )

  if (isMachineFormat(format)) {
    printMachineDocument(response, format)
    return
  }

  console.log(`Model catalog for "${response.connectionId}" (${response.state}):\n`)
  if (response.models.length === 0) {
    // `unavailable` is a catch-all: a non-2xx (401/403), an 8s timeout, a DNS or
    // connection error, a refused redirect, an oversized body and malformed JSON
    // all land here and are indistinguishable in the typed response. Naming only
    // the benign cause sent an operator with a wrong key or a dead gateway off to
    // enter a manual model id, and they learned the truth at the first billed call.
    console.log(response.state === 'unavailable'
      ? '  No model catalog could be read. The gateway may not expose /models, or the\n'
        + '  request failed: check the API key, the endpoint, and that the host is reachable.'
      : '  The gateway returned no models.')
  } else {
    for (const model of response.models) {
      const metadata = [model.displayName, model.provider].filter(Boolean).join(' · ')
      console.log(`  ${model.id}${metadata ? `  ${metadata}` : ''}`)
    }
  }
  console.log('\nManual model IDs remain available: pass --model <model-id> to `canonry settings engine-route <route-id>`.')
}

/** Upserts a generic route; the server owns its revision and evidence capability. */
export async function upsertEngineRoute(
  id: string,
  input: EngineRouteUpsertInput,
  format?: string,
): Promise<void> {
  const response = engineRouteConfigSchema.parse(await getClient().upsertEngineRoute(id, input))

  if (isMachineFormat(format)) {
    printMachineDocument(response, format)
    return
  }

  console.log(`Engine route "${response.label}" saved.`)
  console.log(`  ID:         ${response.id}`)
  console.log(`  Connection: ${response.connectionId}`)
  console.log(`  Model:      ${response.modelId}`)
  console.log(`  Revision:   ${response.revision}`)
  // Readiness needs BOTH a verified owner and verified-measurement capabilities.
  // Checking only the capability let the CLI print 'measurement-ready' for a
  // configured route whose capabilities were hand-edited, while the API reported
  // 'text-ready' for the same row. One rule, one helper.
  if (engineRouteReadiness(response).measurementReady) {
    console.log('  Readiness:  measurement-ready')
  } else {
    console.log('  Readiness:  text-only')
    console.log('  This route can support text work and project researchProvider, but cannot run an answer-visibility sweep.')
  }
}

export function setGoogleAuth(opts: { clientId: string; clientSecret: string; format?: string }): void {
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
