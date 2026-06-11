import type {
  AdsCampaignListResponse,
  AdsConnectionStatusDto,
  AdsDisconnectResponse,
  AdsInsightsResponse,
  AdsSummaryDto,
  AdsSyncResponse,
} from '@ainyc/canonry-contracts'
import { formatMicros } from '@ainyc/canonry-contracts'
import { createApiClient } from '../client.js'
import { CliError, isMachineFormat } from '../cli-error.js'
import { emitJsonl } from '../cli-output.js'

function getClient() {
  return createApiClient()
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
  console.log('DATE        LEVEL      ENTITY                                 IMPR    CLICKS  SPEND      CPC')
  for (const row of result.rows) {
    const cpc = row.cpcMicros != null ? formatMicros(row.cpcMicros) : '—'
    console.log(
      `${row.date}  ${row.level.padEnd(9)}  ${row.entityId.padEnd(36).slice(0, 36)}  ${String(row.impressions).padStart(6)}  ${String(row.clicks).padStart(6)}  ${formatMicros(row.spendMicros).padStart(9)}  ${cpc}`,
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
