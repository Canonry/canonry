#!/usr/bin/env tsx
// End-to-end smoke test for the Phase 2 traffic-sync auth + pull + classifier
// pipeline. The DB upsert path is covered by `packages/api-routes/test/traffic.test.ts`
// against an in-memory SQLite — what those tests can't cover is real Cloud
// Logging access with a real SA key (or gcloud token), which is what this
// script exercises.
//
// Compare the totals printed here to:
//   pnpm tsx scripts/test-cloud-run-traffic-pull.ts --gcp-project <id> --use-gcloud --since <window>
// They should match for the same window.
//
// Usage:
//   pnpm tsx scripts/smoke-traffic-sync.ts \
//     --gcp-project openclaw-nyc \
//     --service openclaw-nyc \
//     --location us-east1 \
//     --service-account-key /Users/arberx/Downloads/openclaw-nyc-9ff6d4cfa430.json \
//     --since-minutes 1440
//
//   pnpm tsx scripts/smoke-traffic-sync.ts \
//     --gcp-project openclaw-nyc --service openclaw-nyc --location us-east1 \
//     --use-gcloud --since-minutes 1440

import fs from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  listCloudRunTrafficEvents,
  getCloudLoggingAccessToken,
} from '../packages/integration-cloud-run/src/index.js'
import { buildTrafficProbeReport } from '../packages/integration-traffic/src/index.js'

const execFileAsync = promisify(execFile)

interface Args {
  gcpProject: string
  service?: string
  location?: string
  saKeyPath?: string
  useGcloud: boolean
  sinceMinutes: number
  pageSize: number
  maxPages: number
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    gcpProject: '',
    sinceMinutes: 60,
    pageSize: 1000,
    maxPages: 5,
    useGcloud: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--gcp-project':
        args.gcpProject = argv[++i] ?? ''
        break
      case '--service':
        args.service = argv[++i]
        break
      case '--location':
        args.location = argv[++i]
        break
      case '--service-account-key':
        args.saKeyPath = argv[++i]
        break
      case '--use-gcloud':
        args.useGcloud = true
        break
      case '--since-minutes':
        args.sinceMinutes = parseInt(argv[++i] ?? '60', 10) || 60
        break
      case '--page-size':
        args.pageSize = parseInt(argv[++i] ?? '1000', 10) || 1000
        break
      case '--max-pages':
        args.maxPages = parseInt(argv[++i] ?? '5', 10) || 5
        break
      case '-h':
      case '--help':
        printUsage()
        process.exit(0)
        break
      default:
        if (arg) {
          console.error(`Unknown argument: ${arg}`)
          printUsage()
          process.exit(1)
        }
    }
  }
  if (!args.gcpProject) {
    console.error('Missing required: --gcp-project')
    process.exit(1)
  }
  if (!args.saKeyPath && !args.useGcloud) {
    console.error('Provide either --service-account-key <path> or --use-gcloud')
    process.exit(1)
  }
  return args
}

function printUsage() {
  console.log(`Usage: pnpm tsx scripts/smoke-traffic-sync.ts \\
  --gcp-project <id> \\
  (--service-account-key <path> | --use-gcloud) \\
  [--service <service-name>] [--location <region>] \\
  [--since-minutes 60] [--page-size 1000] [--max-pages 5]`)
}

async function resolveAccessToken(args: Args): Promise<string> {
  if (args.useGcloud) {
    const { stdout } = await execFileAsync('gcloud', ['auth', 'print-access-token'])
    return stdout.trim()
  }
  if (!args.saKeyPath) throw new Error('No credential path supplied')
  const raw = fs.readFileSync(args.saKeyPath, 'utf-8')
  const parsed = JSON.parse(raw) as { client_email?: string; private_key?: string }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error('Service-account JSON missing client_email or private_key')
  }
  return getCloudLoggingAccessToken(parsed.client_email, parsed.private_key)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  console.log(`[1/3] Resolving Cloud Logging access token (${args.useGcloud ? 'gcloud' : 'service-account'})…`)
  const accessToken = await resolveAccessToken(args)
  console.log(`      → token resolved (length=${accessToken.length})`)

  const windowEnd = new Date()
  const windowStart = new Date(windowEnd.getTime() - args.sinceMinutes * 60_000)
  console.log(`[2/3] Pulling Cloud Run logs ${windowStart.toISOString()} → ${windowEnd.toISOString()}`)
  const page = await listCloudRunTrafficEvents(accessToken, {
    gcpProjectId: args.gcpProject,
    serviceName: args.service,
    location: args.location,
    startTime: windowStart.toISOString(),
    endTime: windowEnd.toISOString(),
    pageSize: args.pageSize,
    maxPages: args.maxPages,
  })
  console.log(`      → ${page.events.length} normalized events (raw entries=${page.rawEntryCount})`)
  console.log(`      → filter: ${page.filter.split('\n').join(' | ')}`)

  console.log(`[3/3] Classifying events into hourly buckets (the same path the API route runs)…`)
  const report = buildTrafficProbeReport(page.events, { sampleLimit: 50 })
  console.log(`      totals:`)
  console.log(`        normalized events:  ${report.totals.normalizedEvents}`)
  console.log(`        crawler hits:       ${report.totals.crawlerHits}`)
  console.log(`        ai-referral hits:   ${report.totals.aiReferralHits}`)
  console.log(`        unknown hits:       ${report.totals.unknownHits}`)
  console.log(`      crawler hourly buckets: ${report.crawlerEventsHourly.length}`)
  for (const bucket of report.crawlerEventsHourly.slice(0, 12)) {
    console.log(`        ${bucket.tsHour}  ${bucket.botId.padEnd(22)} hits=${String(bucket.hits).padStart(4)}  ${bucket.pathNormalized}`)
  }
  if (report.crawlerEventsHourly.length > 12) console.log(`        … (+${report.crawlerEventsHourly.length - 12} more)`)
  console.log(`      ai-referral hourly buckets: ${report.aiReferralEventsHourly.length}`)
  for (const bucket of report.aiReferralEventsHourly.slice(0, 12)) {
    console.log(`        ${bucket.tsHour}  ${bucket.product.padEnd(15)} hits=${String(bucket.hits).padStart(4)}  ${bucket.landingPathNormalized}  (${bucket.evidenceType})`)
  }
  console.log(`      top bots:`)
  for (const bot of report.topBots) console.log(`        ${bot.botId.padEnd(24)} ${bot.operator.padEnd(12)} hits=${bot.hits}`)
  console.log(`      top crawler paths:`)
  for (const p of report.topCrawlerPaths.slice(0, 10)) console.log(`        ${String(p.hits).padStart(4)}  ${p.pathNormalized}`)

  console.log('')
  console.log('Smoke passed. Equivalence check command:')
  console.log(`  pnpm tsx scripts/test-cloud-run-traffic-pull.ts \\`)
  console.log(`    --gcp-project ${args.gcpProject}${args.service ? ` --service ${args.service}` : ''}${args.location ? ` --location ${args.location}` : ''} \\`)
  console.log(`    --use-gcloud --since ${Math.ceil(args.sinceMinutes / 60)}h`)
}

main().catch((err) => {
  console.error('Smoke test failed:', err instanceof Error ? err.message : err)
  if (err instanceof Error && err.stack) console.error(err.stack)
  process.exit(1)
})
