import { FEEDBACK_KINDS, feedbackSubmissionSchema } from '@ainyc/canonry-contracts'
import { createApiClient } from '../client.js'
import { isMachineFormat, usageError, type CliFormat } from '../cli-error.js'

export interface FeedbackCommandInput {
  summary?: string
  kind?: string
  details?: string
  area?: string
  command?: string
  errorCode?: string
}

/**
 * `canonry feedback`: send a struggle, bug, improvement or note about Canonry
 * itself to the Canonry team. Goes through the server so the CLI, MCP and the
 * dashboard share one redaction and delivery path.
 */
export async function feedbackCommand(input: FeedbackCommandInput, format: CliFormat): Promise<void> {
  const parsed = feedbackSubmissionSchema.safeParse({
    kind: input.kind ?? 'other',
    summary: input.summary ?? '',
    ...(input.details ? { details: input.details } : {}),
    ...(input.area ? { area: input.area } : {}),
    ...(input.command ? { command: input.command } : {}),
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
  })
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map(issue => issue.path.join('.') || 'input'))].join(', ')
    throw usageError(`Error: invalid feedback (${fields}). Kind is one of ${FEEDBACK_KINDS.join(', ')}; the summary is required, up to 500 characters.\nUsage: ${FEEDBACK_USAGE}`, {
      message: 'Invalid feedback',
      details: { fields },
    })
  }

  const result = await createApiClient().sendFeedback(parsed.data)
  if (isMachineFormat(format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(`Thanks, feedback sent to the Canonry team (id ${result.id}).`)
}

export const FEEDBACK_USAGE = 'canonry feedback "<summary>" [--kind struggle|bug|improvement|other] [--details <text>] [--area <area>] [--command <canonry command>] [--error-code <code>] [--format json]'
