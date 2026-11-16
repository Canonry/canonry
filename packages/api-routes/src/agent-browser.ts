import type { FastifyInstance } from 'fastify'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { agentBrowserChecks, agentBrowserResults, runs } from '@canonry/canonry-db'
import {
  RunKinds,
  RunStatuses,
  RunTriggers,
  agentBrowserCheckRequestSchema,
  agentBrowserPropertySite,
  agentBrowserRequestIdentity,
  agentBrowserSiteHosts,
  hostOf,
  isAgentBrowserSiteHost,
  missingDependency,
  normalizeAgentBrowserCheckRequest,
  notFound,
  operationInProgress,
  parseRunError,
  summarizeAgentBrowserResults,
  validationError,
} from '@canonry/canonry-contracts'
import type {
  AgentBrowserAgent,
  AgentBrowserCheckDto,
  AgentBrowserCheckScope,
  AgentBrowserCheckRunResponseDto,
  AgentBrowserChecksResponseDto,
  AgentBrowserPerception,
  AgentBrowserResultDto,
  AgentBrowserResultStatus,
  RunStatus,
  RunTrigger,
} from '@canonry/canonry-contracts'
import { resolveProject } from './helpers.js'
import { activeMeasurementPlan } from './measurement-overview.js'

export interface AgentBrowserRoutesOptions {
  /**
   * Fired after an `agent-browser-check` run row is created. The host runs the check in the
   * background (browser + agent loops) and records each agent run as it finishes.
   */
  onAgentBrowserCheckRequested?: (runId: string, projectId: string) => void
}

const LIST_DEFAULT_LIMIT = 20
const LIST_MAX_LIMIT = 100

type ResultRow = typeof agentBrowserResults.$inferSelect

/**
 * What a check covers. Without a Property: the project's site, from its home page. With one (an
 * Advanced Measurement portfolio): the Property's URL rules in the published plan, either plan
 * version, plus the project's own hosts, from the Property's most specific page. The plan
 * revision is frozen into the request, so a later plan change never rewrites a stored check.
 */
function resolveCheckScope(
  app: FastifyInstance,
  project: { id: string; name: string; canonicalDomain: string; ownedDomains: string[] },
  propertyKey: string | undefined,
  requestedStartUrl: string | undefined,
): AgentBrowserCheckScope {
  const projectHosts = agentBrowserSiteHosts(project.canonicalDomain, project.ownedDomains)
  if (propertyKey === undefined) {
    const mainHost = hostOf(project.canonicalDomain)
    if (!mainHost) throw validationError(`Project "${project.name}" has no usable domain to check.`)
    return { property: null, siteHosts: projectHosts, defaultStartUrl: `https://${mainHost}/` }
  }
  const active = activeMeasurementPlan(app.db, project.id)
  if (!active) {
    throw validationError('Checking a Property needs a published Advanced Measurement plan.', { reason: 'no-measurement-plan', property: propertyKey })
  }
  const targets = active.plan.schemaVersion === 2
    ? active.plan.targets.map((target) => ({ key: target.stableKey, label: target.label, rules: target.urlMatchers }))
    : active.plan.targets.map((target) => ({ key: target.stableKey, label: target.label, rules: target.urls }))
  const target = targets.find((candidate) => candidate.key === propertyKey)
  if (!target) {
    throw validationError(`Property "${propertyKey}" is not in the published measurement plan.`, {
      reason: 'unknown-property',
      property: propertyKey,
      properties: targets.map((candidate) => candidate.key),
    })
  }
  const site = agentBrowserPropertySite(target.rules)
  const defaultStartUrl = site.startUrl ?? requestedStartUrl
  if (!defaultStartUrl) {
    throw validationError(`Property "${target.label}" has no URL in the published measurement plan. Pass "startUrl".`, {
      reason: 'property-without-url',
      property: propertyKey,
    })
  }
  return {
    property: { key: target.key, label: target.label, planRevision: active.version.revision },
    siteHosts: [...site.hosts, ...projectHosts],
    defaultStartUrl,
  }
}

function toResultDto(row: ResultRow): AgentBrowserResultDto {
  return {
    id: row.id,
    agent: row.agent as AgentBrowserAgent,
    model: row.model,
    perception: row.perception as AgentBrowserPerception,
    attempt: row.attempt,
    status: row.status as AgentBrowserResultStatus,
    verified: row.verified,
    detail: row.detail,
    checks: row.checks,
    answer: row.answer,
    stop: row.stop,
    error: row.error,
    durationMs: row.durationMs,
    turns: row.turns,
    actions: row.actions,
    screenshots: row.screenshots,
    safetyChecks: row.safetyChecks,
    usage: row.usage,
    finalUrl: row.finalUrl,
    visited: row.visited,
    blockedPages: row.blockedPages,
    submissions: row.submissions,
    evidencePath: row.evidencePath,
    createdAt: row.createdAt,
  }
}

export async function agentBrowserRoutes(app: FastifyInstance, opts: AgentBrowserRoutesOptions) {
  // POST /projects/:name/agent-browser/checks — start a check, or join an identical active one.
  app.post<{ Params: { name: string }; Body: unknown }>('/projects/:name/agent-browser/checks', async (request): Promise<AgentBrowserCheckRunResponseDto> => {
    const project = resolveProject(app.db, request.params.name)
    const parsed = agentBrowserCheckRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      throw validationError(parsed.error.issues[0]?.message ?? 'Invalid agent-browser check request')
    }
    if (!opts.onAgentBrowserCheckRequested) {
      throw missingDependency('Agent-browser checks are not available on this deployment.', { reason: 'no-agent-browser-handler' })
    }
    const scope = resolveCheckScope(app, project, parsed.data.property, parsed.data.startUrl)
    const effective = normalizeAgentBrowserCheckRequest(parsed.data, scope)
    const start = new URL(effective.startUrl)
    if ((start.protocol !== 'https:' && start.protocol !== 'http:') || !isAgentBrowserSiteHost(start.hostname, effective.siteHosts)) {
      const site = effective.property ? `Property "${effective.property.label}"'s site or the project's` : 'the project\'s site'
      throw validationError(`"startUrl" must be a page on ${site} (${effective.siteHosts.join(', ')}).`, { siteHosts: effective.siteHosts })
    }
    const identityKey = agentBrowserRequestIdentity(effective)

    const result = app.db.transaction((tx) => {
      const existing = tx
        .select({ id: runs.id, status: runs.status, identityKey: agentBrowserChecks.identityKey, request: agentBrowserChecks.request })
        .from(runs)
        .leftJoin(agentBrowserChecks, and(eq(agentBrowserChecks.projectId, runs.projectId), eq(agentBrowserChecks.runId, runs.id)))
        .where(and(
          eq(runs.projectId, project.id),
          eq(runs.kind, RunKinds['agent-browser-check']),
          inArray(runs.status, [RunStatuses.queued, RunStatuses.running]),
        ))
        .get()
      if (existing) {
        if (existing.identityKey === identityKey) {
          return { runId: existing.id, status: existing.status as RunStatus, created: false }
        }
        throw operationInProgress(`An agent-browser check is already ${existing.status} with a different request.`, {
          activeRunId: existing.id,
          activeStatus: existing.status,
          activeRequest: existing.request,
          requestedRequest: effective,
        })
      }
      const now = new Date().toISOString()
      const runId = crypto.randomUUID()
      tx.insert(runs).values({
        id: runId,
        projectId: project.id,
        kind: RunKinds['agent-browser-check'],
        status: RunStatuses.queued,
        trigger: RunTriggers.manual,
        createdAt: now,
      }).run()
      tx.insert(agentBrowserChecks).values({ runId, projectId: project.id, identityKey, request: effective, createdAt: now }).run()
      return { runId, status: RunStatuses.queued as RunStatus, created: true }
    })

    if (result.created) opts.onAgentBrowserCheckRequested(result.runId, project.id)
    return { runId: result.runId, status: result.status, reused: !result.created }
  })

  // GET /projects/:name/agent-browser/checks — newest first, with each check's result counts.
  app.get<{ Params: { name: string }; Querystring: { limit?: string; property?: string } }>('/projects/:name/agent-browser/checks', async (request): Promise<AgentBrowserChecksResponseDto> => {
    const project = resolveProject(app.db, request.params.name)
    const rawLimit = request.query.limit
    const limit = rawLimit === undefined ? LIST_DEFAULT_LIMIT : Number(rawLimit)
    if (!Number.isInteger(limit) || limit < 1 || limit > LIST_MAX_LIMIT) {
      throw validationError(`"limit" must be a whole number from 1 to ${LIST_MAX_LIMIT}.`)
    }
    // A Property filter matches the key frozen into each check, so checks of a Property that
    // a later plan dropped stay readable.
    const property = request.query.property?.trim() || undefined
    const rows = app.db
      .select({
        id: runs.id,
        status: runs.status,
        trigger: runs.trigger,
        createdAt: runs.createdAt,
        finishedAt: runs.finishedAt,
        request: agentBrowserChecks.request,
      })
      .from(runs)
      .innerJoin(agentBrowserChecks, and(eq(agentBrowserChecks.projectId, runs.projectId), eq(agentBrowserChecks.runId, runs.id)))
      .where(and(
        eq(runs.projectId, project.id),
        eq(runs.kind, RunKinds['agent-browser-check']),
        property === undefined ? undefined : sql`json_extract(${agentBrowserChecks.request}, '$.property.key') = ${property}`,
      ))
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit(limit)
      .all()
    const runIds = rows.map((r) => r.id)
    const results = runIds.length
      ? app.db
          .select({ runId: agentBrowserResults.runId, status: agentBrowserResults.status, verified: agentBrowserResults.verified })
          .from(agentBrowserResults)
          .where(and(eq(agentBrowserResults.projectId, project.id), inArray(agentBrowserResults.runId, runIds)))
          .all()
      : []
    return {
      project: project.name,
      checks: rows.map((row) => {
        const own = results.filter((r) => r.runId === row.id).map((r) => ({ status: r.status as AgentBrowserResultStatus, verified: r.verified }))
        return {
          runId: row.id,
          property: row.request.property ? { key: row.request.property.key, label: row.request.property.label } : null,
          status: row.status as RunStatus,
          trigger: row.trigger as RunTrigger,
          createdAt: row.createdAt,
          finishedAt: row.finishedAt,
          task: row.request.task,
          startUrl: row.request.startUrl,
          agents: row.request.agents.map((a) => a.agent),
          summary: summarizeAgentBrowserResults(own, row.request.agents.length * row.request.repeats),
        }
      }),
    }
  })

  // GET /projects/:name/agent-browser/checks/:runId — one check with every agent run.
  app.get<{ Params: { name: string; runId: string } }>('/projects/:name/agent-browser/checks/:runId', async (request): Promise<AgentBrowserCheckDto> => {
    const project = resolveProject(app.db, request.params.name)
    const row = app.db
      .select({
        id: runs.id,
        status: runs.status,
        trigger: runs.trigger,
        createdAt: runs.createdAt,
        startedAt: runs.startedAt,
        finishedAt: runs.finishedAt,
        error: runs.error,
        request: agentBrowserChecks.request,
      })
      .from(runs)
      .innerJoin(agentBrowserChecks, and(eq(agentBrowserChecks.projectId, runs.projectId), eq(agentBrowserChecks.runId, runs.id)))
      .where(and(eq(runs.projectId, project.id), eq(runs.id, request.params.runId), eq(runs.kind, RunKinds['agent-browser-check'])))
      .get()
    if (!row) throw notFound('Agent-browser check', request.params.runId)
    const resultRows = app.db
      .select()
      .from(agentBrowserResults)
      .where(and(eq(agentBrowserResults.projectId, project.id), eq(agentBrowserResults.runId, row.id)))
      .all()
      .sort((a, b) => a.agent.localeCompare(b.agent) || a.attempt - b.attempt)
    const results = resultRows.map(toResultDto)
    return {
      runId: row.id,
      project: project.name,
      status: row.status as RunStatus,
      trigger: row.trigger as RunTrigger,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      error: parseRunError(row.error)?.message ?? null,
      request: row.request,
      summary: summarizeAgentBrowserResults(results, row.request.agents.length * row.request.repeats),
      results,
    }
  })
}
