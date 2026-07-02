import fs from 'node:fs'
import path from 'node:path'
import type { DiscoverySessionDto } from '@ainyc/canonry-contracts'
import { CliError, EXIT_USER_ERROR } from '../cli-error.js'
import { createApiClient } from '../client.js'
import {
  DISCOVERY_EVAL_PANEL,
  compareToBaseline,
  scoreSession,
  type DiscoveryEvalBaseline,
  type DiscoveryEvalScorecard,
  type DiscoveryEvalShape,
  type DiscoveryEvalVerdict,
} from '../discovery-eval.js'

/**
 * `canonry discover eval` — the live half of the discovery quality-regression
 * harness. Runs the fixed ICP panel as REAL discovery sessions against the
 * configured instance, scores each shape, and compares against a committed
 * baseline file. Run it before adopting a new engine build or after changing
 * seed prompts / providers / thresholds. Costs real provider spend
 * (~$0.10-0.30 per shape at the default probe budget of 2).
 */

const DEFAULT_BASELINE_PATH = 'canonry-discovery-eval-baseline.json'
const POLL_INTERVAL_MS = 5_000
const SHAPE_TIMEOUT_MS = 10 * 60_000

/** The subset of ApiClient the eval consumes — injectable for tests. */
export interface DiscoverEvalClient {
  putProject(name: string, body: object): Promise<unknown>
  triggerDiscoveryRun(
    name: string,
    body?: {
      icpDescription?: string
      buyerDescription?: string
      seedProviders?: Array<'gemini' | 'openai'>
      maxProbes?: number
      probeConcurrency?: number
    },
  ): Promise<{ sessionId?: unknown }>
  listDiscoverySessions(project: string, opts?: { limit?: number }): Promise<DiscoverySessionDto[]>
}

export interface DiscoverEvalOptions {
  baseline?: string
  updateBaseline?: boolean
  shapes?: string[]
  seedProviders?: Array<'gemini' | 'openai'>
  maxProbes?: number
  probeConcurrency?: number
  format?: string
  /** Test seams. */
  pollIntervalMs?: number
  shapeTimeoutMs?: number
  now?: () => number
}

export async function runDiscoveryEvalPanel(
  client: DiscoverEvalClient,
  shapes: readonly DiscoveryEvalShape[],
  opts: DiscoverEvalOptions,
): Promise<DiscoveryEvalScorecard[]> {
  const scorecards: DiscoveryEvalScorecard[] = []
  const pollInterval = opts.pollIntervalMs ?? POLL_INTERVAL_MS
  const timeout = opts.shapeTimeoutMs ?? SHAPE_TIMEOUT_MS
  const now = opts.now ?? Date.now

  // Shapes run sequentially: deterministic pacing on one provider key, and a
  // failure surfaces immediately instead of five aborted sessions at once.
  for (const shape of shapes) {
    await client.putProject(shape.slug, {
      displayName: shape.displayName,
      canonicalDomain: shape.domain,
      country: 'US',
      language: 'en',
      ...(shape.locations.length > 0
        ? { locations: shape.locations, defaultLocation: shape.locations[0]!.label }
        : {}),
    })
    const started = await client.triggerDiscoveryRun(shape.slug, {
      icpDescription: shape.icp,
      buyerDescription: shape.buyer,
      maxProbes: opts.maxProbes ?? 2,
      probeConcurrency: opts.probeConcurrency ?? 2,
      ...(opts.seedProviders && opts.seedProviders.length > 0 ? { seedProviders: opts.seedProviders } : {}),
    })
    const sessionId = typeof started.sessionId === 'string' ? started.sessionId : ''
    if (!sessionId) {
      throw new CliError({
        code: 'EVAL_SESSION_START_FAILED',
        message: `${shape.slug}: discover run returned no sessionId`,
        exitCode: EXIT_USER_ERROR,
      })
    }
    const deadline = now() + timeout
    let session: DiscoverySessionDto | undefined
    for (;;) {
      const rows = await client.listDiscoverySessions(shape.slug, { limit: 10 })
      session = rows.find((r) => r.id === sessionId)
      if (session?.status === 'completed') break
      if (session?.status === 'failed') {
        throw new CliError({
          code: 'EVAL_SESSION_FAILED',
          message: `${shape.slug}: discovery session failed`,
          exitCode: EXIT_USER_ERROR,
          details: { sessionId },
        })
      }
      if (now() > deadline) {
        throw new CliError({
          code: 'EVAL_SESSION_TIMEOUT',
          message: `${shape.slug}: session did not complete within ${Math.round(timeout / 60000)} minutes`,
          exitCode: EXIT_USER_ERROR,
          details: { sessionId },
        })
      }
      await new Promise((r) => setTimeout(r, pollInterval))
    }
    scorecards.push(scoreSession(shape.slug, session))
  }
  return scorecards
}

function renderHuman(scorecards: readonly DiscoveryEvalScorecard[], verdict: DiscoveryEvalVerdict | null): void {
  console.log('SHAPE                          RAW  CANON  RETENTION  BRAND  GROUND  BAND   TIME')
  for (const c of scorecards) {
    console.log(
      [
        c.shape.padEnd(30),
        String(c.seedCountRaw).padStart(4),
        String(c.canonicalCount).padStart(6) + (c.canonicalCountTruncated ? '*' : ' '),
        c.retention.toFixed(2).padStart(9),
        c.brandShare.toFixed(2).padStart(6),
        c.groundingShare.toFixed(2).padStart(7),
        (c.bandPairFraction ?? 0).toFixed(2).padStart(5),
        c.durationSeconds == null ? '   ?' : `${String(c.durationSeconds).padStart(4)}s`,
      ].join(' '),
    )
    if (c.warning) console.log(`  warning: ${c.warning}`)
  }
  if (verdict) {
    for (const note of verdict.notes) console.log(`note: ${note}`)
    for (const regression of verdict.regressions) console.log(`REGRESSION: ${regression}`)
    console.log(verdict.pass ? 'PASS: no regressions against the baseline.' : 'FAIL: regressions detected.')
  } else {
    console.log('No baseline compared (wrote or missing baseline).')
  }
}

export async function discoverEvalWithClient(client: DiscoverEvalClient, opts: DiscoverEvalOptions): Promise<void> {
  const selected =
    opts.shapes && opts.shapes.length > 0
      ? DISCOVERY_EVAL_PANEL.filter((s) => opts.shapes!.includes(s.slug))
      : DISCOVERY_EVAL_PANEL
  if (selected.length === 0) {
    throw new CliError({
      code: 'EVAL_NO_SHAPES',
      message: `no matching shapes; known: ${DISCOVERY_EVAL_PANEL.map((s) => s.slug).join(', ')}`,
      exitCode: EXIT_USER_ERROR,
    })
  }

  const scorecards = await runDiscoveryEvalPanel(client, selected, opts)
  const baselinePath = path.resolve(opts.baseline ?? DEFAULT_BASELINE_PATH)

  if (opts.updateBaseline) {
    const baseline: DiscoveryEvalBaseline = { capturedAt: new Date().toISOString(), scorecards }
    fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n')
    if (opts.format === 'json' || opts.format === 'jsonl') {
      console.log(JSON.stringify({ scorecards, baselineWritten: baselinePath }, null, 2))
    } else {
      renderHuman(scorecards, null)
      console.log(`Baseline written: ${baselinePath}`)
    }
    return
  }

  if (!fs.existsSync(baselinePath)) {
    throw new CliError({
      code: 'EVAL_NO_BASELINE',
      message: `no baseline at ${baselinePath}; run with --update-baseline to capture one`,
      exitCode: EXIT_USER_ERROR,
    })
  }
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as DiscoveryEvalBaseline
  const verdict = compareToBaseline(scorecards, baseline)

  if (opts.format === 'json' || opts.format === 'jsonl') {
    console.log(JSON.stringify({ scorecards, verdict, baseline: { capturedAt: baseline.capturedAt } }, null, 2))
  } else {
    renderHuman(scorecards, verdict)
  }

  if (!verdict.pass) {
    throw new CliError({
      code: 'EVAL_REGRESSION',
      message: `${verdict.regressions.length} regression${verdict.regressions.length === 1 ? '' : 's'} against the baseline`,
      exitCode: EXIT_USER_ERROR,
      details: { regressions: verdict.regressions },
    })
  }
}

export async function discoverEval(opts: DiscoverEvalOptions): Promise<void> {
  await discoverEvalWithClient(createApiClient(), opts)
}
