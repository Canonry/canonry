import crypto from 'node:crypto'
import { eq, desc } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  competitors,
  discoveryProbes,
  discoverySessions,
  parseJsonColumn,
  runs,
} from '@ainyc/canonry-db'
import {
  DiscoveryBuckets,
  DiscoverySessionStatuses,
  RunKinds,
  RunStatuses,
  RunTriggers,
  citationStateSchema,
  discoveryBucketSchema,
  discoveryRunRequestSchema,
  notFound,
  validationError,
  type DiscoveryCompetitorMapEntry,
  type DiscoveryProbeDto,
  type DiscoverySessionDetailDto,
  type DiscoverySessionDto,
  type DiscoverySessionStatus,
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
}) => void

export interface DiscoveryRoutesOptions {
  onDiscoveryRunRequested?: OnDiscoveryRunRequested
}

export async function discoveryRoutes(app: FastifyInstance, opts: DiscoveryRoutesOptions) {
  // POST /projects/:name/discover/run — kick off a discovery session
  app.post<{
    Params: { name: string }
    Body: { icpDescription?: string; dedupThreshold?: number; maxProbes?: number }
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
  // payload PR 2 would persist. v1 returns it read-only so the operator can
  // preview the basket before running `canonry discover promote` in PR 2.
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

      const competitorMap = parseJsonColumn<DiscoveryCompetitorMapEntry[]>(session.competitorMap, [])
      const newCompetitors = competitorMap
        .filter(entry => !seenCompetitors.has(entry.domain.toLowerCase()))
        .slice(0, 20)

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
    competitorMap: parseJsonColumn<DiscoveryCompetitorMapEntry[]>(row.competitorMap, []),
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
