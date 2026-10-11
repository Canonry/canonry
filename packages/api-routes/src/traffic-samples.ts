import { and, count, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { rawEventSamples } from '@ainyc/canonry-db'
import { escapeLikePattern, TrafficSampleKinds, trafficSampleClassifierSchema, trafficSamplesQuerySchema, validationError, type TrafficSampleKind, type TrafficSamplesResponse } from '@ainyc/canonry-contracts'
import { requireAdminSession } from './auth.js'
import { resolveProject } from './helpers.js'

const storedKind: Record<TrafficSampleKind, string> = {
  [TrafficSampleKinds.crawler]: 'crawler',
  [TrafficSampleKinds['ai-user-fetch']]: 'ai_user_fetch',
  [TrafficSampleKinds['ai-referral']]: 'ai_referral',
  [TrafficSampleKinds.unknown]: 'unknown',
}
const wireKind = new Map(Object.entries(storedKind).map(([kind, stored]) => [stored, kind as TrafficSampleKind]))

/** Bounded stored evidence only. Reading samples never changes retention or rollups. */
export async function trafficSamplesRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { name: string }; Querystring: Record<string, unknown> }>('/projects/:name/traffic/samples', async request => {
    requireAdminSession(request)
    const project = resolveProject(app.db, request.params.name)
    const input = { ...request.query }
    for (const key of ['limit', 'offset']) if (input[key] !== undefined) input[key] = Number(input[key])
    const parsed = trafficSamplesQuerySchema.safeParse(input)
    if (!parsed.success) throw validationError(parsed.error.message)
    const query = parsed.data
    const windowEnd = new Date(query.until ?? Date.now()).toISOString()
    const windowStart = new Date(query.since ?? Date.parse(windowEnd) - 86_400_000).toISOString()
    if (windowStart > windowEnd) throw validationError('since must not be after until', { reason: 'invalid-window' })
    const limit = query.limit ?? 100
    const offset = query.offset ?? 0
    const filters = [eq(rawEventSamples.projectId, project.id), gte(rawEventSamples.ts, windowStart), lte(rawEventSamples.ts, windowEnd)]
    filters.push(query.kind && query.kind !== 'all'
      ? eq(rawEventSamples.eventType, storedKind[query.kind])
      : inArray(rawEventSamples.eventType, [storedKind[TrafficSampleKinds.crawler], storedKind[TrafficSampleKinds['ai-user-fetch']], storedKind[TrafficSampleKinds['ai-referral']]]))
    if (query.sourceId) filters.push(eq(rawEventSamples.sourceId, query.sourceId))
    if (query.path !== undefined) filters.push(sql`${rawEventSamples.pathNormalized} LIKE ${escapeLikePattern(query.path) + '%'} ESCAPE '\\'`)
    const where = and(...filters)
    const totalRows = app.db.select({ total: count() }).from(rawEventSamples).where(where).get()!.total
    // Select only public fields. ipHash and ingest bookkeeping cannot reach the DTO.
    const rows = app.db.select({ id: rawEventSamples.id, sourceId: rawEventSamples.sourceId, ts: rawEventSamples.ts, eventType: rawEventSamples.eventType, pathNormalized: rawEventSamples.pathNormalized, status: rawEventSamples.status, refererHost: rawEventSamples.refererHost, userAgent: rawEventSamples.userAgent, classifier: rawEventSamples.classifierDetailsJson })
      .from(rawEventSamples).where(where).orderBy(desc(rawEventSamples.ts), desc(rawEventSamples.id)).limit(limit).offset(offset).all()
    const response: TrafficSamplesResponse = {
      scope: { project: project.name, sourceId: query.sourceId ?? null, attribution: 'project-source-only', unavailableDimensions: ['property', 'target', 'market'] },
      windowStart, windowEnd, retentionDays: 30,
      sampling: { complete: false, perSync: 100, perBackfill: 500, perPushHour: 100 }, totalRows, limit, offset,
      samples: rows.map(({ eventType, classifier, ...row }) => ({ ...row, kind: wireKind.get(eventType)!, classifier: trafficSampleClassifierSchema.parse(classifier) })),
    }
    return response
  })
}
