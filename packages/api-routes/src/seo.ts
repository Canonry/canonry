import crypto from 'node:crypto'
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { SeoRepository, emptySeoResults, seoJobs, seoProfiles, seoTasks, type DatabaseClient, type SeoJobRow, type SeoTaskRow } from '@canonry/canonry-db'
import {
  SEO_RUN_SCOPE, SEO_WRITE_SCOPE, SeoAvailability, SeoCapabilities, SeoRunStatuses, SeoScopeKinds, SeoTargetKinds, UserRoles,
  normalizeHostname, missingDependency, notFound, validationError, seoProfileInputSchema, seoSyncInputSchema, seoRefreshIntentInputSchema, seoEvidenceQuerySchema, seoReconcileInputSchema,
  type SeoAdapter, type SeoAdapterRequest, type SeoContext, type SeoEvidenceQuery, type SeoOverview, type SeoProfile, type SeoProfileInput, type SeoQuote, type SeoResults, type SeoRun, type SeoRunDetail, type SeoStatus, type SeoOperatorTask, type SeoReconcileResult,
} from '@canonry/canonry-contracts'
import { requireAdminSession, requireScope, requireOperator } from './auth.js'
import { resolveProject, writeAuditLog } from './helpers.js'
import { activeMeasurementPlan } from './measurement-overview.js'
import { planScopeOptions } from './measurement-scope-options.js'

export interface SeoConnection { id: string; label: string; adapter: SeoAdapter }
export interface SeoPolicy { maxRunCostMicros: number; accountDailyLimitMicros: number; accountMonthlyLimitMicros: number; projectMonthlyLimitMicros: number }
export interface SeoRoutesOptions {
  /** Local configuration and cached prices only. Never performs provider I/O. */
  getSeoRuntime?: () => { connections: SeoConnection[]; policy: SeoPolicy } | null
  onSeoRunRequested?: (runId: string) => void
}
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex')
const actor = (request: FastifyRequest) => request.principal?.delegatedUser?.id ?? request.principal?.id ?? request.apiKey?.id ?? 'local'
function can(request: FastifyRequest, scope: string): boolean {
  const principal = request.principal
  const role = principal?.kind === 'user' ? principal.role : principal?.delegatedUser?.role
  if (role === UserRoles.viewer) return false
  const scopes = principal?.scopes ?? request.apiKey?.scopes
  return !scopes || scopes.includes('*') || scopes.includes(scope)
}
function profileDto(row: typeof seoProfiles.$inferSelect): SeoProfile {
  return { ...row.input, id: row.id, revision: row.revision, createdAt: row.createdAt, updatedAt: row.updatedAt }
}
function runDto(job: SeoJobRow, tasks: SeoTaskRow[]): SeoRun {
  return { id: job.id, projectId: job.projectKey, profileId: job.profileId, profileRevision: job.profileRevision, locationCode: job.profile.locationCode, languageCode: job.profile.languageCode, cancelRequested: job.cancelRequested, status: job.status, capabilities: job.profile.capabilities, scope: job.profile.scope, taskCount: tasks.length, completedTasks: tasks.filter(task => task.status === SeoRunStatuses.completed || task.status === SeoRunStatuses.partial).length, failedTasks: tasks.filter(task => task.status === SeoRunStatuses.failed).length, createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt, error: job.error }
}
function resultRows(tasks: SeoTaskRow[]): SeoResults {
  return tasks.reduce<SeoResults>((results, task) => ({ keywordMetrics: results.keywordMetrics.concat(task.results.keywordMetrics), domainIntelligence: results.domainIntelligence.concat(task.results.domainIntelligence), rankedKeywords: results.rankedKeywords.concat(task.results.rankedKeywords) }), emptySeoResults())
}

/** Frozen measurement context is lineage, never a denominator for vendor estimates. */
function resolveScope(db: DatabaseClient, projectId: string, input: SeoProfileInput): Record<string, unknown> {
  const active = activeMeasurementPlan(db, projectId)
  if (!active) {
    if (input.scope.kind !== SeoScopeKinds.project || input.scope.key || input.scope.expectedPlanRevision !== undefined) throw validationError('This project supports project SEO scope only.')
    return { mode: 'simple', scope: input.scope }
  }
  if (input.scope.expectedPlanRevision !== active.version.revision) throw validationError('Select the current Advanced Measurement revision before saving or refreshing this profile.')
  if (active.plan.schemaVersion !== 2) throw validationError('Publish a current Advanced Measurement plan before using scoped SEO profiles.')
  const plan = active.plan
  const option = planScopeOptions(plan, { marketLinks: true }).find(option => option.kind === input.scope.kind && (option.kind === SeoScopeKinds.project ? !input.scope.key : option.id === input.scope.key))
  if (!option) throw validationError('The selected SEO scope does not exist in this plan revision.')
  const market = input.scope.kind === SeoScopeKinds.market ? plan.reportingScopes?.find(market => market.stableKey === input.scope.key) : undefined
  const targetKeys = input.scope.kind === SeoScopeKinds.project ? plan.targets.map(target => target.stableKey) : input.scope.kind === SeoScopeKinds.property ? [input.scope.key!] : input.scope.kind === SeoScopeKinds.group ? plan.groups.find(group => group.stableKey === input.scope.key)!.targetKeys : [...new Set(market!.usageEdges.map(edge => edge.targetKey))]
  const targets = plan.targets.filter(target => targetKeys.includes(target.stableKey))
  if (input.scope.kind !== SeoScopeKinds.project && input.capabilities.some(capability => capability !== SeoCapabilities['keyword-metrics'])) {
    const hosts = new Set(targets.flatMap(target => target.urlMatchers.filter(matcher => matcher.kind === 'host').map(matcher => matcher.host)))
    if (targets.some(target => target.urlMatchers.length === 0 || target.urlMatchers.some(matcher => matcher.kind !== 'host'))) throw validationError('Path and entity Properties support explicit keyword metrics only in this release.')
    if (input.targets.some(target => target.kind !== SeoTargetKinds.host || target.includeSubdomains || !hosts.has(target.value))) throw validationError('This scope requires exact host Targets. A broader domain cannot substitute for a Property.')
  }
  const assignments = plan.assignments.filter(assignment => targetKeys.includes(assignment.targetKey) && (!market || market.usageEdges.some(edge => edge.targetKey === assignment.targetKey && edge.queryId === assignment.queryId && edge.executionNodeKey === assignment.executionNodeKey)))
  return { mode: 'advanced', planRevision: active.version.revision, planVersionId: active.version.id, scope: input.scope, targets, assignments, market: market ?? null }
}

function normalizeProfile(input: SeoProfileInput): SeoProfileInput {
  if (new Set(input.capabilities).size !== input.capabilities.length) throw validationError('Select each SEO capability once.')
  const targets = input.targets.map(target => {
    const host = normalizeHostname(target.value)
    if (!host) throw validationError('SEO Targets must be plain hostnames without paths or ports.')
    if (target.kind === SeoTargetKinds.host && target.includeSubdomains) throw validationError('Exact host Targets cannot include subdomains.')
    return { ...target, value: host }
  })
  if (new Set(targets.map(target => `${target.kind}:${target.value}:${target.includeSubdomains}`)).size !== targets.length) throw validationError('SEO Targets must be distinct.')
  const keywords = [...new Set(input.keywords)]
  if (input.capabilities.includes(SeoCapabilities['keyword-metrics']) && !keywords.length) throw validationError('Keyword metrics requires at least one explicit keyword.')
  if (input.capabilities.some(capability => capability !== SeoCapabilities['keyword-metrics']) && !targets.length) throw validationError('Domain capabilities require at least one explicit Target.')
  return { ...input, targets, keywords }
}
function taskRequests(profile: SeoProfileInput): SeoAdapterRequest[] {
  return profile.capabilities.flatMap(capability => (capability === SeoCapabilities['keyword-metrics'] ? [null] : profile.targets).map(target => ({ capability, target, keywords: capability === SeoCapabilities['keyword-metrics'] ? profile.keywords : [], locationCode: profile.locationCode, languageCode: profile.languageCode, limit: profile.limit, tag: '' })))
}

export async function seoRoutes(app: FastifyInstance, opts: SeoRoutesOptions) {
  const repository = new SeoRepository(app.db)
  // Intents are deliberately short-lived across restarts; durable accepted receipts remain replayable.
  const intentSecret = crypto.randomBytes(32)
  const getRuntime = () => opts.getSeoRuntime?.() ?? null
  const profiles = (projectId: string) => app.db.select().from(seoProfiles).where(eq(seoProfiles.projectId, projectId)).all().map(profileDto)
  const profile = (projectId: string, id: string) => {
    const row = app.db.select().from(seoProfiles).where(and(eq(seoProfiles.projectId, projectId), eq(seoProfiles.id, id))).get()
    if (!row) throw notFound('SEO profile', id)
    return profileDto(row)
  }
  const tasks = (id: string) => app.db.select().from(seoTasks).where(eq(seoTasks.jobId, id)).orderBy(asc(seoTasks.id)).all()
  const job = (projectId: string, id: string) => {
    const row = app.db.select().from(seoJobs).where(and(eq(seoJobs.projectId, projectId), isNotNull(seoJobs.runId), eq(seoJobs.id, id))).get()
    if (!row) throw notFound('SEO run', id)
    return row
  }
  const selected = (projectId: string, query: SeoEvidenceQuery, evidenceOnly = false) => {
    if (query.profileId) profile(projectId, query.profileId)
    if (!query.runId && !query.profileId && profiles(projectId).length > 1) throw validationError('Select an SEO profile explicitly.')
    if (query.runId) {
      const row = job(projectId, query.runId)
      if (query.profileId && row.profileId !== query.profileId) throw validationError('The SEO run does not belong to this profile.')
      return row
    }
    return app.db.select().from(seoJobs).where(and(eq(seoJobs.projectId, projectId), isNotNull(seoJobs.runId), query.profileId ? eq(seoJobs.profileId, query.profileId) : undefined, evidenceOnly ? inArray(seoJobs.status, [SeoRunStatuses.completed, SeoRunStatuses.partial]) : undefined)).orderBy(desc(seoJobs.createdAt), sql`seo_jobs.rowid DESC`).get() ?? null
  }
  const queryInput = (value: unknown): SeoEvidenceQuery => {
    const raw = (value ?? {}) as Record<string, unknown>
    const parsed = seoEvidenceQuerySchema.safeParse({ ...raw, ...(raw.limit === undefined ? {} : { limit: Number(raw.limit) }), ...(raw.offset === undefined ? {} : { offset: Number(raw.offset) }) })
    if (!parsed.success) throw validationError('Invalid SEO evidence selection.')
    return parsed.data
  }
  const status = (projectId: string): SeoStatus => {
    const runtime = getRuntime()
    const latest = app.db.select().from(seoJobs).where(and(eq(seoJobs.projectId, projectId), isNotNull(seoJobs.runId))).orderBy(desc(seoJobs.createdAt)).get()
    const last = app.db.select().from(seoJobs).where(and(eq(seoJobs.projectId, projectId), isNotNull(seoJobs.runId), inArray(seoJobs.status, [SeoRunStatuses.completed, SeoRunStatuses.partial]))).orderBy(desc(seoJobs.finishedAt)).get()
    const available = !!runtime?.connections.length && !!opts.onSeoRunRequested
    return { available, reason: available ? null : 'SEO execution is not configured on this host.', capabilities: [...new Set(runtime?.connections.flatMap(connection => [...connection.adapter.capabilities]) ?? [])], profileCount: profiles(projectId).length, latestRunId: latest?.id ?? null, latestRunStatus: latest?.status ?? null, lastCompletedAt: last?.finishedAt ?? null }
  }
  const planTasks = (input: SeoProfileInput) => {
    const runtime = getRuntime()
    const connection = runtime?.connections.find(connection => connection.id === input.connectionId)
    if (!runtime || !connection || !opts.onSeoRunRequested) throw missingDependency('SEO execution is not configured on this host.')
    let planned: Array<{ request: SeoAdapterRequest; reservedMicros: number; catalogRevision: string }>
    try { planned = taskRequests(input).map(request => { const estimate = connection.adapter.estimate(request); return { request, reservedMicros: estimate.maxCostMicros, catalogRevision: estimate.catalogRevision } }) } catch { throw validationError('This provider does not support the selected SEO scope or capability.') }
    const total = planned.reduce((sum, task) => sum + task.reservedMicros, 0)
    if (!planned.length || planned.some(task => !Number.isSafeInteger(task.reservedMicros) || task.reservedMicros <= 0) || !Number.isSafeInteger(total) || total > runtime.policy.maxRunCostMicros) throw validationError('SEO refresh is unavailable under the current policy.')
    const intentHash = hash(JSON.stringify({ provider: connection.adapter.provider, account: connection.adapter.accountKey, policy: runtime.policy, tasks: planned.map(task => ({ request: task.request, estimate: connection.adapter.estimate(task.request) })) }))
    return { ...runtime, connection, planned, intentHash }
  }
  app.get<{ Params: { id: string } }>('/seo/operator/tasks/:id', async request => {
    requireOperator(request)
    const task = app.db.select().from(seoTasks).where(eq(seoTasks.id, request.params.id)).get()
    if (!task) throw notFound('SEO task', request.params.id)
    return { id: task.id, runId: task.jobId, status: task.status, reservedCostMicros: task.reservedMicros, actualCostMicros: task.actualMicros, receipts: task.receipts } satisfies SeoOperatorTask
  })
  app.post<{ Params: { id: string }; Body: unknown }>('/seo/operator/tasks/:id/reconcile', { config: { writeScope: SEO_RUN_SCOPE } }, async request => {
    requireOperator(request); requireScope(request, SEO_RUN_SCOPE)
    const parsed = seoReconcileInputSchema.safeParse(request.body)
    if (!parsed.success) throw validationError('Provide a verified upstream receipt and reconciliation note.')
    const task = app.db.select().from(seoTasks).where(eq(seoTasks.id, request.params.id)).get()
    if (!task) throw notFound('SEO task', request.params.id)
    app.db.transaction(tx => {
      repository.reconcile(task.id, parsed.data)
      writeAuditLog(tx, { actor: 'api', action: 'seo.task.reconciled', entityType: 'seo-task', entityId: task.id })
    })
    opts.onSeoRunRequested?.(task.jobId)
    return { id: task.id, status: app.db.select().from(seoTasks).where(eq(seoTasks.id, task.id)).get()!.status } satisfies SeoReconcileResult
  })
  type Params = { name: string; id: string }
  app.get<{ Params: Params }>('/projects/:name/seo/context', async request => {
    const project = resolveProject(app.db, request.params.name)
    const current = status(project.id)
    const active = activeMeasurementPlan(app.db, project.id)
    const scopes: SeoContext['scopes'] = active?.plan.schemaVersion === 2 ? planScopeOptions(active.plan, { marketLinks: true }).map(option => ({ kind: option.kind, key: option.kind === SeoScopeKinds.project ? null : option.id, label: option.label, planRevision: active.version.revision, supported: true, reason: option.kind === SeoScopeKinds.project ? null : 'Domain metrics require provider-supported exact host Targets; path and entity Properties support keyword metrics.' })) : [{ kind: SeoScopeKinds.project, key: null, label: 'Project', supported: !active, reason: active ? 'Publish a current Advanced Measurement plan first.' : null }]
    return { available: current.available, reason: current.reason, connections: getRuntime()?.connections.map(connection => ({ id: connection.id, label: connection.label, provider: connection.adapter.provider, capabilities: [...connection.adapter.capabilities] })) ?? [], scopes, access: { canRun: can(request, SEO_RUN_SCOPE), canWrite: can(request, SEO_WRITE_SCOPE) } } satisfies SeoContext
  })
  app.get<{ Params: Params }>('/projects/:name/seo/status', async request => status(resolveProject(app.db, request.params.name).id))
  app.get<{ Params: Params }>('/projects/:name/seo/profiles', async request => ({ profiles: profiles(resolveProject(app.db, request.params.name).id) }))
  app.get<{ Params: Params }>('/projects/:name/seo/profiles/:id', async request => profile(resolveProject(app.db, request.params.name).id, request.params.id))
  app.put<{ Params: Params; Body: unknown }>('/projects/:name/seo/profiles/:id', { config: { writeScope: SEO_WRITE_SCOPE } }, async request => {
    requireScope(request, SEO_WRITE_SCOPE); requireAdminSession(request)
    const project = resolveProject(app.db, request.params.name)
    if (!/^[a-z0-9][\w.-]{0,99}$/i.test(request.params.id)) throw validationError('Use a stable SEO profile id of at most 100 letters, digits, dots, hyphens or underscores.')
    const parsed = seoProfileInputSchema.safeParse(request.body)
    if (!parsed.success) throw validationError('Invalid SEO profile.', { issues: parsed.error.issues })
    const input = normalizeProfile(parsed.data)
    resolveScope(app.db, project.id, input)
    planTasks(input)
    const now = new Date().toISOString()
    app.db.transaction(tx => {
      const current = tx.select().from(seoProfiles).where(and(eq(seoProfiles.projectId, project.id), eq(seoProfiles.id, request.params.id))).get()
      if (current && JSON.stringify(current.input) === JSON.stringify(input)) return
      tx.insert(seoProfiles).values({ projectId: project.id, id: request.params.id, revision: 1, input, createdAt: now, updatedAt: now }).onConflictDoUpdate({ target: [seoProfiles.projectId, seoProfiles.id], set: { input, revision: sql`${seoProfiles.revision} + 1`, updatedAt: now } }).run()
      writeAuditLog(tx, { projectId: project.id, actor: 'api', action: 'seo.profile.updated', entityType: 'seo-profile', entityId: request.params.id })
    })
    return profile(project.id, request.params.id)
  })
  app.post<{ Params: Params; Body: unknown }>('/projects/:name/seo/refresh-intents', { config: { readSemantic: true } }, async request => {
    const project = resolveProject(app.db, request.params.name)
    const parsed = seoRefreshIntentInputSchema.safeParse(request.body)
    if (!parsed.success) throw validationError('Select an SEO profile.')
    const saved = profile(project.id, parsed.data.profileId)
    const scope = resolveScope(app.db, project.id, saved)
    const planned = planTasks(saved)
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString()
    const payload = Buffer.from(JSON.stringify({ projectId: project.id, actor: actor(request), profileId: saved.id, revision: saved.revision, scopeHash: hash(JSON.stringify(scope)), intentHash: planned.intentHash, expiresAt })).toString('base64url')
    const signature = crypto.createHmac('sha256', intentSecret).update(payload).digest('base64url')
    return { token: `${payload}.${signature}`, expiresAt, profileId: saved.id, profileRevision: saved.revision, taskCount: planned.planned.length, targets: saved.targets, capabilities: saved.capabilities, availability: SeoAvailability.ready, reason: null } satisfies SeoQuote
  })
  app.post<{ Params: Params; Body: unknown }>('/projects/:name/seo/sync', { config: { paidRead: true, writeScope: SEO_RUN_SCOPE } }, async (request, reply) => {
    requireScope(request, SEO_RUN_SCOPE); requireAdminSession(request)
    const project = resolveProject(app.db, request.params.name)
    const parsed = seoSyncInputSchema.safeParse(request.body)
    if (!parsed.success) throw validationError('Invalid SEO refresh request.')
    const input = parsed.data
    const requestHash = hash(input.quoteToken)
    const existing = app.db.select().from(seoJobs).where(and(eq(seoJobs.projectId, project.id), eq(seoJobs.idempotencyKey, input.idempotencyKey))).get()
    if (existing) {
      if (!existing.runId) throw notFound('SEO run', existing.id)
      if (existing.requestHash !== requestHash || existing.principalId !== actor(request)) throw validationError('This idempotency key belongs to a different SEO refresh.')
      return runDto(existing, tasks(existing.id))
    }
    const [payload, signature, extra] = input.quoteToken.split('.')
    if (!payload || !signature || extra) throw validationError('Create a new SEO refresh intent.')
    const expected = crypto.createHmac('sha256', intentSecret).update(payload).digest()
    const actual = Buffer.from(signature, 'base64url')
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) throw validationError('Create a new SEO refresh intent.')
    let claims: { projectId: string; actor: string; profileId: string; revision: number; scopeHash: string; intentHash: string; expiresAt: string }
    try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as typeof claims } catch { throw validationError('Create a new SEO refresh intent.') }
    if (claims.projectId !== project.id || claims.actor !== actor(request) || Date.parse(claims.expiresAt) <= Date.now()) throw validationError('Create a new SEO refresh intent.')
    const saved = profile(project.id, claims.profileId)
    const scopeSnapshot = resolveScope(app.db, project.id, saved)
    if (saved.revision !== claims.revision || hash(JSON.stringify(scopeSnapshot)) !== claims.scopeHash) throw validationError('This SEO profile or measurement scope changed. Create a new refresh intent.')
    const runtime = planTasks(saved)
    if (runtime.intentHash !== claims.intentHash) throw validationError('The SEO connection or host policy changed. Create a new refresh intent.')
    const now = new Date().toISOString(); const account = runtime.connection.adapter.accountKey
    const id = repository.admit({ id: crypto.randomUUID(), projectId: project.id, profileId: saved.id, profileRevision: saved.revision, profile: saved, scopeSnapshot, requestHash, idempotencyKey: input.idempotencyKey, principalId: actor(request), accountKey: account, now, buckets: [
      { scope: `account-day:${account}`, period: now.slice(0, 10), limit: runtime.policy.accountDailyLimitMicros },
      { scope: `account-month:${account}`, period: now.slice(0, 7), limit: runtime.policy.accountMonthlyLimitMicros },
      { scope: `project-month:${project.id}`, period: now.slice(0, 7), limit: runtime.policy.projectMonthlyLimitMicros },
    ], tasks: runtime.planned.map(task => { const id = crypto.randomUUID(); return { ...task, id, request: { ...task.request, tag: id } } }) }, tx => writeAuditLog(tx, { projectId: project.id, actor: 'api', action: 'seo.sync.requested', entityType: 'run', entityId: input.idempotencyKey }))
    opts.onSeoRunRequested?.(id)
    return reply.status(202).send(runDto(job(project.id, id), tasks(id)))
  })
  app.get<{ Params: Params; Querystring: { profileId?: string } }>('/projects/:name/seo/runs', async request => {
    const project = resolveProject(app.db, request.params.name)
    const rows = app.db.select().from(seoJobs).where(and(eq(seoJobs.projectId, project.id), isNotNull(seoJobs.runId), request.query.profileId ? eq(seoJobs.profileId, request.query.profileId) : undefined)).orderBy(desc(seoJobs.createdAt), sql`seo_jobs.rowid DESC`).limit(100).all()
    return { runs: rows.map(row => runDto(row, tasks(row.id))) }
  })
  app.get<{ Params: Params }>('/projects/:name/seo/runs/:id', async request => {
    const row = job(resolveProject(app.db, request.params.name).id, request.params.id)
    const rows = tasks(row.id); const results = resultRows(rows)
    return { ...runDto(row, rows), tasks: rows.map(task => ({ id: task.id, capability: task.request.capability, target: task.request.target, status: task.status, error: task.error, remoteTaskId: task.receipts[0]?.remoteTaskId ?? null })), results: { keywordMetrics: results.keywordMetrics.slice(0, 20), domainIntelligence: results.domainIntelligence.slice(0, 20), rankedKeywords: results.rankedKeywords.slice(0, 20) }, resultCounts: { keywordMetrics: results.keywordMetrics.length, domainIntelligence: results.domainIntelligence.length, rankedKeywords: results.rankedKeywords.length }, resultsTruncated: Object.values(results).some(items => items.length > 20) } satisfies SeoRunDetail
  })
  app.post<{ Params: Params }>('/projects/:name/seo/runs/:id/cancel', { config: { paidRead: true, writeScope: SEO_RUN_SCOPE } }, async request => {
    requireScope(request, SEO_RUN_SCOPE); requireAdminSession(request)
    const project = resolveProject(app.db, request.params.name); const row = job(project.id, request.params.id)
    app.db.transaction(tx => { repository.cancel(row.id); writeAuditLog(tx, { projectId: project.id, actor: 'api', action: 'seo.sync.cancelled', entityType: 'run', entityId: row.id }) })
    return runDto(job(project.id, row.id), tasks(row.id))
  })
  app.get<{ Params: Params; Querystring: SeoEvidenceQuery }>('/projects/:name/seo/overview', async request => {
    const project = resolveProject(app.db, request.params.name); const query = queryInput(request.query); const latest = selected(project.id, query); const row = selected(project.id, query, true); const rows = row ? tasks(row.id) : []; const results = resultRows(rows)
    const primary = row?.profile.targets[0]
    const domain = primary ? results.domainIntelligence.find(result => result.target.kind === primary.kind && result.target.value === primary.value && result.target.includeSubdomains === primary.includeSubdomains) : null
    return { status: status(project.id), profiles: profiles(project.id), latestRun: latest ? runDto(latest, tasks(latest.id)) : null, evidenceRunId: row?.id ?? null, evidenceRun: row ? runDto(row, rows) : null, keywordMetricsCount: results.keywordMetrics.length, domainIntelligenceCount: results.domainIntelligence.length, rankedKeywordCount: results.rankedKeywords.length, summary: domain ? { target: domain.target, organicKeywords: domain.organicKeywords, inTop10: domain.top1 !== null && domain.top2To3 !== null && domain.top4To10 !== null ? domain.top1 + domain.top2To3 + domain.top4To10 : null, estimatedOrganicTraffic: domain.estimatedOrganicTraffic, provenance: domain.provenance } : null } satisfies SeoOverview
  })
  for (const [path, key] of [['keyword-metrics', 'keywordMetrics'], ['domain-intelligence', 'domainIntelligence'], ['ranked-keywords', 'rankedKeywords']] as const) app.get<{ Params: Params; Querystring: SeoEvidenceQuery }>(`/projects/:name/seo/${path}`, async request => {
    const query = queryInput(request.query); const row = selected(resolveProject(app.db, request.params.name).id, query, true)
    const items = row ? resultRows(tasks(row.id))[key] : []; const limit = query.limit ?? 50; const offset = query.offset ?? 0
    return { runId: row?.id ?? null, items: items.slice(offset, offset + limit), total: items.length, limit, offset }
  })
}
