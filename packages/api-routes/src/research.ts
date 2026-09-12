import crypto from 'node:crypto'
import { z } from 'zod'
import { and, count, desc, eq, gte, lt, or, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { measurementQueryTemplates, projects, researchRunQueries, researchRuns } from '@ainyc/canonry-db'
import { alreadyExists, DEFAULT_VIEWER_RESEARCH_DAILY_RUN_LIMIT, isBrowserProvider, missingDependency, notFound, researchDailyLimitExceeded, ResearchQueryStatuses, ResearchRunStatuses, researchBatchCreateSchema, researchRunCreateSchema, UserRoles, validationError, type LocationContext, type ResearchBatchCreate, type ResearchBatchDto, type ResearchRunDetailDto, type ResearchRunListDto, type ResearchRunPrincipal, type ResearchRunQueryDto, type ResearchRunSummaryDto, type ResearchRunScope, type ResearchScopeSelection, deduplicateResearchQueries, compileQueryClassifier, expandResearchTemplate, effectiveBrandNames, type QueryTrackingTemplateProvenance, type ResearchTemplateSelection, type ResearchRunCreate } from '@ainyc/canonry-contracts'
import { canRunResearch, requireResearchGrant } from './auth.js'
import { RESEARCH_RUN_SCOPE, WILDCARD_SCOPE } from '@ainyc/canonry-contracts'
import { resolveProject, writeAuditLog } from './helpers.js'
import { activeMeasurementPlan, type ActiveMeasurementPlan } from './measurement-overview.js'
import type { ProviderAdapterInfo } from './settings.js'

export interface ResearchRoutesOptions {
  /** Local cached/bundled choices only; must never discover models live. */
  getCachedProviderModels?: (name: string) => ProviderAdapterInfo['knownModels']
  getEffectiveProviderModels?: () => Readonly<Record<string, string>>
  providerAdapters?: ProviderAdapterInfo[]
  configuredProviderNames?: readonly string[]
  onResearchRunRequested?: (runId: string, projectId: string) => void
  allowViewers?: boolean
  viewerDailyRunLimit?: number
}

const sameLocation = (a: LocationContext, b: LocationContext) =>
  a.label === b.label && a.city === b.city && a.region === b.region && a.country === b.country && a.timezone === b.timezone

/** Reserved so a user-provided single-run receipt can never impersonate a batch child. */
const BATCH_RECEIPT_PREFIX = '__canonry_research_batch__:'

export async function researchRoutes(app: FastifyInstance, opts: ResearchRoutesOptions) {
  const viewerDailyRunLimit = opts.viewerDailyRunLimit ?? DEFAULT_VIEWER_RESEARCH_DAILY_RUN_LIMIT
  if (!Number.isInteger(viewerDailyRunLimit) || viewerDailyRunLimit <= 0) {
    throw new Error('viewerDailyRunLimit must be a positive integer')
  }

  app.post<{ Params: { name: string }; Body: unknown }>('/projects/:name/research/runs', {
    config: { paidRead: true, writeScope: RESEARCH_RUN_SCOPE },
  }, async (request, reply) => {
    requireResearchGrant(request, opts.allowViewers ?? false)
    const project = resolveProject(app.db, request.params.name)
    const parsed = researchRunCreateSchema.safeParse(request.body ?? {})
    if (!parsed.success) throw validationError('Invalid research run request', { issues: parsed.error.issues })
    const input = parsed.data
    if (input.idempotencyKey?.startsWith(BATCH_RECEIPT_PREFIX)) throw validationError('This idempotency key prefix is reserved for internal research batch receipts.')
    const requestHash = directResearchRequestHash(input)
    const existingReceipt = input.idempotencyKey
      ? app.db.select().from(researchRuns).where(and(eq(researchRuns.projectId, project.id), eq(researchRuns.idempotencyKey, input.idempotencyKey))).get()
      : undefined
    if (existingReceipt) {
      assertSameDirectResearchRequest(existingReceipt, input, requestHash)
      const result = getDetail(app, project.id, existingReceipt.id)
      if (existingReceipt.status === ResearchRunStatuses.queued) opts.onResearchRunRequested?.(existingReceipt.id, project.id)
      return reply.status(200).send(result)
    }
    if (!opts.onResearchRunRequested) throw missingDependency('Research execution is not available on this deployment.', { reason: 'no-research-handler' })
    const adapters = opts.providerAdapters ?? []
    const configured = new Set(opts.configuredProviderNames ?? [])
    const providerName = input.provider ?? project.providers.find(name => configured.has(name) && adapters.some(adapter => adapter.name === name && adapter.mode === 'api')) ?? adapters.find(adapter => adapter.mode === 'api' && configured.has(adapter.name))?.name
    const adapter = adapters.find(candidate => candidate.name === providerName)
    if (!providerName || !adapter || adapter.mode !== 'api' || isBrowserProvider(providerName) || !configured.has(providerName)) throw validationError('Research requires a configured API provider.', { provider: input.provider, validProviders: adapters.filter(a => a.mode === 'api' && configured.has(a.name)).map(a => a.name) })
    if (input.model) { adapter.modelValidationPattern.lastIndex = 0; if (!adapter.modelConfigurable || !adapter.modelValidationPattern.test(input.model)) throw validationError(`Invalid model "${input.model}" for provider "${providerName}".`, { provider: providerName, model: input.model, hint: adapter.modelValidationHint }) }
    const active = activeMeasurementPlan(app.db, project.id)
    const scope = input.scope
      ? resolveResearchScope(active, input.scope)
      : null
    const location = input.location === undefined
      ? (scope ? null : (project.defaultLocation ? project.locations.find(item => item.label === project.defaultLocation) ?? null : null))
      : input.location
    if (location && !project.locations.some(item => sameLocation(item, location))) throw validationError('Research location must exactly match a configured project location.', { location })
    const template = input.template
      ? resolveResearchTemplate(app, project.id, input.template, scope, location)
      : null
    const requestedModel = input.model ?? null
    const resolvedModel = requestedModel ?? (project.providerModels[providerName] || opts.getEffectiveProviderModels?.()[providerName] || adapter.defaultModel)
    adapter.modelValidationPattern.lastIndex = 0
    if (!adapter.modelValidationPattern.test(resolvedModel)) throw validationError('Invalid resolved model "' + resolvedModel + '" for provider "' + providerName + '".', { provider: providerName, model: resolvedModel, hint: adapter.modelValidationHint })
    if (deduplicateResearchQueries(input.queries).length !== input.queries.length) throw validationError('Research queries must be unique within a batch.')
    const queryClasses = classifyResearchQueries(project, active?.plan ?? null, input.queries)
    const now = new Date().toISOString()
    const initiatedBy = researchPrincipal(request)
    const decision = app.db.transaction((tx) => {
      if (input.idempotencyKey) {
        const existing = tx.select().from(researchRuns).where(and(eq(researchRuns.projectId, project.id), eq(researchRuns.idempotencyKey, input.idempotencyKey))).get()
        if (existing) {
          assertSameDirectResearchRequest(existing, input, requestHash)
          return { reused: true as const, id: existing.id, shouldDispatch: existing.status === ResearchRunStatuses.queued }
        }
      }
      if (initiatedBy?.limited) {
        const { start, end, date } = utcDayBounds(now)
        const used = tx.select({ value: count() }).from(researchRuns).where(and(
          eq(researchRuns.projectId, project.id),
          gte(researchRuns.createdAt, start),
          lt(researchRuns.createdAt, end),
          sql`(json_extract(${researchRuns.initiatedBy}, '$.role') = ${UserRoles.viewer} OR json_extract(${researchRuns.initiatedBy}, '$.limited') = 1)`,
        )).get()?.value ?? 0
        if (used >= viewerDailyRunLimit) {
          throw researchDailyLimitExceeded(project.name, viewerDailyRunLimit, date)
        }
      }
      const id = crypto.randomUUID()
      tx.insert(researchRuns).values({ id, projectId: project.id, status: ResearchRunStatuses.queued, provider: providerName, requestedModel, resolvedModel, location: location ?? null, totalQueries: input.queries.length, scope, template, idempotencyKey: input.idempotencyKey ?? null, requestHash: input.idempotencyKey ? requestHash : null, initiatedBy, createdAt: now }).run()
      for (const [position, query] of input.queries.entries()) tx.insert(researchRunQueries).values({ id: crypto.randomUUID(), researchRunId: id, position, queryText: query, queryClass: queryClasses[position] ?? null, status: ResearchQueryStatuses.queued, requestedModel, resolvedModel, groundingSources: [], citedDomains: [], searchQueries: [], createdAt: now }).run()
      writeAuditLog(tx, { projectId: project.id, actor: 'api', action: 'research.created', entityType: 'research_run', entityId: id })
      return { reused: false as const, id, shouldDispatch: true }
    })
    const result = getDetail(app, project.id, decision.id)
    if (decision.shouldDispatch) opts.onResearchRunRequested(decision.id, project.id)
    if (decision.reused) return reply.status(200).send(result)
    return reply.status(202).send(result)
  })

  app.post<{ Params: { name: string }; Body: unknown }>('/projects/:name/research/batches', {
    config: { paidRead: true, writeScope: RESEARCH_RUN_SCOPE },
  }, async (request, reply) => {
    requireResearchGrant(request, opts.allowViewers ?? false)
    const project = resolveProject(app.db, request.params.name)
    const parsed = researchBatchCreateSchema.safeParse(request.body ?? {})
    if (!parsed.success) throw validationError('Invalid research batch request', { issues: parsed.error.issues })
    const input = parsed.data
    if (input.idempotencyKey.startsWith(BATCH_RECEIPT_PREFIX)) throw validationError('This idempotency key prefix is reserved for internal research batch receipts.')
    const requestHash = researchBatchRequestHash(input)
    const receiptKeys = input.runs.map((_run, index) => batchChildReceiptKey(input.idempotencyKey, index))

    // Receipt lookup deliberately precedes any plan, template, provider, or default-model
    // validation. A retry is a read of frozen work, not a request to re-resolve it.
    const firstReceipt = app.db.select().from(researchRuns).where(and(
      eq(researchRuns.projectId, project.id), eq(researchRuns.idempotencyKey, receiptKeys[0]!),
    )).get()
    if (firstReceipt) {
      if (firstReceipt.requestHash !== requestHash) throw alreadyExists('Research batch idempotency key', input.idempotencyKey)
      const saved = receiptKeys.map(key => app.db.select().from(researchRuns).where(and(
        eq(researchRuns.projectId, project.id), eq(researchRuns.idempotencyKey, key),
      )).get())
      if (saved.some(row => !row || row.requestHash !== requestHash)) throw alreadyExists('Research batch idempotency key', input.idempotencyKey)
      const runs = saved.map(row => getDetail(app, project.id, row!.id))
      for (const run of runs) if (run.status === ResearchRunStatuses.queued) opts.onResearchRunRequested?.(run.id, project.id)
      return reply.status(200).send({ runs } satisfies ResearchBatchDto)
    }

    if (!opts.onResearchRunRequested) throw missingDependency('Research execution is not available on this deployment.', { reason: 'no-research-handler' })
    const active = activeMeasurementPlan(app.db, project.id)
    const prepared = input.runs.map(run => prepareBatchRun(app, opts, project, active, run))
    const now = new Date().toISOString()
    const initiatedBy = researchPrincipal(request)
    const decision = app.db.transaction((tx) => {
      if (initiatedBy?.limited) {
        const { start, end, date } = utcDayBounds(now)
        const used = tx.select({ value: count() }).from(researchRuns).where(and(
          eq(researchRuns.projectId, project.id),
          gte(researchRuns.createdAt, start),
          lt(researchRuns.createdAt, end),
          sql`(json_extract(${researchRuns.initiatedBy}, '$.role') = ${UserRoles.viewer} OR json_extract(${researchRuns.initiatedBy}, '$.limited') = 1)`,
        )).get()?.value ?? 0
        if (used + prepared.length > viewerDailyRunLimit) throw researchDailyLimitExceeded(project.name, viewerDailyRunLimit, date)
      }
      const ids: string[] = []
      for (const [index, run] of prepared.entries()) {
        const id = crypto.randomUUID()
        ids.push(id)
        tx.insert(researchRuns).values({
          id, projectId: project.id, status: ResearchRunStatuses.queued, provider: run.providerName,
          requestedModel: run.requestedModel, resolvedModel: run.resolvedModel, location: run.location,
          totalQueries: run.input.queries.length, scope: run.scope, template: run.template,
          idempotencyKey: receiptKeys[index]!, requestHash, initiatedBy, createdAt: now,
        }).run()
        for (const [position, query] of run.input.queries.entries()) tx.insert(researchRunQueries).values({
          id: crypto.randomUUID(), researchRunId: id, position, queryText: query,
          queryClass: run.queryClasses[position] ?? null, status: ResearchQueryStatuses.queued,
          requestedModel: run.requestedModel, resolvedModel: run.resolvedModel,
          groundingSources: [], citedDomains: [], searchQueries: [], createdAt: now,
        }).run()
        writeAuditLog(tx, { projectId: project.id, actor: 'api', action: 'research.created', entityType: 'research_run', entityId: id })
      }
      return { ids }
    })
    const runs = decision.ids.map(id => getDetail(app, project.id, id))
    for (const id of decision.ids) opts.onResearchRunRequested(id, project.id)
    return reply.status(202).send({ runs } satisfies ResearchBatchDto)
  })

  app.get<{ Params: { name: string }; Querystring: { limit?: string; cursor?: string } }>('/projects/:name/research/runs', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const requested = Number.parseInt(request.query.limit ?? '', 10)
    const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 100) : 20
    const cursor = request.query.cursor ? parseResearchCursor(request.query.cursor, project.id) : null
    const rows = app.db.select().from(researchRuns).where(and(
      eq(researchRuns.projectId, project.id),
      cursor ? or(lt(researchRuns.createdAt, cursor.createdAt), and(eq(researchRuns.createdAt, cursor.createdAt), lt(researchRuns.id, cursor.id))) : undefined,
    )).orderBy(desc(researchRuns.createdAt), desc(researchRuns.id)).limit(limit + 1).all()
    const runs = rows.slice(0, limit).map(serializeRun)
    const last = runs.at(-1)
    const nextCursor = rows.length > limit && last
      ? Buffer.from(JSON.stringify({ projectId: project.id, createdAt: last.createdAt, id: last.id })).toString('base64url')
      : null
    const configured = new Set(opts.configuredProviderNames ?? [])
    const effectiveModels = opts.getEffectiveProviderModels?.() ?? {}
    const providers = (opts.providerAdapters ?? [])
      .filter(adapter => adapter.mode === 'api' && !isBrowserProvider(adapter.name) && configured.has(adapter.name))
      .map(adapter => {
        const defaultModel = project.providerModels[adapter.name] || effectiveModels[adapter.name] || adapter.defaultModel
        const cached = opts.getCachedProviderModels?.(adapter.name) ?? []
        const models = cached.length ? cached : adapter.knownModels
        return {
          name: adapter.name,
          displayName: adapter.displayName,
          modelConfigurable: adapter.modelConfigurable,
          defaultModel,
          knownModels: [...new Map([{ id: defaultModel, displayName: defaultModel }, ...models].map(model => [model.id, { id: model.id, displayName: model.displayName }])).values()],
        }
      })
    const canRun = canRunResearch(request, opts.allowViewers ?? false)
    const limited = request.principal !== undefined && !request.principal.scopes.includes(WILDCARD_SCOPE)
    return { runs, nextCursor, providers, access: { canRun, dailyRunLimit: canRun && limited ? viewerDailyRunLimit : null } } satisfies ResearchRunListDto
  })

  app.get<{ Params: { name: string; runId: string } }>('/projects/:name/research/runs/:runId', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    return getDetail(app, project.id, request.params.runId)
  })
}


const DIRECT_REQUEST_HASH_VERSION = 'direct-v2:'
function directResearchRequestHash(input: ResearchRunCreate): string {
  const { idempotencyKey: _key, ...request } = input
  return DIRECT_REQUEST_HASH_VERSION + crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex')
}

/** Existing receipts are immutable work; mutable settings never decide their retry identity. */
function assertSameDirectResearchRequest(existing: typeof researchRuns.$inferSelect, input: ResearchRunCreate, hash: string): void {
  if (existing.requestHash?.startsWith(DIRECT_REQUEST_HASH_VERSION)) {
    if (existing.requestHash !== hash) throw alreadyExists('Research idempotency key', input.idempotencyKey!)
    return
  }
  // Legacy receipts hashed resolved defaults. Reconstruct those from the saved row,
  // while still checking any explicit request values and the original ordered text.
  const scope = input.scope ? resolveStoredResearchScope(existing.scope, input.scope, input.idempotencyKey!) : null
  const template = input.template ? resolveStoredResearchTemplate(existing.template, input.template, input.idempotencyKey!) : null
  if (input.template?.bindingLocation !== undefined) throw alreadyExists('Research idempotency key', input.idempotencyKey!)
  const normalized = {
    queries: input.queries, provider: input.provider ?? existing.provider, model: input.model ?? null,
    location: input.location === undefined ? existing.location ?? null : input.location,
    ...(scope ? { scope } : {}), ...(template ? { template } : {}),
  }
  if (crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex') !== existing.requestHash) throw alreadyExists('Research idempotency key', input.idempotencyKey!)
}

const researchCursorSchema = z.object({ projectId: z.string().min(1), createdAt: z.string().datetime({ offset: true }), id: z.string().min(1).max(256) }).strict()
function parseResearchCursor(value: string, projectId: string): z.infer<typeof researchCursorSchema> {
  try {
    if (value.length > 2048 || !/^[\w-]+$/.test(value)) throw new Error('Invalid encoding')
    const cursor = researchCursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')))
    if (cursor.projectId !== projectId) throw new Error('Different project')
    return cursor
  } catch {
    throw validationError('Invalid research history cursor. Reload the first page and try again.')
  }
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

function batchChildReceiptKey(rootKey: string, index: number): string {
  const derived = crypto.createHash('sha256').update(`${rootKey}\u0000${index}`).digest('hex')
  return `${BATCH_RECEIPT_PREFIX}${derived}:${index}`
}

function researchBatchRequestHash(input: ResearchBatchCreate): string {
  // Zod reconstructs fields in schema order, so equivalent JSON objects have one stable
  // representation while query text and destination order stay intentionally exact.
  return crypto.createHash('sha256').update(JSON.stringify({ runs: input.runs })).digest('hex')
}

type PreparedBatchRun = {
  input: ResearchBatchCreate['runs'][number]
  providerName: string
  requestedModel: string
  resolvedModel: string
  location: LocationContext | null
  scope: ResearchRunScope | null
  template: QueryTrackingTemplateProvenance | null
  queryClasses: Array<'branded' | 'non-brand' | null>
}

type ResearchProject = Parameters<typeof effectiveBrandNames>[0] & {
  id: string
  locations: LocationContext[]
}

function prepareBatchRun(
  app: FastifyInstance,
  opts: ResearchRoutesOptions,
  project: ResearchProject,
  active: ActiveMeasurementPlan | null,
  input: ResearchBatchCreate['runs'][number],
): PreparedBatchRun {
  const adapters = opts.providerAdapters ?? []
  const configured = new Set(opts.configuredProviderNames ?? [])
  const providerName = input.provider
  const adapter = adapters.find(candidate => candidate.name === providerName)
  if (!adapter || adapter.mode !== 'api' || isBrowserProvider(providerName) || !configured.has(providerName)) {
    throw validationError('Research requires a configured API provider.', { provider: providerName, validProviders: adapters.filter(a => a.mode === 'api' && configured.has(a.name)).map(a => a.name) })
  }
  adapter.modelValidationPattern.lastIndex = 0
  if (!adapter.modelValidationPattern.test(input.model) || (!adapter.modelConfigurable && input.model !== adapter.defaultModel)) {
    throw validationError(`Invalid model "${input.model}" for provider "${providerName}".`, { provider: providerName, model: input.model, hint: adapter.modelValidationHint })
  }
  const location = input.location
  if (location && !project.locations.some(item => sameLocation(item, location))) {
    throw validationError('Research location must exactly match a configured project location.', { location })
  }
  if (deduplicateResearchQueries(input.queries).length !== input.queries.length) throw validationError('Research queries must be unique within each batch destination.')
  const scope = input.scope ? resolveResearchScope(active, input.scope) : null
  const template = input.template ? resolveResearchTemplate(app, project.id, input.template, scope, location) : null
  return {
    input,
    providerName,
    requestedModel: input.model,
    // The batch contract requires the model so retries never consult a project or instance default.
    resolvedModel: input.model,
    location,
    scope,
    template,
    queryClasses: classifyResearchQueries(project, active?.plan ?? null, input.queries),
  }
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
  app: FastifyInstance, projectId: string, selection: ResearchTemplateSelection, scope: ResearchRunScope | null, location: LocationContext | null,
): QueryTrackingTemplateProvenance {
  const savedTemplate = app.db.select().from(measurementQueryTemplates).where(and(
    eq(measurementQueryTemplates.projectId, projectId), eq(measurementQueryTemplates.id, selection.templateId),
  )).get()
  if (!savedTemplate) throw validationError('Unknown or stale research template. Reload the selected template and try again.')
  const templateVersion = savedTemplate.updatedAt
  if (templateVersion !== selection.templateVersion) {
    throw validationError('The selected research template is stale. Reload it and try again.')
  }
  const bindingLocation = selection.bindingLocation === undefined ? location : selection.bindingLocation
  if (bindingLocation) {
    const project = app.db.select({ locations: projects.locations }).from(projects).where(eq(projects.id, projectId)).get()!
    if (!project.locations.some(item => sameLocation(item, bindingLocation))) throw validationError('Research template binding location must match a configured project location.')
  }
  const { bindings, output } = expandResearchTemplate(savedTemplate, scope, bindingLocation)
  if (!output || output.length > 4000) throw validationError('Research template output must be between 1 and 4000 characters.')
  return { templateId: selection.templateId, templateVersion, template: savedTemplate.pattern, bindings, output }
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
  const actor = principal.delegatedUser ? { ...principal.delegatedUser, kind: 'user' as const } : principal
  return {
    kind: actor.kind,
    id: actor.id,
    name: actor.name,
    role: actor.kind === 'user' ? actor.role ?? null : null,
    ...(!principal.scopes.includes(WILDCARD_SCOPE) ? { limited: true } : {}),
  }
}

function utcDayBounds(now: string): { start: string; end: string; date: string } {
  const date = now.slice(0, 10)
  const start = `${date}T00:00:00.000Z`
  const end = new Date(Date.parse(start) + 24 * 60 * 60 * 1000).toISOString()
  return { start, end, date }
}
