import type { FastifyInstance } from 'fastify'
import {
  USAGE_TELEMETRY_HEADERS,
  feedbackSubmissionSchema,
  notImplemented,
  validationError,
  type FeedbackAcceptedDto,
  type FeedbackSubmission,
} from '@ainyc/canonry-contracts'

/**
 * Who sent the feedback, read from the same caller headers usage telemetry
 * uses. Unvalidated labels: the host must validate them before forwarding,
 * and they are never identity.
 */
export interface FeedbackRequestContext {
  userAgent?: string
  surface?: string
  agent?: string
  mcpClient?: string
}

export interface FeedbackRoutesOptions {
  /** Forwards one submission to the collector. Absent where feedback is not wired. */
  submitFeedback?: (submission: FeedbackSubmission, context: FeedbackRequestContext) => Promise<FeedbackAcceptedDto>
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export async function feedbackRoutes(app: FastifyInstance, opts: FeedbackRoutesOptions) {
  app.post<{ Body: unknown }>('/feedback', async (request, reply) => {
    const parsed = feedbackSubmissionSchema.safeParse(request.body)
    if (!parsed.success) {
      throw validationError('Invalid feedback', {
        issues: parsed.error.issues.map(issue => ({ code: issue.code, path: issue.path.join('.') })),
      })
    }
    if (!opts.submitFeedback) {
      throw notImplemented('Feedback is not available in this deployment')
    }
    const accepted = await opts.submitFeedback(parsed.data, {
      userAgent: header(request.headers['user-agent']),
      surface: header(request.headers[USAGE_TELEMETRY_HEADERS.surface]),
      agent: header(request.headers[USAGE_TELEMETRY_HEADERS.agent]),
      mcpClient: header(request.headers[USAGE_TELEMETRY_HEADERS.mcpClient]),
    })
    return reply.status(202).send(accepted)
  })
}
