import type {
  RunDetailDto,
  TrafficBackfillResponse,
  TrafficEventEntry,
  TrafficEventsResponse,
  TrafficSeriesGranularity,
  TrafficSourceDto,
  TrafficSourceListResponse,
  TrafficStatusResponse,
  TrafficSyncResponse,
} from '@ainyc/canonry-contracts'
import { RunStatuses, TrafficEventKinds, TrafficSeriesGranularities } from '@ainyc/canonry-contracts'
import { createApiClient } from '../client.js'
import { CliError, isMachineFormat } from '../cli-error.js'
import { emitJsonl } from '../cli-output.js'

function getClient() {
  return createApiClient()
}

function configString(value: unknown, fallback = '(unset)'): string {
  return typeof value === 'string' ? value : fallback
}

export async function trafficConnectWordpress(project: string, opts: {
  url: string
  username: string
  /** Inline Application Password value. Mutually exclusive with `appPasswordFile`. */
  appPassword?: string
  /** Path to a file containing the Application Password. Preferred — keeps the secret out of shell history. */
  appPasswordFile?: string
  displayName?: string
  format?: string
}): Promise<void> {
  if (!opts.url) {
    throw new CliError({
      code: 'TRAFFIC_WP_URL_REQUIRED',
      message: '--url is required',
      displayMessage: 'Error: --url is required',
      details: { project },
    })
  }
  if (!opts.username) {
    throw new CliError({
      code: 'TRAFFIC_WP_USERNAME_REQUIRED',
      message: '--username is required',
      displayMessage: 'Error: --username is required',
      details: { project },
    })
  }
  if (opts.appPassword && opts.appPasswordFile) {
    throw new CliError({
      code: 'TRAFFIC_WP_APP_PASSWORD_CONFLICT',
      message: '--app-password and --app-password-file are mutually exclusive',
      displayMessage: 'Error: pass either --app-password <pw> or --app-password-file <path>, not both',
      details: { project },
    })
  }
  let applicationPassword = opts.appPassword?.trim() ?? ''
  if (!applicationPassword && opts.appPasswordFile) {
    const fs = await import('node:fs')
    try {
      applicationPassword = fs.readFileSync(opts.appPasswordFile, 'utf-8').trim()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      throw new CliError({
        code: 'TRAFFIC_WP_APP_PASSWORD_FILE_READ_ERROR',
        message: `Failed to read --app-password-file: ${msg}`,
        displayMessage: `Error: failed to read --app-password-file "${opts.appPasswordFile}": ${msg}`,
        details: { project, appPasswordFile: opts.appPasswordFile },
      })
    }
  }
  if (!applicationPassword) {
    throw new CliError({
      code: 'TRAFFIC_WP_APP_PASSWORD_REQUIRED',
      message: '--app-password or --app-password-file is required',
      displayMessage: 'Error: pass --app-password <pw> or --app-password-file <path>',
      details: { project },
    })
  }

  const client = getClient()
  const result: TrafficSourceDto = await client.trafficConnectWordpress(project, {
    baseUrl: opts.url,
    username: opts.username,
    applicationPassword,
    displayName: opts.displayName,
  })

  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`WordPress traffic source connected for project "${project}".`)
  console.log(`  Source ID:    ${result.id}`)
  console.log(`  Display name: ${result.displayName}`)
  console.log(`  Status:       ${result.status}`)
  console.log(`  Site URL:     ${configString(result.config.baseUrl)}`)
  console.log(`  Username:     ${configString(result.config.username)}`)
  console.log('')
  console.log(`Next: canonry traffic sync ${project} --source ${result.id}`)
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

  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`Cloud Run traffic source connected for project "${project}".`)
  console.log(`  Source ID:    ${result.id}`)
  console.log(`  Display name: ${result.displayName}`)
  console.log(`  Status:       ${result.status}`)
  console.log(`  GCP project:  ${configString(result.config.gcpProjectId)}`)
  if (result.config.serviceName) console.log(`  Service:      ${configString(result.config.serviceName)}`)
  if (result.config.location) console.log(`  Location:     ${configString(result.config.location)}`)
  console.log('')
  console.log(`Next: canonry traffic sync ${project} --source ${result.id}`)
}

export async function trafficConnectVercel(project: string, opts: {
  projectId: string
  teamId: string
  /** Inline Vercel personal access token value. Mutually exclusive with `tokenFile`. */
  token?: string
  /** Path to a file containing the Vercel personal access token. Preferred: keeps the secret out of shell history. */
  tokenFile?: string
  environment?: string
  displayName?: string
  format?: string
}): Promise<void> {
  if (!opts.projectId) {
    throw new CliError({
      code: 'TRAFFIC_VERCEL_PROJECT_ID_REQUIRED',
      message: '--project-id is required',
      displayMessage: 'Error: --project-id is required (the Vercel project id, e.g. prj_...)',
      details: { project },
    })
  }
  if (!opts.teamId) {
    throw new CliError({
      code: 'TRAFFIC_VERCEL_TEAM_ID_REQUIRED',
      message: '--team-id is required',
      displayMessage: 'Error: --team-id is required (the Vercel team or personal account that owns the project)',
      details: { project },
    })
  }
  if (opts.token && opts.tokenFile) {
    throw new CliError({
      code: 'TRAFFIC_VERCEL_TOKEN_CONFLICT',
      message: '--token and --token-file are mutually exclusive',
      displayMessage: 'Error: pass either --token <token> or --token-file <path>, not both',
      details: { project },
    })
  }
  let token = opts.token?.trim() ?? ''
  if (!token && opts.tokenFile) {
    const fs = await import('node:fs')
    try {
      token = fs.readFileSync(opts.tokenFile, 'utf-8').trim()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      throw new CliError({
        code: 'TRAFFIC_VERCEL_TOKEN_FILE_READ_ERROR',
        message: `Failed to read --token-file: ${msg}`,
        displayMessage: `Error: failed to read --token-file "${opts.tokenFile}": ${msg}`,
        details: { project, tokenFile: opts.tokenFile },
      })
    }
  }
  if (!token) {
    throw new CliError({
      code: 'TRAFFIC_VERCEL_TOKEN_REQUIRED',
      message: '--token or --token-file is required',
      displayMessage: 'Error: pass the Vercel personal access token via --token <token> or --token-file <path>',
      details: { project },
    })
  }
  if (opts.environment && opts.environment !== 'production' && opts.environment !== 'preview') {
    throw new CliError({
      code: 'TRAFFIC_VERCEL_INVALID_ENVIRONMENT',
      message: '--environment must be "production" or "preview"',
      displayMessage: 'Error: --environment must be "production" or "preview"',
      details: { project, environment: opts.environment },
    })
  }

  const client = getClient()
  const result: TrafficSourceDto = await client.trafficConnectVercel(project, {
    projectId: opts.projectId,
    teamId: opts.teamId,
    token,
    environment: opts.environment as 'production' | 'preview' | undefined,
    displayName: opts.displayName,
  })

  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`Vercel traffic source connected for project "${project}".`)
  console.log(`  Source ID:    ${result.id}`)
  console.log(`  Display name: ${result.displayName}`)
  console.log(`  Status:       ${result.status}`)
  console.log(`  Project ID:   ${configString(result.config.projectId)}`)
  console.log(`  Team ID:      ${configString(result.config.teamId)}`)
  console.log(`  Environment:  ${configString(result.config.environment)}`)
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
    if (isMachineFormat(opts.format)) {
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

  if (isMachineFormat(opts.format)) {
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

  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`Traffic sync complete for "${project}" (source ${opts.source}).`)
  console.log(`  Run ID:           ${result.runId}`)
  console.log(`  Window:           ${result.windowStart}  →  ${result.windowEnd}`)
  console.log(`  Pulled events:    ${result.pulledEvents}`)
  if (result.selfTrafficExcluded > 0) {
    console.log(`  Self-traffic excl: ${result.selfTrafficExcluded}  (Canonry's own tooling, dropped before rollup)`)
  }
  console.log(`  Crawler hits:     ${result.crawlerHits}  (${result.crawlerBucketRows} hourly bucket${result.crawlerBucketRows === 1 ? '' : 's'})`)
  console.log(`  AI referral hits: ${result.aiReferralHits}  (${result.aiReferralBucketRows} hourly bucket${result.aiReferralBucketRows === 1 ? '' : 's'})`)
  console.log(`  Unknown hits:     ${result.unknownHits}`)
  console.log(`  Sample rows:      ${result.sampleRows}`)
  console.log(`  Synced at:        ${result.syncedAt}`)
}

/**
 * Operator recovery: advance `lastSyncedAt` to NOW and clear `lastError` so
 * the next scheduled sync resumes from a recent timestamp. Primary use case
 * is an idle Vercel/Cloud Run source whose `lastSyncedAt` aged past the
 * upstream retention window and now throws on every sync. Accepts any
 * non-archived source type; cursor-based sources (WordPress) keep their
 * `lastCursor` so the advance is informational for them. Archived sources
 * are rejected — re-connect via `canonry traffic connect ...` instead.
 *
 * Skipped history is the explicit trade-off; run
 * `canonry traffic backfill` separately if any of it needs to be recovered.
 *
 * `--advance-to-now` must be passed — no implicit reset.
 */
export async function trafficReset(project: string, opts: {
  source: string
  advanceToNow?: boolean
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
  if (!opts.advanceToNow) {
    throw new CliError({
      code: 'TRAFFIC_RESET_REQUIRES_FLAG',
      message: '--advance-to-now is required',
      displayMessage:
        'Error: --advance-to-now is required. This skips any history between the source\'s current lastSyncedAt and now; run `canonry traffic backfill` separately if you need to recover it.',
      details: { project, source: opts.source },
    })
  }

  const client = getClient()
  const updated = await client.trafficReset(project, opts.source)

  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify(updated, null, 2))
    return
  }

  console.log(`Traffic source reset for "${project}" (source ${opts.source}).`)
  console.log(`  Status:        ${updated.status}`)
  console.log(`  Last synced:   ${updated.lastSyncedAt ?? 'never'}  (advanced to NOW)`)
  console.log(`  Last error:    ${updated.lastError ?? 'none'}`)
  console.log('')
  console.log('Next scheduled sync will resume from this timestamp.')
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
  } else if (opts.format === 'jsonl') {
    // One self-contained source per line; `project` is prepended so a line
    // lifted out of the envelope still says which project it belongs to.
    emitJsonl(result.sources.map(source => ({ project, ...source })))
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
  } else if (opts.format === 'jsonl') {
    // One self-contained per-source status (totals24h + latestRun) per line;
    // `project` is prepended so a line lifted out still identifies its project.
    emitJsonl(details.map(detail => ({ project, ...detail })))
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
    console.log(`  24h content:     ${d.totals24h.crawlerContentHits} crawls`)
    console.log(`  24h infra:       ${d.totals24h.crawlerInfraHits} sitemap/robots/asset fetches`)
    console.log(`  24h other:       ${d.totals24h.crawlerSegments.other} fetches`)
    console.log(`  24h crawler:     ${d.totals24h.crawlerHits} hits total`)
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
  switch (event.kind) {
    case TrafficEventKinds.crawler:
      return [
        event.tsHour,
        'crawler',
        event.botId,
        event.verificationStatus,
        String(event.status),
        `${event.pathNormalized} [${event.pathClass}]`,
        `${event.hits} hits`,
      ].join('  ')
    case TrafficEventKinds['ai-user-fetch']:
      return [
        event.tsHour,
        'ai-user-fetch',
        event.botId,
        event.verificationStatus,
        String(event.status),
        event.pathNormalized,
        `${event.hits} hits`,
      ].join('  ')
    case TrafficEventKinds['ai-referral']:
      return [
        event.tsHour,
        'ai-referral',
        event.product,
        event.evidenceType,
        event.sourceDomain,
        event.landingPathNormalized,
        `${event.hits} hits`,
        `(paid ${event.paidHits} · organic ${event.organicHits} · unclassified ${event.unknownHits})`,
      ].join('  ')
  }
}

export async function trafficEvents(project: string, opts: {
  kind?: string
  sinceMinutes?: number
  since?: string
  until?: string
  limit?: number
  source?: string
  granularity?: string
  format?: string
}): Promise<void> {
  if (
    opts.kind
    && opts.kind !== 'all'
    && opts.kind !== TrafficEventKinds.crawler
    && opts.kind !== TrafficEventKinds['ai-user-fetch']
    && opts.kind !== TrafficEventKinds['ai-referral']
  ) {
    throw new CliError({
      code: 'TRAFFIC_INVALID_KIND',
      message: `--kind must be one of: all, ${TrafficEventKinds.crawler}, ${TrafficEventKinds['ai-user-fetch']}, ${TrafficEventKinds['ai-referral']}`,
      displayMessage: `Error: --kind must be "all", "${TrafficEventKinds.crawler}", "${TrafficEventKinds['ai-user-fetch']}", or "${TrafficEventKinds['ai-referral']}"`,
      details: { project, kind: opts.kind },
    })
  }

  if (
    opts.granularity
    && opts.granularity !== TrafficSeriesGranularities.hour
    && opts.granularity !== TrafficSeriesGranularities.day
  ) {
    throw new CliError({
      code: 'TRAFFIC_INVALID_GRANULARITY',
      message: `--granularity must be one of: ${TrafficSeriesGranularities.hour}, ${TrafficSeriesGranularities.day}`,
      displayMessage: `Error: --granularity must be "${TrafficSeriesGranularities.hour}" or "${TrafficSeriesGranularities.day}"`,
      details: { project, granularity: opts.granularity },
    })
  }

  const params: { since?: string; until?: string; kind?: string; limit?: number; sourceId?: string; granularity?: TrafficSeriesGranularity } = {}
  if (opts.kind && opts.kind !== 'all') params.kind = opts.kind
  if (opts.source) params.sourceId = opts.source
  if (opts.limit !== undefined) params.limit = opts.limit
  if (opts.granularity) params.granularity = opts.granularity as TrafficSeriesGranularity
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
  } else if (opts.format === 'jsonl') {
    // One self-contained event per line. Each row loses the envelope's window
    // bounds, so `project` + `windowStart`/`windowEnd` are prepended; the
    // event's own fields (including `kind`) win by spreading last.
    emitJsonl(result.events.map(event => ({
      project,
      windowStart: result.windowStart,
      windowEnd: result.windowEnd,
      ...event,
    })))
    return
  }

  console.log(`Traffic events for "${project}"  ${result.windowStart}  →  ${result.windowEnd}`)
  console.log(`  Content crawls (window):       ${result.totals.crawlerContentHits}`)
  console.log(`  Infra fetches (window):        ${result.totals.crawlerInfraHits}  (sitemap ${result.totals.crawlerSegments.sitemap} · robots ${result.totals.crawlerSegments.robots} · asset ${result.totals.crawlerSegments.asset})`)
  console.log(`  Other fetches (window):        ${result.totals.crawlerSegments.other}`)
  console.log(`  Crawler hits total (window):   ${result.totals.crawlerHits}`)
  console.log(`  AI user-fetch hits (window):   ${result.totals.aiUserFetchHits}`)
  console.log(`  AI referral sessions (window): ${result.totals.aiReferralHits}`)
  console.log(`    paid:                       ${result.totals.aiReferralPaidHits}`)
  console.log(`    organic:                    ${result.totals.aiReferralOrganicHits}`)
  console.log(`    unclassified:               ${result.totals.aiReferralUnknownHits}  (ingested before paid/organic classification)`)
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
