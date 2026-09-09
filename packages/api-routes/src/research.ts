import crypto from 'node:crypto'
import { and, count, desc, eq, gte, lt, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { measurementQueryTemplates, researchRunQueries, researchRuns } from '@ainyc/canonry-db'
import { alreadyExists, DEFAULT_VIEWER_RESEARCH_DAILY_RUN_LIMIT, isBrowserProvider, missingDependency, notFound, researchDailyLimitExceeded, ResearchQueryStatuses, ResearchRunStatuses, researchRunCreateSchema, UserRoles, validationError, type LocationContext, type ResearchRunDetailDto, type ResearchRunListDto, type ResearchRunPrincipal, type ResearchRunQueryDto, type ResearchRunSummaryDto, type ResearchRunScope, type ResearchScopeSelection, RESEARCH_BUILTIN_TEMPLATES, compileQueryClassifier, expandQueryTemplate, effectiveBrandNames, type QueryTrackingTemplateProvenance, type ResearchTemplateSelection } from '@ainyc/canonry-contracts'
import { requireResearchGrant } from './auth.js'
import { resolveProject, writeAuditLog } from './helpers.js'
import { activeMeasurementPlan, type ActiveMeasurementPlan } from './measurement-overview.js'
import type { ProviderAdapterInfo, SettingsRoutesOptions } from './settings.js'

export interface ResearchRoutesOptions {
  getProviderModels?: SettingsRoutesOptions['getProviderModels']
  getEffectiveProviderModels?: () => Readonly<Record<string, string>>
  providerAdapters?: ProviderAdapterInfo[]
  configuredProviderNames?: readonly string[]
  onResearchRunRequested?: (runId: string, projectId: string) => void
  allowViewers?: boolean
  viewerDailyRunLimit?: number
}

const sameLocation = (a: LocationContext, b: LocationContext) =>
  a.label === b.label && a.city === b.city && a.region === b.region && a.country === b.country && a.timezone === b.timezone

export async function researchRoutes(app: FastifyInstance, opts: ResearchRoutesOptions) {
  const viewerDailyRunLimit = opts.viewerDailyRunLimit ?? DEFAULT_VIEWER_RESEARCH_DAILY_RUN_LIMIT
  if (!Number.isInteger(viewerDailyRunLimit) || viewerDailyRunLimit <= 0) {
    throw new Error('viewerDailyRunLimit must be a positive integer')
  }

  app.post<{ Params: { name: string }; Body: unknown }>('/projects/:name/research/runs', {
    config: { paidRead: true },
  }, async (request, reply) => {
    requireResearchGrant(request, opts.allowViewers ?? false)
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
    const existingReceipt = input.idempotencyKey
      ? app.db.select().from(researchRuns).where(and(eq(researchRuns.projectId, project.id), eq(researchRuns.idempotencyKey, input.idempotencyKey))).get()
      : undefined
    const active = activeMeasurementPlan(app.db, project.id)
    const scope = input.scope
      ? (existingReceipt ? resolveStoredResearchScope(existingReceipt.scope, input.scope, input.idempotencyKey!) : resolveResearchScope(active, input.scope))
      : null
    const template = input.template
      ? (existingReceipt ? resolveStoredResearchTemplate(existingReceipt.template, input.template, input.idempotencyKey!) : resolveResearchTemplate(app, project.id, input.template, scope))
      : null
    const location = input.location === undefined
      ? (scope ? null : (project.defaultLocation ? project.locations.find(item => item.label === project.defaultLocation) ?? null : null))
      : input.location
    if (location && !project.locations.some(item => sameLocation(item, location))) throw validationError('Research location must exactly match a configured project location.', { location })
    const requestedModel = input.model ?? null
    const resolvedModel = requestedModel ?? (project.providerModels[providerName] || opts.getEffectiveProviderModels?.()[providerName] || adapter.defaultModel)
    adapter.modelValidationPattern.lastIndex = 0
    if (!adapter.modelValidationPattern.test(resolvedModel)) throw validationError('Invalid resolved model "' + resolvedModel + '" for provider "' + providerName + '".', { provider: providerName, model: resolvedModel, hint: adapter.modelValidationHint })
    if (new Set(input.queries.map(query => query.toLocaleLowerCase())).size !== input.queries.length) throw validationError('Research queries must be unique within a batch.')
    const queryClasses = classifyResearchQueries(project, active?.plan ?? null, input.queries)
    const normalized = { queries: input.queries, provider: providerName, model: requestedModel, location: location ?? null, ...(scope ? { scope } : {}), ...(template ? { template } : {}) }
    const requestHash = crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
    const now = new Date().toISOString()
    const initiatedBy = researchPrincipal(request)
    const decision = app.db.transaction((tx) => {
      if (input.idempotencyKey) {
        const existing = tx.select().from(researchRuns).where(and(eq(researchRuns.projectId, project.id), eq(researchRuns.idempotencyKey, input.idempotencyKey))).get()
        if (existing) {
          if (existing.requestHash !== requestHash) throw alreadyExists('Research idempotency key', input.idempotencyKey)
          return { reused: true as const, id: existing.id, shouldDispatch: existing.status === ResearchRunStatuses.queued }
        }
      }
      if (initiatedBy?.kind === 'user' && initiatedBy.role === UserRoles.viewer) {
        const { start, end, date } = utcDayBounds(now)
        const used = tx.select({ value: count() }).from(researchRuns).where(and(
          eq(researchRuns.projectId, project.id),
          gte(researchRuns.createdAt, start),
          lt(researchRuns.createdAt, end),
          sql`json_extract(${researchRuns.initiatedBy}, '$.role') = ${UserRoles.viewer}`,
        )).get()?.value ?? 0
        if (used >= viewerDailyRunLimit) {
          throw researchDailyLimitExceeded(project.name, viewerDailyRunLimit, date)
        }
      }
      const id = crypto.randomUUID()
      tx.insert(researchRuns).values({ id, projectId: project.id, status: ResearchRunStatuses.queued, provider: providerName, requestedModel, resolvedModel, location: location ?? null, totalQueries: input.queries.length, scope, template, idempotencyKey: input.idempotencyKey ?? null, requestHash: input.idempotencyKey ? requestHash : null, initiatedBy, createdAt: now }).run()
      for (const [position, query] of input.queries.entries()) tx.insert(researchRunQueries).values({ id: crypto.randomUUID(), researchRunId: id, position, queryText: query, queryClass: queryClasses[position] ?? null, status: ResearchQueryStatuses.queued, requestedModel, resolvedModel, groundingSources: [], citedDomains: [], searchQueries: [], createdAt: now }).run()
      writeAuditLog(tx, { projectId: project.id, actor: initiatedBy ? `${initiatedBy.kind}:${initiatedBy.id}` : 'api', action: 'research.created', entityType: 'research_run', entityId: id })
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
    const configured = new Set(opts.configuredProviderNames ?? [])
    const effectiveModels = opts.getEffectiveProviderModels?.() ?? {}
    const providers = await Promise.all((opts.providerAdapters ?? [])
      .filter(adapter => adapter.mode === 'api' && !isBrowserProvider(adapter.name) && configured.has(adapter.name))
      .map(async adapter => {
        const defaultModel = project.providerModels[adapter.name] || effectiveModels[adapter.name] || adapter.defaultModel
        const discovered = opts.getProviderModels ? await opts.getProviderModels(adapter.name) : []
        const models = discovered.length ? discovered : adapter.knownModels
        return {
          name: adapter.name,
          displayName: adapter.displayName,
          modelConfigurable: adapter.modelConfigurable,
          defaultModel,
          knownModels: [...new Map([{ id: defaultModel, displayName: defaultModel }, ...models].map(model => [model.id, { id: model.id, displayName: model.displayName }])).values()],
        }
      }))
    return { runs, providers } satisfies ResearchRunListDto
  })

  app.get<{ Params: { name: string; runId: string } }>('/projects/:name/research/runs/:runId', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    return getDetail(app, project.id, request.params.runId)
  })
}

function resolveStoredResearchScope(
  stored: ResearchRunScope | null,
  selection: ResearchScopeSelection,
  idempotencyKey: string,
): ResearchRunScope {
  if (!stored || stored.kind !== selection.kind || stored.key !== selection.key ||
    (selection.expectedPlanRevision !== undefined && selection.expectedPlanRevision !== stored.planRevision)) {
    throw alreadyExists('Research idempotency key', idempotencyKey)
  }
  return stored
}

function resolveResearchScope(active: ActiveMeasurementPlan | null, selection: ResearchScopeSelection): ResearchRunScope {
  if (!active || active.plan.schemaVersion !== 2) {
    throw validationError('Research scope requires an active Advanced Measurement plan.')
  }
  if (selection.expectedPlanRevision !== undefined && selection.expectedPlanRevision !== active.version.revision) {
    throw validationError('The selected research scope is stale. Reload the published measurement plan and try again.', {
      expectedPlanRevision: selection.expectedPlanRevision, activePlanRevision: active.version.revision,
    })
  }
  const label = selection.kind === 'market'
    ? active.plan.reportingScopes?.find(scope => scope.stableKey === selection.key)?.label
    : active.plan.targets.find(target => target.stableKey === selection.key)?.label
  if (!label) throw validationError('Unknown published research ' + selection.kind + ' scope "' + selection.key + '".')
  return { kind: selection.kind, key: selection.key, label, planRevision: active.version.revision }
}

function resolveStoredResearchTemplate(
  stored: QueryTrackingTemplateProvenance | null,
  selection: ResearchTemplateSelection,
  idempotencyKey: string,
): QueryTrackingTemplateProvenance {
  if (!stored || stored.templateId !== selection.templateId || stored.templateVersion !== selection.templateVersion) {
    throw alreadyExists('Research idempotency key', idempotencyKey)
  }
  return stored
}

function resolveResearchTemplate(
  app: FastifyInstance, projectId: string, selection: ResearchTemplateSelection, scope: ResearchRunScope | null,
): QueryTrackingTemplateProvenance {
  const availableBindings = researchTemplateBindings(scope)
  const builtin = RESEARCH_BUILTIN_TEMPLATES.find(template => template.id === selection.templateId)
  const savedTemplate = builtin ? null : app.db.select().from(measurementQueryTemplates).where(and(
    eq(measurementQueryTemplates.projectId, projectId), eq(measurementQueryTemplates.id, selection.templateId),
  )).get()
  if (!builtin && !savedTemplate) throw validationError('Unknown or stale research template. Reload the selected template and try again.')
  const templateVersion = builtin ? builtin.version : savedTemplate!.updatedAt
  if (templateVersion !== selection.templateVersion) {
    throw validationError('The selected research template is stale. Reload it and try again.')
  }
  const variables = builtin ? builtin.variables : savedTemplate!.variables
  const unavailable = variables.filter(variable => availableBindings[variable] === undefined)
  if (unavailable.length) {
    throw validationError('The selected research template requires unavailable bindings: ' + unavailable.join(', '))
  }
  const bindings = Object.fromEntries(variables.map(variable => [variable, availableBindings[variable]!]))
  const pattern = builtin ? builtin.pattern : savedTemplate!.pattern
  const output = expandQueryTemplate(pattern, bindings)
  if (!output || output.length > 4000) throw validationError('Research template output must be between 1 and 4000 characters.')
  return { templateId: selection.templateId, templateVersion, template: pattern, bindings, output }
}

function researchTemplateBindings(scope: ResearchRunScope | null): Record<string, string> {
  if (!scope) throw validationError('Research templates require a selected market or property scope.')
  return scope.kind === 'market'
    ? { market: scope.label, submarket: scope.label }
    : { property: scope.label, propertyBrand: scope.label }
}

function classifyResearchQueries(
  project: Parameters<typeof effectiveBrandNames>[0],
  plan: ActiveMeasurementPlan['plan'] | null,
  queries: readonly string[],
) {
  const propertyNames = plan ? plan.targets.flatMap(target => [target.label, ...target.aliases]) : []
  const classifier = compileQueryClassifier([...effectiveBrandNames(project), ...propertyNames])
  return queries.map(query => classifier?.classify(query) ?? null)
}

function getDetail(app: FastifyInstance, projectId: string, id: string): ResearchRunDetailDto {
  const row = app.db.select().from(researchRuns).where(and(eq(researchRuns.id, id), eq(researchRuns.projectId, projectId))).get()
  if (!row) throw notFound('Research run', id)
  const queries = app.db.select().from(researchRunQueries).where(eq(researchRunQueries.researchRunId, id)).orderBy(researchRunQueries.position).all().map(serializeQuery)
  return { ...serializeRun(row), queries }
}
function serializeRun(row: typeof researchRuns.$inferSelect): ResearchRunSummaryDto {
  return { id: row.id, projectId: row.projectId, status: row.status as ResearchRunSummaryDto['status'], provider: row.provider, requestedModel: row.requestedModel, resolvedModel: row.resolvedModel, location: row.location ?? null, scope: row.scope ?? null, template: row.template ?? null, totalQueries: row.totalQueries, completedQueries: row.completedQueries, failedQueries: row.failedQueries, error: row.error, initiatedBy: row.initiatedBy ?? null, startedAt: row.startedAt, finishedAt: row.finishedAt, createdAt: row.createdAt }
}
function serializeQuery(row: typeof researchRunQueries.$inferSelect): ResearchRunQueryDto {
  return { id: row.id, position: row.position, query: row.queryText, queryClass: row.queryClass ?? null, status: row.status as ResearchRunQueryDto['status'], requestedModel: row.requestedModel, resolvedModel: row.resolvedModel, servedModel: row.servedModel, answerText: row.answerText, groundingSources: row.groundingSources, citedDomains: row.citedDomains, searchQueries: row.searchQueries, namedCompetitors: row.namedCompetitors, citedCompetitorDomains: row.citedCompetitorDomains, answerMentioned: row.answerMentioned, citationState: row.citationState as ResearchRunQueryDto['citationState'], error: row.error, startedAt: row.startedAt, finishedAt: row.finishedAt, createdAt: row.createdAt }
}

function researchPrincipal(request: FastifyRequest): ResearchRunPrincipal | null {
  const principal = request.principal
  if (!principal) return null
  return {
    kind: principal.kind,
    id: principal.id,
    name: principal.name,
    role: principal.kind === 'user' ? principal.role ?? null : null,
  }
}

function utcDayBounds(now: string): { start: string; end: string; date: string } {
  const date = now.slice(0, 10)
  const start = `${date}T00:00:00.000Z`
  const end = new Date(Date.parse(start) + 24 * 60 * 60 * 1000).toISOString()
  return { start, end, date }
}
