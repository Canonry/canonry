import type { FastifyInstance } from 'fastify'
import {
  buildContentTargetRows,
  buildContentSourceRows,
  buildContentGapRows,
} from '@ainyc/canonry-intelligence'
import {
  validationError,
  type ContentTargetsResponseDto,
  type ContentSourcesResponseDto,
  type ContentGapsResponseDto,
} from '@ainyc/canonry-contracts'

import { resolveProject } from './helpers.js'
import { loadOrchestratorInput } from './content-data.js'

export async function contentRoutes(app: FastifyInstance) {
  // GET /projects/:name/content/targets — ranked, action-typed opportunity list
  app.get<{
    Params: { name: string }
    Querystring: { limit?: string; ['include-in-progress']?: string }
  }>('/projects/:name/content/targets', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const includeInProgress = request.query['include-in-progress'] === 'true'
    const limit = parseLimitParam(request.query.limit)

    const input = loadOrchestratorInput(app.db, project)
    let rows = buildContentTargetRows(input)
    if (!includeInProgress) {
      rows = rows.filter((r) => r.existingAction === null)
    }
    if (limit !== undefined) {
      rows = rows.slice(0, limit)
    }

    const response: ContentTargetsResponseDto = {
      targets: rows,
      contextMetrics: {
        totalAiReferralSessions: input.totalAiReferralSessions,
        latestRunId: input.latestRunId,
        runTimestamp: input.latestRunTimestamp,
      },
    }
    return response
  })

  // GET /projects/:name/content/sources — URL-level competitive evidence map
  app.get<{
    Params: { name: string }
  }>('/projects/:name/content/sources', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const input = loadOrchestratorInput(app.db, project)
    const rows = buildContentSourceRows(input)

    const response: ContentSourcesResponseDto = {
      sources: rows,
      latestRunId: input.latestRunId,
    }
    return response
  })

  // GET /projects/:name/content/gaps — competitor-only-cited queries
  app.get<{
    Params: { name: string }
  }>('/projects/:name/content/gaps', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const input = loadOrchestratorInput(app.db, project)
    const rows = buildContentGapRows(input)

    const response: ContentGapsResponseDto = {
      gaps: rows,
      latestRunId: input.latestRunId,
    }
    return response
  })
}

function parseLimitParam(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
    throw validationError('"limit" must be a non-negative integer')
  }
  return parsed
}
