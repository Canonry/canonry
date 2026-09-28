import fs from 'node:fs'
import type {
  ConversionTrackingContract,
  ConversionTrackingContractWriteRequest,
  ConversionTrackingIntegrityReadEnvelope,
  GoogleAdsAccessibleCustomersResponse,
  GoogleAdsConnectionStatusDto,
  GoogleAdsCustomerSelectionRequest,
  GoogleAdsMetricsWindow,
  GoogleAdsPerformanceDto,
  GoogleAdsStoredSnapshotPage,
  GoogleAdsStoredSnapshotReadEnvelope,
  GoogleMarketingDisconnectResponse,
  GtmAccountsResponse,
  GtmConnectionStatusDto,
  GtmContainerListResponse,
  GtmResourceSelectionRequest,
  GtmStoredSnapshotPage,
  GtmStoredSnapshotReadEnvelope,
  GtmWorkspaceListResponse,
  RunDto,
} from '@ainyc/canonry-contracts'
import {
  canonicalizeGtmAccountId,
  canonicalizeGtmResourceSelection,
  conversionTrackingContractWriteRequestSchema,
  describeError,
  formatMicros,
  formatPercent,
} from '@ainyc/canonry-contracts'
import { CliError, isMachineFormat } from '../cli-error.js'
import { emitJsonl } from '../cli-output.js'

/**
 * The CLI/MCP shared boundary for Google Marketing. `ApiClient` implements
 * this after OpenAPI generation; keeping it explicit here prevents command
 * code from reaching around the generated SDK or provider adapters.
 */
export interface GoogleMarketingCliClient {
  disconnectGoogleAds(project: string): Promise<GoogleMarketingDisconnectResponse>
  disconnectGtm(project: string): Promise<GoogleMarketingDisconnectResponse>

  getGoogleAdsStatus(project: string): Promise<GoogleAdsConnectionStatusDto>
  listGoogleAdsCustomers(project: string): Promise<GoogleAdsAccessibleCustomersResponse>
  setGoogleAdsSelection(project: string, request: GoogleAdsCustomerSelectionRequest): Promise<GoogleAdsConnectionStatusDto>
  triggerGoogleAdsSync(project: string): Promise<RunDto>
  getGoogleAdsPerformance(project: string, query?: { window?: GoogleAdsMetricsWindow }): Promise<GoogleAdsPerformanceDto>
  listGoogleAdsSnapshots(project: string, query?: { limit?: number; cursor?: string }): Promise<GoogleAdsStoredSnapshotPage>
  getGoogleAdsSnapshot(project: string, snapshotId: string): Promise<GoogleAdsStoredSnapshotReadEnvelope>

  getGtmStatus(project: string): Promise<GtmConnectionStatusDto>
  listGtmAccounts(project: string): Promise<GtmAccountsResponse>
  listGtmContainers(project: string, accountId: string): Promise<GtmContainerListResponse>
  listGtmWorkspaces(project: string, accountId: string, containerId: string): Promise<GtmWorkspaceListResponse>
  setGtmSelection(project: string, request: GtmResourceSelectionRequest): Promise<GtmConnectionStatusDto>
  triggerGtmSync(project: string): Promise<RunDto>
  listGtmSnapshots(project: string, query?: { limit?: number; cursor?: string }): Promise<GtmStoredSnapshotPage>
  getGtmSnapshot(project: string, snapshotId: string): Promise<GtmStoredSnapshotReadEnvelope>

  listConversionTrackingContracts(project: string): Promise<ConversionTrackingContract[]>
  getConversionTrackingContract(project: string, contractId: string): Promise<ConversionTrackingContract>
  createConversionTrackingContract(project: string, request: ConversionTrackingContractWriteRequest): Promise<ConversionTrackingContract>
  updateConversionTrackingContract(project: string, contractId: string, request: ConversionTrackingContractWriteRequest): Promise<ConversionTrackingContract>
  deleteConversionTrackingContract(project: string, contractId: string): Promise<void>
  getConversionTrackingIntegrity(project: string, contractId: string): Promise<ConversionTrackingIntegrityReadEnvelope>
}

function printMachine(value: unknown, format: string | undefined): boolean {
  if (!isMachineFormat(format)) return false
  console.log(JSON.stringify(value, null, 2))
  return true
}

function connectionSummary(status: GoogleAdsConnectionStatusDto | GtmConnectionStatusDto): string {
  if (!status.connected) return 'not connected'
  if (status.status === 'selection-required') return 'connected; selection required'
  return status.status === 'stale' ? 'connected; stored evidence is stale' : 'connected'
}

function snapshotSummary(snapshot: { kind: string; id: string; capturedAt: string; payloadChecksum: string }): string {
  return `${snapshot.capturedAt}  ${snapshot.kind.padEnd(22)}  ${snapshot.id}  ${snapshot.payloadChecksum.slice(0, 12)}`
}

function canonicalGtmReadAccountId(accountId: string): string {
  const canonical = canonicalizeGtmAccountId(accountId)
  if (canonical) return canonical
  throw new CliError({
    code: 'GTM_RESOURCE_INPUT_INVALID',
    message: 'GTM account must be a safe bare ID or an accounts/{id} resource path.',
    displayMessage: 'Error: GTM account must be a safe bare ID or an accounts/{id} resource path.',
  })
}

function canonicalGtmReadSelection(accountId: string, containerId: string): {
  accountId: string
  containerId: string
} {
  const canonical = canonicalizeGtmResourceSelection({ accountId, containerId })
  if (canonical) return canonical
  throw new CliError({
    code: 'GTM_RESOURCE_INPUT_INVALID',
    message: 'GTM account and container must be matching safe IDs or resource paths.',
    displayMessage: 'Error: GTM account and container must be matching safe IDs or resource paths.',
  })
}

export function readConversionTrackingContractInput(
  inputPath: string | undefined,
): ConversionTrackingContractWriteRequest {
  if (!inputPath) {
    throw new CliError({
      code: 'CONVERSION_TRACKING_INPUT_REQUIRED',
      message: 'A conversion-tracking contract JSON input file is required',
      displayMessage: 'Error: --input <json-file> is required (use --input - for stdin)',
    })
  }
  try {
    const raw = fs.readFileSync(inputPath === '-' ? 0 : inputPath, 'utf8')
    return conversionTrackingContractWriteRequestSchema.parse(JSON.parse(raw))
  } catch (err) {
    const message = describeError(err)
    throw new CliError({
      code: 'CONVERSION_TRACKING_INPUT_INVALID',
      message,
      displayMessage: `Error: invalid conversion-tracking contract input (${message})`,
      details: { inputPath },
    })
  }
}

export async function googleAdsDisconnect(
  client: GoogleMarketingCliClient,
  project: string,
  opts: { format?: string },
): Promise<void> {
  const result = await client.disconnectGoogleAds(project)
  if (printMachine(result, opts.format)) return
  console.log(result.disconnected
    ? `Disconnected Google Ads from project "${project}". Stored redacted evidence was retained.`
    : `Google Ads was not connected to project "${project}".`)
}

export async function gtmDisconnect(
  client: GoogleMarketingCliClient,
  project: string,
  opts: { format?: string },
): Promise<void> {
  const result = await client.disconnectGtm(project)
  if (printMachine(result, opts.format)) return
  console.log(result.disconnected
    ? `Disconnected Google Tag Manager from project "${project}". Stored redacted evidence was retained.`
    : `Google Tag Manager was not connected to project "${project}".`)
}

export async function googleAdsStatus(
  client: GoogleMarketingCliClient,
  project: string,
  opts: { format?: string },
): Promise<void> {
  const result = await client.getGoogleAdsStatus(project)
  if (printMachine(result, opts.format)) return
  console.log(`Google Ads: ${connectionSummary(result)}`)
  if (!result.connected) {
    console.log(`Open project "${project}" in the Canonry dashboard to authorize Google Ads.`)
    return
  }
  const selection = result.connection.selection
  console.log(`Customer: ${selection.customerId ?? 'not selected'}`)
  if (selection.loginCustomerId) console.log(`Login customer: ${selection.loginCustomerId}`)
  if (result.selectedCustomer) {
    console.log(`Selected: ${result.selectedCustomer.descriptiveName ?? result.selectedCustomer.customerId} (${result.selectedCustomer.status})`)
  }
  console.log(`Last inventory snapshot: ${result.connection.lastInventorySnapshotAt ?? 'none'}`)
  console.log(`Last metrics snapshot: ${result.connection.lastMetricsSnapshotAt ?? 'none'}`)
}

export async function gtmStatus(
  client: GoogleMarketingCliClient,
  project: string,
  opts: { format?: string },
): Promise<void> {
  const result = await client.getGtmStatus(project)
  if (printMachine(result, opts.format)) return
  console.log(`Google Tag Manager: ${connectionSummary(result)}`)
  if (!result.connected) {
    console.log(`Open project "${project}" in the Canonry dashboard to authorize Google Tag Manager.`)
    return
  }
  console.log(`Account: ${result.selection.accountId ?? 'not selected'}`)
  console.log(`Container: ${result.selection.containerId ?? 'not selected'}`)
  console.log(`Workspace: ${result.selection.workspaceId ?? 'none (live only)'}`)
  console.log(`Last snapshot: ${result.connection.lastSnapshotAt ?? 'none'}`)
}

export async function googleAdsCustomers(
  client: GoogleMarketingCliClient,
  project: string,
  opts: { format?: string },
): Promise<void> {
  const result = await client.listGoogleAdsCustomers(project)
  if (opts.format === 'jsonl') {
    emitJsonl(result.customers.map(customer => ({ project, fetchedAt: result.fetchedAt, ...customer })))
    return
  }
  if (printMachine(result, opts.format)) return
  if (result.customers.length === 0) {
    console.log('No Google Ads customers are visible to this OAuth connection.')
    return
  }
  console.log(`${result.totalAccessible} accessible customer(s)${result.truncated ? ' (bounded list; truncated)' : ''}:\n`)
  for (const customer of result.customers) {
    const role = customer.manager ? 'manager' : 'client'
    const name = customer.descriptiveName ?? '(unnamed)'
    console.log(`  ${customer.customerId.padEnd(16)} ${name}  ${role}, ${customer.status}`)
  }
  console.log(`\nSelect one with: canonry google-ads select ${project} --customer <customer-id>`)
}

export async function googleAdsSelect(
  client: GoogleMarketingCliClient,
  project: string,
  request: GoogleAdsCustomerSelectionRequest,
  opts: { format?: string },
): Promise<void> {
  const result = await client.setGoogleAdsSelection(project, request)
  if (printMachine(result, opts.format)) return
  console.log(`Selected Google Ads customer ${request.customerId}${request.loginCustomerId ? ` through login customer ${request.loginCustomerId}` : ''}.`)
  console.log(`Run \`canonry google-ads sync ${project}\` to capture read-only conversion and goal evidence.`)
}

export async function googleAdsSync(
  client: GoogleMarketingCliClient,
  project: string,
  opts: { format?: string },
): Promise<void> {
  const run = await client.triggerGoogleAdsSync(project)
  if (printMachine(run, opts.format)) return
  console.log(`Google Ads read-only sync queued (run ${run.id}). Use \`canonry run show ${run.id}\` to check it.`)
}

/**
 * Every money field crossing this boundary is INTEGER MICROS. It becomes a
 * currency string HERE, at the render edge, and nowhere earlier: `--format json`
 * must stay byte-identical to the API response so an agent can swap a UI fetch
 * for this command without re-deriving anything.
 */
function performanceMicros(micros: number | null, currencyCode: string | null): string {
  if (micros === null) return '—'
  // No resolved account currency: print the magnitude without asserting a unit.
  // Defaulting to USD puts a dollar sign on a EUR account, which is a wrong
  // number rather than a missing one.
  if (currencyCode === null) return (micros / 1_000_000).toFixed(2)
  return formatMicros(micros, currencyCode)
}

/** A relative change (0.25 = +25%) as a suffix; empty when there is no prior value to compare. */
function performanceChange(ratio: number | null): string {
  if (ratio === null) return ''
  const sign = ratio > 0 ? '+' : ''
  return ` (${sign}${formatPercent(ratio)} vs prior period)`
}

export async function googleAdsPerformance(
  client: GoogleMarketingCliClient,
  project: string,
  opts: { window?: GoogleAdsMetricsWindow; format?: string },
): Promise<void> {
  const result = await client.getGoogleAdsPerformance(project, opts.window ? { window: opts.window } : {})
  if (printMachine(result, opts.format)) return

  if (!result.source) {
    console.log(`No stored Google Ads metrics for project "${project}".`)
    console.log(`Run \`canonry google-ads sync ${project}\` after selecting a customer.`)
    return
  }

  const currency = result.source.currencyCode
  const { totals, comparison } = result
  console.log(`Window:       ${result.startDate} → ${result.endDate} (${result.days} closed day(s), ${result.window})`)
  // The capture day is PARTIAL, so it is excluded. Saying so keeps a reader from
  // reading the newest closed day as "today is down".
  console.log(`As of:        ${result.source.asOfDate}${result.source.openDate ? ` (${result.source.openDate} still open, excluded)` : ''}`)
  console.log(`Account:      ${result.source.customerId} (${currency ?? '?'}, ${result.source.timeZone ?? 'unknown zone'})`)
  console.log(`Impressions:  ${totals.impressions}${performanceChange(comparison?.change.impressions ?? null)}`)
  console.log(`Clicks:       ${totals.clicks} (CTR ${formatPercent(totals.ctr)})${performanceChange(comparison?.change.clicks ?? null)}`)
  console.log(`Cost:         ${performanceMicros(totals.costMicros, currency)} (CPC ${performanceMicros(totals.cpcMicros, currency)})${performanceChange(comparison?.change.costMicros ?? null)}`)
  console.log(`Conversions:  ${totals.conversions} (rate ${formatPercent(totals.conversionRate)}, cost/conv ${performanceMicros(totals.costPerConversionMicros, currency)})`)
  if (!comparison) {
    console.log(`Comparison:   unavailable (${result.comparisonUnavailableReason ?? 'unknown'})`)
  }
  // The row cap and the 50-campaign query cap are DIFFERENT limits. An account
  // with more than 50 campaigns is summed from the queried subset while
  // `truncated` stays false, so reporting coverage only on `truncated` would
  // print a subtotal as the account total. Compare the counts directly.
  if (result.source.campaignsInInventory > 0 && result.source.campaignsQueried < result.source.campaignsInInventory) {
    console.log(`Coverage:     ${result.source.campaignsQueried} of ${result.source.campaignsInInventory} campaigns; totals are a subset of the account.`)
  }
  if (result.source.truncated) {
    // `truncated` is set by the sync from EITHER the provider row cap or the
    // 50-campaign selection cap, so naming one of them is wrong half the time.
    console.log(`Note:         the provider returned a bounded result, so these totals are a subset sum.`)
  }

  if (result.campaigns.length > 0) {
    console.log(`\n${result.campaigns.length} campaign(s):\n`)
    for (const campaign of result.campaigns) {
      const label = campaign.name ?? `(not in stored inventory: ${campaign.campaignId})`
      console.log(`  ${label.padEnd(32).slice(0, 32)}  ${campaign.status.padEnd(8)}  ${String(campaign.totals.impressions).padStart(8)} impr  ${String(campaign.totals.clicks).padStart(6)} clicks  ${performanceMicros(campaign.totals.costMicros, currency).padStart(12)}`)
    }
  }

  const filled = result.daily.filter(point => point.origin === 'filled').length
  if (filled > 0) {
    console.log(`\n${filled} of ${result.daily.length} day(s) had no delivery and are reported as zero.`)
  }
}

export async function googleAdsSnapshots(
  client: GoogleMarketingCliClient,
  project: string,
  opts: { limit?: number; cursor?: string; format?: string },
): Promise<void> {
  const result = await client.listGoogleAdsSnapshots(project, { limit: opts.limit, cursor: opts.cursor })
  if (opts.format === 'jsonl') {
    emitJsonl(result.snapshots.map(snapshot => ({ project, ...snapshot })))
    return
  }
  if (printMachine(result, opts.format)) return
  if (result.snapshots.length === 0) {
    console.log(`No stored Google Ads snapshots. Run \`canonry google-ads sync ${project}\` after selecting a customer.`)
    return
  }
  console.log(`${result.total} stored Google Ads snapshot(s):\n`)
  for (const snapshot of result.snapshots) console.log(`  ${snapshotSummary(snapshot)}`)
  if (result.nextCursor) console.log(`\nNext cursor: ${result.nextCursor}`)
}

export async function googleAdsSnapshot(
  client: GoogleMarketingCliClient,
  project: string,
  snapshotId: string,
  opts: { format?: string },
): Promise<void> {
  const result = await client.getGoogleAdsSnapshot(project, snapshotId)
  if (printMachine(result, opts.format)) return
  const { metadata, payload } = result.snapshot
  console.log(`Google Ads ${metadata.kind} snapshot ${metadata.id}`)
  console.log(`Captured: ${metadata.capturedAt}`)
  console.log(`Checksum: ${metadata.payloadChecksum}`)
  console.log(`Payload kind: ${payload.kind}`)
}

export async function gtmAccounts(
  client: GoogleMarketingCliClient,
  project: string,
  opts: { format?: string },
): Promise<void> {
  const result = await client.listGtmAccounts(project)
  if (opts.format === 'jsonl') {
    emitJsonl(result.accounts.map(account => ({ project, fetchedAt: result.fetchedAt, ...account })))
    return
  }
  if (printMachine(result, opts.format)) return
  if (result.accounts.length === 0) {
    console.log('No GTM accounts are visible to this OAuth connection.')
    return
  }
  console.log(`${result.totalAccessible} accessible GTM account(s)${result.truncated ? ' (bounded list; truncated)' : ''}:\n`)
  for (const account of result.accounts) console.log(`  ${account.id.padEnd(16)} ${account.name}`)
  console.log(`\nDiscover containers with: canonry gtm containers ${project} --account <account-id>`)
}

export async function gtmContainers(
  client: GoogleMarketingCliClient,
  project: string,
  accountId: string,
  opts: { format?: string },
): Promise<void> {
  const canonicalAccountId = canonicalGtmReadAccountId(accountId)
  const result = await client.listGtmContainers(project, canonicalAccountId)
  if (opts.format === 'jsonl') {
    emitJsonl(result.containers.map(container => ({ project, fetchedAt: result.fetchedAt, ...container })))
    return
  }
  if (printMachine(result, opts.format)) return
  if (result.containers.length === 0) {
    console.log(`No GTM containers are visible under account ${accountId}.`)
    return
  }
  console.log(`${result.totalAccessible} GTM container(s)${result.truncated ? ' (bounded list; truncated)' : ''}:\n`)
  for (const container of result.containers) {
    const publicId = container.publicId ? ` (${container.publicId})` : ''
    console.log(`  ${container.id.padEnd(16)} ${container.name}${publicId}`)
  }
  console.log(`\nDiscover workspaces with: canonry gtm workspaces ${project} --account ${accountId} --container <container-id>`)
}

export async function gtmWorkspaces(
  client: GoogleMarketingCliClient,
  project: string,
  accountId: string,
  containerId: string,
  opts: { format?: string },
): Promise<void> {
  const selection = canonicalGtmReadSelection(accountId, containerId)
  const result = await client.listGtmWorkspaces(project, selection.accountId, selection.containerId)
  if (opts.format === 'jsonl') {
    emitJsonl(result.workspaces.map(workspace => ({ project, fetchedAt: result.fetchedAt, ...workspace })))
    return
  }
  if (printMachine(result, opts.format)) return
  if (result.workspaces.length === 0) {
    console.log(`No GTM workspaces are visible for container ${containerId}. A sync can still capture the live container graph.`)
    return
  }
  console.log(`${result.totalAccessible} GTM workspace(s)${result.truncated ? ' (bounded list; truncated)' : ''}:\n`)
  for (const workspace of result.workspaces) console.log(`  ${workspace.id.padEnd(16)} ${workspace.name}`)
}

export async function gtmSelect(
  client: GoogleMarketingCliClient,
  project: string,
  request: GtmResourceSelectionRequest,
  opts: { format?: string },
): Promise<void> {
  const result = await client.setGtmSelection(project, request)
  if (printMachine(result, opts.format)) return
  console.log(`Selected GTM account ${request.accountId}, container ${request.containerId}${request.workspaceId ? `, and workspace ${request.workspaceId}` : ''}.`)
  console.log(`Run \`canonry gtm sync ${project}\` to capture redacted live${request.workspaceId ? ' and draft' : ''} evidence.`)
}

export async function gtmSync(
  client: GoogleMarketingCliClient,
  project: string,
  opts: { format?: string },
): Promise<void> {
  const run = await client.triggerGtmSync(project)
  if (printMachine(run, opts.format)) return
  console.log(`GTM read-only sync queued (run ${run.id}). Use \`canonry run show ${run.id}\` to check it.`)
}

export async function gtmSnapshots(
  client: GoogleMarketingCliClient,
  project: string,
  opts: { limit?: number; cursor?: string; format?: string },
): Promise<void> {
  const result = await client.listGtmSnapshots(project, { limit: opts.limit, cursor: opts.cursor })
  if (opts.format === 'jsonl') {
    emitJsonl(result.snapshots.map(snapshot => ({ project, ...snapshot })))
    return
  }
  if (printMachine(result, opts.format)) return
  if (result.snapshots.length === 0) {
    console.log(`No stored GTM snapshots. Run \`canonry gtm sync ${project}\` after selecting a container.`)
    return
  }
  console.log(`${result.total} stored GTM snapshot(s):\n`)
  for (const snapshot of result.snapshots) console.log(`  ${snapshotSummary(snapshot)}`)
  if (result.nextCursor) console.log(`\nNext cursor: ${result.nextCursor}`)
}

export async function gtmSnapshot(
  client: GoogleMarketingCliClient,
  project: string,
  snapshotId: string,
  opts: { format?: string },
): Promise<void> {
  const result = await client.getGtmSnapshot(project, snapshotId)
  if (printMachine(result, opts.format)) return
  const { metadata, payload } = result.snapshot
  console.log(`GTM ${metadata.kind} snapshot ${metadata.id}`)
  console.log(`Captured: ${metadata.capturedAt}`)
  console.log(`Checksum: ${metadata.payloadChecksum}`)
  console.log(`Payload kind: ${payload.kind}`)
}

export async function conversionTrackingContracts(
  client: GoogleMarketingCliClient,
  project: string,
  opts: { format?: string },
): Promise<void> {
  const contracts = await client.listConversionTrackingContracts(project)
  if (opts.format === 'jsonl') {
    emitJsonl(contracts.map(contract => ({ project, ...contract })))
    return
  }
  if (printMachine(contracts, opts.format)) return
  if (contracts.length === 0) {
    console.log('No conversion-tracking contracts are declared for this project.')
    return
  }
  console.log(`${contracts.length} conversion-tracking contract(s):\n`)
  for (const contract of contracts) {
    console.log(`  ${contract.id.padEnd(16)} ${contract.name}  event=${contract.eventName}`)
  }
}

export async function conversionTrackingContract(
  client: GoogleMarketingCliClient,
  project: string,
  contractId: string,
  opts: { format?: string },
): Promise<void> {
  const contract = await client.getConversionTrackingContract(project, contractId)
  if (printMachine(contract, opts.format)) return
  printConversionTrackingContract(contract)
}

function printConversionTrackingContract(contract: ConversionTrackingContract): void {
  console.log(`Conversion contract: ${contract.name} (${contract.id})`)
  console.log(`Event: ${contract.eventName}`)
  console.log(`Google Ads: customer ${contract.googleAds.customerId}, conversion action ${contract.googleAds.conversionActionId}`)
  console.log(`GTM: account ${contract.gtm.accountId}, container ${contract.gtm.containerId}, tag ${contract.gtm.tagId}`)
  console.log(`Runtime verification: ${contract.runtime.verificationRequired ? 'required' : 'not required'}`)
}

export async function conversionTrackingCreate(
  client: GoogleMarketingCliClient,
  project: string,
  request: ConversionTrackingContractWriteRequest,
  opts: { format?: string },
): Promise<void> {
  const contract = await client.createConversionTrackingContract(project, request)
  if (printMachine(contract, opts.format)) return
  console.log(`Created conversion-tracking contract "${contract.name}" (${contract.id}).`)
}

export async function conversionTrackingUpdate(
  client: GoogleMarketingCliClient,
  project: string,
  contractId: string,
  request: ConversionTrackingContractWriteRequest,
  opts: { format?: string },
): Promise<void> {
  const contract = await client.updateConversionTrackingContract(project, contractId, request)
  if (printMachine(contract, opts.format)) return
  console.log(`Updated conversion-tracking contract "${contract.name}" (${contract.id}).`)
}

export async function conversionTrackingDelete(
  client: GoogleMarketingCliClient,
  project: string,
  contractId: string,
  opts: { format?: string },
): Promise<void> {
  await client.deleteConversionTrackingContract(project, contractId)
  if (printMachine({ project, contractId, deleted: true }, opts.format)) return
  console.log(`Deleted conversion-tracking contract ${contractId}.`)
}

export async function conversionTrackingIntegrity(
  client: GoogleMarketingCliClient,
  project: string,
  contractId: string,
  opts: { format?: string },
): Promise<void> {
  const result = await client.getConversionTrackingIntegrity(project, contractId)
  if (opts.format === 'jsonl') {
    emitJsonl(result.assessment.findings.map(finding => ({
      project,
      contractId: result.assessment.contract.id,
      integrityStatus: result.assessment.status,
      evaluatedAt: result.assessment.evaluatedAt,
      ...finding,
    })))
    return
  }
  if (printMachine(result, opts.format)) return
  console.log(`Conversion integrity: ${result.assessment.contract.name} — ${result.assessment.status}`)
  console.log(`Evaluated: ${result.assessment.evaluatedAt}`)
  for (const finding of result.assessment.findings) {
    console.log(`  ${finding.outcome.toUpperCase().padEnd(7)} ${finding.code} — ${finding.subject}`)
  }
  if (result.assessment.status === 'runtime-unverified') {
    console.log('\nStatic configuration is consistent, but a GTM API snapshot cannot prove that the website event fired or Google Ads observed a conversion.')
  }
}
