import type { GaConnectResponse, GaStatusResponse, GaSyncResponse, GaTrafficResponse, GaCoverageResponse, GaSocialReferralTrendResponse, GaAttributionTrendResponse, GA4AiReferralHistoryEntry, GA4SessionHistoryEntry, GA4SocialReferralHistoryEntry } from '@ainyc/canonry-contracts'
import { createApiClient } from '../client.js'
import { CliError } from '../cli-error.js'

function getClient() {
  return createApiClient()
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
      const msg = e instanceof Error ? e.message : String(e)
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

  if (opts.format === 'json') {
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

  if (format === 'json') {
    console.log(JSON.stringify({ project, disconnected: true }, null, 2))
    return
  }

  console.log(`GA4 disconnected from project "${project}".`)
}

export async function gaStatus(project: string, format?: string): Promise<void> {
  const client = getClient()
  const result: GaStatusResponse = await client.gaStatus(project)

  if (format === 'json') {
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

export async function gaSync(project: string, opts?: { days?: number; only?: string; format?: string }): Promise<void> {
  const client = getClient()
  const body: { days?: number; only?: string } = {}
  if (opts?.days) body.days = opts.days
  if (opts?.only) body.only = opts.only
  const result: GaSyncResponse = await client.gaSync(project, body)

  if (opts?.format === 'json') {
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
  console.log(`  Period:      ${result.days} days`)
  console.log(`  Synced at:   ${result.syncedAt}`)
}

export async function gaTraffic(project: string, opts?: { limit?: number; window?: string; format?: string }): Promise<void> {
  const client = getClient()
  const params: Record<string, string> = {}
  if (opts?.limit) params.limit = String(opts.limit)
  if (opts?.window) params.window = opts.window

  const result: GaTrafficResponse = await client.gaTraffic(project, Object.keys(params).length > 0 ? params : undefined)

  if (opts?.format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (result.topPages.length === 0 && result.aiReferrals.length === 0 && result.aiReferralLandingPages.length === 0 && result.socialReferrals.length === 0) {
    if (!result.lastSyncedAt) {
      console.log('No GA4 traffic data. Run "canonry ga sync <project>" first.')
    } else {
      console.log(`No GA4 traffic data for the selected period.${opts?.window ? ` Try a wider window or omit --window.` : ''}`)
    }
    return
  }

  console.log(`GA4 Traffic for "${project}"\n`)
  console.log(`  Total Sessions:          ${result.totalSessions}`)
  console.log(`  Organic Sessions:        ${result.totalOrganicSessions}`)
  console.log(`  Total Users:             ${result.totalUsers}`)
  if (result.aiSessionsDeduped > 0) {
    const share = result.totalSessions > 0 ? Math.round((result.aiSessionsDeduped / result.totalSessions) * 100) : 0
    console.log(`  AI Sessions (deduped):   ${result.aiSessionsDeduped} (${share}% of total)`)
  }
  console.log()

  if (result.aiReferrals.length > 0) {
    const attrWidth = 12
    console.log('  AI REFERRAL SOURCES')
    console.log(`  ${'SOURCE'.padEnd(25)}  ${'MEDIUM'.padEnd(15)}  ${'ATTRIBUTION'.padEnd(attrWidth)}  ${'SESSIONS'.padEnd(10)}${'USERS'.padEnd(8)}`)
    console.log(`  ${'─'.repeat(25)}  ${'─'.repeat(15)}  ${'─'.repeat(attrWidth)}  ${'─'.repeat(10)}${'─'.repeat(8)}`)

    for (const ref of result.aiReferrals) {
      const dimLabel = ref.sourceDimension === 'first_user' ? 'first-visit' : ref.sourceDimension === 'manual_utm' ? 'utm' : 'session'
      console.log(
        `  ${ref.source.padEnd(25)}  ${ref.medium.padEnd(15)}  ${dimLabel.padEnd(attrWidth)}  ${String(ref.sessions).padEnd(10)}${String(ref.users).padEnd(8)}`,
      )
    }
    console.log()
  }

  if (result.aiReferralLandingPages.length > 0) {
    const attrWidth = 12
    console.log('  AI REFERRAL LANDING PAGES')
    console.log(`  ${'LANDING PAGE'.padEnd(30)}  ${'SOURCE'.padEnd(25)}  ${'ATTRIBUTION'.padEnd(attrWidth)}  ${'SESSIONS'.padEnd(10)}${'USERS'.padEnd(8)}`)
    console.log(`  ${'─'.repeat(30)}  ${'─'.repeat(25)}  ${'─'.repeat(attrWidth)}  ${'─'.repeat(10)}${'─'.repeat(8)}`)

    for (const row of result.aiReferralLandingPages) {
      const dimLabel = row.sourceDimension === 'first_user' ? 'first-visit' : row.sourceDimension === 'manual_utm' ? 'utm' : 'session'
      const page = row.landingPage.length > 30 ? row.landingPage.slice(0, 27) + '...' : row.landingPage
      const source = row.source.length > 25 ? row.source.slice(0, 22) + '...' : row.source
      console.log(
        `  ${page.padEnd(30)}  ${source.padEnd(25)}  ${dimLabel.padEnd(attrWidth)}  ${String(row.sessions).padEnd(10)}${String(row.users).padEnd(8)}`,
      )
    }
    console.log()
  }

  if (result.socialReferrals.length > 0) {
    const chanWidth = 12
    if (result.socialSessions > 0) {
      const share = result.totalSessions > 0 ? Math.round((result.socialSessions / result.totalSessions) * 100) : 0
      console.log(`  Social Sessions:         ${result.socialSessions} (${share}% of total)`)
    }
    console.log('  SOCIAL REFERRAL SOURCES')
    console.log(`  ${'SOURCE'.padEnd(25)}  ${'MEDIUM'.padEnd(15)}  ${'CHANNEL'.padEnd(chanWidth)}  ${'SESSIONS'.padEnd(10)}${'USERS'.padEnd(8)}`)
    console.log(`  ${'─'.repeat(25)}  ${'─'.repeat(15)}  ${'─'.repeat(chanWidth)}  ${'─'.repeat(10)}${'─'.repeat(8)}`)

    for (const ref of result.socialReferrals) {
      const chanLabel = ref.channelGroup === 'Paid Social' ? 'paid' : 'organic'
      console.log(
        `  ${ref.source.padEnd(25)}  ${ref.medium.padEnd(15)}  ${chanLabel.padEnd(chanWidth)}  ${String(ref.sessions).padEnd(10)}${String(ref.users).padEnd(8)}`,
      )
    }
    console.log()
  }

  if (result.topPages.length > 0) {
    const pageWidth = Math.min(60, Math.max(15, ...result.topPages.map((r) => r.landingPage.length)))
    console.log(`  TOP LANDING PAGES`)
    console.log(`  ${'PAGE'.padEnd(pageWidth)}  ${'SESSIONS'.padEnd(10)}${'ORGANIC'.padEnd(10)}${'USERS'.padEnd(8)}`)
    console.log(`  ${'─'.repeat(pageWidth)}  ${'─'.repeat(10)}${'─'.repeat(10)}${'─'.repeat(8)}`)

    for (const row of result.topPages) {
      const page = row.landingPage.length > pageWidth ? row.landingPage.slice(0, pageWidth - 3) + '...' : row.landingPage
      console.log(
        `  ${page.padEnd(pageWidth)}  ${String(row.sessions).padEnd(10)}${String(row.organicSessions).padEnd(10)}${String(row.users).padEnd(8)}`,
      )
    }
  }

  if (result.lastSyncedAt) {
    console.log(`\n  Last synced: ${result.lastSyncedAt}`)
  }
}

export async function gaAiReferralHistory(project: string, opts?: { window?: string; format?: string }): Promise<void> {
  const client = getClient()
  const result: GA4AiReferralHistoryEntry[] = await client.gaAiReferralHistory(project, opts?.window ? { window: opts.window } : undefined)

  if (opts?.format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (result.length === 0) {
    console.log(`No AI referral history.${opts?.window ? ' Try a wider window or omit --window.' : ' Run "canonry ga sync <project>" first.'}`)
    return
  }

  const dateWidth = 12
  const sourceWidth = Math.min(30, Math.max(10, ...result.map((r) => r.source.length)))
  const attrWidth = 12
  console.log(`GA4 AI Referral History for "${project}":\n`)
  console.log(`  ${'DATE'.padEnd(dateWidth)}  ${'SOURCE'.padEnd(sourceWidth)}  ${'ATTRIBUTION'.padEnd(attrWidth)}  ${'SESSIONS'.padEnd(10)}${'USERS'.padEnd(8)}`)
  console.log(`  ${'─'.repeat(dateWidth)}  ${'─'.repeat(sourceWidth)}  ${'─'.repeat(attrWidth)}  ${'─'.repeat(10)}${'─'.repeat(8)}`)
  for (const row of result) {
    const dimLabel = row.sourceDimension === 'first_user' ? 'first-visit' : row.sourceDimension === 'manual_utm' ? 'utm' : 'session'
    console.log(
      `  ${row.date.padEnd(dateWidth)}  ${row.source.padEnd(sourceWidth)}  ${dimLabel.padEnd(attrWidth)}  ${String(row.sessions).padEnd(10)}${String(row.users).padEnd(8)}`,
    )
  }
}

export async function gaSocialReferralHistory(project: string, opts?: { window?: string; format?: string }): Promise<void> {
  const client = getClient()
  const result: GA4SocialReferralHistoryEntry[] = await client.gaSocialReferralHistory(project, opts?.window ? { window: opts.window } : undefined)

  if (opts?.format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (result.length === 0) {
    console.log(`No social referral history.${opts?.window ? ' Try a wider window or omit --window.' : ' Run "canonry ga sync <project>" first.'}`)
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

export async function gaSessionHistory(project: string, opts?: { window?: string; format?: string }): Promise<void> {
  const client = getClient()
  const result: GA4SessionHistoryEntry[] = await client.gaSessionHistory(project, opts?.window ? { window: opts.window } : undefined)

  if (opts?.format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (result.length === 0) {
    console.log(`No session history.${opts?.window ? ' Try a wider window or omit --window.' : ' Run "canonry ga sync <project>" first.'}`)
    return
  }

  const dateWidth = 12
  console.log(`GA4 Session History for "${project}":\n`)
  console.log(`  ${'DATE'.padEnd(dateWidth)}  ${'SESSIONS'.padEnd(10)}${'ORGANIC'.padEnd(10)}${'USERS'.padEnd(8)}`)
  console.log(`  ${'─'.repeat(dateWidth)}  ${'─'.repeat(10)}${'─'.repeat(10)}${'─'.repeat(8)}`)
  for (const row of result) {
    console.log(
      `  ${row.date.padEnd(dateWidth)}  ${String(row.sessions).padEnd(10)}${String(row.organicSessions).padEnd(10)}${String(row.users).padEnd(8)}`,
    )
  }
}

export async function gaCoverage(project: string, format?: string): Promise<void> {
  const client = getClient()
  const result: GaCoverageResponse = await client.gaCoverage(project)

  if (format === 'json') {
    console.log(JSON.stringify(result, null, 2))
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

export async function gaSocialReferralSummary(project: string, opts?: { trend?: boolean; format?: string }): Promise<void> {
  const client = getClient()
  const traffic: GaTrafficResponse = await client.gaTraffic(project)

  if (opts?.trend) {
    const trend: GaSocialReferralTrendResponse = await client.gaSocialReferralTrend(project)
    if (opts.format === 'json') {
      console.log(JSON.stringify({
        socialSessions: traffic.socialSessions,
        socialUsers: traffic.socialUsers,
        totalSessions: traffic.totalSessions,
        socialSharePct: traffic.socialSharePct,
        topSources: traffic.socialReferrals.slice(0, 5).map((r) => ({ source: r.source, sessions: r.sessions, channel: r.channelGroup })),
        trend: trend,
      }, null, 2))
      return
    }

    console.log(`Social Traffic Summary for "${project}"\n`)
    console.log(`  Sessions: ${traffic.socialSessions} (${traffic.socialSharePct}% of ${traffic.totalSessions} total)`)
    console.log(`  Users:    ${traffic.socialUsers}`)
    console.log()

    const fmtTrend = (pct: number | null) => pct === null ? 'n/a' : `${pct >= 0 ? '+' : ''}${pct}%`
    console.log(`  7d trend:  ${fmtTrend(trend.trend7dPct)} (${trend.socialSessions7d} vs ${trend.socialSessionsPrev7d})`)
    console.log(`  30d trend: ${fmtTrend(trend.trend30dPct)} (${trend.socialSessions30d} vs ${trend.socialSessionsPrev30d})`)
    if (trend.biggestMover) {
      const m = trend.biggestMover
      console.log(`  Mover:     ${m.source} (${m.changePct >= 0 ? '+' : ''}${m.changePct}%, ${m.sessionsPrev7d}→${m.sessions7d})`)
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

  if (opts?.format === 'json') {
    console.log(JSON.stringify({
      socialSessions: traffic.socialSessions,
      socialUsers: traffic.socialUsers,
      totalSessions: traffic.totalSessions,
      socialSharePct: traffic.socialSharePct,
      topSources: traffic.socialReferrals.slice(0, 5).map((r) => ({ source: r.source, sessions: r.sessions, channel: r.channelGroup })),
    }, null, 2))
    return
  }

  console.log(`Social Traffic Summary for "${project}"\n`)
  console.log(`  Sessions: ${traffic.socialSessions} (${traffic.socialSharePct}% of ${traffic.totalSessions} total)`)
  console.log(`  Users:    ${traffic.socialUsers}`)
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

  const fmtTrend = (pct: number | null) => pct === null ? 'n/a' : `${pct >= 0 ? '+' : ''}${pct}%`

  if (opts?.trend) {
    const trend: GaAttributionTrendResponse = await client.gaAttributionTrend(project)

    if (opts.format === 'json') {
      console.log(JSON.stringify({
        totalSessions: traffic.totalSessions,
        totalUsers: traffic.totalUsers,
        organicSessions: traffic.totalOrganicSessions,
        aiSessions: traffic.aiSessionsDeduped,
        aiUsers: traffic.aiUsersDeduped,
        aiSessionsBySession: traffic.aiSessionsBySession,
        aiUsersBySession: traffic.aiUsersBySession,
        socialSessions: traffic.socialSessions,
        socialUsers: traffic.socialUsers,
        directSessions: traffic.totalDirectSessions,
        aiSharePct: traffic.aiSharePct,
        aiSharePctBySession: traffic.aiSharePctBySession,
        socialSharePct: traffic.socialSharePct,
        organicSharePct: traffic.organicSharePct,
        directSharePct: traffic.directSharePct,
        organicSharePctDisplay: traffic.organicSharePctDisplay,
        aiSharePctDisplay: traffic.aiSharePctDisplay,
        aiSharePctBySessionDisplay: traffic.aiSharePctBySessionDisplay,
        socialSharePctDisplay: traffic.socialSharePctDisplay,
        directSharePctDisplay: traffic.directSharePctDisplay,
        aiReferrals: traffic.aiReferrals,
        aiReferralLandingPages: traffic.aiReferralLandingPages,
        socialReferrals: traffic.socialReferrals,
        trend,
      }, null, 2))
      return
    }

    if (traffic.totalSessions === 0) {
      console.log('No GA4 traffic data. Run "canonry ga sync <project>" first.')
      return
    }

    console.log(`GA4 Attribution Overview for "${project}"\n`)
    console.log(`  Total Sessions:   ${traffic.totalSessions}`)
    console.log(`  Total Users:      ${traffic.totalUsers}`)
    console.log()
    console.log('  CHANNEL BREAKDOWN                  7d trend     30d trend')
    console.log(`    Organic Search: ${String(traffic.totalOrganicSessions).padEnd(6)} (${traffic.organicSharePctDisplay.padStart(4)})    ${fmtTrend(trend.organic.trend7dPct).padEnd(12)} ${fmtTrend(trend.organic.trend30dPct)}`)
    console.log(`    Social:         ${String(traffic.socialSessions).padEnd(6)} (${traffic.socialSharePctDisplay.padStart(4)})    ${fmtTrend(trend.social.trend7dPct).padEnd(12)} ${fmtTrend(trend.social.trend30dPct)}`)
    console.log(`    Direct:         ${String(traffic.totalDirectSessions).padEnd(6)} (${traffic.directSharePctDisplay.padStart(4)})    ${fmtTrend(trend.direct.trend7dPct).padEnd(12)} ${fmtTrend(trend.direct.trend30dPct)}`)
    console.log(`    AI Referrals:   ${String(traffic.aiSessionsBySession).padEnd(6)} (${traffic.aiSharePctBySessionDisplay.padStart(4)})    ${fmtTrend(trend.ai.trend7dPct).padEnd(12)} ${fmtTrend(trend.ai.trend30dPct)}  (lower bound — sessionSource only; referrer-stripped traffic falls under Direct)`)
    const otherSessions = traffic.totalSessions - traffic.totalOrganicSessions - traffic.aiSessionsBySession - traffic.socialSessions - traffic.totalDirectSessions
    if (otherSessions > 0) {
      const otherPct = traffic.totalSessions > 0 ? Math.round((otherSessions / traffic.totalSessions) * 100) : 0
      console.log(`    Other:          ${String(otherSessions).padEnd(6)} (${String(otherPct).padStart(2)}%)`)
    }
    console.log(`    ─────────────────────────────────────────────────────`)
    console.log(`    Total:          ${String(traffic.totalSessions).padEnd(6)}         ${fmtTrend(trend.total.trend7dPct).padEnd(12)} ${fmtTrend(trend.total.trend30dPct)}`)

    if (trend.aiBiggestMover) {
      const m = trend.aiBiggestMover
      console.log(`\n  AI Mover:     ${m.source} (${m.changePct >= 0 ? '+' : ''}${m.changePct}%, ${m.sessionsPrev7d}→${m.sessions7d} sessions/7d)`)
    }
    if (trend.socialBiggestMover) {
      const m = trend.socialBiggestMover
      console.log(`  Social Mover: ${m.source} (${m.changePct >= 0 ? '+' : ''}${m.changePct}%, ${m.sessionsPrev7d}→${m.sessions7d} sessions/7d)`)
    }

    if (traffic.periodStart && traffic.periodEnd) {
      console.log(`\n  Period: ${traffic.periodStart} to ${traffic.periodEnd}`)
    }
    if (traffic.lastSyncedAt) {
      console.log(`  Last synced: ${traffic.lastSyncedAt}`)
    }
    return
  }

  if (opts?.format === 'json') {
    console.log(JSON.stringify({
      totalSessions: traffic.totalSessions,
      totalUsers: traffic.totalUsers,
      organicSessions: traffic.totalOrganicSessions,
      aiSessions: traffic.aiSessionsDeduped,
      aiUsers: traffic.aiUsersDeduped,
      aiSessionsBySession: traffic.aiSessionsBySession,
      aiUsersBySession: traffic.aiUsersBySession,
      socialSessions: traffic.socialSessions,
      socialUsers: traffic.socialUsers,
      directSessions: traffic.totalDirectSessions,
      aiSharePct: traffic.aiSharePct,
      aiSharePctBySession: traffic.aiSharePctBySession,
      socialSharePct: traffic.socialSharePct,
      organicSharePct: traffic.organicSharePct,
      directSharePct: traffic.directSharePct,
      organicSharePctDisplay: traffic.organicSharePctDisplay,
      aiSharePctDisplay: traffic.aiSharePctDisplay,
      aiSharePctBySessionDisplay: traffic.aiSharePctBySessionDisplay,
      socialSharePctDisplay: traffic.socialSharePctDisplay,
      directSharePctDisplay: traffic.directSharePctDisplay,
      aiReferrals: traffic.aiReferrals,
      aiReferralLandingPages: traffic.aiReferralLandingPages,
      socialReferrals: traffic.socialReferrals,
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
  console.log(`  Total Sessions:   ${traffic.totalSessions}`)
  console.log(`  Total Users:      ${traffic.totalUsers}`)
  console.log()
  console.log('  CHANNEL BREAKDOWN')
  console.log(`    Organic Search: ${traffic.totalOrganicSessions} sessions (${traffic.organicSharePctDisplay})`)
  console.log(`    Social:         ${traffic.socialSessions} sessions (${traffic.socialSharePctDisplay})`)
  console.log(`    Direct:         ${traffic.totalDirectSessions} sessions (${traffic.directSharePctDisplay})`)
  console.log(`    AI Referrals:   ${traffic.aiSessionsBySession} sessions (${traffic.aiSharePctBySessionDisplay})  (lower bound — sessionSource only; referrer-stripped traffic falls under Direct)`)
  const otherSessions = traffic.totalSessions - traffic.totalOrganicSessions - traffic.aiSessionsBySession - traffic.socialSessions - traffic.totalDirectSessions
  if (otherSessions > 0) {
    const otherPct = traffic.totalSessions > 0 ? Math.round((otherSessions / traffic.totalSessions) * 100) : 0
    console.log(`    Other:          ${otherSessions} sessions (${otherPct}%)`)
  }

  if (traffic.aiReferrals.length > 0) {
    console.log()
    console.log('  AI SOURCES')
    for (const ref of traffic.aiReferrals.slice(0, 10)) {
      const dimLabel = ref.sourceDimension === 'first_user' ? 'first-visit' : ref.sourceDimension === 'manual_utm' ? 'utm' : 'session'
      console.log(`    ${ref.source.padEnd(25)} ${String(ref.sessions).padEnd(8)} sessions  (${dimLabel})`)
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

  if (traffic.periodStart && traffic.periodEnd) {
    console.log(`\n  Period: ${traffic.periodStart} to ${traffic.periodEnd}`)
  }
  if (traffic.lastSyncedAt) {
    console.log(`  Last synced: ${traffic.lastSyncedAt}`)
  }
}
