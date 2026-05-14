import { createApiClient } from '../client.js'
import type { ApiClient, DiscoveryRunStartResponse } from '../client.js'
import type {
  DiscoveryBucket,
  DiscoveryPromotePreview,
  DiscoveryPromoteRequest,
  DiscoverySessionDetailDto,
  DiscoverySessionDto,
} from '@ainyc/canonry-contracts'
import { CliError } from '../cli-error.js'

const TERMINAL_DISCOVERY_STATUSES = new Set<DiscoverySessionDto['status']>([
  'completed',
  'failed',
])

function getClient(): ApiClient {
  return createApiClient()
}

export interface DiscoverRunOptions {
  icp?: string
  icpAngles?: string[]
  dedupThreshold?: number
  maxProbes?: number
  wait?: boolean
  format?: string
}

function buildRunBody(opts: DiscoverRunOptions, icpDescription?: string): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (icpDescription) body.icpDescription = icpDescription
  if (opts.dedupThreshold !== undefined) body.dedupThreshold = opts.dedupThreshold
  if (opts.maxProbes !== undefined) body.maxProbes = opts.maxProbes
  return body
}

export function resolveIcpAngles(opts: DiscoverRunOptions): Array<string | undefined> {
  if (opts.icpAngles && opts.icpAngles.length > 0) return opts.icpAngles
  if (opts.icp) return [opts.icp]
  return [undefined]
}

export async function discoverRun(project: string, opts: DiscoverRunOptions): Promise<void> {
  const client = getClient()
  const angles = resolveIcpAngles(opts)

  const runs: Array<{ angle: string | undefined; start: DiscoveryRunStartResponse }> = []
  for (const angle of angles) {
    const body = buildRunBody(opts, angle)
    const start = await client.triggerDiscoveryRun(project, body)
    runs.push({ angle, start })
  }

  if (!opts.wait) {
    if (opts.format === 'json') {
      console.log(JSON.stringify(runs.length === 1 ? runs[0]!.start : runs.map(r => r.start), null, 2))
      return
    }
    for (const { angle, start } of runs) {
      if (angle) console.log(`[${angle}]`)
      console.log(`Discovery run started: ${start.runId}`)
      console.log(`  Session: ${start.sessionId}`)
      console.log(`  Status:  ${start.status}`)
      console.log(`  Tail:    canonry discover show ${project} ${start.sessionId}`)
      if (runs.length > 1) console.log()
    }
    return
  }

  const results = await Promise.all(
    runs.map(r => pollSession(client, project, r.start.sessionId).then(session => ({ angle: r.angle, session }))),
  )

  if (opts.format === 'json') {
    console.log(JSON.stringify(results.length === 1 ? results[0]!.session : results.map(r => r.session), null, 2))
    return
  }

  for (const { angle, session } of results) {
    if (angle) console.log(`## ICP angle: ${angle}\n`)
    printSessionDetail(session)
    if (results.length > 1) console.log()
  }

  if (results.length > 1) {
    const totalProbes = results.reduce((sum, r) => sum + (r.session.probeCount ?? 0), 0)
    const totalCited = results.reduce((sum, r) => sum + (r.session.citedCount ?? 0), 0)
    const totalWasted = results.reduce((sum, r) => sum + (r.session.wastedCount ?? 0), 0)
    const totalAsp = results.reduce((sum, r) => sum + (r.session.aspirationalCount ?? 0), 0)
    console.log(`── Summary across ${results.length} angle(s) ──`)
    console.log(`  Probes: ${totalProbes}  Cited: ${totalCited}  Wasted: ${totalWasted}  Aspirational: ${totalAsp}`)
    console.log('\n  Promote each session:')
    for (const { session } of results) {
      console.log(`    canonry discover promote ${project} ${session.id}`)
    }
  }
}

export async function discoverSeed(project: string, opts: DiscoverRunOptions): Promise<void> {
  // PR 1 ships a single combined seed+probe pipeline behind one POST.
  // The `seed` subcommand is offered for symmetry with a planned future flow
  // (`canonry discover seed → review → probe`); for now it kicks off the
  // same combined pipeline and aliases the experience.
  await discoverRun(project, opts)
}

export async function discoverProbe(project: string, sessionId: string, opts: { format?: string }): Promise<void> {
  // PR 1's combined pipeline already probes during `discover run`. The probe
  // subcommand is provided as a read-only inspection of an existing session
  // until a later PR splits the phases.
  const client = getClient()
  const session = await client.getDiscoverySession(project, sessionId)
  if (opts.format === 'json') {
    console.log(JSON.stringify(session, null, 2))
    return
  }
  printSessionDetail(session)
}

export async function discoverList(project: string, opts: { limit?: number; format?: string }): Promise<void> {
  const client = getClient()
  const sessions = await client.listDiscoverySessions(project, opts.limit !== undefined ? { limit: opts.limit } : undefined)
  if (opts.format === 'json') {
    console.log(JSON.stringify(sessions, null, 2))
    return
  }
  if (sessions.length === 0) {
    console.log(`No discovery sessions for "${project}".`)
    return
  }
  console.log(`Discovery sessions for "${project}" (${sessions.length}):\n`)
  console.log('  ID                                    STATUS      PROBES  CITED  WASTED  ASPIR.  CREATED')
  console.log('  ────────────────────────────────────  ──────────  ──────  ─────  ──────  ──────  ───────────────────────')
  for (const s of sessions) {
    const id = s.id.padEnd(36)
    const status = (s.status ?? '').padEnd(10)
    const probes = String(s.probeCount ?? 0).padStart(6)
    const cited = String(s.citedCount ?? 0).padStart(5)
    const wasted = String(s.wastedCount ?? 0).padStart(6)
    const asp = String(s.aspirationalCount ?? 0).padStart(6)
    console.log(`  ${id}  ${status}  ${probes}  ${cited}  ${wasted}  ${asp}  ${s.createdAt}`)
  }
}

export async function discoverShow(project: string, sessionId: string, opts: { format?: string }): Promise<void> {
  const client = getClient()
  const session = await client.getDiscoverySession(project, sessionId)
  if (opts.format === 'json') {
    console.log(JSON.stringify(session, null, 2))
    return
  }
  printSessionDetail(session)
}

export async function discoverPromotePreview(project: string, sessionId: string, opts: { format?: string }): Promise<void> {
  const client = getClient()
  const preview: DiscoveryPromotePreview = await client.previewDiscoveryPromote(project, sessionId)
  if (opts.format === 'json') {
    console.log(JSON.stringify(preview, null, 2))
    return
  }
  console.log(`Promote preview for session ${sessionId} (status: ${preview.status}):`)
  console.log(`  Cited (${preview.queriesByBucket.cited.length})`)
  for (const q of preview.queriesByBucket.cited.slice(0, 10)) console.log(`    + ${q}`)
  console.log(`  Wasted-surface (${preview.queriesByBucket['wasted-surface'].length})`)
  for (const q of preview.queriesByBucket['wasted-surface'].slice(0, 10)) console.log(`    + ${q}`)
  console.log(`  Aspirational (${preview.queriesByBucket.aspirational.length})`)
  for (const q of preview.queriesByBucket.aspirational.slice(0, 10)) console.log(`    + ${q}`)
  if (preview.suggestedCompetitors.length > 0) {
    console.log(`  Suggested new competitors:`)
    for (const c of preview.suggestedCompetitors) console.log(`    - ${c.domain} (${c.hits} hits)`)
  }
  console.log(`\n  Run \`canonry discover promote ${project} ${sessionId}\` to merge cited + aspirational queries.`)
  console.log('  Add `--bucket wasted-surface` only when off-ICP competitor gaps should be tracked.')
}

export interface DiscoverPromoteOptions {
  buckets?: DiscoveryBucket[]
  includeCompetitors?: boolean
  format?: string
}

export async function discoverPromote(
  project: string,
  sessionId: string,
  opts: DiscoverPromoteOptions,
): Promise<void> {
  const client = getClient()
  const body: DiscoveryPromoteRequest = {}
  if (opts.buckets && opts.buckets.length > 0) body.buckets = opts.buckets
  if (opts.includeCompetitors === false) body.includeCompetitors = false

  const result = await client.promoteDiscovery(project, sessionId, body)
  if (opts.format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  const { promoted, skipped } = result
  console.log(`Promoted discovery session ${sessionId} into "${project}":`)
  console.log(`  Queries:     ${promoted.queries.length} added, ${skipped.queries.length} already tracked`)
  for (const q of promoted.queries) console.log(`    + ${q}`)
  console.log(`  Competitors: ${promoted.competitors.length} added, ${skipped.competitors.length} already tracked`)
  for (const c of promoted.competitors) console.log(`    + ${c}`)
  if (promoted.queries.length === 0 && promoted.competitors.length === 0) {
    console.log(`  Nothing new — the project's basket already covers this session.`)
  }
}

function printSessionDetail(session: DiscoverySessionDetailDto): void {
  console.log(`Discovery session: ${session.id}`)
  console.log(`  Status:        ${session.status}`)
  if (session.icpDescription) console.log(`  ICP:           ${session.icpDescription}`)
  if (session.seedProvider) console.log(`  Seed provider: ${session.seedProvider}`)
  if (session.dedupThreshold != null) console.log(`  Dedup thresh:  ${session.dedupThreshold}`)
  if (session.seedCountRaw != null && session.seedCount != null) {
    console.log(`  Seed candidates: ${session.seedCount} (raw ${session.seedCountRaw})`)
  }
  if (session.probeCount != null) console.log(`  Probes:        ${session.probeCount}`)
  console.log(`  Buckets:       cited=${session.citedCount ?? 0}  wasted-surface=${session.wastedCount ?? 0}  aspirational=${session.aspirationalCount ?? 0}`)
  if (session.competitorMap.length > 0) {
    console.log(`  Top recurring competitor domains:`)
    for (const c of session.competitorMap.slice(0, 10)) console.log(`    - ${c.domain} (${c.hits} hits)`)
  }
  if (session.error) console.log(`  Error:         ${session.error}`)
  if (session.startedAt) console.log(`  Started:       ${session.startedAt}`)
  if (session.finishedAt) console.log(`  Finished:      ${session.finishedAt}`)
  console.log(`  Created:       ${session.createdAt}`)

  if (session.probes && session.probes.length > 0) {
    const sorted = [...session.probes].sort((a, b) => (a.bucket ?? '').localeCompare(b.bucket ?? ''))
    console.log(`\n  Probes (${session.probes.length}):`)
    for (const p of sorted) {
      const bucket = (p.bucket ?? '–').padEnd(15)
      const cit = p.citationState === 'cited' ? 'C' : 'c'
      console.log(`    [${cit}]  ${bucket}  ${p.query}`)
    }
  }
}

const POLL_INTERVAL_MS = 3000
const POLL_TIMEOUT_MS = 15 * 60 * 1000

async function pollSession(
  client: ApiClient,
  project: string,
  sessionId: string,
): Promise<DiscoverySessionDetailDto> {
  process.stderr.write(`Waiting for discovery session ${sessionId}`)
  const deadline = Date.now() + POLL_TIMEOUT_MS
  for (;;) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
    if (Date.now() > deadline) {
      throw new CliError({
        code: 'DISCOVERY_TIMEOUT',
        message: `Timed out waiting for discovery session ${sessionId} after ${POLL_TIMEOUT_MS / 1000}s`,
      })
    }
    const session = await client.getDiscoverySession(project, sessionId)
    process.stderr.write('.')
    if (TERMINAL_DISCOVERY_STATUSES.has(session.status)) {
      process.stderr.write('\n')
      return session
    }
  }
}
