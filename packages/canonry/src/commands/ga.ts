import type { GaConnectResponse, GaStatusResponse, GaSyncResponse, GaTrafficResponse, GaCoverageResponse, GA4AiReferralHistoryEntry } from '@ainyc/canonry-contracts'
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

export async function gaSync(project: string, opts?: { days?: number; format?: string }): Promise<void> {
  const client = getClient()
  const result: GaSyncResponse = await client.gaSync(project, { days: opts?.days })

  if (opts?.format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`GA4 sync complete for "${project}".`)
  console.log(`  Page rows:   ${result.rowCount}`)
  console.log(`  AI rows:     ${result.aiReferralCount}`)
  console.log(`  Period:      ${result.days} days`)
  console.log(`  Synced at:   ${result.syncedAt}`)
}

export async function gaTraffic(project: string, opts?: { limit?: number; format?: string }): Promise<void> {
  const client = getClient()
  const params: Record<string, string> = {}
  if (opts?.limit) params.limit = String(opts.limit)

  const result: GaTrafficResponse = await client.gaTraffic(project, Object.keys(params).length > 0 ? params : undefined)

  if (opts?.format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (result.topPages.length === 0 && result.aiReferrals.length === 0) {
    console.log('No GA4 traffic data. Run "canonry ga sync <project>" first.')
    return
  }

  console.log(`GA4 Traffic for "${project}"\n`)
  console.log(`  Total Sessions:          ${result.totalSessions}`)
  console.log(`  Organic Sessions:        ${result.totalOrganicSessions}`)
  console.log(`  Total Users:             ${result.totalUsers}`)
  console.log()

  if (result.aiReferrals.length > 0) {
    console.log('  AI REFERRAL SOURCES')
    console.log(`  ${'SOURCE'.padEnd(25)}  ${'MEDIUM'.padEnd(15)}  ${'SESSIONS'.padEnd(10)}${'USERS'.padEnd(8)}`)
    console.log(`  ${'─'.repeat(25)}  ${'─'.repeat(15)}  ${'─'.repeat(10)}${'─'.repeat(8)}`)

    for (const ref of result.aiReferrals) {
      console.log(
        `  ${ref.source.padEnd(25)}  ${ref.medium.padEnd(15)}  ${String(ref.sessions).padEnd(10)}${String(ref.users).padEnd(8)}`,
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

export async function gaAiReferralHistory(project: string, format?: string): Promise<void> {
  const client = getClient()
  const result: GA4AiReferralHistoryEntry[] = await client.gaAiReferralHistory(project)

  if (format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (result.length === 0) {
    console.log('No AI referral history. Run "canonry ga sync <project>" first.')
    return
  }

  const dateWidth = 12
  const sourceWidth = Math.min(30, Math.max(10, ...result.map((r) => r.source.length)))
  console.log(`GA4 AI Referral History for "${project}":\n`)
  console.log(`  ${'DATE'.padEnd(dateWidth)}  ${'SOURCE'.padEnd(sourceWidth)}  ${'SESSIONS'.padEnd(10)}${'USERS'.padEnd(8)}`)
  console.log(`  ${'─'.repeat(dateWidth)}  ${'─'.repeat(sourceWidth)}  ${'─'.repeat(10)}${'─'.repeat(8)}`)
  for (const row of result) {
    console.log(
      `  ${row.date.padEnd(dateWidth)}  ${row.source.padEnd(sourceWidth)}  ${String(row.sessions).padEnd(10)}${String(row.users).padEnd(8)}`,
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
