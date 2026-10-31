import { and, asc, eq, gte, lte, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { agentJourneyCaptureDays, agentJourneyEvents, aiUserFetchLikelyFakeHourly, trafficSources, type DatabaseClient } from '@canonry/canonry-db'
import {
  AGENT_JOURNEY_DAILY_EVENT_LIMIT, AGENT_JOURNEY_IDLE_MINUTES, AGENT_JOURNEY_READ_EVENT_LIMIT, AGENT_JOURNEY_RETENTION_DAYS,
  AgentJourneyAttributions, AgentJourneyCorrelationBases, AgentTrustLevels, TrafficSourceTypes, TrafficSourceStatuses,
  agentJourneysQuerySchema, compareText, formatValidationIssues, notFound, resolveMeasurementTarget, trafficSourceTypeSchema, validationError,
  type AgentJourney, type AgentJourneyContext, type AgentJourneyDetailResponse, type AgentJourneyEvent,
  type AgentJourneysQuery, type AgentJourneysResponse, type MeasurementTargetUrlMatcher, type StoredAgentTrust, type TrafficSourceType,
} from '@canonry/canonry-contracts'
import { requireAdminSession } from './auth.js'
import { resolveProject } from './helpers.js'
import { activeMeasurementPlan } from './measurement-overview.js'

const DAY_MS = 86_400_000
const SOURCE_LIMITS: Record<TrafficSourceType, string[]> = {
  [TrafficSourceTypes['cloud-run']]: ['Only requests reaching the configured Cloud Run service are recorded. CDN hits and upstream blocks may be absent.'],
  [TrafficSourceTypes.wordpress]: ['Only requests reaching the WordPress logger are recorded. CDN/cache hits and upstream blocks may be absent.'],
  [TrafficSourceTypes.cloudflare]: ['Only requests forwarded by the deployed Worker are recorded. Upstream blocks and unrecognized agents may be absent.'],
  [TrafficSourceTypes.vercel]: ['The source reports no client IP. Requests remain unlinked; identical user agents never establish a session.'],
  [TrafficSourceTypes['generic-log']]: ['Coverage is limited to the requests supplied by this log source.'],
}

const STORED_TRUST_ORDER: readonly StoredAgentTrust[] = [AgentTrustLevels.verified, AgentTrustLevels.likely_real, AgentTrustLevels.unknown]

type EventRow = typeof agentJourneyEvents.$inferSelect
interface Sequence { rows: EventRow[]; events: AgentJourneyEvent[]; summary: AgentJourney }
interface Target { stableKey: string; label: string; urls: MeasurementTargetUrlMatcher[] }

function hourStart(iso: string): string {
  const date = new Date(iso)
  date.setUTCMinutes(0, 0, 0)
  return date.toISOString()
}

function parseSelection(raw: Record<string, unknown>): AgentJourneysQuery {
  const input = { ...raw }
  for (const key of ['limit', 'offset']) if (input[key] !== undefined) input[key] = Number(input[key])
  const parsed = agentJourneysQuerySchema.safeParse(input)
  if (!parsed.success) throw validationError(formatValidationIssues(parsed.error.issues), { issues: parsed.error.issues.map(({ path, message }) => ({ path, message })) })
  return parsed.data
}

function eventDto(row: EventRow, targets: Target[], hasPlan: boolean): AgentJourneyEvent {
  let attribution: AgentJourneyEvent['attribution'] = AgentJourneyAttributions['not-configured']
  let targetKey: string | null = null
  if (hasPlan) {
    if (!row.host) attribution = AgentJourneyAttributions['unknown-host']
    else if (/:(?:token|email)(?:\/|$)/.test(row.path)) attribution = AgentJourneyAttributions.redacted
    else {
      const match = resolveMeasurementTarget(`https://${row.host}${row.path}`, targets)
      if (match?.status === 'matched') { attribution = AgentJourneyAttributions.matched; targetKey = match.targetKey }
      else attribution = match ? AgentJourneyAttributions.ambiguous : AgentJourneyAttributions.unmatched
    }
  }
  return {
    id: row.id, ts: row.ts, host: row.host, path: row.path, method: row.method,
    status: row.status, latencyMs: row.latencyMs, verificationStatus: row.verificationStatus,
    verificationManifest: row.verificationManifest, trust: row.trust, trustReasons: row.trustReasons, targetKey, attribution,
  }
}

/** Group stored requests before narrowing Property/trust, so filters cannot join separate sequences. */
function sequences(rows: EventRow[], targets: Target[], hasPlan: boolean, query: AgentJourneysQuery): Sequence[] {
  const active = new Map<string, EventRow[]>()
  const groups: EventRow[][] = []
  for (const row of rows) {
    const key = `${row.sourceId}:${row.agentId}:${row.correlationKey}`
    const previous = active.get(key)
    if (row.correlationBasis === AgentJourneyCorrelationBases.unlinked || !previous || Date.parse(row.ts) - Date.parse(previous.at(-1)!.ts) >= AGENT_JOURNEY_IDLE_MINUTES * 60_000) {
      const next = [row]
      groups.push(next)
      active.set(key, next)
    } else previous.push(row)
  }
  const out: Sequence[] = []
  for (const group of groups) {
    const events = group.map(row => eventDto(row, targets, hasPlan)).filter(event =>
      (!query.targetKey || event.targetKey === query.targetKey)
      && (!query.trust || event.trust === query.trust))
    if (events.length === 0) continue
    const first = events[0]!
    const last = events.at(-1)!
    const anchor = group[0]!
    out.push({ rows: group, events, summary: {
      id: anchor.id, sourceId: anchor.sourceId, agentId: anchor.agentId, operator: anchor.operator, product: anchor.product,
      correlationBasis: anchor.correlationBasis,
      correlation: anchor.correlationBasis === AgentJourneyCorrelationBases['ip-ua'] ? 'inferred' : 'unlinked',
      startedAt: first.ts, endedAt: last.ts, firstHost: first.host, firstPath: first.path, lastPath: last.path,
      requestCount: events.length,
      errorCount: events.filter(event => event.status !== null && event.status >= 400 && event.status <= 599).length,
      trustLevels: STORED_TRUST_ORDER.filter(level => events.some(event => event.trust === level)),
      targetKeys: [...new Set(events.flatMap(event => event.targetKey ? [event.targetKey] : []))].sort(compareText),
    } })
  }
  return out.sort((a, b) => compareText(b.summary.startedAt, a.summary.startedAt) || compareText(b.summary.id, a.summary.id))
}

/** Stored evidence only. Refuse oversized reads instead of presenting truncated sequences as complete. */
function readSequences(db: DatabaseClient, name: string, query: AgentJourneysQuery, recordingEnabled: boolean): { context: AgentJourneyContext; groups: Sequence[] } {
  const project = resolveProject(db, name)
  const windowEnd = new Date(query.until ? (query.until.length === 10 ? `${query.until}T23:59:59.999Z` : query.until) : Date.now()).toISOString()
  const windowStart = new Date(query.since ?? Date.parse(windowEnd) - DAY_MS).toISOString()
  const duration = Date.parse(windowEnd) - Date.parse(windowStart)
  if (duration < 0 || duration > 31 * DAY_MS) throw validationError('Select an ordered window of at most 31 days.', { reason: 'invalid-window' })
  const sources = db.select().from(trafficSources).where(eq(trafficSources.projectId, project.id)).orderBy(asc(trafficSources.id)).all()
  if (query.sourceId && !sources.some(source => source.id === query.sourceId)) throw notFound('Traffic source', query.sourceId)
  const active = activeMeasurementPlan(db, project.id)
  const targets: Target[] = active ? active.plan.schemaVersion === 2
    ? active.plan.targets.map(target => ({ stableKey: target.stableKey, label: target.label, urls: target.urlMatchers }))
    : active.plan.targets.map(target => ({ stableKey: target.stableKey, label: target.label, urls: target.urls })) : []
  if (query.targetKey && !targets.some(target => target.stableKey === query.targetKey)) throw validationError('Select a Property from the current measurement plan.', { reason: 'unknown-target' })
  const retentionCutoff = new Date(Date.now() - AGENT_JOURNEY_RETENTION_DAYS * DAY_MS).toISOString()
  const filters = [eq(agentJourneyEvents.projectId, project.id), gte(agentJourneyEvents.ts, windowStart), gte(agentJourneyEvents.ts, retentionCutoff), lte(agentJourneyEvents.ts, windowEnd)]
  if (query.sourceId) filters.push(eq(agentJourneyEvents.sourceId, query.sourceId))
  if (query.agentId) filters.push(eq(agentJourneyEvents.agentId, query.agentId))
  const rows = db.select().from(agentJourneyEvents).where(and(...filters)).orderBy(asc(agentJourneyEvents.ts), asc(agentJourneyEvents.id)).limit(AGENT_JOURNEY_READ_EVENT_LIMIT + 1).all()
  if (rows.length > AGENT_JOURNEY_READ_EVENT_LIMIT) throw validationError('This selection exceeds 20,000 requests. Narrow the time window, source, or agent.', { reason: 'agent-journey-read-limit', limit: AGENT_JOURNEY_READ_EVENT_LIMIT })
  const capFilters = [eq(agentJourneyCaptureDays.projectId, project.id), eq(agentJourneyCaptureDays.capped, true), gte(agentJourneyCaptureDays.day, windowStart.slice(0, 10)), lte(agentJourneyCaptureDays.day, windowEnd.slice(0, 10))]
  if (query.sourceId) capFilters.push(eq(agentJourneyCaptureDays.sourceId, query.sourceId))
  const cappedSourceDays = db.select({ sourceId: agentJourneyCaptureDays.sourceId, day: agentJourneyCaptureDays.day }).from(agentJourneyCaptureDays).where(and(...capFilters)).orderBy(asc(agentJourneyCaptureDays.day), asc(agentJourneyCaptureDays.sourceId)).all()
  // Same selectors as the stored requests; the hourly totals bound the window to whole hours.
  const fakeFilters = [eq(aiUserFetchLikelyFakeHourly.projectId, project.id), gte(aiUserFetchLikelyFakeHourly.tsHour, hourStart(windowStart)), lte(aiUserFetchLikelyFakeHourly.tsHour, windowEnd)]
  if (query.sourceId) fakeFilters.push(eq(aiUserFetchLikelyFakeHourly.sourceId, query.sourceId))
  if (query.agentId) fakeFilters.push(eq(aiUserFetchLikelyFakeHourly.botId, query.agentId))
  const likelyFake = db.select({ total: sql<number>`COALESCE(SUM(${aiUserFetchLikelyFakeHourly.hits}), 0)` }).from(aiUserFetchLikelyFakeHourly).where(and(...fakeFilters)).get()
  const context: AgentJourneyContext = {
    scope: {
      project: project.name, sourceId: query.sourceId ?? null, agentId: query.agentId ?? null,
      trust: query.trust ?? null, targetKey: query.targetKey ?? null,
      mode: active ? 'advanced' : 'simple', planRevision: active?.version.revision ?? null,
      attribution: active ? 'current-plan-url' : 'project',
      unavailableDimensions: ['market', 'query', 'query-class', 'model', 'task'],
    },
    windowStart, windowEnd, properties: targets.map(target => ({ key: target.stableKey, label: target.label })),
    coverage: {
      recordingEnabled, retentionDays: AGENT_JOURNEY_RETENTION_DAYS, idleMinutes: AGENT_JOURNEY_IDLE_MINUTES,
      dailyEventLimit: AGENT_JOURNEY_DAILY_EVENT_LIMIT, windowBounded: true, cappedSourceDays,
      likelyFakeRequests: Number(likelyFake?.total ?? 0),
      sources: sources.map(source => ({
        sourceId: source.id, sourceType: trafficSourceTypeSchema.parse(source.sourceType), label: source.displayName,
        limitations: [
          ...SOURCE_LIMITS[trafficSourceTypeSchema.parse(source.sourceType)],
          ...(source.status === TrafficSourceStatuses.connected ? [] : [`Source is ${source.status}; new requests may not be recorded.`]),
          source.lastSyncedAt ? `Last recorded sync: ${source.lastSyncedAt}.` : 'No completed sync has been recorded for this source.',
          ...(source.skippedThroughAt ? [`Logs were skipped through ${source.skippedThroughAt}; the skipped interval may be absent.`] : []),
          ...(source.queueBacklogCount !== null && source.queueBacklogCount > 0 ? [`Queue reported ${source.queueBacklogCount} pending messages at ${source.queueBacklogObservedAt ?? 'an unknown time'}; newer requests may still be waiting.`] : []),
        ],
      })),
      limitations: [
        'Requests are observed; IP and user-agent sequences are inferred, not confirmed user sessions. Shared egress can merge tasks and changing IPs can split them.',
        'Operator verification does not identify a user, task, or model. Unknown browser agents are not detected.',
        'Trust levels other than verified are heuristics over the IP check, the user agent and the path. Likely fake requests (paths that look for credential or admin files, a user agent unlike the operator\'s published string, or an IP outside a current published list) are counted, not listed.',
        'Only retained requests inside this window are shown. Query strings, bodies and sensitive path segments are omitted. Static assets are excluded.',
        'HTTP responses do not establish clicks, intent, or business outcomes. External browsing and browser-only interactions are not observed.',
        'Requests with identical timestamps have a stable display order, not a proven causal order.',
        ...(active ? ['Property attribution uses the current plan and retained URL paths; it is not historical market or query attribution. Property and trust filters retain only matching requests.'] : []),
      ],
    },
  }
  return { context, groups: sequences(rows, targets, active !== null, query) }
}

export async function agentJourneyRoutes(app: FastifyInstance, opts: { journeyKeySecret?: string }): Promise<void> {
  app.get<{ Params: { name: string }; Querystring: Record<string, unknown> }>('/projects/:name/traffic/agent-journeys', async request => {
    requireAdminSession(request)
    const query = parseSelection(request.query)
    const { context, groups } = readSequences(app.db, request.params.name, query, Boolean(opts.journeyKeySecret))
    const limit = query.limit ?? 50
    const offset = query.offset ?? 0
    const response: AgentJourneysResponse = {
      ...context, observedRequests: groups.reduce((total, group) => total + group.events.length, 0),
      totalJourneys: groups.length, limit, offset, journeys: groups.slice(offset, offset + limit).map(group => group.summary),
    }
    return response
  })
  app.get<{ Params: { name: string; journeyId: string }; Querystring: Record<string, unknown> }>('/projects/:name/traffic/agent-journeys/:journeyId', async request => {
    requireAdminSession(request)
    const query = parseSelection(request.query)
    const { context, groups } = readSequences(app.db, request.params.name, query, Boolean(opts.journeyKeySecret))
    const group = groups.find(group => group.rows.some(row => row.id === request.params.journeyId))
    if (!group) throw notFound('Agent journey in this selection', request.params.journeyId)
    const limit = query.limit ?? 100
    const offset = query.offset ?? 0
    const response: AgentJourneyDetailResponse = { ...context, journey: group.summary, totalEvents: group.events.length, limit, offset, events: group.events.slice(offset, offset + limit) }
    return response
  })
}
