import fs from 'node:fs'
import type {
  AdsAccountDto,
  AdsCampaignListResponse,
  AdsConnectionStatusDto,
  AdsConversionEventSettingListResponse,
  AdsConversionPixelListResponse,
  AdsDisconnectResponse,
  AdsGeoSearchQuery,
  AdsGeoSearchResponse,
  AdsInsightsResponse,
  AdsSummaryDto,
  AdsSyncResponse,
  AdsOperationResponse,
  AdsImageUploadRequest,
  AdsCampaignCreateRequest,
  AdsCampaignUpdateRequest,
  AdsAdGroupCreateRequest,
  AdsAdGroupUpdateRequest,
  AdsAdCreateRequest,
  AdsAdUpdateRequest,
  AdsPauseRequest,
} from '@ainyc/canonry-contracts'
import {
  adsGeoSearchQuerySchema,
  adsAdCreateRequestSchema,
  adsAdGroupCreateRequestSchema,
  adsAdGroupUpdateRequestSchema,
  adsAdUpdateRequestSchema,
  adsCampaignCreateRequestSchema,
  adsCampaignUpdateRequestSchema,
  adsImageUploadRequestSchema,
  adsPauseRequestSchema,
  formatMicros,
} from '@ainyc/canonry-contracts'
import type { z } from 'zod'
import { createApiClient } from '../client.js'
import { CliError, isMachineFormat } from '../cli-error.js'
import { emitJsonl } from '../cli-output.js'

function getClient() {
  return createApiClient()
}

function readRequest<TSchema extends z.ZodTypeAny>(inputPath: string | undefined, schema: TSchema): z.infer<TSchema> {
  if (!inputPath) {
    throw new CliError({
      code: 'ADS_INPUT_REQUIRED',
      message: 'A JSON input file is required',
      displayMessage: 'Error: --input <json-file> is required (use --input - for stdin)',
    })
  }
  try {
    const raw = fs.readFileSync(inputPath === '-' ? 0 : inputPath, 'utf8')
    return schema.parse(JSON.parse(raw))
  } catch (err) {
    if (err instanceof CliError) throw err
    throw new CliError({
      code: 'ADS_INPUT_INVALID',
      message: err instanceof Error ? err.message : String(err),
      displayMessage: `Error: invalid ads JSON input (${err instanceof Error ? err.message : String(err)})`,
      details: { inputPath },
    })
  }
}

function printOperation(result: AdsOperationResponse, format?: string): void {
  if (isMachineFormat(format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  const operation = result.operation
  console.log(`${result.replayed ? 'Replayed' : 'Recorded'} ${operation.kind}: ${operation.state}`)
  console.log(`Operation: ${operation.operationKey}`)
  if (operation.entityId) console.log(`Entity:    ${operation.entityType ?? 'unknown'} ${operation.entityId}`)
  if (operation.upstreamUpdatedAt != null) console.log(`Updated:   ${operation.upstreamUpdatedAt}`)
  if (operation.errorCode) console.log(`Error:     ${operation.errorCode}: ${operation.errorMessage ?? ''}`)
  if (operation.state === 'unknown') {
    console.log('Do not retry with a new operation key. Reconcile this outcome with a human first.')
  }
}

function describeConnection(status: AdsConnectionStatusDto): string[] {
  const lines: string[] = []
  lines.push(`Connected:    ${status.connected ? 'yes' : 'no'}`)
  if (status.connected) {
    if (status.displayName) lines.push(`Account:      ${status.displayName} (${status.adAccountId ?? 'unknown id'})`)
    if (status.currencyCode) lines.push(`Currency:     ${status.currencyCode}`)
    if (status.timezone) lines.push(`Timezone:     ${status.timezone}`)
    if (status.status) lines.push(`Status:       ${status.status}`)
    lines.push(`Last synced:  ${status.lastSyncedAt ?? 'never'}`)
  }
  return lines
}

export async function adsConnect(project: string, opts: { apiKey?: string; format?: string }): Promise<void> {
  if (!opts.apiKey) {
    throw new CliError({
      code: 'ADS_API_KEY_REQUIRED',
      message: 'API key is required (pass --api-key)',
      displayMessage: 'Error: --api-key is required (mint an SDK key in OpenAI Ads Manager)',
      details: { project },
    })
  }

  const client = getClient()
  const result: AdsConnectionStatusDto = await client.adsConnect(project, { apiKey: opts.apiKey })

  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(`Connected OpenAI ad account for ${project}.`)
  for (const line of describeConnection(result)) console.log(line)
  console.log('Schedule daily syncs with: canonry schedule set ' + project + ' --kind ads-sync --preset daily')
}

export async function adsDisconnect(project: string, opts?: { format?: string }): Promise<void> {
  const client = getClient()
  const result: AdsDisconnectResponse = await client.adsDisconnect(project)

  if (isMachineFormat(opts?.format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(result.disconnected ? `Disconnected the ads connection for ${project}.` : 'No ads connection to remove.')
}

export async function adsStatus(project: string, opts?: { format?: string }): Promise<void> {
  const client = getClient()
  const result: AdsConnectionStatusDto = await client.getAdsStatus(project)

  if (isMachineFormat(opts?.format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  for (const line of describeConnection(result)) console.log(line)
  if (!result.connected) {
    console.log('Connect with: canonry ads connect ' + project + ' --api-key <sdk-key>')
  }
}

export async function adsAccount(project: string, opts?: { format?: string }): Promise<void> {
  const result: AdsAccountDto = await getClient().getAdsAccount(project)

  if (isMachineFormat(opts?.format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`Account:    ${result.name}`)
  console.log(`ID:         ${result.id}`)
  console.log(`Status:     ${result.status}`)
  console.log(`Currency:   ${result.currencyCode ?? 'unknown'}`)
  console.log(`Timezone:   ${result.timezone ?? 'unknown'}`)
  console.log(`Review:     ${result.reviewStatus ?? 'unknown'}`)
  console.log(`Integrity:  ${result.integrityReviewStatus ?? 'unknown'}`)
  if (result.integrityDecision) console.log(`Decision:   ${result.integrityDecision}`)
  if (result.url) console.log(`Ads Manager: ${result.url}`)
}

export async function adsGeoSearch(
  project: string,
  opts: { q?: string; limit?: number; format?: string },
): Promise<void> {
  const parsed = adsGeoSearchQuerySchema.safeParse({ q: opts.q, limit: opts.limit })
  if (!parsed.success) {
    throw new CliError({
      code: 'ADS_GEO_QUERY_INVALID',
      message: 'A valid geo search query is required',
      displayMessage: 'Error: --query is required and --limit must be an integer from 1 to 100',
      details: {
        project,
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      },
    })
  }

  const query: AdsGeoSearchQuery = parsed.data
  const result: AdsGeoSearchResponse = await getClient().searchAdsGeo(project, query)

  if (opts.format === 'jsonl') {
    emitJsonl(result.results.map((location) => ({ project, query: result.query, ...location })))
    return
  }
  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (result.results.length === 0) {
    console.log(`No OpenAI Ads locations matched "${result.query}".`)
    return
  }
  for (const location of result.results) {
    const region = location.regionCode ? `, ${location.regionCode}` : ''
    console.log(`${location.canonicalName} (${location.type}, ${location.countryCode}${region}) [${location.id}]`)
  }
}

export async function adsConversionPixels(project: string, opts?: { format?: string }): Promise<void> {
  const result: AdsConversionPixelListResponse = await getClient().getAdsConversionPixels(project)

  if (opts?.format === 'jsonl') {
    emitJsonl(result.pixels.map((pixel) => ({ project, ...pixel })))
    return
  }
  if (isMachineFormat(opts?.format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (result.pixels.length === 0) {
    console.log('No OpenAI Ads conversion pixels are configured.')
    return
  }
  for (const pixel of result.pixels) {
    console.log(`${pixel.name} (${pixel.clientType}) [${pixel.id}] pixel ${pixel.pixelId}`)
  }
}

export async function adsConversionEventSettings(project: string, opts?: { format?: string }): Promise<void> {
  const result: AdsConversionEventSettingListResponse = await getClient().getAdsConversionEventSettings(project)

  if (opts?.format === 'jsonl') {
    emitJsonl(result.eventSettings.map((eventSetting) => ({ project, ...eventSetting })))
    return
  }
  if (isMachineFormat(opts?.format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (result.eventSettings.length === 0) {
    console.log('No OpenAI Ads conversion event settings are configured.')
    return
  }
  for (const eventSetting of result.eventSettings) {
    const sources = eventSetting.sources.map((source) => source.name).join(', ') || 'no sources'
    const archived = eventSetting.archived ? ' [archived]' : ''
    console.log(
      `${eventSetting.name}${archived}: ${eventSetting.eventType}, ${eventSetting.attributionWindowDays}d attribution, ${sources} [${eventSetting.id}]`,
    )
  }
}

export async function adsOperationGet(
  project: string,
  opts: { operationKey: string; format?: string },
): Promise<void> {
  printOperation(await getClient().getAdsOperation(project, opts.operationKey), opts.format)
}

export async function adsImageUpload(
  project: string,
  opts: { input?: string; format?: string },
): Promise<void> {
  const request: AdsImageUploadRequest = readRequest(opts.input, adsImageUploadRequestSchema)
  printOperation(await getClient().uploadAdsImage(project, request), opts.format)
}

export async function adsCampaignCreate(
  project: string,
  opts: { input?: string; format?: string },
): Promise<void> {
  const request: AdsCampaignCreateRequest = readRequest(opts.input, adsCampaignCreateRequestSchema)
  printOperation(await getClient().createAdsCampaign(project, request), opts.format)
}

export async function adsCampaignUpdate(
  project: string,
  campaignId: string,
  opts: { input?: string; format?: string },
): Promise<void> {
  const request: AdsCampaignUpdateRequest = readRequest(opts.input, adsCampaignUpdateRequestSchema)
  printOperation(await getClient().updateAdsCampaign(project, campaignId, request), opts.format)
}

export async function adsCampaignPause(
  project: string,
  campaignId: string,
  opts: { input?: string; format?: string },
): Promise<void> {
  const request: AdsPauseRequest = readRequest(opts.input, adsPauseRequestSchema)
  printOperation(await getClient().pauseAdsCampaign(project, campaignId, request), opts.format)
}

export async function adsAdGroupCreate(
  project: string,
  opts: { input?: string; format?: string },
): Promise<void> {
  const request: AdsAdGroupCreateRequest = readRequest(opts.input, adsAdGroupCreateRequestSchema)
  printOperation(await getClient().createAdsAdGroup(project, request), opts.format)
}

export async function adsAdGroupUpdate(
  project: string,
  adGroupId: string,
  opts: { input?: string; format?: string },
): Promise<void> {
  const request: AdsAdGroupUpdateRequest = readRequest(opts.input, adsAdGroupUpdateRequestSchema)
  printOperation(await getClient().updateAdsAdGroup(project, adGroupId, request), opts.format)
}

export async function adsAdGroupPause(
  project: string,
  adGroupId: string,
  opts: { input?: string; format?: string },
): Promise<void> {
  const request: AdsPauseRequest = readRequest(opts.input, adsPauseRequestSchema)
  printOperation(await getClient().pauseAdsAdGroup(project, adGroupId, request), opts.format)
}

export async function adsAdCreate(
  project: string,
  opts: { input?: string; format?: string },
): Promise<void> {
  const request: AdsAdCreateRequest = readRequest(opts.input, adsAdCreateRequestSchema)
  printOperation(await getClient().createAdsAd(project, request), opts.format)
}

export async function adsAdUpdate(
  project: string,
  adId: string,
  opts: { input?: string; format?: string },
): Promise<void> {
  const request: AdsAdUpdateRequest = readRequest(opts.input, adsAdUpdateRequestSchema)
  printOperation(await getClient().updateAdsAd(project, adId, request), opts.format)
}

export async function adsAdPause(
  project: string,
  adId: string,
  opts: { input?: string; format?: string },
): Promise<void> {
  const request: AdsPauseRequest = readRequest(opts.input, adsPauseRequestSchema)
  printOperation(await getClient().pauseAdsAd(project, adId, request), opts.format)
}

export async function adsSync(project: string, opts?: { format?: string }): Promise<void> {
  const client = getClient()
  const result: AdsSyncResponse = await client.triggerAdsSync(project)

  if (isMachineFormat(opts?.format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(`Ads sync queued (run ${result.runId}). Check progress with: canonry runs get ${result.runId}`)
}

export async function adsCampaigns(project: string, opts?: { format?: string }): Promise<void> {
  const client = getClient()
  const result: AdsCampaignListResponse = await client.getAdsCampaigns(project)

  if (opts?.format === 'jsonl') {
    emitJsonl(result.campaigns.map((campaign) => ({ project, ...campaign })))
    return
  }
  if (isMachineFormat(opts?.format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (result.campaigns.length === 0) {
    console.log('No campaign snapshots. Run "canonry ads sync ' + project + '" first.')
    return
  }
  for (const campaign of result.campaigns) {
    const budget = campaign.dailySpendLimitMicros != null ? `${formatMicros(campaign.dailySpendLimitMicros)}/day` : 'no daily limit'
    console.log(`${campaign.name} [${campaign.status}] — ${campaign.adGroups.length} ad groups, ${budget}`)
    for (const group of campaign.adGroups) {
      const bid = group.maxBidMicros != null ? `max bid ${formatMicros(group.maxBidMicros)}` : 'auto bid'
      console.log(`  - ${group.name} [${group.status}] — ${group.ads.length} ads, ${bid}`)
      const hintLines = group.contextHints.flatMap((hint) => hint.split('\n')).filter(Boolean)
      for (const hint of hintLines.slice(0, 3)) console.log(`      ${hint}`)
      if (hintLines.length > 3) console.log(`      … and ${hintLines.length - 3} more hint lines`)
    }
  }
}

export async function adsInsights(project: string, opts?: {
  level?: string
  entity?: string
  from?: string
  to?: string
  format?: string
}): Promise<void> {
  const client = getClient()
  const result: AdsInsightsResponse = await client.getAdsInsights(project, {
    level: opts?.level,
    entityId: opts?.entity,
    from: opts?.from,
    to: opts?.to,
  })

  if (opts?.format === 'jsonl') {
    emitJsonl(result.rows.map((row) => ({ project, ...row })))
    return
  }
  if (isMachineFormat(opts?.format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (result.rows.length === 0) {
    console.log('No paid-performance rollups in range. Run "canonry ads sync ' + project + '" first.')
    return
  }
  const currency = result.currencyCode ?? 'USD'
  console.log('DATE        LEVEL      ENTITY                                 IMPR    CLICKS  SPEND      CPC')
  for (const row of result.rows) {
    const cpc = row.cpcMicros != null ? formatMicros(row.cpcMicros, currency) : '—'
    console.log(
      `${row.date}  ${row.level.padEnd(9)}  ${row.entityId.padEnd(36).slice(0, 36)}  ${String(row.impressions).padStart(6)}  ${String(row.clicks).padStart(6)}  ${formatMicros(row.spendMicros, currency).padStart(9)}  ${cpc}`,
    )
  }
}

export async function adsSummary(project: string, opts?: { format?: string }): Promise<void> {
  const client = getClient()
  const result: AdsSummaryDto = await client.getAdsSummary(project)

  if (isMachineFormat(opts?.format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (!result.connected) {
    console.log('Not connected. Connect with: canonry ads connect ' + project + ' --api-key <sdk-key>')
    return
  }
  console.log(`Account:      ${result.displayName ?? 'unknown'} (${result.currencyCode ?? '?'})`)
  console.log(`Structure:    ${result.campaignCount} campaigns / ${result.adGroupCount} ad groups / ${result.adCount} ads`)
  console.log(`Window:       ${result.window.from ?? '—'} → ${result.window.to ?? '—'}`)
  console.log(`Impressions:  ${result.totals.impressions}`)
  console.log(`Clicks:       ${result.totals.clicks}${result.totals.ctr != null ? ` (CTR ${(result.totals.ctr * 100).toFixed(2)}%)` : ''}`)
  console.log(`Spend:        ${formatMicros(result.totals.spendMicros, result.currencyCode ?? 'USD')}${result.totals.cpcMicros != null ? ` (CPC ${formatMicros(result.totals.cpcMicros, result.currencyCode ?? 'USD')})` : ''}`)
  console.log(`Last synced:  ${result.lastSyncedAt ?? 'never'}`)
}
