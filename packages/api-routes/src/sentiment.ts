import type { FastifyInstance } from 'fastify'
import {
  sentimentBackfillRequestSchema, sentimentBackfillSelectionSchema, sentimentCompareRequestSchema,
  sentimentEvidenceRequestSchema, sentimentJobRequestSchema, sentimentSettingsUpdateSchema, sentimentSummaryRequestSchema,
} from '@ainyc/canonry-contracts'
import { resolveProject } from './helpers.js'
import { canAdministerSentiment, requireSentimentAdministrator } from './sentiment-auth.js'
import { parseSentimentRequest, SentimentService, type SentimentServiceOptions } from './sentiment-service.js'

export type SentimentRoutesOptions = SentimentServiceOptions
/** All GET handlers read stored data. Only the host worker owns a classifier. */
export async function sentimentRoutes(app: FastifyInstance, options: SentimentRoutesOptions) {
  const service = new SentimentService(app.db, options)
  app.get<{ Params: { name: string } }>('/projects/:name/sentiment/settings', async request => service.settings(resolveProject(app.db, request.params.name).id, canAdministerSentiment(request)))
  app.put<{ Params: { name: string }; Body: unknown }>('/projects/:name/sentiment/settings', async request => {
    requireSentimentAdministrator(request)
    const project = resolveProject(app.db, request.params.name)
    const result = service.configure(project.id, parseSentimentRequest(sentimentSettingsUpdateSchema, request.body), request.principal?.delegatedUser?.id ?? request.principal?.id ?? 'local')
    return result
  })
  app.get<{ Params: { name: string }; Querystring: unknown }>('/projects/:name/sentiment', async request => {
    // include, queryLimit and queryCursor are tuning: they shape and page query rows, never the scored population.
    const { include, queryLimit, queryCursor, ...selection } = parseSentimentRequest(sentimentSummaryRequestSchema, request.query)
    return service.summary(resolveProject(app.db, request.params.name).id, selection, { include, queryLimit, queryCursor })
  })
  app.get<{ Params: { name: string }; Querystring: unknown }>('/projects/:name/sentiment/evidence', async request => {
    const { limit, cursor, ...selection } = parseSentimentRequest(sentimentEvidenceRequestSchema, request.query)
    return service.evidence(resolveProject(app.db, request.params.name).id, selection, limit, cursor)
  })
  app.get<{ Params: { name: string }; Querystring: unknown }>('/projects/:name/sentiment/compare', async request => {
    const { fromRunId, toRunId, ...selection } = parseSentimentRequest(sentimentCompareRequestSchema, request.query)
    return service.compare(resolveProject(app.db, request.params.name).id, selection, fromRunId, toRunId)
  })
  app.get<{ Params: { name: string }; Querystring: unknown }>('/projects/:name/sentiment/backfill-preview', async request => service.preview(resolveProject(app.db, request.params.name).id, parseSentimentRequest(sentimentBackfillSelectionSchema, request.query)))
  app.post<{ Params: { name: string }; Body: unknown }>('/projects/:name/sentiment/backfills', async request => {
    requireSentimentAdministrator(request)
    const body = parseSentimentRequest(sentimentBackfillRequestSchema, request.body)
    const project = resolveProject(app.db, request.params.name)
    const result = service.submit(project.id, body.previewToken, body.idempotencyKey, request.principal?.delegatedUser?.id ?? request.principal?.id ?? 'local')
    return result
  })
  app.get<{ Params: { name: string } }>('/projects/:name/sentiment/jobs', async request => service.jobList(resolveProject(app.db, request.params.name).id))
  app.get<{ Params: { name: string; jobId: string }; Querystring: unknown }>('/projects/:name/sentiment/jobs/:jobId', async request => {
    const { attemptLimit, attemptCursor } = parseSentimentRequest(sentimentJobRequestSchema, request.query ?? {})
    return service.job(resolveProject(app.db, request.params.name).id, request.params.jobId, { limit: attemptLimit, cursor: attemptCursor })
  })
}
