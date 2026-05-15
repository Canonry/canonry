import crypto from 'node:crypto'
import { eq, desc } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  competitors,
  discoveryProbes,
  discoverySessions,
  parseJsonColumn,
  queries,
  runs,
} from '@ainyc/canonry-db'
import {
  DEFAULT_DISCOVERY_PROMOTE_BUCKETS,
  DEFAULT_DISCOVERY_PROMOTE_COMPETITOR_TYPES,
  DISCOVERY_PROMOTE_COMPETITOR_CAP,
  DISCOVERY_PROMOTE_COMPETITOR_MIN_HITS,
  DiscoveryBuckets,
  DiscoveryCompetitorTypes,
  DiscoverySessionStatuses,
  RunKinds,
  RunStatuses,
  RunTriggers,
  citationStateSchema,
  discoveryBucketSchema,
  discoveryPromoteRequestSchema,
  discoveryRunRequestSchema,
  notFound,
  resolveLocations,
  validationError,
  type DiscoveryBucket,
  type DiscoveryCompetitorMapEntry,
  type DiscoveryCompetitorType,
  type DiscoveryProbeDto,
  type DiscoveryPromoteResult,
  type DiscoverySessionDetailDto,
  type DiscoverySessionDto,
  type DiscoverySessionStatus,
  type LocationContext,
} from '@ainyc/canonry-contracts'
import { resolveProject, writeAuditLog } from '../helpers.js'

/**
 * Fired after a `discovery_sessions` row + matching `runs` row are inserted
 * but BEFORE the response is sent. Canonry-side handler runs the orchestrator
 * in the background, writes the bucket-divergence insight, and triggers the
 * run-coordinator. Cloud deployments may leave this unset, in which case the
 * POST endpoint returns `MISSING_DEPENDENCY` rather than silently dropping
 * the request on the floor.
 */
export type OnDiscoveryRunRequested = (input: {
  runId: string
  sessionId: string
  projectId: string
  icpDescription: string
  dedupThreshold?: number
  maxProbes?: number
  /**
   * Resolved service-area locations for this session — every project
   * location, or the subset named by the request's `locations` override.
   * Empty when the project has no locations configured. Forwarded to the
   * seed generator so discovered queries stay inside the service area.
   */
  locations: LocationContext[]
}) => void

export interface DiscoveryRoutesOptions {
  onDiscoveryRunRequested?: OnDiscoveryRunRequested
}

export async function discoveryRoutes(app: FastifyInstance, opts: DiscoveryRoutesOptions) {
  // POST /projects/:name/discover/run — kick off a discovery session
  app.post<{
    Params: { name: string }
    Body: { icpDescription?: string; dedupThreshold?: number; maxProbes?: number; locations?: string[] }
  }>('/projects/:name/discover/run', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const parsed = discoveryRunRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      throw validationError('Invalid discovery run request', {
        issues: parsed.error.issues.map(issue => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      })
    }

    // Resolve ICP: explicit body > stored on project. If neither is present,
    // surface a validation error early — the orchestrator can't seed without
    // an ICP description.
    const icpDescription = parsed.data.icpDescription?.trim() || (project.icpDescription ?? '').trim()
    if (!icpDescription) {
      throw validationError(
        'icpDescription is required. Pass it in the request body or store it on the project (spec.icpDescription).',
      )
    }

    // Resolve the session's service areas: every project location, or the
    // subset named by `locations`. An unknown label throws validationError.
    const locations = resolveLocations(
      parseJsonColumn<LocationContext[]>(project.locations, []),
      parsed.data.locations,
    )

    if (!opts.onDiscoveryRunRequested) {
      throw validationError('Discovery is not available on this deployment.', {
        reason: 'no-discovery-handler',
      })
    }

    const now = new Date().toISOString()
    const sessionId = crypto.randomUUID()
    const runId = crypto.randomUUID()

    app.db.transaction((tx) => {
      tx.insert(discoverySessions).values({
        id: sessionId,
        projectId: project.id,
        runId,
        status: DiscoverySessionStatuses.queued,
        icpDescription,
        dedupThreshold: parsed.data.dedupThreshold,
        competitorMap: '[]',
        createdAt: now,
      }).run()

      tx.insert(runs).values({
        id: runId,
        projectId: project.id,
        kind: RunKinds['aeo-discover-probe'],
        status: RunStatuses.queued,
        trigger: RunTriggers.manual,
        createdAt: now,
      }).run()

      writeAuditLog(tx, {
        projectId: project.id,
        actor: 'api',
        action: 'discovery.created',
        entityType: 'discovery_session',
        entityId: sessionId,
      })
    })

    opts.onDiscoveryRunRequested({
      runId,
      sessionId,
      projectId: project.id,
      icpDescription,
      dedupThreshold: parsed.data.dedupThreshold,
      maxProbes: parsed.data.maxProbes,
      locations,
    })

    return reply.status(201).send({ runId, sessionId, status: 'running' })
  })

  // GET /projects/:name/discover/sessions — list sessions for a project
  app.get<{ Params: { name: string }; Querystring: { limit?: string } }>(
    '/projects/:name/discover/sessions',
    async (request, reply) => {
      const project = resolveProject(app.db, request.params.name)
      const parsedLimit = parseInt(request.query.limit ?? '', 10)
      const limit = Number.isNaN(parsedLimit) || parsedLimit <= 0 ? 50 : parsedLimit

      const rows = app.db
        .select()
        .from(discoverySessions)
        .where(eq(discoverySessions.projectId, project.id))
        .orderBy(desc(discoverySessions.createdAt))
        .limit(limit)
        .all()

      return reply.send(rows.map(serializeSession))
    },
  )

  // GET /projects/:name/discover/sessions/:id — single session with probes
  app.get<{ Params: { name: string; id: string } }>(
    '/projects/:name/discover/sessions/:id',
    async (request, reply) => {
      const project = resolveProject(app.db, request.params.name)
      const session = app.db
        .select()
        .from(discoverySessions)
        .where(eq(discoverySessions.id, request.params.id))
        .get()
      if (!session || session.projectId !== project.id) {
        throw notFound('Discovery session', request.params.id)
      }

      const probeRows = app.db
        .select()
        .from(discoveryProbes)
        .where(eq(discoveryProbes.sessionId, session.id))
        .all()

      const detail: DiscoverySessionDetailDto = {
        ...serializeSession(session),
        probes: probeRows.map(serializeProbe),
      }
      return reply.send(detail)
    },
  )

  // GET /projects/:name/discover/sessions/:id/promote — show the promotion
  // payload the POST would persist. Read-only, so the operator can preview
  // the bucketed basket before running `canonry discover promote`.
  app.get<{ Params: { name: string; id: string } }>(
    '/projects/:name/discover/sessions/:id/promote',
    async (request, reply) => {
      const project = resolveProject(app.db, request.params.name)
      const session = app.db
        .select()
        .from(discoverySessions)
        .where(eq(discoverySessions.id, request.params.id))
        .get()
      if (!session || session.projectId !== project.id) {
        throw notFound('Discovery session', request.params.id)
      }
      const probeRows = app.db
        .select()
        .from(discoveryProbes)
        .where(eq(discoveryProbes.sessionId, session.id))
        .all()
      const existingCompetitors = app.db
        .select({ domain: competitors.domain })
        .from(competitors)
        .where(eq(competitors.projectId, project.id))
        .all()
        .map(r => r.domain.toLowerCase())

      const seenCompetitors = new Set(existingCompetitors)
      const cited = new Set<string>()
      const aspirational = new Set<string>()
      const wasted = new Set<string>()
      for (const probe of probeRows) {
        const bucket = probe.bucket
        if (!bucket) continue
        if (bucket === DiscoveryBuckets.cited) cited.add(probe.query)
        else if (bucket === DiscoveryBuckets.aspirational) aspirational.add(probe.query)
        else if (bucket === DiscoveryBuckets['wasted-surface']) wasted.add(probe.query)
      }

      // Preview surfaces every recurring candidate regardless of type — each
      // entry carries its `competitorType` so the operator can see what
      // promote adopts by default (direct-competitor) vs. what needs an
      // explicit `--competitor-types` override.
      const competitorMap = parseCompetitorMap(session.competitorMap)
      const newCompetitors = selectEligibleCompetitors(competitorMap)
        .filter(entry => !seenCompetitors.has(entry.domain.toLowerCase()))

      return reply.send({
        sessionId: session.id,
        projectId: project.id,
        queriesByBucket: {
          cited: Array.from(cited).sort(),
          aspirational: Array.from(aspirational).sort(),
          'wasted-surface': Array.from(wasted).sort(),
        },
        suggestedCompetitors: newCompetitors,
        status: session.status,
      })
    },
  )

  // POST /projects/:name/discover/sessions/:id/promote — adopt a completed
  // session's bucketed queries (and, by default, recurring discovered
  // competitor domains) into the project's tracked basket. Add-only and idempotent:
  // queries/domains already tracked land in `skipped`, never inserted twice,
  // so re-running a promote is safe.
  app.post<{
    Params: { name: string; id: string }
    Body: { buckets?: string[]; includeCompetitors?: boolean; competitorTypes?: string[] }
  }>('/projects/:name/discover/sessions/:id/promote', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const session = app.db
      .select()
      .from(discoverySessions)
      .where(eq(discoverySessions.id, request.params.id))
      .get()
    if (!session || session.projectId !== project.id) {
      throw notFound('Discovery session', request.params.id)
    }

    const parsed = discoveryPromoteRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      throw validationError('Invalid discovery promote request', {
        issues: parsed.error.issues.map(issue => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      })
    }

    // Status gate — bucket assignments are not final until the session
    // completes, so promoting a queued/seeding/probing/failed session would
    // adopt a half-built (or empty) basket.
    if (session.status !== DiscoverySessionStatuses.completed) {
      throw validationError(
        `Discovery session is "${session.status}" — only completed sessions can be promoted.`,
        { status: session.status },
      )
    }

    const buckets: readonly DiscoveryBucket[] = parsed.data.buckets ?? DEFAULT_DISCOVERY_PROMOTE_BUCKETS
    const bucketSet = new Set<DiscoveryBucket>(buckets)
    const includeCompetitors = parsed.data.includeCompetitors ?? true
    // Default to direct-competitor only — aggregators, editorial media, and
    // `other` are noise for a tracked-competitor watchlist, and legacy
    // `unknown` entries are excluded until the caller opts them in explicitly.
    const competitorTypes: readonly DiscoveryCompetitorType[] =
      parsed.data.competitorTypes ?? DEFAULT_DISCOVERY_PROMOTE_COMPETITOR_TYPES

    // Candidate queries: probes whose bucket is in the requested set.
    const probeRows = app.db
      .select()
      .from(discoveryProbes)
      .where(eq(discoveryProbes.sessionId, session.id))
      .all()
    const candidateQueries = new Set<string>()
    for (const probe of probeRows) {
      if (!probe.bucket) continue
      const bucket = discoveryBucketSchema.safeParse(probe.bucket)
      if (bucket.success && bucketSet.has(bucket.data)) candidateQueries.add(probe.query)
    }

    // Promotion is add-only and idempotent. Dedupe case-insensitively against
    // the existing basket so re-running a promote — or promoting a query that
    // only differs in casing from a tracked one — never creates near-dupes.
    const existingQueries = new Set(
      app.db
        .select({ query: queries.query })
        .from(queries)
        .where(eq(queries.projectId, project.id))
        .all()
        .map(r => r.query.toLowerCase()),
    )
    const promotedQueries: string[] = []
    const skippedQueries: string[] = []
    for (const query of Array.from(candidateQueries).sort()) {
      if (existingQueries.has(query.toLowerCase())) {
        skippedQueries.push(query)
      } else {
        promotedQueries.push(query)
        existingQueries.add(query.toLowerCase())
      }
    }

    const promotedCompetitors: string[] = []
    const skippedCompetitors: string[] = []
    if (includeCompetitors) {
      const existingCompetitors = new Set(
        app.db
          .select({ domain: competitors.domain })
          .from(competitors)
          .where(eq(competitors.projectId, project.id))
          .all()
          .map(r => r.domain.toLowerCase()),
      )
      // Mirror the GET preview's recurrence + cap policy, narrowed to the
      // requested competitor types; existing domains are returned as skipped
      // for idempotency instead of being inserted again.
      const competitorMap = parseCompetitorMap(session.competitorMap)
      for (const entry of selectEligibleCompetitors(competitorMap, competitorTypes)) {
        const key = entry.domain.toLowerCase()
        if (existingCompetitors.has(key)) {
          skippedCompetitors.push(entry.domain)
        } else {
          promotedCompetitors.push(entry.domain)
          existingCompetitors.add(key)
        }
      }
    }

    const provenance = `discovery:${session.id}`
    const now = new Date().toISOString()

    if (promotedQueries.length > 0 || promotedCompetitors.length > 0) {
      app.db.transaction((tx) => {
        for (const query of promotedQueries) {
          tx.insert(queries).values({
            id: crypto.randomUUID(),
            projectId: project.id,
            query,
            provenance,
            createdAt: now,
          }).run()
        }
        for (const domain of promotedCompetitors) {
          tx.insert(competitors).values({
            id: crypto.randomUUID(),
            projectId: project.id,
            domain,
            provenance,
            createdAt: now,
          }).run()
        }
        writeAuditLog(tx, {
          projectId: project.id,
          actor: 'api',
          action: 'discovery.promoted',
          entityType: 'discovery_session',
          entityId: session.id,
          diff: { queries: promotedQueries, competitors: promotedCompetitors },
        })
      })
    }

    const result: DiscoveryPromoteResult = {
      sessionId: session.id,
      projectId: project.id,
      promoted: { queries: promotedQueries, competitors: promotedCompetitors },
      skipped: { queries: skippedQueries, competitors: skippedCompetitors },
    }
    return reply.send(result)
  })
}

function serializeSession(row: typeof discoverySessions.$inferSelect): DiscoverySessionDto {
  return {
    id: row.id,
    projectId: row.projectId,
    status: row.status as DiscoverySessionStatus,
    icpDescription: row.icpDescription ?? null,
    seedProvider: row.seedProvider ?? null,
    seedCountRaw: row.seedCountRaw ?? null,
    seedCount: row.seedCount ?? null,
    dedupThreshold: row.dedupThreshold ?? null,
    probeCount: row.probeCount ?? null,
    citedCount: row.citedCount ?? null,
    aspirationalCount: row.aspirationalCount ?? null,
    wastedCount: row.wastedCount ?? null,
    competitorMap: parseCompetitorMap(row.competitorMap),
    error: row.error ?? null,
    startedAt: row.startedAt ?? null,
    finishedAt: row.finishedAt ?? null,
    createdAt: row.createdAt,
  }
}

function serializeProbe(row: typeof discoveryProbes.$inferSelect): DiscoveryProbeDto {
  const bucketParsed = row.bucket ? discoveryBucketSchema.safeParse(row.bucket) : null
  const stateParsed = citationStateSchema.safeParse(row.citationState)
  return {
    id: row.id,
    sessionId: row.sessionId,
    projectId: row.projectId,
    query: row.query,
    bucket: bucketParsed?.success ? bucketParsed.data : null,
    citationState: stateParsed.success ? stateParsed.data : 'not-cited',
    citedDomains: parseJsonColumn<string[]>(row.citedDomains, []),
    createdAt: row.createdAt,
  }
}

/**
 * Parse a `discovery_sessions.competitor_map` JSON column into normalized
 * entries. `parseJsonColumn` does not apply Zod defaults, so a competitor map
 * persisted before classification existed has entries without
 * `competitorType` — normalize those to `unknown` here so every consumer sees
 * a well-formed `DiscoveryCompetitorMapEntry`.
 */
function parseCompetitorMap(json: string): DiscoveryCompetitorMapEntry[] {
  const raw = parseJsonColumn<Array<Partial<DiscoveryCompetitorMapEntry> & { domain: string; hits: number }>>(
    json,
    [],
  )
  return raw.map(entry => ({
    domain: entry.domain,
    hits: entry.hits,
    competitorType: entry.competitorType ?? DiscoveryCompetitorTypes.unknown,
  }))
}

/**
 * Recurring competitor domains eligible for promotion: at least
 * `DISCOVERY_PROMOTE_COMPETITOR_MIN_HITS` probe hits, optionally narrowed to a
 * set of classified `competitorType`s, sorted by hits desc, capped. Omitting
 * `competitorTypes` applies no type filter — the GET preview uses that to
 * surface every recurring candidate with its classification so the operator
 * can decide what to pass to `--competitor-types`.
 */
function selectEligibleCompetitors(
  competitorMap: readonly DiscoveryCompetitorMapEntry[],
  competitorTypes?: readonly DiscoveryCompetitorType[],
): DiscoveryCompetitorMapEntry[] {
  const typeFilter = competitorTypes ? new Set(competitorTypes) : null
  return competitorMap
    .filter(entry => entry.hits >= DISCOVERY_PROMOTE_COMPETITOR_MIN_HITS)
    .filter(entry => !typeFilter || typeFilter.has(entry.competitorType))
    .sort((a, b) => b.hits - a.hits || a.domain.localeCompare(b.domain))
    .slice(0, DISCOVERY_PROMOTE_COMPETITOR_CAP)
}
