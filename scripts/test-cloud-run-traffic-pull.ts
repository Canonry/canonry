#!/usr/bin/env tsx
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
  buildTrafficProbeReport,
} from '../packages/integration-traffic/src/index.js'

const execFileAsync = promisify(execFile)

interface Args {
  gcpProjectId?: string
  serviceName?: string
  location?: string
  since: string
  until?: string
  pageSize: number
  maxPages: number
  accessToken?: string
  tokenEnv: string
  useGcloud: boolean
  narrowBots: boolean
  urlContains: string[]
  fixture?: string
  out?: string
  json: boolean
  help: boolean
}

interface PullResult {
  events: ReturnType<typeof normalizeCloudRunLogEntry>[]
  rawEntryCount: number
  skippedEntryCount: number
  nextPageToken?: string
  filter: string
}

function usage(): string {
  return [
    'Usage:',
    '  pnpm tsx scripts/test-cloud-run-traffic-pull.ts --gcp-project <id> [--service <name>] [--location <region>]',
    '  pnpm tsx scripts/test-cloud-run-traffic-pull.ts --fixture scripts/fixtures/cloud-run-traffic-sample.json',
    '',
    'Options:',
    '  --since <duration|iso>       Window start. Durations: 30m, 6h, 2d. Default: 1h',
    '  --until <iso>                Window end. Default: now',
    '  --page-size <n>              Cloud Logging page size. Default: 1000',
    '  --max-pages <n>              Max pages to pull. Default: 1',
    '  --access-token <token>       Bearer token for Cloud Logging',
    '  --token-env <name>           Env var containing token. Default: GOOGLE_CLOUD_ACCESS_TOKEN',
    '  --use-gcloud                 Resolve token via `gcloud auth print-access-token`',
    '  --narrow-bots                Add UA filters for known AI crawlers. Misses human AI referrals.',
    '  --url-contains <value>       Add request URL substring filter. Repeatable.',
    '  --out <path>                 Write JSON report to a file',
    '  --json                       Print full JSON report to stdout',
    '  --help                       Show this help',
  ].join('\n')
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    since: '1h',
    pageSize: 1000,
    maxPages: 1,
    tokenEnv: 'GOOGLE_CLOUD_ACCESS_TOKEN',
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
      case '--gcp-project':
        args.gcpProjectId = next()
        break
      case '--service':
        args.serviceName = next()
        break
      case '--location':
        args.location = next()
        break
      case '--since':
        args.since = next()
        break
      case '--until':
        args.until = next()
        break
      case '--page-size':
        args.pageSize = parsePositiveInt('--page-size', next())
        break
      case '--max-pages':
        args.maxPages = parsePositiveInt('--max-pages', next())
        break
      case '--access-token':
        args.accessToken = next()
        break
      case '--token-env':
        args.tokenEnv = next()
        break
      case '--use-gcloud':
        args.useGcloud = true
        break
      case '--narrow-bots':
        args.narrowBots = true
        break
      case '--url-contains':
        args.urlContains.push(next())
        break
      case '--fixture':
        args.fixture = next()
        break
      case '--out':
        args.out = next()
        break
      case '--json':
        args.json = true
        break
      case '--help':
      case '-h':
        args.help = true
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
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

function resolveWindow(since: string, until: string | undefined): { startTime: string; endTime: string } {
  const end = until ? new Date(until) : new Date()
  if (Number.isNaN(end.getTime())) throw new Error(`Invalid --until timestamp: ${until}`)

  const durationMatch = /^(\d+)([mhd])$/.exec(since.trim())
  if (durationMatch) {
    const amount = Number(durationMatch[1])
    const unit = durationMatch[2]
    const multiplier = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000
    return {
      startTime: new Date(end.getTime() - amount * multiplier).toISOString(),
      endTime: end.toISOString(),
    }
  }

  const start = new Date(since)
  if (Number.isNaN(start.getTime())) {
    throw new Error(`Invalid --since value: ${since}`)
  }
  if (start.getTime() >= end.getTime()) {
    throw new Error('--since must be before --until')
  }
  return { startTime: start.toISOString(), endTime: end.toISOString() }
}

async function resolveAccessToken(args: Args): Promise<string> {
  if (args.accessToken?.trim()) return args.accessToken.trim()

  const envToken = process.env[args.tokenEnv]?.trim()
  if (envToken) return envToken

  if (args.useGcloud) {
    const { stdout } = await execFileAsync('gcloud', ['auth', 'print-access-token'])
    const token = stdout.trim()
    if (token) return token
  }

  throw new Error(
    `No Cloud Logging access token found. Set ${args.tokenEnv}, pass --access-token, or use --use-gcloud.`,
  )
}

function isLogEntryArray(value: unknown): value is CloudRunLogEntry[] {
  return Array.isArray(value)
}

function readEntriesFromFixture(value: unknown): CloudRunLogEntry[] {
  if (isLogEntryArray(value)) return value
  if (value && typeof value === 'object') {
    const object = value as {
      entries?: unknown
      responses?: Array<{ entries?: unknown }>
    }
    if (isLogEntryArray(object.entries)) return object.entries
    if (Array.isArray(object.responses)) {
      return object.responses.flatMap((response) => (
        isLogEntryArray(response.entries) ? response.entries : []
      ))
    }
  }
  throw new Error('Fixture must be an array of LogEntry objects, { entries }, or { responses: [{ entries }] }')
}

async function pullFromFixture(fixturePath: string): Promise<PullResult> {
  const raw = await fs.readFile(fixturePath, 'utf-8')
  const entries = readEntriesFromFixture(JSON.parse(raw) as unknown)
  const events: PullResult['events'] = []
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
    filter: `fixture:${fixturePath}`,
  }
}

async function pullFromCloudLogging(args: Args, startTime: string, endTime: string): Promise<PullResult> {
  if (!args.gcpProjectId) throw new Error('--gcp-project is required unless --fixture is used')
  const accessToken = await resolveAccessToken(args)
  return listCloudRunTrafficEvents(accessToken, {
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
}

function printSummary(output: {
  probe: {
    rawEntryCount: number
    normalizedEventCount: number
    skippedEntryCount: number
    nextPageToken?: string
    filter: string
    outputPath?: string
  }
  report: ReturnType<typeof buildTrafficProbeReport>
}): void {
  const { probe, report } = output
  console.log('Cloud Run traffic probe')
  console.log(`Raw entries: ${probe.rawEntryCount}`)
  console.log(`Normalized events: ${probe.normalizedEventCount}`)
  console.log(`Skipped entries: ${probe.skippedEntryCount}`)
  console.log(`Crawler hits: ${report.totals.crawlerHits}`)
  console.log(`Explicit AI referral hits: ${report.totals.aiReferralHits}`)
  console.log(`Unknown hits: ${report.totals.unknownHits}`)
  console.log(`Filter: ${probe.filter}`)
  if (probe.nextPageToken) console.log(`Next page token: ${probe.nextPageToken}`)
  if (probe.outputPath) console.log(`Wrote report: ${probe.outputPath}`)

  if (report.topBots.length > 0) {
    console.log('\nTop crawler bots:')
    for (const row of report.topBots) {
      console.log(`  ${row.botId} (${row.operator}): ${row.hits}`)
    }
  }

  if (report.topAiReferrers.length > 0) {
    console.log('\nTop AI referrers:')
    for (const row of report.topAiReferrers) {
      console.log(`  ${row.sourceDomain} (${row.product}): ${row.hits}`)
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return
  }

  const { startTime, endTime } = resolveWindow(args.since, args.until)
  const pull = args.fixture
    ? await pullFromFixture(args.fixture)
    : await pullFromCloudLogging(args, startTime, endTime)

  const events = pull.events.filter((event): event is NonNullable<typeof event> => event !== null)
  const report = buildTrafficProbeReport(events)
  const outputPath = args.out ? path.resolve(args.out) : undefined
  const output = {
    probe: {
      source: args.fixture ? 'fixture' : 'cloud-run',
      gcpProjectId: args.gcpProjectId ?? null,
      serviceName: args.serviceName ?? null,
      location: args.location ?? null,
      startTime,
      endTime,
      pageSize: args.pageSize,
      maxPages: args.maxPages,
      narrowBots: args.narrowBots,
      urlContains: args.urlContains,
      rawEntryCount: pull.rawEntryCount,
      normalizedEventCount: events.length,
      skippedEntryCount: pull.skippedEntryCount,
      nextPageToken: pull.nextPageToken,
      filter: pull.filter,
      outputPath,
    },
    report,
  }

  if (outputPath) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`)
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
