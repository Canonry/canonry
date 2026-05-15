import { createApiClient } from '../client.js'
import type { ApiClient, DiscoveryRunStartResponse } from '../client.js'
import type {
  DiscoveryBucket,
  DiscoveryCompetitorType,
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
  /** Project location labels to geo-constrain seed generation. Resolved server-side; omit to use every project location. */
  locations?: string[]
  wait?: boolean
  format?: string
}

function buildRunBody(opts: DiscoverRunOptions, icpDescription?: string): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (icpDescription) body.icpDescription = icpDescription
  if (opts.dedupThreshold !== undefined) body.dedupThreshold = opts.dedupThreshold
  if (opts.maxProbes !== undefined) body.maxProbes = opts.maxProbes
  if (opts.locations && opts.locations.length > 0) body.locations = opts.locations
  return body
}

export interface ResolvedIcpAngles {
  /** One entry per discovery session to start. `undefined` lets the API fall back to the project-stored ICP. */
  angles: Array<string | undefined>
  /** True when `--icp-angle` supplied at least one non-empty value — drives array-vs-object JSON output. */
  multiAngle: boolean
}

export function resolveIcpAngles(opts: DiscoverRunOptions): ResolvedIcpAngles {
  const angles = (opts.icpAngles ?? []).map(a => a.trim()).filter(a => a.length > 0)
  if (angles.length > 0) return { angles, multiAngle: true }
  const icp = opts.icp?.trim()
  if (icp) return { angles: [icp], multiAngle: false }
  return { angles: [undefined], multiAngle: false }
}

export interface AngleSummary {
  angleCount: number
  totalProbes: number
  totalCited: number
  totalWasted: number
  totalAspirational: number
}

type DiscoverySessionCounts = Pick<
  DiscoverySessionDetailDto,
  'probeCount' | 'citedCount' | 'wastedCount' | 'aspirationalCount'
>

export function summarizeAngles(sessions: readonly DiscoverySessionCounts[]): AngleSummary {
  return {
    angleCount: sessions.length,
    totalProbes: sessions.reduce((sum, s) => sum + (s.probeCount ?? 0), 0),
    totalCited: sessions.reduce((sum, s) => sum + (s.citedCount ?? 0), 0),
    totalWasted: sessions.reduce((sum, s) => sum + (s.wastedCount ?? 0), 0),
    totalAspirational: sessions.reduce((sum, s) => sum + (s.aspirationalCount ?? 0), 0),
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export async function discoverRun(project: string, opts: DiscoverRunOptions): Promise<void> {
  const client = getClient()
  const { angles, multiAngle } = resolveIcpAngles(opts)

  const runs: Array<{ angle: string | undefined; start: DiscoveryRunStartResponse }> = []
  for (const angle of angles) {
    try {
      const start = await client.triggerDiscoveryRun(project, buildRunBody(opts, angle))
      runs.push({ angle, start })
    } catch (err) {
      // A trigger failure mid-loop leaves earlier sessions already running
      // server-side — surface their IDs so the operator can recover them.
      if (runs.length > 0) {
        process.stderr.write(
          `\nFailed to start ${angle ? `angle "${angle}"` : 'discovery run'}: ${errorMessage(err)}\n` +
            `Sessions already started (recover with \`canonry discover show ${project} <id>\`):\n` +
            runs.map(r => `  ${r.start.sessionId}`).join('\n') +
            '\n',
        )
      }
      throw err
    }
  }

  if (!opts.wait) {
    if (opts.format === 'json') {
      console.log(JSON.stringify(multiAngle ? runs.map(r => r.start) : runs[0]!.start, null, 2))
      return
    }
    for (const { angle, start } of runs) {
      if (angle) console.log(`[${angle}]`)
      // The headline must tell the operator whether a fresh sweep started or
      // whether the route latched onto an in-flight one — otherwise the
      // expensive Gemini seed call looks identical from the CLI. Issue #498.
      if (start.consolidated) {
        console.log(`Reusing in-flight discovery session: ${start.sessionId}`)
        console.log(`  Run:     ${start.runId}`)
        console.log(`  Status:  ${start.status}`)
        console.log(`  Tail:    canonry discover show ${project} ${start.sessionId}`)
      } else {
        console.log(`Discovery run started: ${start.runId}`)
        console.log(`  Session: ${start.sessionId}`)
        console.log(`  Status:  ${start.status}`)
        console.log(`  Tail:    canonry discover show ${project} ${start.sessionId}`)
      }
      if (runs.length > 1) console.log()
    }
    return
  }

  // Poll every session even if some fail — one timeout must not discard the
  // sessions that completed. Multiple sessions poll quietly under a single
  // status line so their progress dots don't interleave on stderr.
  const parallel = runs.length > 1
  if (parallel) process.stderr.write(`Waiting for ${runs.length} discovery sessions...\n`)
  const settled = await Promise.allSettled(
    runs.map(r => pollSession(client, project, r.start.sessionId, parallel)),
  )

  const results: Array<{ angle: string | undefined; session: DiscoverySessionDetailDto }> = []
  const failures: Array<{ angle: string | undefined; sessionId: string; reason: unknown }> = []
  settled.forEach((outcome, i) => {
    const run = runs[i]!
    if (outcome.status === 'fulfilled') {
      results.push({ angle: run.angle, session: outcome.value })
    } else {
      failures.push({ angle: run.angle, sessionId: run.start.sessionId, reason: outcome.reason })
    }
  })

  if (results.length > 0) {
    if (opts.format === 'json') {
      console.log(JSON.stringify(multiAngle ? results.map(r => r.session) : results[0]!.session, null, 2))
    } else {
      for (const { angle, session } of results) {
        if (angle) console.log(`## ICP angle: ${angle}\n`)
        printSessionDetail(session)
        if (results.length > 1) console.log()
      }
      if (results.length > 1) {
        const summary = summarizeAngles(results.map(r => r.session))
        console.log(`── Summary across ${summary.angleCount} angle(s) ──`)
        console.log(
          `  Probes: ${summary.totalProbes}  Cited: ${summary.totalCited}` +
            `  Wasted: ${summary.totalWasted}  Aspirational: ${summary.totalAspirational}`,
        )
        console.log('\n  Promote each session:')
        for (const { session } of results) {
          console.log(`    canonry discover promote ${project} ${session.id}`)
        }
      }
    }
  }

  if (failures.length > 0) {
    // Single-angle (legacy) path: surface the original poll error untouched.
    if (!multiAngle) throw failures[0]!.reason
    for (const f of failures) {
      process.stderr.write(
        `Discovery session ${f.sessionId}${f.angle ? ` ("${f.angle}")` : ''} did not complete: ${errorMessage(f.reason)}\n`,
      )
    }
    throw new CliError({
      code: 'DISCOVERY_INCOMPLETE',
      message: `${failures.length} of ${runs.length} discovery session(s) did not complete`,
      details: { failed: failures.map(f => f.sessionId) },
    })
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
    for (const c of preview.suggestedCompetitors) {
      console.log(`    - ${c.domain} (${c.hits} hits, ${c.competitorType})`)
    }
    console.log('    Only direct-competitor is promoted by default — pass --competitor-types to include other types.')
  }
  console.log(`\n  Run \`canonry discover promote ${project} ${sessionId}\` to merge cited + aspirational queries.`)
  console.log('  Add `--bucket wasted-surface` only when off-ICP competitor gaps should be tracked.')
}

export interface DiscoverPromoteOptions {
  buckets?: DiscoveryBucket[]
  competitorTypes?: DiscoveryCompetitorType[]
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
  if (opts.competitorTypes && opts.competitorTypes.length > 0) body.competitorTypes = opts.competitorTypes
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
    for (const c of session.competitorMap.slice(0, 10)) {
      console.log(`    - ${c.domain} (${c.hits} hits, ${c.competitorType})`)
    }
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
  quiet = false,
): Promise<DiscoverySessionDetailDto> {
  if (!quiet) process.stderr.write(`Waiting for discovery session ${sessionId}`)
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
    if (!quiet) process.stderr.write('.')
    if (TERMINAL_DISCOVERY_STATUSES.has(session.status)) {
      if (!quiet) process.stderr.write('\n')
      return session
    }
  }
}
