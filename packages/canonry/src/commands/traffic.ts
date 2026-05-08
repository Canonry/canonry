import type { TrafficSourceDto, TrafficSyncResponse } from '@ainyc/canonry-contracts'
import { createApiClient } from '../client.js'
import { CliError } from '../cli-error.js'

function getClient() {
  return createApiClient()
}

export async function trafficConnectCloudRun(project: string, opts: {
  gcpProject: string
  service?: string
  location?: string
  serviceAccountKey?: string
  displayName?: string
  format?: string
}): Promise<void> {
  if (!opts.gcpProject) {
    throw new CliError({
      code: 'TRAFFIC_GCP_PROJECT_REQUIRED',
      message: '--gcp-project is required',
      displayMessage: 'Error: --gcp-project is required',
      details: { project },
    })
  }
  if (!opts.serviceAccountKey) {
    throw new CliError({
      code: 'TRAFFIC_KEY_FILE_REQUIRED',
      message: '--service-account-key is required for v1 (OAuth-mode Cloud Run is not yet supported).',
      displayMessage: 'Error: --service-account-key <path-to-json> is required',
      details: { project },
    })
  }

  const fs = await import('node:fs')
  let keyJson: string
  try {
    keyJson = fs.readFileSync(opts.serviceAccountKey, 'utf-8')
    JSON.parse(keyJson)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new CliError({
      code: 'TRAFFIC_KEY_FILE_READ_ERROR',
      message: `Failed to read service-account key: ${msg}`,
      displayMessage: `Error: failed to read --service-account-key "${opts.serviceAccountKey}": ${msg}`,
      details: { project, keyFile: opts.serviceAccountKey },
    })
  }

  const client = getClient()
  const result: TrafficSourceDto = await client.trafficConnectCloudRun(project, {
    gcpProjectId: opts.gcpProject,
    serviceName: opts.service,
    location: opts.location,
    displayName: opts.displayName,
    keyJson,
  })

  if (opts.format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`Cloud Run traffic source connected for project "${project}".`)
  console.log(`  Source ID:    ${result.id}`)
  console.log(`  Display name: ${result.displayName}`)
  console.log(`  Status:       ${result.status}`)
  console.log(`  GCP project:  ${result.config.gcpProjectId ?? '(unset)'}`)
  if (result.config.serviceName) console.log(`  Service:      ${result.config.serviceName}`)
  if (result.config.location) console.log(`  Location:     ${result.config.location}`)
  console.log('')
  console.log(`Next: canonry traffic sync ${project} --source ${result.id}`)
}

export async function trafficSync(project: string, opts: {
  source: string
  sinceMinutes?: number
  format?: string
}): Promise<void> {
  if (!opts.source) {
    throw new CliError({
      code: 'TRAFFIC_SOURCE_REQUIRED',
      message: '--source <id> is required',
      displayMessage: 'Error: --source <id> is required (run `canonry traffic connect cloud-run` first if you have not connected a source)',
      details: { project },
    })
  }

  const client = getClient()
  const result: TrafficSyncResponse = await client.trafficSync(project, opts.source, {
    sinceMinutes: opts.sinceMinutes,
  })

  if (opts.format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`Traffic sync complete for "${project}" (source ${opts.source}).`)
  console.log(`  Run ID:           ${result.runId}`)
  console.log(`  Window:           ${result.windowStart}  →  ${result.windowEnd}`)
  console.log(`  Pulled events:    ${result.pulledEvents}`)
  console.log(`  Crawler hits:     ${result.crawlerHits}  (${result.crawlerBucketRows} hourly bucket${result.crawlerBucketRows === 1 ? '' : 's'})`)
  console.log(`  AI referral hits: ${result.aiReferralHits}  (${result.aiReferralBucketRows} hourly bucket${result.aiReferralBucketRows === 1 ? '' : 's'})`)
  console.log(`  Unknown hits:     ${result.unknownHits}`)
  console.log(`  Sample rows:      ${result.sampleRows}`)
  console.log(`  Synced at:        ${result.syncedAt}`)
}
