import type { GaConnectResponse, GA4PropertiesDto, GaStatusResponse, GaSyncResponse, GaTrafficResponse, GaCoverageResponse, GaMeasurementAnalysisDto, GaSocialReferralTrendResponse, GaAttributionTrendResponse, GA4AiReferralDailyDto, GA4AiReferralHistoryEntry, GA4SessionHistoryEntry, GA4SocialReferralHistoryEntry } from '@ainyc/canonry-contracts'
import { createApiClient } from '../client.js'
import { CliError, isMachineFormat } from '../cli-error.js'
import { emitJsonl } from '../cli-output.js'
import { describeError, formatPercent } from '@ainyc/canonry-contracts'

function getClient() {
  return createApiClient()
}

/** Options every date-scoped GA read accepts. */
export interface GaRangeOptions {
  window?: string
  startDate?: string
  endDate?: string
  format?: string
}

/**
 * Build the query params for a date-scoped GA read. Explicit dates win over the
 * rolling window server-side, so both are forwarded verbatim and the server is
 * the single place that decides. Returns undefined when nothing was asked for,
 * keeping the request byte-identical to an unfiltered one.
 */
function rangeParams(opts?: GaRangeOptions, extra?: Record<string, string>): Record<string, string> | undefined {
  const params: Record<string, string> = { ...extra }
  if (opts?.window) params.window = opts.window
  if (opts?.startDate) params.startDate = opts.startDate
  if (opts?.endDate) params.endDate = opts.endDate
  return Object.keys(params).length > 0 ? params : undefined
}

/** True when the read was scoped at all, so an empty result can say why. */
function isRangeScoped(opts?: GaRangeOptions): boolean {
  return Boolean(opts?.window || opts?.startDate || opts?.endDate)
}

export async function gaConnect(project: string, opts: {
  propertyId: string
  keyFile?: string
  keyJson?: string
  format?: string
}): Promise<void> {
  if (!opts.propertyId) {
    throw new CliError({
      code: 'GA_PROPERTY_ID_REQUIRED',
      message: 'Property ID is required (pass --property-id)',
      displayMessage: 'Error: --property-id is required',
      details: { project },
    })
  }

  const body: { propertyId: string; keyJson?: string } = {
    propertyId: opts.propertyId,
  }

  // If key-file is provided, read it locally and send contents as keyJson to the API
  // (the server never reads files from its own filesystem for security)
  if (opts.keyFile) {
    const fs = await import('node:fs')
    try {
      const content = fs.readFileSync(opts.keyFile, 'utf-8')
      // Validate it's JSON
      JSON.parse(content)
      body.keyJson = content
    } catch (e) {
      const msg = describeError(e)
      throw new CliError({
        code: 'GA_KEY_FILE_READ_ERROR',
        message: `Failed to read key file: ${msg}`,
        displayMessage: `Error: failed to read key file "${opts.keyFile}": ${msg}`,
        details: { project, keyFile: opts.keyFile },
      })
    }
  } else if (opts.keyJson) {
    body.keyJson = opts.keyJson
  }
  // No key provided — server will attempt to use existing OAuth token
  // from "canonry google connect <project> --type ga4"

  const client = getClient()
  const result: GaConnectResponse = await client.gaConnect(project, body)

  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`GA4 connected for project "${project}".`)
  console.log(`  Property ID:  ${result.propertyId}`)
  if (result.authMethod === 'service-account' && result.clientEmail) {
    console.log(`  Auth:         service account (${result.clientEmail})`)
  } else {
    console.log(`  Auth:         OAuth (canonry google connect --type ga4)`)
  }
}

export async function gaDisconnect(project: string, format?: string): Promise<void> {
  const client = getClient()
  await client.gaDisconnect(project)

  if (isMachineFormat(format)) {
    console.log(JSON.stringify({ project, disconnected: true }, null, 2))
    return
  }

  console.log(`GA4 disconnected from project "${project}".`)
}

export async function gaStatus(project: string, format?: string): Promise<void> {
  const client = getClient()
  const result: GaStatusResponse = await client.gaStatus(project)

  if (isMachineFormat(format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (!result.connected) {
    console.log(`No GA4 connection for project "${project}".`)
    console.log('Options:')
    console.log('  With service account: canonry ga connect <project> --property-id <id> --key-file <path>')
    console.log('  With OAuth:           canonry google connect <project> --type ga4')
    console.log('                        canonry ga connect <project> --property-id <id>')
    return
  }

  console.log(`GA4 for "${project}":\n`)
  console.log(`  Property ID:  ${result.propertyId}`)
  if (result.authMethod === 'service-account') {
    console.log(`  Auth:         service account (${result.clientEmail})`)
  } else {
    console.log(`  Auth:         OAuth`)
  }
  console.log(`  Last Synced:  ${result.lastSyncedAt ?? '(never)'}`)
  console.log(`  Connected:    ${result.createdAt ?? 'unknown'}`)
}

export async function gaProperties(project: string, format?: string): Promise<void> {
  const client = getClient()
  const result: GA4PropertiesDto = await client.gaProperties(project)

  if (format === 'jsonl') {
    emitJsonl(result.properties.map((p) => ({ project, ...p })))
    return
  }

  if (isMachineFormat(format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (result.properties.length === 0) {
    console.log(`No GA4 properties visible to the connected account for "${project}".`)
    return
  }

  console.log('Available GA4 properties:\n')
  const idWidth = Math.max(11, ...result.properties.map((p) => p.propertyId.length))
  const nameWidth = Math.max(12, ...result.properties.map((p) => p.displayName.length))
  console.log(`  ${'PROPERTY ID'.padEnd(idWidth)}  ${'DISPLAY NAME'.padEnd(nameWidth)}  ACCOUNT`)
  console.log(`  ${'─'.repeat(idWidth)}  ${'─'.repeat(nameWidth)}  ${'─'.repeat(12)}`)
  for (const p of result.properties) {
    console.log(`  ${p.propertyId.padEnd(idWidth)}  ${p.displayName.padEnd(nameWidth)}  ${p.accountName}`)
  }
  console.log('\nUse "canonry ga connect <project> --property-id <id>" to select one.')
}

export async function gaSync(project: string, opts?: { days?: number; only?: string; format?: string }): Promise<void> {
  const client = getClient()
  const body: { days?: number; only?: string } = {}
  if (opts?.days) body.days = opts.days
  if (opts?.only) body.only = opts.only
  const result: GaSyncResponse = await client.gaSync(project, body)

  // Warn on stderr in BOTH formats. A `--days 500` request silently writes 90
  // days; the JSON consumer reads `clamped`/`requestedDays` off the payload,
  // but a person watching the terminal would otherwise see only a truthful
  // "Period: 90 days" with nothing to connect it to what they typed. stderr
  // keeps stdout's JSON contract byte-for-byte intact.
  if (result.clamped) {
    console.error(
      `Warning: requested ${result.requestedDays} days but synced ${result.days} — `
      + `GA4's supported sync window bounded the request. Only ${result.days} days of history were written.`,
    )
  }

  if (isMachineFormat(opts?.format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`GA4 sync complete for "${project}".`)
  if (result.syncedComponents) {
    console.log(`  Components:  ${result.syncedComponents.join(', ')}`)
  }
  console.log(`  Page rows:   ${result.rowCount}`)
  console.log(`  AI rows:     ${result.aiReferralCount}`)
  console.log(`  Social rows: ${result.socialReferralCount}`)
  console.log(`  Period:      ${result.days} days${result.clamped ? ` (requested ${result.requestedDays})` : ''}`)
  console.log(`  Synced at:   ${result.syncedAt}`)
}

export async function gaTraffic(project: string, opts?: GaRangeOptions & { limit?: number }): Promise<void> {
  const client = getClient()
  const params = rangeParams(opts, opts?.limit ? { limit: String(opts.limit) } : undefined)

  const result: GaTrafficResponse = await client.gaTraffic(project, params)

  if (isMachineFormat(opts?.format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (result.topPages.length === 0 && result.aiReferrals.length === 0 && result.aiReferralLandingPages.length === 0 && result.socialReferrals.length === 0) {
    if (!result.lastSyncedAt) {
      console.log('No GA4 traffic data. Run "canonry ga sync <project>" first.')
    } else {
      console.log(`No GA4 traffic data for the selected period.${isRangeScoped(opts) ? ' Try a wider range, or omit --window / --start / --end.' : ''}`)
    }
    return
  }

  console.log(`GA4 Traffic for "${project}"\n`)
  console.log(`  Total Sessions:          ${result.totalSessions}`)
  console.log(`  Organic Sessions:        ${result.totalOrganicSessions}`)
  console.log(`  Total Users:             ${result.totalUsers ?? 'unavailable for this range'}`)
  if (result.aiSessionsDeduped > 0) {
    console.log(`  AI Sessions (deduped):   ${result.aiSessionsDeduped} (${result.aiSharePctDisplay} of total)`)
    if (result.paidAiSessionsDeduped > 0) {
      console.log(`    Paid AI:               ${result.paidAiSessionsDeduped} (${result.paidAiSharePctDisplay} of total)`)
    }
  }
  console.log()

  if (result.aiReferrals.length > 0) {
    const attrWidth = 12
    const classWidth = 8
    // Sessions only. GA counts users DISTINCT at the grain it was asked for,
    // so these rows carry no user figure to print.
    console.log('  AI REFERRAL SOURCES')
    console.log(`  ${'SOURCE'.padEnd(25)}  ${'MEDIUM'.padEnd(15)}  ${'CLASS'.padEnd(classWidth)}  ${'ATTRIBUTION'.padEnd(attrWidth)}  ${'SESSIONS'.padEnd(10)}`)
    console.log(`  ${'─'.repeat(25)}  ${'─'.repeat(15)}  ${'─'.repeat(classWidth)}  ${'─'.repeat(attrWidth)}  ${'─'.repeat(10)}`)

    for (const ref of result.aiReferrals) {
      const dimLabel = ref.sourceDimension === 'first_user' ? 'first-visit' : ref.sourceDimension === 'manual_utm' ? 'utm' : 'session'
      const classLabel = ref.trafficClass === 'paid' ? 'paid' : 'organic'
      console.log(
        `  ${ref.source.padEnd(25)}  ${ref.medium.padEnd(15)}  ${classLabel.padEnd(classWidth)}  ${dimLabel.padEnd(attrWidth)}  ${String(ref.sessions).padEnd(10)}`,
      )
    }
    console.log()
  }

  if (result.aiReferralLandingPages.length > 0) {
    const attrWidth = 12
    console.log('  AI REFERRAL LANDING PAGES')
    console.log(`  ${'LANDING PAGE'.padEnd(30)}  ${'SOURCE'.padEnd(25)}  ${'ATTRIBUTION'.padEnd(attrWidth)}  ${'SESSIONS'.padEnd(10)}`)
    console.log(`  ${'─'.repeat(30)}  ${'─'.repeat(25)}  ${'─'.repeat(attrWidth)}  ${'─'.repeat(10)}`)

    for (const row of result.aiReferralLandingPages) {
      const dimLabel = row.sourceDimension === 'first_user' ? 'first-visit' : row.sourceDimension === 'manual_utm' ? 'utm' : 'session'
      const page = row.landingPage.length > 30 ? row.landingPage.slice(0, 27) + '...' : row.landingPage
      const source = row.source.length > 25 ? row.source.slice(0, 22) + '...' : row.source
      console.log(
        `  ${page.padEnd(30)}  ${source.padEnd(25)}  ${dimLabel.padEnd(attrWidth)}  ${String(row.sessions).padEnd(10)}`,
      )
    }
    console.log()
  }

  if (result.socialReferrals.length > 0) {
    const chanWidth = 12
    if (result.socialSessions > 0) {
      console.log(`  Social Sessions:         ${result.socialSessions} (${result.socialSharePctDisplay} of total)`)
    }
    console.log('  SOCIAL REFERRAL SOURCES')
    console.log(`  ${'SOURCE'.padEnd(25)}  ${'MEDIUM'.padEnd(15)}  ${'CHANNEL'.padEnd(chanWidth)}  ${'SESSIONS'.padEnd(10)}`)
    console.log(`  ${'─'.repeat(25)}  ${'─'.repeat(15)}  ${'─'.repeat(chanWidth)}  ${'─'.repeat(10)}`)

    for (const ref of result.socialReferrals) {
      const chanLabel = ref.channelGroup === 'Paid Social' ? 'paid' : 'organic'
      console.log(
        `  ${ref.source.padEnd(25)}  ${ref.medium.padEnd(15)}  ${chanLabel.padEnd(chanWidth)}  ${String(ref.sessions).padEnd(10)}`,
      )
    }
    console.log()
  }

  if (result.topPages.length > 0) {
    const pageWidth = Math.min(60, Math.max(15, ...result.topPages.map((r) => r.landingPage.length)))
    console.log(`  TOP LANDING PAGES`)
    console.log(`  ${'PAGE'.padEnd(pageWidth)}  ${'SESSIONS'.padEnd(10)}${'ORGANIC'.padEnd(10)}`)
    console.log(`  ${'─'.repeat(pageWidth)}  ${'─'.repeat(10)}${'─'.repeat(10)}`)

    for (const row of result.topPages) {
      const page = row.landingPage.length > pageWidth ? row.landingPage.slice(0, pageWidth - 3) + '...' : row.landingPage
      console.log(
        `  ${page.padEnd(pageWidth)}  ${String(row.sessions).padEnd(10)}${String(row.organicSessions).padEnd(10)}`,
      )
    }
  }

  if (result.lastSyncedAt) {
    console.log(`\n  Last synced: ${result.lastSyncedAt}`)
  }
}

export async function gaMeasurementAnalysis(project: string, opts?: {
  window?: string
  hostScope?: string
  pathPrefix?: string
  limit?: number
  format?: string
}): Promise<void> {
  const client = getClient()
  const params: Record<string, string> = {}
  if (opts?.window) params.window = opts.window
  if (opts?.hostScope) params.hostScope = opts.hostScope
  if (opts?.pathPrefix) params.pathPrefix = opts.pathPrefix
  if (opts?.limit) params.limit = String(opts.limit)
  const result: GaMeasurementAnalysisDto = await client.gaMeasurementAnalysis(
    project,
    Object.keys(params).length > 0 ? params : undefined,
  )

  if (isMachineFormat(opts?.format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`GA4 Measurement Analysis for "${project}" (${result.window})\n`)
  console.log(`  Acquisition: ${result.acquisition.status}`)
  if (result.acquisition.error) console.log(`    Error: ${result.acquisition.error}`)
  for (const period of result.acquisition.periods) {
    console.log(`    ${period.label.padEnd(8)} ${period.sessions} sessions  ${period.startDate} to ${period.endDate}`)
  }
  if (result.acquisition.channels.length > 0) {
    console.log('  Native channels (latest cohort)')
    for (const channel of result.acquisition.channels) {
      console.log(`    ${channel.channelGroup}: ${channel.periods.at(-1)?.sessions ?? 0}`)
    }
  }

  console.log(`  Leads: ${result.leads.status}${result.leads.attributionScope ? ` (${result.leads.attributionScope} attribution)` : ''}`)
  if (result.leads.error) console.log(`    Error: ${result.leads.error}`)
  for (const period of result.leads.periods) {
    console.log(`    ${period.label.padEnd(8)} ${period.eventCount} leads  ${period.startDate} to ${period.endDate}`)
  }

  console.log(`  Search demand: ${result.searchDemand.status}`)
  for (const period of result.searchDemand.periods) {
    console.log(`    ${period.label.padEnd(8)} ${period.propertyClicks} clicks / ${period.propertyImpressions} impressions  (${period.brandedClicks} branded clicks / ${period.brandedImpressions} branded impressions; ${period.nonBrandedClicks} reported non-brand clicks / ${period.nonBrandedImpressions} reported non-brand impressions; ${period.unreportedClicks} unreported clicks / ${period.unreportedImpressions} unreported impressions)`)
  }
  if (!result.leads.hostAndPathFiltersApplied && result.leads.attributionScope === 'channel') {
    console.log('  Note: lead attribution is channel-level; host and path filters do not apply to leads.')
  }
}

export async function gaAiReferralHistory(project: string, opts?: GaRangeOptions): Promise<void> {
  const client = getClient()
  const result: GA4AiReferralHistoryEntry[] = await client.gaAiReferralHistory(project, rangeParams(opts))

  if (opts?.format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  } else if (opts?.format === 'jsonl') {
    // One self-contained referral-day per line; prepend the envelope context
    // (project + the range asked for) so a line lifted out still says what it covers.
    emitJsonl(result.map(row => ({ project, window: opts?.window, startDate: opts?.startDate, endDate: opts?.endDate, ...row })))
    return
  }

  if (result.length === 0) {
    console.log(`No AI referral history.${isRangeScoped(opts) ? ' Try a wider range, or omit --window / --start / --end.' : ' Run "canonry ga sync <project>" first.'}`)
    return
  }

  const dateWidth = 12
  const sourceWidth = Math.min(30, Math.max(10, ...result.map((r) => r.source.length)))
  const attrWidth = 12
  console.log(`GA4 AI Referral History for "${project}":\n`)
  console.log(`  ${'DATE'.padEnd(dateWidth)}  ${'SOURCE'.padEnd(sourceWidth)}  ${'ATTRIBUTION'.padEnd(attrWidth)}  ${'SESSIONS'.padEnd(10)}`)
  console.log(`  ${'─'.repeat(dateWidth)}  ${'─'.repeat(sourceWidth)}  ${'─'.repeat(attrWidth)}  ${'─'.repeat(10)}`)
  for (const row of result) {
    const dimLabel = row.sourceDimension === 'first_user' ? 'first-visit' : row.sourceDimension === 'manual_utm' ? 'utm' : 'session'
    console.log(
      `  ${row.date.padEnd(dateWidth)}  ${row.source.padEnd(sourceWidth)}  ${dimLabel.padEnd(attrWidth)}  ${String(row.sessions).padEnd(10)}`,
    )
  }
}

export async function gaAiReferralDaily(project: string, opts?: GaRangeOptions): Promise<void> {
  const client = getClient()
  const result: GA4AiReferralDailyDto = await client.gaAiReferralDaily(project, rangeParams(opts))

  if (opts?.format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  } else if (opts?.format === 'jsonl') {
    // One self-contained day per line; prepend the envelope context (project +
    // the range asked for) so a line lifted out still says what it covers.
    emitJsonl(result.days.map(day => ({ project, window: opts?.window, startDate: opts?.startDate, endDate: opts?.endDate, ...day })))
    return
  }

  if (result.days.length === 0) {
    console.log(`No AI referral sessions.${isRangeScoped(opts) ? ' Try a wider range, or omit --window / --start / --end.' : ' Run "canonry ga sync <project>" first.'}`)
    return
  }

  // Sessions only. GA counts users DISTINCT at the grain it was asked for, and
  // these rows are keyed down to the landing page, so there is no user count
  // that can be added up truthfully here. See ga4AiReferralDailyDtoSchema.
  const dateWidth = 12
  const sourceWidth = Math.min(30, Math.max(10, ...result.sources.map((s) => s.length)))
  console.log(`GA4 AI Referral Sessions per Day for "${project}":\n`)
  console.log(`  ${'DATE'.padEnd(dateWidth)}  ${'SOURCE'.padEnd(sourceWidth)}  ${'SESSIONS'.padEnd(10)}${'PAID'.padEnd(8)}${'ORGANIC'.padEnd(9)}`)
  console.log(`  ${'─'.repeat(dateWidth)}  ${'─'.repeat(sourceWidth)}  ${'─'.repeat(10)}${'─'.repeat(8)}${'─'.repeat(9)}`)
  for (const day of result.days) {
    for (const entry of day.bySource) {
      console.log(
        `  ${day.date.padEnd(dateWidth)}  ${entry.source.padEnd(sourceWidth)}  ${String(entry.sessions).padEnd(10)}${String(entry.paidSessions).padEnd(8)}${String(entry.organicSessions).padEnd(9)}`,
      )
    }
  }
  console.log(`\n  Total: ${result.totalSessions} sessions (${result.totalPaidSessions} paid, ${result.totalOrganicSessions} organic)`)
}

export async function gaSocialReferralHistory(project: string, opts?: GaRangeOptions): Promise<void> {
  const client = getClient()
  const result: GA4SocialReferralHistoryEntry[] = await client.gaSocialReferralHistory(project, rangeParams(opts))

  if (opts?.format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  } else if (opts?.format === 'jsonl') {
    // One self-contained referral-day per line; prepend the envelope context
    // (project + the range asked for) so a line lifted out still says what it covers.
    emitJsonl(result.map(row => ({ project, window: opts?.window, startDate: opts?.startDate, endDate: opts?.endDate, ...row })))
    return
  }

  if (result.length === 0) {
    console.log(`No social referral history.${isRangeScoped(opts) ? ' Try a wider range, or omit --window / --start / --end.' : ' Run "canonry ga sync <project>" first.'}`)
    return
  }

  const dateWidth = 12
  const sourceWidth = Math.min(30, Math.max(10, ...result.map((r) => r.source.length)))
  const chanWidth = 12
  console.log(`GA4 Social Referral History for "${project}":\n`)
  console.log(`  ${'DATE'.padEnd(dateWidth)}  ${'SOURCE'.padEnd(sourceWidth)}  ${'CHANNEL'.padEnd(chanWidth)}  ${'SESSIONS'.padEnd(10)}${'USERS'.padEnd(8)}`)
  console.log(`  ${'─'.repeat(dateWidth)}  ${'─'.repeat(sourceWidth)}  ${'─'.repeat(chanWidth)}  ${'─'.repeat(10)}${'─'.repeat(8)}`)
  for (const row of result) {
    const chanLabel = row.channelGroup === 'Paid Social' ? 'paid' : 'organic'
    console.log(
      `  ${row.date.padEnd(dateWidth)}  ${row.source.padEnd(sourceWidth)}  ${chanLabel.padEnd(chanWidth)}  ${String(row.sessions).padEnd(10)}${String(row.users).padEnd(8)}`,
    )
  }
}

export async function gaSessionHistory(project: string, opts?: GaRangeOptions): Promise<void> {
  const client = getClient()
  const result: GA4SessionHistoryEntry[] = await client.gaSessionHistory(project, rangeParams(opts))

  if (opts?.format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  } else if (opts?.format === 'jsonl') {
    // One self-contained session-day per line; prepend the envelope context
    // (project + the range asked for) so a line lifted out still says what it covers.
    emitJsonl(result.map(row => ({ project, window: opts?.window, startDate: opts?.startDate, endDate: opts?.endDate, ...row })))
    return
  }

  if (result.length === 0) {
    console.log(`No session history.${isRangeScoped(opts) ? ' Try a wider range, or omit --window / --start / --end.' : ' Run "canonry ga sync <project>" first.'}`)
    return
  }

  const dateWidth = 12
  console.log(`GA4 Session History for "${project}":\n`)
  console.log(`  ${'DATE'.padEnd(dateWidth)}  ${'SESSIONS'.padEnd(10)}${'ORGANIC'.padEnd(10)}${'USERS'.padEnd(8)}`)
  console.log(`  ${'─'.repeat(dateWidth)}  ${'─'.repeat(10)}${'─'.repeat(10)}${'─'.repeat(8)}`)
  for (const row of result) {
    // Mark days whose user count is the older per-page sum so a mixed series
    // never reads as one consistent measurement.
    const users = row.usersSource === 'deduplicated' ? String(row.users) : `${row.users}*`
    console.log(
      `  ${row.date.padEnd(dateWidth)}  ${String(row.sessions).padEnd(10)}${String(row.organicSessions).padEnd(10)}${users.padEnd(8)}`,
    )
  }
  if (result.some((row) => row.usersSource !== 'deduplicated')) {
    console.log('\n  * Visitor count is approximate — it adds up each page a visitor landed on,')
    console.log('    so someone who read several pages is counted more than once. Run')
    console.log(`    "canonry ga sync ${project}" to replace these with exact counts.`)
  }
}

export async function gaCoverage(project: string, format?: string): Promise<void> {
  const client = getClient()
  const result: GaCoverageResponse = await client.gaCoverage(project)

  if (format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  } else if (format === 'jsonl') {
    // One self-contained page per line; prepend `project` so a line lifted out
    // of the envelope still says which project it covers.
    emitJsonl(result.pages.map(row => ({ project, ...row })))
    return
  }

  if (result.pages.length === 0) {
    console.log('No GA4 coverage data. Run "canonry ga sync <project>" first.')
    return
  }

  console.log(`GA4 Page Coverage (${result.pages.length} pages with traffic):\n`)

  const pageWidth = Math.min(60, Math.max(15, ...result.pages.map((r) => r.landingPage.length)))
  console.log(`  ${'LANDING PAGE'.padEnd(pageWidth)}  ${'SESSIONS'.padEnd(10)}${'ORGANIC'.padEnd(10)}${'USERS'.padEnd(8)}`)
  console.log(`  ${'─'.repeat(pageWidth)}  ${'─'.repeat(10)}${'─'.repeat(10)}${'─'.repeat(8)}`)

  for (const row of result.pages) {
    const page = row.landingPage.length > pageWidth ? row.landingPage.slice(0, pageWidth - 3) + '...' : row.landingPage
    console.log(
      `  ${page.padEnd(pageWidth)}  ${String(row.sessions).padEnd(10)}${String(row.organicSessions).padEnd(10)}${String(row.users).padEnd(8)}`,
    )
  }
}

/**
 * A server trend or mover change, a 0..100 relative change (`15` = +15%), with
 * its sign; `n/a` when there was no prior period to compare.
 */
function fmtTrend(pct: number | null): string {
  return pct === null ? 'n/a' : `${pct >= 0 ? '+' : ''}${formatPercent(pct, 'percent')}`
}

/**
 * The one line that makes every percentage below it readable.
 *
 * Printed ABOVE the numbers, never as a footer: a reader who meets "Direct 69%"
 * first has already formed a view of the business by the time a trailing line
 * tells them what period it covers. Returns null only when the window is
 * genuinely open-ended, in which case there is no span to state.
 */
function windowLine(traffic: GaTrafficResponse): string | null {
  if (!traffic.windowStart || !traffic.windowEnd) return null
  const span = traffic.windowDays === null ? '' : ` (${traffic.windowDays} days)`
  return `  Window: ${traffic.windowStart} to ${traffic.windowEnd}${span}`
}

export async function gaSocialReferralSummary(project: string, opts?: { trend?: boolean; format?: string }): Promise<void> {
  const client = getClient()
  const traffic: GaTrafficResponse = await client.gaTraffic(project)

  if (opts?.trend) {
    const trend: GaSocialReferralTrendResponse = await client.gaSocialReferralTrend(project)
    if (isMachineFormat(opts.format)) {
      console.log(JSON.stringify({
        socialSessions: traffic.socialSessions,
        totalSessions: traffic.totalSessions,
        socialSharePct: traffic.socialSharePct,
        windowStart: traffic.windowStart,
        windowEnd: traffic.windowEnd,
        windowDays: traffic.windowDays,
        topSources: traffic.socialReferrals.slice(0, 5).map((r) => ({ source: r.source, sessions: r.sessions, channel: r.channelGroup })),
        trend: trend,
      }, null, 2))
      return
    }

    console.log(`Social Traffic Summary for "${project}"\n`)
    const trendWindow = windowLine(traffic)
    if (trendWindow) console.log(`${trendWindow}\n`)
    console.log(`  Sessions: ${traffic.socialSessions} (${traffic.socialSharePctDisplay} of ${traffic.totalSessions} total)`)
    console.log()

    console.log(`  7d trend:  ${fmtTrend(trend.trend7dPct)} (${trend.socialSessions7d} vs ${trend.socialSessionsPrev7d})`)
    console.log(`  30d trend: ${fmtTrend(trend.trend30dPct)} (${trend.socialSessions30d} vs ${trend.socialSessionsPrev30d})`)
    if (trend.biggestMover) {
      const m = trend.biggestMover
      console.log(`  Mover:     ${m.source} (${fmtTrend(m.changePct)}, ${m.sessionsPrev7d}→${m.sessions7d})`)
    }
    console.log()

    if (traffic.socialReferrals.length > 0) {
      console.log('  TOP SOURCES')
      for (const ref of traffic.socialReferrals.slice(0, 5)) {
        const chanLabel = ref.channelGroup === 'Paid Social' ? 'paid' : 'organic'
        console.log(`    ${ref.source.padEnd(20)} ${String(ref.sessions).padEnd(8)} sessions  (${chanLabel})`)
      }
    }
    return
  }

  if (isMachineFormat(opts?.format)) {
    console.log(JSON.stringify({
      socialSessions: traffic.socialSessions,
      totalSessions: traffic.totalSessions,
      socialSharePct: traffic.socialSharePct,
      windowStart: traffic.windowStart,
      windowEnd: traffic.windowEnd,
      windowDays: traffic.windowDays,
      topSources: traffic.socialReferrals.slice(0, 5).map((r) => ({ source: r.source, sessions: r.sessions, channel: r.channelGroup })),
    }, null, 2))
    return
  }

  console.log(`Social Traffic Summary for "${project}"\n`)
  const socialWindow = windowLine(traffic)
  if (socialWindow) console.log(`${socialWindow}\n`)
  console.log(`  Sessions: ${traffic.socialSessions} (${traffic.socialSharePctDisplay} of ${traffic.totalSessions} total)`)
  if (traffic.socialReferrals.length > 0) {
    console.log()
    console.log('  TOP SOURCES')
    for (const ref of traffic.socialReferrals.slice(0, 5)) {
      const chanLabel = ref.channelGroup === 'Paid Social' ? 'paid' : 'organic'
      console.log(`    ${ref.source.padEnd(20)} ${String(ref.sessions).padEnd(8)} sessions  (${chanLabel})`)
    }
  }
}

export async function gaAttribution(project: string, opts?: { trend?: boolean; format?: string }): Promise<void> {
  const client = getClient()
  const traffic: GaTrafficResponse = await client.gaTraffic(project)

  if (opts?.trend) {
    const trend: GaAttributionTrendResponse = await client.gaAttributionTrend(project)

    if (isMachineFormat(opts.format)) {
      console.log(JSON.stringify({
        totalSessions: traffic.totalSessions,
        totalUsers: traffic.totalUsers,
        organicSessions: traffic.totalOrganicSessions,
        aiSessions: traffic.aiSessionsDeduped,
        paidAiSessions: traffic.paidAiSessionsDeduped,
        organicAiSessions: traffic.organicAiSessionsDeduped,
        aiSessionsBySession: traffic.aiSessionsBySession,
        paidAiSessionsBySession: traffic.paidAiSessionsBySession,
        organicAiSessionsBySession: traffic.organicAiSessionsBySession,
        socialSessions: traffic.socialSessions,
        directSessions: traffic.totalDirectSessions,
        aiSharePct: traffic.aiSharePct,
        aiSharePctBySession: traffic.aiSharePctBySession,
        paidAiSharePct: traffic.paidAiSharePct,
        paidAiSharePctBySession: traffic.paidAiSharePctBySession,
        organicAiSharePct: traffic.organicAiSharePct,
        organicAiSharePctBySession: traffic.organicAiSharePctBySession,
        socialSharePct: traffic.socialSharePct,
        organicSharePct: traffic.organicSharePct,
        directSharePct: traffic.directSharePct,
        organicSharePctDisplay: traffic.organicSharePctDisplay,
        aiSharePctDisplay: traffic.aiSharePctDisplay,
        aiSharePctBySessionDisplay: traffic.aiSharePctBySessionDisplay,
        paidAiSharePctDisplay: traffic.paidAiSharePctDisplay,
        paidAiSharePctBySessionDisplay: traffic.paidAiSharePctBySessionDisplay,
        organicAiSharePctDisplay: traffic.organicAiSharePctDisplay,
        organicAiSharePctBySessionDisplay: traffic.organicAiSharePctBySessionDisplay,
        socialSharePctDisplay: traffic.socialSharePctDisplay,
        directSharePctDisplay: traffic.directSharePctDisplay,
        otherSessions: traffic.otherSessions,
        otherSharePct: traffic.otherSharePct,
        otherSharePctDisplay: traffic.otherSharePctDisplay,
        channelBreakdown: traffic.channelBreakdown,
        aiReferrals: traffic.aiReferrals,
        aiReferralLandingPages: traffic.aiReferralLandingPages,
        socialReferrals: traffic.socialReferrals,
        windowStart: traffic.windowStart,
        windowEnd: traffic.windowEnd,
        windowDays: traffic.windowDays,
        trend,
      }, null, 2))
      return
    }

    if (traffic.totalSessions === 0) {
      console.log('No GA4 traffic data. Run "canonry ga sync <project>" first.')
      return
    }

    console.log(`GA4 Attribution Overview for "${project}"\n`)
    const trendWindow = windowLine(traffic)
    if (trendWindow) console.log(`${trendWindow}\n`)
    console.log(`  Total Sessions:   ${traffic.totalSessions}`)
    console.log(`  Total Users:      ${traffic.totalUsers ?? 'unavailable for this range'}`)
    console.log()
    // Share cells are six wide, the widest formatPercent value (`>99.9%`), so every row
    // starts its trend columns under these headings, the Total row included.
    console.log(`  CHANNEL BREAKDOWN${' '.repeat(20)}7d trend     30d trend`)
    console.log(`    Organic Search: ${String(traffic.channelBreakdown.organic.sessions).padEnd(6)} (${traffic.channelBreakdown.organic.sharePctDisplay.padStart(6)})    ${fmtTrend(trend.organic.trend7dPct).padEnd(12)} ${fmtTrend(trend.organic.trend30dPct)}`)
    console.log(`    Social:         ${String(traffic.channelBreakdown.social.sessions).padEnd(6)} (${traffic.channelBreakdown.social.sharePctDisplay.padStart(6)})    ${fmtTrend(trend.social.trend7dPct).padEnd(12)} ${fmtTrend(trend.social.trend30dPct)}`)
    console.log(`    Direct:         ${String(traffic.channelBreakdown.direct.sessions).padEnd(6)} (${traffic.channelBreakdown.direct.sharePctDisplay.padStart(6)})    ${fmtTrend(trend.direct.trend7dPct).padEnd(12)} ${fmtTrend(trend.direct.trend30dPct)}`)
    console.log(`    AI Referrals:   ${String(traffic.channelBreakdown.ai.sessions).padEnd(6)} (${traffic.channelBreakdown.ai.sharePctDisplay.padStart(6)})    ${fmtTrend(trend.ai.trend7dPct).padEnd(12)} ${fmtTrend(trend.ai.trend30dPct)}  (lower bound — sessionSource only; referrer-stripped traffic falls under Direct)`)
    if (traffic.paidAiSessionsBySession > 0) {
      console.log(`      Paid AI:      ${String(traffic.paidAiSessionsBySession).padEnd(6)} (${traffic.paidAiSharePctBySessionDisplay.padStart(6)})`)
    }
    console.log(`    Other:          ${String(traffic.channelBreakdown.other.sessions).padEnd(6)} (${traffic.channelBreakdown.other.sharePctDisplay.padStart(6)})`)
    console.log(`    ─────────────────────────────────────────────────────`)
    console.log(`    Total:          ${String(traffic.totalSessions).padEnd(6)}${' '.repeat(13)}${fmtTrend(trend.total.trend7dPct).padEnd(12)} ${fmtTrend(trend.total.trend30dPct)}`)

    if (trend.aiBiggestMover) {
      const m = trend.aiBiggestMover
      console.log(`\n  AI Mover:     ${m.source} (${fmtTrend(m.changePct)}, ${m.sessionsPrev7d}→${m.sessions7d} sessions/7d)`)
    }
    if (trend.socialBiggestMover) {
      const m = trend.socialBiggestMover
      console.log(`  Social Mover: ${m.source} (${fmtTrend(m.changePct)}, ${m.sessionsPrev7d}→${m.sessions7d} sessions/7d)`)
    }

    if (traffic.lastSyncedAt) {
      console.log(`\n  Last synced: ${traffic.lastSyncedAt}`)
    }
    return
  }

  if (isMachineFormat(opts?.format)) {
    console.log(JSON.stringify({
      totalSessions: traffic.totalSessions,
      totalUsers: traffic.totalUsers,
      organicSessions: traffic.totalOrganicSessions,
      aiSessions: traffic.aiSessionsDeduped,
      paidAiSessions: traffic.paidAiSessionsDeduped,
      organicAiSessions: traffic.organicAiSessionsDeduped,
      aiSessionsBySession: traffic.aiSessionsBySession,
      paidAiSessionsBySession: traffic.paidAiSessionsBySession,
      organicAiSessionsBySession: traffic.organicAiSessionsBySession,
      socialSessions: traffic.socialSessions,
      directSessions: traffic.totalDirectSessions,
      aiSharePct: traffic.aiSharePct,
      aiSharePctBySession: traffic.aiSharePctBySession,
      paidAiSharePct: traffic.paidAiSharePct,
      paidAiSharePctBySession: traffic.paidAiSharePctBySession,
      organicAiSharePct: traffic.organicAiSharePct,
      organicAiSharePctBySession: traffic.organicAiSharePctBySession,
      socialSharePct: traffic.socialSharePct,
      organicSharePct: traffic.organicSharePct,
      directSharePct: traffic.directSharePct,
      organicSharePctDisplay: traffic.organicSharePctDisplay,
      aiSharePctDisplay: traffic.aiSharePctDisplay,
      aiSharePctBySessionDisplay: traffic.aiSharePctBySessionDisplay,
      paidAiSharePctDisplay: traffic.paidAiSharePctDisplay,
      paidAiSharePctBySessionDisplay: traffic.paidAiSharePctBySessionDisplay,
      organicAiSharePctDisplay: traffic.organicAiSharePctDisplay,
      organicAiSharePctBySessionDisplay: traffic.organicAiSharePctBySessionDisplay,
      socialSharePctDisplay: traffic.socialSharePctDisplay,
      directSharePctDisplay: traffic.directSharePctDisplay,
      otherSessions: traffic.otherSessions,
      otherSharePct: traffic.otherSharePct,
      otherSharePctDisplay: traffic.otherSharePctDisplay,
      channelBreakdown: traffic.channelBreakdown,
      aiReferrals: traffic.aiReferrals,
      aiReferralLandingPages: traffic.aiReferralLandingPages,
      socialReferrals: traffic.socialReferrals,
      windowStart: traffic.windowStart,
      windowEnd: traffic.windowEnd,
      windowDays: traffic.windowDays,
      periodStart: traffic.periodStart,
      periodEnd: traffic.periodEnd,
    }, null, 2))
    return
  }

  if (traffic.totalSessions === 0) {
    console.log('No GA4 traffic data. Run "canonry ga sync <project>" first.')
    return
  }

  console.log(`GA4 Attribution Overview for "${project}"\n`)
  const attributionWindow = windowLine(traffic)
  if (attributionWindow) console.log(`${attributionWindow}\n`)
  console.log(`  Total Sessions:   ${traffic.totalSessions}`)
  console.log(`  Total Users:      ${traffic.totalUsers ?? 'unavailable for this range'}`)
  console.log()
  console.log('  CHANNEL BREAKDOWN')
  console.log(`    Organic Search: ${traffic.channelBreakdown.organic.sessions} sessions (${traffic.channelBreakdown.organic.sharePctDisplay})`)
  console.log(`    Social:         ${traffic.channelBreakdown.social.sessions} sessions (${traffic.channelBreakdown.social.sharePctDisplay})`)
  console.log(`    Direct:         ${traffic.channelBreakdown.direct.sessions} sessions (${traffic.channelBreakdown.direct.sharePctDisplay})`)
  console.log(`    AI Referrals:   ${traffic.channelBreakdown.ai.sessions} sessions (${traffic.channelBreakdown.ai.sharePctDisplay})  (lower bound — sessionSource only; referrer-stripped traffic falls under Direct)`)
  if (traffic.paidAiSessionsBySession > 0) {
    console.log(`      Paid AI:      ${traffic.paidAiSessionsBySession} sessions (${traffic.paidAiSharePctBySessionDisplay})`)
  }
  console.log(`    Other:          ${traffic.channelBreakdown.other.sessions} sessions (${traffic.channelBreakdown.other.sharePctDisplay})`)

  if (traffic.aiReferrals.length > 0) {
    console.log()
    console.log('  AI SOURCES')
    for (const ref of traffic.aiReferrals.slice(0, 10)) {
      const dimLabel = ref.sourceDimension === 'first_user' ? 'first-visit' : ref.sourceDimension === 'manual_utm' ? 'utm' : 'session'
      const classLabel = ref.trafficClass === 'paid' ? 'paid' : 'organic'
      console.log(`    ${ref.source.padEnd(25)} ${String(ref.sessions).padEnd(8)} sessions  (${classLabel}, ${dimLabel})`)
    }
  }

  if (traffic.aiReferralLandingPages.length > 0) {
    console.log()
    console.log('  AI LANDING PAGES')
    for (const row of traffic.aiReferralLandingPages.slice(0, 10)) {
      const dimLabel = row.sourceDimension === 'first_user' ? 'first-visit' : row.sourceDimension === 'manual_utm' ? 'utm' : 'session'
      const page = row.landingPage.length > 30 ? row.landingPage.slice(0, 27) + '...' : row.landingPage
      const source = row.source.length > 22 ? row.source.slice(0, 19) + '...' : row.source
      console.log(`    ${page.padEnd(30)} ${source.padEnd(22)} ${String(row.sessions).padEnd(8)} sessions  (${dimLabel})`)
    }
  }

  if (traffic.socialReferrals.length > 0) {
    console.log()
    console.log('  SOCIAL SOURCES')
    for (const ref of traffic.socialReferrals.slice(0, 10)) {
      const chanLabel = ref.channelGroup === 'Paid Social' ? 'paid' : 'organic'
      console.log(`    ${ref.source.padEnd(25)} ${String(ref.sessions).padEnd(8)} sessions  (${chanLabel})`)
    }
  }

  if (traffic.lastSyncedAt) {
    console.log(`\n  Last synced: ${traffic.lastSyncedAt}`)
  }
}
