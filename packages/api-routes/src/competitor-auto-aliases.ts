import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { competitors, projects, querySnapshots, runs, type DatabaseClient } from '@ainyc/canonry-db'
import {
  AUTO_ALIAS_SCAN_MAX_RUNS,
  AUTO_ALIAS_SCAN_MAX_SNAPSHOTS,
  competitorAliasProjectIdentity,
  competitorAutoAliasThresholds,
  createAutoAliasAccumulator,
  normalizeCompetitorAliases,
  resolveCompetitorAutoAliases,
  RunKinds,
  RunStatuses,
  type AnchoredAnswerSpan,
  type AutoAliasScores,
  type CompetitorAliasMarketPin,
  type CompetitorAutoAliasDetectionDto,
  type CompetitorAutoAliasResolution,
} from '@ainyc/canonry-contracts'
import { readStoredCompetitors, type StoredCompetitor } from './competitor-writes.js'
import { notProbeRun, writeAuditLog } from './helpers.js'
import { readMarketCompetitors, writeMarketCompetitorNames, type MarketCompetitor } from './market-competitor-names.js'
import { createPlanPinLookup, readMarketCompetitorPins } from './plan-competitors.js'

/**
 * COMPETITOR AUTO-ALIAS DETECTION OVER STORED ANSWERS.
 *
 * The DB side of `competitor-auto-aliases.ts` in contracts: scan the project's
 * stored answer-visibility answers, score every tracked competitor's
 * candidate names, and store the names that pass. Stored data only: no
 * provider call, no request to any competitor site. The scan is bounded
 * (`AUTO_ALIAS_SCAN_MAX_RUNS` newest completed or partial runs, and at most
 * `AUTO_ALIAS_SCAN_MAX_SNAPSHOTS` snapshots, stopping mid-run when the cap
 * falls inside one), excludes probe runs, lists a run's snapshot ids first
 * and reads the rows (raw responses included) a page at a time, yielding to
 * the event loop between pages, so neither one large sweep nor a large
 * project holds the server or its memory for the whole pass.
 *
 * Detection covers every project competitor and every competitor the active
 * Advanced plan pins without tracking it project-wide (`readMarketCompetitors`).
 * A market competitor keeps its market boundary: its evidence counts only the
 * answers to its markets' questions (each answer's own plan revision and
 * execution node, `createPlanPinLookup`), its plan label and aliases are its
 * curated names, and its learned names are stored for it in
 * `market_competitor_names`, never as a project competitor.
 *
 * A candidate counts as naming a competitor only outside its longer names
 * (its domain label, a curated alias, a longer stored name), so the scan
 * passes each competitor's curated names to the accumulator: a tracked
 * competitor's curated aliases, a market-only competitor's plan label and
 * aliases. A tracked competitor's own pin names are not passed.
 *
 * Callers: `GET /competitor-auto-aliases` (dry run), `POST` (apply now, in
 * every `competitorAutoAliases` mode), and the local server's unattended pass
 * after every completed or partial non-probe answer-visibility run, a
 * competitor add, an unblock and a market pin write that changes the pins,
 * which follows the project's mode: `apply`
 * stores through `createCompetitorAutoAliasRunner` (packages/canonry),
 * `preview` (the default) runs `previewCompetitorAutoAliases` and logs, `off`
 * runs nothing.
 */

/**
 * Reads the provider citation structure of one stored snapshot. Injected by
 * the host (packages/canonry `extractStoredAnswerAnchors`); without it only
 * the pairings written in the answer text count.
 */
export type CompetitorAnswerAnchorReader = (provider: string, rawResponse: string | null) => AnchoredAnswerSpan[]

export interface CompetitorAutoAliasScan {
  scores: AutoAliasScores
  runs: number
  snapshots: number
  providerCitations: boolean
}

/** Snapshots read (and parsed) per page, with an event-loop yield between pages. */
const SCAN_PAGE_SIZE = 200

type DetectionProject = Pick<typeof projects.$inferSelect, 'id' | 'name' | 'displayName' | 'aliases' | 'canonicalDomain' | 'ownedDomains'>

/** Scan the project's stored answers and score every tracked competitor's candidate names. */
export async function scanCompetitorAutoAliasEvidence(
  db: DatabaseClient,
  project: DetectionProject,
  opts: { readAnchors?: CompetitorAnswerAnchorReader; /** False keeps the whole pass on one tick (tests). */ yieldToEventLoop?: boolean } = {},
): Promise<CompetitorAutoAliasScan> {
  const tracked = readStoredCompetitors(db, project.id)
  const market = readMarketCompetitors(db, project.id, tracked)
  const marketDomains = new Set(market.map(entry => entry.domain))
  const pinsFor = createPlanPinLookup(db)
  const accumulator = createAutoAliasAccumulator({
    // Curated names (a market competitor's plan label and aliases) go in so a
    // candidate written only inside one of them is not counted as naming it.
    competitors: [
      ...tracked.map(row => ({ domain: row.domain, aliases: row.aliases })),
      ...market.map(entry => ({ domain: entry.domain, scoped: true, aliases: entry.names })),
    ],
    project: competitorAliasProjectIdentity(project),
  })
  const runRows = tracked.length === 0 && market.length === 0
    ? []
    : db.select({ id: runs.id, createdAt: runs.createdAt, planVersionId: runs.measurementPlanVersionId })
      .from(runs)
      .where(and(
        eq(runs.projectId, project.id),
        eq(runs.kind, RunKinds['answer-visibility']),
        inArray(runs.status, [RunStatuses.completed, RunStatuses.partial]),
        notProbeRun(),
      ))
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit(AUTO_ALIAS_SCAN_MAX_RUNS)
      .all()
  const pause = (): Promise<void> => (opts.yieldToEventLoop === false ? Promise.resolve() : yieldToEventLoop())
  let scannedRuns = 0
  let scannedSnapshots = 0
  for (const run of runRows) {
    if (scannedSnapshots >= AUTO_ALIAS_SCAN_MAX_SNAPSHOTS) break
    if (scannedRuns > 0) await pause()
    // Ids first (cheap), capped to what the pass may still read, so the cap
    // holds inside a run and no run is ever loaded whole.
    const ids = db.select({ id: querySnapshots.id })
      .from(querySnapshots)
      .where(eq(querySnapshots.runId, run.id))
      .orderBy(asc(querySnapshots.id))
      .limit(AUTO_ALIAS_SCAN_MAX_SNAPSHOTS - scannedSnapshots)
      .all()
      .map(row => row.id)
    if (ids.length === 0) continue
    scannedRuns++
    for (let offset = 0; offset < ids.length; offset += SCAN_PAGE_SIZE) {
      if (offset > 0) await pause()
      const rows = db.select({
        id: querySnapshots.id,
        provider: querySnapshots.provider,
        answerText: querySnapshots.answerText,
        citedDomains: querySnapshots.citedDomains,
        rawResponse: querySnapshots.rawResponse,
        executionId: querySnapshots.measurementExecutionId,
        createdAt: querySnapshots.createdAt,
      }).from(querySnapshots).where(inArray(querySnapshots.id, ids.slice(offset, offset + SCAN_PAGE_SIZE))).all()
      scannedSnapshots += rows.length
      for (const row of rows) {
        accumulator.add({
          snapshotId: row.id,
          runId: run.id,
          // Every run of one multi-location sweep is created at the same
          // moment, so they count as one sweep toward the run threshold.
          sweepKey: run.createdAt,
          createdAt: row.createdAt,
          answerText: row.answerText,
          citedDomains: row.citedDomains,
          anchors: row.answerText && opts.readAnchors ? opts.readAnchors(row.provider, row.rawResponse) : [],
          // The market competitors this answer's own revision pins for its question.
          ...(market.length > 0
            ? { scopedCompetitors: pinsFor(run.planVersionId, row.executionId).filter(domain => marketDomains.has(domain)) }
            : {}),
        })
      }
    }
  }
  return {
    scores: await accumulator.finishInChunks(
      pause,
      {
        storedNames: [
          ...tracked.flatMap(row => row.autoAliases.map(record => ({ domain: row.domain, name: record.name }))),
          ...market.flatMap(entry => (entry.stored?.autoAliases ?? []).map(record => ({ domain: entry.domain, name: record.name }))),
        ],
      },
    ),
    runs: scannedRuns,
    snapshots: scannedSnapshots,
    providerCitations: opts.readAnchors !== undefined,
  }
}

/** The competitors one pass resolves: project competitors by domain, then market-only pins by domain. */
interface DetectionTargets {
  tracked: StoredCompetitor[]
  market: MarketCompetitor[]
  /** Every pin the curated alias rules take (`readMarketCompetitorPins`). */
  marketPins: CompetitorAliasMarketPin[]
}

function readDetectionTargets(db: Parameters<typeof readMarketCompetitorPins>[0], projectId: string): DetectionTargets {
  const tracked = readStoredCompetitors(db, projectId)
  return { tracked, market: readMarketCompetitors(db, projectId, tracked), marketPins: readMarketCompetitorPins(db, projectId) }
}

/**
 * Resolve a scan against the competitors as stored now (curated may have
 * changed since the scan). Project competitors come first, so a project
 * competitor's stored name wins an overlap with a market competitor's. Every
 * market pin the curated alias rules take (the active revision, the pending
 * draft, and superseded revisions runs were measured under) claims its names
 * like a curated alias, so no competitor learns a name a pin of another
 * domain answers to.
 */
function resolveAgainst(
  targets: DetectionTargets,
  project: DetectionProject,
  scan: CompetitorAutoAliasScan,
  now: string,
): CompetitorAutoAliasResolution[] {
  return resolveCompetitorAutoAliases(
    scan.scores,
    [
      ...targets.tracked.map(row => ({
        domain: row.domain,
        aliases: row.aliases,
        autoAliases: row.autoAliases,
        blockedAliases: row.blockedAliases,
      })),
      ...targets.market.map(entry => ({
        domain: entry.domain,
        aliases: entry.names,
        autoAliases: entry.stored?.autoAliases ?? [],
        blockedAliases: entry.stored?.blockedAliases ?? [],
      })),
    ],
    competitorAliasProjectIdentity(project),
    now,
    targets.marketPins,
  )
}

function detectionDto(
  project: DetectionProject,
  targets: DetectionTargets,
  scan: CompetitorAutoAliasScan,
  resolutions: readonly CompetitorAutoAliasResolution[],
  applied: boolean,
): CompetitorAutoAliasDetectionDto {
  const states: { aliases: string[]; blockedAliases: string[]; marketKeys?: string[] }[] = [
    ...targets.tracked.map(row => ({ aliases: row.aliases, blockedAliases: row.blockedAliases })),
    ...targets.market.map(entry => ({ aliases: entry.names, blockedAliases: entry.stored?.blockedAliases ?? [], marketKeys: entry.marketKeys })),
  ]
  return {
    project: project.name,
    applied,
    changed: resolutions.some(resolution => resolution.namesChanged),
    scan: {
      runs: scan.runs,
      snapshots: scan.snapshots,
      answers: scan.scores.answers,
      maxRuns: AUTO_ALIAS_SCAN_MAX_RUNS,
      maxSnapshots: AUTO_ALIAS_SCAN_MAX_SNAPSHOTS,
      providerCitations: scan.providerCitations,
    },
    thresholds: competitorAutoAliasThresholds(),
    competitors: resolutions.map((resolution, index) => {
      const state = states[index]!
      return {
        domain: resolution.domain,
        ...(state.marketKeys ? { marketKeys: state.marketKeys } : {}),
        aliases: normalizeCompetitorAliases(state.aliases),
        autoAliases: resolution.autoAliases,
        blockedAliases: normalizeCompetitorAliases(state.blockedAliases),
        added: resolution.added,
        removed: resolution.removed,
        candidates: resolution.candidates,
      }
    }),
  }
}

/** Dry run: what detection would store now, without writing. */
export async function previewCompetitorAutoAliases(
  db: DatabaseClient,
  project: DetectionProject,
  opts: { readAnchors?: CompetitorAnswerAnchorReader; now?: string } = {},
): Promise<CompetitorAutoAliasDetectionDto> {
  const scan = await scanCompetitorAutoAliasEvidence(db, project, opts)
  const targets = readDetectionTargets(db, project.id)
  return detectionDto(project, targets, scan, resolveAgainst(targets, project, scan, opts.now ?? new Date().toISOString()), false)
}

export interface AppliedCompetitorAutoAliases {
  detection: CompetitorAutoAliasDetectionDto
  /** True when any competitor's set of auto names changed (the stored competitor fields need a recompute). */
  namesChanged: boolean
}

/**
 * Scan, then store the result. The heavy scan runs outside any transaction;
 * the write re-reads the project, its competitors and the active plan's
 * market-only pins inside one transaction and re-resolves against them, so a
 * curated edit made during the scan always wins. Writes only rows whose stored
 * auto names or evidence differ (a pass over unchanged answers writes
 * nothing): a project competitor's on `competitors`, a market competitor's on
 * `market_competitor_names`. Audits as `competitors.auto-aliases-updated`
 * (actor `system`) only when names change.
 */
export async function applyCompetitorAutoAliases(
  db: DatabaseClient,
  projectId: string,
  opts: { readAnchors?: CompetitorAnswerAnchorReader; now?: string } = {},
): Promise<AppliedCompetitorAutoAliases | null> {
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get()
  if (!project) return null
  const scan = await scanCompetitorAutoAliasEvidence(db, project, opts)
  const now = opts.now ?? new Date().toISOString()
  return db.transaction((tx) => {
    const current = tx.select().from(projects).where(eq(projects.id, projectId)).get()
    if (!current) return null
    const targets = readDetectionTargets(tx, projectId)
    const resolutions = resolveAgainst(targets, current, scan, now)
    const changes: { domain: string; marketKeys?: string[]; added: string[]; removed: CompetitorAutoAliasResolution['removed'] }[] = []
    resolutions.forEach((resolution, index) => {
      if (!resolution.recordsChanged) return
      // Resolutions follow `resolveAgainst`: project competitors, then market-only pins.
      const market = index < targets.tracked.length ? null : targets.market[index - targets.tracked.length]!
      if (market) writeMarketCompetitorNames(tx, projectId, market, { autoAliases: resolution.autoAliases }, now)
      else tx.update(competitors).set({ autoAliases: resolution.autoAliases }).where(eq(competitors.id, targets.tracked[index]!.id)).run()
      if (resolution.namesChanged) {
        changes.push({ domain: resolution.domain, ...(market ? { marketKeys: market.marketKeys } : {}), added: resolution.added, removed: resolution.removed })
      }
    })
    if (changes.length > 0) {
      writeAuditLog(tx, {
        projectId,
        actor: 'system',
        action: 'competitors.auto-aliases-updated',
        entityType: 'competitor',
        diff: { changes, scan: { runs: scan.runs, snapshots: scan.snapshots } },
      })
    }
    return {
      detection: detectionDto(current, targets, scan, resolutions, true),
      namesChanged: changes.length > 0,
    }
  })
}
