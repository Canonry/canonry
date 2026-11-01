import { and, eq, gte, lte } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { unrecognizedAgentEventsHourly } from '@canonry/canonry-db'
import {
  formatValidationIssues,
  trafficUnrecognizedAgentsQuerySchema,
  validationError,
  type TrafficUnrecognizedAgent,
  type TrafficUnrecognizedAgentsResponse,
} from '@canonry/canonry-contracts'
import { requireAdminSession } from './auth.js'
import { resolveProject } from './helpers.js'

const DEFAULT_WINDOW_MS = 30 * 86_400_000
const DEFAULT_LIMIT = 100

function hourFloor(iso: string): string {
  const date = new Date(iso)
  date.setUTCMinutes(0, 0, 0)
  return date.toISOString()
}

/** Bots and agents no classifier rule recognizes, summed by name. Stored rows only. */
export async function trafficUnrecognizedAgentsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { name: string }; Querystring: Record<string, unknown> }>('/projects/:name/traffic/unrecognized-agents', async request => {
    requireAdminSession(request)
    const project = resolveProject(app.db, request.params.name)
    const input = { ...request.query }
    if (input.limit !== undefined) input.limit = Number(input.limit)
    const parsed = trafficUnrecognizedAgentsQuerySchema.safeParse(input)
    if (!parsed.success) throw validationError(formatValidationIssues(parsed.error.issues), { issues: parsed.error.issues.map(({ path, message }) => ({ path, message })) })
    const query = parsed.data
    const windowEnd = new Date(query.until ?? Date.now()).toISOString()
    const windowStart = new Date(query.since ?? Date.parse(windowEnd) - DEFAULT_WINDOW_MS).toISOString()
    if (windowStart > windowEnd) throw validationError('since must not be after until', { reason: 'invalid-window' })

    // Rows are hourly, so a window starting mid-hour still includes that hour.
    const scope = [eq(unrecognizedAgentEventsHourly.projectId, project.id)]
    if (query.sourceId) scope.push(eq(unrecognizedAgentEventsHourly.sourceId, query.sourceId))
    const rows = app.db.select().from(unrecognizedAgentEventsHourly)
      .where(and(...scope, gte(unrecognizedAgentEventsHourly.tsHour, hourFloor(windowStart)), lte(unrecognizedAgentEventsHourly.tsHour, windowEnd)))
      .all()

    const byName = new Map<string, TrafficUnrecognizedAgent>()
    for (const row of rows) {
      const agent = byName.get(row.agentName)
      if (!agent) {
        byName.set(row.agentName, {
          name: row.agentName, hits: row.hits, firstSeenAt: row.tsHour, lastSeenAt: row.tsHour,
          sampleUserAgent: row.sampledUserAgent, samplePath: row.sampledPath, sourceIds: [row.sourceId],
        })
        continue
      }
      agent.hits += row.hits
      if (row.tsHour >= agent.lastSeenAt) {
        agent.lastSeenAt = row.tsHour
        agent.sampleUserAgent = row.sampledUserAgent
        agent.samplePath = row.sampledPath
      }
      if (!agent.sourceIds.includes(row.sourceId)) agent.sourceIds.push(row.sourceId)
    }

    const agents = [...byName.values()].sort((a, b) => b.hits - a.hits || a.name.localeCompare(b.name)).slice(0, query.limit ?? DEFAULT_LIMIT)
    // First seen comes from every stored hour, not just this window.
    for (const agent of agents) {
      const earliest = app.db.select({ tsHour: unrecognizedAgentEventsHourly.tsHour }).from(unrecognizedAgentEventsHourly)
        .where(and(...scope, eq(unrecognizedAgentEventsHourly.agentName, agent.name)))
        .orderBy(unrecognizedAgentEventsHourly.tsHour).limit(1).get()
      if (earliest) agent.firstSeenAt = earliest.tsHour
      agent.sourceIds.sort()
    }

    const response: TrafficUnrecognizedAgentsResponse = {
      scope: { project: project.name, sourceId: query.sourceId ?? null },
      windowStart,
      windowEnd,
      totalAgents: byName.size,
      totalHits: rows.reduce((sum, row) => sum + row.hits, 0),
      agents,
    }
    return response
  })
}
