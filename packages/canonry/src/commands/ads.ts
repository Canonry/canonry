import fs from 'node:fs'
import type {
  AdsAccountDto,
  AdsCampaignListResponse,
  AdsConnectionStatusDto,
  AdsConversionEventSettingListResponse,
  AdsConversionPixelListResponse,
  AdsDisconnectResponse,
  AdsActivationGrantCreateRequest,
  AdsActivationGrantResponse,
  AdsActivateTreeRequest,
  AdsActivateTreeResponse,
  AdsGeoSearchQuery,
  AdsGeoSearchResponse,
  AdsInsightsResponse,
  AdsSummaryDto,
  AdsDeliveryDiagnosticsDto,
  AdsLiveDeliveryDto,
  AdsSyncResponse,
  AdsOperationDto,
  AdsOperationReconcileResponse,
  AdsOperationResponse,
  AdsUnresolvedOperationListResponse,
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
  adsActivationGrantCreateRequestSchema,
  adsActivateTreeRequestSchema,
  adsImageUploadRequestSchema,
  adsPauseRequestSchema,
  AdsOperationKinds,
  AdsOperationStates,
  AdsOperationStepStates,
  AdsHistoricalCampaignRollupStatuses,
  AdsDeliverySnapshotStatuses,
  AdsLiveEntityTypes,
  formatMicros,
  formatPercent,
  describeError,
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
      message: describeError(err),
      displayMessage: `Error: invalid ads JSON input (${describeError(err)})`,
      details: { inputPath },
    })
  }
}

/**
 * The suffix that tells a reader the last date in a window is not a finished
 * day. Empty when every date in the window is closed.
 *
 * The sync now stores the ad account's current local day while it is still
 * running, so a total that spans it keeps rising. Reading such a total as a
 * closed one is the mistake this note exists to prevent, so it names the date
 * rather than saying "today": the account's day is not necessarily the reader's.
 */
function partialDayNote(inProgressDate: string | null): string {
  return inProgressDate === null ? '' : ` (${inProgressDate} still filling)`
}

function printOperationDetails(operation: AdsOperationDto): void {
  console.log(`Operation: ${operation.operationKey}`)
  if (operation.entityId) console.log(`Entity:    ${operation.entityType ?? 'unknown'} ${operation.entityId}`)
  if (operation.upstreamUpdatedAt != null) console.log(`Updated:   ${operation.upstreamUpdatedAt}`)
  if (operation.errorCode) console.log(`Error:     ${operation.errorCode}: ${operation.errorMessage ?? ''}`)
  if (
    operation.state === AdsOperationStates.pending ||
    operation.state === AdsOperationStates.unknown ||
    operation.state === AdsOperationStates.reconciling
  ) {
    if (operation.kind === AdsOperationKinds.campaign_tree_activate) {
      console.log('Do not retry with a new operation key. Resume activation recovery for the original receipt instead.')
    } else {
      console.log('Do not retry with a new operation key. Reconcile the original receipt instead.')
    }
  }
}

function printOperation(result: AdsOperationResponse, format?: string): void {
  if (isMachineFormat(format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(`${result.replayed ? 'Replayed' : 'Recorded'} ${result.operation.kind}: ${result.operation.state}`)
  printOperationDetails(result.operation)
}

function printReconciliation(result: AdsOperationReconcileResponse, format?: string): void {
  if (isMachineFormat(format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(`${result.resolved ? 'Resolved' : 'Still unresolved'} ${result.operation.kind}: ${result.operation.state}`)
  printOperationDetails(result.operation)
}

function printActivationGrant(
  result: AdsActivationGrantResponse,
  verb: 'Approved' | 'Revoked',
  format?: string,
): void {
  if (isMachineFormat(format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  const cancellationRequested = verb === 'Revoked' && result.grant.revocationRequestedAt !== null
  console.log(cancellationRequested
    ? `Cancellation requested for activation grant ${result.grant.id}: ${result.grant.state}`
    : `${verb} activation grant ${result.grant.id}: ${result.grant.state}`)
  if (cancellationRequested) console.log(`Requested: ${result.grant.revocationRequestedAt}`)
  console.log(`Manifest: ${result.grant.manifestHash}`)
  console.log(`Expires:  ${result.grant.expiresAt}`)
}

function printActivation(result: AdsActivateTreeResponse, format?: string): void {
  if (isMachineFormat(format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  const activeSteps = result.steps.filter((step) => step.state === AdsOperationStepStates.active).length
  console.log(`Activation ${result.operation.operationKey}: ${result.operation.state}`)
  console.log(`Steps:      ${activeSteps}/${result.steps.length} active`)
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
    const name = pixel.name ?? 'Unnamed conversion pixel'
    const clientType = pixel.clientType ?? 'unknown client'
    const pixelId = pixel.pixelId ? ` pixel ${pixel.pixelId}` : ''
    console.log(`${name} (${clientType}) [${pixel.id}]${pixelId}`)
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
    const name = eventSetting.name ?? 'Unnamed conversion event'
    const eventType = eventSetting.eventType ?? 'unknown event'
    const attribution = eventSetting.attributionWindowDays === undefined
      ? 'unknown attribution window'
      : `${eventSetting.attributionWindowDays}d attribution`
    const sources = eventSetting.sources
      ?.map((source) => source.name ?? source.id)
      .join(', ') || 'no source details'
    const archived = eventSetting.archived === true ? ' [archived]' : ''
    console.log(
      `${name}${archived}: ${eventType}, ${attribution}, ${sources} [${eventSetting.id}]`,
    )
  }
}

export async function adsOperationGet(
  project: string,
  opts: { operationKey: string; format?: string },
): Promise<void> {
  printOperation(await getClient().getAdsOperation(project, opts.operationKey), opts.format)
}

export async function adsOperationsUnresolved(
  project: string,
  opts?: { state?: Array<'pending' | 'unknown' | 'reconciling'>; limit?: number; cursor?: string; format?: string },
): Promise<void> {
  const query = {
    state: opts?.state,
    limit: opts?.limit,
    cursor: opts?.cursor,
  }
  const client = getClient()
  const result: AdsUnresolvedOperationListResponse = Object.values(query)
    .some((value) => value !== undefined)
    ? await client.getUnresolvedAdsOperations(project, query)
    : await client.getUnresolvedAdsOperations(project)

  if (opts?.format === 'jsonl') {
    emitJsonl(result.operations.map((operation) => ({ project, ...operation })))
    return
  }
  if (isMachineFormat(opts?.format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (result.operations.length === 0) {
    console.log('No unresolved OpenAI Ads mutation receipts.')
    return
  }
  console.log('STATE         KIND                  OPERATION KEY')
  for (const operation of result.operations) {
    console.log(`${operation.state.padEnd(13)} ${operation.kind.padEnd(21)} ${operation.operationKey}`)
  }
  if (result.nextCursor) console.log(`Next cursor: ${result.nextCursor}`)
}

export async function adsOperationReconcile(
  project: string,
  opts: { operationKey: string; format?: string },
): Promise<void> {
  printReconciliation(
    await getClient().reconcileAdsOperation(project, opts.operationKey),
    opts.format,
  )
}

export async function adsOperationResumeActivation(
  project: string,
  opts: { operationKey: string; format?: string },
): Promise<void> {
  printActivation(
    await getClient().resumeAdsActivation(project, opts.operationKey),
    opts.format,
  )
}

export async function adsActivationGrantCreate(
  project: string,
  opts: { input?: string; format?: string },
): Promise<void> {
  const request: AdsActivationGrantCreateRequest = readRequest(
    opts.input,
    adsActivationGrantCreateRequestSchema,
  )
  printActivationGrant(await getClient().createAdsActivationGrant(project, request), 'Approved', opts.format)
}

export async function adsActivationGrantRevoke(
  project: string,
  grantId: string,
  opts?: { format?: string },
): Promise<void> {
  printActivationGrant(
    await getClient().revokeAdsActivationGrant(project, grantId),
    'Revoked',
    opts?.format,
  )
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

export async function adsCampaignActivateTree(
  project: string,
  campaignId: string,
  opts: { input?: string; format?: string },
): Promise<void> {
  const request: AdsActivateTreeRequest = readRequest(opts.input, adsActivateTreeRequestSchema)
  printActivation(await getClient().activateAdsCampaignTree(project, campaignId, request), opts.format)
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
    // A row for the account's current day is still filling. Say so on the row
    // rather than in a footnote, so a reader scanning the table cannot compare
    // it against the finished days above it by accident.
    const partial = row.inProgress ? '  (still filling)' : ''
    console.log(
      `${row.date}  ${row.level.padEnd(9)}  ${row.entityId.padEnd(36).slice(0, 36)}  ${String(row.impressions).padStart(6)}  ${String(row.clicks).padStart(6)}  ${formatMicros(row.spendMicros, currency).padStart(9)}  ${cpc}${partial}`,
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
  console.log(`Window:       ${result.window.from ?? '—'} → ${result.window.to ?? '—'}${partialDayNote(result.window.inProgressDate)}`)
  console.log(`Impressions:  ${result.totals.impressions}`)
  console.log(`Clicks:       ${result.totals.clicks}${result.totals.ctr != null ? ` (CTR ${formatPercent(result.totals.ctr)})` : ''}`)
  console.log(`Spend:        ${formatMicros(result.totals.spendMicros, result.currencyCode ?? 'USD')}${result.totals.cpcMicros != null ? ` (CPC ${formatMicros(result.totals.cpcMicros, result.currencyCode ?? 'USD')})` : ''}`)
  console.log(`Last synced:  ${result.lastSyncedAt ?? 'never'}`)
}

export async function adsDeliveryDiagnostics(project: string, opts?: { format?: string }): Promise<void> {
  const result: AdsDeliveryDiagnosticsDto = await getClient().getAdsDeliveryDiagnostics(project)

  if (isMachineFormat(opts?.format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`Snapshot:     ${result.snapshot.status}${result.snapshot.issue ? ` (${result.snapshot.issue})` : ''}`)
  console.log(`Source sync:  ${result.snapshot.sourceSync ? `${result.snapshot.sourceSync.runId} [${result.snapshot.sourceSync.status}]` : 'none'}`)
  console.log(`Structure:    ${result.snapshot.campaignCount} campaigns / ${result.snapshot.adGroupCount} ad groups / ${result.snapshot.adCount} ads`)
  console.log(`Last synced:  ${result.snapshot.lastSyncedAt ?? 'never'}`)
  console.log(`Activity:     ${result.assessment.state}`)
  if (
    result.historicalCampaignRollups.status === AdsHistoricalCampaignRollupStatuses.reported &&
    result.historicalCampaignRollups.totals !== null
  ) {
    const rollupWindow = result.historicalCampaignRollups.window
    console.log(`Historical:   ${result.historicalCampaignRollups.totals.impressions} impressions / ${result.historicalCampaignRollups.totals.clicks} clicks (${rollupWindow.from} → ${rollupWindow.to})${partialDayNote(rollupWindow.inProgressDate)}`)
  } else {
    console.log('Historical:   no stored campaign rollups')
  }
  console.log('Evidence:     stored snapshot and historical rollups only; not an OpenAI eligibility or serving verdict.')
  if (result.snapshot.status !== AdsDeliverySnapshotStatuses.complete) {
    console.log('Structure details suppressed until a complete trusted snapshot exists.')
    return
  }

  for (const campaign of result.storedConfiguration.campaigns) {
    const budget = campaign.dailySpendLimitMicros !== null
      ? `${formatMicros(campaign.dailySpendLimitMicros)}/day`
      : campaign.lifetimeSpendLimitMicros !== null
        ? `${formatMicros(campaign.lifetimeSpendLimitMicros)} lifetime`
        : 'no stored budget'
    console.log(`${campaign.name} [${campaign.status}] — ${campaign.biddingType ?? 'unknown bidding'}, ${budget}, ${campaign.conversionEventSettingIds.length} conversion settings`)
    for (const group of campaign.adGroups) {
      const bid = group.maxBidMicros === null ? 'no stored max bid' : `max bid ${formatMicros(group.maxBidMicros)}`
      console.log(`  - ${group.name} [${group.status}] — ${group.billingEventType ?? 'unknown billing'}, ${bid}, ${group.contextHints.length} context hints`)
      for (const ad of group.ads) console.log(`      ${ad.name} [${ad.status}] review=${ad.reviewStatus ?? 'unknown'}`)
    }
  }
}

export async function adsLiveDelivery(
  project: string,
  opts?: { campaignId?: string; lookbackDays?: number; format?: string },
): Promise<void> {
  const result: AdsLiveDeliveryDto = await getClient().getAdsLiveDelivery(project, {
    campaignId: opts?.campaignId,
    lookbackDays: opts?.lookbackDays,
  })

  if (isMachineFormat(opts?.format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`Read at:      ${result.fetchedAt} (live provider read)`)
  console.log(`Ad account:   ${result.adAccountId}`)
  console.log(`Snapshot:     last synced ${result.storedSnapshotSyncedAt ?? 'never'}`)
  console.log(`Metrics:      last ${result.metricsWindow.lookbackDays}d, as the provider reported them`)
  // Two units, said plainly: a reader call is a logical list/insight read and
  // auto-paginates upstream, so the HTTP ceiling is far above the call count.
  console.log(`Provider:     ${result.bounds.readerCalls}/${result.bounds.maxReaderCalls} reader calls, up to ${result.bounds.maxUpstreamHttpRequests} upstream HTTP requests${result.bounds.truncated ? ' (TRUNCATED, walk hit a cap)' : ''}`)
  console.log(`Drift:        ${result.drift.driftedEntities}/${result.drift.entitiesCompared} entities (${result.drift.statusDrifted} status, ${result.drift.metricsDrifted} metrics)`)
  for (const failure of result.errors) {
    console.log(`Read failed:  ${failure.surface}${failure.entityId ? ` ${failure.entityId}` : ''}${failure.upstreamStatus === null ? '' : ` [HTTP ${failure.upstreamStatus}]`}`)
  }

  for (const entity of result.entities) {
    const indent = entity.entityType === AdsLiveEntityTypes.campaign
      ? ''
      : entity.entityType === AdsLiveEntityTypes.ad_group ? '  ' : '    '
    const label = entity.live?.name ?? entity.stored?.name ?? entity.id
    const liveStatus = entity.live === null ? 'absent upstream' : entity.live.status
    const storedStatus = entity.stored === null ? 'absent locally' : entity.stored.status
    const marker = entity.drifted ? 'DRIFT' : 'match'
    console.log(`${indent}${label} [${entity.entityType}]: live ${liveStatus} / stored ${storedStatus} (${marker})`)
    for (const delta of entity.fieldDeltas) {
      console.log(`${indent}  ${delta.field}: live ${delta.live ?? 'none'} / stored ${delta.stored ?? 'none'}`)
    }
    for (const delta of entity.metricDeltas ?? []) {
      if (!delta.drifted) continue
      const live = delta.live === null
        ? 'no provider row'
        : `${delta.live.impressions} impr / ${delta.live.clicks} clicks / ${formatMicros(delta.live.spendMicros)}`
      const stored = delta.stored === null
        ? 'no stored row'
        : `${delta.stored.impressions} impr / ${delta.stored.clicks} clicks / ${formatMicros(delta.stored.spendMicros)}`
      console.log(`${indent}  ${delta.date}: live ${live} / stored ${stored}`)
    }
  }
}
