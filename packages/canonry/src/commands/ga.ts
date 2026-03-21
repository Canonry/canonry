import { loadConfig } from '../config.js'
import { ApiClient } from '../client.js'
import { CliError } from '../cli-error.js'

function getClient(): ApiClient {
  const config = loadConfig()
  return new ApiClient(config.apiUrl, config.apiKey)
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

  if (!opts.keyFile && !opts.keyJson) {
    throw new CliError({
      code: 'GA_KEY_REQUIRED',
      message: 'Service account key is required (pass --key-file or --key-json)',
      displayMessage: 'Error: --key-file or --key-json is required',
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

  const client = getClient()
  const result = await client.gaConnect(project, body) as {
    connected: boolean
    propertyId: string
    clientEmail: string
  }

  if (opts.format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`GA4 connected for project "${project}".`)
  console.log(`  Property ID:     ${result.propertyId}`)
  console.log(`  Service Account: ${result.clientEmail}`)
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
  const result = await client.gaStatus(project) as {
    connected: boolean
    propertyId: string | null
    clientEmail: string | null
    lastSyncedAt: string | null
    createdAt?: string
    updatedAt?: string
  }

  if (format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (!result.connected) {
    console.log(`No GA4 connection for project "${project}".`)
    console.log('Run "canonry ga connect <project> --property-id <id> --key-file <path>" to connect.')
    return
  }

  console.log(`GA4 for "${project}":\n`)
  console.log(`  Property ID:     ${result.propertyId}`)
  console.log(`  Service Account: ${result.clientEmail}`)
  console.log(`  Last Synced:     ${result.lastSyncedAt ?? '(never)'}`)
  console.log(`  Connected:       ${result.createdAt ?? 'unknown'}`)
}

export async function gaSync(project: string, opts?: { days?: number; format?: string }): Promise<void> {
  const client = getClient()
  const result = await client.gaSync(project, { days: opts?.days }) as {
    synced: boolean
    rowCount: number
    days: number
    syncedAt: string
  }

  if (opts?.format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`GA4 sync complete for "${project}".`)
  console.log(`  Rows synced: ${result.rowCount}`)
  console.log(`  Period:      ${result.days} days`)
  console.log(`  Synced at:   ${result.syncedAt}`)
}

export async function gaTraffic(project: string, opts?: { limit?: number; format?: string }): Promise<void> {
  const client = getClient()
  const params: Record<string, string> = {}
  if (opts?.limit) params.limit = String(opts.limit)

  const result = await client.gaTraffic(project, Object.keys(params).length > 0 ? params : undefined) as {
    totalSessions: number
    totalOrganicSessions: number
    totalUsers: number
    topPages: Array<{ landingPage: string; sessions: number; organicSessions: number; users: number }>
    lastSyncedAt: string | null
  }

  if (opts?.format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (result.topPages.length === 0) {
    console.log('No GA4 traffic data. Run "canonry ga sync <project>" first.')
    return
  }

  console.log(`GA4 Traffic for "${project}"\n`)
  console.log(`  Total Sessions:          ${result.totalSessions}`)
  console.log(`  Organic Sessions:        ${result.totalOrganicSessions}`)
  console.log(`  Total Users:             ${result.totalUsers}`)
  console.log()

  const pageWidth = Math.min(60, Math.max(15, ...result.topPages.map((r) => r.landingPage.length)))
  console.log(`  ${'LANDING PAGE'.padEnd(pageWidth)}  ${'SESSIONS'.padEnd(10)}${'ORGANIC'.padEnd(10)}${'USERS'.padEnd(8)}`)
  console.log(`  ${'─'.repeat(pageWidth)}  ${'─'.repeat(10)}${'─'.repeat(10)}${'─'.repeat(8)}`)

  for (const row of result.topPages) {
    const page = row.landingPage.length > pageWidth ? row.landingPage.slice(0, pageWidth - 3) + '...' : row.landingPage
    console.log(
      `  ${page.padEnd(pageWidth)}  ${String(row.sessions).padEnd(10)}${String(row.organicSessions).padEnd(10)}${String(row.users).padEnd(8)}`,
    )
  }

  if (result.lastSyncedAt) {
    console.log(`\n  Last synced: ${result.lastSyncedAt}`)
  }
}

export async function gaCoverage(project: string, format?: string): Promise<void> {
  const client = getClient()
  const result = await client.gaCoverage(project) as {
    pages: Array<{ landingPage: string; sessions: number; organicSessions: number; users: number }>
  }

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
