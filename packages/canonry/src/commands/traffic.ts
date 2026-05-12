import type {
  RunDetailDto,
  TrafficBackfillResponse,
  TrafficEventEntry,
  TrafficEventsResponse,
  TrafficSourceDto,
  TrafficSourceListResponse,
  TrafficStatusResponse,
  TrafficSyncResponse,
} from '@ainyc/canonry-contracts'
import { RunStatuses, TrafficEventKinds } from '@ainyc/canonry-contracts'
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

export async function trafficBackfill(project: string, opts: {
  source: string
  days?: number
  wait?: boolean
  pollIntervalMs?: number
  format?: string
}): Promise<void> {
  if (!opts.source) {
    throw new CliError({
      code: 'TRAFFIC_SOURCE_REQUIRED',
      message: '--source <id> is required',
      displayMessage: 'Error: --source <id> is required (run `canonry traffic sources` to list connected sources)',
      details: { project },
    })
  }

  const client = getClient()
  const submitted: TrafficBackfillResponse = await client.trafficBackfill(project, opts.source, {
    days: opts.days,
  })

  if (!opts.wait) {
    if (opts.format === 'json') {
      console.log(JSON.stringify(submitted, null, 2))
      return
    }
    console.log(`Backfill submitted for "${project}" (source ${opts.source}).`)
    console.log(`  Run ID:        ${submitted.runId}`)
    console.log(`  Window:        ${submitted.windowStart}  →  ${submitted.windowEnd}`)
    console.log(`  Days applied:  ${submitted.daysApplied} (requested ${submitted.daysRequested})`)
    console.log(`  Status:        ${submitted.status}`)
    console.log('')
    console.log(`Poll: canonry runs get ${submitted.runId}`)
    return
  }

  // Poll until terminal. Backfill at ainyc volume completes in seconds; cap
  // the wait at 5 minutes so a stuck run doesn't hang the CLI forever.
  const intervalMs = opts.pollIntervalMs ?? 1500
  const deadlineMs = Date.now() + 5 * 60_000
  let final: RunDetailDto | null = null
  while (Date.now() < deadlineMs) {
    const run = await client.getRun(submitted.runId)
    if (run.status !== RunStatuses.running && run.status !== RunStatuses.queued) {
      final = run
      break
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs))
  }

  if (!final) {
    throw new CliError({
      code: 'TRAFFIC_BACKFILL_TIMEOUT',
      message: `Backfill did not complete within 5 minutes (run ${submitted.runId} still running)`,
      displayMessage: `Error: backfill run ${submitted.runId} did not finish within 5 minutes — check status with "canonry runs get ${submitted.runId}"`,
      details: { project, runId: submitted.runId },
    })
  }

  if (opts.format === 'json') {
    console.log(JSON.stringify({ ...submitted, finalStatus: final.status, finalRun: final }, null, 2))
    return
  }

  if (final.status === RunStatuses.completed) {
    console.log(`Backfill complete for "${project}" (source ${opts.source}).`)
    console.log(`  Run ID:        ${final.id}`)
    console.log(`  Window:        ${submitted.windowStart}  →  ${submitted.windowEnd}`)
    console.log(`  Days applied:  ${submitted.daysApplied}`)
    console.log(`  Started:       ${final.startedAt ?? 'unknown'}`)
    console.log(`  Finished:      ${final.finishedAt ?? 'unknown'}`)
    console.log('')
    console.log(`Inspect rebuilt rollups: canonry traffic events ${project} --source ${opts.source} --since-minutes ${submitted.daysApplied * 24 * 60}`)
    return
  }

  const errorMessage = final.error?.message ?? null
  throw new CliError({
    code: 'TRAFFIC_BACKFILL_FAILED',
    message: errorMessage ?? 'backfill run did not complete successfully',
    displayMessage: `Error: backfill run ${final.id} ${final.status}${errorMessage ? ` — ${errorMessage}` : ''}`,
    details: { project, runId: final.id, status: final.status },
  })
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

function formatSourceLine(source: TrafficSourceDto): string {
  const parts = [
    source.id,
    source.sourceType,
    source.status,
    source.lastSyncedAt ?? 'never synced',
    source.displayName,
  ]
  return parts.join('  ')
}

export async function trafficSources(project: string, opts: { format?: string }): Promise<void> {
  const client = createApiClient()
  const result: TrafficSourceListResponse = await client.trafficListSources(project)

  if (opts.format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (result.sources.length === 0) {
    console.log(`No traffic sources connected for project "${project}".`)
    console.log('Run: canonry traffic connect cloud-run <project> --gcp-project <id> --service-account-key <path>')
    return
  }

  console.log(`Traffic sources for "${project}":`)
  console.log('  ID  TYPE  STATUS  LAST_SYNCED  DISPLAY_NAME')
  for (const source of result.sources) {
    console.log(`  ${formatSourceLine(source)}`)
  }
}

export async function trafficStatus(project: string, opts: { format?: string }): Promise<void> {
  const client = createApiClient()
  const result: TrafficStatusResponse = await client.trafficStatus(project)
  const details = result.sources

  if (opts.format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (details.length === 0) {
    console.log(`No traffic sources connected for project "${project}".`)
    console.log('Run: canonry traffic connect cloud-run <project> --gcp-project <id> --service-account-key <path>')
    return
  }

  for (const d of details) {
    console.log(`Source ${d.id} (${d.sourceType})`)
    console.log(`  Display name:    ${d.displayName}`)
    console.log(`  Status:          ${d.status}`)
    console.log(`  Last synced:     ${d.lastSyncedAt ?? 'never'}`)
    if (d.lastError) console.log(`  Last error:      ${d.lastError}`)
    console.log(`  24h crawler:     ${d.totals24h.crawlerHits} hits`)
    console.log(`  24h AI referral: ${d.totals24h.aiReferralHits} sessions`)
    console.log(`  24h samples:     ${d.totals24h.sampleCount}`)
    if (d.latestRun) {
      console.log(`  Latest run:      ${d.latestRun.runId} (${d.latestRun.status})`)
      console.log(`    Started:       ${d.latestRun.startedAt}`)
      if (d.latestRun.finishedAt) console.log(`    Finished:      ${d.latestRun.finishedAt}`)
      if (d.latestRun.error) console.log(`    Error:         ${d.latestRun.error}`)
    } else {
      console.log(`  Latest run:      (none)`)
    }
    console.log('')
  }
}

function formatEventLine(event: TrafficEventEntry): string {
  if (event.kind === TrafficEventKinds.crawler) {
    return [
      event.tsHour,
      'crawler',
      event.botId,
      event.verificationStatus,
      String(event.status),
      event.pathNormalized,
      `${event.hits} hits`,
    ].join('  ')
  }
  return [
    event.tsHour,
    'ai-referral',
    event.product,
    event.evidenceType,
    event.sourceDomain,
    event.landingPathNormalized,
    `${event.hits} hits`,
  ].join('  ')
}

export async function trafficEvents(project: string, opts: {
  kind?: string
  sinceMinutes?: number
  since?: string
  until?: string
  limit?: number
  source?: string
  format?: string
}): Promise<void> {
  if (opts.kind && opts.kind !== 'all' && opts.kind !== TrafficEventKinds.crawler && opts.kind !== TrafficEventKinds['ai-referral']) {
    throw new CliError({
      code: 'TRAFFIC_INVALID_KIND',
      message: `--kind must be one of: all, ${TrafficEventKinds.crawler}, ${TrafficEventKinds['ai-referral']}`,
      displayMessage: `Error: --kind must be "all", "${TrafficEventKinds.crawler}", or "${TrafficEventKinds['ai-referral']}"`,
      details: { project, kind: opts.kind },
    })
  }

  const params: { since?: string; until?: string; kind?: string; limit?: number; sourceId?: string } = {}
  if (opts.kind && opts.kind !== 'all') params.kind = opts.kind
  if (opts.source) params.sourceId = opts.source
  if (opts.limit !== undefined) params.limit = opts.limit
  if (opts.sinceMinutes !== undefined) {
    const since = new Date(Date.now() - opts.sinceMinutes * 60_000).toISOString()
    params.since = since
  } else if (opts.since) {
    params.since = opts.since
  }
  if (opts.until) params.until = opts.until

  const client = createApiClient()
  const result: TrafficEventsResponse = await client.trafficListEvents(project, params)

  if (opts.format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`Traffic events for "${project}"  ${result.windowStart}  →  ${result.windowEnd}`)
  console.log(`  Crawler hits (window):     ${result.totals.crawlerHits}`)
  console.log(`  AI referral sessions (window): ${result.totals.aiReferralHits}`)
  console.log('')

  if (result.events.length === 0) {
    console.log('No events in this window.')
    return
  }

  console.log('  TS_HOUR  KIND  IDENTITY  EVIDENCE/STATUS  PATH  COUNT')
  for (const event of result.events) {
    console.log(`  ${formatEventLine(event)}`)
  }
}
