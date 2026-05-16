#!/usr/bin/env tsx
/**
 * Pull Cloud Run request logs and GA4 AI referrals over the same window,
 * correlate per AI source and per landing path, and surface the gap.
 *
 * GA4 sees AI clicks that survive as a referrer or UTM tag; Cloud Run sees
 * the raw request including AI crawler bots that GA never records. The
 * script makes the asymmetry inspectable end-to-end before the persistence
 * + public surface layer lands.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  listCloudRunTrafficEvents,
  normalizeCloudRunLogEntry,
  type CloudRunLogEntry,
} from '../packages/integration-cloud-run/src/index.js'
import {
  DEFAULT_AI_CRAWLER_USER_AGENT_SUBSTRINGS,
  DEFAULT_AI_REFERRER_RULES,
  buildTrafficProbeReport,
  classifyAiReferral,
  classifyCrawler,
  type AiReferrerRule,
} from '../packages/integration-traffic/src/index.js'
import {
  getAccessToken as getGa4AccessToken,
  fetchAiReferrals,
  type GA4AiReferralRow,
} from '../packages/integration-google-analytics/src/index.js'
import { loadConfig } from '../packages/canonry/src/config.js'
import { getGa4Connection } from '../packages/canonry/src/ga4-config.js'

const execFileAsync = promisify(execFile)

interface Args {
  // Window
  since: string
  until?: string
  // Cloud Run
  gcpProjectId?: string
  serviceName?: string
  location?: string
  pageSize: number
  maxPages: number
  cloudRunAccessToken?: string
  cloudRunTokenEnv: string
  useGcloud: boolean
  narrowBots: boolean
  urlContains: string[]
  cloudRunFixture?: string
  // GA4
  canonryProject?: string
  gaPropertyId?: string
  gaKeyFile?: string
  gaFixture?: string
  // Output
  out?: string
  json: boolean
  help: boolean
}

interface CloudRunPullResult {
  events: NonNullable<ReturnType<typeof normalizeCloudRunLogEntry>>[]
  rawEntryCount: number
  skippedEntryCount: number
  nextPageToken?: string
  filter: string
}

interface AiSourceComparisonRow {
  domain: string
  operator: string
  product: string
  cloudRunHits: number
  cloudRunHitsByEvidence: { referer: number; utm: number }
  gaSessions: number
  delta: number
  verdict:
    | 'agree'
    | 'cloud-run-higher'
    | 'ga-higher'
    | 'cloud-run-only'
    | 'ga-only'
    | 'neither'
}

interface PathRow {
  path: string
  cloudRunTotalHits: number
  cloudRunCrawlerHits: number
  topCrawler: string | null
  cloudRunReferralHits: number
  topCrawlerReferer: string | null
  gaAiSessions: number
  topGaSource: string | null
  verdict: 'crawled+clicked' | 'crawled-only' | 'clicked-only' | 'referred-only'
}

interface CorrelationOutput {
  window: {
    cloudRun: { startTime: string; endTime: string }
    ga: { days: number; note: string }
  }
  cloudRun: {
    source: 'cloud-run' | 'fixture'
    rawEntryCount: number
    normalizedEventCount: number
    skippedEntryCount: number
    nextPageToken?: string
    filter: string
    crawlerHits: number
    aiReferralHits: number
    unknownHits: number
  }
  ga: {
    source: 'ga4' | 'fixture'
    rowsFetched: number
    sessionsTotal: number
  }
  aiSourceComparison: AiSourceComparisonRow[]
  pathJoin: PathRow[]
  topCrawlerBots: Array<{ botId: string; operator: string; hits: number }>
  topCrawlerPaths: Array<{ pathNormalized: string; hits: number }>
}

function usage(): string {
  return [
    'Usage:',
    '  pnpm tsx scripts/test-cloud-run-vs-ga-ai-traffic.ts \\',
    '    --gcp-project <id> --use-gcloud \\',
    '    --canonry-project <name> \\',
    '    --since 24h',
    '',
    '  pnpm tsx scripts/test-cloud-run-vs-ga-ai-traffic.ts \\',
    '    --cloud-run-fixture scripts/fixtures/cloud-run-traffic-sample.json \\',
    '    --ga-fixture scripts/fixtures/ga4-ai-referrals-sample.json',
    '',
    'Window:',
    '  --since <duration|iso>       Window start. Durations: 30m, 6h, 7d. Default: 24h',
    '  --until <iso>                Window end. Default: now',
    '',
    'Cloud Run:',
    '  --gcp-project <id>           GCP project (required for live)',
    '  --service <name>             Cloud Run service name (optional narrow filter)',
    '  --location <region>          Cloud Run region (optional narrow filter)',
    '  --page-size <n>              Cloud Logging page size. Default: 1000',
    '  --max-pages <n>              Max pages to pull. Default: 1',
    '  --access-token <token>       Bearer token for Cloud Logging',
    '  --token-env <name>           Env var with token. Default: GOOGLE_CLOUD_ACCESS_TOKEN',
    '  --use-gcloud                 Resolve token via `gcloud auth print-access-token`',
    '  --narrow-bots                Cloud Logging UA filter to known AI crawlers (misses human AI referrals)',
    '  --url-contains <value>       Cloud Logging request-URL substring filter. Repeatable.',
    '  --cloud-run-fixture <path>   Read Cloud Logging entries from a JSON fixture',
    '',
    'GA4:',
    '  --canonry-project <name>     Look up GA4 service-account credentials in ~/.canonry/config.yaml',
    '  --ga-property <id>           GA4 property ID (used with --ga-key-file)',
    '  --ga-key-file <path>         GA4 service-account JSON key file',
    '  --ga-fixture <path>          Read GA4 AI-referral rows from a JSON fixture',
    '',
    'Output:',
    '  --out <path>                 Write full JSON report to a file',
    '  --json                       Print full JSON report to stdout',
    '  --help                       Show this help',
  ].join('\n')
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    since: '24h',
    pageSize: 1000,
    maxPages: 1,
    cloudRunTokenEnv: 'GOOGLE_CLOUD_ACCESS_TOKEN',
    useGcloud: false,
    narrowBots: false,
    urlContains: [],
    json: false,
    help: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      const value = argv[i + 1]
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`)
      i += 1
      return value
    }
    switch (arg) {
      case '--since': args.since = next(); break
      case '--until': args.until = next(); break
      case '--gcp-project': args.gcpProjectId = next(); break
      case '--service': args.serviceName = next(); break
      case '--location': args.location = next(); break
      case '--page-size': args.pageSize = parsePositiveInt('--page-size', next()); break
      case '--max-pages': args.maxPages = parsePositiveInt('--max-pages', next()); break
      case '--access-token': args.cloudRunAccessToken = next(); break
      case '--token-env': args.cloudRunTokenEnv = next(); break
      case '--use-gcloud': args.useGcloud = true; break
      case '--narrow-bots': args.narrowBots = true; break
      case '--url-contains': args.urlContains.push(next()); break
      case '--cloud-run-fixture': args.cloudRunFixture = next(); break
      case '--canonry-project': args.canonryProject = next(); break
      case '--ga-property': args.gaPropertyId = next(); break
      case '--ga-key-file': args.gaKeyFile = next(); break
      case '--ga-fixture': args.gaFixture = next(); break
      case '--out': args.out = next(); break
      case '--json': args.json = true; break
      case '--help':
      case '-h': args.help = true; break
      default: throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return args
}

function parsePositiveInt(name: string, raw: string): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

function resolveWindow(since: string, until: string | undefined): {
  startTime: string
  endTime: string
  hours: number
} {
  const end = until ? new Date(until) : new Date()
  if (Number.isNaN(end.getTime())) throw new Error(`Invalid --until timestamp: ${until}`)

  const durationMatch = /^(\d+)([mhd])$/.exec(since.trim())
  let startMs: number
  if (durationMatch) {
    const amount = Number(durationMatch[1])
    const unit = durationMatch[2]
    const multiplier = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000
    startMs = end.getTime() - amount * multiplier
  } else {
    const start = new Date(since)
    if (Number.isNaN(start.getTime())) throw new Error(`Invalid --since value: ${since}`)
    if (start.getTime() >= end.getTime()) throw new Error('--since must be before --until')
    startMs = start.getTime()
  }

  const hours = (end.getTime() - startMs) / 3_600_000
  return {
    startTime: new Date(startMs).toISOString(),
    endTime: end.toISOString(),
    hours,
  }
}

async function resolveCloudRunToken(args: Args): Promise<string> {
  if (args.cloudRunAccessToken?.trim()) return args.cloudRunAccessToken.trim()
  const envToken = process.env[args.cloudRunTokenEnv]?.trim()
  if (envToken) return envToken
  if (args.useGcloud) {
    const { stdout } = await execFileAsync('gcloud', ['auth', 'print-access-token'])
    const token = stdout.trim()
    if (token) return token
  }
  throw new Error(
    `No Cloud Logging access token found. Set ${args.cloudRunTokenEnv}, pass --access-token, or use --use-gcloud.`,
  )
}

function isLogEntryArray(value: unknown): value is CloudRunLogEntry[] {
  return Array.isArray(value)
}

function readEntriesFromFixture(value: unknown): CloudRunLogEntry[] {
  if (isLogEntryArray(value)) return value
  if (value && typeof value === 'object') {
    const object = value as { entries?: unknown; responses?: Array<{ entries?: unknown }> }
    if (isLogEntryArray(object.entries)) return object.entries
    if (Array.isArray(object.responses)) {
      return object.responses.flatMap((response) =>
        isLogEntryArray(response.entries) ? response.entries : [],
      )
    }
  }
  throw new Error('Cloud Run fixture must be LogEntry[], { entries }, or { responses: [{ entries }] }')
}

async function pullCloudRun(args: Args, startTime: string, endTime: string): Promise<CloudRunPullResult> {
  if (args.cloudRunFixture) {
    const raw = await fs.readFile(args.cloudRunFixture, 'utf-8')
    const entries = readEntriesFromFixture(JSON.parse(raw) as unknown)
    const events: CloudRunPullResult['events'] = []
    let skippedEntryCount = 0
    for (const entry of entries) {
      const event = normalizeCloudRunLogEntry(entry)
      if (event) events.push(event)
      else skippedEntryCount += 1
    }
    return {
      events,
      rawEntryCount: entries.length,
      skippedEntryCount,
      filter: `fixture:${args.cloudRunFixture}`,
    }
  }

  if (!args.gcpProjectId) {
    throw new Error('--gcp-project is required unless --cloud-run-fixture is used')
  }
  const accessToken = await resolveCloudRunToken(args)
  const page = await listCloudRunTrafficEvents(accessToken, {
    gcpProjectId: args.gcpProjectId,
    serviceName: args.serviceName,
    location: args.location,
    startTime,
    endTime,
    pageSize: args.pageSize,
    maxPages: args.maxPages,
    userAgentSubstrings: args.narrowBots ? DEFAULT_AI_CRAWLER_USER_AGENT_SUBSTRINGS : undefined,
    requestUrlSubstrings: args.urlContains.length > 0 ? args.urlContains : undefined,
  })
  return {
    events: page.events.filter((event): event is NonNullable<typeof event> => event !== null),
    rawEntryCount: page.rawEntryCount,
    skippedEntryCount: page.skippedEntryCount,
    nextPageToken: page.nextPageToken,
    filter: page.filter,
  }
}

function isAiReferralRowArray(value: unknown): value is GA4AiReferralRow[] {
  return Array.isArray(value)
}

function readGaRowsFromFixture(value: unknown): GA4AiReferralRow[] {
  if (isAiReferralRowArray(value)) return value
  if (value && typeof value === 'object') {
    const object = value as { rows?: unknown }
    if (isAiReferralRowArray(object.rows)) return object.rows
  }
  throw new Error('GA fixture must be GA4AiReferralRow[] or { rows: GA4AiReferralRow[] }')
}

async function pullGa(
  args: Args,
  windowDays: number,
): Promise<{ rows: GA4AiReferralRow[]; source: 'ga4' | 'fixture' }> {
  if (args.gaFixture) {
    const raw = await fs.readFile(args.gaFixture, 'utf-8')
    return { rows: readGaRowsFromFixture(JSON.parse(raw) as unknown), source: 'fixture' }
  }

  let propertyId: string
  let clientEmail: string
  let privateKey: string

  if (args.canonryProject) {
    const config = loadConfig()
    const connection = getGa4Connection(config, args.canonryProject)
    if (!connection) {
      throw new Error(
        `No GA4 connection found for canonry project "${args.canonryProject}". ` +
          'Run `canonry ga connect <project> --property-id <id> --service-account-key <file>` first.',
      )
    }
    propertyId = connection.propertyId
    clientEmail = connection.clientEmail
    privateKey = connection.privateKey
  } else {
    if (!args.gaPropertyId || !args.gaKeyFile) {
      throw new Error(
        'GA4 source missing: pass --canonry-project <name>, or --ga-property + --ga-key-file, or --ga-fixture <path>.',
      )
    }
    const keyRaw = await fs.readFile(args.gaKeyFile, 'utf-8')
    const parsed = JSON.parse(keyRaw) as { client_email?: string; private_key?: string }
    if (!parsed.client_email || !parsed.private_key) {
      throw new Error(`--ga-key-file ${args.gaKeyFile} is missing client_email or private_key`)
    }
    propertyId = args.gaPropertyId
    clientEmail = parsed.client_email
    privateKey = parsed.private_key
  }

  const accessToken = await getGa4AccessToken(clientEmail, privateKey)
  const rows = await fetchAiReferrals(accessToken, propertyId, windowDays)
  return { rows, source: 'ga4' }
}

/**
 * GA4 fans the same session out across three attribution dimensions
 * (`session`, `first_user`, `manual_utm`). Mirror the dedupe in
 * `packages/api-routes/src/ga.ts`: take MAX sessions per
 * (date, source, medium, landingPage) so a 14-session row in `session`
 * and a 14-session row in `first_user` count as 14, not 28.
 */
function dedupeGaRows(rows: GA4AiReferralRow[]): GA4AiReferralRow[] {
  const max = new Map<string, GA4AiReferralRow>()
  for (const row of rows) {
    const key = `${row.date}|${row.source}|${row.medium}|${row.landingPage}`
    const existing = max.get(key)
    if (!existing || row.sessions > existing.sessions) max.set(key, row)
  }
  return [...max.values()]
}

function normalizePath(rawPath: string): string {
  if (!rawPath) return '/'
  try {
    const withBase = rawPath.startsWith('http') ? new URL(rawPath) : new URL(rawPath, 'http://x')
    const trimmed = withBase.pathname.replace(/\/+$/, '')
    return trimmed.length === 0 ? '/' : trimmed
  } catch {
    const stripped = rawPath.split('?')[0].split('#')[0]
    if (!stripped) return '/'
    const trimmed = stripped.replace(/\/+$/, '')
    return trimmed.length === 0 ? '/' : trimmed
  }
}

function gaSourceMatchesRule(gaSource: string, rule: AiReferrerRule): boolean {
  const lower = gaSource.toLowerCase()
  const domain = rule.domain.toLowerCase()
  if (lower === domain) return true
  // GA4 normalizes some sources to bare brand strings. Match the brand token
  // (text before the first dot) so e.g. `chatgpt` ≈ `chatgpt.com`.
  const brand = domain.split('.')[0]
  if (brand && lower.includes(brand)) return true
  // Match domain substring for hosts like `chat.openai.com` referenced under `openai`.
  if (lower.includes(domain)) return true
  return false
}

function buildAiSourceComparison(
  cloudRunEvents: CloudRunPullResult['events'],
  gaRows: GA4AiReferralRow[],
): AiSourceComparisonRow[] {
  const dedupedGa = dedupeGaRows(gaRows)

  // Group rules by product so we don't double-count when multiple rules
  // (e.g. chatgpt.com + chat.openai.com) point at the same AI surface.
  const rulesByProduct = new Map<string, AiReferrerRule[]>()
  for (const rule of DEFAULT_AI_REFERRER_RULES) {
    const list = rulesByProduct.get(rule.product) ?? []
    list.push(rule)
    rulesByProduct.set(rule.product, list)
  }

  // Use the shipped classifier so referer + UTM evidence both count.
  const classifications = cloudRunEvents.map((event) => classifyAiReferral(event))

  const rows: AiSourceComparisonRow[] = []
  for (const [product, rules] of rulesByProduct) {
    let referer = 0
    let utm = 0
    for (const ai of classifications) {
      if (!ai || ai.product !== product) continue
      if (ai.evidenceType === 'referer') referer += 1
      else if (ai.evidenceType === 'utm') utm += 1
    }
    const cloudRunHits = referer + utm

    const gaSessions = dedupedGa
      .filter((row) => rules.some((rule) => gaSourceMatchesRule(row.source, rule)))
      .reduce((sum, row) => sum + row.sessions, 0)

    const delta = cloudRunHits - gaSessions
    let verdict: AiSourceComparisonRow['verdict']
    if (cloudRunHits === 0 && gaSessions === 0) verdict = 'neither'
    else if (cloudRunHits === 0) verdict = 'ga-only'
    else if (gaSessions === 0) verdict = 'cloud-run-only'
    else if (delta === 0) verdict = 'agree'
    else verdict = delta > 0 ? 'cloud-run-higher' : 'ga-higher'

    rows.push({
      domain: rules[0].domain,
      operator: rules[0].operator,
      product,
      cloudRunHits,
      cloudRunHitsByEvidence: { referer, utm },
      gaSessions,
      delta,
      verdict,
    })
  }
  return rows
}

function buildPathJoin(
  cloudRunEvents: CloudRunPullResult['events'],
  gaRows: GA4AiReferralRow[],
): PathRow[] {
  const dedupedGa = dedupeGaRows(gaRows)

  type PathAggregate = {
    cloudRunTotalHits: number
    cloudRunCrawlerHits: number
    crawlerCounts: Map<string, number>
    cloudRunReferralHits: number
    refererCounts: Map<string, number>
    gaAiSessions: number
    gaSourceCounts: Map<string, number>
  }
  const byPath = new Map<string, PathAggregate>()
  const ensure = (key: string): PathAggregate => {
    let row = byPath.get(key)
    if (!row) {
      row = {
        cloudRunTotalHits: 0,
        cloudRunCrawlerHits: 0,
        crawlerCounts: new Map(),
        cloudRunReferralHits: 0,
        refererCounts: new Map(),
        gaAiSessions: 0,
        gaSourceCounts: new Map(),
      }
      byPath.set(key, row)
    }
    return row
  }

  for (const event of cloudRunEvents) {
    const key = normalizePath(event.path)
    const row = ensure(key)
    row.cloudRunTotalHits += 1

    const crawler = classifyCrawler(event)
    if (crawler) {
      row.cloudRunCrawlerHits += 1
      row.crawlerCounts.set(crawler.product, (row.crawlerCounts.get(crawler.product) ?? 0) + 1)
    }

    const ai = classifyAiReferral(event)
    if (ai) {
      row.cloudRunReferralHits += 1
      const label = `${ai.product} (${ai.evidenceType})`
      row.refererCounts.set(label, (row.refererCounts.get(label) ?? 0) + 1)
    }
  }

  for (const row of dedupedGa) {
    const key = normalizePath(row.landingPage)
    const aggregate = ensure(key)
    aggregate.gaAiSessions += row.sessions
    aggregate.gaSourceCounts.set(
      row.source,
      (aggregate.gaSourceCounts.get(row.source) ?? 0) + row.sessions,
    )
  }

  const top = (counts: Map<string, number>): string | null => {
    let best: { key: string; value: number } | null = null
    for (const [key, value] of counts) {
      if (!best || value > best.value) best = { key, value }
    }
    return best ? `${best.key} (${best.value})` : null
  }

  const verdictFor = (row: PathAggregate): PathRow['verdict'] => {
    const crawled = row.cloudRunCrawlerHits > 0
    const clicked = row.gaAiSessions > 0
    const referred = row.cloudRunReferralHits > 0
    if (crawled && clicked) return 'crawled+clicked'
    if (crawled) return 'crawled-only'
    if (clicked) return 'clicked-only'
    return referred ? 'referred-only' : 'crawled-only'
  }

  return [...byPath.entries()]
    .map(([pathKey, aggregate]) => ({
      path: pathKey,
      cloudRunTotalHits: aggregate.cloudRunTotalHits,
      cloudRunCrawlerHits: aggregate.cloudRunCrawlerHits,
      topCrawler: top(aggregate.crawlerCounts),
      cloudRunReferralHits: aggregate.cloudRunReferralHits,
      topCrawlerReferer: top(aggregate.refererCounts),
      gaAiSessions: aggregate.gaAiSessions,
      topGaSource: top(aggregate.gaSourceCounts),
      verdict: verdictFor(aggregate),
    }))
    .filter(
      (row) =>
        row.cloudRunCrawlerHits > 0 ||
        row.cloudRunReferralHits > 0 ||
        row.gaAiSessions > 0,
    )
    .sort((a, b) => {
      const aScore = a.cloudRunCrawlerHits + a.cloudRunReferralHits + a.gaAiSessions
      const bScore = b.cloudRunCrawlerHits + b.cloudRunReferralHits + b.gaAiSessions
      return bScore - aScore
    })
}

function printSummary(output: CorrelationOutput): void {
  console.log('Cloud Run × GA4 AI traffic correlation')
  console.log(`Cloud Run window: ${output.window.cloudRun.startTime} → ${output.window.cloudRun.endTime}`)
  console.log(`GA4 window:       last ${output.window.ga.days}d (${output.window.ga.note})`)
  console.log('')
  console.log(
    `Cloud Run: source=${output.cloudRun.source} raw=${output.cloudRun.rawEntryCount} ` +
      `events=${output.cloudRun.normalizedEventCount} crawlers=${output.cloudRun.crawlerHits} ` +
      `referrals=${output.cloudRun.aiReferralHits} unknown=${output.cloudRun.unknownHits}`,
  )
  console.log(
    `GA4:       source=${output.ga.source} rows=${output.ga.rowsFetched} ` +
      `sessions=${output.ga.sessionsTotal}`,
  )

  if (output.topCrawlerBots.length > 0) {
    console.log('\nTop Cloud Run crawlers (no GA equivalent):')
    for (const bot of output.topCrawlerBots) {
      console.log(`  ${bot.botId} (${bot.operator}): ${bot.hits}`)
    }
  }

  console.log('\nAI source comparison (Cloud Run referer+UTM vs GA sessions):')
  console.log(
    '  surface'.padEnd(30) +
      'CR'.padStart(6) +
      'ref'.padStart(6) +
      'utm'.padStart(6) +
      'GA'.padStart(6) +
      'delta'.padStart(8) +
      '  verdict',
  )
  for (const row of output.aiSourceComparison) {
    if (row.verdict === 'neither') continue
    const label = `${row.product} (${row.domain})`
    console.log(
      `  ${label.padEnd(28)}` +
        `${row.cloudRunHits.toString().padStart(6)}` +
        `${row.cloudRunHitsByEvidence.referer.toString().padStart(6)}` +
        `${row.cloudRunHitsByEvidence.utm.toString().padStart(6)}` +
        `${row.gaSessions.toString().padStart(6)}` +
        `${row.delta.toString().padStart(8)}  ${row.verdict}`,
    )
  }

  if (output.pathJoin.length > 0) {
    console.log('\nPath-level join (top 20):')
    for (const row of output.pathJoin.slice(0, 20)) {
      console.log(`  ${row.path}`)
      console.log(
        `    crawlers=${row.cloudRunCrawlerHits}` +
          (row.topCrawler ? ` top=${row.topCrawler}` : '') +
          ` referrals=${row.cloudRunReferralHits}` +
          (row.topCrawlerReferer ? ` ref=${row.topCrawlerReferer}` : '') +
          ` ga=${row.gaAiSessions}` +
          (row.topGaSource ? ` ga-src=${row.topGaSource}` : '') +
          `  [${row.verdict}]`,
      )
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return
  }

  const window = resolveWindow(args.since, args.until)
  const gaDays = Math.max(1, Math.ceil(window.hours / 24))

  const cloudRunPull = await pullCloudRun(args, window.startTime, window.endTime)
  const gaPull = await pullGa(args, gaDays)

  const probe = buildTrafficProbeReport(cloudRunPull.events)
  const aiSourceComparison = buildAiSourceComparison(cloudRunPull.events, gaPull.rows)
  const pathJoin = buildPathJoin(cloudRunPull.events, gaPull.rows)
  const sessionsTotal = dedupeGaRows(gaPull.rows).reduce((sum, row) => sum + row.sessions, 0)

  const output: CorrelationOutput = {
    window: {
      cloudRun: { startTime: window.startTime, endTime: window.endTime },
      ga: {
        days: gaDays,
        note:
          window.hours <= 24
            ? 'GA4 minimum is 1 day; Cloud Run window is shorter, so GA bucket is wider'
            : 'GA4 ceil-rounds to whole days from --since',
      },
    },
    cloudRun: {
      source: args.cloudRunFixture ? 'fixture' : 'cloud-run',
      rawEntryCount: cloudRunPull.rawEntryCount,
      normalizedEventCount: cloudRunPull.events.length,
      skippedEntryCount: cloudRunPull.skippedEntryCount,
      nextPageToken: cloudRunPull.nextPageToken,
      filter: cloudRunPull.filter,
      crawlerHits: probe.totals.crawlerHits,
      aiReferralHits: probe.totals.aiReferralHits,
      unknownHits: probe.totals.unknownHits,
    },
    ga: {
      source: gaPull.source,
      rowsFetched: gaPull.rows.length,
      sessionsTotal,
    },
    aiSourceComparison,
    pathJoin,
    topCrawlerBots: probe.topBots,
    topCrawlerPaths: probe.topCrawlerPaths,
  }

  if (args.out) {
    const outputPath = path.resolve(args.out)
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`)
    if (!args.json) console.log(`Wrote report: ${outputPath}`)
  }

  if (args.json) {
    console.log(JSON.stringify(output, null, 2))
  } else {
    printSummary(output)
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
