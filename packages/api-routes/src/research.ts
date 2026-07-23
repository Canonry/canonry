import crypto from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { researchRunQueries, researchRuns } from '@ainyc/canonry-db'
import { alreadyExists, isBrowserProvider, missingDependency, notFound, ResearchQueryStatuses, ResearchRunStatuses, researchRunCreateSchema, validationError, type LocationContext, type ResearchRunDetailDto, type ResearchRunListDto, type ResearchRunQueryDto, type ResearchRunSummaryDto } from '@ainyc/canonry-contracts'
import { resolveProject, writeAuditLog } from './helpers.js'
import type { ProviderAdapterInfo } from './settings.js'

export interface ResearchRoutesOptions {
  providerAdapters?: ProviderAdapterInfo[]
  configuredProviderNames?: readonly string[]
  onResearchRunRequested?: (runId: string, projectId: string) => void
}

const sameLocation = (a: LocationContext, b: LocationContext) =>
  a.label === b.label && a.city === b.city && a.region === b.region && a.country === b.country && a.timezone === b.timezone

export async function researchRoutes(app: FastifyInstance, opts: ResearchRoutesOptions) {
  app.post<{ Params: { name: string }; Body: unknown }>('/projects/:name/research/runs', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    if (!opts.onResearchRunRequested) throw missingDependency('Research execution is not available on this deployment.', { reason: 'no-research-handler' })
    const parsed = researchRunCreateSchema.safeParse(request.body ?? {})
    if (!parsed.success) throw validationError('Invalid research run request', { issues: parsed.error.issues })
    const input = parsed.data
    const adapters = opts.providerAdapters ?? []
    const configured = new Set(opts.configuredProviderNames ?? [])
    const providerName = input.provider ?? project.providers.find(name => configured.has(name) && adapters.some(adapter => adapter.name === name && adapter.mode === 'api')) ?? adapters.find(adapter => adapter.mode === 'api' && configured.has(adapter.name))?.name
    const adapter = adapters.find(candidate => candidate.name === providerName)
    if (!providerName || !adapter || adapter.mode !== 'api' || isBrowserProvider(providerName) || !configured.has(providerName)) throw validationError('Research requires a configured API provider.', { provider: input.provider, validProviders: adapters.filter(a => a.mode === 'api' && configured.has(a.name)).map(a => a.name) })
    if (input.model) { adapter.modelValidationPattern.lastIndex = 0; if (!adapter.modelConfigurable || !adapter.modelValidationPattern.test(input.model)) throw validationError(`Invalid model "${input.model}" for provider "${providerName}".`, { provider: providerName, model: input.model, hint: adapter.modelValidationHint }) }
    const location = input.location === undefined ? (project.defaultLocation ? project.locations.find(item => item.label === project.defaultLocation) ?? null : null) : input.location
    if (location && !project.locations.some(item => sameLocation(item, location))) throw validationError('Research location must exactly match a configured project location.', { location })
    const requestedModel = input.model ?? null
    const resolvedModel = requestedModel ?? (project.providerModels[providerName] || adapter.defaultModel)
    adapter.modelValidationPattern.lastIndex = 0
    if (!adapter.modelValidationPattern.test(resolvedModel)) throw validationError(`Invalid resolved model "${resolvedModel}" for provider "${providerName}".`, { provider: providerName, model: resolvedModel, hint: adapter.modelValidationHint })
    if (new Set(input.queries.map(query => query.toLocaleLowerCase())).size !== input.queries.length) throw validationError('Research queries must be unique within a batch.')
    const normalized = { queries: input.queries, provider: providerName, model: requestedModel, location: location ?? null }
    const requestHash = crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
    const now = new Date().toISOString()
    const decision = app.db.transaction((tx) => {
      if (input.idempotencyKey) {
        const existing = tx.select().from(researchRuns).where(and(eq(researchRuns.projectId, project.id), eq(researchRuns.idempotencyKey, input.idempotencyKey))).get()
        if (existing) {
          if (existing.requestHash !== requestHash) throw alreadyExists('Research idempotency key', input.idempotencyKey)
          return { reused: true as const, id: existing.id, shouldDispatch: existing.status === ResearchRunStatuses.queued }
        }
      }
      const id = crypto.randomUUID()
      tx.insert(researchRuns).values({ id, projectId: project.id, status: ResearchRunStatuses.queued, provider: providerName, requestedModel, resolvedModel, location: location ?? null, totalQueries: input.queries.length, idempotencyKey: input.idempotencyKey ?? null, requestHash: input.idempotencyKey ? requestHash : null, createdAt: now }).run()
      for (const [position, query] of input.queries.entries()) tx.insert(researchRunQueries).values({ id: crypto.randomUUID(), researchRunId: id, position, queryText: query, status: ResearchQueryStatuses.queued, requestedModel, resolvedModel, groundingSources: [], citedDomains: [], searchQueries: [], createdAt: now }).run()
      writeAuditLog(tx, { projectId: project.id, actor: 'api', action: 'research.created', entityType: 'research_run', entityId: id })
      return { reused: false as const, id, shouldDispatch: true }
    })
    const result = getDetail(app, project.id, decision.id)
    if (decision.shouldDispatch) opts.onResearchRunRequested(decision.id, project.id)
    if (decision.reused) return reply.status(200).send(result)
    return reply.status(202).send(result)
  })

  app.get<{ Params: { name: string }; Querystring: { limit?: string } }>('/projects/:name/research/runs', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const requested = Number.parseInt(request.query.limit ?? '', 10)
    const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 100) : 20
    const runs = app.db.select().from(researchRuns).where(eq(researchRuns.projectId, project.id)).orderBy(desc(researchRuns.createdAt)).limit(limit).all().map(serializeRun)
    return { runs } satisfies ResearchRunListDto
  })

  app.get<{ Params: { name: string; runId: string } }>('/projects/:name/research/runs/:runId', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    return getDetail(app, project.id, request.params.runId)
  })
}

function getDetail(app: FastifyInstance, projectId: string, id: string): ResearchRunDetailDto {
  const row = app.db.select().from(researchRuns).where(and(eq(researchRuns.id, id), eq(researchRuns.projectId, projectId))).get()
  if (!row) throw notFound('Research run', id)
  const queries = app.db.select().from(researchRunQueries).where(eq(researchRunQueries.researchRunId, id)).orderBy(researchRunQueries.position).all().map(serializeQuery)
  return { ...serializeRun(row), queries }
}
function serializeRun(row: typeof researchRuns.$inferSelect): ResearchRunSummaryDto {
  return { id: row.id, projectId: row.projectId, status: row.status as ResearchRunSummaryDto['status'], provider: row.provider, requestedModel: row.requestedModel, resolvedModel: row.resolvedModel, location: row.location ?? null, totalQueries: row.totalQueries, completedQueries: row.completedQueries, failedQueries: row.failedQueries, error: row.error, startedAt: row.startedAt, finishedAt: row.finishedAt, createdAt: row.createdAt }
}
function serializeQuery(row: typeof researchRunQueries.$inferSelect): ResearchRunQueryDto {
  return { id: row.id, position: row.position, query: row.queryText, status: row.status as ResearchRunQueryDto['status'], requestedModel: row.requestedModel, resolvedModel: row.resolvedModel, servedModel: row.servedModel, answerText: row.answerText, groundingSources: row.groundingSources, citedDomains: row.citedDomains, searchQueries: row.searchQueries, answerMentioned: row.answerMentioned, citationState: row.citationState as ResearchRunQueryDto['citationState'], error: row.error, startedAt: row.startedAt, finishedAt: row.finishedAt, createdAt: row.createdAt }
}
