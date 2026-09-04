/**
 * Source evidence for exactly one Property.
 *
 * `GET /measurement-report` answers a different question: it reconstructs a
 * whole revision — every group, every Target, every evidence row, unpaginated —
 * for a revision the caller names. A Property page asks for one Target's rows
 * out of the run the overview is already displaying, split by question class,
 * and it must be able to stop after a page. Those are different reads, so this
 * is a separate route rather than a filter bolted onto the report: the report's
 * `groups`, `targets` and `diagnostics` are run-level and would have to start
 * meaning something narrower whenever a filter was present, and the class split
 * lives on a v2 assignment that the v1 revisions `/measurement-report` also
 * serves do not have at all.
 *
 * Everything reads the run-pinned revision, exactly as the overview does.
 */

import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  MEASUREMENT_EVIDENCE_DEFAULT_SHAPE,
  MEASUREMENT_PAGE_DEFAULT_LIMIT,
  MEASUREMENT_PLAN_V2_SCHEMA_VERSION,
  MeasurementEvidenceShapes,
  measurementPropertyEvidenceQuerySchema,
  measurementPropertyEvidenceResponseSchema,
  notFound,
  RunStatuses,
  validationError,
  type MeasurementAnswerEvidence,
  type MeasurementAttributionEvidence,
  type MeasurementEvidenceShape,
  type MeasurementPlanV2,
  type MeasurementPropertyEvidenceQuery,
  type MeasurementPropertyEvidenceResponse,
  type MeasurementQueryClassFilter,
} from '@ainyc/canonry-contracts'
import {
  measurementPlanVersions,
  querySnapshots,
  runs,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { resolveProject } from './helpers.js'
import {
  activeMeasurementPlan,
  displayedState,
  runRevisionMismatch,
  type ActiveMeasurementPlan,
} from './measurement-overview.js'
import { buildMeasurementEvidence, normalizeMeasurementLocation } from './measurement-report.js'
import {
  buildMeasurementPlanV2ReportInput,
  latestMeasurementRun,
  measurementRunExpectedSlots,
  runVersionServesActiveVersion,
} from './measurement-report-adapter.js'

interface EvidenceCursor {
  v: 1
  key: string
  shape: MeasurementEvidenceShape
  displayedRunId: string
  filterFingerprint: string
  planVersionId: string
  evidenceFingerprint: string
}

function parseEvidenceQuery(raw: Record<string, unknown>): MeasurementPropertyEvidenceQuery {
  const candidate = { ...raw, ...(raw.limit === undefined ? {} : { limit: Number(raw.limit) }) }
  const parsed = measurementPropertyEvidenceQuerySchema.safeParse(candidate)
  if (!parsed.success) {
    throw validationError('Invalid measurement property evidence query', { issues: parsed.error.issues })
  }
  return parsed.data
}

function normalizedText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en')
}

function filterFingerprint(query: MeasurementPropertyEvidenceQuery): string {
  const filters = {
    targetKey: query.targetKey,
    queryClass: query.queryClass ?? 'all',
    provider: query.provider === undefined ? null : normalizedText(query.provider),
    location: query.location === undefined ? null : normalizedText(query.location),
  }
  return createHash('sha256').update(JSON.stringify(filters)).digest('base64url')
}

function evidenceFingerprintOf(snapshots: readonly typeof querySnapshots.$inferSelect[]): string {
  const canonical = [...snapshots]
    .sort((left, right) => left.id.localeCompare(right.id))
    // `servedProvider` is audit provenance for a routed response; the Property
    // evidence projection never reads it. Excluding it preserves cursors minted
    // before migration v150 added the nullable column, while evidence-changing
    // snapshot fields still invalidate a walk.
    .map(snapshot => JSON.stringify(Object.fromEntries(
      Object.entries(snapshot).filter(([key]) => key !== 'servedProvider'),
    )))
    .join('\n')
  return createHash('sha256').update(canonical).digest('base64url')
}

/**
 * One source row is identified by the slot it was observed in, the usage edge
 * that claimed it, and the source URL. `prepareReport` already orders rows by
 * exactly those three, so the identity and the ordering cannot drift apart.
 */
function sourceRowKey(row: MeasurementAttributionEvidence): string {
  return [row.expectedSlotId, row.usageEdgeId, row.sourceUrl].join('\u0000')
}

/**
 * One answer row is identified by the slot and the usage edge alone — the pair
 * the kernel sorts `answers` by. Keying on the slot rather than on a URL is what
 * makes a page boundary fall BETWEEN answers: an answer's cited URLs travel
 * nested inside its row, so there is nothing left for a boundary to split.
 */
/**
 * `limit` bounds answer ROWS, and each row nests every source the engine
 * returned, so one answer citing hundreds of URLs produced an unbounded
 * response through both the API and MCP, where a tool result has an output
 * budget. `sourceCount` stays exact so a capped list cannot read as a short one.
 */
const MAX_SOURCES_PER_ANSWER = 50

function capSources(row: MeasurementAnswerEvidence): MeasurementAnswerEvidence {
  if (row.sources.length <= MAX_SOURCES_PER_ANSWER) return row
  return { ...row, sources: row.sources.slice(0, MAX_SOURCES_PER_ANSWER), sourcesTruncated: true }
}

function answerRowKey(row: MeasurementAnswerEvidence): string {
  return [row.expectedSlotId, row.usageEdgeId].join('\u0000')
}

/**
 * The default shape omits the field, so a cursor over the published per-URL rows
 * is byte-identical to one minted before this parameter existed and a caller
 * mid-walk when it deploys keeps its place.
 */
function encodeCursor(cursor: EvidenceCursor): string {
  const { shape, ...rest } = cursor
  return Buffer.from(
    JSON.stringify(shape === MEASUREMENT_EVIDENCE_DEFAULT_SHAPE ? rest : { ...rest, shape }),
    'utf8',
  ).toString('base64url')
}

function parseCursor(value: string): EvidenceCursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const cursor = parsed as Record<string, unknown>
    if (cursor.v !== 1) return null
    for (const field of ['key', 'displayedRunId', 'filterFingerprint', 'planVersionId', 'evidenceFingerprint']) {
      const candidate = cursor[field]
      if (typeof candidate !== 'string' || candidate.length === 0) return null
    }
    // A cursor carrying no shape is one this route minted before the parameter
    // existed, and could only ever have named the default.
    const shape = cursor.shape === undefined ? MEASUREMENT_EVIDENCE_DEFAULT_SHAPE : cursor.shape
    if (shape !== MeasurementEvidenceShapes.sources && shape !== MeasurementEvidenceShapes.answers) return null
    return {
      v: 1,
      key: cursor.key as string,
      shape,
      displayedRunId: cursor.displayedRunId as string,
      filterFingerprint: cursor.filterFingerprint as string,
      planVersionId: cursor.planVersionId as string,
      evidenceFingerprint: cursor.evidenceFingerprint as string,
    }
  } catch {
    return null
  }
}

/**
 * A run pinned to another revision answered a different set of questions, so
 * naming one is refused rather than reported under this Property's label.
 */
function selectDisplayedRun(
  db: DatabaseClient,
  projectId: string,
  active: ActiveMeasurementPlan,
  runId: string | undefined,
): typeof runs.$inferSelect | undefined {
  if (runId === undefined) {
    return latestMeasurementRun(db, projectId, active.version.id, [RunStatuses.completed])
  }
  const run = db.select().from(runs).where(and(eq(runs.projectId, projectId), eq(runs.id, runId))).get()
  if (!run) throw notFound('Run', runId)
  // A run pinned to a comparable prior revision (a label-only republish chain)
  // measured exactly the questions the active revision asks, so naming it is
  // continuity, not cross-revision mixing.
  if (runVersionServesActiveVersion(db, projectId, active.version.id, run.measurementPlanVersionId)) return run
  const pinned = run.measurementPlanVersionId === null
    ? null
    : db.select({ revision: measurementPlanVersions.revision }).from(measurementPlanVersions)
        .where(eq(measurementPlanVersions.id, run.measurementPlanVersionId)).get()?.revision ?? null
  throw runRevisionMismatch(run.id, pinned, active.version.revision)
}

/**
 * Both readings of one result set.
 *
 * `buildMeasurementEvidence` derives the per-URL rows from the answer rows in a
 * single pass, and the same edge/provider/location predicate narrows both here,
 * so the two shapes cannot select different evidence out of the same run.
 */
function propertyEvidenceRows(
  db: DatabaseClient,
  plan: MeasurementPlanV2,
  active: ActiveMeasurementPlan,
  run: typeof runs.$inferSelect,
  query: MeasurementPropertyEvidenceQuery,
  queryClass: MeasurementQueryClassFilter,
): {
  sources: MeasurementAttributionEvidence[]
  answers: MeasurementAnswerEvidence[]
  evidenceFingerprint: string
} {
  const snapshots = db.select().from(querySnapshots).where(eq(querySnapshots.runId, run.id)).all()
  const manifest = measurementRunExpectedSlots(run, plan)
  const { input, edgeQueryClass } = buildMeasurementPlanV2ReportInput(active.version.revision, plan, manifest, snapshots)

  // Every usage edge this Property owns, narrowed to the requested class first:
  // the class is a property of the Target-owned assignment, so it selects edges
  // rather than questions.
  const ownEdgeIds = new Set(input.usageEdges
    .filter(edge => edge.type === 'target' && edge.targetId === query.targetKey)
    .filter(edge => queryClass === 'all' || edgeQueryClass.get(edge.id) === queryClass)
    .map(edge => edge.id))

  const provider = query.provider === undefined ? undefined : normalizedText(query.provider)
  const location = query.location === undefined ? undefined : normalizeMeasurementLocation(query.location)
  const owned = (row: { usageEdgeId: string; provider: string; location: string | null }): boolean => (
    ownEdgeIds.has(row.usageEdgeId)
    && (provider === undefined || row.provider === provider)
    && (location === undefined || normalizeMeasurementLocation(row.location) === location)
  )

  const built = buildMeasurementEvidence(input)
  return {
    sources: built.evidence.filter(owned),
    answers: built.answers.filter(owned),
    evidenceFingerprint: evidenceFingerprintOf(snapshots),
  }
}

interface CursorPage<Row> {
  items: Row[]
  nextCursor: string | null
  totalEstimate: number
}

/**
 * `keyOf` is what makes the page boundary land where the shape needs it: the
 * per-URL rows key on the URL, the answer rows key on the (slot, usage edge)
 * pair. Both are the exact tuple the kernel sorted by, so a cursor key and the
 * ordering it walks cannot drift apart.
 */
function pageOf<Row>(
  rows: readonly Row[],
  keyOf: (row: Row) => string,
  shape: MeasurementEvidenceShape,
  query: MeasurementPropertyEvidenceQuery,
  displayedRunId: string,
  planVersionId: string,
  evidenceFingerprint: string,
): CursorPage<Row> {
  const limit = query.limit ?? MEASUREMENT_PAGE_DEFAULT_LIMIT
  let offset = 0
  if (query.cursor !== undefined) {
    const cursor = parseCursor(query.cursor)
    if (cursor === null) throw validationError('The measurement property evidence cursor is not readable.')
    // The shapes key their rows differently, so a cursor crossing between them
    // would name a row identity the other shape never mints. Refused by name
    // rather than folded into the filter mismatch below, which says nothing
    // about which reading the caller asked for.
    if (cursor.shape !== shape) {
      throw validationError('The measurement property evidence cursor shape does not match the request.')
    }
    if (cursor.filterFingerprint !== filterFingerprint(query)) {
      throw validationError('The measurement property evidence cursor filters do not match the request.')
    }
    if (cursor.planVersionId !== planVersionId) {
      throw validationError('The measurement property evidence cursor revision does not match the active plan.')
    }
    if (cursor.displayedRunId !== displayedRunId) {
      throw validationError('The measurement property evidence cursor run does not match the request.')
    }
    if (cursor.evidenceFingerprint !== evidenceFingerprint) {
      throw validationError('The measurement property evidence changed between pages.')
    }
    const index = rows.findIndex(row => keyOf(row) === cursor.key)
    if (index < 0) throw validationError('The measurement property evidence cursor does not belong to this result set.')
    offset = index + 1
  }

  const items = rows.slice(offset, offset + limit)
  const last = items.at(-1)
  return {
    items,
    nextCursor: last === undefined || rows.at(offset + limit) === undefined
      ? null
      : encodeCursor({
          v: 1,
          key: keyOf(last),
          shape,
          displayedRunId,
          filterFingerprint: filterFingerprint(query),
          planVersionId,
          evidenceFingerprint,
        }),
    totalEstimate: rows.length,
  }
}

export async function measurementPropertyEvidenceRoutes(app: FastifyInstance) {
  app.get<{ Params: { name: string }; Querystring: Record<string, unknown> }>(
    '/projects/:name/measurement-property-evidence',
    async request => {
      const project = resolveProject(app.db, request.params.name)
      const query = parseEvidenceQuery(request.query)
      const active = activeMeasurementPlan(app.db, project.id)
      if (!active) throw notFound('Active measurement plan', project.name)
      // A v1 revision has no Branded/Non-brand assignment to scope evidence by,
      // so answering here would mean inventing a class this revision never
      // recorded. `/measurement-report` still reconstructs a v1 revision whole.
      if (active.plan.schemaVersion !== MEASUREMENT_PLAN_V2_SCHEMA_VERSION) {
        throw validationError(
          'Property evidence is not available for a schema v1 revision. Republish setup, or read the whole revision through GET /measurement-report.',
        )
      }
      const plan = active.plan
      const target = plan.targets.find(candidate => candidate.stableKey === query.targetKey)
      if (!target) throw validationError(`Measurement Property "${query.targetKey}" is not in the active revision.`)

      const queryClass = query.queryClass ?? 'all'
      const shape = query.shape ?? MEASUREMENT_EVIDENCE_DEFAULT_SHAPE
      const property = { targetKey: target.stableKey, label: target.label }
      // A cursor pins the run it was issued against. Re-selecting the latest run
      // here meant a sweep completing between two pages moved the result set and
      // the caller's own cursor was then rejected as not belonging to it.
      const pinnedRunId = query.runId ?? (query.cursor === undefined ? undefined : parseCursor(query.cursor)?.displayedRunId)
      const displayed = selectDisplayedRun(app.db, project.id, active, pinnedRunId)
      if (!displayed) {
        // Not measured is not "no evidence". The state says which one this is,
        // and the empty page below must never be read as a measured zero.
        if (query.cursor !== undefined) {
          throw validationError('The measurement property evidence cursor does not belong to this result set.')
        }
        const empty = { items: [], nextCursor: null, totalEstimate: 0 }
        return measurementPropertyEvidenceResponseSchema.parse({
          property,
          queryClass,
          measurement: { state: 'not_measured' },
          // The page still arrives under the key the caller's shape names. An
          // unmeasured Property has no rows in EITHER reading, and swapping the
          // key here would read as "that shape is unavailable" instead.
          ...(shape === MeasurementEvidenceShapes.answers ? { answers: empty } : { evidence: empty }),
        } satisfies MeasurementPropertyEvidenceResponse)
      }

      const { sources, answers, evidenceFingerprint } =
        propertyEvidenceRows(app.db, plan, active, displayed, query, queryClass)
      const pageArgs = [shape, query, displayed.id, active.version.id, evidenceFingerprint] as const
      return measurementPropertyEvidenceResponseSchema.parse({
        property,
        queryClass,
        measurement: {
          state: displayedState(displayed.status),
          displayedRunId: displayed.id,
          ...(displayed.finishedAt ? { completedAt: displayed.finishedAt } : {}),
        },
        ...(shape === MeasurementEvidenceShapes.answers
          ? { answers: pageOf(answers.map(capSources), answerRowKey, ...pageArgs) }
          : { evidence: pageOf(sources, sourceRowKey, ...pageArgs) }),
      } satisfies MeasurementPropertyEvidenceResponse)
    },
  )
}
