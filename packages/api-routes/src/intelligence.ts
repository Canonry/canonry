import { eq, desc, and, inArray, like } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { groupRunsByCreatedAt, insights, healthSnapshots, runs } from '@ainyc/canonry-db'
import { notFound, validationError, RunKinds, RunStatuses, type InsightDto, type HealthSnapshotDto } from '@ainyc/canonry-contracts'
import { notProbeRun, resolveProject } from './helpers.js'

// Severity ordering for the insights `severity` filter (a MINIMUM-level gate:
// `--severity high` returns high + critical). Mirrors InsightDto['severity'].
const SEVERITY_RANK: Record<InsightDto['severity'], number> = { low: 0, medium: 1, high: 2, critical: 3 }

/** Severities at or above `min`, or throw a validation error for an unknown level. */
function severitiesAtOrAbove(min: string): InsightDto['severity'][] {
  const floor = SEVERITY_RANK[min as InsightDto['severity']]
  if (floor === undefined) {
    throw validationError(`Invalid severity "${min}". Use one of: low, medium, high, critical.`)
  }
  return (Object.keys(SEVERITY_RANK) as InsightDto['severity'][]).filter((s) => SEVERITY_RANK[s] >= floor)
}

function emptyHealthSnapshot(projectId: string): HealthSnapshotDto {
  return {
    id: `no-data:${projectId}`,
    projectId,
    runId: null,
    overallCitedRate: 0,
    overallMentionRate: 0,
    totalPairs: 0,
    citedPairs: 0,
    mentionedPairs: 0,
    providerBreakdown: {},
    createdAt: '',
    status: 'no-data',
    reason: 'no-runs-yet',
  }
}

function mapInsightRow(r: typeof insights.$inferSelect): InsightDto {
  return {
    id: r.id,
    projectId: r.projectId,
    runId: r.runId ?? null,
    type: r.type as InsightDto['type'],
    severity: r.severity as InsightDto['severity'],
    title: r.title,
    query: r.query,
    provider: r.provider,
    recommendation: r.recommendation ?? undefined,
    cause: r.cause ?? undefined,
    dismissed: r.dismissed,
    createdAt: r.createdAt,
  }
}

/**
 * Coalesce a persisted providerBreakdown into the current DTO shape. Rows
 * written before the mention columns existed have entries with no
 * `mentionRate` / `mentioned` keys — fill them with 0 so the contract field
 * is always present. Cited fields pass through untouched.
 */
function coalesceProviderBreakdown(
  breakdown: Record<string, { citedRate: number; mentionRate?: number; cited: number; mentioned?: number; total: number }>,
): HealthSnapshotDto['providerBreakdown'] {
  const out: HealthSnapshotDto['providerBreakdown'] = {}
  for (const [provider, entry] of Object.entries(breakdown)) {
    out[provider] = {
      citedRate: entry.citedRate,
      mentionRate: entry.mentionRate ?? 0,
      cited: entry.cited,
      mentioned: entry.mentioned ?? 0,
      total: entry.total,
    }
  }
  return out
}

function mapHealthRow(r: typeof healthSnapshots.$inferSelect): HealthSnapshotDto {
  return {
    id: r.id,
    projectId: r.projectId,
    runId: r.runId ?? null,
    overallCitedRate: Number(r.overallCitedRate),
    // Legacy rows (persisted before v80) have NULL mention columns → 0.
    overallMentionRate: r.overallMentionRate == null ? 0 : Number(r.overallMentionRate),
    totalPairs: r.totalPairs,
    citedPairs: r.citedPairs,
    mentionedPairs: r.mentionedPairs ?? 0,
    providerBreakdown: coalesceProviderBreakdown(r.providerBreakdown),
    createdAt: r.createdAt,
    status: 'ready',
  }
}

/**
 * Combine N healthSnapshot rows (one per fan-out location) into a single
 * project-level health summary. Pairs are summed across rows; provider
 * breakdowns merge by adding `total` and `cited` per provider key.
 *
 * The synthesized row uses the newest createdAt and concatenates the source
 * runIds so consumers can trace back to the underlying runs if needed.
 *
 * For single-location projects (one row in the group), this returns a result
 * identical to `mapHealthRow(row)` — no behavior change for the common case.
 */
function aggregateHealthSnapshots(
  projectId: string,
  rows: readonly (typeof healthSnapshots.$inferSelect)[],
): HealthSnapshotDto {
  if (rows.length === 1) return mapHealthRow(rows[0]!)

  let totalPairs = 0
  let citedPairs = 0
  let mentionedPairs = 0
  const mergedProviders: Record<string, { total: number; cited: number; mentioned: number; citedRate: number; mentionRate: number }> = {}
  let newestCreatedAt = ''
  const runIds: string[] = []

  for (const row of rows) {
    totalPairs += row.totalPairs
    citedPairs += row.citedPairs
    // Legacy rows (pre-v80) have NULL mention columns → contribute 0 to the
    // numerator. Cited and mention are merged identically but independently.
    mentionedPairs += row.mentionedPairs ?? 0
    if (row.createdAt > newestCreatedAt) newestCreatedAt = row.createdAt
    if (row.runId) runIds.push(row.runId)
    const providerBreakdown = row.providerBreakdown
    for (const [provider, entry] of Object.entries(providerBreakdown)) {
      const existing = mergedProviders[provider] ?? { total: 0, cited: 0, mentioned: 0, citedRate: 0, mentionRate: 0 }
      existing.total += entry.total
      existing.cited += entry.cited
      existing.mentioned += entry.mentioned ?? 0
      mergedProviders[provider] = existing
    }
  }
  // Compute per-provider rates after summing. Cited and mention are computed
  // separately — neither is derived from the other.
  for (const entry of Object.values(mergedProviders)) {
    entry.citedRate = entry.total > 0 ? entry.cited / entry.total : 0
    entry.mentionRate = entry.total > 0 ? entry.mentioned / entry.total : 0
  }
  const overallCitedRate = totalPairs > 0 ? citedPairs / totalPairs : 0
  const overallMentionRate = totalPairs > 0 ? mentionedPairs / totalPairs : 0

  return {
    // Synthetic id so consumers can tell this is an aggregate; concatenate
    // source runIds for traceability without inventing a new schema column.
    id: `group:${runIds.join(',')}`,
    projectId,
    runId: runIds[0] ?? null,
    overallCitedRate,
    overallMentionRate,
    totalPairs,
    citedPairs,
    mentionedPairs,
    providerBreakdown: mergedProviders,
    createdAt: newestCreatedAt,
    status: 'ready',
  }
}

export async function intelligenceRoutes(app: FastifyInstance) {
  // GET /projects/:name/insights — list insights for a project.
  // Filters (all optional, AND-combined): `type` matches an exact insight type
  // or, with a trailing `*`, a prefix (e.g. `gbp-*`); `severity` is a MINIMUM
  // level (`high` returns high + critical); `limit` caps the (newest-first)
  // result. Server-side so an agent gets exactly what it needs in one call.
  app.get<{
    Params: { name: string }
    Querystring: { dismissed?: string; runId?: string; type?: string; severity?: string; limit?: string }
  }>('/projects/:name/insights', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const conditions = [eq(insights.projectId, project.id)]
    if (request.query.runId) {
      conditions.push(eq(insights.runId, request.query.runId))
    }
    const typeFilter = request.query.type?.trim()
    if (typeFilter) {
      // Insight types are a server-controlled enum of safe identifiers (no LIKE
      // metacharacters), so a raw prefix is sufficient for the `gbp-*` form.
      conditions.push(
        typeFilter.endsWith('*')
          ? like(insights.type, `${typeFilter.slice(0, -1)}%`)
          : eq(insights.type, typeFilter),
      )
    }
    const severityFilter = request.query.severity?.trim()
    if (severityFilter) {
      conditions.push(inArray(insights.severity, severitiesAtOrAbove(severityFilter)))
    }

    let limit: number | undefined
    if (request.query.limit !== undefined) {
      const parsed = Number(request.query.limit)
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw validationError(`Invalid limit "${request.query.limit}". Use a positive integer.`)
      }
      limit = parsed
    }

    const rows = app.db
      .select()
      .from(insights)
      .where(conditions.length === 1 ? conditions[0]! : and(...conditions))
      .orderBy(desc(insights.createdAt))
      .all()

    const showDismissed = request.query.dismissed === 'true'

    let result: InsightDto[] = rows
      .filter(r => showDismissed || !r.dismissed)
      .map(mapInsightRow)
    if (limit !== undefined) result = result.slice(0, limit)

    return reply.send(result)
  })

  // GET /projects/:name/insights/:id — get a single insight
  app.get<{
    Params: { name: string; id: string }
  }>('/projects/:name/insights/:id', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const row = app.db
      .select()
      .from(insights)
      .where(eq(insights.id, request.params.id))
      .get()

    if (!row || row.projectId !== project.id) {
      throw notFound('Insight', request.params.id)
    }

    return reply.send(mapInsightRow(row))
  })

  // POST /projects/:name/insights/:id/dismiss — dismiss an insight
  app.post<{
    Params: { name: string; id: string }
  }>('/projects/:name/insights/:id/dismiss', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const row = app.db
      .select()
      .from(insights)
      .where(eq(insights.id, request.params.id))
      .get()

    if (!row || row.projectId !== project.id) {
      throw notFound('Insight', request.params.id)
    }

    app.db
      .update(insights)
      .set({ dismissed: true })
      .where(eq(insights.id, request.params.id))
      .run()

    return reply.send({ ok: true })
  })

  // GET /projects/:name/health/latest — latest health snapshot
  app.get<{
    Params: { name: string }
  }>('/projects/:name/health/latest', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    // Multi-location `--all-locations` sweeps write one healthSnapshot per
    // run. Picking the single newest row would return one location's stats
    // arbitrarily. Aggregate across the latest fan-out group instead so the
    // "current project health" headline reflects all configured locations.
    // See #480.
    const projectVisRuns = app.db
      .select({ id: runs.id, createdAt: runs.createdAt })
      .from(runs)
      .where(and(
        eq(runs.projectId, project.id),
        eq(runs.kind, RunKinds['answer-visibility']),
        inArray(runs.status, [RunStatuses.completed, RunStatuses.partial]),
        // Health-latest is the dashboard headline; probe runs must not
        // displace the most recent real visibility sweep.
        notProbeRun(),
      ))
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .all()
    const latestGroup = groupRunsByCreatedAt(projectVisRuns)[0] ?? []
    const latestGroupRunIds = latestGroup.map(r => r.id)

    // Try the group-aware aggregation first. Two fallback layers:
    //   (a) Runs exist but no snapshot was written for the latest group
    //       yet (intelligence service hasn't run for them) — use the
    //       most recent healthSnapshot regardless of group.
    //   (b) No completed visibility runs exist at all — also fall back to
    //       the most recent healthSnapshot. Handles legacy rows written
    //       without a runId reference and "snapshot inserted manually" cases.
    if (latestGroupRunIds.length > 0) {
      const groupRows = app.db
        .select()
        .from(healthSnapshots)
        .where(and(
          eq(healthSnapshots.projectId, project.id),
          inArray(healthSnapshots.runId, latestGroupRunIds),
        ))
        .all()
      if (groupRows.length > 0) {
        return reply.send(aggregateHealthSnapshots(project.id, groupRows))
      }
    }

    const fallback = app.db
      .select()
      .from(healthSnapshots)
      .where(eq(healthSnapshots.projectId, project.id))
      .orderBy(desc(healthSnapshots.createdAt))
      .limit(1)
      .get()
    if (!fallback) {
      return reply.send(emptyHealthSnapshot(project.id))
    }
    return reply.send(mapHealthRow(fallback))
  })

  // GET /projects/:name/health/history — health snapshot history
  app.get<{
    Params: { name: string }
    Querystring: { limit?: string }
  }>('/projects/:name/health/history', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const parsed = request.query.limit ? parseInt(request.query.limit, 10) : NaN
    const limit = Number.isNaN(parsed) ? 30 : Math.min(Math.max(parsed, 1), 100)

    const rows = app.db
      .select()
      .from(healthSnapshots)
      .where(eq(healthSnapshots.projectId, project.id))
      .orderBy(desc(healthSnapshots.createdAt))
      .limit(limit)
      .all()

    return reply.send(rows.map(mapHealthRow))
  })
}
